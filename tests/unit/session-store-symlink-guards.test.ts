import {existsSync, mkdirSync, renameSync, symlinkSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {createLocalRuntimeSessionStore} from '../../src/runtime/storage/session-store.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

describe('local runtime session store symlink guards', () => {
  it('refuses a session directory replaced by a symlink outside the store', async () => {
    const root = createTestTempRoot('project02-session-symlink-');
    const storeRoot = join(root, 'home', 'character-data', 'mira');
    const outside = join(root, 'outside');

    mkdirSync(outside, {recursive: true});

    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    });

    await store.createSession({
      sessionId: 'session-00',
      createdAt: '2026-07-16T00:00:00.000Z',
    });

    // Swap the real session directory for a link to a directory outside the
    // character data root; evidence readers must refuse it rather than follow
    // the link and read files from the target.
    const sessionRoot = join(store.layout.sessionsRoot, 'session-00');
    renameSync(sessionRoot, join(root, 'parked'));
    symlinkSync(outside, sessionRoot, 'dir');

    await expect(store.readSession('session-00')).rejects.toThrow(
      /must be a real directory/,
    );
  });

  it('refuses a symlinked store root before creating any lock files', async () => {
    const root = createTestTempRoot('project02-store-symlink-');
    const realStore = join(root, 'real-store');
    const linkedStore = join(root, 'home', 'character-data', 'mira-symlink');

    mkdirSync(realStore, {recursive: true});
    mkdirSync(join(root, 'home', 'character-data'), {recursive: true});
    symlinkSync(realStore, linkedStore, 'dir');

    const store = createLocalRuntimeSessionStore({
      storeRoot: linkedStore,
      characterId: 'mira',
    });

    await expect(
      store.createSession({
        sessionId: 'session-00',
        createdAt: '2026-07-16T00:00:00.000Z',
      }),
    ).rejects.toThrow(/must be a real directory/);

    // The guard has to run before the lock root is prepared, so a rejected
    // store never routes control files into the link target.
    expect(existsSync(join(realStore, '.locks'))).toBe(false);
  });
});
