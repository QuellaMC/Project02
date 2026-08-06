import {existsSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {
  applyRuntimeConfigControlOperation,
  createLayeredRuntimeConfigFingerprint,
  defaultRuntimeConfigPath,
  prepareRuntimeConfigControlOperation,
  RuntimeConfigConflictError,
  runtimeConfigEnvVarName,
  runtimeConfigVersion,
  type Project02RuntimeConfig,
  type RuntimePluginConfigFieldInspectShape,
  type RuntimePluginConfigInspectShape,
  inspectRuntimePluginConfig,
  resolveRuntimeConfigScopeTarget,
} from '../../src/runtime/config/index.ts';
import {
  createRuntimePlugin,
  type RuntimePluginManifest,
} from '../../src/plugins/index.ts';
import {ensureCharacterDataMarker} from '../../src/runtime/storage/index.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {
  writeRuntimeConfig,
  runtimeLocationForTest,
} from '../support/runtime-config.ts';
import {requiredSecretPlugin} from '../support/runtime-config-fixtures.ts';

const fixturePluginId = 'config.control.fixture';
const fixtureSecretEnvVar = 'PROJECT02_FIXTURE_API_KEY';

describe('runtime plugin config control', () => {
  it('resolves one coherent control target from one selected config snapshot', () => {
    const firstRoot = createTestTempRoot('project02-control-target-first-');
    const secondRoot = createTestTempRoot('project02-control-target-second-');
    const firstConfigPath = writeRuntimeConfig(join(firstRoot, 'config.json'), {
      project02: {storeRoot: firstRoot},
    });
    const secondConfigPath = writeRuntimeConfig(
      join(secondRoot, 'config.json'),
      {project02: {storeRoot: secondRoot}},
    );
    const env: NodeJS.ProcessEnv = {};
    let selectionReads = 0;

    Object.defineProperty(env, runtimeConfigEnvVarName, {
      enumerable: true,
      get: () => {
        selectionReads += 1;
        return selectionReads === 1 ? firstConfigPath : secondConfigPath;
      },
    });

    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({env: env}),
      env,
      scope: 'global',
    });

    expect(selectionReads).toBe(1);
    expect(target).toMatchObject({
      scope: 'global',
      configPath: firstConfigPath,
      canonicalConfigPath: realpathSync.native(firstConfigPath),
      runtimeLocation: {
        selectedConfig: {
          path: firstConfigPath,
          canonicalPath: realpathSync.native(firstConfigPath),
        },
        homeRoot: realpathSync.native(firstRoot),
      },
    });
  });

  it('inspects declared metadata with redacted authored and effective values plus an authored fingerprint', () => {
    const root = createTestTempRoot('project02-plugin-config-inspect-');
    const configPath = join(root, 'config.json');
    const manifest = configControlManifest();
    const authoredConfig: Project02RuntimeConfig = {
      version: runtimeConfigVersion,
      project02: {storeRoot: root},
      plugins: {
        [fixturePluginId]: {
          enabled: true,
          config: {
            mode: 'remote',
            label: 'primary',
            apiKey: {$env: fixtureSecretEnvVar},
          },
        },
      },
    };

    writeRuntimeConfig(configPath, {
      project02: authoredConfig.project02,
      plugins: authoredConfig.plugins,
    });

    const inspected = inspectRuntimePluginConfig({
      targetScope: 'global',
      runtimeLocation: runtimeLocationForTest({
        configPath: configPath,
        storeRoot: root,
        env: {[fixtureSecretEnvVar]: 'resolved-secret-value'},
      }),

      env: {[fixtureSecretEnvVar]: 'resolved-secret-value'},
      manifest,
    });
    const inspectedWithChangedSecret = inspectRuntimePluginConfig({
      targetScope: 'global',
      runtimeLocation: runtimeLocationForTest({
        configPath: configPath,
        storeRoot: root,
        env: {[fixtureSecretEnvVar]: 'changed-secret-value'},
      }),

      env: {[fixtureSecretEnvVar]: 'changed-secret-value'},
      manifest,
    });

    expect(inspected).toMatchObject({
      pluginId: fixturePluginId,
      displayName: 'Config Control Fixture',
      version: '1.0.0',
      enabled: true,
      activation: {
        enabled: true,
        status: 'active',
      },
      diagnostics: [],
    });
    expect(inspectField(inspected, 'mode')).toEqual({
      name: 'mode',
      description: 'Backend mode.',
      required: true,
      secret: false,
      valueType: 'enum',
      defaultValueSummary: 'local',
      allowedValues: ['local', 'remote'],
      agentMutable: true,
      reloadRequired: true,
      authored: {
        configured: true,
        value: 'remote',
      },
      effectiveSource: 'global',
      effective: {
        name: 'mode',
        secret: false,
        source: 'config',
        resolved: true,
        value: 'remote',
      },
    });
    expect(inspectField(inspected, 'apiKey')).toEqual({
      name: 'apiKey',
      description: 'API key.',
      required: false,
      secret: true,
      valueType: 'secret',
      agentMutable: false,
      reloadRequired: true,
      authored: {
        configured: true,
        value: '[redacted]',
      },
      effectiveSource: 'global',
      effective: {
        name: 'apiKey',
        secret: true,
        source: `env:${fixtureSecretEnvVar}`,
        resolved: true,
        value: '[redacted]',
      },
    });
    expect(inspected.fingerprint).toBe(
      createLayeredRuntimeConfigFingerprint({
        globalConfig: authoredConfig,
        characterId: 'mira',
        overlayConfig: null,
      }),
    );
    expect(inspectedWithChangedSecret.fingerprint).toBe(inspected.fingerprint);
    expect(
      JSON.stringify([inspected, inspectedWithChangedSecret]),
    ).not.toContain('resolved-secret-value');
    expect(
      JSON.stringify([inspected, inspectedWithChangedSecret]),
    ).not.toContain('changed-secret-value');
  });

  it('includes global authored-config diagnostics in plugin inspection', () => {
    const root = createTestTempRoot(
      'project02-plugin-config-global-diagnostic-',
    );
    const configPath = join(root, 'config.json');

    writeFileSync(
      configPath,
      `${JSON.stringify({version: 'project02.config.unsupported'})}\n`,
      'utf8',
    );

    const inspected = inspectRuntimePluginConfig({
      targetScope: 'global',
      runtimeLocation: runtimeLocationForTest({
        configPath: configPath,
        env: {},
      }),

      env: {},
      manifest: configControlManifest(),
    });

    expect(inspected.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'global',
          severity: 'error',
          code: 'runtime_config_version_unsupported',
          path: 'version',
        }),
      ]),
    );
    expect(inspected.activation).toMatchObject({
      enabled: false,
      status: 'blocked',
    });
    expect(inspected.activation.reasons).toContain(
      'runtime_config_error:runtime_config_version_unsupported',
    );
  });

  it('lets an agent exactly set and unset an agent-mutable field', () => {
    const fixture = createSeededControlFixture();
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({
        configPath: fixture.configPath,
        env: {},
      }),

      env: {},
      scope: 'global',
    });

    const setResult = applyRuntimeConfigControlOperation({
      target,
      expectedFingerprint: fixture.fingerprint,
      request: {
        kind: 'plugin_config',
        manifest: fixture.manifest,
        actor: 'agent',
        fieldOperation: {
          kind: 'set',
          fieldName: 'label',
          value: 'after',
        },
      },
    });
    const expectedAfterSet: Project02RuntimeConfig = {
      version: runtimeConfigVersion,
      ...(fixture.config.project02 === undefined
        ? {}
        : {project02: fixture.config.project02}),
      plugins: {
        [fixturePluginId]: {
          enabled: true,
          config: {
            mode: 'local',
            label: 'after',
          },
        },
        'untouched.plugin': {
          enabled: false,
          config: {
            keep: 'value',
          },
        },
      },
    };

    expect(setResult.config).toEqual(expectedAfterSet);
    expect(readConfigFile(fixture.configPath)).toEqual(expectedAfterSet);

    const unsetResult = applyRuntimeConfigControlOperation({
      target,
      expectedFingerprint: setResult.fingerprint,
      request: {
        kind: 'plugin_config',
        manifest: fixture.manifest,
        actor: 'agent',
        fieldOperation: {
          kind: 'unset',
          fieldName: 'label',
        },
      },
    });
    const expectedAfterUnset: Project02RuntimeConfig = {
      version: runtimeConfigVersion,
      ...(fixture.config.project02 === undefined
        ? {}
        : {project02: fixture.config.project02}),
      plugins: {
        [fixturePluginId]: {
          enabled: true,
          config: {
            mode: 'local',
          },
        },
        'untouched.plugin': {
          enabled: false,
          config: {
            keep: 'value',
          },
        },
      },
    };

    expect(unsetResult.config).toEqual(expectedAfterUnset);
    expect(readConfigFile(fixture.configPath)).toEqual(expectedAfterUnset);
  });

  it('rejects fields not declared by the target plugin', () => {
    const fixture = createSeededControlFixture();
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({
        configPath: fixture.configPath,
        env: {},
      }),

      env: {},
      scope: 'global',
    });

    expect(() =>
      applyRuntimeConfigControlOperation({
        target,
        expectedFingerprint: fixture.fingerprint,
        request: {
          kind: 'plugin_config',
          manifest: fixture.manifest,
          actor: 'agent',
          fieldOperation: {
            kind: 'set',
            fieldName: 'unknownField',
            value: 'ignored',
          },
        },
      }),
    ).toThrow(
      `Plugin "${fixturePluginId}" does not declare config field "unknownField". ` +
        'Declared fields: mode, label, operatorOnly, retries, settings, apiKey.',
    );
    expect(readConfigFile(fixture.configPath)).toEqual(fixture.config);
  });

  it('rejects unsetting a required field', () => {
    const fixture = createSeededControlFixture();
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({
        configPath: fixture.configPath,
        env: {},
      }),

      env: {},
      scope: 'global',
    });

    expect(() =>
      applyRuntimeConfigControlOperation({
        target,
        expectedFingerprint: fixture.fingerprint,
        request: {
          kind: 'plugin_config',
          manifest: fixture.manifest,
          actor: 'agent',
          fieldOperation: {
            kind: 'unset',
            fieldName: 'mode',
          },
        },
      }),
    ).toThrow('Required plugin config field "mode" cannot be unset.');
    expect(readConfigFile(fixture.configPath)).toEqual(fixture.config);
  });

  it('rejects agent mutation when the field is not agent-mutable', () => {
    const fixture = createSeededControlFixture();
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({
        configPath: fixture.configPath,
        env: {},
      }),

      env: {},
      scope: 'global',
    });

    expect(() =>
      applyRuntimeConfigControlOperation({
        target,
        expectedFingerprint: fixture.fingerprint,
        request: {
          kind: 'plugin_config',
          manifest: fixture.manifest,
          actor: 'agent',
          fieldOperation: {
            kind: 'set',
            fieldName: 'operatorOnly',
            value: true,
          },
        },
      }),
    ).toThrow(
      'Plugin config field "operatorOnly" does not allow agent mutation.',
    );
    expect(readConfigFile(fixture.configPath)).toEqual(fixture.config);
  });

  it('rejects secret field mutation even when the value is only an env reference', () => {
    const fixture = createSeededControlFixture();
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({
        configPath: fixture.configPath,
        env: {},
      }),

      env: {},
      scope: 'global',
    });

    expect(() =>
      applyRuntimeConfigControlOperation({
        target,
        expectedFingerprint: fixture.fingerprint,
        request: {
          kind: 'plugin_config',
          manifest: fixture.manifest,
          actor: 'agent',
          fieldOperation: {
            kind: 'set',
            fieldName: 'apiKey',
            value: {$env: 'ATTACKER_SELECTED_SECRET'},
          },
        },
      }),
    ).toThrow(
      'Plugin config field "apiKey" is secret and must be managed through the dedicated secret command.',
    );
    expect(readConfigFile(fixture.configPath)).toEqual(fixture.config);
  });

  it('rejects values with the wrong type or outside declared allowed values', () => {
    const fixture = createSeededControlFixture();
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({
        configPath: fixture.configPath,
        env: {},
      }),

      env: {},
      scope: 'global',
    });

    for (const [operation, message] of [
      [
        {
          kind: 'set',
          fieldName: 'retries',
          value: 'three',
        },
        'Plugin config field "retries" must be a finite number; received a string.',
      ],
      [
        {
          kind: 'set',
          fieldName: 'mode',
          value: 'unsupported',
        },
        'Plugin config field "mode" must be one of: local, remote; received a string that is not an allowed value.',
      ],
      [
        {
          kind: 'set',
          fieldName: 'retries',
          value: Number.NaN,
        },
        'Plugin config field "retries" must be a finite number; received a number.',
      ],
    ] as const) {
      expect(() =>
        applyRuntimeConfigControlOperation({
          target,
          expectedFingerprint: fixture.fingerprint,
          request: {
            kind: 'plugin_config',
            manifest: fixture.manifest,
            actor: 'agent',
            fieldOperation: operation,
          },
        }),
      ).toThrow(message);
    }

    expect(readConfigFile(fixture.configPath)).toEqual(fixture.config);
  });

  it('rejects nested env references in non-secret structured fields', () => {
    const fixture = createSeededControlFixture();
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({
        configPath: fixture.configPath,
        env: {},
      }),

      env: {},
      scope: 'global',
    });

    expect(() =>
      applyRuntimeConfigControlOperation({
        target,
        expectedFingerprint: fixture.fingerprint,
        request: {
          kind: 'plugin_config',
          manifest: fixture.manifest,
          actor: 'agent',
          fieldOperation: {
            kind: 'set',
            fieldName: 'settings',
            value: {
              authentication: {
                token: {$env: 'NESTED_SECRET'},
              },
            },
          },
        },
      }),
    ).toThrow(
      'Plugin config field "settings" value must not embed secret references; secrets are managed through the dedicated secret command.',
    );
    expect(readConfigFile(fixture.configPath)).toEqual(fixture.config);
  });

  it('rejects credential-shaped values that would be hidden in the approval preview', () => {
    const fixture = createSeededControlFixture();
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({
        configPath: fixture.configPath,
        env: {},
      }),

      env: {},
      scope: 'global',
    });

    expect(() =>
      applyRuntimeConfigControlOperation({
        target,
        expectedFingerprint: fixture.fingerprint,
        request: {
          kind: 'plugin_config',
          manifest: fixture.manifest,
          actor: 'agent',
          fieldOperation: {
            kind: 'set',
            fieldName: 'settings',
            value: {
              authentication: {
                token: 'agent-chosen-secret',
              },
            },
          },
        },
      }),
    ).toThrow(
      'Plugin config field "settings" value contains content that must stay redacted and cannot be written.',
    );
    expect(readConfigFile(fixture.configPath)).toEqual(fixture.config);
  });

  it('revalidates the complete target plugin config before committing', () => {
    const fixture = createSeededControlFixture();
    const invalidConfig: Project02RuntimeConfig = {
      ...fixture.config,
      plugins: {
        ...fixture.config.plugins,
        [fixturePluginId]: {
          enabled: true,
          config: {
            mode: 'local',
            label: 'before',
            undeclaredSibling: 'must-block-the-write',
          },
        },
      },
    };

    writeRuntimeConfig(fixture.configPath, {
      project02: invalidConfig.project02,
      plugins: invalidConfig.plugins,
    });
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({
        configPath: fixture.configPath,
        env: {},
      }),

      env: {},
      scope: 'global',
    });

    expect(() =>
      applyRuntimeConfigControlOperation({
        target,
        expectedFingerprint: createLayeredRuntimeConfigFingerprint({
          globalConfig: invalidConfig,
          characterId: 'mira',
          overlayConfig: null,
        }),
        request: {
          kind: 'plugin_config',
          manifest: fixture.manifest,
          actor: 'agent',
          fieldOperation: {
            kind: 'set',
            fieldName: 'label',
            value: 'after',
          },
        },
      }),
    ).toThrow(
      'Cannot update plugin config because the resulting config is invalid: Unknown config field "undeclaredSibling"',
    );
    expect(readConfigFile(fixture.configPath)).toEqual(invalidConfig);
  });

  it('refuses to inspect through a data directory rebound to another character', async () => {
    const homeRoot = createTestTempRoot('project02-plugin-inspect-rebind-');
    const dataRoot = join(homeRoot, 'character-data', 'mira');
    const plugin = requiredSecretPlugin('operator.rebind-inspect');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });

    const before = inspectRuntimePluginConfig({
      targetScope: 'global',
      runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot, env: {}}),

      env: {},
      manifest: plugin.manifest,
    });

    expect(before.pluginId).toBe('operator.rebind-inspect');

    // Rebound after the fact: model-visible config must not come from
    // a store the runtime would refuse.
    writeFileSync(
      join(dataRoot, 'schema.json'),
      `${JSON.stringify({
        schemaVersion: 7,
        scope: 'character-data',
        characterId: 'nova',
        createdAt: '2026-07-23T00:00:00.000Z',
      })}\n`,
    );

    expect(() =>
      inspectRuntimePluginConfig({
        targetScope: 'global',
        runtimeLocation: runtimeLocationForTest({storeRoot: homeRoot, env: {}}),

        env: {},
        manifest: plugin.manifest,
      }),
    ).toThrow('holds history for character "nova"');
  });

  it('rejects a direct overlay selection before secret control', async () => {
    const homeRoot = createTestTempRoot('project02-plugin-overlay-secret-');
    const dataRoot = join(homeRoot, 'character-data', 'mira');
    const overlayPath = join(dataRoot, 'config.json');

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });

    const env = {OVERLAY_SECRET_VAR: 'overlay-secret-value'};
    expect(() =>
      resolveRuntimeConfigScopeTarget({
        runtimeLocation: runtimeLocationForTest({
          configPath: overlayPath,
          env: env,
        }),

        env,
        scope: 'character',
      }),
    ).toThrow('is inside a character-data directory');
    expect(existsSync(overlayPath)).toBe(false);
    expect(existsSync(join(homeRoot, '.env'))).toBe(false);
    expect(existsSync(join(dataRoot, '.env'))).toBe(false);
  });

  it('rejects a mutation bound to a stale authored fingerprint', () => {
    const fixture = createSeededControlFixture();
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({
        configPath: fixture.configPath,
        env: {},
      }),

      env: {},
      scope: 'global',
    });
    const committed = applyRuntimeConfigControlOperation({
      target,
      expectedFingerprint: fixture.fingerprint,
      request: {
        kind: 'plugin_config',
        manifest: fixture.manifest,
        actor: 'agent',
        fieldOperation: {
          kind: 'set',
          fieldName: 'label',
          value: 'committed',
        },
      },
    });

    expect(() =>
      applyRuntimeConfigControlOperation({
        target,
        expectedFingerprint: fixture.fingerprint,
        request: {
          kind: 'plugin_config',
          manifest: fixture.manifest,
          actor: 'agent',
          fieldOperation: {
            kind: 'set',
            fieldName: 'label',
            value: 'stale-write',
          },
        },
      }),
    ).toThrow(RuntimeConfigConflictError);
    expect(readConfigFile(fixture.configPath)).toEqual(committed.config);
  });

  it('prepares the committed fingerprint without writing config', () => {
    const fixture = createSeededControlFixture();
    const originalConfigText = readFileSync(fixture.configPath, 'utf8');
    const expectedConfig: Project02RuntimeConfig = {
      ...fixture.config,
      plugins: {
        ...fixture.config.plugins,
        [fixturePluginId]: {
          ...fixture.config.plugins?.[fixturePluginId],
          config: {
            ...fixture.config.plugins?.[fixturePluginId]?.config,
            label: 'prepared',
          },
        },
      },
    };
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({
        configPath: fixture.configPath,
        env: {},
      }),

      env: {},
      scope: 'global',
    });
    const options = {
      target,
      expectedFingerprint: fixture.fingerprint,
      request: {
        kind: 'plugin_config' as const,
        manifest: fixture.manifest,
        actor: 'agent' as const,
        fieldOperation: {
          kind: 'set' as const,
          fieldName: 'label',
          value: 'prepared',
        },
      },
    };

    const prepared = prepareRuntimeConfigControlOperation(options);

    expect(prepared.resultFingerprint).toBe(
      createLayeredRuntimeConfigFingerprint({
        globalConfig: expectedConfig,
        characterId: 'mira',
        overlayConfig: null,
      }),
    );
    expect(readFileSync(fixture.configPath, 'utf8')).toBe(originalConfigText);

    const committed = applyRuntimeConfigControlOperation(options);

    expect(committed.fingerprint).toBe(prepared.resultFingerprint);
    expect(committed.config).toEqual(expectedConfig);
  });

  it('bootstraps a missing config through the same inspected fingerprint', () => {
    const storeRoot = createTestTempRoot('project02-plugin-config-bootstrap-');
    const canonicalStoreRoot = realpathSync.native(storeRoot);
    const configPath = defaultRuntimeConfigPath(storeRoot);
    const manifest = configControlManifest();
    const inspected = inspectRuntimePluginConfig({
      targetScope: 'global',
      runtimeLocation: runtimeLocationForTest({storeRoot: storeRoot, env: {}}),

      env: {},
      manifest,
    });
    const bootstrapBase: Project02RuntimeConfig = {
      version: runtimeConfigVersion,
      project02: {
        storeRoot: canonicalStoreRoot,
      },
    };

    expect(existsSync(configPath)).toBe(false);
    expect(inspected.fingerprint).toBe(
      createLayeredRuntimeConfigFingerprint({
        globalConfig: bootstrapBase,
        characterId: 'mira',
        overlayConfig: null,
      }),
    );

    const result = applyRuntimeConfigControlOperation({
      target: resolveRuntimeConfigScopeTarget({
        runtimeLocation: runtimeLocationForTest({
          storeRoot: storeRoot,
          env: {},
        }),

        env: {},
        scope: 'global',
      }),
      expectedFingerprint: inspected.fingerprint,
      request: {
        kind: 'plugin_config',
        manifest,
        actor: 'agent',
        fieldOperation: {
          kind: 'set',
          fieldName: 'mode',
          value: 'local',
        },
      },
    });
    const expectedConfig: Project02RuntimeConfig = {
      ...bootstrapBase,
      plugins: {
        [fixturePluginId]: {
          config: {
            mode: 'local',
          },
        },
      },
    };

    expect(result.config).toEqual(expectedConfig);
    expect(readConfigFile(configPath)).toEqual(expectedConfig);
  });
});

