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
  createMemoryProviderRuntimePlugin,
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

  it('ignores explicitly disabled unknown plugin wrappers during strict activation', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-disabled-unknown-strict-')
    );
    const plugin = firstPartyPlugin('valid.runtime');

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        old: {
          enabled: false
        },
        [plugin.manifest.id]: {
          enabled: true
        }
      }
    });

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ storeRoot }),
      strictUnknownPlugins: true,
      factories: {
        [plugin.manifest.id]: {
          manifest: plugin.manifest,
          create: () => plugin
        }
      }
    });

    expect(configured.activation.enabledPluginIds).toEqual([plugin.manifest.id]);
    expect(configured.plugins.map((item) => item.manifest.id)).toEqual([
      plugin.manifest.id
    ]);
    expect(configured.activation.diagnostics.map((item) => item.code)).not.toContain(
      'runtime_config_unknown_plugin'
    );
    expect(configured.activation.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: plugin.manifest.id,
        enabled: true,
        activationStatus: 'active'
      })
    );
  });

  it('keeps unselected registered legacy plugin config wrappers known during strict activation', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-unselected-legacy-wrapper-strict-')
    );
    const configPath = join(storeRoot, 'config.json');
    let factoryCalls = 0;

    writeRuntimeConfig(configPath, {
      plugins: {
        legacy: {
          config: {
            mode: 'inactive'
          }
        }
      }
    });

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ configPath }),
      storeRoot,
      strictUnknownPlugins: true,
      factories: {
        legacy: () => {
          factoryCalls += 1;
          throw new Error('unselected legacy factory must not be constructed');
        }
      }
    });

    expect(factoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(configured.activation.diagnostics.map((item) => item.code)).not.toContain(
      'runtime_config_unknown_plugin'
    );
    expect(configured.activation.diagnostics.map((item) => item.code)).not.toContain(
      'runtime_config_legacy_factory_unchecked'
    );
  });

  it('keeps disabled unknown plugin wrappers strict when selected by enabledPlugins', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-disabled-unknown-enabled-list-')
    );

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      enabledPlugins: ['old'],
      plugins: {
        old: {
          enabled: false
        }
      }
    });

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ storeRoot }),
      strictUnknownPlugins: true
    });

    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_unknown_plugin'
        })
      ])
    );
  });

  it('keeps disabled unknown plugin wrappers strict when selected by defaultMemoryProvider', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-disabled-unknown-default-memory-')
    );

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: 'old',
      plugins: {
        old: {
          enabled: false
        }
      }
    });

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ storeRoot }),
      strictUnknownPlugins: true
    });

    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_unknown_plugin'
        })
      ])
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

  it('activates helper memory providers selected only by defaultMemoryProvider', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-helper-default-memory-')
    );
    const plugin = createMemoryProviderRuntimePlugin({
      id: 'memory.local',
      displayName: 'Local Memory',
      recall() {
        return Promise.resolve({ items: [] });
      }
    });
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: plugin.manifest.id
    });

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ storeRoot }),
      factories: {
        [plugin.manifest.id]: {
          manifest: plugin.manifest,
          create() {
            factoryCalls += 1;

            return plugin;
          }
        }
      }
    });
    const activation = configured.activation.plugins.find(
      (item) => item.pluginId === plugin.manifest.id
    );

    expect(factoryCalls).toBe(1);
    expect(configured.plugins.map((item) => item.manifest.id)).toEqual([
      plugin.manifest.id
    ]);
    expect(configured.activation.enabledPluginIds).toEqual([plugin.manifest.id]);
    expect(configured.activation.defaultMemoryProvider).toBe(plugin.manifest.id);
    expect(configured.activation.diagnostics).toEqual([]);
    expect(activation).toMatchObject({
      pluginId: plugin.manifest.id,
      kind: 'memory_provider',
      enabled: true,
      activationStatus: 'active'
    });
    expect(activation?.activationReasons).toEqual(
      expect.arrayContaining([
        'memory_provider_factory',
        'selected_as_default_memory_provider'
      ])
    );
  });

  it('keeps helper memory providers disabled when selected but explicitly disabled', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-helper-default-memory-disabled-')
    );
    const plugin = createMemoryProviderRuntimePlugin({
      id: 'memory.local',
      displayName: 'Local Memory',
      recall() {
        return Promise.resolve({ items: [] });
      }
    });
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: plugin.manifest.id,
      plugins: {
        [plugin.manifest.id]: {
          enabled: false
        }
      }
    });

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ storeRoot }),
      factories: {
        [plugin.manifest.id]: {
          manifest: plugin.manifest,
          create() {
            factoryCalls += 1;
            throw new Error('explicitly disabled memory provider was constructed');
          }
        }
      }
    });
    const activation = configured.activation.plugins.find(
      (item) => item.pluginId === plugin.manifest.id
    );

    expect(factoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(configured.activation.enabledPluginIds).toEqual([]);
    expect(configured.activation.defaultMemoryProvider).toBeUndefined();
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'default_memory_provider_unavailable',
          path: 'defaultMemoryProvider'
        })
      ])
    );
    expect(activation).toMatchObject({
      pluginId: plugin.manifest.id,
      kind: 'memory_provider',
      enabled: false,
      activationStatus: 'disabled'
    });
    expect(activation?.activationReasons).toEqual(
      expect.arrayContaining(['memory_provider_factory', 'disabled_by_config'])
    );
    expect(activation?.activationReasons).not.toContain(
      'selected_as_default_memory_provider'
    );
  });

  it('validates required config for default-disabled memory providers selected by defaultMemoryProvider', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-default-memory-required-')
    );
    const plugin = requiredSecretPlugin('memory.default-required', {
      defaultEnabled: false
    });
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: plugin.manifest.id
    });

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ storeRoot }),
      factories: {
        [plugin.manifest.id]: {
          manifest: plugin.manifest,
          create() {
            factoryCalls += 1;
            throw new Error('invalid memory provider config reached the factory');
          }
        }
      }
    });

    expect(factoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(configured.activation.enabledPluginIds).toEqual([]);
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_required_secret_missing',
          path: `plugins.${plugin.manifest.id}.config.apiKey`,
          pluginId: plugin.manifest.id,
          pluginConfigField: 'apiKey'
        })
      ])
    );
    expect(configured.activation.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: plugin.manifest.id,
        enabled: false,
        activationStatus: 'blocked'
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

  it('keeps unreferenced default-disabled duplicate manifest ids passing check', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-duplicate-default-disabled-')
    );
    const firstPlugin = firstPartyPlugin('optional.duplicate', {
      defaultEnabled: false
    });
    const secondPlugin = firstPartyPlugin('optional.duplicate', {
      defaultEnabled: false
    });
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
          'optional.duplicate.primary': {
            manifest: firstPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'inactive duplicate manifest check must not construct factories'
              );
            }
          },
          'optional.duplicate.secondary': {
            manifest: secondPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'inactive duplicate manifest check must not construct factories'
              );
            }
          }
        }
      }
    );
    const output = parseActivationOutput(stdout);

    expect(exitCode).toBe(0);
    expect(factoryCalls).toBe(0);
    expect(output.activationDiagnostics.map((item) => item.code)).not.toContain(
      'runtime_config_duplicate_plugin_manifest_id'
    );
    expect(output.plugins.filter((plugin) => plugin.enabled)).toEqual([]);
    expect(output.plugins.map((plugin) => plugin.activationStatus)).toEqual([
      'disabled',
      'disabled'
    ]);
  });

  it('fails check for mixed default-enabled duplicate manifest ids', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-duplicate-mixed-default-')
    );
    const firstPlugin = firstPartyPlugin('mixed.duplicate');
    const secondPlugin = firstPartyPlugin('mixed.duplicate', {
      defaultEnabled: false
    });
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
          'mixed.duplicate.primary': {
            manifest: firstPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'mixed default duplicate manifest check must not construct factories'
              );
            }
          },
          'mixed.duplicate.secondary': {
            manifest: secondPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'mixed default duplicate manifest check must not construct factories'
              );
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
          path: 'plugins.mixed.duplicate',
          pluginId: 'mixed.duplicate'
        })
      ])
    );
    expect(output.plugins.filter((plugin) => plugin.enabled)).toEqual([]);
  });

  it('keeps explicitly disabled duplicate manifest ids passing check', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-duplicate-disabled-')
    );
    const firstPlugin = firstPartyPlugin('disabled.duplicate');
    const secondPlugin = firstPartyPlugin('disabled.duplicate');
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'disabled.duplicate': {
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
          'disabled.duplicate.primary': {
            manifest: firstPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'disabled duplicate manifest check must not construct factories'
              );
            }
          },
          'disabled.duplicate.secondary': {
            manifest: secondPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'disabled duplicate manifest check must not construct factories'
              );
            }
          }
        }
      }
    );
    const output = parseActivationOutput(stdout);

    expect(exitCode).toBe(0);
    expect(factoryCalls).toBe(0);
    expect(output.activationDiagnostics.map((item) => item.code)).not.toContain(
      'runtime_config_duplicate_plugin_manifest_id'
    );
    expect(output.plugins.filter((plugin) => plugin.enabled)).toEqual([]);
    expect(output.plugins.map((plugin) => plugin.activationStatus)).toEqual([
      'disabled',
      'disabled'
    ]);
  });

  it('keeps unselected duplicate memory providers passing check', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-duplicate-memory-unselected-')
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
          [envVar]: 'selected-memory-secret'
        },
        factories: {
          'memory.selected': {
            manifest: selectedPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error('runtime-config check must not construct factories');
            }
          },
          'memory.unselected.primary': {
            manifest: firstUnselectedPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'unselected duplicate manifest check must not construct factories'
              );
            }
          },
          'memory.unselected.secondary': {
            manifest: secondUnselectedPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'unselected duplicate manifest check must not construct factories'
              );
            }
          }
        }
      }
    );
    const output = parseActivationOutput(stdout);

    expect(exitCode).toBe(0);
    expect(factoryCalls).toBe(0);
    expect(output.activationDiagnostics.map((item) => item.code)).not.toContain(
      'runtime_config_duplicate_plugin_manifest_id'
    );
    expect(output.plugins.filter((plugin) => plugin.enabled)).toEqual([
      expect.objectContaining({
        pluginId: 'memory.selected'
      })
    ]);
    expect(
      output.plugins
        .filter((plugin) => plugin.pluginId === 'memory.unselected')
        .map((plugin) => plugin.activationStatus)
    ).toEqual(['disabled', 'disabled']);
  });

  it('fails check for config-enabled default-disabled duplicate manifest ids', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-duplicate-enabled-')
    );
    const firstPlugin = firstPartyPlugin('selected.duplicate', {
      defaultEnabled: false
    });
    const secondPlugin = firstPartyPlugin('selected.duplicate', {
      defaultEnabled: false
    });
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'selected.duplicate': {
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
          'selected.duplicate.primary': {
            manifest: firstPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'active duplicate manifest check must not construct factories'
              );
            }
          },
          'selected.duplicate.secondary': {
            manifest: secondPlugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error(
                'active duplicate manifest check must not construct factories'
              );
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
          path: 'plugins.selected.duplicate',
          pluginId: 'selected.duplicate'
        })
      ])
    );
    expect(output.plugins.filter((plugin) => plugin.enabled)).toEqual([]);
  });

  it('skips unselected legacy function factories during host preparation', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-unselected-legacy-host-')
    );
    const configPath = join(storeRoot, 'config.json');
    let factoryCalls = 0;

    writeRuntimeConfig(configPath, {});

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ configPath }),
      storeRoot,
      sessionId: 'unselected-legacy-host-session',
      factories: {
        'legacy.optional': () => {
          factoryCalls += 1;
          throw new Error('unselected legacy factory must not be constructed');
        }
      }
    });

    expect(factoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(configured.activation.diagnostics).toEqual([]);
    expect(configured.activation.plugins).toEqual([]);
  });

  it('skips later unselected legacy factory failures during host preparation', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-legacy-prepare-skip-')
    );
    const configPath = join(storeRoot, 'config.json');
    let factoryCalls = 0;

    writeRuntimeConfig(configPath, {});

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ configPath }),
      storeRoot,
      sessionId: 'legacy-prepare-skip-session',
      factories: {
        'legacy.prepare-cleanup': () => {
          factoryCalls += 1;
          return sessionEndPlugin('legacy.prepare-cleanup', () => {});
        },
        'legacy.prepare-failure': () => {
          factoryCalls += 1;
          throw new Error('later legacy factory failed during preparation');
        }
      }
    });

    expect(factoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(configured.activation.diagnostics).toEqual([]);
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

function requiredSecretPlugin(
  id: string,
  options: {
    readonly defaultEnabled?: boolean;
  } = {}
) {
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
        defaultEnabled: options.defaultEnabled ?? true,
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
