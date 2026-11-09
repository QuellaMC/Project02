/**
 * A Mem0 REST backend on loopback, standing in for a self-hosted server and
 * for the hosted platform: the mem0 plugin's baseUrl points the daemon at
 * it, it answers each request on a path with the next answer the test
 * scripted for that path, and it keeps every request the daemon sent.
 */
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {text} from 'node:stream/consumers';

import {servedOnLoopback} from './server.ts';
import {attachEvidence, within} from './wait.ts';

export type Mem0Request = {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  /** The body as it came. */
  readonly text: string;
  readonly body: unknown;
};

/** The status, and a body sent as its JSON. */
export type Mem0Answer = {
  readonly status: number;
  readonly body?: unknown;
};

export type Mem0Held = {
  /** The request, once it reached the server. */
  readonly arrived: () => Promise<Mem0Request>;
  readonly release: (answer: Mem0Answer) => void;
};

export type Mem0Server = {
  /** The origin a home's mem0 baseUrl names. */
  readonly baseUrl: string;
  readonly requests: readonly Mem0Request[];
  /** The answers to the next requests on this path, in order; a request nobody scripted gets an empty result list. */
  readonly answer: (path: string, ...answers: Mem0Answer[]) => void;
  /** The next request on this path waits for the test to release it. */
  readonly hold: (path: string) => Mem0Held;
};

type Scripted =
  | Mem0Answer
  | {
      readonly reached: (request: Mem0Request) => void;
      readonly released: Promise<Mem0Answer>;
    };

export async function startMem0Server(): Promise<Mem0Server> {
  const requests: Mem0Request[] = [];
  const scripts = new Map<string, Scripted[]>();
  const scriptOf = (path: string): Scripted[] => {
    const script = scripts.get(path) ?? [];

    scripts.set(path, script);

    return script;
  };
  const respond = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const body = await text(request);
    const recorded = {
      method: request.method ?? '',
      path: request.url ?? '',
      headers: request.headers,
      text: body,
      body: body === '' ? undefined : (JSON.parse(body) as unknown),
    };

    requests.push(recorded);

    const next = scriptOf(recorded.path).shift() ?? {
      status: 200,
      body: {results: []},
    };

    if ('released' in next) {
      next.reached(recorded);
      give(await next.released, response);
    } else {
      give(next, response);
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
      `mem0 server: ${requests
        .map(request => `${request.method} ${request.path}`)
        .join(', ')}`,
  );

  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    requests,
    answer: (path, ...answers) => {
      scriptOf(path).push(...answers);
    },
    hold: path => {
      const arrival = Promise.withResolvers<Mem0Request>();
      const release = Promise.withResolvers<Mem0Answer>();

      scriptOf(path).push({
        reached: arrival.resolve,
        released: release.promise,
      });

      return {
        arrived: () =>
          within(
            `the held request on ${path} to reach the mem0 server`,
            arrival.promise,
          ),
        release: release.resolve,
      };
    },
  };
}

function give(answer: Mem0Answer, response: ServerResponse): void {
  response
    .writeHead(answer.status, {'content-type': 'application/json'})
    .end(JSON.stringify(answer.body ?? {}));
}
