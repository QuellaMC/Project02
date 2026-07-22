import {mkdirSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {structuredConfigPlugin} from '../support/runtime-config-fixtures.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {resolveRuntimeCliStartup} from '../../src/app/index.ts';
import {
  characterOverlayConfigPath,
  loadProject02CharacterOverlayConfig,
  resolveLayeredProject02RuntimeConfig,
  resolveProject02RuntimeConfig,
  runtimeConfigDiagnosticAttribution,
  runtimeConfigVersion,
  type LoadedProject02CharacterOverlayConfig,
  type LoadedProject02RuntimeConfig,
  type Project02HostConfig,
  type Project02RuntimePluginConfig,
} from '../../src/runtime/config/index.ts';
import {characterDataDirPath} from '../../src/runtime/storage/index.ts';

function overlayDataRoot(): string {
  const dataRoot = join(createTestTempRoot(), 'character-data', 'mira');

  mkdirSync(dataRoot, {recursive: true});
  return dataRoot;
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
  it('treats an absent overlay file as valid and empty', () => {
    const overlay = loadProject02CharacterOverlayConfig({
      dataRoot: overlayDataRoot(),
      characterId: 'mira',
    });

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

    const overlay = loadProject02CharacterOverlayConfig({
      dataRoot,
      characterId: 'mira',
    });

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

    const overlay = loadProject02CharacterOverlayConfig({
      dataRoot,
      characterId: 'mira',
    });

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

    const versionGated = loadProject02CharacterOverlayConfig({
      dataRoot,
      characterId: 'mira',
    });

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
    const globalResolved = resolveProject02RuntimeConfig({loadedConfig});

    expect(resolveLayeredProject02RuntimeConfig({loadedConfig})).toEqual(
      globalResolved,
    );
    expect(
      resolveLayeredProject02RuntimeConfig({
        loadedConfig,
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
      loadedConfig,
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
      loadedConfig,
      pluginManifests: [plugin.manifest],
    });
    // Disabled globally: config is not validated, fields resolve as-is.
    expect(globalOnly.diagnostics).toEqual([]);

    const reEnabled = resolveLayeredProject02RuntimeConfig({
      loadedConfig,
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
      loadedConfig: loadedGlobalConfig({
        project02: {...character, userDisplayName: 'One'},
      }),
    });
    const renamedUser = resolveProject02RuntimeConfig({
      loadedConfig: loadedGlobalConfig({
        project02: {...character, userDisplayName: 'Two'},
      }),
    });
    const otherCharacter = resolveProject02RuntimeConfig({
      loadedConfig: loadedGlobalConfig({
        project02: {character: 'nova', userDisplayName: 'One'},
      }),
    });
    const overlayApplied = resolveLayeredProject02RuntimeConfig({
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
  it('resolves the overlay for the configured character before activation', () => {
    const homeRoot = createTestTempRoot();
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    mkdirSync(dataRoot, {recursive: true});
    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {userDisplayName: 'Global Name'},
    });
    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {
      project02: {userDisplayName: 'Overlay Name'},
    });

    const startup = resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
      factories: {},
    });

    expect(startup.status).toBe('resolved');
    expect(startup.overlayLoadedConfig).toMatchObject({
      scope: 'character',
      characterId: 'mira',
      source: 'overlay',
    });
    expect(
      startup.activationPlan.resolvedConfig.project02.userDisplayName,
    ).toBe('Overlay Name');
  });

  it('blocks startup on an overlay error with character attribution', () => {
    const homeRoot = createTestTempRoot();
    const dataRoot = characterDataDirPath(homeRoot, 'nova');

    mkdirSync(dataRoot, {recursive: true});
    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {character: 'nova'},
    });
    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {
      project02: {storeRoot: '/elsewhere'},
    });

    const startup = resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
      factories: {},
    });

    expect(startup.status).toBe('config_invalid');
    expect(startup.overlayLoadedConfig?.characterId).toBe('nova');
    expect(
      startup.activationPlan.resolvedConfig.diagnostics.filter(
        diagnostic => diagnostic.code === 'runtime_config_field_global_only',
      ),
    ).toMatchObject([{origin: {characterId: 'nova'}}]);
  });
});
