import {randomBytes} from 'node:crypto';

import type {HttpBindings} from '@hono/node-server';
import type {Context} from 'hono';
import {streamSSE, type SSEStreamingApi} from 'hono/streaming';

import {
  gatewayProtocolVersion,
  type Gateway,
  type GatewayReady,
  type RunningTurn,
} from '../api/contract.ts';
import {foldRunningTurns, type RunningTurns} from '../api/running-turns.ts';
import type {ApiEnv} from './env.ts';

export type EventStreamsOptions = {
  /** Keeps an idle connection alive through client body timeouts; tests shorten it. */
  readonly heartbeatMs?: number | undefined;
  /** How long a client may leave one frame untaken before it is treated as gone; tests shorten it. */
  readonly graceMs?: number | undefined;
  /** How much of the log is kept for a client that returns; tests shorten it. */
  readonly replayBytes?: number;
};

export type EventStreams = {
  /** A connector's process names itself, and is present while its stream is open. */
  readonly handler: (c: Context<ApiEnv>, connectorId?: string) => Response;
  /** Streams open right now. */
  readonly openCount: () => number;
  /**
   * Ends every open stream once the frames already queued for it are
   * written — a client that does not take them within the grace is
   * dropped — ends at once any stream that arrives later (a request can
   * pass the stopping guard before it is set and reach its stream after),
   * and lets go of the gateway. Shutdown awaits it after the gateway
   * drained its turns, so the last reply rides out before the stream
   * ends.
   */
  readonly closeAll: () => Promise<void>;
};

export type FrameQueue = {
  push(frame: string): void;
  /** Settles once every frame pushed so far is written, or the client was dropped on the way. */
  drain(): Promise<void>;
};

/**
 * The tail of the stream, numbered: what a client that returns with the
 * id of the last frame it applied is handed before the live stream.
 */
export type EventLog = {
  /** This run's id; an id from another run names frames this log never held. */
  readonly run: string;
  /** The number of the newest frame; 0 before the first. */
  latest(): number;
  /** Appends the frame under the next number and returns it. */
  append(frame: string): number;
  /**
   * The frames after the one the id names, oldest first — none when the
   * client holds the newest — or undefined when the id is from another
   * run, names a frame the log no longer holds, or none it ever held.
   */
  after(lastEventId: string): readonly string[] | undefined;
};

/** The first frame on a stream that cannot be caught up: the snapshot. */
export const readyEvent = 'ready';
/** The first frame on a stream that is caught up instead: nothing to install. */
export const resumedEvent = 'resumed';

const defaultHeartbeatMs = 15_000;
/**
 * How long a client may take to take what it was sent — a frame, or at
 * shutdown an answer — before it is gone. A reading client takes it in
 * milliseconds, whatever burst it arrives in; this only ever meets one
 * that stopped.
 */
export const clientGraceMs = 2_000;
/**
 * How much of the stream is kept for a client that returns: minutes of a
 * busy stream, since a reply is a few kilobytes a second. A client further
 * back gets the snapshot, which is always right. Bytes, because a frame's
 * size is not bounded by anything a person could name.
 */
const defaultReplayBytes = 1024 * 1024;
const heartbeatFrame = ': ping\n\n';
const eventIdPattern = /^([0-9a-f]{16})-([0-9]{1,15})$/u;

