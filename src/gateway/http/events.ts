import type {HttpBindings} from '@hono/node-server';
import type {Context} from 'hono';
import {streamSSE, type SSEStreamingApi} from 'hono/streaming';

import {
  gatewayProtocolVersion,
  type Gateway,
  type GatewayReady,
} from '../api/contract.ts';
import type {ApiEnv} from './env.ts';

export type EventStreamsOptions = {
  /** Keeps an idle connection alive through client body timeouts; tests shorten it. */
  readonly heartbeatMs?: number;
  /** Frames a client may leave unread before it is treated as gone. */
  readonly maxPendingFrames?: number;
};

export type EventStreams = {
  readonly handler: (c: Context<ApiEnv>) => Response;
  /** Streams open right now. */
  readonly openCount: () => number;
  /**
   * Ends every open stream once the frames already queued for it are
   * written, dropping a client that does not take them within the drain
   * grace, and ends at once any stream that arrives later: a request can
   * pass the stopping guard before it is set and reach its stream after.
   * Shutdown awaits it after the gateway drained its turns, so the last
   * reply rides out before the stream ends.
   */
  readonly closeAll: () => Promise<void>;
};

export type FrameQueue = {
  push(frame: string): void;
  pending(): number;
  /**
   * Settles true once every frame pushed so far has been written. A client
   * that has not taken them within the grace is dropped, and it settles
   * false.
   */
  drain(graceMs: number): Promise<boolean>;
};

/** The first frame on every stream; a client bootstraps on each one it sees. */
export const readyEvent = 'ready';

const defaultHeartbeatMs = 15_000;
const defaultMaxPendingFrames = 64;
/** A reading client takes the last frames in milliseconds; this is for one that stopped. */
const drainGraceMs = 2_000;
const heartbeatFrame = ': ping\n\n';

/** SSE framing: the event name, one line of JSON, a blank line. */
export function formatEventFrame(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

/**
 * Writes frames in order and counts the ones the socket has not taken yet.
 * Past the bound, or past the drain grace, the client is not slow, it is
 * gone: `drop` ends it, and every later frame is discarded rather than
 * buffered without limit.
 */
export function createFrameQueue(options: {
  readonly write: (frame: string) => Promise<unknown>;
  readonly drop: () => void;
  readonly maxPendingFrames: number;
}): FrameQueue {
  let chain: Promise<unknown> = Promise.resolve();
  let pending = 0;
  let dropped = false;
  const abandon = (): void => {
    dropped = true;
    options.drop();
  };

  return Object.freeze({
    push(frame) {
      if (dropped) {
        return;
      }

      if (pending >= options.maxPendingFrames) {
        abandon();
        return;
      }

      pending += 1;
      chain = chain
        .then(() => options.write(frame))
        .then(
          () => {
            pending -= 1;
          },
          () => {
            pending -= 1;
          },
        );
    },
    pending: () => pending,
    drain: graceMs =>
      dropped
        ? Promise.resolve(false)
        : new Promise<boolean>(resolve => {
            const timer = setTimeout(() => {
              abandon();
              resolve(false);
            }, graceMs);
            const written = (): void => {
              clearTimeout(timer);
              resolve(true);
            };

            chain.then(written, written);
          }),
  });
}

/**
 * One SSE stream per connection over the gateway's event fan-out. The
 * daemon's listener is registered and the snapshot taken in one breath,
 * so `ready` is exactly the state every later event moves on from: a
 * client installs it and reads on, with nothing to fetch and nothing to
 * order — the stream stays a hint, and the verbs the truth.
 */
export function createEventStreams(
  source: Pick<Gateway, 'events' | 'health' | 'pendingConfirmations'>,
  options: EventStreamsOptions = {},
): EventStreams {
  const heartbeatMs = options.heartbeatMs ?? defaultHeartbeatMs;
  const maxPendingFrames = options.maxPendingFrames ?? defaultMaxPendingFrames;
  const closers = new Set<() => Promise<void>>();
  let closed = false;

  return Object.freeze({
    handler(c) {
      const response = streamSSE(c, stream => runStream(c, stream));

      // The helper's own no-cache is fine; the API's rule is stricter.
      response.headers.set('Cache-Control', 'no-store');

      return response;
    },
    openCount: () => closers.size,
    closeAll: () => {
      closed = true;

      return Promise.all([...closers].map(close => close())).then(
        () => undefined,
      );
    },
  });

  async function runStream(
    c: Context<ApiEnv>,
    stream: SSEStreamingApi,
  ): Promise<void> {
    if (closed) {
      return;
    }

    const heartbeat = createHeartbeatClock();
    const close = async (): Promise<void> => {
      heartbeat.stop();

      if (await queue.drain(drainGraceMs)) {
        await stream.close();
      }
    };
    const queue = createFrameQueue({
      write: frame => stream.write(frame),
      drop() {
        heartbeat.stop();
        // The adapter types the bindings as always present; app.request()
        // runs handlers with none, and then there is no socket to destroy.
        (c.env as HttpBindings | undefined)?.outgoing.destroy();
        stream.abort();
      },
      maxPendingFrames,
    });

    stream.onAbort(() => {
      heartbeat.stop();
    });
    closers.add(close);

    const unsubscribe = source.events(event => {
      queue.push(formatEventFrame(event.kind, JSON.stringify(event)));
    });
    const snapshot: GatewayReady = {
      protocolVersion: gatewayProtocolVersion,
      health: source.health(),
      confirmations: source.pendingConfirmations(),
    };

    try {
      queue.push(formatEventFrame(readyEvent, JSON.stringify(snapshot)));

      while (await heartbeat.tick(heartbeatMs)) {
        queue.push(heartbeatFrame);
      }
    } finally {
      unsubscribe();
      closers.delete(close);
    }
  }
}

/**
 * Paces the heartbeat. `tick` resolves true after the interval and false
 * as soon as the stream stops, so a close or an abort never waits it out.
 */
function createHeartbeatClock(): {
  tick(ms: number): Promise<boolean>;
  stop(): void;
} {
  let stopped = false;
  let interrupt: (() => void) | undefined;

  return {
    tick: ms =>
      stopped
        ? Promise.resolve(false)
        : new Promise<boolean>(resolve => {
            const timer = setTimeout(() => {
              interrupt = undefined;
              resolve(true);
            }, ms);

            interrupt = () => {
              clearTimeout(timer);
              interrupt = undefined;
              resolve(false);
            };
          }),
    stop: () => {
      stopped = true;
      interrupt?.();
    },
  };
}
