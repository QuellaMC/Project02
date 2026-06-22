import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { runRuntimeConfigCliFromArgs } from '../src/cli/config.ts';
import { roleModelPluginListToolName } from '../src/role-model/contracts.ts';
import {
  createConfiguredProject02PluginHost,
  loadProject02RuntimeConfig,
  runtimeConfigVersion
} from '../src/runtime/config/index.ts';
import {
  characterStatePluginId,
  createRuntimePluginFileStore,
  createRuntimePlugin,
  memorySearchTool,
  runtimePluginDiscoveryPluginId,
  runtimePluginContractVersion,
  type RuntimePluginContext
} from '../src/plugins/index.ts';

describe('runtime config activation diagnostics', () => {
  it('fails check for config-enabled legacy function factories without constructing them', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-legacy-unchecked-')
    );
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'legacy.required': {
          enabled: true
        }
      }
    });

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories: {
          'legacy.required': () => {
            factoryCalls += 1;
            throw new Error('runtime-config check must not construct legacy plugins');
          }
        }
      }
    );
    const output = parseActivationOutput(stdout);

    expect(exitCode).toBe(1);
    expect(factoryCalls).toBe(0);
    expect(output.activationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_legacy_factory_unchecked',
          path: 'plugins.legacy.required.enabled',
          pluginId: 'legacy.required'
        })
      ])
    );
  });

  it('keeps unreferenced default-disabled legacy function factories passing check', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-legacy-unreferenced-')
    );
    const plugin = firstPartyPlugin('legacy.optional', { defaultEnabled: false });
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories: {
          'legacy.optional': () => {
            factoryCalls += 1;

            return plugin;
          }
        }
      }
    );
    const output = parseActivationOutput(stdout);

    expect(exitCode).toBe(0);
    expect(factoryCalls).toBe(0);
    expect(output.activationDiagnostics.map((item) => item.code)).not.toContain(
      'runtime_config_legacy_factory_unchecked'
    );
    expect(output.plugins).toEqual([]);
  });

  it('fails check for default-memory legacy function factories without constructing them', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-legacy-default-memory-unchecked-')
    );
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: 'legacy.memory'
    });

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories: {
          'legacy.memory': () => {
            factoryCalls += 1;
            throw new Error('runtime-config check must not construct legacy plugins');
          }
        }
      }
    );
    const output = parseActivationOutput(stdout);

    expect(exitCode).toBe(1);
    expect(factoryCalls).toBe(0);
    expect(output.activationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_legacy_factory_unchecked',
          path: 'defaultMemoryProvider',
          pluginId: 'legacy.memory'
        })
      ])
    );
  });

  it('keeps explicitly disabled legacy function factories passing check', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-legacy-disabled-')
    );
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      enabledPlugins: ['legacy.required'],
      plugins: {
        'legacy.required': {
          enabled: false
        }
      }
    });

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories: {
          'legacy.required': () => {
            factoryCalls += 1;
            throw new Error('disabled legacy plugins must not be constructed');
          }
        }
      }
    );
    const output = parseActivationOutput(stdout);

    expect(exitCode).toBe(0);
    expect(factoryCalls).toBe(0);
    expect(output.activationDiagnostics.map((item) => item.code)).not.toContain(
      'runtime_config_legacy_factory_unchecked'
    );
    expect(output.activationDiagnostics.map((item) => item.code)).not.toContain(
      'runtime_config_unknown_plugin'
    );
  });

  it('fails check when the default memory provider targets a disabled legacy function factory', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-legacy-disabled-default-')
    );
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      enabledPlugins: ['legacy.required'],
      defaultMemoryProvider: 'legacy.required',
      plugins: {
        'legacy.required': {
          enabled: false
        }
      }
    });

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories: {
          'legacy.required': () => {
            factoryCalls += 1;
            throw new Error('disabled legacy plugins must not be constructed');
          }
        }
      }
    );
    const output = parseActivationOutput(stdout);

    expect(exitCode).toBe(1);
    expect(factoryCalls).toBe(0);
    expect(output.activationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'default_memory_provider_unavailable',
          path: 'defaultMemoryProvider',
          pluginId: 'legacy.required'
        })
      ])
    );
    expect(output.activationDiagnostics.map((item) => item.code)).not.toContain(
      'runtime_config_legacy_factory_unchecked'
    );
    expect(output.activationDiagnostics.map((item) => item.code)).not.toContain(
      'runtime_config_unknown_plugin'
    );
  });

  it('fails strict activation for an unknown default memory provider', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-memory-default-strict-')
    );

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: 'memory.typo'
    });

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ storeRoot }),
      strictUnknownPlugins: true
    });

    expect(configured.plugins).toEqual([]);
    expect(configured.activation.enabledPluginIds).toEqual([]);
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_unknown_plugin',
          path: 'defaultMemoryProvider'
        }),
        expect.objectContaining({
          severity: 'warning',
          code: 'default_memory_provider_unavailable',
          path: 'defaultMemoryProvider'
        })
      ])
    );
    expect(configured.activation.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: characterStatePluginId,
        enabled: false,
        activationStatus: 'blocked'
      })
    );
  });

  it('keeps non-strict unknown default memory providers warning-only when no provider is active', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-memory-default-warning-')
    );

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: 'memory.typo'
    });

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ storeRoot })
    });

    expect(
      configured.activation.diagnostics.filter(
        (diagnostic) => diagnostic.severity === 'error'
      )
    ).toEqual([]);
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          code: 'default_memory_provider_unavailable',
          path: 'defaultMemoryProvider'
        })
      ])
    );
    expect(configured.activation.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: characterStatePluginId,
        enabled: true,
        activationStatus: 'active'
      })
    );
  });

  it('skips required config validation for unselected default-enabled memory providers', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-memory-default-selected-')
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
          config: {
            apiKey: { $env: envVar }
          }
        }
      }
    });

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ storeRoot }),
      env: {
        [envVar]: 'selected-memory-secret'
      },
      factories: {
        [selectedPlugin.manifest.id]: {
          manifest: selectedPlugin.manifest,
          create() {
            selectedFactoryCalls += 1;

            return selectedPlugin;
          }
        },
        [unselectedPlugin.manifest.id]: {
          manifest: unselectedPlugin.manifest,
          create() {
            unselectedFactoryCalls += 1;

            return unselectedPlugin;
          }
        }
      }
    });

    expect(configured.activation.enabledPluginIds).toEqual([
      selectedPlugin.manifest.id
    ]);
    expect(configured.activation.defaultMemoryProvider).toBe(
      selectedPlugin.manifest.id
    );
    expect(selectedFactoryCalls).toBe(1);
    expect(unselectedFactoryCalls).toBe(0);
    expect(configured.activation.diagnostics.map((item) => item.code)).not.toContain(
      'runtime_config_required_secret_missing'
    );
    expect(configured.activation.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: unselectedPlugin.manifest.id,
        enabled: false,
        activationStatus: 'disabled'
      })
    );
  });

  it('skips required config validation for explicitly enabled unselected memory providers', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-memory-enabled-default-selected-')
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
            apiKey: { $env: envVar }
          }
        },
        [unselectedPlugin.manifest.id]: {
          enabled: true
        }
      }
    });

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ storeRoot }),
      env: {
        [envVar]: 'selected-memory-secret'
      },
      factories: {
        [selectedPlugin.manifest.id]: {
          manifest: selectedPlugin.manifest,
          create() {
            selectedFactoryCalls += 1;

            return selectedPlugin;
          }
        },
        [unselectedPlugin.manifest.id]: {
          manifest: unselectedPlugin.manifest,
          create() {
            unselectedFactoryCalls += 1;

            return unselectedPlugin;
          }
        }
      }
    });
    const unselectedActivation = configured.activation.plugins.find(
      (plugin) => plugin.pluginId === unselectedPlugin.manifest.id
    );

    expect(configured.activation.enabledPluginIds).toEqual([
      selectedPlugin.manifest.id
    ]);
    expect(configured.activation.defaultMemoryProvider).toBe(
      selectedPlugin.manifest.id
    );
    expect(selectedFactoryCalls).toBe(1);
    expect(unselectedFactoryCalls).toBe(0);
    expect(configured.activation.diagnostics.map((item) => item.code)).not.toContain(
      'runtime_config_required_secret_missing'
    );
    expect(unselectedActivation).toMatchObject({
      pluginId: unselectedPlugin.manifest.id,
      enabled: false,
      activationStatus: 'disabled'
    });
    expect(unselectedActivation?.activationReasons).toEqual(
      expect.arrayContaining([
        'enabled_by_config',
        'not_selected_as_default_memory_provider'
      ])
    );
  });

  it('keeps manifest-backed factories eligible for non-instantiating checks', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-manifest-backed-check-')
    );
    const envVar = 'PROJECT02_MANIFEST_BACKED_CHECK_SECRET_3448479333';
    const plugin = requiredSecretPlugin('legacy.required');
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'legacy.required': {
          enabled: true,
          config: {
            apiKey: { $env: envVar }
          }
        }
      }
    });

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        env: {
          [envVar]: 'manifest-backed-secret'
        },
        factories: {
          'legacy.required': {
            manifest: plugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error('runtime-config check must not construct factories');
            }
          }
        }
      }
    );
    const output = parseActivationOutput(stdout);

    expect(exitCode).toBe(0);
    expect(factoryCalls).toBe(0);
    expect(output.activationDiagnostics.map((item) => item.code)).not.toContain(
      'runtime_config_legacy_factory_unchecked'
    );
    expect(output.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: 'legacy.required',
        activationStatus: 'active',
        enabled: true
      })
    );
    expect(stdout).not.toContain('manifest-backed-secret');
  });

  it('fails check for duplicate manifest ids without constructing factories', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-duplicate-manifest-check-')
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
            apiKey: { $env: envVar }
          }
        }
      }
    });

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        env: {
          [envVar]: 'duplicate-manifest-secret'
        },
        factories: {
          'memory.duplicate.primary': {
            manifest: firstPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error('duplicate manifest check must not construct factories');
            }
          },
          'memory.duplicate.secondary': {
            manifest: secondPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error('duplicate manifest check must not construct factories');
            }
          }
        }
      }
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
          pluginId: 'memory.duplicate'
        })
      ])
    );
    expect(output.plugins.filter((plugin) => plugin.enabled)).toEqual([]);
    expect(stdout).not.toContain('duplicate-manifest-secret');
  });

  it('cleans up inactive legacy plugins prepared before activation filtering', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-inactive-legacy-cleanup-')
    );
    const configPath = join(storeRoot, 'config.json');
    const cleanupContexts: RuntimePluginContext[] = [];
    const inactivePlugin = sessionEndPlugin(
      'legacy.inactive-cleanup',
      (context) => {
        cleanupContexts.push(context);
      },
      { defaultEnabled: false }
    );
    let factoryCalls = 0;

    writeRuntimeConfig(configPath, {});

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ configPath }),
      storeRoot,
      sessionId: 'inactive-legacy-cleanup-session',
      factories: {
        [inactivePlugin.manifest.id]: () => {
          factoryCalls += 1;

          return inactivePlugin;
        }
      }
    });

    expect(factoryCalls).toBe(1);
    expect(configured.plugins).toEqual([]);
    expect(configured.activation.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: inactivePlugin.manifest.id,
        enabled: false,
        activationStatus: 'disabled'
      })
    );
    expect(cleanupContexts).toHaveLength(1);
    expect(cleanupContexts[0]).toMatchObject({
      sessionId: 'inactive-legacy-cleanup-session',
      currentUserMessage: 'configured plugin construction failed before host creation',
      privacy: {
        exposePrivateConfig: false
      }
    });
  });

  it('cleans up prepared legacy plugins when a later legacy factory throws', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-legacy-prepare-cleanup-')
    );
    const configPath = join(storeRoot, 'config.json');
    const cleanupContexts: RuntimePluginContext[] = [];
    const cleanupPlugin = sessionEndPlugin('legacy.prepare-cleanup', (context) => {
      cleanupContexts.push(context);
    });

    writeRuntimeConfig(configPath, {});

    await expect(
      createConfiguredProject02PluginHost({
        loadedConfig: loadProject02RuntimeConfig({ configPath }),
        storeRoot,
        sessionId: 'legacy-prepare-cleanup-session',
        factories: {
          [cleanupPlugin.manifest.id]: () => cleanupPlugin,
          'legacy.prepare-failure': () => {
            throw new Error('later legacy factory failed during preparation');
          }
        }
      })
    ).rejects.toThrow('later legacy factory failed during preparation');

    expect(cleanupContexts).toHaveLength(1);
    expect(cleanupContexts[0]).toMatchObject({
      sessionId: 'legacy-prepare-cleanup-session',
      currentUserMessage: 'configured plugin construction failed before host creation',
      privacy: {
        exposePrivateConfig: false
      }
    });
  });

  it('fails check for manifest ids reserved by the host discovery plugin', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-reserved-discovery-id-')
    );
    const plugin = firstPartyPlugin(runtimePluginDiscoveryPluginId);
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories: {
          'fixture.discovery-collision': {
            manifest: plugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error('reserved id check must not construct factories');
            }
          }
        }
      }
    );
    const output = parseActivationOutput(stdout);

    expect(exitCode).toBe(1);
    expect(factoryCalls).toBe(0);
    expect(output.activationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_duplicate_plugin_manifest_id',
          path: `plugins.${runtimePluginDiscoveryPluginId}`,
          pluginId: runtimePluginDiscoveryPluginId
        })
      ])
    );
    expect(output.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: runtimePluginDiscoveryPluginId,
        activationStatus: 'blocked',
        enabled: false
      })
    );
  });

  it('rejects manifest-backed factories that return a different same-id manifest', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-manifest-mismatch-')
    );
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
          enabled: true
        },
        'memory.contract': {
          enabled: true,
          config: {
            apiKey: { $env: envVar }
          }
        }
      }
    });

    const loadedConfig = loadProject02RuntimeConfig({ configPath });

    await expect(
      createConfiguredProject02PluginHost({
        loadedConfig,
        env: {
          [envVar]: 'same-id-different-manifest-secret'
        },
        factories: {
          [cleanupPlugin.manifest.id]: {
            manifest: cleanupPlugin.manifest,
            create: () => cleanupPlugin
          },
          'memory.contract': {
            manifest: declaredPlugin.manifest,
            create: () => returnedPlugin
          }
        }
      })
    ).rejects.toThrow(
      'Plugin factory "memory.contract" returned a manifest that differs from its declared manifest "memory.contract".'
    );
    expect(cleanupCalls).toBe(1);
  });

  it('closes already-created plugins when a later manifest-backed factory throws', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-factory-throw-cleanup-')
    );
    const configPath = join(storeRoot, 'config.json');
    const cleanupContexts: RuntimePluginContext[] = [];
    const cleanupPlugin = sessionEndPlugin('first.cleanup', (context) => {
      cleanupContexts.push(context);
    });
    const failingPlugin = firstPartyPlugin('later.failure');
    const sessionId = 'factory-throw-cleanup-session';

    writeRuntimeConfig(configPath, {
      plugins: {
        [cleanupPlugin.manifest.id]: {
          enabled: true
        },
        [failingPlugin.manifest.id]: {
          enabled: true
        }
      }
    });

    const loadedConfig = loadProject02RuntimeConfig({ configPath });

    await expect(
      createConfiguredProject02PluginHost({
        loadedConfig,
        storeRoot,
        sessionId,
        factories: {
          [cleanupPlugin.manifest.id]: {
            manifest: cleanupPlugin.manifest,
            create: () => cleanupPlugin
          },
          [failingPlugin.manifest.id]: {
            manifest: failingPlugin.manifest,
            create: () => {
              throw new Error('later manifest-backed factory failed');
            }
          }
        }
      })
    ).rejects.toThrow('later manifest-backed factory failed');

    expect(cleanupContexts).toHaveLength(1);
    expect(cleanupContexts[0]).toMatchObject({
      sessionId,
      currentUserMessage: 'configured plugin construction failed before host creation',
      privacy: {
        exposePrivateConfig: false
      }
    });
    expect(cleanupContexts[0]?.currentUserMessage).not.toContain(
      'later manifest-backed factory failed'
    );
  });

  it('keeps construction-failure cleanup read-only by default', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-factory-readonly-cleanup-')
    );
    const configPath = join(storeRoot, 'config.json');
    const cleanupContexts: RuntimePluginContext[] = [];
    const cleanupWriteBlocked: boolean[] = [];
    const cleanupPlugin = fileStoreSessionEndPlugin('first.cleanup', (context) => {
      cleanupContexts.push(context);

      if (context.fileStore === undefined) {
        throw new Error('Expected construction cleanup context to include fileStore.');
      }

      try {
        context.fileStore.writeJsonAtomic('cleanup.json', {
          value: 'should-not-write'
        });
        cleanupWriteBlocked.push(false);
      } catch {
        cleanupWriteBlocked.push(true);
      }
    });
    const failingPlugin = firstPartyPlugin('later.failure');

    writeRuntimeConfig(configPath, {
      plugins: {
        [cleanupPlugin.manifest.id]: {
          enabled: true
        },
        [failingPlugin.manifest.id]: {
          enabled: true
        }
      }
    });

    await expect(
      createConfiguredProject02PluginHost({
        loadedConfig: loadProject02RuntimeConfig({ configPath }),
        storeRoot,
        factories: {
          [cleanupPlugin.manifest.id]: {
            manifest: cleanupPlugin.manifest,
            create: () => cleanupPlugin
          },
          [failingPlugin.manifest.id]: {
            manifest: failingPlugin.manifest,
            create: () => {
              throw new Error('later manifest-backed factory failed');
            }
          }
        }
      })
    ).rejects.toThrow('later manifest-backed factory failed');

    const cleanupContext = cleanupContexts[0];

    if (cleanupContext === undefined) {
      throw new Error('Expected construction cleanup to run.');
    }

    const cleanupStore = createRuntimePluginFileStore({
      storeRoot,
      sessionId: cleanupContext.sessionId,
      pluginId: cleanupPlugin.manifest.id
    });

    expect(cleanupContext).toMatchObject({
      sessionId: 'configured-plugin-construction-cleanup',
      currentUserMessage: 'configured plugin construction failed before host creation'
    });
    expect(cleanupWriteBlocked).toEqual([true]);
    expect(cleanupStore.readJson('cleanup.json')).toBeUndefined();
  });

  it('preserves factory errors when construction cleanup file-store setup fails', async () => {
    const configRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-factory-invalid-store-cleanup-')
    );
    const invalidStoreRoot = join(configRoot, 'store-root-file');
    const configPath = join(configRoot, 'config.json');
    const cleanupContexts: RuntimePluginContext[] = [];
    const cleanupFileStoreAvailable: boolean[] = [];
    const cleanupPlugin = fileStoreSessionEndPlugin('first.cleanup', (context) => {
      cleanupContexts.push(context);
      cleanupFileStoreAvailable.push(context.fileStore !== undefined);
    });
    const failingPlugin = firstPartyPlugin('later.failure');

    writeFileSync(invalidStoreRoot, 'not a runtime store directory\n', 'utf8');
    writeRuntimeConfig(configPath, {
      plugins: {
        [cleanupPlugin.manifest.id]: {
          enabled: true
        },
        [failingPlugin.manifest.id]: {
          enabled: true
        }
      }
    });

    await expect(
      createConfiguredProject02PluginHost({
        loadedConfig: loadProject02RuntimeConfig({ configPath }),
        storeRoot: invalidStoreRoot,
        factories: {
          [cleanupPlugin.manifest.id]: {
            manifest: cleanupPlugin.manifest,
            create: () => cleanupPlugin
          },
          [failingPlugin.manifest.id]: {
            manifest: failingPlugin.manifest,
            create: () => {
              throw new Error(
                'later manifest-backed factory failed with unusable store'
              );
            }
          }
        }
      })
    ).rejects.toThrow(
      'later manifest-backed factory failed with unusable store'
    );

    expect(cleanupContexts).toHaveLength(1);
    expect(cleanupContexts[0]).toMatchObject({
      sessionId: 'configured-plugin-construction-cleanup',
      currentUserMessage: 'configured plugin construction failed before host creation'
    });
    expect(cleanupFileStoreAvailable).toEqual([true]);
  });

  it('cleans up created plugins when host construction fails after factories succeed', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-host-throw-cleanup-')
    );
    const configPath = join(storeRoot, 'config.json');
    const cleanupContexts: RuntimePluginContext[] = [];
    const cleanupWriteBlocked: boolean[] = [];
    const cleanupPlugin = fileStoreSessionEndPlugin('first.cleanup', (context) => {
      cleanupContexts.push(context);

      if (context.fileStore === undefined) {
        throw new Error('Expected host cleanup context to include fileStore.');
      }

      try {
        context.fileStore.writeJsonAtomic('cleanup.json', {
          value: 'should-not-write'
        });
        cleanupWriteBlocked.push(false);
      } catch {
        cleanupWriteBlocked.push(true);
      }
    });
    const firstToolPlugin = modelFacingMemorySearchPlugin('memory.first');
    const secondToolPlugin = modelFacingMemorySearchPlugin('memory.second');

    writeRuntimeConfig(configPath, {
      plugins: {
        [cleanupPlugin.manifest.id]: {
          enabled: true
        },
        [firstToolPlugin.manifest.id]: {
          enabled: true
        },
        [secondToolPlugin.manifest.id]: {
          enabled: true
        }
      }
    });

    await expect(
      createConfiguredProject02PluginHost({
        loadedConfig: loadProject02RuntimeConfig({ configPath }),
        storeRoot,
        factories: {
          [cleanupPlugin.manifest.id]: {
            manifest: cleanupPlugin.manifest,
            create: () => cleanupPlugin
          },
          [firstToolPlugin.manifest.id]: {
            manifest: firstToolPlugin.manifest,
            create: () => firstToolPlugin
          },
          [secondToolPlugin.manifest.id]: {
            manifest: secondToolPlugin.manifest,
            create: () => secondToolPlugin
          }
        }
      })
    ).rejects.toThrow(/declared more than once/iu);

    const cleanupContext = cleanupContexts[0];

    if (cleanupContext === undefined) {
      throw new Error('Expected host construction cleanup to run.');
    }

    const cleanupStore = createRuntimePluginFileStore({
      storeRoot,
      sessionId: cleanupContext.sessionId,
      pluginId: cleanupPlugin.manifest.id
    });

    expect(cleanupContext).toMatchObject({
      sessionId: 'configured-plugin-construction-cleanup',
      currentUserMessage: 'configured plugin construction failed before host creation'
    });
    expect(cleanupWriteBlocked).toEqual([true]);
    expect(cleanupStore.readJson('cleanup.json')).toBeUndefined();
  });

  it('runs cleanup for partial plugins that collide with host plugin.list', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-plugin-list-cleanup-')
    );
    const configPath = join(storeRoot, 'config.json');
    const cleanupContexts: RuntimePluginContext[] = [];
    const collisionPlugin = modelFacingPluginListCollisionPlugin(
      'plugin-list.cleanup-collision',
      (context) => {
        cleanupContexts.push(context);
        throw new Error('cleanup hook failure must not mask host construction');
      }
    );

    writeRuntimeConfig(configPath, {
      plugins: {
        [collisionPlugin.manifest.id]: {
          enabled: true
        }
      }
    });

    await expect(
      createConfiguredProject02PluginHost({
        loadedConfig: loadProject02RuntimeConfig({ configPath }),
        storeRoot,
        factories: {
          [collisionPlugin.manifest.id]: {
            manifest: collisionPlugin.manifest,
            create: () => collisionPlugin
          }
        }
      })
    ).rejects.toThrow('Plugin tool "plugin.list" is declared more than once.');

    expect(cleanupContexts).toHaveLength(1);
    expect(cleanupContexts[0]).toMatchObject({
      sessionId: 'configured-plugin-construction-cleanup',
      currentUserMessage: 'configured plugin construction failed before host creation',
      pluginId: collisionPlugin.manifest.id
    });
  });

  it('accepts manifest-backed factories that return their declared manifest', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-manifest-match-')
    );
    const configPath = join(storeRoot, 'config.json');
    const envVar = 'PROJECT02_MANIFEST_MATCH_SECRET_3448659339';
    const plugin = requiredSecretPlugin('memory.contract');
    let factoryCalls = 0;

    writeRuntimeConfig(configPath, {
      plugins: {
        'memory.contract': {
          enabled: true,
          config: {
            apiKey: { $env: envVar }
          }
        }
      }
    });

    const loadedConfig = loadProject02RuntimeConfig({ configPath });
    const configured = await createConfiguredProject02PluginHost({
      loadedConfig,
      env: {
        [envVar]: 'same-id-matching-manifest-secret'
      },
      factories: {
        'memory.contract': {
          manifest: plugin.manifest,
          create: () => {
            factoryCalls += 1;

            return plugin;
          }
        }
      }
    });

    expect(factoryCalls).toBe(1);
    expect(configured.plugins.map((item) => item.manifest.id)).toEqual([
      'memory.contract'
    ]);
  });
});