function configControlManifest(
  id: string = fixturePluginId,
): RuntimePluginManifest {
  const base = requiredSecretPlugin(id);

  return createRuntimePlugin({
    manifest: {
      ...base.manifest,
      displayName: 'Config Control Fixture',
      description: 'Schema-aware config control fixture.',
      config: {
        scope: 'global_with_character_overrides',
        fields: [
          {
            name: 'mode',
            description: 'Backend mode.',
            required: true,
            secret: false,
            valueType: 'enum',
            defaultValueSummary: 'local',
            allowedValues: ['local', 'remote'],
            agentMutable: true,
            reloadRequired: true,
            redactionLabels: [],
          },
          {
            name: 'label',
            description: 'Operator label.',
            required: false,
            secret: false,
            valueType: 'string',
            agentMutable: true,
            redactionLabels: [],
          },
          {
            name: 'operatorOnly',
            description: 'Operator-only switch.',
            required: false,
            secret: false,
            valueType: 'boolean',
            agentMutable: false,
            redactionLabels: [],
          },
          {
            name: 'retries',
            description: 'Retry count.',
            required: false,
            secret: false,
            valueType: 'number',
            agentMutable: true,
            redactionLabels: [],
          },
          {
            name: 'settings',
            description: 'Structured settings.',
            required: false,
            secret: false,
            valueType: 'object',
            agentMutable: true,
            redactionLabels: [],
          },
          {
            name: 'apiKey',
            description: 'API key.',
            required: false,
            secret: true,
            valueType: 'secret',
            envVar: fixtureSecretEnvVar,
            redactionLabels: ['secret'],
          },
        ],
      },
    },
  }).manifest;
}

