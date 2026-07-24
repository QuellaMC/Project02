import {testCharacterProfile} from '../support/character-fixtures.ts';
import {existsSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {createTestTempRoot} from '../support/temp-root.ts';
import {runRuntimeConfigCliFromArgs} from '../../src/cli/config/main.ts';
import {
  createConversationSession,
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
} from '../../src/core/index.ts';
import {
  createConfiguredProject02PluginHostFromPlan,
  initializeProject02CharacterRuntime,
  prepareConfiguredProject02PluginActivation,
} from '../../src/app/index.ts';
import {loadProject02RuntimeConfig} from '../../src/runtime/config/index.ts';
import {
  createMemoryProviderRuntimePlugin,
  firstPartyModelToolsPluginId,
  runtimePluginId,
  runtimePluginListToolName,
} from '../../src/plugins/index.ts';
import {
  characterStatePluginId,
  createCharacterStatePlugin,
  createCharacterStatePluginManifest,
} from '../../src/plugins/packages/character-state/plugin.ts';
import {runLocalUserMessageEvent} from '../../src/runtime/turn/local.ts';
import {createRuntimeLogStore} from '../../src/runtime/evidence/index.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {collect} from '../support/streams.ts';
import {
  fileStoreSessionEndPlugin,
  firstPartyPlugin,
  parseActivationOutput,
  requiredSecretAndEndpointPlugin,
  requiredSecretPlugin,
} from '../support/runtime-config-activation-fixtures.ts';
import {initializeCharacterDataForHost} from '../support/runtime-config-fixtures.ts';
import {
  pluginDiscoveryPluginSummaries,
  testIdentity,
  testPluginContext,
} from '../support/plugin-host-fixtures.ts';
import {runtimePluginAccessSnapshot} from '../../src/plugins/policy/access-control.ts';

describe('runtime config activation planning', () => {
  it('constructs the configured host from the exact prepared activation plan', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-prepared-activation-',
    );

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    await initializeCharacterDataForHost(storeRoot);

    const activationPlan = prepareConfiguredProject02PluginActivation({
      loadedConfig: loadProject02RuntimeConfig({storeRoot}),
    });
    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan,
    });

    expect(configured.resolvedConfig).toBe(activationPlan.resolvedConfig);
    expect(configured.activation).toBe(activationPlan.activation);
    expect(activationPlan.pluginConfigControl.activationByPluginId).toEqual(
      Object.fromEntries(
        activationPlan.activation.plugins.map(plugin => [
          plugin.pluginId,
          {
            enabled: plugin.enabled,
            status: plugin.activationStatus,
            reasons: plugin.activationReasons,
          },
        ]),
      ),
    );
    expect(configured.host.enabledPluginIds()).toEqual(
      activationPlan.activation.enabledPluginIds,
    );
  });

  it('refuses direct host construction on an uninitialized character home', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-host-uninitialized-',
    );

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    // Host construction is downstream of character initialization: it
    // must refuse — not silently create — uninitialized character
    // state, which previously produced a host with no package defaults
    // and no diagnostics.
    await expect(
      createConfiguredProject02PluginHostFromPlan({
        activationPlan: prepareConfiguredProject02PluginActivation({
          loadedConfig: loadProject02RuntimeConfig({storeRoot}),
        }),
      }),
    ).rejects.toThrow('is not initialized in this home');
    expect(existsSync(join(storeRoot, 'character-data', 'mira'))).toBe(false);
  });

  it('matches shared-startup activation when constructing after the initializer', async () => {
    const storeRoot = createTestTempRoot('project02-config-host-parity-');

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    const initialized = await initializeProject02CharacterRuntime({
      location: {storeRoot},
      env: {},
    });
    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: initialized.activationPlan,
    });

    // The initializer materialized the character package: the direct
    // host now carries the same package-authored enablement the CLI
    // startup produces, instead of a divergent manifest-defaults-only
    // plugin system.
    expect(configured.activation.enabledPluginIds).toEqual([
      runtimePluginId,
      firstPartyModelToolsPluginId,
      characterStatePluginId,
    ]);
    expect(configured.activation.enabledPluginIds).toEqual(
      configured.host.enabledPluginIds(),
    );
    expect(
      existsSync(join(storeRoot, 'character-data', 'mira', 'config.json')),
    ).toBe(true);
    expect(configured.host.pluginToolDefinitions()).toContainEqual(
      expect.objectContaining({
        pluginId: runtimePluginId,
        name: runtimePluginListToolName,
      }),
    );
  });

  it('keeps check access inventory aligned with host-injected discovery', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-check-host-discovery-',
    );
    let stdout = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories: {},
      },
    );
    const output = parseActivationOutput(stdout);
    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        loadedConfig: loadProject02RuntimeConfig({storeRoot}),
        factories: {},
      }),
    });
    const checkDiscovery = output.plugins.find(
      plugin => plugin.pluginId === runtimePluginId,
    );
    const hostDiscovery = configured.host
      .registrySnapshot()
      .plugins.find(plugin => plugin.manifest.id === runtimePluginId);

    expect(exitCode).toBe(0);
    expect(checkDiscovery).toMatchObject({
      pluginId: runtimePluginId,
      enabled: true,
      activationStatus: 'active',
      requestedAccess: {model_input: 'write'},
      grantedAccess: {model_input: 'write'},
    });
    expect(hostDiscovery).toMatchObject({
      requestedAccess: checkDiscovery?.requestedAccess,
      grantedAccess: checkDiscovery?.grantedAccess,
    });
    expect(configured.host.pluginToolDefinitions()).toContainEqual(
      expect.objectContaining({
        pluginId: runtimePluginId,
        name: runtimePluginListToolName,
      }),
    );
  });

  it('keeps an explicit host-scoped disable aligned with host state', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-host-disable-aligned-',
    );

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [runtimePluginId]: {
          enabled: false,
        },
      },
    });

    await initializeCharacterDataForHost(storeRoot);

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        loadedConfig: loadProject02RuntimeConfig({storeRoot}),
      }),
      toolConfirmationHandler: () => ({status: 'approved'}),
    });

    expect(configured.activation.enabledPluginIds).toEqual(
      configured.host.enabledPluginIds(),
    );
    expect(configured.activation.enabledPluginIds).not.toContain(
      runtimePluginId,
    );
    expect(
      configured.host
        .pluginToolDefinitions()
        .filter(definition => definition.pluginId === runtimePluginId),
    ).toEqual([]);
  });

  it('keeps inventory available for cold blocked-plugin discovery when config is invalid', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-invalid-inventory-recovery-',
    );
    const plugin = requiredSecretAndEndpointPlugin('memory.blocked-config');
    const envVar = 'PROJECT02_BLOCKED_CONFIG_SECRET_3452542101';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {
            apiKey: {$env: envVar},
          },
        },
      },
    });

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        loadedConfig: loadProject02RuntimeConfig({storeRoot}),
        env: {
          [envVar]: 'blocked-config-secret',
        },
        factories: {
          [plugin.manifest.id]: {
            manifest: plugin.manifest,
            create() {
              factoryCalls += 1;
              return plugin;
            },
          },
        },
      }),
      toolConfirmationHandler: () => ({status: 'approved'}),
    });
    const inventoryResult = await configured.host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginId,
        toolName: runtimePluginListToolName,
        input: {scope: 'all'},
      },
      testPluginContext(),
    );

    expect(configured.activation.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'runtime_config_required_value_missing',
        pluginId: plugin.manifest.id,
      }),
    );
    expect(configured.activation.enabledPluginIds).toEqual([runtimePluginId]);
    expect(configured.host.pluginToolDefinitions()).toEqual([
      expect.objectContaining({
        pluginId: runtimePluginId,
        name: runtimePluginListToolName,
      }),
    ]);
    expect(factoryCalls).toBe(0);
    expect(inventoryResult.status).toBe('accepted');
    if (inventoryResult.status !== 'accepted') {
      throw new Error('Expected recovery inventory to be accepted.');
    }
    expect(
      pluginDiscoveryPluginSummaries(inventoryResult.output).find(
        summary => summary['id'] === plugin.manifest.id,
      ),
    ).toMatchObject({
      id: plugin.manifest.id,
      enabled: false,
      availableForTurn: false,
      activationStatus: 'blocked',
      providedTools: [],
    });
  });

  it('keeps character-agent output non-committed when config disables visible_reply', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-model-tools-disabled-runtime-',
    );
    const sessionId = 'session-model-tools-disabled-runtime';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [firstPartyModelToolsPluginId]: {
          enabled: false,
        },
      },
    });

    await initializeCharacterDataForHost(storeRoot);

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        loadedConfig: loadProject02RuntimeConfig({storeRoot}),
        storeRoot,
      }),
      sessionId,
    });
    const logStore = createRuntimeLogStore();
    const result = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'hello',
        createRuntimeEventIdentity({
          eventId: 'evt_model_tools_disabled_runtime',
          traceId: 'trace_model_tools_disabled_runtime',
          createdAt: '2026-06-15T00:00:00.000Z',
        }),
      ),
      session: createConversationSession({
        id: sessionId,
        character: testCharacterProfile,
      }),
      logStore,
      pluginHost: configured.host,
      agent: {
        reply() {
          return {
            text: 'Character agent reply.',
          };
        },
      },
    });

    expect(configured.activation.enabledPluginIds).not.toContain(
      firstPartyModelToolsPluginId,
    );
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      throw new Error('Expected the disabled visible-reply turn to complete.');
    }

    expect(
      result.rawEvent.roleModelIOSnapshot?.inputEnvelope.allowedTools,
    ).not.toContain('visible_reply');
    expect(
      result.rawEvent.parsedRoleModelDecisionSnapshot?.result,
    ).toMatchObject({
      status: 'accepted',
      nonCommittedText: 'Character agent reply.',
      decision: {
        toolCalls: [],
      },
    });
    expect(result).not.toHaveProperty('turn');
    expect(result.conversationMessages).toEqual([]);
    expect(logStore.conversationMessages()).toEqual([]);
  });

  it('loads runtime env before reporting mixed check activation diagnostics', async () => {
    const storeRoot = createTestTempRoot('project02-config-check-mixed-env-');
    const plugin = requiredSecretAndEndpointPlugin('memory.mixed-check');
    const envVar = 'PROJECT02_CHECK_MIXED_SECRET_3452532128';
    let stdout = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {
            apiKey: {$env: envVar},
          },
        },
      },
    });
    writeFileSync(join(storeRoot, '.env'), `${envVar}=check-secret\n`, 'utf8');

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories: {
          [plugin.manifest.id]: {
            manifest: plugin.manifest,
            create() {
              throw new Error(
                'runtime-config check must not construct invalid plugins',
              );
            },
          },
        },
      },
    );
    const output = parseActivationOutput(stdout);

    expect(exitCode).toBe(1);
    expect(output.activationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_required_value_missing',
          path: `plugins.${plugin.manifest.id}.config.endpoint`,
          pluginId: plugin.manifest.id,
        }),
      ]),
    );
    expect(output.activationDiagnostics.map(item => item.code)).not.toContain(
      'runtime_config_required_secret_missing',
    );
  });

  it('ignores explicitly disabled unknown plugin wrappers during strict activation', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-disabled-unknown-strict-',
    );
    const plugin = firstPartyPlugin('valid.runtime');

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        old: {
          enabled: false,
        },
        [plugin.manifest.id]: {
          enabled: true,
        },
      },
    });

    await initializeCharacterDataForHost(storeRoot);

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        loadedConfig: loadProject02RuntimeConfig({storeRoot}),
        strictUnknownPlugins: true,
        factories: {
          [plugin.manifest.id]: {
            manifest: plugin.manifest,
            create: () => plugin,
          },
        },
      }),
    });
    expect(configured.activation.enabledPluginIds).toEqual([
      runtimePluginId,
      firstPartyModelToolsPluginId,
      plugin.manifest.id,
    ]);
    expect(configured.plugins.map(item => item.manifest.id)).toEqual([
      plugin.manifest.id,
    ]);
    expect(
      configured.activation.diagnostics.map(item => item.code),
    ).not.toContain('runtime_config_unknown_plugin');
    expect(configured.activation.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: plugin.manifest.id,
        enabled: true,
        activationStatus: 'active',
      }),
    );
  });

  it('records requested and granted access in activation snapshots', async () => {
    const storeRoot = createTestTempRoot('project02-config-access-');
    const plugin = fileStoreSessionEndPlugin(
      'valid.file-store-policy',
      () => {},
    );

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
        },
      },
    });

    await initializeCharacterDataForHost(storeRoot);

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        loadedConfig: loadProject02RuntimeConfig({storeRoot}),
        factories: {
          [plugin.manifest.id]: {
            manifest: plugin.manifest,
            create: () => plugin,
          },
        },
      }),
    });
    const activation = configured.activation.plugins.find(
      item => item.pluginId === plugin.manifest.id,
    );
    const canonicalAccess = runtimePluginAccessSnapshot({
      requestedAccess: plugin.manifest.requestedAccess,
      enabled: true,
      fieldPrefix: plugin.manifest.id,
    });
    const hostAccess = configured.host
      .registrySnapshot()
      .plugins.find(item => item.manifest.id === plugin.manifest.id);

    expect(activation).toMatchObject({
      pluginId: plugin.manifest.id,
      ...canonicalAccess,
    });
    expect(hostAccess).toMatchObject(canonicalAccess);
  });

  it('keeps character-only Character State disabled until character initialization', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-character-state-default-api-perms-',
    );

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    await initializeCharacterDataForHost(storeRoot);

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        loadedConfig: loadProject02RuntimeConfig({storeRoot}),
      }),
    });

    expect(configured.activation.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: characterStatePluginId,
        enabled: false,
        requestedAccess: {file_store: 'write', model_input: 'write'},
        grantedAccess: {},
      }),
    );
  });

  it('does not default-enable caller-supplied real Character State factories', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-character-state-real-factory-api-perms-',
    );
    const plugin = createCharacterStatePlugin();
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    await initializeCharacterDataForHost(storeRoot);

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        loadedConfig: loadProject02RuntimeConfig({storeRoot}),
        factories: {
          [characterStatePluginId]: {
            manifest: createCharacterStatePluginManifest(),
            create: () => {
              factoryCalls += 1;

              return plugin;
            },
          },
        },
      }),
    });

    expect(factoryCalls).toBe(0);
    expect(configured.activation.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: characterStatePluginId,
        enabled: false,
        requestedAccess: {file_store: 'write', model_input: 'write'},
        grantedAccess: {},
      }),
    );
  });

  it('does not default-enable caller-supplied Character State id spoofs', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-character-state-spoof-api-perms-',
    );
    const plugin = fileStoreSessionEndPlugin(characterStatePluginId, () => {});

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    await initializeCharacterDataForHost(storeRoot);

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        loadedConfig: loadProject02RuntimeConfig({storeRoot}),
        factories: {
          [characterStatePluginId]: {
            manifest: plugin.manifest,
            create: () => plugin,
          },
        },
      }),
    });

    expect(configured.activation.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: characterStatePluginId,
        enabled: false,
        requestedAccess: {file_store: 'write'},
        grantedAccess: {},
      }),
    );
  });

  it('does not default-enable a caller-supplied Character State factory', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-character-state-forged-catalog-',
    );
    const plugin = createCharacterStatePlugin();
    let factoryCalls = 0;
    const factories = {
      [characterStatePluginId]: {
        manifest: plugin.manifest,
        create() {
          factoryCalls += 1;

          return plugin;
        },
      },
    };

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    await initializeCharacterDataForHost(storeRoot);

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        loadedConfig: loadProject02RuntimeConfig({storeRoot}),
        factories,
      }),
    });

    expect(factoryCalls).toBe(0);
    expect(configured.activation.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: characterStatePluginId,
        enabled: false,
        requestedAccess: {file_store: 'write', model_input: 'write'},
        grantedAccess: {},
      }),
    );
  });

  it('keeps disabled unknown plugin wrappers strict when selected by defaultMemoryProvider', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-disabled-unknown-default-memory-',
    );

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: 'old',
      plugins: {
        old: {
          enabled: false,
        },
      },
    });

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        loadedConfig: loadProject02RuntimeConfig({storeRoot}),
        strictUnknownPlugins: true,
      }),
    });

    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_unknown_plugin',
        }),
      ]),
    );
  });

  it('fails strict activation for an unknown default memory provider', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-memory-default-strict-',
    );

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: 'memory.typo',
    });

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        loadedConfig: loadProject02RuntimeConfig({storeRoot}),
        strictUnknownPlugins: true,
      }),
    });

    expect(configured.plugins).toEqual([]);
    expect(configured.activation.enabledPluginIds).toEqual([runtimePluginId]);
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_unknown_plugin',
          path: 'project02.defaultMemoryProvider',
        }),
        expect.objectContaining({
          severity: 'warning',
          code: 'default_memory_provider_unavailable',
          path: 'project02.defaultMemoryProvider',
        }),
      ]),
    );
    expect(configured.activation.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: characterStatePluginId,
        enabled: false,
        activationStatus: 'blocked',
      }),
    );
  });

  it('keeps non-strict unknown default memory providers warning-only when no provider is active', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-memory-default-warning-',
    );

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: 'memory.typo',
    });

    await initializeCharacterDataForHost(storeRoot);

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        loadedConfig: loadProject02RuntimeConfig({storeRoot}),
      }),
    });

    expect(
      configured.activation.diagnostics.filter(
        diagnostic => diagnostic.severity === 'error',
      ),
    ).toEqual([]);
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          code: 'default_memory_provider_unavailable',
          path: 'project02.defaultMemoryProvider',
        }),
      ]),
    );
    expect(configured.activation.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: characterStatePluginId,
        enabled: false,
        activationStatus: 'disabled',
      }),
    );
  });

  it('does not activate memory providers selected only by defaultMemoryProvider', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-helper-default-memory-',
    );
    const plugin = createMemoryProviderRuntimePlugin({
      id: 'memory.local',
      displayName: 'Local Memory',
      recall() {
        return Promise.resolve({items: []});
      },
    });
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: plugin.manifest.id,
    });

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        loadedConfig: loadProject02RuntimeConfig({storeRoot}),
        factories: {
          [plugin.manifest.id]: {
            manifest: plugin.manifest,
            create() {
              factoryCalls += 1;

              return plugin;
            },
          },
        },
      }),
    });
    const activation = configured.activation.plugins.find(
      item => item.pluginId === plugin.manifest.id,
    );

    expect(factoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(configured.activation.enabledPluginIds).toEqual([runtimePluginId]);
    expect(configured.activation.defaultMemoryProvider).toBeUndefined();
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'default_memory_provider_unavailable',
          path: 'project02.defaultMemoryProvider',
          pluginId: plugin.manifest.id,
        }),
      ]),
    );
    expect(activation).toMatchObject({
      pluginId: plugin.manifest.id,
      kind: 'memory_provider',
      enabled: false,
      activationStatus: 'disabled',
    });
    expect(activation?.activationReasons).toEqual(
      expect.arrayContaining(['memory_provider_factory', 'not_enabled']),
    );
  });

  it('keeps helper memory providers disabled when selected but explicitly disabled', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-helper-default-memory-disabled-',
    );
    const plugin = createMemoryProviderRuntimePlugin({
      id: 'memory.local',
      displayName: 'Local Memory',
      recall() {
        return Promise.resolve({items: []});
      },
    });
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: plugin.manifest.id,
      plugins: {
        [plugin.manifest.id]: {
          enabled: false,
        },
      },
    });

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        loadedConfig: loadProject02RuntimeConfig({storeRoot}),
        factories: {
          [plugin.manifest.id]: {
            manifest: plugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'explicitly disabled memory provider was constructed',
              );
            },
          },
        },
      }),
    });
    const activation = configured.activation.plugins.find(
      item => item.pluginId === plugin.manifest.id,
    );

    expect(factoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(configured.activation.enabledPluginIds).toEqual([runtimePluginId]);
    expect(configured.activation.defaultMemoryProvider).toBeUndefined();
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'default_memory_provider_unavailable',
          path: 'project02.defaultMemoryProvider',
        }),
      ]),
    );
    expect(activation).toMatchObject({
      pluginId: plugin.manifest.id,
      kind: 'memory_provider',
      enabled: false,
      activationStatus: 'disabled',
    });
    expect(activation?.activationReasons).toEqual(
      expect.arrayContaining(['memory_provider_factory', 'disabled_by_config']),
    );
    expect(activation?.activationReasons).not.toContain(
      'selected_as_default_memory_provider',
    );
  });

  it('does not validate required config for inactive default memory providers', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-default-memory-required-',
    );
    const plugin = requiredSecretPlugin('memory.default-required', {
      defaultEnabled: false,
    });
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: plugin.manifest.id,
    });

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        loadedConfig: loadProject02RuntimeConfig({storeRoot}),
        factories: {
          [plugin.manifest.id]: {
            manifest: plugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'invalid memory provider config reached the factory',
              );
            },
          },
        },
      }),
    });

    expect(factoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(configured.activation.enabledPluginIds).toEqual([runtimePluginId]);
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'default_memory_provider_unavailable',
          path: 'project02.defaultMemoryProvider',
          pluginId: plugin.manifest.id,
        }),
      ]),
    );
    expect(
      configured.activation.diagnostics.map(item => item.code),
    ).not.toContain('runtime_config_required_secret_missing');
    expect(configured.activation.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: plugin.manifest.id,
        enabled: false,
        activationStatus: 'disabled',
      }),
    );
  });

  it('skips config validation and cold-discovers unselected memory providers', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-memory-default-selected-',
    );
    const selectedPlugin = requiredSecretPlugin('memory.selected');
    const unselectedPlugin = requiredSecretPlugin('memory.unselected');
    const envVar = 'PROJECT02_SELECTED_MEMORY_SECRET_3449142730';
    let selectedFactoryCalls = 0;
    let unselectedFactoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: selectedPlugin.manifest.id,
      plugins: {
        [selectedPlugin.manifest.id]: {
          enabled: true,
          config: {
            apiKey: {$env: envVar},
          },
        },
      },
    });

    await initializeCharacterDataForHost(storeRoot);

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        loadedConfig: loadProject02RuntimeConfig({storeRoot}),
        env: {
          [envVar]: 'selected-memory-secret',
        },
        factories: {
          [selectedPlugin.manifest.id]: {
            manifest: selectedPlugin.manifest,
            create() {
              selectedFactoryCalls += 1;

              return selectedPlugin;
            },
          },
          [unselectedPlugin.manifest.id]: {
            manifest: unselectedPlugin.manifest,
            create() {
              unselectedFactoryCalls += 1;

              return unselectedPlugin;
            },
          },
        },
      }),
    });
    const discoveryResult = await configured.host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginId,
        toolName: runtimePluginListToolName,
        input: {scope: 'all'},
      },
      testPluginContext(),
    );

    expect(configured.activation.enabledPluginIds).toEqual([
      runtimePluginId,
      firstPartyModelToolsPluginId,
      selectedPlugin.manifest.id,
    ]);
    expect(configured.activation.defaultMemoryProvider).toBe(
      selectedPlugin.manifest.id,
    );
    expect(selectedFactoryCalls).toBe(1);
    expect(unselectedFactoryCalls).toBe(0);
    expect(
      configured.host
        .registrySnapshot()
        .plugins.map(registered => registered.manifest.id),
    ).not.toContain(unselectedPlugin.manifest.id);
    expect(
      configured.host
        .pluginToolDefinitions()
        .some(tool => tool.pluginId === unselectedPlugin.manifest.id),
    ).toBe(false);
    expect(discoveryResult.status).toBe('accepted');
    if (discoveryResult.status !== 'accepted') {
      throw new Error('Expected runtime.plugin.list scope=all to be accepted.');
    }
    expect(
      pluginDiscoveryPluginSummaries(discoveryResult.output).find(
        summary => summary['id'] === unselectedPlugin.manifest.id,
      ),
    ).toMatchObject({
      id: unselectedPlugin.manifest.id,
      enabled: false,
      availableForTurn: false,
      activationStatus: 'disabled',
      grantedAccess: {},
      registeredLifecycleHooks: [],
      providedTools: [],
    });
    expect(
      configured.activation.diagnostics.map(item => item.code),
    ).not.toContain('runtime_config_required_secret_missing');
    expect(configured.activation.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: unselectedPlugin.manifest.id,
        enabled: false,
        activationStatus: 'disabled',
      }),
    );
  });

  it('skips required config validation for explicitly enabled unselected memory providers', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-memory-enabled-default-selected-',
    );
    const selectedPlugin = requiredSecretPlugin('memory.selected');
    const unselectedPlugin = requiredSecretPlugin('memory.unselected');
    const envVar = 'PROJECT02_EXPLICIT_SELECTED_MEMORY_SECRET_3449174646';
    let selectedFactoryCalls = 0;
    let unselectedFactoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: selectedPlugin.manifest.id,
      plugins: {
        [selectedPlugin.manifest.id]: {
          enabled: true,
          config: {
            apiKey: {$env: envVar},
          },
        },
        [unselectedPlugin.manifest.id]: {
          enabled: true,
        },
      },
    });

    await initializeCharacterDataForHost(storeRoot);

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        loadedConfig: loadProject02RuntimeConfig({storeRoot}),
        env: {
          [envVar]: 'selected-memory-secret',
        },
        factories: {
          [selectedPlugin.manifest.id]: {
            manifest: selectedPlugin.manifest,
            create() {
              selectedFactoryCalls += 1;

              return selectedPlugin;
            },
          },
          [unselectedPlugin.manifest.id]: {
            manifest: unselectedPlugin.manifest,
            create() {
              unselectedFactoryCalls += 1;

              return unselectedPlugin;
            },
          },
        },
      }),
    });
    const unselectedActivation = configured.activation.plugins.find(
      plugin => plugin.pluginId === unselectedPlugin.manifest.id,
    );

    expect(configured.activation.enabledPluginIds).toEqual([
      runtimePluginId,
      firstPartyModelToolsPluginId,
      selectedPlugin.manifest.id,
    ]);
    expect(configured.activation.defaultMemoryProvider).toBe(
      selectedPlugin.manifest.id,
    );
    expect(selectedFactoryCalls).toBe(1);
    expect(unselectedFactoryCalls).toBe(0);
    expect(
      configured.activation.diagnostics.map(item => item.code),
    ).not.toContain('runtime_config_required_secret_missing');
    expect(unselectedActivation).toMatchObject({
      pluginId: unselectedPlugin.manifest.id,
      enabled: false,
      activationStatus: 'disabled',
    });
    expect(unselectedActivation?.activationReasons).toEqual(
      expect.arrayContaining([
        'enabled_by_config',
        'not_selected_as_default_memory_provider',
      ]),
    );
  });

  it('keeps manifest-backed factories eligible for non-instantiating checks', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-manifest-backed-check-',
    );
    const envVar = 'PROJECT02_MANIFEST_BACKED_CHECK_SECRET_3448479333';
    const plugin = requiredSecretPlugin('memory.required');
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'memory.required': {
          enabled: true,
          config: {
            apiKey: {$env: envVar},
          },
        },
      },
    });

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        env: {
          [envVar]: 'manifest-backed-secret',
        },
        factories: {
          'memory.required': {
            manifest: plugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'runtime-config check must not construct factories',
              );
            },
          },
        },
      },
    );
    const output = parseActivationOutput(stdout);

    expect(exitCode).toBe(0);
    expect(factoryCalls).toBe(0);
    expect(output.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: 'memory.required',
        activationStatus: 'active',
        enabled: true,
      }),
    );
    expect(stdout).not.toContain('manifest-backed-secret');
  });
});
