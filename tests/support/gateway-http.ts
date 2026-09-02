import {serve} from '@hono/node-server';

import {
  createSseFrameSplitter,
  type SseFrame,
} from '../../src/gateway/client/index.ts';
import {createGatewayApp} from '../../src/gateway/http/app.ts';
import {
  createEventStreams,
  type EventStreams,
  type EventStreamsOptions,
} from '../../src/gateway/http/events.ts';
import type {Gateway} from '../../src/gateway/index.ts';

export const testGatewayToken = 'test-token-0123456789abcdef';

export type TestServer = {
  readonly baseUrl: string;
  readonly port: number;
  /** Stops accepting, severs what is still open, and waits for the close. */
  close(): Promise<void>;
};

export type TestGatewayServer = TestServer & {
  readonly events: EventStreams;
  /** Flip to make every API request answer 503. */
  readonly lifecycle: {stopping: boolean};
};

/** Any fetch handler on a real loopback socket with an ephemeral port. */
export async function listen(app: {
  readonly fetch: (request: Request) => Response | Promise<Response>;
}): Promise<TestServer> {
  const server = serve({fetch: app.fetch, hostname: '127.0.0.1', port: 0});

  await new Promise<void>(resolve => {
    server.once('listening', () => {
      resolve();
    });
  });

  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('The test server has no TCP address.');
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    port: address.port,
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => {
          resolve();
        });

        if ('closeAllConnections' in server) {
          server.closeAllConnections();
        }
      }),
  };
}

/** A real socket on an ephemeral port over a gateway the test already holds. */
export async function startTestGatewayServer(options: {
  readonly gateway: Gateway;
  readonly uiRoot?: string;
  readonly streams?: EventStreamsOptions;
}): Promise<TestGatewayServer> {
  const events = createEventStreams(options.gateway, options.streams ?? {});
  const lifecycle = {stopping: false};
  const app = createGatewayApp({
    gateway: options.gateway,
    token: testGatewayToken,
    events,
    lifecycle: {stopping: () => lifecycle.stopping},
    ...(options.uiRoot === undefined ? {} : {uiRoot: options.uiRoot}),
  });
  const server = await listen(app);

  return {
    ...server,
    events,
    lifecycle,
    close() {
      events.closeAll();

      return server.close();
    },
  };
}

export type {SseFrame};

export type EventSubscription = {
  readonly response: Response;
  readonly frames: readonly SseFrame[];
  /** The next unconsumed frame that matches, already received or still to come. */
  next(
    match: (frame: SseFrame) => boolean,
    timeoutMs?: number,
  ): Promise<SseFrame>;
  /** Settles when the server ends the stream. */
  readonly ended: Promise<void>;
  cancel(): Promise<void>;
};

export async function subscribeToEvents(
  baseUrl: string,
  token = testGatewayToken,
): Promise<EventSubscription> {
  const response = await fetch(`${baseUrl}/api/events`, {
    headers: {authorization: `Bearer ${token}`},
  });

  if (!response.ok || response.body === null) {
    throw new Error(`Events stream refused: ${String(response.status)}`);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const splitter = createSseFrameSplitter();
  const frames: SseFrame[] = [];
  const waiters: {
    readonly match: (frame: SseFrame) => boolean;
    readonly resolve: (frame: SseFrame) => void;
  }[] = [];
  let cursor = 0;
  const ended = (async () => {
    for (;;) {
      const {value, done} = await reader.read();

      if (done) {
        return;
      }

      for (const frame of splitter.push(value)) {
        frames.push(frame);

        const waiting = waiters.findIndex(waiter => waiter.match(frame));

        if (waiting !== -1) {
          const [waiter] = waiters.splice(waiting, 1);

          cursor = frames.length;
          waiter?.resolve(frame);
        }
      }
    }
  })().catch(() => undefined);

  return {
    response,
    frames,
    next(match, timeoutMs = 5_000) {
      const index = frames.findIndex(
        (frame, position) => position >= cursor && match(frame),
      );

      if (index !== -1) {
        cursor = index + 1;

        return Promise.resolve(frames[index] as SseFrame);
      }

      return new Promise<SseFrame>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `No matching frame within ${String(timeoutMs)} ms; saw ${JSON.stringify(frames)}`,
            ),
          );
        }, timeoutMs);

        waiters.push({
          match,
          resolve: frame => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    },
    ended,
    cancel: () => reader.cancel(),
  };
}

export function frameData(frame: SseFrame): unknown {
  return frame.data === undefined ? undefined : JSON.parse(frame.data);
}
