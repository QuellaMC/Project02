import {describe, expect, it} from 'vitest';

import {
  createFrameQueue,
  formatEventFrame,
} from '../../src/gateway/http/events.ts';

describe('gateway event stream frames', () => {
  it('formats an event as one SSE frame', () => {
    expect(formatEventFrame('ready', '{"protocolVersion":1}')).toBe(
      'event: ready\ndata: {"protocolVersion":1}\n\n',
    );
  });

  it('writes frames in order, one at a time, even when a write is slow', async () => {
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
      maxPendingFrames: 8,
    });

    queue.push('first');
    queue.push('second');
    queue.push('third');
    await Promise.resolve();

    // Only the head is in flight; the rest wait their turn.
    expect(releases).toHaveLength(1);
    expect(queue.pending()).toBe(3);

    releases[0]?.();
    await new Promise(resolve => setImmediate(resolve));
    releases[1]?.();
    await new Promise(resolve => setImmediate(resolve));
    releases[2]?.();
    await new Promise(resolve => setImmediate(resolve));

    expect(written).toEqual(['first', 'second', 'third']);
    expect(queue.pending()).toBe(0);
  });

  it('drops a client that stops taking frames, once, and discards the rest', () => {
    let drops = 0;
    const queue = createFrameQueue({
      write: () => new Promise(() => undefined),
      drop: () => {
        drops += 1;
      },
      maxPendingFrames: 3,
    });

    for (let index = 0; index < 10; index += 1) {
      queue.push(`frame ${String(index)}`);
    }

    expect(drops).toBe(1);
    expect(queue.pending()).toBe(3);
  });
});
