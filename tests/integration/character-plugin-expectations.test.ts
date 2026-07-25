import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {
  enforceCharacterPluginExpectations,
  planCharacterPackagePluginMaterialization,
  resolveRuntimeCliStartup,
} from '../../src/app/index.ts';
import type {CharacterPluginExpectations} from '../../src/characters/index.ts';
import {
  applyRuntimeConfigControlOperation,
  characterOverlayConfigPath,
  resolveRuntimeConfigScopeTarget,
} from '../../src/runtime/config/index.ts';
import {
  characterDataDirPath,
  createLocalRuntimeStorageLayout,
  decodeStorageSchemaMarker,
  ensureCharacterDataMarker,
} from '../../src/runtime/storage/index.ts';
import type {RuntimePluginActivationResult} from '../../src/app/index.ts';
import {
  writeRuntimeConfig,
  runtimeLocationForTest,
} from '../support/runtime-config.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

function expectations(
  overrides: Partial<CharacterPluginExpectations>,
): CharacterPluginExpectations {
  return {
    required: [],
    recommended: [],
    config: {},
    ...overrides,
  };
}

function activationWithEnabled(
  enabledPluginIds: readonly string[],
): RuntimePluginActivationResult {
  return {
    enabledPluginIds,
    disabledPluginIds: [],
    plugins: [],
    diagnostics: [],
  };
}

/** Seeds a home whose operator character declares a plugins block. */
function homeWithCharacter(options: {
  readonly characterId: string;
  readonly version?: string;
  readonly plugins?: Readonly<Record<string, unknown>>;
}): string {
  const homeRoot = createTestTempRoot('project02-char-plugins-');

  writeCharacterPackage({
    homeRoot,
    characterId: options.characterId,
    version: options.version ?? '1.0.0',
    ...(options.plugins === undefined ? {} : {plugins: options.plugins}),
  });
  writeRuntimeConfig(join(homeRoot, 'config.json'), {
    project02: {character: options.characterId},
  });
  return homeRoot;
}

function writeCharacterPackage(options: {
  readonly homeRoot: string;
  readonly characterId: string;
  readonly version: string;
  readonly plugins?: Readonly<Record<string, unknown>>;
}): void {
  const packageRoot = join(options.homeRoot, 'characters', options.characterId);

  mkdirSync(packageRoot, {recursive: true});
  writeFileSync(
    join(packageRoot, 'project02.character.json'),
    `${JSON.stringify(
      {
        format: 'project02.character.v1',
        identity: {
          id: options.characterId,
          displayName: 'Seeded Character',
        },
        persona: {system: ['You are a seeded fixture character.']},
        meta: {version: options.version},
        ...(options.plugins === undefined ? {} : {plugins: options.plugins}),
      },
      null,
      2,
    )}\n`,
  );
}

describe('character plugin enforcement', () => {
  it('escalates required plugins and only warns for recommended ones', () => {
    const diagnostics = enforceCharacterPluginExpectations({
      expectations: expectations({
        required: ['missing-required', 'disabled-required', 'ok-plugin'],
        recommended: ['missing-recommended', 'ok-plugin'],
      }),
      characterId: 'seeded',
      activation: activationWithEnabled(['ok-plugin']),
      installedPluginIds: new Set(['disabled-required', 'ok-plugin']),
    });

    expect(diagnostics).toMatchObject([
      {
        severity: 'error',
        code: 'character_required_plugin_missing',
        pluginId: 'missing-required',
      },
      {
        severity: 'error',
        code: 'character_required_plugin_disabled',
        pluginId: 'disabled-required',
      },
      {
        severity: 'warning',
        code: 'character_recommended_plugin_missing',
        pluginId: 'missing-recommended',
      },
    ]);
    expect(diagnostics[1]?.message).toContain(
      'runtime-config --character seeded plugin enable disabled-required',
    );
  });
});

describe('character plugin materialization planning', () => {
  it.each(['toString', 'constructor'] as const)(
    'treats prototype-colliding plugin id %s as an ordinary own-property lookup',
    pluginId => {
      const plan = planCharacterPackagePluginMaterialization({
        expectations: expectations({required: [pluginId]}),
        pluginManifests: [],
      });

      expect(plan).toEqual({
        status: 'ready',
        document: {
          version: 'project02.config.v2',
          plugins: {[pluginId]: {enabled: true}},
        },
      });
    },
  );
});

