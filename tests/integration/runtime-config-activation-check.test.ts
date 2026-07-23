import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {createTestTempRoot} from '../support/temp-root.ts';
import {runRuntimeConfigCliFromArgs} from '../../src/cli/config/main.ts';
import {createConfiguredProject02PluginHost} from '../../src/app/index.ts';
import {loadProject02RuntimeConfig} from '../../src/runtime/config/index.ts';
import {
  createRuntimePlugin,
  runtimePluginId,
  type RuntimePluginContext,
} from '../../src/plugins/index.ts';
import {createRuntimePluginFileStore} from '../../src/runtime/storage/plugin-file-store/index.ts';
import {
  characterStatePluginId,
  createCharacterStatePlugin,
  createCharacterStatePluginManifest,
} from '../../src/plugins/packages/character-state/plugin.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {collect} from '../support/streams.ts';
import {
  enabledNonHostScopedActivationPlugins,
  fileStoreSessionEndPlugin,
  firstPartyPlugin,
  modelFacingMemorySearchPlugin,
  modelFacingPluginListCollisionPlugin,
  nonHostScopedActivationPlugins,
  parseActivationOutput,
  pluginWithAdditionalConfigField,
  requiredSecretPlugin,
  sessionEndPlugin,
} from '../support/runtime-config-activation-fixtures.ts';
import {initializeCharacterDataForHost} from '../support/runtime-config-fixtures.ts';

