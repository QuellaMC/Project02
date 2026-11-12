/**
 * The internet her apps reach, on loopback, standing in for every host: the
 * daemon's environment points it here, so a request an app makes for
 * `https://<host>/<path>?<query>` arrives as `/<host>/<path>?<query>`. Each
 * path answers what the test scripted for it, in order, any other a 404,
 * and it keeps every request with its headers and body.
 */
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {text} from 'node:stream/consumers';

import {servedOnLoopback} from './server.ts';
import {attachEvidence} from './wait.ts';

export type InternetRequest = {
  readonly method: string;
  /** Where it arrived: `/<host>/<path>?<query>`. */
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  /** The body as it came, empty when it had none. */
  readonly body: string;
};

/** A status, with headers and a body written as given. */
export type InternetAnswer = {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
};

/** An answer, or one made from the request it answers. */
type Scripted = InternetAnswer | ((request: InternetRequest) => InternetAnswer);

export type InternetServer = {
  /** The daemon's environment that points every request of her apps here. */
  readonly env: {readonly PROJECT02_TEST_APP_INTERNET: string};
  /** Every request, in order. */
  readonly requests: readonly InternetRequest[];
  /** The answers to the next requests at this path, in order. */
  readonly answer: (path: string, ...answers: readonly Scripted[]) => void;
};

export async function startInternetServer(): Promise<InternetServer> {
  const requests: InternetRequest[] = [];
  const scripts = new Map<string, Scripted[]>();
  const respond = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const arrived = {
      method: request.method ?? '',
      path: request.url ?? '',
      headers: request.headers,
      body: await text(request),
    };

    requests.push(arrived);

    const next = scripts.get(arrived.path)?.shift() ?? {status: 404};
    const {status, headers, body} =
      typeof next === 'function' ? next(arrived) : next;

    response.writeHead(status, headers).end(body);
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
      `internet server: ${requests
        .map(request => `${request.method} ${request.path}`)
        .join(', ')}`,
  );

  return {
    env: {PROJECT02_TEST_APP_INTERNET: `http://127.0.0.1:${String(port)}`},
    requests,
    answer: (path, ...answers) => {
      scripts.set(path, [...(scripts.get(path) ?? []), ...answers]);
    },
  };
}
