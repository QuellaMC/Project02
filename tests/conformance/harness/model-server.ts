/**
 * An OpenAI-compatible chat completions server on loopback, standing in
 * for the model: the home's provider settings point the daemon at it, it
 * answers each request with the next answer the test scripted, and it
 * keeps every request the daemon sent.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {text} from 'node:stream/consumers';

import {servedOnLoopback} from './server.ts';
import {attachEvidence, within} from './wait.ts';

export type ModelRequest = {
  readonly path: string;
  readonly authorization: string | undefined;
  /** The body as it came. */
  readonly text: string;
  readonly body: unknown;
};

export type ChatMessage = {
  readonly role: string;
  readonly content: string | null;
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly function: {readonly name: string; readonly arguments: string};
  }[];
  readonly tool_call_id?: string;
};

/** How the server answers one request. */
export type Answer =
  /** Streamed: each chunk a `data:` line, then `[DONE]`, unless the stream is cut or left hanging. */
  | {readonly chunks: readonly unknown[]; readonly end?: 'cut' | 'hang'}
  /** Whole, in one JSON body: how `stream: false` is answered. */
  | {readonly completion: unknown}
  | {readonly status: number; readonly body?: unknown}
  /** The connection closed before any byte of an answer. */
  | {readonly drop: true};

export type Held = {
  /** The request, once it reached the server. */
  readonly arrived: () => Promise<ModelRequest>;
  readonly release: (answer: Answer) => void;
};

/**
 * A streamed answer the test writes piece by piece, so a draft grows at the
 * test's pace. The headers go out with the first piece, and an empty piece
 * sends them alone.
 */
export type Driven = {
  readonly arrived: () => Promise<ModelRequest>;
  readonly write: (chunks: readonly unknown[]) => void;
  /** These bytes as they are: a frame, or a character, may end in the next piece. */
  readonly send: (bytes: Uint8Array) => void;
  /** Ends the answer with `[DONE]`. */
  readonly end: () => void;
};

export type ModelServer = {
  /** The `project02` settings of a home's `config.json` that point the daemon here. */
  readonly settings: {
    readonly roleModelProvider: 'nvidia';
    readonly nvidiaApiKey: string;
    readonly nvidiaBaseUrl: string;
  };
  readonly requests: readonly ModelRequest[];
  /** The answers to the next requests, in order. */
  readonly answer: (...answers: Answer[]) => void;
  /** The next request waits for the test to release it; never released, it is silence. */
  readonly hold: () => Held;
  /** The next request is answered as the test writes, piece by piece. */
  readonly stream: () => Driven;
};

type Scripted =
  | Answer
  | {
      readonly reached: (request: ModelRequest) => void;
      readonly released: Promise<Answer>;
    }
  | {
      readonly reached: (request: ModelRequest) => void;
      readonly drive: (response: ServerResponse) => void;
    };

export async function startModelServer(): Promise<ModelServer> {
  const requests: ModelRequest[] = [];
  const script: Scripted[] = [];
  const respond = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const body = await text(request);
    const recorded = {
      path: request.url ?? '',
      authorization: request.headers.authorization,
      text: body,
      body: body === '' ? undefined : (JSON.parse(body) as unknown),
    };

    requests.push(recorded);

    if (!recorded.path.endsWith('/chat/completions')) {
      response.writeHead(404).end();

      return;
    }

    const next = script.shift() ?? {
      status: 400,
      body: {
        error: {
          message: `The model server has no answer for request ${String(requests.length)}.`,
        },
      },
    };

    if ('drive' in next) {
      next.reached(recorded);
      next.drive(response);
    } else if ('released' in next) {
      next.reached(recorded);
      give(await next.released, request, response);
    } else {
      give(next, request, response);
    }
  };
  const server = createServer((request, response) => {
    // A request that broke off has nobody left to answer.
    respond(request, response).catch(() => {
      request.socket.destroy();
    });
  });

  const port = await servedOnLoopback(server);

  attachEvidence(
    () =>
      `model server: ${String(requests.length)} request(s), ${String(script.length)} scripted answer(s) left`,
  );

  return {
    settings: {
      roleModelProvider: 'nvidia',
      nvidiaApiKey: 'model-server-key',
      nvidiaBaseUrl: `http://127.0.0.1:${String(port)}/v1`,
    },
    requests,
    answer: (...answers) => {
      script.push(...answers);
    },
    hold: () => {
      const arrival = Promise.withResolvers<ModelRequest>();
      const release = Promise.withResolvers<Answer>();

      script.push({reached: arrival.resolve, released: release.promise});

      return {
        arrived: () =>
          within('the held request to reach the model server', arrival.promise),
        release: release.resolve,
      };
    },
    stream: () => {
      const arrival = Promise.withResolvers<ModelRequest>();
      let response: ServerResponse | undefined;
      let pending: (string | Uint8Array)[] = [];
      let ended = false;
      const flush = (): void => {
        if (response === undefined) {
          return;
        }

        for (const piece of pending) {
          response.write(piece);
        }

        pending = [];

        if (ended) {
          response.end('data: [DONE]\n\n');
        }
      };

      script.push({
        reached: arrival.resolve,
        drive: driven => {
          response = driven.writeHead(200, {
            'content-type': 'text/event-stream',
          });
          flush();
        },
      });

      return {
        arrived: () =>
          within(
            'the driven request to reach the model server',
            arrival.promise,
          ),
        write: chunks => {
          pending.push(eventStream(chunks));
          flush();
        },
        send: bytes => {
          pending.push(bytes);
          flush();
        },
        end: () => {
          ended = true;
          flush();
        },
      };
    },
  };
}

