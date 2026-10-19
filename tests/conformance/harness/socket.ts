/**
 * A bare TCP connection to the daemon, for what no HTTP client does on
 * purpose: stopping halfway through a request, or not reading an answer.
 * What comes back is kept byte for byte.
 */
import {connect} from 'node:net';

import type {Address} from './daemon.ts';
import {onTestFinished} from './runner.ts';
import {attachEvidence, waitFailure, within} from './wait.ts';

export type Socket = {
  readonly write: (text: string) => void;
  /** Every byte the daemon sent so far. */
  readonly received: () => Buffer;
  /** Settles once what the daemon sent holds this text. */
  readonly holds: (text: string) => Promise<void>;
  /** Takes nothing more: what the daemon sends next waits in the sockets' buffers. */
  readonly pause: () => void;
  readonly resume: () => void;
  /** Settles once the daemon closed the connection and what it sent is read. */
  readonly closed: () => Promise<void>;
};

/** The text of a request to the daemon as a client writes it, the token added, a JSON body when given. */
export function requestText(
  daemon: Address,
  sent: {
    readonly method: string;
    readonly path: string;
    readonly body?: string;
    readonly headers?: Readonly<Record<string, string>>;
  },
): string {
  const headers = {
    host: new URL(daemon.origin).host,
    authorization: `Bearer ${daemon.token}`,
    ...(sent.body === undefined
      ? {}
      : {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(sent.body)),
        }),
    ...sent.headers,
  };

  return `${sent.method} ${sent.path} HTTP/1.1\r\n${Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('')}\r\n${sent.body ?? ''}`;
}

export async function connectSocket(daemon: Address): Promise<Socket> {
  const {hostname, port} = new URL(daemon.origin);
  const socket = connect(Number(port), hostname);
  const chunks: Buffer[] = [];
  let arrival = Promise.withResolvers<undefined>();
  let ended = false;
  const changed = (): void => {
    arrival.resolve(undefined);
    arrival = Promise.withResolvers();
  };
  const closed = new Promise<void>(resolve => {
    socket.once('close', () => {
      ended = true;
      resolve();
      changed();
    });
  });
  const received = (): Buffer => Buffer.concat(chunks);

  // A connection the daemon cuts errors before it closes; the close says it.
  socket.on('error', () => undefined);
  socket.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
    changed();
  });
  onTestFinished(() => {
    socket.destroy();
  });
  attachEvidence(
    () =>
      `socket to ${daemon.origin}: ${String(received().length)} byte(s) received${
        ended ? ', closed' : ''
      }`,
  );
  await within(
    'the socket to connect',
    new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    }),
  );

  return {
    write: text => {
      socket.write(text);
    },
    received,
    holds: text => {
      const what = `the socket to receive "${text}"`;
      const failed = waitFailure(what);

      return within(
        what,
        (async () => {
          while (!received().includes(text)) {
            if (ended) {
              throw failed.because('the daemon closed it first');
            }

            await arrival.promise;
          }
        })(),
      );
    },
    pause: () => {
      socket.pause();
    },
    resume: () => {
      socket.resume();
    },
    closed: () => within('the daemon to close the socket', closed),
  };
}