describe('first-selection materialization through startup', () => {
  it('writes a versioned minimal overlay even when the package declares no plugins', async () => {
    const homeRoot = homeWithCharacter({characterId: 'seeded'});
    const dataRoot = characterDataDirPath(homeRoot, 'seeded');

    await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
    });

    expect(
      JSON.parse(readFileSync(characterOverlayConfigPath(dataRoot), 'utf8')),
    ).toEqual({version: 'project02.config.v2'});
    expect(
      decodeStorageSchemaMarker(
        readFileSync(
          createLocalRuntimeStorageLayout({storeRoot: dataRoot}).schemaPath,
          'utf8',
        ),
      ),
    ).toMatchObject({
      schemaVersion: 4,
      materializedCharacterPackageVersion: '1.0.0',
    });
  });

  it('writes only package overrides and keeps absent fields inherited from global config', async () => {
    const homeRoot = homeWithCharacter({
      characterId: 'seeded',
      plugins: {
        recommended: ['demo-config'],
        config: {'demo-config': {tone: 'warm'}},
      },
    });
    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {character: 'seeded'},
      plugins: {
        'demo-config': {
          enabled: false,
          config: {tone: 'formal', signoff: 'Global One'},
        },
      },
    });
    const dataRoot = characterDataDirPath(homeRoot, 'seeded');
    const first = await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
    });

    expect(
      JSON.parse(readFileSync(characterOverlayConfigPath(dataRoot), 'utf8')),
    ).toEqual({
      version: 'project02.config.v2',
      plugins: {
        'demo-config': {enabled: true, config: {tone: 'warm'}},
      },
    });
    if (first.status !== 'resolved') {
      throw new Error('Expected the package override to activate.');
    }
    expect(
      first.activationPlan.resolvedConfig.pluginConfigs['demo-config'],
    ).toMatchObject({
      tone: {value: 'warm'},
      signoff: {value: 'Global One'},
    });

    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {character: 'seeded'},
      plugins: {
        'demo-config': {
          enabled: false,
          config: {tone: 'pirate', signoff: 'Global Two'},
        },
      },
    });
    const second = await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
    });

    if (second.status !== 'resolved') {
      throw new Error('Expected inherited global changes to resolve.');
    }
    expect(
      second.activationPlan.resolvedConfig.pluginConfigs['demo-config'],
    ).toMatchObject({
      tone: {value: 'warm'},
      signoff: {value: 'Global Two'},
    });
  });

  it('keeps config-only and unknown plugin defaults without implicitly enabling them', async () => {
    const homeRoot = homeWithCharacter({
      characterId: 'seeded',
      plugins: {
        config: {
          'demo-config': {tone: 'warm'},
          'future-plugin': {mode: 'later'},
        },
      },
    });
    const dataRoot = characterDataDirPath(homeRoot, 'seeded');
    const startup = await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
      continueAfterActivationErrors: true,
    });

    expect(startup.status).toBe('resolved');
    expect(
      JSON.parse(readFileSync(characterOverlayConfigPath(dataRoot), 'utf8')),
    ).toEqual({
      version: 'project02.config.v2',
      plugins: {
        'demo-config': {config: {tone: 'warm'}},
        'future-plugin': {config: {mode: 'later'}},
      },
    });
    if (startup.status === 'character_invalid') {
      throw new Error('Expected a plugin activation plan.');
    }
    expect(
      startup.activationPlan.activation.diagnostics.filter(
        diagnostic =>
          diagnostic.code === 'character_package_plugin_auto_enabled',
      ),
    ).toEqual([]);
  });

  it('materializes required enablement above a global disable', async () => {
    const homeRoot = homeWithCharacter({
      characterId: 'seeded',
      plugins: {required: ['demo-config']},
    });
    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {character: 'seeded'},
      plugins: {'demo-config': {enabled: false}},
    });
    const overlayPath = characterOverlayConfigPath(
      characterDataDirPath(homeRoot, 'seeded'),
    );

    const startup = await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
    });

    expect(startup.status).toBe('resolved');
    expect(JSON.parse(readFileSync(overlayPath, 'utf8'))).toEqual({
      version: 'project02.config.v2',
      plugins: {'demo-config': {enabled: true}},
    });
    if (startup.status === 'character_invalid') {
      throw new Error('Expected a plugin activation plan.');
    }
    expect(
      startup.activationPlan.activation.diagnostics.filter(
        diagnostic =>
          diagnostic.code === 'character_package_plugin_auto_enabled',
      ),
    ).toHaveLength(1);
  });

  it('materializes recommended enablement above a global disable', async () => {
    const homeRoot = homeWithCharacter({
      characterId: 'seeded',
      plugins: {recommended: ['demo-config']},
    });
    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {character: 'seeded'},
      plugins: {'demo-config': {enabled: false}},
    });
    const overlayPath = characterOverlayConfigPath(
      characterDataDirPath(homeRoot, 'seeded'),
    );

    const startup = await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
    });

    expect(startup.status).toBe('resolved');
    expect(JSON.parse(readFileSync(overlayPath, 'utf8'))).toEqual({
      version: 'project02.config.v2',
      plugins: {'demo-config': {enabled: true}},
    });
    if (startup.status !== 'resolved') {
      throw new Error('Expected startup to continue after a recommendation.');
    }
    expect(
      startup.activationPlan.activation.diagnostics.filter(
        diagnostic =>
          diagnostic.code === 'character_package_plugin_auto_enabled',
      ),
    ).toHaveLength(1);
  });

  it('persists intended enablement and blocks a missing required plugin', async () => {
    const homeRoot = homeWithCharacter({
      characterId: 'seeded',
      plugins: {required: ['not-installed-plugin']},
    });
    const overlayPath = characterOverlayConfigPath(
      characterDataDirPath(homeRoot, 'seeded'),
    );

    const startup = await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
    });

    expect(JSON.parse(readFileSync(overlayPath, 'utf8'))).toEqual({
      version: 'project02.config.v2',
      plugins: {'not-installed-plugin': {enabled: true}},
    });
    expect(startup.status).toBe('activation_blocked_before_runtime_env');
    if (startup.status === 'character_invalid') {
      throw new Error('Expected a plugin activation plan.');
    }
    expect(
      startup.activationPlan.activation.diagnostics.filter(
        diagnostic => diagnostic.code === 'character_required_plugin_missing',
      ),
    ).toHaveLength(1);
  });

  it('fills missing package entries without overwriting an earlier scoped edit', async () => {
    const homeRoot = homeWithCharacter({
      characterId: 'seeded',
      plugins: {required: ['demo-config']},
    });

    // Operator writes the overlay before ever selecting the character
    // (the CLI verb marks the data dir first, then mutates).
    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: characterDataDirPath(homeRoot, 'seeded')},
      characterId: 'seeded',
    });
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({
        storeRoot: homeRoot,
        characterId: 'seeded',
        env: {},
      }),

      env: {},
      scope: 'character',
    });
    applyRuntimeConfigControlOperation({
      target,
      request: {
        kind: 'document',
        operation: {
          kind: 'set',
          path: 'project02.userDisplayName',
          value: 'Early Bird',
        },
      },
    });

    const overlayPath = characterOverlayConfigPath(
      characterDataDirPath(homeRoot, 'seeded'),
    );
    const cliWrittenBytes = readFileSync(overlayPath, 'utf8');
    const startup = await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
    });

    expect(readFileSync(overlayPath, 'utf8')).not.toBe(cliWrittenBytes);
    expect(JSON.parse(readFileSync(overlayPath, 'utf8'))).toEqual({
      version: 'project02.config.v2',
      project02: {userDisplayName: 'Early Bird'},
      plugins: {'demo-config': {enabled: true}},
    });
    expect(startup.status).toBe('resolved');
    if (startup.status === 'character_invalid') {
      throw new Error('Expected a plugin activation plan.');
    }
    expect(
      startup.activationPlan.activation.diagnostics.filter(
        diagnostic =>
          diagnostic.code === 'character_package_plugin_auto_enabled',
      ),
    ).toHaveLength(1);
  });

  it('blocks a required plugin an operator explicitly disabled in the overlay', async () => {
    const homeRoot = homeWithCharacter({
      characterId: 'seeded',
      plugins: {required: ['demo-config']},
    });
    const dataRoot = characterDataDirPath(homeRoot, 'seeded');

    mkdirSync(dataRoot, {recursive: true});
    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {
      plugins: {'demo-config': {enabled: false}},
    });

    const startup = await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
    });

    expect(startup.status).toBe('activation_blocked_before_runtime_env');
    if (startup.status === 'character_invalid') {
      throw new Error('Expected a plugin activation plan.');
    }

    const disabled = startup.activationPlan.activation.diagnostics.find(
      diagnostic => diagnostic.code === 'character_required_plugin_disabled',
    );

    // The recovery command names the selected home so it edits the
    // right store.
    expect(disabled?.message).toContain(
      `--store ${realpathSync.native(homeRoot)} `,
    );
    expect(disabled?.message).toContain(
      '--character seeded plugin enable demo-config',
    );
  });
});