describe('runtime config activation checks and construction', () => {
  it('reports host-owned default access during check for the default Character State factory', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-check-character-state-default-factory-',
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
      },
    );
    const output = parseActivationOutput(stdout);

    expect(exitCode).toBe(0);
    expect(output.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: characterStatePluginId,
        activationStatus: 'active',
        enabled: true,
        requestedAccess: {file_store: 'write', model_input: 'write'},
        grantedAccess: {file_store: 'write', model_input: 'write'},
      }),
    );
  });

  it('applies package-authored Character State enablement to caller-supplied factories during check', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-check-character-state-real-factory-',
    );
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories: {
          [characterStatePluginId]: {
            manifest: createCharacterStatePluginManifest(),
            create() {
              factoryCalls += 1;

              return createCharacterStatePlugin();
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
        pluginId: characterStatePluginId,
        activationStatus: 'active',
        enabled: true,
        requestedAccess: {file_store: 'write', model_input: 'write'},
        grantedAccess: {file_store: 'write', model_input: 'write'},
      }),
    );
  });

  it('applies package-authored Character State enablement to exact manifest matches', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-check-character-state-exact-manifest-',
    );
    const builtInPlugin = createCharacterStatePlugin();
    const plugin = createRuntimePlugin({
      manifest: builtInPlugin.manifest,
      providedTools: builtInPlugin.providedTools,
      lifecycleHooks: builtInPlugin.lifecycleHooks,
    });
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories: {
          [characterStatePluginId]: {
            manifest: createCharacterStatePluginManifest(),
            create() {
              factoryCalls += 1;

              return plugin;
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
        pluginId: characterStatePluginId,
        activationStatus: 'active',
        enabled: true,
        requestedAccess: {file_store: 'write', model_input: 'write'},
        grantedAccess: {file_store: 'write', model_input: 'write'},
      }),
    );
  });

  it('applies package-authored enablement by stable plugin id to injected manifests', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-check-character-state-spoof-',
    );
    const plugin = fileStoreSessionEndPlugin(characterStatePluginId, () => {});
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories: {
          [characterStatePluginId]: {
            manifest: plugin.manifest,
            create() {
              factoryCalls += 1;

              return plugin;
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
        pluginId: characterStatePluginId,
        activationStatus: 'active',
        enabled: true,
        requestedAccess: {file_store: 'write'},
        grantedAccess: {file_store: 'write'},
      }),
    );
  });

  it('fails check for duplicate manifest ids without constructing factories', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-duplicate-manifest-check-',
    );
    const envVar = 'PROJECT02_DUPLICATE_MANIFEST_CHECK_SECRET_3448711003';
    const firstPlugin = requiredSecretPlugin('memory.duplicate');
    const secondPlugin = requiredSecretPlugin('memory.duplicate');
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'memory.duplicate': {
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
          [envVar]: 'duplicate-manifest-secret',
        },
        factories: {
          'memory.duplicate.primary': {
            manifest: firstPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'duplicate manifest check must not construct factories',
              );
            },
          },
          'memory.duplicate.secondary': {
            manifest: secondPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'duplicate manifest check must not construct factories',
              );
            },
          },
        },
      },
    );
    const output = parseActivationOutput(stdout);

    expect(exitCode).toBe(1);
    expect(factoryCalls).toBe(0);
    expect(output.activationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_duplicate_plugin_manifest_id',
          path: 'plugins.memory.duplicate',
          pluginId: 'memory.duplicate',
        }),
      ]),
    );
    expect(
      output.plugins
        .filter(plugin => plugin.enabled)
        .map(plugin => plugin.pluginId),
    ).toEqual([runtimePluginId]);
    expect(stdout).not.toContain('duplicate-manifest-secret');
  });

  it('keeps unreferenced default-disabled duplicate manifest ids passing check', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-duplicate-default-disabled-',
    );
    const firstPlugin = firstPartyPlugin('optional.duplicate', {
      defaultEnabled: false,
    });
    const secondPlugin = firstPartyPlugin('optional.duplicate', {
      defaultEnabled: false,
    });
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories: {
          'optional.duplicate.primary': {
            manifest: firstPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'inactive duplicate manifest check must not construct factories',
              );
            },
          },
          'optional.duplicate.secondary': {
            manifest: secondPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'inactive duplicate manifest check must not construct factories',
              );
            },
          },
        },
      },
    );
    const output = parseActivationOutput(stdout);

    expect(exitCode).toBe(0);
    expect(factoryCalls).toBe(0);
    expect(output.activationDiagnostics.map(item => item.code)).not.toContain(
      'runtime_config_duplicate_plugin_manifest_id',
    );
    expect(
      enabledNonHostScopedActivationPlugins(output)
        .filter(plugin => plugin.pluginId === 'optional.duplicate')
        .map(plugin => plugin.pluginId),
    ).toEqual([]);
    expect(
      nonHostScopedActivationPlugins(output)
        .filter(plugin => plugin.pluginId === 'optional.duplicate')
        .map(plugin => plugin.activationStatus),
    ).toEqual(['disabled', 'disabled']);
  });

  it('fails check for mixed default-enabled duplicate manifest ids', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-duplicate-mixed-default-',
    );
    const firstPlugin = firstPartyPlugin('mixed.duplicate');
    const secondPlugin = firstPartyPlugin('mixed.duplicate', {
      defaultEnabled: false,
    });
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'mixed.duplicate': {
          enabled: true,
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
        factories: {
          'mixed.duplicate.primary': {
            manifest: firstPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'mixed default duplicate manifest check must not construct factories',
              );
            },
          },
          'mixed.duplicate.secondary': {
            manifest: secondPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'mixed default duplicate manifest check must not construct factories',
              );
            },
          },
        },
      },
    );
    const output = parseActivationOutput(stdout);

    expect(exitCode).toBe(1);
    expect(factoryCalls).toBe(0);
    expect(output.activationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_duplicate_plugin_manifest_id',
          path: 'plugins.mixed.duplicate',
          pluginId: 'mixed.duplicate',
        }),
      ]),
    );
    expect(
      output.plugins
        .filter(plugin => plugin.enabled)
        .map(plugin => plugin.pluginId),
    ).toEqual([runtimePluginId]);
  });

  it('keeps explicitly disabled duplicate manifest ids passing check', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-duplicate-disabled-',
    );
    const firstPlugin = firstPartyPlugin('disabled.duplicate');
    const secondPlugin = firstPartyPlugin('disabled.duplicate');
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'disabled.duplicate': {
          enabled: false,
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
        factories: {
          'disabled.duplicate.primary': {
            manifest: firstPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'disabled duplicate manifest check must not construct factories',
              );
            },
          },
          'disabled.duplicate.secondary': {
            manifest: secondPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'disabled duplicate manifest check must not construct factories',
              );
            },
          },
        },
      },
    );
    const output = parseActivationOutput(stdout);

    expect(exitCode).toBe(0);
    expect(factoryCalls).toBe(0);
    expect(output.activationDiagnostics.map(item => item.code)).not.toContain(
      'runtime_config_duplicate_plugin_manifest_id',
    );
    expect(
      enabledNonHostScopedActivationPlugins(output)
        .filter(plugin => plugin.pluginId === 'disabled.duplicate')
        .map(plugin => plugin.pluginId),
    ).toEqual([]);
    expect(
      nonHostScopedActivationPlugins(output)
        .filter(plugin => plugin.pluginId === 'disabled.duplicate')
        .map(plugin => plugin.activationStatus),
    ).toEqual(['disabled', 'disabled']);
  });

  it('keeps unselected duplicate memory providers passing check', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-duplicate-memory-unselected-',
    );
    const envVar = 'PROJECT02_SELECTED_MEMORY_DUPLICATE_SECRET_3450063170';
    const selectedPlugin = requiredSecretPlugin('memory.selected');
    const firstUnselectedPlugin = requiredSecretPlugin('memory.unselected');
    const secondUnselectedPlugin = requiredSecretPlugin('memory.unselected');
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: 'memory.selected',
      plugins: {
        'memory.selected': {
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
          [envVar]: 'selected-memory-secret',
        },
        factories: {
          'memory.selected': {
            manifest: selectedPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'runtime-config check must not construct factories',
              );
            },
          },
          'memory.unselected.primary': {
            manifest: firstUnselectedPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'unselected duplicate manifest check must not construct factories',
              );
            },
          },
          'memory.unselected.secondary': {
            manifest: secondUnselectedPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'unselected duplicate manifest check must not construct factories',
              );
            },
          },
        },
      },
    );
    const output = parseActivationOutput(stdout);

    expect(exitCode).toBe(0);
    expect(factoryCalls).toBe(0);
    expect(output.activationDiagnostics.map(item => item.code)).not.toContain(
      'runtime_config_duplicate_plugin_manifest_id',
    );
    expect(
      enabledNonHostScopedActivationPlugins(output).filter(plugin =>
        plugin.pluginId.startsWith('memory.'),
      ),
    ).toEqual([
      expect.objectContaining({
        pluginId: 'memory.selected',
      }),
    ]);
    expect(
      output.plugins
        .filter(plugin => plugin.pluginId === 'memory.unselected')
        .map(plugin => plugin.activationStatus),
    ).toEqual(['disabled', 'disabled']);
  });

  it('fails check for config-enabled default-disabled duplicate manifest ids', async () => {
    const storeRoot = createTestTempRoot('project02-config-duplicate-enabled-');
    const firstPlugin = firstPartyPlugin('selected.duplicate', {
      defaultEnabled: false,
    });
    const secondPlugin = firstPartyPlugin('selected.duplicate', {
      defaultEnabled: false,
    });
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'selected.duplicate': {
          enabled: true,
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
        factories: {
          'selected.duplicate.primary': {
            manifest: firstPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'active duplicate manifest check must not construct factories',
              );
            },
          },
          'selected.duplicate.secondary': {
            manifest: secondPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'active duplicate manifest check must not construct factories',
              );
            },
          },
        },
      },
    );
    const output = parseActivationOutput(stdout);

    expect(exitCode).toBe(1);
    expect(factoryCalls).toBe(0);
    expect(output.activationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_duplicate_plugin_manifest_id',
          path: 'plugins.selected.duplicate',
          pluginId: 'selected.duplicate',
        }),
      ]),
    );
    expect(
      output.plugins
        .filter(plugin => plugin.enabled)
        .map(plugin => plugin.pluginId),
    ).toEqual([runtimePluginId]);
  });

  it('fails check for manifest ids reserved by the host management plugin', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-reserved-management-id-',
    );
    const plugin = firstPartyPlugin(runtimePluginId);
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [runtimePluginId]: {
          enabled: true,
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
        factories: {
          'fixture.discovery-collision': {
            manifest: plugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error('reserved id check must not construct factories');
            },
          },
        },
      },
    );
    const output = parseActivationOutput(stdout);

    expect(exitCode).toBe(1);
    expect(factoryCalls).toBe(0);
    expect(output.activationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_duplicate_plugin_manifest_id',
          path: `plugins.${runtimePluginId}`,
          pluginId: runtimePluginId,
        }),
      ]),
    );
    expect(output.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: runtimePluginId,
        activationStatus: 'blocked',
        enabled: false,
      }),
    );
  });

  it('rejects manifest-backed factories that return a different same-id manifest', async () => {
    const storeRoot = createTestTempRoot('project02-config-manifest-mismatch-');
    const configPath = join(storeRoot, 'config.json');
    const envVar = 'PROJECT02_MANIFEST_MISMATCH_SECRET_3448659339';
    let cleanupCalls = 0;
    const cleanupPlugin = sessionEndPlugin('first.cleanup', () => {
      cleanupCalls += 1;
    });
    const declaredPlugin = requiredSecretPlugin('memory.contract');
    const returnedPlugin = pluginWithAdditionalConfigField('memory.contract');

    writeRuntimeConfig(configPath, {
      plugins: {
        [cleanupPlugin.manifest.id]: {
          enabled: true,
        },
        'memory.contract': {
          enabled: true,
          config: {
            apiKey: {$env: envVar},
          },
        },
      },
    });

    const loadedConfig = loadProject02RuntimeConfig({configPath});

    await initializeCharacterDataForHost(storeRoot);

    await expect(
      createConfiguredProject02PluginHost({
        loadedConfig,
        env: {
          [envVar]: 'same-id-different-manifest-secret',
        },
        factories: {
          [cleanupPlugin.manifest.id]: {
            manifest: cleanupPlugin.manifest,
            create: () => cleanupPlugin,
          },
          'memory.contract': {
            manifest: declaredPlugin.manifest,
            create: () => returnedPlugin,
          },
        },
      }),
    ).rejects.toThrow(
      'Plugin package loader "memory.contract" returned a manifest that differs from its declared manifest "memory.contract".',
    );
    expect(cleanupCalls).toBe(1);
  });

  it('closes already-created plugins when a later manifest-backed factory throws', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-factory-throw-cleanup-',
    );
    const configPath = join(storeRoot, 'config.json');
    const cleanupContexts: RuntimePluginContext[] = [];
    const cleanupPlugin = sessionEndPlugin('first.cleanup', context => {
      cleanupContexts.push(context);
    });
    const failingPlugin = firstPartyPlugin('later.failure');
    const sessionId = 'factory-throw-cleanup-session';

    writeRuntimeConfig(configPath, {
      plugins: {
        [cleanupPlugin.manifest.id]: {
          enabled: true,
        },
        [failingPlugin.manifest.id]: {
          enabled: true,
        },
      },
    });

    const loadedConfig = loadProject02RuntimeConfig({configPath});

    await initializeCharacterDataForHost(storeRoot);

    await expect(
      createConfiguredProject02PluginHost({
        loadedConfig,
        storeRoot,
        sessionId,
        factories: {
          [cleanupPlugin.manifest.id]: {
            manifest: cleanupPlugin.manifest,
            create: () => cleanupPlugin,
          },
          [failingPlugin.manifest.id]: {
            manifest: failingPlugin.manifest,
            create: () => {
              throw new Error('later manifest-backed factory failed');
            },
          },
        },
      }),
    ).rejects.toThrow('later manifest-backed factory failed');

    expect(cleanupContexts).toHaveLength(1);
    expect(cleanupContexts[0]).toMatchObject({
      sessionId,
      currentUserMessage: '',
      privacy: {
        exposePrivateConfig: false,
      },
    });
    expect(cleanupContexts[0]?.currentUserMessage).not.toContain(
      'later manifest-backed factory failed',
    );
  });

  it('keeps construction-failure cleanup read-only by default', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-factory-readonly-cleanup-',
    );
    const configPath = join(storeRoot, 'config.json');
    const cleanupContexts: RuntimePluginContext[] = [];
    const cleanupWriteBlocked: boolean[] = [];
    const cleanupPlugin = fileStoreSessionEndPlugin(
      'first.cleanup',
      context => {
        cleanupContexts.push(context);

        if (context.fileStore === undefined) {
          throw new Error(
            'Expected construction cleanup context to include fileStore.',
          );
        }

        try {
          context.fileStore.writeJsonAtomic('cleanup.json', {
            value: 'should-not-write',
          });
          cleanupWriteBlocked.push(false);
        } catch {
          cleanupWriteBlocked.push(true);
        }
      },
    );
    const failingPlugin = firstPartyPlugin('later.failure');

    writeRuntimeConfig(configPath, {
      plugins: {
        [cleanupPlugin.manifest.id]: {
          enabled: true,
        },
        [failingPlugin.manifest.id]: {
          enabled: true,
        },
      },
    });

    await initializeCharacterDataForHost(storeRoot);

    await expect(
      createConfiguredProject02PluginHost({
        loadedConfig: loadProject02RuntimeConfig({configPath}),
        storeRoot,
        factories: {
          [cleanupPlugin.manifest.id]: {
            manifest: cleanupPlugin.manifest,
            create: () => cleanupPlugin,
          },
          [failingPlugin.manifest.id]: {
            manifest: failingPlugin.manifest,
            create: () => {
              throw new Error('later manifest-backed factory failed');
            },
          },
        },
      }),
    ).rejects.toThrow('later manifest-backed factory failed');

    const cleanupContext = cleanupContexts[0];

    if (cleanupContext === undefined) {
      throw new Error('Expected construction cleanup to run.');
    }

    const cleanupStore = createRuntimePluginFileStore({
      storeRoot,
      sessionId: cleanupContext.sessionId,
      pluginId: cleanupPlugin.manifest.id,
    });

    expect(cleanupContext).toMatchObject({
      sessionId: 'configured-plugin-construction-cleanup',
      currentUserMessage: '',
    });
    expect(cleanupWriteBlocked).toEqual([true]);
    expect(cleanupStore.readJson('cleanup.json')).toBeUndefined();
  });

  it('uses the configured store root for construction-failure cleanup file-store reads', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-factory-durable-cleanup-',
    );
    const configPath = join(storeRoot, 'config.json');
    const sessionId = 'configured-plugin-durable-construction-cleanup';
    const cleanupReads: unknown[] = [];
    const cleanupPlugin = fileStoreSessionEndPlugin(
      'first.cleanup',
      context => {
        if (context.fileStore === undefined) {
          throw new Error(
            'Expected construction cleanup context to include fileStore.',
          );
        }

        cleanupReads.push(context.fileStore.readJson('state.json'));
      },
    );
    const failingPlugin = firstPartyPlugin('later.failure');

    writeRuntimeConfig(configPath, {
      plugins: {
        [cleanupPlugin.manifest.id]: {
          enabled: true,
        },
        [failingPlugin.manifest.id]: {
          enabled: true,
        },
      },
    });

    await initializeCharacterDataForHost(storeRoot);

    await expect(
      createConfiguredProject02PluginHost({
        loadedConfig: loadProject02RuntimeConfig({configPath}),
        storeRoot,
        sessionId,
        factories: {
          [cleanupPlugin.manifest.id]: {
            manifest: cleanupPlugin.manifest,
            create: input => {
              createRuntimePluginFileStore({
                storeRoot: input.storeRoot,
                sessionId,
                pluginId: cleanupPlugin.manifest.id,
              }).writeJsonAtomic('state.json', {
                value: 'durable construction state',
              });

              return cleanupPlugin;
            },
          },
          [failingPlugin.manifest.id]: {
            manifest: failingPlugin.manifest,
            create: () => {
              throw new Error('later manifest-backed factory failed');
            },
          },
        },
      }),
    ).rejects.toThrow('later manifest-backed factory failed');

    expect(cleanupReads).toEqual([
      {
        value: 'durable construction state',
      },
    ]);
  });

  it('fails closed on an unusable store before any factory or cleanup runs', async () => {
    const configRoot = createTestTempRoot(
      'project02-config-factory-invalid-store-cleanup-',
    );
    const invalidStoreRoot = join(configRoot, 'store-root-file');
    const configPath = join(configRoot, 'config.json');
    const cleanupContexts: RuntimePluginContext[] = [];
    const cleanupPlugin = fileStoreSessionEndPlugin(
      'first.cleanup',
      context => {
        cleanupContexts.push(context);
      },
    );
    const failingPlugin = firstPartyPlugin('later.failure');
    let factoryCalls = 0;

    writeFileSync(invalidStoreRoot, 'not a runtime store directory\n', 'utf8');
    writeRuntimeConfig(configPath, {
      plugins: {
        [cleanupPlugin.manifest.id]: {
          enabled: true,
        },
        [failingPlugin.manifest.id]: {
          enabled: true,
        },
      },
    });

    // The guarded initializer rejects the unusable store with its own
    // precise error before any factory can construct against it.
    await expect(
      createConfiguredProject02PluginHost({
        loadedConfig: loadProject02RuntimeConfig({configPath}),
        storeRoot: invalidStoreRoot,
        factories: {
          [cleanupPlugin.manifest.id]: {
            manifest: cleanupPlugin.manifest,
            create: () => {
              factoryCalls += 1;
              return cleanupPlugin;
            },
          },
          [failingPlugin.manifest.id]: {
            manifest: failingPlugin.manifest,
            create: () => {
              factoryCalls += 1;
              throw new Error(
                'later manifest-backed factory failed with unusable store',
              );
            },
          },
        },
      }),
    ).rejects.toThrow('Could not inspect the character-data root');

    expect(factoryCalls).toBe(0);
    expect(cleanupContexts).toHaveLength(0);
  });

  it('cleans up created plugins when host construction fails after factories succeed', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-host-throw-cleanup-',
    );
    const configPath = join(storeRoot, 'config.json');
    const cleanupContexts: RuntimePluginContext[] = [];
    const cleanupWriteBlocked: boolean[] = [];
    const cleanupPlugin = fileStoreSessionEndPlugin(
      'first.cleanup',
      context => {
        cleanupContexts.push(context);

        if (context.fileStore === undefined) {
          throw new Error(
            'Expected host cleanup context to include fileStore.',
          );
        }

        try {
          context.fileStore.writeJsonAtomic('cleanup.json', {
            value: 'should-not-write',
          });
          cleanupWriteBlocked.push(false);
        } catch {
          cleanupWriteBlocked.push(true);
        }
      },
    );
    const firstToolPlugin = modelFacingMemorySearchPlugin('memory.first');
    const secondToolPlugin = modelFacingMemorySearchPlugin('memory.second');

    writeRuntimeConfig(configPath, {
      plugins: {
        [cleanupPlugin.manifest.id]: {
          enabled: true,
        },
        [firstToolPlugin.manifest.id]: {
          enabled: true,
        },
        [secondToolPlugin.manifest.id]: {
          enabled: true,
        },
      },
    });

    await initializeCharacterDataForHost(storeRoot);

    await expect(
      createConfiguredProject02PluginHost({
        loadedConfig: loadProject02RuntimeConfig({configPath}),
        storeRoot,
        factories: {
          [cleanupPlugin.manifest.id]: {
            manifest: cleanupPlugin.manifest,
            create: () => cleanupPlugin,
          },
          [firstToolPlugin.manifest.id]: {
            manifest: firstToolPlugin.manifest,
            create: () => firstToolPlugin,
          },
          [secondToolPlugin.manifest.id]: {
            manifest: secondToolPlugin.manifest,
            create: () => secondToolPlugin,
          },
        },
      }),
    ).rejects.toThrow(/declared more than once/iu);

    const cleanupContext = cleanupContexts[0];

    if (cleanupContext === undefined) {
      throw new Error('Expected host construction cleanup to run.');
    }

    const cleanupStore = createRuntimePluginFileStore({
      storeRoot,
      sessionId: cleanupContext.sessionId,
      pluginId: cleanupPlugin.manifest.id,
    });

    expect(cleanupContext).toMatchObject({
      sessionId: 'configured-plugin-construction-cleanup',
      currentUserMessage: '',
    });
    expect(cleanupWriteBlocked).toEqual([true]);
    expect(cleanupStore.readJson('cleanup.json')).toBeUndefined();
  });

  it('runs cleanup for partial plugins that collide with host runtime.plugin.list', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-plugin-list-cleanup-',
    );
    const configPath = join(storeRoot, 'config.json');
    const cleanupContexts: RuntimePluginContext[] = [];
    const collisionPlugin = modelFacingPluginListCollisionPlugin(
      'plugin-list.cleanup-collision',
      context => {
        cleanupContexts.push(context);
        throw new Error('cleanup hook failure must not mask host construction');
      },
    );

    writeRuntimeConfig(configPath, {
      plugins: {
        [collisionPlugin.manifest.id]: {
          enabled: true,
        },
      },
    });

    await initializeCharacterDataForHost(storeRoot);

    await expect(
      createConfiguredProject02PluginHost({
        loadedConfig: loadProject02RuntimeConfig({configPath}),
        storeRoot,
        factories: {
          [collisionPlugin.manifest.id]: {
            manifest: collisionPlugin.manifest,
            create: () => collisionPlugin,
          },
        },
      }),
    ).rejects.toThrow(
      'Plugin tool "runtime.plugin.list" is declared more than once.',
    );

    expect(cleanupContexts).toHaveLength(1);
    expect(cleanupContexts[0]).toMatchObject({
      sessionId: 'configured-plugin-construction-cleanup',
      currentUserMessage: '',
      pluginId: collisionPlugin.manifest.id,
    });
  });

  it('accepts manifest-backed factories that return their declared manifest', async () => {
    const storeRoot = createTestTempRoot('project02-config-manifest-match-');
    const configPath = join(storeRoot, 'config.json');
    const envVar = 'PROJECT02_MANIFEST_MATCH_SECRET_3448659339';
    const plugin = requiredSecretPlugin('memory.contract');
    let factoryCalls = 0;

    writeRuntimeConfig(configPath, {
      plugins: {
        'memory.contract': {
          enabled: true,
          config: {
            apiKey: {$env: envVar},
          },
        },
      },
    });

    const loadedConfig = loadProject02RuntimeConfig({configPath});
    await initializeCharacterDataForHost(storeRoot);

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig,
      env: {
        [envVar]: 'same-id-matching-manifest-secret',
      },
      factories: {
        'memory.contract': {
          manifest: plugin.manifest,
          create: () => {
            factoryCalls += 1;

            return plugin;
          },
        },
      },
    });

    expect(factoryCalls).toBe(1);
    expect(configured.plugins.map(item => item.manifest.id)).toEqual([
      'memory.contract',
    ]);
  });
});
