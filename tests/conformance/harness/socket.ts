/**
 * One HTTP exchange on a socket of its own, for what fetch keeps from a
 * test: the status and headers of an answer, the body as it came, and a
 * client that stops reading or hangs up mid-stream.
 */
import {connect} from 'node:net';

import {onTestFinished} from 'vitest';

import type {Address} from './daemon.ts';
import {attachEvidence, waitFailure, within} from './wait.ts';

export type Head = {
  readonly status: number;
  /** By lower-case name. */
  readonly headers: Readonly<Record<string, string>>;
};

export type Exchange = {
  /** The status line and the headers, once they came. */
  readonly head: () => Promise<Head>;
  /** The body so far, its chunked coding removed. */
  readonly body: () => string;
  /** Settles once the body holds this text. */
  readonly received: (text: string) => Promise<void>;
  /** Stops taking bytes: what the daemon writes piles up in the sockets' buffers. */
  readonly pause: () => void;
  readonly resume: () => void;
  /** Goes away, as a closed tab does. */
  readonly hangUp: () => void;
  /** Settles once the connection is gone, whichever side ended it. */
  readonly ended: () => Promise<void>;
};

/** The request, with the daemon's token, on a connection that closes after the answer. */
export function exchange(
  daemon: Address,
  request: {
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly body?: unknown;
  },
): Exchange {
  const {host, port} = new URL(daemon.origin);
  const payload =
    request.body === undefined ? '' : JSON.stringify(request.body);
  const socket = connect(Number(port), '127.0.0.1');
  const headDone = Promise.withResolvers<Head>();
  const gone = Promise.withResolvers<undefined>();
  const checks = new Set<() => void>();
  const decoder = new TextDecoder();
  let head: Head | undefined;
  let pending = Buffer.alloc(0);
  let text = '';
  let ended = false;
  let take = (bytes: Buffer): void => {
    pending = Buffer.concat([pending, bytes]);

    const end = pending.indexOf('\r\n\r\n');

    if (end === -1) {
      return;
    }

    head = headOf(pending.subarray(0, end).toString('latin1'));
    headDone.resolve(head);

    const append = (piece: Buffer): void => {
      text += decoder.decode(piece, {stream: true});
    };

    take =
      head.headers['transfer-encoding'] === 'chunked'
        ? createDechunker(append)
        : append;
    take(pending.subarray(end + 4));
  };
  const changed = (): void => {
    for (const check of [...checks]) {
      check();
    }
  };

  socket.on('data', (bytes: Buffer) => {
    take(bytes);
    changed();
  });
  // A reset is how the daemon cuts a client off; the close that follows says so.
  socket.on('error', () => undefined);
  socket.on('close', () => {
    ended = true;
    gone.resolve(undefined);
    changed();
  });
  socket.write(
    `${request.method} ${request.path} HTTP/1.1\r\n` +
      `Host: ${host}\r\n` +
      `Authorization: Bearer ${daemon.token}\r\n` +
      'Connection: close\r\n' +
      (payload === ''
        ? ''
        : 'Content-Type: application/json\r\n' +
          `Content-Length: ${String(Buffer.byteLength(payload))}\r\n`) +
      `\r\n${payload}`,
  );
  attachEvidence(
    () =>
      `${request.method} ${request.path} on a socket of its own` +
      (head === undefined ? '' : `, answered ${String(head.status)}`) +
      `${ended ? ', ended' : ''}; body (${String(text.length)} characters):\n` +
      (text.length > 2000 ? `…${text.slice(-2000)}` : text),
  );
  onTestFinished(() => {
    socket.destroy();
  });

  return {
    head: () => within('the head of the answer', headDone.promise),
    body: () => text,
    received: expected => {
      const what = `the body to hold ${JSON.stringify(expected)}`;
      const failed = waitFailure(what);
      let searched = 0;

      return within(
        what,
        new Promise<void>((resolve, reject) => {
          const check = (): void => {
            // Only the new text, and the tail a match could begin in.
            const found = text.includes(
              expected,
              Math.max(0, searched - expected.length),
            );

            searched = text.length;

            if (found) {
              checks.delete(check);
              resolve();
            } else if (ended) {
              checks.delete(check);
              reject(failed.because('the connection ended first'));
            }
          };

          checks.add(check);
          check();
        }),
      );
    },
    pause: () => {
      socket.pause();
    },
    resume: () => {
      socket.resume();
    },
    hangUp: () => {
      socket.destroy();
    },
    ended: () => within('the connection to end', gone.promise),
  };
}

function headOf(lines: string): Head {
  const [statusLine = '', ...fields] = lines.split('\r\n');

  return {
    status: Number(statusLine.split(' ')[1]),
    headers: Object.fromEntries(
      fields.map(field => {
        const colon = field.indexOf(':');

        return [
          field.slice(0, colon).trim().toLowerCase(),
          field.slice(colon + 1).trim(),
        ];
      }),
    ),
  };
}

/** Each chunk is its size in hex on a line, its bytes, then a line end; a size of 0 ends the body. */
function createDechunker(
  emit: (piece: Buffer) => void,
): (bytes: Buffer) => void {
  let pending = Buffer.alloc(0);
  let remaining = 0;
  let state: 'size' | 'data' | 'end of chunk' | 'done' = 'size';

  return bytes => {
    pending = Buffer.concat([pending, bytes]);

    for (;;) {
      if (state === 'size') {
        const end = pending.indexOf('\r\n');

        if (end === -1) {
          return;
        }

        remaining = Number.parseInt(
          pending.subarray(0, end).toString('latin1'),
          16,
        );
        pending = pending.subarray(end + 2);
        state = remaining === 0 ? 'done' : 'data';
      } else if (state === 'data') {
        const piece = pending.subarray(0, remaining);

        emit(piece);
        remaining -= piece.length;
        pending = pending.subarray(piece.length);

        if (remaining > 0) {
          return;
        }

        state = 'end of chunk';
      } else if (state === 'end of chunk' && pending.length >= 2) {
        pending = pending.subarray(2);
        state = 'size';
      } else {
        return;
      }
    }
  };
}