describe('package-version missing-only upgrades', () => {
  it('does nothing at the same version, then fills only missing fields and enablement after a version bump', async () => {
    const homeRoot = homeWithCharacter({
      characterId: 'seeded',
      version: '1.0.0',
      plugins: {
        recommended: ['demo-config'],
        config: {
          'demo-config': {
            tone: 'warm',
            signoff: 'First',
            operatorNote: 'Keep me',
          },
        },
      },
    });
    const dataRoot = characterDataDirPath(homeRoot, 'seeded');
    const overlayPath = characterOverlayConfigPath(dataRoot);

    await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
    });
    writeRuntimeConfig(overlayPath, {
      plugins: {
        'demo-config': {
          config: {
            tone: 'playful',
            operatorNote: 'User-owned',
          },
        },
      },
    });
    const sameVersionBytes = readFileSync(overlayPath, 'utf8');

    await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
    });
    expect(readFileSync(overlayPath, 'utf8')).toBe(sameVersionBytes);

    writeCharacterPackage({
      homeRoot,
      characterId: 'seeded',
      version: '2.0.0',
      plugins: {
        recommended: ['demo-config'],
        config: {
          'demo-config': {
            tone: 'formal',
            signoff: 'Returned on upgrade',
          },
        },
      },
    });
    const upgraded = await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
    });

    expect(JSON.parse(readFileSync(overlayPath, 'utf8'))).toEqual({
      version: 'project02.config.v2',
      plugins: {
        'demo-config': {
          enabled: true,
          config: {
            tone: 'playful',
            operatorNote: 'User-owned',
            signoff: 'Returned on upgrade',
          },
        },
      },
    });
    if (upgraded.status !== 'resolved') {
      throw new Error('Expected upgraded package config to resolve.');
    }
    expect(
      upgraded.activationPlan.activation.diagnostics.filter(
        diagnostic =>
          diagnostic.code === 'character_package_plugin_auto_enabled',
      ),
    ).toHaveLength(1);
    expect(
      decodeStorageSchemaMarker(
        readFileSync(
          createLocalRuntimeStorageLayout({storeRoot: dataRoot}).schemaPath,
          'utf8',
        ),
      ),
    ).toMatchObject({materializedCharacterPackageVersion: '2.0.0'});
  });
});

