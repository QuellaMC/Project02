import {existsSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {
  characterOnlyConfigPlugin,
  structuredConfigPlugin,
} from '../support/runtime-config-fixtures.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {
  applyRuntimeConfigControlOperation,
  characterOverlayConfigPath,
  createLayeredRuntimeConfigFingerprint,
  createRuntimePluginConfigControlCapability,
  inspectRuntimePluginConfig,
  loadProject02RuntimeConfig,
  resolveProject02RuntimeConfig,
  resolveRuntimeConfigScopeTarget,
  RuntimeConfigConflictError,
  runtimeConfigVersion,
} from '../../src/runtime/config/index.ts';
import {
  characterDataDirPath,
  ensureCharacterDataMarker,
} from '../../src/runtime/storage/index.ts';

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
  it('writes character-scoped fields to the overlay and only the overlay', async () => {
    const {homeRoot, configPath, dataRoot} = seededHome();
    const globalBefore = readFileSync(configPath, 'utf8');

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });

    const target = resolveRuntimeConfigScopeTarget({
      storeRoot: homeRoot,
      env: {},
      scope: 'character',
    });
    const result = applyRuntimeConfigControlOperation({
      target,
      request: {
        kind: 'document',
        operation: {
          kind: 'set',
          path: 'project02.userDisplayName',
          value: 'Overlay Name',
        },
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
    const target = resolveRuntimeConfigScopeTarget({
      storeRoot: homeRoot,
      env: {},
      scope: 'character',
    });

    expect(() =>
      applyRuntimeConfigControlOperation({
        target,
        request: {
          kind: 'document',
          operation: {kind: 'set', path: 'project02.storeRoot', value: '/x'},
        },
      }),
    ).toThrow('global-only');
    expect(() =>
      applyRuntimeConfigControlOperation({
        target,
        expectedFingerprint: 'unused',
        request: {
          kind: 'plugin_config',
          manifest: structuredConfigPlugin('scope.secrets').manifest,
          actor: 'operator',
          fieldOperation: {
            kind: 'secret_set',
            fieldName: 'apiKey',
            envVar: 'X',
            secretValue: 'y',
          },
        },
      }),
    ).toThrow('Secrets are shared across characters');
    expect(existsSync(characterOverlayConfigPath(dataRoot))).toBe(false);
  });

  it('refuses scoped writes into an unmarked data directory', () => {
    const {homeRoot, dataRoot} = seededHome();
    const target = resolveRuntimeConfigScopeTarget({
      storeRoot: homeRoot,
      env: {},
      scope: 'character',
    });

    // The marker is proof that the guarded initializer ran; a bare
    // library call against a fresh (or foreign) home must not create
    // character state.
    expect(() =>
      applyRuntimeConfigControlOperation({
        target,
        request: {
          kind: 'document',
          operation: {
            kind: 'set',
            path: 'project02.userDisplayName',
            value: 'X',
          },
        },
      }),
    ).toThrow('has no identity marker');
    expect(existsSync(dataRoot)).toBe(false);
  });

  it('enforces the layered expectation for scoped mutations', async () => {
    const {homeRoot, dataRoot} = seededHome();

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });
    const target = resolveRuntimeConfigScopeTarget({
      storeRoot: homeRoot,
      env: {},
      scope: 'character',
    });

    const freshExpected = applyRuntimeConfigControlOperation({
      target,
      request: {
        kind: 'document',
        operation: {
          kind: 'set',
          path: 'project02.userDisplayName',
          value: 'First',
        },
      },
    }).fingerprint;

    const committed = applyRuntimeConfigControlOperation({
      target,
      expectedFingerprint: freshExpected,
      request: {
        kind: 'document',
        operation: {
          kind: 'set',
          path: 'project02.userDisplayName',
          value: 'Second',
        },
      },
    });

    expect(committed.config.project02?.['userDisplayName']).toBe('Second');
    expect(() =>
      applyRuntimeConfigControlOperation({
        target,
        expectedFingerprint: freshExpected,
        request: {
          kind: 'document',
          operation: {
            kind: 'set',
            path: 'project02.userDisplayName',
            value: 'Stale',
          },
        },
      }),
    ).toThrow(RuntimeConfigConflictError);
  });

  it('validates scoped plugin field candidates against the merged document', async () => {
    const homeRoot = createTestTempRoot('project02-config-scope-merged-');
    const plugin = structuredConfigPlugin('scope.merged');

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: characterDataDirPath(homeRoot, 'mira')},
      characterId: 'mira',
    });

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
    const target = resolveRuntimeConfigScopeTarget({
      storeRoot: homeRoot,
      env: {},
      scope: 'character',
    });
    const result = applyRuntimeConfigControlOperation({
      target,
      expectedFingerprint: expected,
      request: {
        kind: 'plugin_config',
        manifest: plugin.manifest,
        actor: 'operator',
        fieldOperation: {
          kind: 'set',
          fieldName: 'settings',
          value: {from: 'overlay'},
        },
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
    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: characterDataDirPath(bareHome, 'mira')},
      characterId: 'mira',
    });
    const bareTarget = resolveRuntimeConfigScopeTarget({
      storeRoot: bareHome,
      env: {},
      scope: 'character',
    });
    expect(() =>
      applyRuntimeConfigControlOperation({
        target: bareTarget,
        expectedFingerprint: resolveScopedExpected(bareHome),
        request: {
          kind: 'plugin_config',
          manifest: plugin.manifest,
          actor: 'operator',
          fieldOperation: {
            kind: 'set',
            fieldName: 'settings',
            value: {from: 'overlay'},
          },
        },
      }),
    ).toThrow('Cannot update plugin config');
    // The rejected candidate must not leave a fresh overlay behind:
    // that would move the layered fingerprint for a failed change.
    expect(
      existsSync(
        characterOverlayConfigPath(characterDataDirPath(bareHome, 'mira')),
      ),
    ).toBe(false);
  });

  it('names the overlay, owning home, and global file as the scope target', () => {
    const {homeRoot, configPath, dataRoot} = seededHome();
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
      globalConfigPath: configPath,
      homeRoot,
      characterScope: {characterId: 'nova'},
    });
    expect(dataRoot).toContain('character-data');
  });

  it('binds an overlay-only selection to that overlay owner', async () => {
    const homeRoot = createTestTempRoot('project02-config-scope-owner-');
    const configPath = join(homeRoot, 'config.json');
    const miraRoot = characterDataDirPath(homeRoot, 'mira');
    const novaRoot = characterDataDirPath(homeRoot, 'nova');
    const novaOverlayPath = characterOverlayConfigPath(novaRoot);

    writeRuntimeConfig(configPath, {
      project02: {character: 'mira'},
    });
    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: novaRoot},
      characterId: 'nova',
    });
    const canonicalHomeRoot = realpathSync.native(homeRoot);
    const canonicalConfigPath = realpathSync.native(configPath);
    const canonicalNovaRoot = realpathSync.native(novaRoot);
    const canonicalNovaOverlayPath =
      characterOverlayConfigPath(canonicalNovaRoot);

    const target = resolveRuntimeConfigScopeTarget({
      configPath: novaOverlayPath,
      env: {},
      scope: 'character',
    });

    expect(target).toMatchObject({
      scope: 'character',
      configPath: canonicalNovaOverlayPath,
      canonicalConfigPath: canonicalNovaOverlayPath,
      globalConfigPath: canonicalConfigPath,
      homeRoot: canonicalHomeRoot,
      characterScope: {
        characterId: 'nova',
        dataRoot: canonicalNovaRoot,
      },
    });

    applyRuntimeConfigControlOperation({
      target,
      request: {
        kind: 'document',
        operation: {
          kind: 'set',
          path: 'project02.userDisplayName',
          value: 'Nova Name',
        },
      },
    });

    expect(JSON.parse(readFileSync(novaOverlayPath, 'utf8'))).toMatchObject({
      project02: {userDisplayName: 'Nova Name'},
    });
    expect(existsSync(miraRoot)).toBe(false);
  });
});

