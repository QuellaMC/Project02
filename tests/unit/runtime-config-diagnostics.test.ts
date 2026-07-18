import { describe, expect, it } from 'vitest';

import {
  pluginHasConfigErrors,
  resolveProject02RuntimeConfig,
  runtimeConfigVersion,
  runtimeConfigDiagnosticMatchesPlugin,
  type RuntimeConfigDiagnostic
} from '../../src/runtime/config/index.ts';
import { resolveRuntimePluginActivation } from '../../src/app/index.ts';

describe('runtime config diagnostic plugin matching', () => {
  it('matches config errors by exact plugin id and config boundary', () => {
    const siblingProviderDiagnostics: readonly RuntimeConfigDiagnostic[] = [
      diagnostic(
        'error',
        'plugins.memory.recall.config.backend',
        'memory.recall',
        'backend'
      ),
      diagnostic(
        'error',
        'plugins.memory.configuration.backend',
        'memory.configuration',
        'backend'
      ),
      diagnostic(
        'warning',
        'plugins.memory.config.backend',
        'memory',
        'backend'
      )
    ];

    expect(
      pluginHasConfigErrors({
        diagnostics: siblingProviderDiagnostics,
        pluginId: 'memory'
      })
    ).toBe(false);
    expect(
      pluginHasConfigErrors({
        diagnostics: siblingProviderDiagnostics,
        pluginId: 'memory.recall'
      })
    ).toBe(true);
    expect(
      pluginHasConfigErrors({
        diagnostics: [
          diagnostic(
            'error',
            'plugins.memory.config.backend',
            'memory',
            'backend'
          )
        ],
        pluginId: 'memory'
      })
    ).toBe(true);
    expect(
      pluginHasConfigErrors({
        diagnostics: [
          diagnostic(
            'error',
            'plugins.memory.config.api.config.key',
            'memory',
            'api.config.key'
          )
        ],
        pluginId: 'memory'
      })
    ).toBe(true);
  });

  it('uses diagnostic metadata to disambiguate plugin ids and dotted config fields', () => {
    const dottedFieldDiagnostic = diagnostic(
      'error',
      'plugins.memory.config.api.config.key',
      'memory',
      'api.config.key'
    );
    const dottedPluginDiagnostic = diagnostic(
      'error',
      'plugins.memory.config.config.backend',
      'memory.config',
      'backend'
    );

    expect(
      pluginHasConfigErrors({
        diagnostics: [dottedFieldDiagnostic],
        pluginId: 'memory'
      })
    ).toBe(true);
    expect(
      pluginHasConfigErrors({
        diagnostics: [dottedFieldDiagnostic],
        pluginId: 'memory.config.api'
      })
    ).toBe(false);
    expect(
      pluginHasConfigErrors({
        diagnostics: [dottedPluginDiagnostic],
        pluginId: 'memory'
      })
    ).toBe(false);
    expect(
      pluginHasConfigErrors({
        diagnostics: [dottedPluginDiagnostic],
        pluginId: 'memory.config'
      })
    ).toBe(true);
  });

  it('attributes generated unknown dotted-plugin diagnostics to the exact plugin id', () => {
    const loadedConfig = Object.freeze({
      source: 'default' as const,
      config: Object.freeze({
        version: runtimeConfigVersion,
        plugins: Object.freeze({
          'memory.config': Object.freeze({ enabled: true })
        })
      }),
      diagnostics: Object.freeze([])
    });
    const resolvedConfig = resolveProject02RuntimeConfig({
      loadedConfig,
      pluginManifests: []
    });
    const activation = resolveRuntimePluginActivation({
      loadedConfig,
      resolvedConfig,
      pluginManifests: [],
      strictUnknownPlugins: true
    });
    const unknownDiagnostic = activation.diagnostics.find(
      (item) => item.code === 'runtime_config_unknown_plugin'
    );

    expect(unknownDiagnostic).toMatchObject({
      pluginId: 'memory.config',
      path: 'plugins.memory.config'
    });
    expect(
      runtimeConfigDiagnosticMatchesPlugin({
        diagnostic: unknownDiagnostic as RuntimeConfigDiagnostic,
        pluginId: 'memory.config'
      })
    ).toBe(true);
    expect(
      runtimeConfigDiagnosticMatchesPlugin({
        diagnostic: unknownDiagnostic as RuntimeConfigDiagnostic,
        pluginId: 'memory'
      })
    ).toBe(false);
  });

  it('never infers plugin scope from a dotted diagnostic path', () => {
    const globalDiagnostic = diagnostic(
      'error',
      'plugins.memory.config.backend'
    );

    expect(
      runtimeConfigDiagnosticMatchesPlugin({
        diagnostic: globalDiagnostic,
        pluginId: 'memory'
      })
    ).toBe(false);
    expect(
      pluginHasConfigErrors({
        diagnostics: [globalDiagnostic],
        pluginId: 'memory'
      })
    ).toBe(false);
  });
});

function diagnostic(
  severity: RuntimeConfigDiagnostic['severity'],
  path: string,
  pluginId?: string,
  pluginConfigField?: string
): RuntimeConfigDiagnostic {
  const base = {
    severity,
    code: 'test_diagnostic',
    message: 'test diagnostic',
    path
  } as const;

  return pluginId === undefined
    ? Object.freeze({ ...base, scope: 'global' })
    : Object.freeze({
        ...base,
        scope: 'plugin',
        pluginId,
        ...(pluginConfigField === undefined ? {} : { pluginConfigField })
      });
}
