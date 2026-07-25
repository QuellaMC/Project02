import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {createFileRuntimeLogStore} from '../../src/runtime/storage/file-runtime-log-store.ts';
import {createLocalRuntimeSessionStore} from '../../src/runtime/storage/session-store.ts';
import {testCharacterProfile} from '../support/character-fixtures.ts';
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

  it('refuses an absent store root under a symlinked character-data parent', async () => {
    const root = createTestTempRoot('project02-store-parent-symlink-');
    const outside = join(root, 'outside');
    const home = join(root, 'home');

    mkdirSync(outside, {recursive: true});
    mkdirSync(home, {recursive: true});
    symlinkSync(outside, join(home, 'character-data'), 'dir');

    // The store root itself is absent, which a leaf-only guard accepts because
    // the caller may create it under the lock. Acquiring that lock creates the
    // root recursively, so the symlinked parent has to be rejected first or the
    // rejected call still writes into the link target.
    const store = createLocalRuntimeSessionStore({
      storeRoot: join(home, 'character-data', 'mira'),
      characterId: 'mira',
    });

    await expect(
      store.createSession({
        sessionId: 'session-00',
        createdAt: '2026-07-16T00:00:00.000Z',
      }),
    ).rejects.toThrow(/must be a real directory/);

    expect(existsSync(join(outside, 'mira'))).toBe(false);
  });

  it('rechecks the session directory after a read has already succeeded', async () => {
    const root = createTestTempRoot('project02-session-recheck-');
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

    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'session-00',
      characterId: 'mira',
      boundCharacter: testCharacterProfile,
    });

    // First access settles session identity. Whether the directory is a real
    // directory is not settled by it, so the swap below has to be caught even
    // though the identity check is already cached.
    expect(logStore.rawEvents()).toEqual([]);

    const sessionRoot = join(store.layout.sessionsRoot, 'session-00');
    renameSync(sessionRoot, join(root, 'parked'));
    symlinkSync(outside, sessionRoot, 'dir');

    expect(() => logStore.rawEvents()).toThrow(/must be a real directory/);
    expect(readdirSync(outside)).toEqual([]);
  });
});