function inspectField(
  inspected: RuntimePluginConfigInspectShape,
  fieldName: string,
): RuntimePluginConfigFieldInspectShape {
  const field = inspected.fields.find(
    candidate => candidate.name === fieldName,
  );

  if (field === undefined) {
    throw new Error(`Expected inspect output to include field ${fieldName}.`);
  }

  return field;
}

function createSeededControlFixture(): {
  readonly configPath: string;
  readonly config: Project02RuntimeConfig;
  readonly manifest: RuntimePluginManifest;
  readonly fingerprint: string;
} {
  const root = createTestTempRoot('project02-plugin-config-control-');
  const configPath = join(root, 'config.json');
  const manifest = configControlManifest();
  const config: Project02RuntimeConfig = {
    version: runtimeConfigVersion,
    project02: {storeRoot: root},
    plugins: {
      [fixturePluginId]: {
        enabled: true,
        config: {
          mode: 'local',
          label: 'before',
        },
      },
      'untouched.plugin': {
        enabled: false,
        config: {
          keep: 'value',
        },
      },
    },
  };

  writeRuntimeConfig(configPath, {
    project02: config.project02,
    plugins: config.plugins,
  });

  return {
    configPath,
    config,
    manifest,
    fingerprint: inspectRuntimePluginConfig({
      targetScope: 'global',
      runtimeLocation: runtimeLocationForTest({
        configPath: configPath,
        env: {},
      }),

      env: {},
      manifest,
    }).fingerprint,
  };
}

function readConfigFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}
