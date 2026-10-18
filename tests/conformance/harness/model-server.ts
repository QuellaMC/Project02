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
import type {AddressInfo} from 'node:net';
import {text} from 'node:stream/consumers';

import {onTestFinished} from 'vitest';

import {attachEvidence, within} from './wait.ts';

export type ModelRequest = {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
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
};

type Scripted =
  | Answer
  | {
      readonly reached: (request: ModelRequest) => void;
      readonly released: Promise<Answer>;
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

    if ('released' in next) {
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

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  onTestFinished(
    () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );
  attachEvidence(
    () =>
      `model server: ${String(requests.length)} request(s), ${String(script.length)} scripted answer(s) left`,
  );

  const {port} = server.address() as AddressInfo;

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
  };
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

    for (const chunk of answer.chunks) {
      response.write(
        `data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`,
      );
    }

    // Ended, not destroyed: the chunks written so far still go out first.
    if (answer.end === 'cut') {
      request.socket.end();
    } else if (answer.end === undefined) {
      response.end('data: [DONE]\n\n');
    }
  }
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

function pieces(whole: string, cuts: readonly number[]): string[] {
  return [0, ...cuts].map((start, at) => whole.slice(start, cuts[at]));
}
