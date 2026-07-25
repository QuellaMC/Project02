import {mkdirSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {structuredConfigPlugin} from '../support/runtime-config-fixtures.ts';
import {
  writeRuntimeConfig,
  runtimeLocationForTest,
  runtimeConfigSnapshotForTest,
} from '../support/runtime-config.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {resolveRuntimeCliStartup} from '../../src/app/index.ts';
import {
  assertScopedMutationOperationAllowed,
  characterOverlayConfigPath,
  readCharacterOverlayForScope,
  runtimeConfigDiagnosticAttribution,
  runtimeConfigVersion,
  type LoadedProject02CharacterOverlayConfig,
  type LoadedProject02RuntimeConfig,
  type Project02HostConfig,
  type Project02RuntimePluginConfig,
  resolveLayeredProject02RuntimeConfig,
  resolveProject02RuntimeConfig,
} from '../../src/runtime/config/index.ts';
import {assertOverlayLocatedCandidateStaysCharacterScoped} from '../../src/runtime/config/mutate.ts';
import {characterDataDirPath} from '../../src/runtime/storage/index.ts';

function overlayDataRoot(): string {
  const dataRoot = join(createTestTempRoot(), 'character-data', 'mira');

  mkdirSync(dataRoot, {recursive: true});
  return dataRoot;
}

function loadCharacterOverlay(
  dataRoot: string,
  characterId = 'mira',
): LoadedProject02CharacterOverlayConfig {
  return readCharacterOverlayForScope({dataRoot, characterId}).overlay;
}

function loadedGlobalConfig(options: {
  readonly project02?: Project02HostConfig;
  readonly plugins?: Readonly<Record<string, Project02RuntimePluginConfig>>;
}): LoadedProject02RuntimeConfig {
  return {
    source: 'default',
    path: '/global-home/config.json',
    config: {
      version: runtimeConfigVersion,
      project02: {storeRoot: '/global-home', ...options.project02},
      ...(options.plugins === undefined ? {} : {plugins: options.plugins}),
    },
    diagnostics: [],
  };
}

function loadedOverlay(options: {
  readonly project02?: Project02HostConfig;
  readonly plugins?: Readonly<Record<string, Project02RuntimePluginConfig>>;
}): LoadedProject02CharacterOverlayConfig {
  return {
    scope: 'character',
    characterId: 'mira',
    source: 'overlay',
    path: '/global-home/character-data/mira/config.json',
    config: {
      version: runtimeConfigVersion,
      ...(options.project02 === undefined
        ? {}
        : {project02: options.project02}),
      ...(options.plugins === undefined ? {} : {plugins: options.plugins}),
    },
    diagnostics: [],
  };
}

describe('character overlay config loader', () => {
  it('rejects a dangling overlay symlink instead of reading it as absent', () => {
    const dataRoot = createTestTempRoot('project02-overlay-dangling-');

    symlinkSync(
      join(dataRoot, 'missing-target.json'),
      join(dataRoot, 'config.json'),
    );

    expect(() => loadCharacterOverlay(dataRoot)).toThrow(
      'must be a real file inside the data directory',
    );
  });

  it('rejects a symlinked overlay file with an error diagnostic', () => {
    const dataRoot = createTestTempRoot('project02-overlay-symlink-');
    const outside = createTestTempRoot('project02-overlay-symlink-target-');
    const realConfig = join(outside, 'external.json');

    writeFileSync(realConfig, '{"version":"project02.config.v2"}\n');
    symlinkSync(realConfig, join(dataRoot, 'config.json'));

    expect(() => loadCharacterOverlay(dataRoot)).toThrow(
      'must be a real file inside the data directory',
    );
  });

  it('treats an absent overlay file as valid and empty', () => {
    const overlay = loadCharacterOverlay(overlayDataRoot());

    expect(overlay).toEqual({
      scope: 'character',
      characterId: 'mira',
      source: 'none',
      diagnostics: [],
    });
  });

  it('loads a character-scoped overlay document', () => {
    const dataRoot = overlayDataRoot();

    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {
      project02: {userDisplayName: 'Mike'},
      plugins: {'demo-config': {enabled: true, config: {tone: 'warm'}}},
    });

    const overlay = loadCharacterOverlay(dataRoot);

    expect(overlay.source).toBe('overlay');
    expect(overlay.diagnostics).toEqual([]);
    expect(overlay.config).toMatchObject({
      project02: {userDisplayName: 'Mike'},
      plugins: {'demo-config': {enabled: true, config: {tone: 'warm'}}},
    });
  });

  it('rejects global-only fields with an attributed diagnostic and no config', () => {
    const dataRoot = overlayDataRoot();

    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {
      project02: {
        storeRoot: '/elsewhere',
        character: 'nova',
        userDisplayName: 'Mike',
      },
    });

    const overlay = loadCharacterOverlay(dataRoot);

    expect(overlay.config).toBeUndefined();
    expect(overlay.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'runtime_config_field_global_only',
        path: 'project02.storeRoot',
        origin: {
          scope: 'character',
          characterId: 'mira',
          path: characterOverlayConfigPath(dataRoot),
        },
      }),
      expect.objectContaining({
        code: 'runtime_config_field_global_only',
        path: 'project02.character',
      }),
    ]);
    const globalOnly = overlay.diagnostics[0];

    if (globalOnly === undefined) {
      throw new Error('Expected a global-only diagnostic.');
    }

    expect(globalOnly.message).toContain('global-only');
    expect(globalOnly.message).toContain('home');
    expect(runtimeConfigDiagnosticAttribution(globalOnly)).toBe(
      '[character mira] ',
    );
  });

  it.each([
    [
      'project02.storeRoot',
      '/tmp/home',
      {version: runtimeConfigVersion, project02: {storeRoot: '/tmp/home'}},
      true,
    ],
    [
      'project02.character',
      'mira',
      {version: runtimeConfigVersion, project02: {character: 'mira'}},
      true,
    ],
    [
      'project02.defaultMemoryProvider',
      'memory',
      {
        version: runtimeConfigVersion,
        project02: {defaultMemoryProvider: 'memory'},
      },
      false,
    ],
    [
      'project02.roleModelProvider',
      'local',
      {
        version: runtimeConfigVersion,
        project02: {roleModelProvider: 'local' as const},
      },
      false,
    ],
    [
      'project02.userDisplayName',
      'Mike',
      {version: runtimeConfigVersion, project02: {userDisplayName: 'Mike'}},
      false,
    ],
  ] as const)(
    'uses one character-field scope policy for %s across every write boundary',
    (path, value, candidate, globalOnly) => {
      const operation = {kind: 'set' as const, path, value};
      const dataRoot = overlayDataRoot();

      writeRuntimeConfig(characterOverlayConfigPath(dataRoot), candidate);
      const loaded = loadCharacterOverlay(dataRoot);

      if (globalOnly) {
        expect(() => {
          assertScopedMutationOperationAllowed(operation);
        }).toThrow('global-only');
        expect(() => {
          assertOverlayLocatedCandidateStaysCharacterScoped(candidate);
        }).toThrow('global-only');
        expect(loaded.diagnostics).toEqual([
          expect.objectContaining({
            code: 'runtime_config_field_global_only',
            path,
          }),
        ]);
        return;
      }

      expect(() => {
        assertScopedMutationOperationAllowed(operation);
      }).not.toThrow();
      expect(() => {
        assertOverlayLocatedCandidateStaysCharacterScoped(candidate);
      }).not.toThrow();
      expect(loaded.diagnostics).toEqual([]);
    },
  );

  it('stays structurally incompatible with the global loaded-config type', () => {
    // Structural guard (R7): an overlay must never reach the global
    // resolvers or re-derive a store root from its own path. This fails
    // to compile if the overlay type ever becomes assignable.
    type OverlayAssignableToGlobal =
      LoadedProject02CharacterOverlayConfig extends LoadedProject02RuntimeConfig
        ? true
        : false;
    const overlayIsAssignable: OverlayAssignableToGlobal = false;

    expect(overlayIsAssignable).toBe(false);
  });

  it('applies the shared version gate and JSON diagnostics with origin', () => {
    const dataRoot = overlayDataRoot();

    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {
      version: 'project02.config.v1',
      project02: {userDisplayName: 'Mike'},
    });

    const versionGated = loadCharacterOverlay(dataRoot);

    expect(versionGated.config).toBeUndefined();
    expect(versionGated.diagnostics).toHaveLength(1);
    expect(versionGated.diagnostics[0]).toMatchObject({
      code: 'runtime_config_version_unsupported',
      origin: {characterId: 'mira'},
    });
  });
});

