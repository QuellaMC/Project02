/**
 * The daemon's wire relayed for a client the test starts, so the test sees
 * what that client asks and can slow its answers: a home of its own whose
 * record names the relay in the daemon's place, and every request kept and
 * passed on as it came, unless the test holds an answer back, refuses a
 * request, or takes the daemon out of the client's reach for a while.
 */
import {readFileSync} from 'node:fs';
import {
  createServer,
  request as forward,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {join} from 'node:path';
import {buffer} from 'node:stream/consumers';

import {createHome} from './home.ts';
import {servedOnLoopback} from './server.ts';
import {attachEvidence, observed, within} from './wait.ts';

export type RelayedRequest = {
  readonly method: string;
  /** With its query. */
  readonly path: string;
  /** By lower-case name, as Node gives them. */
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  /** When it reached the relay, by the monotonic clock. */
  readonly at: number;
};

export type RelayHeld = {
  /** The request, once it reached the relay and went on to the daemon. */
  readonly arrived: () => Promise<RelayedRequest>;
  /** Settles once the daemon's whole answer is in the relay's hands. */
  readonly answered: () => Promise<void>;
  /** The daemon's answer goes on to the client. */
  readonly release: () => void;
  /** Settles once the client went away before its answer reached it. */
  readonly abandoned: () => Promise<void>;
};

export type Relay = {
  /** Where the client reaches the relay, as it would the daemon. */
  readonly origin: string;
  /** A home whose record names the relay: what the client's `--store` names. */
  readonly home: string;
  readonly requests: readonly RelayedRequest[];
  /** Settles on what `find` finds in the requests, as soon as they hold it. */
  readonly reached: <T>(
    find: (requests: readonly RelayedRequest[]) => T | undefined,
  ) => Promise<T>;
  /** The next request on this path, whatever its query, goes on to the daemon, and its answer waits for the test to release it. */
  readonly hold: (path: string) => RelayHeld;
  /** The next request on this path, whatever its query, is answered with this status and no body, and never reaches the daemon. */
  readonly refuse: (path: string, status: number) => void;
  /**
   * The daemon out of the client's reach: every exchange under way that
   * the test does not hold is cut, the event stream among them, and every
   * request after waits until `back`. A held answer still lands when it is
   * released, as one the daemon sent before it went away.
   */
  readonly away: () => void;
  readonly back: () => void;
};

type Holding = {
  readonly reached: (request: RelayedRequest) => void;
  readonly answered: () => void;
  readonly released: Promise<void>;
  readonly gone: () => void;
};

type Scripted = {readonly hold: Holding} | {readonly status: number};

/**
 * A relay to the daemon serving `home`, whose record it copies under its own
 * port. It forwards to the port the home's record names at the time, since a
 * daemon that comes back finds its last port taken now and then, binds
 * another, and records it.
 */
export async function startRelay(home: string): Promise<Relay> {
  const recordOf = (): Readonly<Record<string, unknown>> =>
    JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as Readonly<
      Record<string, unknown>
    >;
  const record = recordOf();
  const requests = observed<RelayedRequest>();
  const scripts = new Map<string, Scripted[]>();
  const parked: (() => void)[] = [];
  /** The exchanges under way and not held: what `away` cuts. */
  const passing = new Set<ServerResponse>();
  let away = false;
  const scriptOf = (path: string): Scripted[] => {
    const script = scripts.get(path) ?? [];

    scripts.set(path, script);

    return script;
  };
  const pass = (
    request: IncomingMessage,
    body: Buffer,
    response: ServerResponse,
    holding: Holding | undefined,
  ): void => {
    const outgoing = forward({
      host: '127.0.0.1',
      port: Number(recordOf()['port']),
      method: request.method,
      path: request.url,
      headers: request.headers,
      agent: false,
    });

    if (holding === undefined) {
      passing.add(response);
    }

    // The daemon gone mid-exchange: the client's connection goes with it.
    outgoing.on('error', () => {
      response.destroy();
    });
    response.on('close', () => {
      passing.delete(response);

      if (!response.writableFinished) {
        outgoing.destroy();
        holding?.gone();
      }
    });
    outgoing.on('response', answer => {
      const head = (): void => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
      };

      // Cut short by either side; the close above says so.
      answer.on('error', () => undefined);

      if (holding === undefined) {
        head();
        answer.pipe(response);

        return;
      }

      void buffer(answer).then(async whole => {
        holding.answered();
        await holding.released;

        if (connected(response)) {
          head();
          response.end(whole);
        }
      });
    });
    outgoing.end(body);
  };
  const relay = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const body = await buffer(request);
    const relayed = {
      method: request.method ?? '',
      path: request.url ?? '/',
      headers: request.headers,
      body: body.toString('utf8'),
      at: performance.now(),
    };

    requests.add(relayed);

    const go = (): void => {
      // A client that left while the daemon was away asks nothing of it.
      if (!connected(response)) {
        return;
      }

      const next = scriptOf(
        new URL(relayed.path, 'http://relay').pathname,
      ).shift();

      if (next !== undefined && 'status' in next) {
        response.writeHead(next.status).end();

        return;
      }

      next?.hold.reached(relayed);
      pass(request, body, response, next?.hold);
    };

    if (away) {
      parked.push(go);
    } else {
      go();
    }
  };
  const server = createServer((request, response) => {
    // A request that broke off has nobody left to answer.
    relay(request, response).catch(() => {
      request.socket.destroy();
    });
  });
  const port = await servedOnLoopback(server);

  attachEvidence(
    () =>
      `relay: ${requests.items
        .map(request => `${request.method} ${request.path}`)
        .join(', ')}`,
  );

  return {
    origin: `http://127.0.0.1:${String(port)}`,
    home: createHome({'daemon.json': JSON.stringify({...record, port})}),
    requests: requests.items,
    reached: find => requests.until('a request to reach the relay', find),
    hold: path => {
      const arrival = Promise.withResolvers<RelayedRequest>();
      const answer = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const abandon = Promise.withResolvers<undefined>();

      scriptOf(path).push({
        hold: {
          reached: arrival.resolve,
          answered: () => {
            answer.resolve(undefined);
          },
          released: release.promise,
          gone: () => {
            abandon.resolve(undefined);
          },
        },
      });

      return {
        arrived: () =>
          within(
            `the held request on ${path} to reach the relay`,
            arrival.promise,
          ),
        answered: () =>
          within(
            `the daemon to answer the held request on ${path}`,
            answer.promise,
          ),
        release: () => {
          release.resolve(undefined);
        },
        abandoned: () =>
          within(
            `the client to leave the held request on ${path}`,
            abandon.promise,
          ),
      };
    },
    refuse: (path, status) => {
      scriptOf(path).push({status});
    },
    away: () => {
      away = true;

      for (const response of passing) {
        response.destroy();
      }
    },
    back: () => {
      away = false;

      for (const go of parked.splice(0)) {
        go();
      }
    },
  };
}

/** Whether the client is still there to be answered. */
function connected(response: ServerResponse): boolean {
  return response.socket?.destroyed === false;
}
