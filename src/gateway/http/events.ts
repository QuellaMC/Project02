import type {HttpBindings} from '@hono/node-server';
import type {Context} from 'hono';
import {streamSSE, type SSEStreamingApi} from 'hono/streaming';

import {gatewayProtocolVersion, type Gateway} from '../api/contract.ts';
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
  /** Ends every open stream; shutdown calls it before the gateway stops. */
  readonly closeAll: () => void;
};

export type FrameQueue = {
  push(frame: string): void;
  pending(): number;
};

/** The first frame on every stream; a client bootstraps on each one it sees. */
export const readyEvent = 'ready';

const defaultHeartbeatMs = 15_000;
const defaultMaxPendingFrames = 64;
const heartbeatFrame = ': ping\n\n';

/** SSE framing: the event name, one line of JSON, a blank line. */
export function formatEventFrame(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

/**
 * Writes frames in order and counts the ones the socket has not taken yet.
 * Past the bound the client is not slow, it is gone: `drop` ends it, and
 * every later frame is discarded rather than buffered without limit.
 */
export function createFrameQueue(options: {
  readonly write: (frame: string) => Promise<unknown>;
  readonly drop: () => void;
  readonly maxPendingFrames: number;
}): FrameQueue {
  let chain: Promise<unknown> = Promise.resolve();
  let pending = 0;
  let dropped = false;

  return Object.freeze({
    push(frame) {
      if (dropped) {
        return;
      }

      if (pending >= options.maxPendingFrames) {
        dropped = true;
        options.drop();
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
  });
}

/**
 * One SSE stream per connection over the gateway's event fan-out. The
 * daemon's listener is registered before `ready` is written, so nothing
 * between the handshake and the client's first snapshot can be missed —
 * the stream stays a hint, and the verbs the truth.
 */
export function createEventStreams(
  source: Pick<Gateway, 'events'>,
  options: EventStreamsOptions = {},
): EventStreams {
  const heartbeatMs = options.heartbeatMs ?? defaultHeartbeatMs;
  const maxPendingFrames = options.maxPendingFrames ?? defaultMaxPendingFrames;
  const closers = new Set<() => void>();

  return Object.freeze({
    handler(c) {
      const response = streamSSE(c, stream => runStream(c, stream));

      // The helper's own no-cache is fine; the API's rule is stricter.
      response.headers.set('Cache-Control', 'no-store');

      return response;
    },
    openCount: () => closers.size,
    closeAll() {
      for (const close of [...closers]) {
        close();
      }
    },
  });

  async function runStream(
    c: Context<ApiEnv>,
    stream: SSEStreamingApi,
  ): Promise<void> {
    const heartbeat = createHeartbeatClock();
    const close = (): void => {
      heartbeat.stop();
      void stream.close();
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

    try {
      queue.push(
        formatEventFrame(
          readyEvent,
          JSON.stringify({protocolVersion: gatewayProtocolVersion}),
        ),
      );

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