describe('concurrent materialization and first edits', () => {
  it('serializes package defaults and preserves both first scoped edits', async () => {
    const homeRoot = homeWithCharacter({
      characterId: 'seeded',
      plugins: {
        required: ['demo-config'],
        config: {'demo-config': {tone: 'warm'}},
      },
    });
    const dataRoot = characterDataDirPath(homeRoot, 'seeded');

    const startups = await Promise.all([
      resolveRuntimeCliStartup({
        location: {storeRoot: homeRoot},
        env: {},
        characterConfigRequest: {
          kind: 'document',
          operation: {
            kind: 'set',
            path: 'project02.userDisplayName',
            value: 'First Editor',
          },
        },
      }),
      resolveRuntimeCliStartup({
        location: {storeRoot: homeRoot},
        env: {},
        characterConfigRequest: {
          kind: 'document',
          operation: {
            kind: 'set',
            path: 'project02.roleModelProvider',
            value: 'local',
          },
        },
      }),
    ]);

    expect(startups.map(startup => startup.status)).toEqual([
      'resolved',
      'resolved',
    ]);
    expect(
      JSON.parse(readFileSync(characterOverlayConfigPath(dataRoot), 'utf8')),
    ).toEqual({
      version: 'project02.config.v2',
      project02: {
        userDisplayName: 'First Editor',
        roleModelProvider: 'local',
      },
      plugins: {
        'demo-config': {
          enabled: true,
          config: {tone: 'warm'},
        },
      },
    });
  });
});

