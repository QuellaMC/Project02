import {mkdirSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it, vi} from 'vitest';

import type * as ProjectFileSystem from '../../src/shared/file-system.ts';

const deniedEntry = vi.hoisted(() => ({path: undefined as string | undefined}));

// An overlay that exists but cannot be inspected — a per-entry ACL, a
// transient filesystem error — is not something a temp directory can be
// arranged into portably, so the two stats that would report it are
// interposed on instead. Both fail, as they would for a real caller: a
// path component that denies search denies it to every syscall.
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

const {characterOverlayConfigPath, characterOverlayFingerprintLayer} =
  await import('../../src/runtime/config/overlay.ts');
const {blockingRuntimeConfigLayerDiagnostic} =
  await import('../../src/runtime/config/mutate.ts');
const {readCharacterOverlayForScope} =
  await import('../../src/runtime/config/index.ts');
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

    // Reporting this as absent would resolve the character against
    // inherited global values and let materialization rewrite settings
    // the operator did author, because nothing downstream can tell "no
    // overlay" from "an overlay I could not read".
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

    // The two states must also fingerprint differently, or a currency
    // gate would accept a cached resolution taken when the file could
    // still be read.
    expect(characterOverlayFingerprintLayer(overlay)).toEqual({
      $overlayUnreadable: true,
    });

    // And no edit may be based on it: there are no authored bytes to
    // repair, so mutation fails closed instead of overwriting them.
    expect(blockingRuntimeConfigLayerDiagnostic(overlay)).toMatchObject({
      code: 'runtime_config_read_failed',
    });
  });
});