function requiredSecretPlugin(id: string) {
  return createRuntimePlugin({
    manifest: {
      id,
      displayName: 'Required Secret',
      version: '1.0.0',
      kind: 'memory_provider',
      description: 'Test plugin with required secret config.',
      contractVersion: runtimePluginContractVersion,
      compatibility: {
        hostContractVersions: [runtimePluginContractVersion],
        sourceSystem: 'project02'
      },
      declaredPlugins: ['plugin_discovery'],
      config: {
        fields: [
          {
            name: 'apiKey',
            description: 'API key.',
            required: true,
            secret: true,
            valueType: 'secret',
            redactionLabels: ['secret']
          }
        ]
      },
      localTrustLevel: 'trusted_adapter',
      runtimePolicy: {
        requiredForTurn: false,
        sideEffectLevel: 'runtime_read',
        confirmation: 'not_required',
        timeoutMs: 1000,
        sourceReferencesRequired: false,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall: 'degrade',
          handleToolCall: 'degrade',
          afterTurnCommitted: 'log_failure',
          health: 'degrade'
        }
      },
      activation: {
        defaultEnabled: true,
        reasons: ['test_required_secret']
      },
      requestedApis: []
    }
  });
}

function pluginWithAdditionalConfigField(id: string) {
  const plugin = requiredSecretPlugin(id);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
      config: {
        ...plugin.manifest.config,
        fields: [
          ...plugin.manifest.config.fields,
          {
            name: 'region',
            description: 'Region.',
            required: false,
            secret: false,
            valueType: 'string',
            redactionLabels: []
          }
        ]
      }
    }
  });
}

