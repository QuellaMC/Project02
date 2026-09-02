import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {
  characterOnlyConfigPlugin,
  structuredConfigPlugin,
} from '../support/runtime-config-fixtures.ts';
import {requiredSecretPlugin} from '../support/runtime-config-activation-fixtures.ts';
import {
  runtimeLocationForTest,
  writeRuntimeConfig,
  loadRuntimeConfigForTest,
} from '../support/runtime-config.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {
  applyRuntimeConfigControlOperation,
  bindProject02CharacterRuntimeLocation,
  characterOverlayConfigPath,
  characterSecretsEnvPath,
  readCharacterOverlayForScope,
  resolveLayeredProject02RuntimeConfig,
  createLayeredRuntimeConfigFingerprint,
  createRuntimePluginConfigControlCapability,
  loadProject02RuntimeConfigWithLocation,
  RuntimeConfigConflictError,
  runtimeConfigVersion,
  inspectRuntimePluginConfig,
  resolveProject02RuntimeConfig,
  resolveRuntimeConfigScopeTarget,
} from '../../src/runtime/config/index.ts';
import {
  characterDataDirPath,
  ensureCharacterDataMarker,
  ensureInitializedProject02Home,
} from '../../src/runtime/storage/index.ts';
import {canonicalRuntimeConfigPath} from '../../src/runtime/config/path.ts';

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
  it('rejects a missing bound home that becomes a symlink before secret control', async () => {
    const configRoot = createTestTempRoot(
      'project02-config-missing-home-anchor-',
    );
    const missingHome = join(configRoot, 'runtime-home');
    const redirectedHome = createTestTempRoot(
      'project02-config-missing-home-redirect-',
    );
    const configPath = writeRuntimeConfig(join(configRoot, 'runtime.json'), {
      storeRoot: missingHome,
    });
    const envVar = 'PROJECT02_MISSING_HOME_SECRET';

    await ensureInitializedProject02Home({homeRoot: redirectedHome});
    const snapshot = loadProject02RuntimeConfigWithLocation({
      selection: {configPath},
      env: {[envVar]: 'secret'},
    });
    const runtimeLocation = bindProject02CharacterRuntimeLocation({
      configLocation: snapshot.configLocation,
      characterId: 'mira',
    });
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation,
      env: {[envVar]: 'secret'},
      scope: 'global',
    });

    symlinkSync(redirectedHome, missingHome);

    expect(() =>
      applyRuntimeConfigControlOperation({
        pluginManifests: [],
        target,
        request: {
          kind: 'plugin_config',
          manifest: requiredSecretPlugin('scope.missing-home').manifest,
          actor: 'operator',
          fieldOperation: {
            kind: 'secret_set',
            fieldName: 'apiKey',
            envVar,
            secretValue: 'secret',
          },
        },
      }),
    ).toThrow(RuntimeConfigConflictError);
    expect(existsSync(join(redirectedHome, '.env'))).toBe(false);
  });

  it('rejects an existing bound home replaced at the same path', async () => {
    const configRoot = createTestTempRoot(
      'project02-config-replaced-home-config-',
    );
    const homeRoot = join(configRoot, 'runtime-home');
    const displacedHome = join(configRoot, 'runtime-home-before');
    const configPath = writeRuntimeConfig(join(configRoot, 'runtime.json'), {
      storeRoot: homeRoot,
    });
    const envVar = 'PROJECT02_REPLACED_HOME_SECRET';

    mkdirSync(homeRoot);
    await ensureInitializedProject02Home({homeRoot});
    const snapshot = loadProject02RuntimeConfigWithLocation({
      selection: {configPath},
      env: {[envVar]: 'secret'},
    });
    const runtimeLocation = bindProject02CharacterRuntimeLocation({
      configLocation: snapshot.configLocation,
      characterId: 'mira',
    });
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation,
      env: {[envVar]: 'secret'},
      scope: 'global',
    });

    renameSync(homeRoot, displacedHome);
    mkdirSync(homeRoot);

    expect(() =>
      applyRuntimeConfigControlOperation({
        pluginManifests: [],
        target,
        request: {
          kind: 'plugin_config',
          manifest: requiredSecretPlugin('scope.replaced-home').manifest,
          actor: 'operator',
          fieldOperation: {
            kind: 'secret_set',
            fieldName: 'apiKey',
            envVar,
            secretValue: 'secret',
          },
        },
      }),
    ).toThrow(RuntimeConfigConflictError);
    expect(existsSync(join(homeRoot, '.env'))).toBe(false);
    expect(existsSync(join(displacedHome, '.env'))).toBe(false);
  });

  it('allows a standalone config edit but rejects its foreign effective home for state control', () => {
    const configRoot = createTestTempRoot(
      'project02-config-standalone-foreign-config-',
    );
    const foreignHome = createTestTempRoot(
      'project02-config-standalone-foreign-home-',
    );
    const configPath = writeRuntimeConfig(join(configRoot, 'runtime.json'), {
      storeRoot: foreignHome,
    });
    const envVar = 'PROJECT02_FOREIGN_HOME_SECRET';

    writeFileSync(join(foreignHome, 'notes.txt'), 'foreign content\n', 'utf8');
    const snapshot = loadProject02RuntimeConfigWithLocation({
      selection: {configPath},
      env: {[envVar]: 'secret'},
    });
    const globalTarget = resolveRuntimeConfigScopeTarget({
      runtimeLocation: snapshot.configLocation,
      env: {[envVar]: 'secret'},
      scope: 'global',
    });

    applyRuntimeConfigControlOperation({
      pluginManifests: [],
      target: globalTarget,
      request: {
        kind: 'document',
        operation: {
          kind: 'set',
          path: 'project02.userDisplayName',
          value: 'Standalone Edit',
        },
      },
    });
    expect(
      (
        JSON.parse(readFileSync(configPath, 'utf8')) as {
          readonly project02: {readonly userDisplayName: string};
        }
      ).project02.userDisplayName,
    ).toBe('Standalone Edit');

    const runtimeLocation = bindProject02CharacterRuntimeLocation({
      configLocation: snapshot.configLocation,
      characterId: 'mira',
    });
    const secretTarget = resolveRuntimeConfigScopeTarget({
      runtimeLocation,
      env: {[envVar]: 'secret'},
      scope: 'global',
    });

    expect(() =>
      applyRuntimeConfigControlOperation({
        pluginManifests: [],
        target: secretTarget,
        request: {
          kind: 'plugin_config',
          manifest: requiredSecretPlugin('scope.foreign-home').manifest,
          actor: 'operator',
          fieldOperation: {
            kind: 'secret_set',
            fieldName: 'apiKey',
            envVar,
            secretValue: 'secret',
          },
        },
      }),
    ).toThrow(/contains foreign entries/);
    expect(() =>
      resolveRuntimeConfigScopeTarget({
        runtimeLocation,
        env: {},
        scope: 'character',
      }),
    ).toThrow(/contains foreign entries/);
    expect(existsSync(join(foreignHome, '.env'))).toBe(false);
    expect(existsSync(join(foreignHome, '.locks'))).toBe(false);
  });

  it('rejects a foreign candidate home without granting it target authority', async () => {
    const configRoot = createTestTempRoot(
      'project02-config-foreign-candidate-config-',
    );
    const currentHome = createTestTempRoot(
      'project02-config-foreign-candidate-current-',
    );
    const foreignHome = createTestTempRoot(
      'project02-config-foreign-candidate-home-',
    );
    const configPath = writeRuntimeConfig(join(configRoot, 'runtime.json'), {
      storeRoot: currentHome,
    });
    const originalConfig = readFileSync(configPath, 'utf8');

    await ensureInitializedProject02Home({homeRoot: currentHome});
    writeFileSync(join(foreignHome, 'notes.txt'), 'foreign content\n', 'utf8');
    const snapshot = loadProject02RuntimeConfigWithLocation({
      selection: {configPath},
      env: {},
    });
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: snapshot.configLocation,
      env: {},
      scope: 'global',
    });

    expect(() =>
      applyRuntimeConfigControlOperation({
        pluginManifests: [],
        target,
        request: {
          kind: 'document',
          operation: {
            kind: 'set',
            path: 'project02.storeRoot',
            value: foreignHome,
          },
        },
      }),
    ).toThrow(/contains foreign entries/);
    expect(readFileSync(configPath, 'utf8')).toBe(originalConfig);
    expect(existsSync(join(foreignHome, '.locks'))).toBe(false);
  });

  it('repairs a standalone config whose current effective home is unusable', () => {
    const configRoot = createTestTempRoot(
      'project02-config-repair-invalid-home-',
    );
    const invalidHome = join(configRoot, 'not-a-directory');
    const repairedHome = createTestTempRoot(
      'project02-config-repair-valid-home-',
    );
    const configPath = writeRuntimeConfig(join(configRoot, 'runtime.json'), {
      storeRoot: invalidHome,
    });

    writeFileSync(invalidHome, 'not a directory\n', 'utf8');
    const snapshot = loadProject02RuntimeConfigWithLocation({
      selection: {configPath},
      env: {},
    });
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: snapshot.configLocation,
      env: {},
      scope: 'global',
    });

    applyRuntimeConfigControlOperation({
      pluginManifests: [],
      target,
      request: {
        kind: 'document',
        operation: {
          kind: 'set',
          path: 'project02.storeRoot',
          value: repairedHome,
        },
      },
    });

    expect(
      (
        JSON.parse(readFileSync(configPath, 'utf8')) as {
          readonly project02: {readonly storeRoot: string};
        }
      ).project02.storeRoot,
    ).toBe(repairedHome);
  });

  it('keeps secret writes at the bound physical home after an authored alias moves', async () => {
    const configRoot = createTestTempRoot(
      'project02-config-bound-home-config-',
    );
    const firstHome = createTestTempRoot('project02-config-bound-home-first-');
    const secondHome = createTestTempRoot(
      'project02-config-bound-home-second-',
    );
    const authoredHome = join(configRoot, 'runtime-home');
    const configPath = writeRuntimeConfig(join(configRoot, 'runtime.json'), {
      storeRoot: authoredHome,
    });
    const envVar = 'PROJECT02_BOUND_HOME_SECRET';

    await ensureInitializedProject02Home({homeRoot: firstHome});
    await ensureInitializedProject02Home({homeRoot: secondHome});
    symlinkSync(firstHome, authoredHome);

    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({
        configPath,
        env: {[envVar]: 'bound-secret'},
      }),
      env: {[envVar]: 'bound-secret'},
      scope: 'global',
    });

    unlinkSync(authoredHome);
    symlinkSync(secondHome, authoredHome);

    const result = applyRuntimeConfigControlOperation({
      pluginManifests: [],
      target,
      request: {
        kind: 'plugin_config',
        manifest: requiredSecretPlugin('scope.bound-home').manifest,
        actor: 'operator',
        fieldOperation: {
          kind: 'secret_set',
          fieldName: 'apiKey',
          envVar,
          secretValue: 'bound-secret',
        },
      },
    });

    expect(result.envPath).toBe(join(realpathSync.native(firstHome), '.env'));
    expect(readFileSync(join(firstHome, '.env'), 'utf8')).toContain(
      `${envVar}="bound-secret"`,
    );
    expect(existsSync(join(secondHome, '.env'))).toBe(false);
  });

  it('guards the selected home separately from the authored runtime home', async () => {
    const selectedHomeRoot = createTestTempRoot(
      'project02-config-selected-owner-',
    );
    const effectiveHomeRoot = createTestTempRoot(
      'project02-config-effective-home-',
    );
    const configPath = join(selectedHomeRoot, 'config.json');

    await ensureInitializedProject02Home({homeRoot: effectiveHomeRoot});
    const effectiveConfigPath = writeRuntimeConfig(
      join(effectiveHomeRoot, 'config.json'),
      {project02: {userDisplayName: 'Effective Home'}},
    );
    writeRuntimeConfig(configPath, {
      project02: {storeRoot: effectiveHomeRoot},
    });
    writeFileSync(
      join(selectedHomeRoot, 'notes.txt'),
      'foreign selected-home content\n',
    );
    const configBefore = readFileSync(configPath, 'utf8');
    const effectiveConfigBefore = readFileSync(effectiveConfigPath, 'utf8');
    const effectiveLocksBefore = readdirSync(
      join(effectiveHomeRoot, '.locks'),
    ).sort();
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({
        storeRoot: selectedHomeRoot,
        env: {},
      }),
      env: {},
      scope: 'global',
    });

    expect(() =>
      applyRuntimeConfigControlOperation({
        pluginManifests: [],
        target,
        request: {
          kind: 'document',
          operation: {
            kind: 'set',
            path: 'project02.userDisplayName',
            value: 'Must Not Land',
          },
        },
      }),
    ).toThrow(/contains foreign entries/);
    expect(readFileSync(configPath, 'utf8')).toBe(configBefore);
    expect(existsSync(join(selectedHomeRoot, '.locks'))).toBe(false);
    expect(readFileSync(effectiveConfigPath, 'utf8')).toBe(
      effectiveConfigBefore,
    );
    expect(readdirSync(join(effectiveHomeRoot, '.locks')).sort()).toEqual(
      effectiveLocksBefore,
    );
  });

  it('writes character-scoped fields to the overlay and only the overlay', async () => {
    const {homeRoot, configPath, dataRoot} = seededHome();
    const globalBefore = readFileSync(configPath, 'utf8');

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });

    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot, env: {}}),

      env: {},
      scope: 'character',
    });
    const result = applyRuntimeConfigControlOperation({
      pluginManifests: [],
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

    expect(result.configPath).toBe(
      canonicalRuntimeConfigPath(characterOverlayConfigPath(dataRoot)),
    );
    expect(result.config).toEqual({
      version: runtimeConfigVersion,
      project02: {userDisplayName: 'Overlay Name'},
    });
    // R7: the overlay lock root is local to the data dir rather than
    // re-inferred from the home.
    expect(readFileSync(configPath, 'utf8')).toBe(globalBefore);
    expect(existsSync(join(dataRoot, '.env'))).toBe(false);
    expect(existsSync(join(dataRoot, '.locks'))).toBe(true);

    const globalConfig = loadRuntimeConfigForTest({
      storeRoot: homeRoot,
      env: {},
    }).config;

    if (globalConfig === undefined) {
      throw new Error('Expected the global config to load.');
    }

    expect(result.fingerprint).toBe(
      createLayeredRuntimeConfigFingerprint({
        pluginManifests: [],
        globalConfig,
        characterId: 'mira',
        overlayConfig: result.config,
      }),
    );
  });

  it('rejects global-only host fields while secrets stay per character', async () => {
    const {homeRoot, dataRoot} = seededHome();
    const plugin = characterOnlyConfigPlugin('scope.secrets');

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });

    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot, env: {}}),

      env: {},
      scope: 'character',
    });

    expect(() =>
      applyRuntimeConfigControlOperation({
        pluginManifests: [],
        target,
        request: {
          kind: 'document',
          operation: {kind: 'set', path: 'project02.storeRoot', value: '/x'},
        },
      }),
    ).toThrow('global-only');

    // A character's credential lands beside its overlay, never in the
    // shared home env, so two characters can hold different accounts.
    applyRuntimeConfigControlOperation({
      pluginManifests: [],
      target,
      request: {
        kind: 'plugin_config',
        manifest: plugin.manifest,
        actor: 'operator',
        fieldOperation: {
          kind: 'secret_set',
          fieldName: 'apiKey',
          envVar: 'SCOPE_SECRETS_KEY',
          secretValue: 'character-value',
        },
      },
    });

    expect(
      JSON.parse(readFileSync(characterOverlayConfigPath(dataRoot), 'utf8')),
    ).toMatchObject({
      plugins: {
        'scope.secrets': {config: {apiKey: {$env: 'SCOPE_SECRETS_KEY'}}},
      },
    });
    expect(readFileSync(characterSecretsEnvPath(dataRoot), 'utf8')).toContain(
      'SCOPE_SECRETS_KEY="character-value"',
    );
    expect(existsSync(join(homeRoot, '.env'))).toBe(false);

    // A later scoped edit validates against the same merged env the
    // runtime resolves with, so the credential above satisfies a
    // required secret even though the process env never held it.
    const requiredSecretManifest = {
      ...plugin.manifest,
      config: {
        ...plugin.manifest.config,
        fields: plugin.manifest.config.fields.map(field =>
          field.name === 'apiKey' ? {...field, required: true} : field,
        ),
      },
    };

    applyRuntimeConfigControlOperation({
      pluginManifests: [],
      target,
      request: {
        kind: 'plugin_config',
        manifest: requiredSecretManifest,
        actor: 'operator',
        fieldOperation: {kind: 'set', fieldName: 'setting', value: 'tuned'},
      },
    });

    expect(
      JSON.parse(readFileSync(characterOverlayConfigPath(dataRoot), 'utf8')),
    ).toMatchObject({
      plugins: {'scope.secrets': {config: {setting: 'tuned'}}},
    });
  });

  it('repairs a blank character secret instead of refusing the write', async () => {
    const {homeRoot, dataRoot} = seededHome();
    const plugin = characterOnlyConfigPlugin('scope.secret-repair');
    const requiredSecretManifest = {
      ...plugin.manifest,
      config: {
        ...plugin.manifest.config,
        fields: plugin.manifest.config.fields.map(field =>
          field.name === 'apiKey' ? {...field, required: true} : field,
        ),
      },
    };

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });
    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {
      plugins: {
        'scope.secret-repair': {
          enabled: true,
          config: {apiKey: {$env: 'SECRET_REPAIR_KEY'}},
        },
      },
    });
    // The value the operator is fixing: present but empty, which the
    // resolver reads as missing.
    writeFileSync(characterSecretsEnvPath(dataRoot), 'SECRET_REPAIR_KEY=""\n');

    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot, env: {}}),

      env: {},
      scope: 'character',
    });

    // Validation judges the file this write is about to produce, so the
    // pending value satisfies the required secret it supplies.
    applyRuntimeConfigControlOperation({
      target,
      pluginManifests: [requiredSecretManifest],
      request: {
        kind: 'plugin_config',
        manifest: requiredSecretManifest,
        actor: 'operator',
        fieldOperation: {
          kind: 'secret_set',
          fieldName: 'apiKey',
          envVar: 'SECRET_REPAIR_KEY',
          secretValue: 'repaired-value',
        },
      },
    });

    expect(readFileSync(characterSecretsEnvPath(dataRoot), 'utf8')).toContain(
      'SECRET_REPAIR_KEY="repaired-value"',
    );
  });

  it('guards the env file a character secret write targets, not the home one', async () => {
    const {homeRoot, dataRoot} = seededHome();
    const plugin = characterOnlyConfigPlugin('scope.env-target');

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });
    // The home env being a symlink is irrelevant to a write that only
    // touches the character's own file.
    symlinkSync(join(homeRoot, 'elsewhere.env'), join(homeRoot, '.env'));

    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot, env: {}}),

      env: {},
      scope: 'character',
    });
    const secretSet = {
      kind: 'plugin_config' as const,
      manifest: plugin.manifest,
      actor: 'operator' as const,
      fieldOperation: {
        kind: 'secret_set' as const,
        fieldName: 'apiKey',
        envVar: 'ENV_TARGET_KEY',
        secretValue: 'character-value',
      },
    };

    applyRuntimeConfigControlOperation({
      pluginManifests: [],
      target,
      request: secretSet,
    });

    expect(readFileSync(characterSecretsEnvPath(dataRoot), 'utf8')).toContain(
      'ENV_TARGET_KEY="character-value"',
    );

    // The file it does write must be real: a symlink would carry the
    // credential outside the character-data directory.
    unlinkSync(characterSecretsEnvPath(dataRoot));
    symlinkSync(
      join(homeRoot, 'elsewhere.env'),
      characterSecretsEnvPath(dataRoot),
    );

    expect(() =>
      applyRuntimeConfigControlOperation({
        pluginManifests: [],
        target,
        request: secretSet,
      }),
    ).toThrow('must be a regular file');
  });

  it('refuses scoped writes into an unmarked data directory', () => {
    const {homeRoot, dataRoot} = seededHome();
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot, env: {}}),

      env: {},
      scope: 'character',
    });

    // The marker is proof that the guarded initializer ran.
    expect(() =>
      applyRuntimeConfigControlOperation({
        pluginManifests: [],
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
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot, env: {}}),

      env: {},
      scope: 'character',
    });

    const freshExpected = applyRuntimeConfigControlOperation({
      pluginManifests: [],
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
      pluginManifests: [],
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
        pluginManifests: [],
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
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot, env: {}}),

      env: {},
      scope: 'character',
    });
    const result = applyRuntimeConfigControlOperation({
      pluginManifests: [],
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

    // Without the global layer the merged candidate misses a required field.
    const bareHome = createTestTempRoot('project02-config-scope-bare-');

    writeRuntimeConfig(join(bareHome, 'config.json'), {
      plugins: {'scope.merged': {enabled: true}},
    });
    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: characterDataDirPath(bareHome, 'mira')},
      characterId: 'mira',
    });
    const bareTarget = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({storeRoot: bareHome, env: {}}),

      env: {},
      scope: 'character',
    });
    expect(() =>
      applyRuntimeConfigControlOperation({
        pluginManifests: [],
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
    // A fresh overlay would move the layered fingerprint for a failed change.
    expect(
      existsSync(
        characterOverlayConfigPath(characterDataDirPath(bareHome, 'mira')),
      ),
    ).toBe(false);
  });

  it('names the overlay, owning home, and global file as the scope target', () => {
    const {homeRoot, configPath, dataRoot} = seededHome();
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({
        storeRoot: homeRoot,
        characterId: 'nova',
        env: {},
      }),

      env: {},
      scope: 'character',
    });

    expect(target).toMatchObject({
      scope: 'character',
      configPath: canonicalRuntimeConfigPath(
        characterOverlayConfigPath(characterDataDirPath(homeRoot, 'nova')),
      ),
      runtimeLocation: {
        selectedConfig: {path: configPath},
        homeRoot: canonicalRuntimeConfigPath(homeRoot),
        characterScope: {characterId: 'nova'},
      },
    });
    expect(dataRoot).toContain('character-data');
  });

  it('rejects an overlay-only selection before resolving a target', async () => {
    const homeRoot = createTestTempRoot('project02-config-scope-owner-');
    const novaRoot = characterDataDirPath(homeRoot, 'nova');
    const novaOverlayPath = characterOverlayConfigPath(novaRoot);

    await ensureInitializedProject02Home({homeRoot});

    expect(() =>
      resolveRuntimeConfigScopeTarget({
        runtimeLocation: runtimeLocationForTest({
          configPath: novaOverlayPath,
          env: {},
        }),

        env: {},
        scope: 'character',
      }),
    ).toThrow('is inside a character-data directory');
    expect(existsSync(novaRoot)).toBe(false);
  });
});