describe('plugin manifest config scope policy', () => {
  it('rejects global character-only enablement and non-secret fields while allowing global secret refs', () => {
    const plugin = characterOnlyConfigPlugin('scope.character-only');
    const resolved = resolveProject02RuntimeConfig({
      loadedConfig: {
        source: 'path',
        config: {
          version: runtimeConfigVersion,
          plugins: {
            [plugin.manifest.id]: {
              enabled: true,
              config: {
                setting: 'global-value',
                apiKey: {$env: 'CHARACTER_ONLY_API_KEY'},
              },
            },
          },
        },
        diagnostics: [],
      },
      pluginManifests: [plugin.manifest],
      validateInactivePluginConfigs: true,
      env: {CHARACTER_ONLY_API_KEY: 'secret'},
    });

    expect(resolved.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_character_only_plugin_enabled_globally',
          path: `plugins.${plugin.manifest.id}.enabled`,
        }),
        expect.objectContaining({
          code: 'runtime_config_character_only_plugin_field_globally',
          path: `plugins.${plugin.manifest.id}.config.setting`,
        }),
      ]),
    );
    expect(
      resolved.diagnostics.some(
        diagnostic =>
          diagnostic.path === `plugins.${plugin.manifest.id}.config.apiKey` &&
          diagnostic.code.includes('scope'),
      ),
    ).toBe(false);
  });

  it('uses the same policy for manifest-aware activation and field controls', async () => {
    const {homeRoot, configPath, dataRoot} = seededHome();
    const plugin = characterOnlyConfigPlugin('scope.character-only-control');

    writeRuntimeConfig(configPath, {
      plugins: {
        [plugin.manifest.id]: {
          config: {apiKey: {$env: 'CHARACTER_ONLY_CONTROL_API_KEY'}},
        },
      },
    });
    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });
    const globalTarget = resolveRuntimeConfigScopeTarget({
      storeRoot: homeRoot,
      env: {CHARACTER_ONLY_CONTROL_API_KEY: 'secret'},
      scope: 'global',
    });
    const characterTarget = resolveRuntimeConfigScopeTarget({
      storeRoot: homeRoot,
      env: {CHARACTER_ONLY_CONTROL_API_KEY: 'secret'},
      scope: 'character',
    });
    const globalBefore = readFileSync(configPath, 'utf8');

    expect(() =>
      applyRuntimeConfigControlOperation({
        target: globalTarget,
        request: {
          kind: 'plugin_activation',
          manifest: plugin.manifest,
          enabled: true,
        },
      }),
    ).toThrow('character-only');
    expect(() =>
      applyRuntimeConfigControlOperation({
        target: globalTarget,
        request: {
          kind: 'plugin_config',
          manifest: plugin.manifest,
          actor: 'operator',
          fieldOperation: {
            kind: 'set',
            fieldName: 'setting',
            value: 'global-nope',
          },
        },
      }),
    ).toThrow('character-only');
    expect(readFileSync(configPath, 'utf8')).toBe(globalBefore);

    applyRuntimeConfigControlOperation({
      target: characterTarget,
      request: {
        kind: 'plugin_activation',
        manifest: plugin.manifest,
        enabled: true,
      },
    });
    applyRuntimeConfigControlOperation({
      target: characterTarget,
      request: {
        kind: 'plugin_config',
        manifest: plugin.manifest,
        actor: 'agent',
        fieldOperation: {
          kind: 'set',
          fieldName: 'setting',
          value: 'character-value',
        },
      },
    });

    expect(
      JSON.parse(readFileSync(characterOverlayConfigPath(dataRoot), 'utf8')),
    ).toEqual({
      version: runtimeConfigVersion,
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {setting: 'character-value'},
        },
      },
    });
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