function firstPartyPlugin(
  id: string,
  options: {
    readonly defaultEnabled?: boolean;
  } = {}
) {
  return createRuntimePlugin({
    manifest: {
      id,
      displayName: 'First Party',
      version: '1.0.0',
      kind: 'first_party',
      description: 'Test first-party plugin.',
      contractVersion: runtimePluginContractVersion,
      compatibility: {
        hostContractVersions: [runtimePluginContractVersion],
        sourceSystem: 'project02'
      },
      declaredPlugins: ['plugin_discovery'],
      config: {
        fields: []
      },
      localTrustLevel: 'first_party',
      runtimePolicy: {
        requiredForTurn: false,
        sideEffectLevel: 'runtime_read',
        confirmation: 'not_required',
        timeoutMs: 1000,
        sourceReferencesRequired: false,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall: 'degrade',
          handleToolCall: 'degrade',
          afterTurnCommitted: 'log_failure',
          health: 'degrade'
        }
      },
      activation: {
        defaultEnabled: options.defaultEnabled ?? true,
        reasons: ['test_first_party']
      },
      requestedApis: []
    }
  });
}

function sessionEndPlugin(
  id: string,
  onSessionEnd: (context: RuntimePluginContext) => void,
  options: {
    readonly defaultEnabled?: boolean;
  } = {}
) {
  const plugin = firstPartyPlugin(id, options);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
      declaredPlugins: ['plugin_discovery', 'on_session_end']
    },
    lifecycleHooks: {
      onSessionEnd(context) {
        onSessionEnd(context);
        return {
          status: 'completed',
          evidence: []
        };
      }
    }
  });
}

