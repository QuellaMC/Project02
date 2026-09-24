import {describe, expect, it, vi} from 'vitest';

import {
  createEventLog,
  createFrameQueue,
  formatEventFrame,
} from '../../src/gateway/http/events.ts';

describe('gateway event stream frames', () => {
  it('formats an event as one SSE frame, with its id when it has one', () => {
    expect(formatEventFrame('ready', '{"protocolVersion":1}')).toBe(
      'event: ready\ndata: {"protocolVersion":1}\n\n',
    );
    expect(formatEventFrame('state_changed', '{}', 'ab-7')).toBe(
      'id: ab-7\nevent: state_changed\ndata: {}\n\n',
    );
  });

  it('keeps the tail of the log within its budget, oldest out first, and answers an id it cannot reach with nothing', () => {
    const frame = (seq: number): string => `event: e\ndata: ${String(seq)}\n\n`;
    const log = createEventLog({maxBytes: 3 * frame(1).length});

    expect(log.latest()).toBe(0);
    // Before the first frame, the number before it is the tail.
    expect(log.after(`${log.run}-0`)).toEqual([]);

    for (let seq = 1; seq <= 5; seq += 1) {
      expect(log.append(frame(seq))).toBe(seq);
    }

    expect(log.latest()).toBe(5);
    expect(log.after(`${log.run}-5`)).toEqual([]);
    expect(log.after(`${log.run}-3`)).toEqual([frame(4), frame(5)]);
    // One before the oldest kept saw everything the tail has since lost.
    expect(log.after(`${log.run}-2`)).toEqual([frame(3), frame(4), frame(5)]);
    expect(log.after(`${log.run}-1`)).toBeUndefined();
    expect(log.after(`${log.run}-6`)).toBeUndefined();
    expect(log.after(`${'f'.repeat(16)}-3`)).toBeUndefined();
    expect(log.after('yesterday')).toBeUndefined();
  });

  it('writes frames in order, one at a time, and reports the drain once the last one is out', async () => {
    const written: string[] = [];
    const releases: (() => void)[] = [];
    const queue = createFrameQueue({
      write: frame =>
        new Promise<void>(resolve => {
          releases.push(() => {
            written.push(frame);
            resolve();
          });
        }),
      drop: () => {
        throw new Error('nothing should be dropped');
      },
      graceMs: 1_000,
    });

    queue.push('first');
    queue.push('second');
    queue.push('third');
    await Promise.resolve();

    // Only the head is in flight; the rest wait their turn.
    expect(releases).toHaveLength(1);

    let drained: boolean | undefined;

    void queue.drain().then(written => {
      drained = written;
    });
    releases[0]?.();
    await new Promise(resolve => setImmediate(resolve));
    releases[1]?.();
    await new Promise(resolve => setImmediate(resolve));
    // A close that waits on the drain still has the last frame ahead of it.
    expect(drained).toBeUndefined();
    releases[2]?.();
    await new Promise(resolve => setImmediate(resolve));

    expect(written).toEqual(['first', 'second', 'third']);
    expect(drained).toBe(true);
  });

  it('drops a client that has not taken a frame within the grace, once, and discards the rest', async () => {
    vi.useFakeTimers();

    try {
      let drops = 0;
      let writes = 0;
      const queue = createFrameQueue({
        write: () => {
          writes += 1;

          return new Promise(() => undefined);
        },
        drop: () => {
          drops += 1;
        },
        graceMs: 10,
      });

      for (let index = 0; index < 100; index += 1) {
        queue.push(`frame ${String(index)}`);
      }

      // A hundred frames waiting their turn is a burst, not a verdict: the
      // grace runs for the one frame the client has been handed.
      await vi.advanceTimersByTimeAsync(9);
      expect(drops).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(drops).toBe(1);
      expect(writes).toBe(1);

      // Dropped once; what waited is discarded, and so is what comes later.
      queue.push('late');
      await expect(queue.drain()).resolves.toBe(false);
      expect(writes).toBe(1);
      expect(drops).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
