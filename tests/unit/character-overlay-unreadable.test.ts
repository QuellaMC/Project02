import {mkdirSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it, vi} from 'vitest';

import type * as ProjectFileSystem from '../../src/shared/file-system.ts';

const deniedEntry = vi.hoisted(() => ({path: undefined as string | undefined}));

// No temp directory portably arranges an unreadable entry, so both stats are
// interposed on: a component that denies search denies it to every syscall.
vi.mock('../../src/shared/file-system.ts', async importOriginal => {
  const original = await importOriginal<typeof ProjectFileSystem>();

  function denyIfRequested(path: string): void {
    if (path === deniedEntry.path) {
      throw Object.assign(new Error(`EACCES: permission denied, ${path}`), {
        code: 'EACCES',
      });
    }
  }

  return {
    ...original,
    lstatPathSync: (path: string): ProjectFileSystem.BigIntStats => {
      denyIfRequested(path);
      return original.lstatPathSync(path);
    },
    statPathSync: (path: string): ProjectFileSystem.BigIntStats => {
      denyIfRequested(path);
      return original.statPathSync(path);
    },
  };
});

const {blockingRuntimeConfigLayerDiagnostic} =
  await import('../../src/runtime/config/mutate.ts');
const {
  characterOverlayConfigPath,
  layeredRuntimeConfigFingerprintForScope,
  readCharacterOverlayForScope,
  runtimeConfigVersion,
} = await import('../../src/runtime/config/index.ts');
const {createTestTempRoot} = await import('../support/temp-root.ts');

describe('character overlay that cannot be inspected', () => {
  it('loads as an error-bearing overlay rather than an absent one', () => {
    const dataRoot = join(createTestTempRoot(), 'character-data', 'mira');

    mkdirSync(dataRoot, {recursive: true});
    deniedEntry.path = characterOverlayConfigPath(dataRoot);

    const {overlay} = readCharacterOverlayForScope({
      dataRoot,
      characterId: 'mira',
    });

    expect(overlay.source).toBe('overlay');
    expect(overlay.config).toBeUndefined();
    expect(overlay.diagnostics).toMatchObject([
      {
        severity: 'error',
        code: 'runtime_config_read_failed',
        origin: {scope: 'character', characterId: 'mira'},
      },
    ]);
    expect(overlay.diagnostics).toHaveLength(1);

    // There are no authored bytes to repair, so mutation fails closed.
    expect(blockingRuntimeConfigLayerDiagnostic(overlay)).toMatchObject({
      code: 'runtime_config_read_failed',
    });

    // A shared fingerprint would let a currency gate accept a resolution taken
    // while the file was still readable.
    const scope = {
      globalConfig: {version: runtimeConfigVersion},
      characterScope: {characterId: 'mira', dataRoot},
    };
    const unreadableFingerprint = layeredRuntimeConfigFingerprintForScope({
      sections: {plugins: []},
      ...scope,
      overlay,
    });

    deniedEntry.path = undefined;

    expect(
      layeredRuntimeConfigFingerprintForScope({
        sections: {plugins: []},
        ...scope,
        overlay: readCharacterOverlayForScope(scope.characterScope).overlay,
      }),
    ).not.toBe(unreadableFingerprint);
  });
});