describe('materialization ordering', () => {
  it('creates no durable state when the global config is invalid', async () => {
    const homeRoot = homeWithCharacter({
      characterId: 'seeded',
      plugins: {required: ['demo-config']},
    });

    writeFileSync(
      join(homeRoot, 'config.json'),
      '{"version":"project02.config.v2","unknownField":true}\n',
    );

    const startup = await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
    });

    expect(startup.status).toBe('config_invalid');
    expect(existsSync(characterDataDirPath(homeRoot, 'seeded'))).toBe(false);
    expect(existsSync(join(homeRoot, 'schema.json'))).toBe(false);
  });

  it('creates no durable state when a known package field has the wrong type', async () => {
    const homeRoot = homeWithCharacter({
      characterId: 'seeded',
      plugins: {
        config: {'demo-config': {tone: 42}},
      },
    });
    const startup = await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
    });

    expect(startup.status).toBe('config_invalid');
    if (startup.status === 'character_invalid') {
      throw new Error('Expected config-invalid materialization planning.');
    }
    expect(startup.activationPlan.activation.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'character_package_plugin_config_invalid',
        severity: 'error',
      }),
    );
    expect(existsSync(characterDataDirPath(homeRoot, 'seeded'))).toBe(false);
    expect(existsSync(join(homeRoot, 'schema.json'))).toBe(false);
  });

  it('creates no durable state for global enablement of a character-only plugin', async () => {
    const homeRoot = homeWithCharacter({characterId: 'seeded'});

    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {character: 'seeded'},
      plugins: {'character-state': {enabled: true}},
    });
    const startup = await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
    });

    expect(startup.status).toBe('config_invalid');
    if (startup.status === 'character_invalid') {
      throw new Error('Expected config-invalid scope policy.');
    }
    expect(startup.activationPlan.resolvedConfig.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'runtime_config_character_only_plugin_enabled_globally',
        severity: 'error',
      }),
    );
    expect(existsSync(characterDataDirPath(homeRoot, 'seeded'))).toBe(false);
    expect(existsSync(join(homeRoot, 'schema.json'))).toBe(false);
  });
});

describe('materialization ordering for pre-existing overlays', () => {
  it('reports an invalid pre-existing overlay without creating durable state', async () => {
    const homeRoot = homeWithCharacter({
      characterId: 'seeded',
      plugins: {required: ['demo-config']},
    });
    const dataRoot = characterDataDirPath(homeRoot, 'seeded');

    mkdirSync(dataRoot, {recursive: true});
    writeFileSync(join(dataRoot, 'config.json'), '{not json\n');

    const startup = await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
    });

    expect(startup.status).toBe('config_invalid');
    // The invalid overlay was read before materialization: no home
    // home marker or character data marker.
    expect(existsSync(join(homeRoot, 'schema.json'))).toBe(false);
    expect(existsSync(join(dataRoot, 'schema.json'))).toBe(false);
  });

  it('rejects an installed-manifest type error in an existing overlay before marker writes', async () => {
    const homeRoot = homeWithCharacter({characterId: 'seeded'});
    const dataRoot = characterDataDirPath(homeRoot, 'seeded');

    mkdirSync(dataRoot, {recursive: true});
    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {
      plugins: {'demo-config': {config: {tone: 42}}},
    });

    const startup = await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
    });

    expect(startup.status).toBe('config_invalid');
    if (startup.status === 'character_invalid') {
      throw new Error('Expected config-invalid overlay policy.');
    }
    expect(startup.activationPlan.resolvedConfig.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'runtime_config_value_type_invalid',
        severity: 'error',
      }),
    );
    expect(existsSync(join(homeRoot, 'schema.json'))).toBe(false);
    expect(existsSync(join(dataRoot, 'schema.json'))).toBe(false);
  });
});
