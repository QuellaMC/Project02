import {describe, expect, it} from 'vitest';

import {createToolBatchLock} from '../../src/role-model/loop/tool-batch-lock.ts';

describe('tool batch execution lock', () => {
  it('overlaps shared calls and runs exclusive calls alone', async () => {
    const lock = createToolBatchLock();
    const events: string[] = [];
    const run = (name: string, mode: 'shared' | 'exclusive') =>
      lock.run(mode, async () => {
        events.push(`start:${name}`);
        await Promise.resolve();
        await Promise.resolve();
        events.push(`end:${name}`);
      });

    await Promise.all([
      run('readA', 'shared'),
      run('readB', 'shared'),
      run('write', 'exclusive'),
      run('readC', 'shared'),
    ]);

    expect(events.indexOf('start:readB')).toBeLessThan(
      events.indexOf('end:readA'),
    );

    const writeStart = events.indexOf('start:write');
    const writeEnd = events.indexOf('end:write');

    expect(events.indexOf('end:readB')).toBeLessThan(writeStart);
    expect(writeEnd).toBeLessThan(events.indexOf('start:readC'));
  });

  it('does not let later shared calls overtake a waiting exclusive call', async () => {
    const lock = createToolBatchLock();
    const events: string[] = [];
    let releaseFirst = (): void => {};
    const firstHeld = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });

    const first = lock.run('shared', async () => {
      events.push('start:first');
      await firstHeld;
      events.push('end:first');
    });
    const exclusive = lock.run('exclusive', () => {
      events.push('start:exclusive');
      return Promise.resolve();
    });
    const late = lock.run('shared', () => {
      events.push('start:late');
      return Promise.resolve();
    });

    releaseFirst();
    await Promise.all([first, exclusive, late]);

    expect(events).toEqual([
      'start:first',
      'end:first',
      'start:exclusive',
      'start:late',
    ]);
  });

  it('releases the lock when a call throws so the batch continues', async () => {
    const lock = createToolBatchLock();
    const failing = lock.run('exclusive', () => {
      throw new Error('tool failed');
    });

    await expect(failing).rejects.toThrow('tool failed');
    await expect(
      lock.run('exclusive', () => Promise.resolve('next call ran')),
    ).resolves.toBe('next call ran');
  });
});