function fileStoreSessionEndPlugin(
  id: string,
  onSessionEnd: (context: RuntimePluginContext) => void
) {
  const plugin = firstPartyPlugin(id);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
      declaredPlugins: ['plugin_discovery', 'on_session_end'],
      runtimePolicy: {
        ...plugin.manifest.runtimePolicy,
        sideEffectLevel: 'local_memory_write'
      },
      requestedApis: ['file_store']
    },
    lifecycleHooks: {
      onSessionEnd(context) {
        onSessionEnd(context);
        return {
          status: 'completed',
          evidence: []
        };
      }
    }
  });
}

function modelFacingMemorySearchPlugin(id: string) {
  const plugin = firstPartyPlugin(id);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
      declaredPlugins: [
        'plugin_discovery',
        'tool_provider',
        'handle_tool_call'
      ]
    },
    providedTools: [memorySearchTool('memory.search')],
    lifecycleHooks: {
      handleToolCall() {
        return {
          status: 'accepted',
          output: {},
          evidence: []
        };
      }
    }
  });
}

function modelFacingPluginListCollisionPlugin(
  id: string,
  onSessionEnd: (context: RuntimePluginContext) => void
) {
  const plugin = firstPartyPlugin(id);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
      declaredPlugins: [
        'plugin_discovery',
        'tool_provider',
        'handle_tool_call',
        'on_session_end'
      ]
    },
    providedTools: [memorySearchTool(roleModelPluginListToolName)],
    lifecycleHooks: {
      handleToolCall() {
        return {
          status: 'accepted',
          output: {},
          evidence: []
        };
      },
      onSessionEnd(context) {
        onSessionEnd(context);

        return {
          status: 'completed',
          evidence: []
        };
      }
    }
  });
}

function writeRuntimeConfig(
  path: string,
  config: Readonly<Record<string, unknown>>
): string {
  writeFileSync(
    path,
    `${JSON.stringify({ version: runtimeConfigVersion, ...config }, null, 2)}\n`,
    'utf8'
  );
  return path;
}

function collect(write: (chunk: string) => void): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      write(String(chunk));
      callback();
    }
  });
}

function parseActivationOutput(stdout: string): {
  readonly activationDiagnostics: readonly {
    readonly severity: string;
    readonly code: string;
    readonly path?: string;
    readonly pluginId?: string;
  }[];
  readonly plugins: readonly {
    readonly pluginId: string;
    readonly activationStatus: string;
    readonly enabled: boolean;
  }[];
} {
  return JSON.parse(stdout) as {
    readonly activationDiagnostics: readonly {
      readonly severity: string;
      readonly code: string;
      readonly path?: string;
      readonly pluginId?: string;
    }[];
    readonly plugins: readonly {
      readonly pluginId: string;
      readonly activationStatus: string;
      readonly enabled: boolean;
    }[];
  };
}
