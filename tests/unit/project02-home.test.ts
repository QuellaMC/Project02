import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {createTestTempRoot} from '../support/temp-root.ts';
import {
  createProject02HomeLayout,
  ensureInitializedProject02Home,
} from '../../src/runtime/storage/index.ts';
import {acquireLocalRuntimeMutationLock} from '../../src/runtime/storage/mutation-lock.ts';

describe('project02 home initialization', () => {
  it('initializes a fresh home with a scoped marker and the character-data root', async () => {
    const homeRoot = join(createTestTempRoot(), 'fresh-home');

    const layout = await ensureInitializedProject02Home({homeRoot});

    expect(JSON.parse(readFileSync(layout.schemaPath, 'utf8'))).toMatchObject({
      schemaVersion: 8,
      scope: 'home',
    });

    const markerBefore = readFileSync(layout.schemaPath, 'utf8');
    await ensureInitializedProject02Home({homeRoot});
    expect(readFileSync(layout.schemaPath, 'utf8')).toBe(markerBefore);
  });

  it('accepts a home whose allowlisted entries already exist', async () => {
    const homeRoot = join(createTestTempRoot(), 'seeded-home');
    const layout = createProject02HomeLayout({homeRoot});

    mkdirSync(layout.characterPackagesRoot, {recursive: true});
    mkdirSync(layout.pluginPackagesRoot, {recursive: true});
    writeFileSync(layout.configPath, '{"version":"project02.config.v2"}\n');
    writeFileSync(layout.envPath, 'API_KEY=x\n');

    await expect(
      ensureInitializedProject02Home({homeRoot}),
    ).resolves.toMatchObject({homeRoot: layout.homeRoot});
  });

  it('tolerates a live in-flight marker replacement but not an abandoned one', async () => {
    const homeRoot = join(createTestTempRoot(), 'racing-home');

    // A sibling's in-flight marker replacement, named after a live pid.
    mkdirSync(homeRoot, {recursive: true});
    writeFileSync(
      join(
        homeRoot,
        `.schema.json.${String(process.pid)}.` +
          '0f0e0d0c-0b0a-4908-8706-050403020100.tmp',
      ),
      '{}',
    );

    await expect(
      ensureInitializedProject02Home({homeRoot}),
    ).resolves.toMatchObject({homeRoot});

    const abandonedRoot = join(createTestTempRoot(), 'abandoned-home');

    mkdirSync(abandonedRoot, {recursive: true});
    writeFileSync(
      join(
        abandonedRoot,
        '.schema.json.999999999.0f0e0d0c-0b0a-4908-8706-050403020100.tmp',
      ),
      '{}',
    );

    await expect(
      ensureInitializedProject02Home({homeRoot: abandonedRoot}),
    ).rejects.toMatchObject({code: 'missing_file'});
  });

  it('treats a reserved directory name with a file type as foreign', async () => {
    const homeRoot = join(createTestTempRoot(), 'wrong-type-home');

    mkdirSync(homeRoot, {recursive: true});
    writeFileSync(join(homeRoot, 'character-data'), 'not a directory\n');

    await expect(
      ensureInitializedProject02Home({homeRoot}),
    ).rejects.toMatchObject({
      name: 'LocalRuntimeStorageContractError',
      code: 'missing_file',
    });
  });

  it('refuses to initialize a directory with foreign entries', async () => {
    const homeRoot = join(createTestTempRoot(), 'foreign-home');

    mkdirSync(homeRoot, {recursive: true});
    writeFileSync(join(homeRoot, 'notes.txt'), 'not a home\n');

    await expect(
      ensureInitializedProject02Home({homeRoot}),
    ).rejects.toMatchObject({
      name: 'LocalRuntimeStorageContractError',
      code: 'missing_file',
    });
  });

  it('rejects a symlinked home marker instead of trusting the home', async () => {
    const homeRoot = createTestTempRoot('project02-home-marker-link-');
    const donor = createTestTempRoot('project02-home-marker-donor-');

    await ensureInitializedProject02Home({homeRoot: donor});
    writeFileSync(join(homeRoot, 'notes.txt'), 'foreign\n');
    symlinkSync(join(donor, 'schema.json'), join(homeRoot, 'schema.json'));

    await expect(ensureInitializedProject02Home({homeRoot})).rejects.toThrow(
      'is a symlink',
    );
  });

  it('treats a symlinked character-data root in a marker-less home as foreign', async () => {
    const homeRoot = createTestTempRoot('project02-home-symlink-');
    const outside = createTestTempRoot('project02-home-symlink-target-');

    symlinkSync(outside, join(homeRoot, 'character-data'));

    await expect(ensureInitializedProject02Home({homeRoot})).rejects.toThrow(
      'contains foreign entries',
    );
  });

  it('rejects an initialized home whose character-data root became a symlink', async () => {
    const homeRoot = createTestTempRoot('project02-home-symlink-swap-');
    const outside = createTestTempRoot('project02-home-symlink-swap-target-');

    await ensureInitializedProject02Home({homeRoot});
    rmSync(join(homeRoot, 'character-data'), {recursive: true});
    symlinkSync(outside, join(homeRoot, 'character-data'));

    await expect(ensureInitializedProject02Home({homeRoot})).rejects.toThrow(
      'not a real directory',
    );
  });

  it('rejects a character-data directory offered as a home', async () => {
    const homeRoot = join(createTestTempRoot(), 'not-a-home');
    const layout = createProject02HomeLayout({homeRoot});

    mkdirSync(homeRoot, {recursive: true});
    writeFileSync(
      layout.schemaPath,
      `${JSON.stringify({
        schemaVersion: 8,
        scope: 'character-data',
        createdAt: '2026-07-22T00:00:00.000Z',
      })}\n`,
    );

    await expect(
      ensureInitializedProject02Home({homeRoot}),
    ).rejects.toMatchObject({
      name: 'LocalRuntimeStorageContractError',
      code: 'malformed_schema_marker',
    });
  });

  it('rejects another scope that wins the marker initialization race', async () => {
    const homeRoot = join(createTestTempRoot(), 'raced-home-scope');
    const layout = createProject02HomeLayout({homeRoot});
    const heldMarkerLock = await acquireLocalRuntimeMutationLock({
      locksRoot: layout.locksRoot,
      resourceKey: 'storage-schema',
    });
    const initialization = ensureInitializedProject02Home({homeRoot});
    const initializationRejection = expect(
      initialization,
    ).rejects.toMatchObject({
      name: 'LocalRuntimeStorageContractError',
      code: 'malformed_schema_marker',
    });

    try {
      await waitForPath(layout.characterDataRoot);
      writeFileSync(
        layout.schemaPath,
        `${JSON.stringify({
          schemaVersion: 8,
          scope: 'character-data',
          characterId: 'mira',
          createdAt: '2026-07-23T00:00:00.000Z',
        })}\n`,
      );
    } finally {
      await heldMarkerLock.release();
    }

    await initializationRejection;
  });

  it('refuses foreign content added while waiting to mark a home', async () => {
    const homeRoot = join(createTestTempRoot(), 'raced-foreign-home');
    const layout = createProject02HomeLayout({homeRoot});
    const heldMarkerLock = await acquireLocalRuntimeMutationLock({
      locksRoot: layout.locksRoot,
      resourceKey: 'storage-schema',
    });
    const initialization = ensureInitializedProject02Home({homeRoot});
    const initializationRejection = expect(
      initialization,
    ).rejects.toMatchObject({
      name: 'LocalRuntimeStorageContractError',
      code: 'missing_file',
    });

    try {
      await waitForPath(layout.characterDataRoot);
      writeFileSync(join(homeRoot, 'notes.txt'), 'foreign\n');
    } finally {
      await heldMarkerLock.release();
    }

    await initializationRejection;
    expect(existsSync(layout.schemaPath)).toBe(false);
  });
});

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 1_000;

  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for path: ${path}`);
    }

    await new Promise<void>(resolve => {
      setTimeout(resolve, 1);
    });
  }
}