/** SSE framing: the id when the frame has one, the event name, one line of JSON, a blank line. */
export function formatEventFrame(
  event: string,
  data: string,
  id?: string,
): string {
  return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${data}\n\n`;
}

/**
 * Writes frames in order, each given the grace to be taken. A client that
 * has not taken a frame within it is not slow, it is gone: `drop` ends it,
 * and every later frame is discarded rather than buffered without limit.
 * How many frames wait their turn says nothing about the client — a reply
 * spoken in one breath queues hundreds — so nothing is judged by it.
 */
export function createFrameQueue(options: {
  readonly write: (frame: string) => Promise<unknown>;
  readonly drop: () => void;
  readonly graceMs: number;
}): FrameQueue {
  let chain: Promise<unknown> = Promise.resolve();
  let dropped = false;
  const writeWithinGrace = (frame: string): Promise<void> =>
    new Promise(resolve => {
      const timer = setTimeout(() => {
        dropped = true;
        options.drop();
        resolve();
      }, options.graceMs);
      const taken = (): void => {
        clearTimeout(timer);
        resolve();
      };

      options.write(frame).then(taken, taken);
    });

  return Object.freeze({
    push(frame) {
      if (dropped) {
        return;
      }

      chain = chain.then(() => (dropped ? undefined : writeWithinGrace(frame)));
    },
    drain: () => chain.then(() => undefined),
  });
}

/**
 * Keeps the newest frames up to a byte budget, oldest out first. An id is
 * reachable from one before the oldest frame kept — a client that saw
 * exactly up to it missed nothing the log has lost — to the newest.
 */
export function createEventLog(options: {readonly maxBytes: number}): EventLog {
  const run = randomBytes(8).toString('hex');
  const frames: {readonly seq: number; readonly frame: string}[] = [];
  let latest = 0;
  let bytes = 0;

  return Object.freeze({
    run,
    latest: () => latest,
    append(frame) {
      latest += 1;
      frames.push({seq: latest, frame});
      bytes += Buffer.byteLength(frame);

      while (bytes > options.maxBytes && frames.length > 0) {
        bytes -= Buffer.byteLength(frames[0]?.frame ?? '');
        frames.shift();
      }

      return latest;
    },
    after(lastEventId) {
      const match = eventIdPattern.exec(lastEventId);

      if (match === null || match[1] !== run) {
        return undefined;
      }

      const seq = Number(match[2]);
      const oldestKept = frames[0]?.seq ?? latest + 1;

      if (seq < oldestKept - 1 || seq > latest) {
        return undefined;
      }

      return frames.filter(kept => kept.seq > seq).map(kept => kept.frame);
    },
  });
}

/**
 * The SSE streams over the gateway's event fan-out. One subscription,
 * taken when the streams are created and kept as long as they live,
 * numbers and formats every event once, keeps the tail of the log, and
 * hands the frame to each open stream in the same tick; it also folds the
 * turns running, so a stream opened mid-reply finds the reply so far in
 * its snapshot whether or not anyone was listening before. A stream
 * opens with one of two frames, taken in one synchronous breath with its
 * registration: a client that returns with the id of the last frame it
 * applied gets `resumed` and exactly the frames after it; any other gets
 * `ready`, the snapshot that is exactly the state every later frame moves
 * on from. A client installs the one and reads on after either — the
 * stream stays a hint, and the verbs the truth.
 */
export function createEventStreams(
  source: Pick<
    Gateway,
    | 'events'
    | 'health'
    | 'pendingConfirmations'
    | 'pendingPairings'
    | 'connectorPresent'
  >,
  options: EventStreamsOptions = {},
): EventStreams {
  const heartbeatMs = options.heartbeatMs ?? defaultHeartbeatMs;
  const graceMs = options.graceMs ?? clientGraceMs;
  const log = createEventLog({
    maxBytes: options.replayBytes ?? defaultReplayBytes,
  });
  const closers = new Set<() => Promise<void>>();
  const attached = new Set<FrameQueue>();
  let turns: RunningTurns = new Map();
  let closed = false;
  const unsubscribe = source.events(event => {
    turns = foldRunningTurns(turns, event);

    const seq = log.latest() + 1;
    const frame = formatEventFrame(
      event.kind,
      JSON.stringify(event),
      `${log.run}-${String(seq)}`,
    );

    log.append(frame);

    for (const queue of attached) {
      queue.push(frame);
    }
  });

  return Object.freeze({
    handler(c, connectorId) {
      const response = streamSSE(c, stream =>
        runStream(c, stream, connectorId),
      );

      // The helper's own no-cache is fine; the API's rule is stricter.
      response.headers.set('Cache-Control', 'no-store');

      return response;
    },
    openCount: () => closers.size,
    closeAll: () => {
      closed = true;
      unsubscribe();

      return Promise.all([...closers].map(close => close())).then(
        () => undefined,
      );
    },
  });

  async function runStream(
    c: Context<ApiEnv>,
    stream: SSEStreamingApi,
    connectorId: string | undefined,
  ): Promise<void> {
    if (closed) {
      return;
    }

    const heartbeat = createHeartbeatClock();
    const {promise: ended, resolve: end}: PromiseWithResolvers<void> =
      Promise.withResolvers();
    const close = (): Promise<void> => {
      heartbeat.stop();

      return ended;
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
      graceMs,
    });

    stream.onAbort(() => {
      heartbeat.stop();
    });
    closers.add(close);

    // Present before the first frame, so what a connector's own stream
    // opens with already counts it.
    const leave =
      connectorId === undefined
        ? undefined
        : source.connectorPresent(connectorId);

    try {
      // First frame and attachment in one breath: no event lands between.
      const lastEventId = c.req.header('last-event-id');
      const missed =
        lastEventId === undefined ? undefined : log.after(lastEventId);

      if (missed === undefined) {
        const snapshot: GatewayReady = {
          protocolVersion: gatewayProtocolVersion,
          health: source.health(),
          confirmations: source.pendingConfirmations(),
          pairings: source.pendingPairings(),
          turns: runningTurns(turns),
        };

        queue.push(
          formatEventFrame(
            readyEvent,
            JSON.stringify(snapshot),
            `${log.run}-${String(log.latest())}`,
          ),
        );
      } else {
        queue.push(formatEventFrame(resumedEvent, '{}'));

        for (const frame of missed) {
          queue.push(frame);
        }
      }

      attached.add(queue);

      while (await heartbeat.tick(heartbeatMs)) {
        queue.push(heartbeatFrame);
      }

      // Hono ends the stream once this returns, so what is queued for it
      // is written first.
      await queue.drain();
    } finally {
      attached.delete(queue);
      closers.delete(close);
      leave?.();
      end();
    }
  }
}

function runningTurns(turns: RunningTurns): readonly RunningTurn[] {
  return Object.freeze([...turns.values()]);
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
