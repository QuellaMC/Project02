import {mkdtemp, rm} from 'node:fs/promises';
import type {PathLike} from 'node:fs';
import type * as NodeFileSystemPromises from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it, vi} from 'vitest';

const directoryStatProbe = vi.hoisted(() => ({
  active: 0,
  blocking: false,
  maximumActive: 0,
  targetPrefix: undefined as string | undefined,
  releases: [] as Array<() => void>,
  reachedExpectedConcurrency: undefined as (() => void) | undefined,
}));

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof NodeFileSystemPromises>();

  return {
    ...original,
    stat: async (path: PathLike) => {
      if (
        !directoryStatProbe.blocking ||
        directoryStatProbe.targetPrefix === undefined ||
        !String(path).startsWith(directoryStatProbe.targetPrefix)
      ) {
        return await original.stat(path);
      }

      directoryStatProbe.active += 1;
      directoryStatProbe.maximumActive = Math.max(
        directoryStatProbe.maximumActive,
        directoryStatProbe.active,
      );
      if (directoryStatProbe.active === 16) {
        directoryStatProbe.reachedExpectedConcurrency?.();
      }

      await new Promise<void>(resolve => {
        directoryStatProbe.releases.push(resolve);
      });

      try {
        return await original.stat(path);
      } finally {
        directoryStatProbe.active -= 1;
      }
    },
  };
});

import {createLocalRuntimeSessionStore} from '../../src/runtime/storage/session-store.ts';

const tempRoots: string[] = [];

describe('local runtime session catalog reconciliation concurrency', () => {
  afterEach(async () => {
    releaseBlockedDirectoryStats();
    directoryStatProbe.active = 0;
    directoryStatProbe.blocking = false;
    directoryStatProbe.maximumActive = 0;
    directoryStatProbe.targetPrefix = undefined;
    directoryStatProbe.reachedExpectedConcurrency = undefined;

    await Promise.all(
      tempRoots.map(async root => {
        await rm(root, {recursive: true, force: true});
      }),
    );
    tempRoots.length = 0;
  });

  it('caps concurrent session-directory point reads at 16', async () => {
    const storeRoot = await createTempStoreRoot();
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    });

    for (let index = 0; index < 17; index += 1) {
      await store.createSession({
        sessionId: `session-${String(index).padStart(2, '0')}`,
        createdAt: '2026-07-16T00:00:00.000Z',
      });
    }

    const reachedExpectedConcurrency = new Promise<void>(resolve => {
      directoryStatProbe.reachedExpectedConcurrency = resolve;
    });
    directoryStatProbe.targetPrefix = `${store.layout.sessionsRoot}/`;
    directoryStatProbe.blocking = true;

    const listedSessions = store.listSessions();
    const probeOutcome = await Promise.race([
      reachedExpectedConcurrency.then(() => 'reached' as const),
      listedSessions.then(() => 'completed' as const),
      new Promise<'stalled'>(resolve => {
        setTimeout(() => {
          resolve('stalled');
        }, 250);
      }),
    ]);

    try {
      expect({
        active: directoryStatProbe.active,
        maximumActive: directoryStatProbe.maximumActive,
        outcome: probeOutcome,
      }).toMatchObject({
        active: 16,
        outcome: 'reached',
      });
      expect(directoryStatProbe.maximumActive).toBe(16);
    } finally {
      releaseBlockedDirectoryStats();
    }

    await expect(listedSessions).resolves.toHaveLength(17);
  });
});

function releaseBlockedDirectoryStats(): void {
  directoryStatProbe.blocking = false;
  for (const release of directoryStatProbe.releases.splice(0)) {
    release();
  }
}

async function createTempStoreRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'project02-session-cap-test-'));
  tempRoots.push(root);
  return root;
}