describe('character-scoped plugin control capability', () => {
  it('routes agent tool updates at the active character overlay, never the home config', async () => {
    const {homeRoot, configPath, dataRoot} = seededHome();
    const plugin = structuredConfigPlugin('scope.capability');

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });

    writeRuntimeConfig(configPath, {
      plugins: {
        'scope.capability': {
          enabled: true,
          config: {settings: {from: 'global'}, endpoints: ['global']},
        },
      },
    });

    const characterScope = {characterId: 'mira', dataRoot};
    const capability = createRuntimePluginConfigControlCapability();
    const fingerprint = inspectRuntimePluginConfig({
      manifest: plugin.manifest,
      pluginManifests: [plugin.manifest],
      storeRoot: homeRoot,
      env: {},
      characterScope,
    }).fingerprint;
    const overlayPath = characterOverlayConfigPath(dataRoot);
    const globalBefore = readFileSync(configPath, 'utf8');
    const target = capability.resolveTarget({
      storeRoot: homeRoot,
      env: {},
      scope: 'character',
      characterScope,
    });
    const prepared = capability.prepareOperation({
      target,
      expectedFingerprint: fingerprint,
      request: {
        kind: 'plugin_config',
        manifest: plugin.manifest,
        actor: 'operator',
        fieldOperation: {
          kind: 'set',
          fieldName: 'settings',
          value: {from: 'agent'},
        },
      },
    });

    // Prepare is read-only and already names the overlay as the target.
    expect(existsSync(overlayPath)).toBe(false);
    expect(prepared.targetConfigPath).toBe(target.canonicalConfigPath);

    const applied = capability.applyOperation({
      target,
      expectedFingerprint: fingerprint,
      request: {
        kind: 'plugin_config',
        manifest: plugin.manifest,
        actor: 'operator',
        fieldOperation: {
          kind: 'set',
          fieldName: 'settings',
          value: {from: 'agent'},
        },
      },
    });

    expect(applied.fingerprint).toBe(prepared.resultFingerprint);
    expect(JSON.parse(readFileSync(overlayPath, 'utf8'))).toEqual({
      version: runtimeConfigVersion,
      plugins: {'scope.capability': {config: {settings: {from: 'agent'}}}},
    });
    expect(readFileSync(configPath, 'utf8')).toBe(globalBefore);
  });
});

