import {existsSync, mkdirSync, symlinkSync, writeFileSync} from 'node:fs';
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
  blockingRuntimeConfigLayerDiagnostic,
  characterOverlayConfigPath,
  layeredRuntimeConfigFingerprintForScope,
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

function overlayFingerprint(dataRoot: string, characterId = 'mira'): string {
  return layeredRuntimeConfigFingerprintForScope({
    globalConfig: {version: runtimeConfigVersion},
    characterScope: {characterId, dataRoot},
    overlay: loadCharacterOverlay(dataRoot, characterId),
  });
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
    secretsEnv: {},
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
      secretsEnv: {},
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

  it('retains the authored document of an invalid overlay but no config', () => {
    const dataRoot = overlayDataRoot();

    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {
      project02: {userDisplayName: 42},
    });

    const overlay = loadCharacterOverlay(dataRoot);

    // Repairable and unusable at once: the bytes survive for the control seam
    // to edit, but no validated config reaches resolution.
    expect(overlay.authoredDocument).toEqual({
      version: runtimeConfigVersion,
      project02: {userDisplayName: 42},
    });
    expect(overlay.config).toBeUndefined();
    expect(blockingRuntimeConfigLayerDiagnostic(overlay)).toBeUndefined();
  });

  it('reports no authored document when the overlay is not readable JSON', () => {
    const dataRoot = overlayDataRoot();

    writeFileSync(characterOverlayConfigPath(dataRoot), '{not json\n');

    const overlay = loadCharacterOverlay(dataRoot);

    // Nothing to base an edit on, so this layer stays unrepairable.
    expect(overlay.authoredDocument).toBeUndefined();
    expect(blockingRuntimeConfigLayerDiagnostic(overlay)).toMatchObject({
      code: 'runtime_config_malformed_json',
    });
  });

  it('stays structurally incompatible with the global loaded-config type', () => {
    // R7: an overlay must never reach the global resolvers, so this stops
    // compiling if the type ever becomes assignable.
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

  it('fingerprints an edit to an invalid overlay as a change', () => {
    const dataRoot = overlayDataRoot();
    const overlayPath = characterOverlayConfigPath(dataRoot);

    // Two bad fields, so fixing one still leaves the overlay invalid.
    writeRuntimeConfig(overlayPath, {
      project02: {storeRoot: '/elsewhere', character: 'nova'},
    });

    const before = overlayFingerprint(dataRoot);

    writeRuntimeConfig(overlayPath, {project02: {character: 'nova'}});

    // Both overlays are invalid; only the bytes moved, and a currency gate
    // holding `before` must still decline against the new fingerprint.
    expect(overlayFingerprint(dataRoot)).not.toBe(before);
  });

  it('separates unusable-for-different-reasons overlays from each other', () => {
    const dataRoot = overlayDataRoot();
    const overlayPath = characterOverlayConfigPath(dataRoot);

    writeRuntimeConfig(overlayPath, {project02: {storeRoot: '/elsewhere'}});

    const invalid = overlayFingerprint(dataRoot);

    writeRuntimeConfig(overlayPath, {});

    expect(overlayFingerprint(dataRoot)).not.toBe(invalid);
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
          secretsEnv: {},
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
            // Hand-built to bypass the loader's rejection of global-only keys.
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
          // Hand-built to bypass the loader's rejection of global-only keys.
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

    // Disabling via overlay suppresses the required-config validation.
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

  it('blocks a read-only startup on a repairable overlay value', async () => {
    const homeRoot = createTestTempRoot();
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    mkdirSync(dataRoot, {recursive: true});
    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    // Repairability is granted by a requested mutation, never by the shape of
    // the invalid value.
    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {
      project02: {userDisplayName: 42},
    });

    const startup = await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
      factories: {},
    });

    expect(startup.status).toBe('config_invalid');
    expect(existsSync(join(dataRoot, 'schema.json'))).toBe(false);
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

  it('returns character_invalid before deriving storage for an invalid explicit id', async () => {
    const homeRoot = createTestTempRoot();

    const startup = await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot, character: '../bad'},
      env: {},
      factories: {},
    });

    expect(startup.status).toBe('character_invalid');
    if (startup.status !== 'character_invalid') {
      throw new Error('Expected character_invalid.');
    }
    expect(startup.characterActivation).toMatchObject({
      status: 'failed',
      configuredCharacterId: '../bad',
    });
    expect(existsSync(join(homeRoot, 'character-data'))).toBe(false);
    expect(existsSync(join(homeRoot, '.locks'))).toBe(false);
    expect(existsSync(join(homeRoot, 'config.json'))).toBe(false);
  });
});