/** The messages a request showed the model, in order. */
export function messagesOf(
  request: ModelRequest | undefined,
): readonly ChatMessage[] {
  return (
    (request?.body as {readonly messages?: readonly ChatMessage[]} | undefined)
      ?.messages ?? []
  );
}

/** What a request told the model each tool call it made answered, in order. */
export function toolResults(request: ModelRequest | undefined): unknown[] {
  return messagesOf(request)
    .filter(message => message.role === 'tool')
    .map(message => JSON.parse(message.content ?? 'null') as unknown);
}

function give(
  answer: Answer,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  if ('drop' in answer) {
    request.socket.destroy();
  } else if ('status' in answer) {
    response
      .writeHead(answer.status, {'content-type': 'application/json'})
      .end(
        JSON.stringify(
          answer.body ?? {error: {message: `HTTP ${String(answer.status)}`}},
        ),
      );
  } else if ('completion' in answer) {
    response
      .writeHead(200, {'content-type': 'application/json'})
      .end(JSON.stringify(answer.completion));
  } else {
    response.writeHead(200, {'content-type': 'text/event-stream'});
    // Out now, so a stream that then hangs or is cut had opened.
    response.flushHeaders();
    response.write(eventStream(answer.chunks));

    // Ended, not destroyed: the chunks written so far still go out first.
    if (answer.end === 'cut') {
      request.socket.end();
    } else if (answer.end === undefined) {
      response.end('data: [DONE]\n\n');
    }
  }
}

/** Each chunk a `data:` line: an object as its JSON, a string as written. */
export function eventStream(chunks: readonly unknown[]): string {
  return chunks
    .map(
      chunk =>
        `data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`,
    )
    .join('');
}

/** Plain content, one chunk per piece, cut at the given offsets. */
export function content(words: string, ...cuts: number[]): unknown[] {
  return pieces(words, cuts).map(piece => ({
    choices: [{index: 0, delta: {content: piece}, finish_reason: null}],
  }));
}

/** A tool call as the endpoint streams one: its id and name come with the first piece of its arguments. */
export function toolCall(
  call: {
    readonly index: number;
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
  },
  ...cuts: number[]
): unknown[] {
  return pieces(call.arguments, cuts).map((piece, at) => ({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: call.index,
              ...(at === 0 ? {id: call.id, type: 'function'} : {}),
              function: {
                ...(at === 0 ? {name: call.name} : {}),
                arguments: piece,
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  }));
}

/** The character speaking through `visible_reply`, its arguments cut at the given offsets. */
export function visibleReply(words: string, ...cuts: number[]): unknown[] {
  return toolCall(
    {
      index: 0,
      id: 'call_reply',
      name: 'visible_reply',
      arguments: JSON.stringify({text: words}),
    },
    ...cuts,
  );
}

export function finish(reason: string): unknown {
  return {choices: [{index: 0, delta: {}, finish_reason: reason}]};
}

export function usage(tokens: {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
}): unknown {
  return {
    choices: [],
    usage: {
      ...tokens,
      total_tokens: tokens.prompt_tokens + tokens.completion_tokens,
    },
  };
}

/** The words as a whole reply: plain content, finished. */
export function reply(words: string): Answer {
  return {chunks: [...content(words), finish('stop')]};
}

/** A whole completion, as a `stream: false` request is answered. */
export function completion(words: string, finishReason = 'stop'): Answer {
  return {
    completion: {
      choices: [
        {
          index: 0,
          finish_reason: finishReason,
          message: {role: 'assistant', content: words},
        },
      ],
    },
  };
}

/** The model calling these tools, each with its input, and nothing else in that round. */
export function calling(
  ...calls: readonly (readonly [name: string, input: object])[]
): Answer {
  return {
    chunks: [
      ...calls.flatMap(([name, input], index) =>
        toolCall({
          index,
          id: `call_${String(index)}`,
          name,
          arguments: JSON.stringify(input),
        }),
      ),
      finish('tool_calls'),
    ],
  };
}

function pieces(whole: string, cuts: readonly number[]): string[] {
  return [0, ...cuts].map((start, at) => whole.slice(start, cuts[at]));
}

/**
 * A model that never decides, for as many rounds as one turn gives it:
 * each answer neither replies nor calls a tool, so the parser refuses it,
 * and the turn ends rejected once its rounds — the first and 99 more — are
 * spent.
 */
export function undecided(rounds = 100): Answer[] {
  return Array.from({length: rounds}, () => ({chunks: [finish('stop')]}));
}
