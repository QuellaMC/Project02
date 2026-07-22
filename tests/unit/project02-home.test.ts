import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {createTestTempRoot} from '../support/temp-root.ts';
import {
  createProject02HomeLayout,
  ensureInitializedProject02Home,
} from '../../src/runtime/storage/index.ts';

describe('project02 home initialization', () => {
  it('initializes a fresh home with a scoped marker and the character-data root', async () => {
    const homeRoot = join(createTestTempRoot(), 'fresh-home');

    const layout = await ensureInitializedProject02Home({homeRoot});

    expect(JSON.parse(readFileSync(layout.schemaPath, 'utf8'))).toMatchObject({
      schemaVersion: 4,
      scope: 'home',
    });

    // Idempotent: a second call keeps the marker and succeeds.
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

  it('rejects a character-data directory offered as a home', async () => {
    const homeRoot = join(createTestTempRoot(), 'not-a-home');
    const layout = createProject02HomeLayout({homeRoot});

    mkdirSync(homeRoot, {recursive: true});
    writeFileSync(
      layout.schemaPath,
      `${JSON.stringify({
        schemaVersion: 4,
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
});
