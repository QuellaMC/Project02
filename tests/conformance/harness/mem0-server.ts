/**
 * A self-hosted Mem0 server on loopback, standing in for a character's
 * long-term memory: the home's mem0 settings point the daemon at it, it
 * answers a search with one memory naming the query and an add with the id
 * of one memory, holds a search open on demand, and keeps every request.
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

export type Mem0Request = {
  readonly path: string;
  readonly body: unknown;
};

export type Mem0Server = {
  /** The mem0 stanza of a home's `config.json` that switches it on and points it here. */
  readonly settings: {
    readonly enabled: true;
    readonly config: {readonly backend: 'server'; readonly baseUrl: string};
  };
  readonly requests: readonly Mem0Request[];
  /** The next search for this query waits for the test to release it. */
  readonly hold: (query: string) => {
    readonly arrived: () => Promise<Mem0Request>;
    readonly release: () => void;
  };
};

export async function startMem0Server(): Promise<Mem0Server> {
  const requests: Mem0Request[] = [];
  const held = new Map<
    string,
    {
      readonly reached: (request: Mem0Request) => void;
      readonly released: Promise<void>;
    }
  >();
  const respond = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const body = await text(request);
    const recorded = {
      path: request.url ?? '',
      body: body === '' ? undefined : (JSON.parse(body) as unknown),
    };

    requests.push(recorded);

    const query = (recorded.body as {readonly query?: string} | undefined)
      ?.query;
    const hold = query === undefined ? undefined : held.get(query);

    if (query !== undefined && hold !== undefined) {
      held.delete(query);
      hold.reached(recorded);
      await hold.released;
    }

    const id = `memory-${String(requests.length)}`;

    response
      .writeHead(200, {'content-type': 'application/json'})
      .end(
        JSON.stringify(
          recorded.path === '/search'
            ? {results: [{id, memory: `What I know of ${String(query)}.`}]}
            : recorded.path === '/memories'
              ? {results: [{id}]}
              : {},
        ),
      );
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
      `mem0 server: ${requests.map(request => request.path).join(', ') || 'no requests'}`,
  );

  const {port} = server.address() as AddressInfo;

  return {
    settings: {
      enabled: true,
      config: {backend: 'server', baseUrl: `http://127.0.0.1:${String(port)}`},
    },
    requests,
    hold: query => {
      const arrival = Promise.withResolvers<Mem0Request>();
      const release = Promise.withResolvers<undefined>();

      held.set(query, {reached: arrival.resolve, released: release.promise});

      return {
        arrived: () =>
          within(
            `the search for "${query}" to reach the mem0 server`,
            arrival.promise,
          ),
        release: () => {
          release.resolve(undefined);
        },
      };
    },
  };
}
