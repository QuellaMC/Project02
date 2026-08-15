import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {createFileRuntimeLogStore} from '../../src/runtime/storage/file-runtime-log-store.ts';
import {listDirectoryNamesSync} from '../../src/shared/file-system.ts';
import {createLocalRuntimeSessionStore} from '../../src/runtime/storage/session-store.ts';
import {testCharacterProfile} from '../support/character-fixtures.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

describe('local runtime session store symlink guards', () => {
  it('tolerates Finder metadata in the sessions directory', async () => {
    const root = createTestTempRoot('project02-session-metadata-');
    const storeRoot = join(root, 'home', 'character-data', 'mira');
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    });

    await store.createSession({
      sessionId: 'session-00',
      createdAt: '2026-08-14T00:00:00.000Z',
    });
    writeFileSync(join(store.layout.sessionsRoot, '.DS_Store'), 'finder');

    // Browsing the store in Finder is an ordinary condition, not
    // corruption: listing and reading must keep working.
    await expect(store.listSessions()).resolves.toHaveLength(1);
    await expect(store.readSession('session-00')).resolves.toBeDefined();

    // A stray metadata file alone must not read as durable evidence
    // demanding a session catalog.
    rmSync(join(store.layout.sessionsRoot, 'session-00'), {
      force: true,
      recursive: true,
    });
    rmSync(store.layout.sessionCatalogPath, {force: true});
    await expect(store.listSessions()).resolves.toHaveLength(0);
  });

  it('tolerates Finder metadata inside an interrupted session directory', async () => {
    const root = createTestTempRoot('project02-session-metadata-nested-');
    const storeRoot = join(root, 'home', 'character-data', 'mira');
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    });

    await store.createSession({
      sessionId: 'session-00',
      createdAt: '2026-08-14T00:00:00.000Z',
    });
    rmSync(store.layout.sessionCatalogPath, {force: true});

    const orphan = join(store.layout.sessionsRoot, 'session-00');

    for (const name of listDirectoryNamesSync(orphan)) {
      rmSync(join(orphan, name), {force: true, recursive: true});
    }
    writeFileSync(join(orphan, '.DS_Store'), 'finder');

    // A crash can leave an empty session directory; browsing it in Finder
    // must not turn a recoverable store into a missing-catalog error.
    await expect(store.listSessions()).resolves.toHaveLength(0);
  });

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

    // The guard runs before the lock root is prepared.
    expect(existsSync(join(realStore, '.locks'))).toBe(false);
  });

  it('refuses an absent store root under a symlinked character-data parent', async () => {
    const root = createTestTempRoot('project02-store-parent-symlink-');
    const outside = join(root, 'outside');
    const home = join(root, 'home');

    mkdirSync(outside, {recursive: true});
    mkdirSync(home, {recursive: true});
    symlinkSync(outside, join(home, 'character-data'), 'dir');

    // A leaf-only guard admits the absent root, and taking the lock then creates
    // it recursively inside the link target.
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

    // First access caches session identity; realness is not settled with it.
    expect(logStore.rawEvents()).toEqual([]);

    const sessionRoot = join(store.layout.sessionsRoot, 'session-00');
    renameSync(sessionRoot, join(root, 'parked'));
    symlinkSync(outside, sessionRoot, 'dir');

    expect(() => logStore.rawEvents()).toThrow(/must be a real directory/);
    expect(readdirSync(outside)).toEqual([]);
  });
});
