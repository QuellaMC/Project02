/**
 * One HTTP exchange exactly as the test writes it: any method, path, Host
 * and headers, with nothing added that the test did not add; the answer's
 * status and headers, its body as it comes, and a client that stops
 * reading or hangs up mid-stream. What the verbs of `wire.ts` keep from a
 * test.
 */
import {
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from 'node:http';

import type {Address} from './daemon.ts';
import {onTestFinished} from './runner.ts';
import {attachEvidence, waitFailure, within} from './wait.ts';

export type Exchange = {
  readonly status: number;
  /** By lower-case name, as Node gives them. */
  readonly headers: IncomingHttpHeaders;
  /** The body so far. */
  readonly body: () => string;
  /** The whole body, once the daemon ends it. */
  readonly whole: () => Promise<string>;
  /** Settles once the body holds this text. */
  readonly received: (text: string) => Promise<void>;
  /** Takes nothing more: what the daemon writes next piles up in the sockets' buffers. */
  readonly pause: () => void;
  readonly resume: () => void;
  /** Goes away, as a closed tab does. */
  readonly hangUp: () => void;
  /** Settles once the connection is gone, whichever side ended it. */
  readonly ended: () => Promise<void>;
};

/** The daemon's token, as a client sends it. */
export function bearer(daemon: Address): Readonly<Record<string, string>> {
  return {authorization: `Bearer ${daemon.token}`};
}

/** The token and the content type a JSON body travels under. */
export function jsonFrom(daemon: Address): Readonly<Record<string, string>> {
  return {...bearer(daemon), 'content-type': 'application/json'};
}

/** Settles on the answer's head; the body follows, so a stream answers too. */
export function exchange(
  daemon: Address,
  sent: {
    readonly method?: string;
    readonly path: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
  },
): Promise<Exchange> {
  const {hostname, port} = new URL(daemon.origin);
  const what = `${sent.method ?? 'GET'} ${sent.path}`;
  const outgoing = request({
    host: hostname,
    port,
    method: sent.method ?? 'GET',
    path: sent.path,
    headers: sent.headers,
    agent: false,
  });
  const gone = Promise.withResolvers<undefined>();
  const checks = new Set<() => void>();
  let text = '';
  let ended = false;
  const changed = (): void => {
    for (const check of [...checks]) {
      check();
    }
  };

  // A connection the daemon cuts errors before it closes; the close says it.
  outgoing.on('error', () => undefined);
  outgoing.on('close', () => {
    ended = true;
    gone.resolve(undefined);
    changed();
  });
  onTestFinished(() => {
    outgoing.destroy();
  });

  return within(
    `${what} to answer`,
    new Promise<Exchange>((resolve, reject) => {
      outgoing.once('error', reject);
      outgoing.once('response', (incoming: IncomingMessage) => {
        const whole = Promise.withResolvers<string>();

        incoming.setEncoding('utf8');
        incoming.on('data', (piece: string) => {
          text += piece;
          changed();
        });
        incoming.on('end', () => {
          whole.resolve(text);
        });
        incoming.on('error', () => undefined);
        incoming.on('close', () => {
          whole.reject(new Error(`${what} broke off before its body ended.`));
        });
        // Awaited by `whole`; a stream nobody reads to its end is cut at teardown.
        whole.promise.catch(() => undefined);
        attachEvidence(
          () =>
            `${what}: answered ${String(incoming.statusCode)}` +
            `${ended ? ', ended' : ''}; body (${String(text.length)} characters):\n` +
            (text.length > 2000 ? `…${text.slice(-2000)}` : text),
        );
        resolve({
          status: incoming.statusCode ?? 0,
          headers: incoming.headers,
          body: () => text,
          whole: () => within(`the body of ${what}`, whole.promise),
          received: expected => {
            const wait = `the body of ${what} to hold ${JSON.stringify(expected)}`;
            const failed = waitFailure(wait);
            let searched = 0;

            return within(
              wait,
              new Promise<void>((resolveFound, rejectFound) => {
                const check = (): void => {
                  // Only the new text, and the tail a match could begin in.
                  const found = text.includes(
                    expected,
                    Math.max(0, searched - expected.length),
                  );

                  searched = text.length;

                  if (found) {
                    checks.delete(check);
                    resolveFound();
                  } else if (ended) {
                    checks.delete(check);
                    rejectFound(failed.because('the connection ended first'));
                  }
                };

                checks.add(check);
                check();
              }),
            );
          },
          pause: () => {
            incoming.pause();
          },
          resume: () => {
            incoming.resume();
          },
          hangUp: () => {
            outgoing.destroy();
          },
          ended: () => within(`${what} to end`, gone.promise),
        });
      });
      outgoing.end(sent.body);
    }),
  );
}