describe('plugin inspection authored views', () => {
  it('reports global-authored values when asked, without changing the layered fingerprint', async () => {
    const {homeRoot, configPath, dataRoot} = seededHome();
    const plugin = structuredConfigPlugin('scope.authored-view');

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });

    writeRuntimeConfig(configPath, {
      plugins: {
        'scope.authored-view': {
          enabled: true,
          config: {settings: {from: 'global'}, endpoints: ['global']},
        },
      },
    });
    const base = {
      manifest: plugin.manifest,
      pluginManifests: [plugin.manifest],
      storeRoot: homeRoot,
      env: {},
    };

    const target = resolveRuntimeConfigScopeTarget({
      storeRoot: homeRoot,
      env: {},
      scope: 'character',
      characterId: 'mira',
    });
    applyRuntimeConfigControlOperation({
      target,
      expectedFingerprint: inspectRuntimePluginConfig(base).fingerprint,
      request: {
        kind: 'plugin_config',
        manifest: plugin.manifest,
        actor: 'operator',
        fieldOperation: {
          kind: 'set',
          fieldName: 'settings',
          value: {from: 'overlay'},
        },
      },
    });
    const merged = inspectRuntimePluginConfig(base);
    const globalView = inspectRuntimePluginConfig({
      ...base,
      authoredView: 'global',
    });
    const authoredSettings = (
      inspected: ReturnType<typeof inspectRuntimePluginConfig>,
    ) => inspected.fields.find(field => field.name === 'settings')?.authored;

    // The merged view surfaces the overlay rung; the global view is for
    // surfaces that stage global-file edits and must not present the
    // overlay-authored value as editable.
    expect(authoredSettings(merged)).toMatchObject({
      configured: true,
      value: {from: 'overlay'},
    });
    expect(authoredSettings(globalView)).toMatchObject({
      configured: true,
      value: {from: 'global'},
    });
    // Both views fingerprint the same layered document.
    expect(globalView.fingerprint).toBe(merged.fingerprint);
    expect(existsSync(characterOverlayConfigPath(dataRoot))).toBe(true);
  });
});

describe('configured character id normalization', () => {
  it('trims a padded authored character id at every read seam', () => {
    const homeRoot = createTestTempRoot('project02-scope-trim-');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {character: '  mira  '},
    });

    const resolved = resolveProject02RuntimeConfig({
      loadedConfig: loadProject02RuntimeConfig({storeRoot: homeRoot, env: {}}),
      storeRoot: homeRoot,
    });

    expect(resolved.project02.character).toBe('mira');
    expect(
      resolveRuntimeConfigScopeTarget({
        storeRoot: homeRoot,
        env: {},
        scope: 'character',
      }).characterScope,
    ).toMatchObject({characterId: 'mira'});
  });
});

describe('scoped writes over a broken global layer', () => {
  it('rejects the mutation instead of merging against a synthetic global document', () => {
    const homeRoot = createTestTempRoot('project02-scope-invalid-global-');

    writeFileSync(join(homeRoot, 'config.json'), '{not json\n');

    expect(() => {
      const target = resolveRuntimeConfigScopeTarget({
        storeRoot: homeRoot,
        env: {},
        scope: 'character',
        characterId: 'mira',
      });
      applyRuntimeConfigControlOperation({
        target,
        request: {
          kind: 'document',
          operation: {
            kind: 'set',
            path: 'project02.userDisplayName',
            value: 'Bob',
          },
        },
      });
    }).toThrow(/failed to load/);
    expect(
      existsSync(
        characterOverlayConfigPath(characterDataDirPath(homeRoot, 'mira')),
      ),
    ).toBe(false);
  });
});