describe('layered runtime config resolution', () => {
  const character = {character: 'mira'};

  it('is byte-identical to the global resolve without an overlay', () => {
    const loadedConfig = loadedGlobalConfig({
      project02: {...character, userDisplayName: 'Global Name'},
    });
    const globalResolved = resolveProject02RuntimeConfig({
      ...runtimeConfigSnapshotForTest({loadedConfig: loadedConfig}),
    });

    expect(
      resolveLayeredProject02RuntimeConfig({
        ...runtimeConfigSnapshotForTest({loadedConfig: loadedConfig}),
      }),
    ).toEqual(globalResolved);
    expect(
      resolveLayeredProject02RuntimeConfig({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loadedConfig,
          characterId: {
            scope: 'character',
            characterId: 'mira',
            source: 'none',
            diagnostics: [],
          }.characterId,
        }),

        overlayConfig: {
          scope: 'character',
          characterId: 'mira',
          source: 'none',
          diagnostics: [],
        },
      }),
    ).toEqual(globalResolved);
  });

  it('overrides only character-scoped project02 fields and keeps the global path', () => {
    const loadedConfig = loadedGlobalConfig({
      project02: {
        ...character,
        userDisplayName: 'Global Name',
        roleModelProvider: 'local',
      },
    });
    const resolved = resolveLayeredProject02RuntimeConfig({
      ...runtimeConfigSnapshotForTest({
        loadedConfig: loadedConfig,
        characterId: loadedOverlay({
          project02: {
            userDisplayName: 'Overlay Name',
            roleModelProvider: 'nvidia',
            defaultMemoryProvider: 'memory.overlay',
            // Smuggled global-only values must never cross the merge, even
            // when a hand-built overlay bypasses the loader's rejection.
            storeRoot: '/smuggled-home',
            character: 'nova',
          },
        }).characterId,
      }),

      overlayConfig: loadedOverlay({
        project02: {
          userDisplayName: 'Overlay Name',
          roleModelProvider: 'nvidia',
          defaultMemoryProvider: 'memory.overlay',
          // Smuggled global-only values must never cross the merge, even
          // when a hand-built overlay bypasses the loader's rejection.
          storeRoot: '/smuggled-home',
          character: 'nova',
        },
      }),
    });

    expect(resolved.project02).toMatchObject({
      storeRoot: '/global-home',
      character: 'mira',
      userDisplayName: 'Overlay Name',
      roleModelProvider: 'nvidia',
      defaultMemoryProvider: 'memory.overlay',
    });
    expect(resolved.path).toBe('/global-home/config.json');
    expect(resolved.diagnostics).toEqual([]);
  });

  it('merges plugin enablement and config at field level', () => {
    const plugin = structuredConfigPlugin('demo.layered');
    const loadedConfig = loadedGlobalConfig({
      project02: character,
      plugins: {
        'demo.layered': {
          enabled: false,
          config: {settings: {from: 'global'}, endpoints: ['global']},
        },
      },
    });

    const globalOnly = resolveProject02RuntimeConfig({
      ...runtimeConfigSnapshotForTest({loadedConfig: loadedConfig}),

      pluginManifests: [plugin.manifest],
    });
    // Disabled globally: config is not validated, fields resolve as-is.
    expect(globalOnly.diagnostics).toEqual([]);

    const reEnabled = resolveLayeredProject02RuntimeConfig({
      ...runtimeConfigSnapshotForTest({
        loadedConfig: loadedConfig,
        characterId: loadedOverlay({
          plugins: {
            'demo.layered': {
              enabled: true,
              config: {settings: {from: 'overlay'}},
            },
          },
        }).characterId,
      }),

      pluginManifests: [plugin.manifest],
      overlayConfig: loadedOverlay({
        plugins: {
          'demo.layered': {
            enabled: true,
            config: {settings: {from: 'overlay'}},
          },
        },
      }),
    });

    // The overlay re-enables the plugin and replaces one field; the
    // other field survives from the global layer.
    expect(reEnabled.pluginConfigs['demo.layered']).toMatchObject({
      settings: {resolved: true, value: {from: 'overlay'}},
      endpoints: {resolved: true, value: ['global']},
    });
    expect(reEnabled.diagnostics).toEqual([]);

    const disabledByOverlay = resolveLayeredProject02RuntimeConfig({
      runtimeLocation: runtimeLocationForTest({
        loadedConfig: loadedGlobalConfig({
          project02: character,
          plugins: {'demo.layered': {enabled: true}},
        }),
        characterId: loadedOverlay({
          plugins: {'demo.layered': {enabled: false}},
        }).characterId,
      }),
      loadedConfig: loadedGlobalConfig({
        project02: character,
        plugins: {'demo.layered': {enabled: true}},
      }),
      pluginManifests: [plugin.manifest],
      overlayConfig: loadedOverlay({
        plugins: {'demo.layered': {enabled: false}},
      }),
    });

    // Disabling via overlay suppresses the required-config validation
    // that an enabled plugin with no config would fail.
    expect(disabledByOverlay.diagnostics).toEqual([]);
  });

  it('changes the effective fingerprint when character-scoped values change', () => {
    const base = resolveProject02RuntimeConfig({
      runtimeLocation: runtimeLocationForTest({
        loadedConfig: loadedGlobalConfig({
          project02: {...character, userDisplayName: 'One'},
        }),
      }),
      loadedConfig: loadedGlobalConfig({
        project02: {...character, userDisplayName: 'One'},
      }),
    });
    const renamedUser = resolveProject02RuntimeConfig({
      runtimeLocation: runtimeLocationForTest({
        loadedConfig: loadedGlobalConfig({
          project02: {...character, userDisplayName: 'Two'},
        }),
      }),
      loadedConfig: loadedGlobalConfig({
        project02: {...character, userDisplayName: 'Two'},
      }),
    });
    const otherCharacter = resolveProject02RuntimeConfig({
      runtimeLocation: runtimeLocationForTest({
        loadedConfig: loadedGlobalConfig({
          project02: {character: 'nova', userDisplayName: 'One'},
        }),
      }),
      loadedConfig: loadedGlobalConfig({
        project02: {character: 'nova', userDisplayName: 'One'},
      }),
    });
    const overlayApplied = resolveLayeredProject02RuntimeConfig({
      runtimeLocation: runtimeLocationForTest({
        loadedConfig: loadedGlobalConfig({
          project02: {...character, userDisplayName: 'One'},
        }),
        characterId: loadedOverlay({
          project02: {userDisplayName: 'Two'},
        }).characterId,
      }),
      loadedConfig: loadedGlobalConfig({
        project02: {...character, userDisplayName: 'One'},
      }),
      overlayConfig: loadedOverlay({
        project02: {userDisplayName: 'Two'},
      }),
    });

    expect(renamedUser.effectiveConfigFingerprint).not.toBe(
      base.effectiveConfigFingerprint,
    );
    expect(otherCharacter.effectiveConfigFingerprint).not.toBe(
      base.effectiveConfigFingerprint,
    );
    expect(overlayApplied.effectiveConfigFingerprint).toBe(
      renamedUser.effectiveConfigFingerprint,
    );
  });
});