describe('plugin manifest config scope policy', () => {
  it('rejects every globally authored setting of a character-only plugin', () => {
    const plugin = characterOnlyConfigPlugin('scope.character-only');
    const configPath = join(
      createTestTempRoot('project02-config-scope-policy-'),
      'config.json',
    );
    const loadedConfig = Object.freeze({
      source: 'path' as const,
      path: configPath,
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
      } as const,
      diagnostics: Object.freeze([]),
    });
    const resolved = resolveProject02RuntimeConfig({
      runtimeLocation: runtimeLocationForTest({
        loadedConfig,
        env: {CHARACTER_ONLY_API_KEY: 'secret'},
      }),
      loadedConfig,
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
    // Secrets included: a character-only plugin is self-contained, and
    // its credential belongs beside its overlay, not in the home config.
    expect(resolved.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'runtime_config_character_only_plugin_field_globally',
        path: `plugins.${plugin.manifest.id}.config.apiKey`,
      }),
    );
  });

  it('offers a scope only the settings that scope can save', async () => {
    const {homeRoot, dataRoot} = seededHome();
    const characterOnly = characterOnlyConfigPlugin('scope.character-owned');
    const shared = structuredConfigPlugin('scope.shared');

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });

    const base = {
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot, env: {}}),
      env: {},
    };
    const editableFields = (
      inspected: ReturnType<typeof inspectRuntimePluginConfig>,
    ) =>
      inspected.fields
        .filter(field => field.editableInScope)
        .map(field => field.name);
    const globalViewOfCharacterOnly = inspectRuntimePluginConfig({
      ...base,
      targetScope: 'global',
      manifest: characterOnly.manifest,
      pluginManifests: [characterOnly.manifest],
    });
    const characterViewOfShared = inspectRuntimePluginConfig({
      ...base,
      targetScope: 'character',
      manifest: shared.manifest,
      pluginManifests: [shared.manifest],
    });
    const globalTarget = resolveRuntimeConfigScopeTarget({
      runtimeLocation: base.runtimeLocation,
      env: {},
      scope: 'global',
    });

    // A console renders from this shape, so anything it offers must save:
    // a character-only plugin belongs wholly to its character, secrets
    // included, and a shared plugin is now fully character-tunable too.
    expect(editableFields(globalViewOfCharacterOnly)).toEqual([]);
    expect(globalViewOfCharacterOnly.activation.editableInScope).toBe(false);
    expect(editableFields(characterViewOfShared)).toEqual([
      'settings',
      'endpoints',
    ]);
    expect(characterViewOfShared.activation.editableInScope).toBe(true);
    expect(() =>
      applyRuntimeConfigControlOperation({
        pluginManifests: [],
        target: globalTarget,
        request: {
          kind: 'plugin_config',
          manifest: characterOnly.manifest,
          actor: 'operator',
          fieldOperation: {
            kind: 'set',
            fieldName: 'setting',
            value: 'global-nope',
          },
        },
      }),
    ).toThrow('character-only');

    // A document already holding a forbidden value must be repairable:
    // the console offers Unset, and the rule allows exactly that.
    applyRuntimeConfigControlOperation({
      pluginManifests: [],
      target: globalTarget,
      request: {
        kind: 'plugin_config',
        manifest: characterOnly.manifest,
        actor: 'operator',
        fieldOperation: {kind: 'unset', fieldName: 'setting'},
      },
    });
    applyRuntimeConfigControlOperation({
      pluginManifests: [],
      target: globalTarget,
      request: {kind: 'plugin_activation', manifest: characterOnly.manifest},
    });
  });

  it('merges the character env over the shared env for secret refs', async () => {
    const {homeRoot, configPath, dataRoot} = seededHome();

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });
    const plugin = structuredConfigPlugin('scope.layered-secrets');
    const manifest = {
      ...plugin.manifest,
      config: {
        scope: 'global_with_character_overrides' as const,
        fields: [
          ...plugin.manifest.config.fields,
          {
            name: 'apiKey',
            description: 'Account credential.',
            required: false,
            secret: true,
            valueType: 'secret' as const,
            redactionLabels: ['secret'],
          },
        ],
      },
    };

    writeRuntimeConfig(configPath, {
      plugins: {
        'scope.layered-secrets': {
          enabled: true,
          config: {
            settings: {from: 'global'},
            endpoints: ['global'],
            apiKey: {$env: 'LAYERED_KEY'},
          },
        },
      },
    });
    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {
      plugins: {
        'scope.layered-secrets': {config: {apiKey: {$env: 'LAYERED_KEY'}}},
      },
    });
    writeFileSync(
      characterSecretsEnvPath(dataRoot),
      'LAYERED_KEY="character-account"\n',
    );

    const env = {LAYERED_KEY: 'operator-account'};
    const runtimeLocation = runtimeLocationForTest({
      loadedConfig: loadRuntimeConfigForTest({
        configPath,
        storeRoot: homeRoot,
        env,
      }),
      configPath,
      storeRoot: homeRoot,
      env,
    });
    const layered = resolveLayeredProject02RuntimeConfig({
      runtimeLocation,
      loadedConfig: loadRuntimeConfigForTest({
        configPath,
        storeRoot: homeRoot,
        env,
      }),
      overlayConfig: readCharacterOverlayForScope(
        runtimeLocation.characterScope,
      ).overlay,
      pluginManifests: [manifest],
      env,
    });
    const fields = layered.pluginConfigs['scope.layered-secrets'] ?? {};

    // Same variable in both envs: the character's own value wins, the same
    // way a character overlay wins over the global config.
    expect(fields['apiKey']).toMatchObject({
      resolved: true,
      value: 'character-account',
    });

    // When the character's file lacks the value, the shared env fills it --
    // one account for every character until one keeps its own.
    writeFileSync(characterSecretsEnvPath(dataRoot), '');
    const fallthrough = resolveLayeredProject02RuntimeConfig({
      runtimeLocation,
      loadedConfig: loadRuntimeConfigForTest({
        configPath,
        storeRoot: homeRoot,
        env,
      }),
      overlayConfig: readCharacterOverlayForScope(
        runtimeLocation.characterScope,
      ).overlay,
      pluginManifests: [manifest],
      env,
    });

    expect(
      fallthrough.pluginConfigs['scope.layered-secrets']?.['apiKey'],
    ).toMatchObject({resolved: true, value: 'operator-account'});
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
      runtimeLocation: runtimeLocationForTest({
        storeRoot: homeRoot,
        env: {CHARACTER_ONLY_CONTROL_API_KEY: 'secret'},
      }),

      env: {CHARACTER_ONLY_CONTROL_API_KEY: 'secret'},
      scope: 'global',
    });
    const characterTarget = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({
        storeRoot: homeRoot,
        env: {CHARACTER_ONLY_CONTROL_API_KEY: 'secret'},
      }),

      env: {CHARACTER_ONLY_CONTROL_API_KEY: 'secret'},
      scope: 'character',
    });
    const globalBefore = readFileSync(configPath, 'utf8');

    expect(() =>
      applyRuntimeConfigControlOperation({
        pluginManifests: [],
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
        pluginManifests: [],
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
      pluginManifests: [],
      target: characterTarget,
      request: {
        kind: 'plugin_activation',
        manifest: plugin.manifest,
        enabled: true,
      },
    });
    applyRuntimeConfigControlOperation({
      pluginManifests: [],
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
  const loaded = loadRuntimeConfigForTest({storeRoot: homeRoot, env: {}});

  if (loaded.config === undefined) {
    throw new Error('Expected the seeded global config to load.');
  }

  return createLayeredRuntimeConfigFingerprint({
    pluginManifests: [],
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
      runtimeLocation: runtimeLocationForTest({
        storeRoot: homeRoot,
        characterScope: characterScope,
        env: {},
      }),
      targetScope: 'character',
      manifest: plugin.manifest,
      pluginManifests: [plugin.manifest],

      env: {},
    }).fingerprint;
    const overlayPath = characterOverlayConfigPath(dataRoot);
    const globalBefore = readFileSync(configPath, 'utf8');
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({
        storeRoot: homeRoot,
        characterScope,
        env: {},
      }),
      env: {},
      scope: 'character',
    });
    const prepared = capability.prepareOperation({
      target,
      pluginManifests: [],
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
      pluginManifests: [],
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

describe('plugin inspection target authorship', () => {
  it('reports an inherited global field as effective but not authored in the character target', async () => {
    const {homeRoot, configPath, dataRoot} = seededHome();
    const plugin = structuredConfigPlugin('scope.inherited-authorship');

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });
    writeRuntimeConfig(configPath, {
      plugins: {
        'scope.inherited-authorship': {
          enabled: true,
          config: {settings: {from: 'global'}},
        },
      },
    });
    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {});

    const inspected = inspectRuntimePluginConfig({
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot, env: {}}),
      targetScope: 'character',
      manifest: plugin.manifest,
      pluginManifests: [plugin.manifest],
      env: {},
    });
    const settings = inspected.fields.find(field => field.name === 'settings');

    expect(settings).toMatchObject({
      authored: {configured: false},
      effectiveSource: 'global',
      effective: {
        source: 'config',
        resolved: true,
        value: {from: 'global'},
      },
    });
  });

  it('reports each target document without changing effective provenance or the layered fingerprint', async () => {
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
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot, env: {}}),
      manifest: plugin.manifest,
      pluginManifests: [plugin.manifest],
      env: {},
    };

    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: base.runtimeLocation,
      env: {},
      scope: 'character',
    });
    applyRuntimeConfigControlOperation({
      pluginManifests: [],
      target,
      expectedFingerprint: inspectRuntimePluginConfig({
        ...base,
        targetScope: 'character',
      }).fingerprint,
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
    const characterView = inspectRuntimePluginConfig({
      ...base,
      targetScope: 'character',
    });
    const globalView = inspectRuntimePluginConfig({
      ...base,
      targetScope: 'global',
    });
    const authoredSettings = (
      inspected: ReturnType<typeof inspectRuntimePluginConfig>,
    ) => inspected.fields.find(field => field.name === 'settings')?.authored;

    // Each target reports only its own authored rung.
    expect(authoredSettings(characterView)).toMatchObject({
      configured: true,
      value: {from: 'overlay'},
    });
    expect(authoredSettings(globalView)).toMatchObject({
      configured: true,
      value: {from: 'global'},
    });
    expect(
      characterView.fields.find(field => field.name === 'settings'),
    ).toMatchObject({
      effectiveSource: 'character',
      effective: {value: {from: 'overlay'}},
    });
    expect(
      globalView.fields.find(field => field.name === 'settings'),
    ).toMatchObject({
      effectiveSource: 'character',
      effective: {value: {from: 'overlay'}},
    });
    expect(globalView.fingerprint).toBe(characterView.fingerprint);
    expect(existsSync(characterOverlayConfigPath(dataRoot))).toBe(true);
  });
});

describe('scoped writes over a broken global layer', () => {
  it('rejects the mutation instead of merging against a synthetic global document', () => {
    const homeRoot = createTestTempRoot('project02-scope-invalid-global-');

    writeFileSync(join(homeRoot, 'config.json'), '{not json\n');

    expect(() => {
      const target = resolveRuntimeConfigScopeTarget({
        runtimeLocation: runtimeLocationForTest({
          storeRoot: homeRoot,
          characterId: 'mira',
          env: {},
        }),

        env: {},
        scope: 'character',
      });
      applyRuntimeConfigControlOperation({
        pluginManifests: [],
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

describe('stale global expectations', () => {
  it('conflicts without materializing a lock root in an absent data dir', () => {
    const {homeRoot, dataRoot} = seededHome();
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot, env: {}}),

      env: {},
      scope: 'global',
    });

    expect(() =>
      applyRuntimeConfigControlOperation({
        pluginManifests: [],
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
    // Not even the per-character lock root.
    expect(existsSync(dataRoot)).toBe(false);
  });
});