describe('global control writes aimed directly at the overlay path', () => {
  it('completes without pre-locking the overlay against itself', async () => {
    const {homeRoot, configPath, dataRoot} = seededHome();
    const overlayPath = characterOverlayConfigPath(dataRoot);
    const plugin = structuredConfigPlugin('scope.direct-overlay');

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });

    const globalBefore = readFileSync(configPath, 'utf8');
    // The "global" layer aliases the overlay here; the expectation
    // pre-lock must not take the file lock the mutation itself needs.
    const target = resolveRuntimeConfigScopeTarget({
      configPath: overlayPath,
      storeRoot: homeRoot,
      env: {},
      scope: 'global',
    });
    const result = applyRuntimeConfigControlOperation({
      target,
      expectedFingerprint: inspectRuntimePluginConfig({
        configPath: overlayPath,
        storeRoot: homeRoot,
        env: {},
        manifest: plugin.manifest,
        pluginManifests: [plugin.manifest],
      }).fingerprint,
      request: {
        kind: 'plugin_activation',
        manifest: structuredConfigPlugin('scope.direct-overlay').manifest,
        enabled: true,
      },
    });

    expect(result.configPath).toBe(target.configPath);
    expect(JSON.parse(readFileSync(overlayPath, 'utf8'))).toEqual({
      version: runtimeConfigVersion,
      plugins: {'scope.direct-overlay': {enabled: true}},
    });
    expect(readFileSync(configPath, 'utf8')).toBe(globalBefore);
  });
});

describe('stale global expectations', () => {
  it('conflicts without materializing a lock root in an absent data dir', () => {
    const {homeRoot, dataRoot} = seededHome();
    const target = resolveRuntimeConfigScopeTarget({
      storeRoot: homeRoot,
      env: {},
      scope: 'global',
    });

    expect(() =>
      applyRuntimeConfigControlOperation({
        target,
        expectedFingerprint: 'stale-fingerprint',
        request: {
          kind: 'document',
          operation: {
            kind: 'set',
            path: 'project02.userDisplayName',
            value: 'Bob',
          },
        },
      }),
    ).toThrow(RuntimeConfigConflictError);
    // The rejected commit created no character state — not even the
    // per-character lock root.
    expect(existsSync(dataRoot)).toBe(false);
  });
});

describe('global writes that move the character selection', () => {
  it('reports the new character layer in the returned fingerprint', async () => {
    const homeRoot = createTestTempRoot('project02-scope-switch-');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: characterDataDirPath(homeRoot, 'nova')},
      characterId: 'nova',
    });
    // Give nova an overlay so the layers differ observably.
    const novaTarget = resolveRuntimeConfigScopeTarget({
      storeRoot: homeRoot,
      env: {},
      scope: 'character',
      characterId: 'nova',
    });
    applyRuntimeConfigControlOperation({
      target: novaTarget,
      request: {
        kind: 'document',
        operation: {
          kind: 'set',
          path: 'project02.userDisplayName',
          value: 'Nova User',
        },
      },
    });

    const loaded = loadProject02RuntimeConfig({storeRoot: homeRoot, env: {}});
    const globalDocument = loaded.config;

    if (globalDocument === undefined) {
      throw new Error('Expected the seeded global config to load.');
    }

    const expected = createLayeredRuntimeConfigFingerprint({
      globalConfig: globalDocument,
      characterId: 'mira',
      overlayConfig: null,
    });
    const globalTarget = resolveRuntimeConfigScopeTarget({
      storeRoot: homeRoot,
      env: {},
      scope: 'global',
    });
    const switched = applyRuntimeConfigControlOperation({
      target: globalTarget,
      expectedFingerprint: expected,
      request: {
        kind: 'document',
        operation: {kind: 'set', path: 'project02.character', value: 'nova'},
      },
    });

    // The returned fingerprint is composed for the newly selected
    // character's layer, ready to chain into the next scoped step.
    expect(switched.fingerprint).toBe(
      createLayeredRuntimeConfigFingerprint({
        globalConfig: switched.config,
        characterId: 'nova',
        overlayConfig: {
          version: runtimeConfigVersion,
          project02: {userDisplayName: 'Nova User'},
        },
      }),
    );
  });
});
