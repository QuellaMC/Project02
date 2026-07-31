import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it, vi} from 'vitest';

import type * as ProjectFileSystem from '../../src/shared/file-system.ts';

const siblingInitializer = vi.hoisted(() => ({
  dataRoot: undefined as string | undefined,
  commit: undefined as (() => void) | undefined,
}));

// The window this suite is about lives between two reads inside one
// guard, so it cannot be arranged from outside: any state written up
// front is seen by the marker read, which returns before the directory
// listing that misjudges it. Interposing on the listing is what puts a
// sibling's commit exactly in between.
vi.mock('../../src/shared/file-system.ts', async importOriginal => {
  const original = await importOriginal<typeof ProjectFileSystem>();

  return {
    ...original,
    listDirectoryNamesSync: (path: string): string[] => {
      if (path === siblingInitializer.dataRoot) {
        const commit = siblingInitializer.commit;
        siblingInitializer.commit = undefined;
        commit?.();
      }

      return original.listDirectoryNamesSync(path);
    },
  };
});

const {assertCharacterDataDirAdoptable} =
  await import('../../src/runtime/storage/character-data.ts');
const {
  characterDataDirPath,
  createLocalRuntimeStorageSchemaMarker,
  encodeStorageSchemaMarker,
} = await import('../../src/runtime/storage/layout-contract.ts');
const {createTestTempRoot} = await import('../support/temp-root.ts');

describe('character data adoption during a concurrent first run', () => {
  it('adopts a directory a sibling claimed between the marker read and the scan', () => {
    const dataRoot = characterDataDirPath(
      createTestTempRoot('project02-adoption-race-'),
      'mira',
    );

    mkdirSync(dataRoot, {recursive: true});
    siblingInitializer.dataRoot = dataRoot;
    siblingInitializer.commit = () => {
      // One of twelve racing processes wins: it marks the directory and
      // lays out the storage it owns. A loser already past its own
      // marker read then lists a directory full of entries its
      // allowlist does not name, and used to refuse the directory it
      // shares — the failure CI saw as one missing rejection in twelve.
      mkdirSync(join(dataRoot, 'sessions'), {recursive: true});
      writeFileSync(join(dataRoot, 'sessions.jsonl'), '');
      writeFileSync(
        join(dataRoot, 'schema.json'),
        `${encodeStorageSchemaMarker(
          createLocalRuntimeStorageSchemaMarker({
            scope: 'character-data',
            characterId: 'mira',
            createdAt: '2026-07-23T00:00:00.000Z',
          }),
        )}\n`,
      );
    };

    expect(() => {
      assertCharacterDataDirAdoptable({storeRoot: dataRoot});
    }).not.toThrow();
  });

  it('refuses a directory whose entries arrive without a marker', () => {
    const dataRoot = characterDataDirPath(
      createTestTempRoot('project02-adoption-unowned-'),
      'mira',
    );

    mkdirSync(dataRoot, {recursive: true});
    siblingInitializer.dataRoot = dataRoot;
    siblingInitializer.commit = () => {
      // Same interleaving, no marker: a copied or truncated tree. The
      // confirming re-read must not soften the refusal into adoption.
      mkdirSync(join(dataRoot, 'sessions'), {recursive: true});
      writeFileSync(join(dataRoot, 'sessions.jsonl'), '');
    };

    expect(() => {
      assertCharacterDataDirAdoptable({storeRoot: dataRoot});
    }).toThrow('without a data marker');
  });
});