describe('startup with a character overlay', () => {
  it('resolves the overlay for the configured character before activation', async () => {
    const homeRoot = createTestTempRoot();
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    mkdirSync(dataRoot, {recursive: true});
    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {userDisplayName: 'Global Name'},
    });
    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {
      project02: {userDisplayName: 'Overlay Name'},
    });

    const startup = await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
      factories: {},
    });

    expect(startup.status).toBe('resolved');
    if (startup.status === 'character_invalid') {
      throw new Error('Expected a plugin activation plan.');
    }
    expect(startup.overlayLoadedConfig).toMatchObject({
      scope: 'character',
      characterId: 'mira',
      source: 'overlay',
    });
    expect(
      startup.activationPlan.resolvedConfig.project02.userDisplayName,
    ).toBe('Overlay Name');
  });

  it('blocks startup on an overlay error with character attribution', async () => {
    const homeRoot = createTestTempRoot();
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    mkdirSync(dataRoot, {recursive: true});
    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {
      project02: {storeRoot: '/elsewhere'},
    });

    const startup = await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
      factories: {},
    });

    expect(startup.status).toBe('config_invalid');
    if (startup.status === 'character_invalid') {
      throw new Error('Expected a plugin activation plan.');
    }
    expect(startup.overlayLoadedConfig?.characterId).toBe('mira');
    expect(
      startup.activationPlan.resolvedConfig.diagnostics.filter(
        diagnostic => diagnostic.code === 'runtime_config_field_global_only',
      ),
    ).toMatchObject([{origin: {characterId: 'mira'}}]);
  });

  it('fails startup as character_invalid for an unknown configured character', async () => {
    const homeRoot = createTestTempRoot();

    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {character: 'nova'},
    });

    const startup = await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
      factories: {},
    });

    expect(startup.status).toBe('character_invalid');
    if (startup.status !== 'character_invalid') {
      throw new Error('Expected character_invalid.');
    }
    expect(startup.characterActivation).toMatchObject({status: 'failed'});
  });
});
