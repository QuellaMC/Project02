import {cpSync, existsSync, readFileSync, rmSync, symlinkSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {
  ensureCharacterDataDir,
  createLocalRuntimeStorageLayout,
  decodeStorageSchemaMarker,
  recordMaterializedCharacterPackageVersion,
} from '../../src/runtime/storage/index.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

describe('character data marker', () => {
  it('initializes config-only character data with one identity marker', async () => {
    const homeRoot = createTestTempRoot('project02-character-marker-');
    const dataRoot = await ensureCharacterDataDir({
      homeRoot,
      characterId: 'mira',
      now: () => '2026-07-23T00:00:00.000Z',
    });
    const layout = createLocalRuntimeStorageLayout({storeRoot: dataRoot});

    expect(
      decodeStorageSchemaMarker(readFileSync(layout.schemaPath, 'utf8')),
    ).toEqual({
      schemaVersion: 7,
      scope: 'character-data',
      characterId: 'mira',
      createdAt: '2026-07-23T00:00:00.000Z',
    });
    expect(existsSync(layout.configPath)).toBe(false);
  });

  it('records the last materialized package version without changing schema version or identity', async () => {
    const homeRoot = createTestTempRoot('project02-character-version-');
    const dataRoot = await ensureCharacterDataDir({
      homeRoot,
      characterId: 'mira',
      now: () => '2026-07-23T00:00:00.000Z',
    });
    const layout = createLocalRuntimeStorageLayout({storeRoot: dataRoot});

    await recordMaterializedCharacterPackageVersion({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
      packageVersion: '1.1.0',
    });

    expect(
      decodeStorageSchemaMarker(readFileSync(layout.schemaPath, 'utf8')),
    ).toEqual({
      schemaVersion: 7,
      scope: 'character-data',
      characterId: 'mira',
      createdAt: '2026-07-23T00:00:00.000Z',
      materializedCharacterPackageVersion: '1.1.0',
    });
  });

  it('refuses to record a version through a swapped data directory', async () => {
    const homeRoot = createTestTempRoot('project02-character-swapped-');
    const elsewhere = createTestTempRoot('project02-character-outside-');
    const dataRoot = await ensureCharacterDataDir({
      homeRoot,
      characterId: 'mira',
      now: () => '2026-07-23T00:00:00.000Z',
    });

    // The overlay committed against the real directory; the directory is
    // then swapped for a link to an outside copy carrying a matching
    // marker. Recording the version must not rewrite that outside marker.
    cpSync(dataRoot, join(elsewhere, 'mira'), {recursive: true});
    rmSync(dataRoot, {recursive: true});
    symlinkSync(join(elsewhere, 'mira'), dataRoot);

    await expect(
      recordMaterializedCharacterPackageVersion({
        storageOptions: {storeRoot: dataRoot},
        characterId: 'mira',
        packageVersion: '1.1.0',
      }),
    ).rejects.toThrow('must be a real directory');
    expect(
      decodeStorageSchemaMarker(
        readFileSync(join(elsewhere, 'mira', 'schema.json'), 'utf8'),
      ),
    ).not.toHaveProperty('materializedCharacterPackageVersion');
  });

  it('initializes from a padded character ID without leaving a rejected home', async () => {
    const homeRoot = createTestTempRoot('project02-character-padded-');
    // The path helper and marker constructor both normalize, so carrying the
    // raw ID to the post-write verification compared the marker against a value
    // that never reached storage -- and only after the home marker and data
    // directory had been created.
    const dataRoot = await ensureCharacterDataDir({
      homeRoot,
      characterId: '  mira  ',
      now: () => '2026-07-23T00:00:00.000Z',
    });
    const layout = createLocalRuntimeStorageLayout({storeRoot: dataRoot});

    expect(dataRoot).toBe(join(homeRoot, 'character-data', 'mira'));
    expect(
      decodeStorageSchemaMarker(readFileSync(layout.schemaPath, 'utf8')),
    ).toEqual({
      schemaVersion: 7,
      scope: 'character-data',
      characterId: 'mira',
      createdAt: '2026-07-23T00:00:00.000Z',
    });
  });

  it('rejects an invalid character ID with a character-specific code', async () => {
    const homeRoot = createTestTempRoot('project02-character-invalid-');

    // Character selection failures must not report themselves as plugin ID
    // failures; callers branching on the code would misclassify them.
    await expect(
      ensureCharacterDataDir({homeRoot, characterId: '9-not-valid'}),
    ).rejects.toMatchObject({code: 'invalid_character_id'});
  });
});
