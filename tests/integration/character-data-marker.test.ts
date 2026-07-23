import {existsSync, readFileSync} from 'node:fs';

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
      schemaVersion: 4,
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
      schemaVersion: 4,
      scope: 'character-data',
      characterId: 'mira',
      createdAt: '2026-07-23T00:00:00.000Z',
      materializedCharacterPackageVersion: '1.1.0',
    });
  });
});
