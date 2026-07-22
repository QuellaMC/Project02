import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {structuredConfigPlugin} from '../support/runtime-config-fixtures.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {
  applyScopedRuntimeConfigControlOperation,
  applyScopedRuntimePluginConfigControlOperation,
  characterOverlayConfigPath,
  createLayeredRuntimeConfigFingerprint,
  loadProject02RuntimeConfig,
  resolveRuntimeConfigScopeTarget,
  RuntimeConfigConflictError,
  runtimeConfigVersion,
} from '../../src/runtime/config/index.ts';
import {characterDataDirPath} from '../../src/runtime/storage/index.ts';

function seededHome(): {
  readonly homeRoot: string;
  readonly configPath: string;
  readonly dataRoot: string;
} {
  const homeRoot = createTestTempRoot('project02-config-scope-');
  const configPath = join(homeRoot, 'config.json');

  writeRuntimeConfig(configPath, {
    project02: {userDisplayName: 'Global Name'},
  });

  return {
    homeRoot,
    configPath,
    dataRoot: characterDataDirPath(homeRoot, 'mira'),
  };
}

describe('scope-aware runtime config mutations', () => {
  it('writes character-scoped fields to the overlay and only the overlay', () => {
    const {homeRoot, configPath, dataRoot} = seededHome();
    const globalBefore = readFileSync(configPath, 'utf8');

    const result = applyScopedRuntimeConfigControlOperation({
      storeRoot: homeRoot,
      env: {},
      scope: 'character',
      operation: {
        kind: 'set',
        path: 'project02.userDisplayName',
        value: 'Overlay Name',
      },
    });

    expect(result.configPath).toBe(characterOverlayConfigPath(dataRoot));
    expect(result.config).toEqual({
      version: runtimeConfigVersion,
      project02: {userDisplayName: 'Overlay Name'},
    });
    // R7 pin: the global file is untouched, no secrets file appears in
    // the character-data directory, and the overlay lock root is local
    // to the data dir instead of re-inferring the home.
    expect(readFileSync(configPath, 'utf8')).toBe(globalBefore);
    expect(existsSync(join(dataRoot, '.env'))).toBe(false);
    expect(existsSync(join(dataRoot, '.locks'))).toBe(true);

    // The returned fingerprint is the layered pair after the write.
    const globalConfig = loadProject02RuntimeConfig({
      storeRoot: homeRoot,
      env: {},
    }).config;

    if (globalConfig === undefined) {
      throw new Error('Expected the global config to load.');
    }

    expect(result.fingerprint).toBe(
      createLayeredRuntimeConfigFingerprint({
        globalConfig,
        characterId: 'mira',
        overlayConfig: result.config,
      }),
    );
  });

  it('rejects global-only fields and secret operations under character scope', () => {
    const {homeRoot, dataRoot} = seededHome();

    expect(() =>
      applyScopedRuntimeConfigControlOperation({
        storeRoot: homeRoot,
        env: {},
        scope: 'character',
        operation: {kind: 'set', path: 'project02.storeRoot', value: '/x'},
      }),
    ).toThrow('global-only');
    expect(() =>
      applyScopedRuntimePluginConfigControlOperation({
        storeRoot: homeRoot,
        env: {},
        scope: 'character',
        manifest: structuredConfigPlugin('scope.secrets').manifest,
        actor: 'operator',
        expectedFingerprint: 'unused',
        operation: {
          kind: 'secret_set',
          fieldName: 'apiKey',
          envVar: 'X',
          secretValue: 'y',
        },
      }),
    ).toThrow('Secrets are shared across characters');
    expect(existsSync(characterOverlayConfigPath(dataRoot))).toBe(false);
  });

  it('enforces the layered expectation for scoped mutations', () => {
    const {homeRoot} = seededHome();
    const freshExpected = applyScopedRuntimeConfigControlOperation({
      storeRoot: homeRoot,
      env: {},
      scope: 'character',
      operation: {
        kind: 'set',
        path: 'project02.userDisplayName',
        value: 'First',
      },
    }).fingerprint;

    const committed = applyScopedRuntimeConfigControlOperation({
      storeRoot: homeRoot,
      env: {},
      scope: 'character',
      expectedFingerprint: freshExpected,
      operation: {
        kind: 'set',
        path: 'project02.userDisplayName',
        value: 'Second',
      },
    });

    expect(committed.config.project02?.['userDisplayName']).toBe('Second');
    expect(() =>
      applyScopedRuntimeConfigControlOperation({
        storeRoot: homeRoot,
        env: {},
        scope: 'character',
        expectedFingerprint: freshExpected,
        operation: {
          kind: 'set',
          path: 'project02.userDisplayName',
          value: 'Stale',
        },
      }),
    ).toThrow(RuntimeConfigConflictError);
  });

  it('validates scoped plugin field candidates against the merged document', () => {
    const homeRoot = createTestTempRoot('project02-config-scope-merged-');
    const plugin = structuredConfigPlugin('scope.merged');

    // Global supplies both required fields; the overlay overrides one.
    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      plugins: {
        'scope.merged': {
          enabled: true,
          config: {settings: {from: 'global'}, endpoints: ['global']},
        },
      },
    });

    const expected = resolveScopedExpected(homeRoot);
    const result = applyScopedRuntimePluginConfigControlOperation({
      storeRoot: homeRoot,
      env: {},
      scope: 'character',
      manifest: plugin.manifest,
      actor: 'operator',
      expectedFingerprint: expected,
      operation: {
        kind: 'set',
        fieldName: 'settings',
        value: {from: 'overlay'},
      },
    });

    expect(result.config).toEqual({
      version: runtimeConfigVersion,
      plugins: {'scope.merged': {config: {settings: {from: 'overlay'}}}},
    });

    // Without the global layer the merged candidate misses a required
    // field and the scoped write is rejected.
    const bareHome = createTestTempRoot('project02-config-scope-bare-');

    writeRuntimeConfig(join(bareHome, 'config.json'), {
      plugins: {'scope.merged': {enabled: true}},
    });
    expect(() =>
      applyScopedRuntimePluginConfigControlOperation({
        storeRoot: bareHome,
        env: {},
        scope: 'character',
        manifest: plugin.manifest,
        actor: 'operator',
        expectedFingerprint: resolveScopedExpected(bareHome),
        operation: {
          kind: 'set',
          fieldName: 'settings',
          value: {from: 'overlay'},
        },
      }),
    ).toThrow('Cannot update plugin config');
  });

  it('names the overlay file and character allowlist as the scope target', () => {
    const {homeRoot, dataRoot} = seededHome();
    const target = resolveRuntimeConfigScopeTarget({
      storeRoot: homeRoot,
      env: {},
      scope: 'character',
      characterId: 'nova',
    });

    expect(target).toMatchObject({
      scope: 'character',
      configPath: characterOverlayConfigPath(
        characterDataDirPath(homeRoot, 'nova'),
      ),
      characterScope: {characterId: 'nova'},
      secretOpsAllowed: false,
    });
    expect(
      target.allowedProject02Fields.map(field => field.name).sort(),
    ).toEqual([
      'defaultMemoryProvider',
      'roleModelProvider',
      'userDisplayName',
    ]);
    expect(dataRoot).toContain('character-data');
  });
});

function resolveScopedExpected(homeRoot: string): string {
  const loaded = loadProject02RuntimeConfig({storeRoot: homeRoot, env: {}});

  if (loaded.config === undefined) {
    throw new Error('Expected the seeded global config to load.');
  }

  return createLayeredRuntimeConfigFingerprint({
    globalConfig: loaded.config,
    characterId: 'mira',
    overlayConfig: null,
  });
}
