import { describe, expect, it } from 'vitest';

import {
  pluginHasConfigErrors,
  runtimeConfigDiagnosticPathMatchesPlugin,
  type RuntimeConfigDiagnostic
} from '../src/runtime/config/index.ts';

describe('runtime config diagnostic plugin matching', () => {
  it('matches config errors by exact plugin id and config boundary', () => {
    const siblingProviderDiagnostics: readonly RuntimeConfigDiagnostic[] = [
      diagnostic('error', 'plugins.memory.recall.config.backend'),
      diagnostic('error', 'plugins.memory.configuration.backend'),
      diagnostic('warning', 'plugins.memory.config.backend')
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
        diagnostics: [diagnostic('error', 'plugins.memory.config.backend')],
        pluginId: 'memory'
      })
    ).toBe(true);
    expect(
      pluginHasConfigErrors({
        diagnostics: [diagnostic('error', 'plugins.memory.config.config.backend')],
        pluginId: 'memory'
      })
    ).toBe(false);
    expect(
      pluginHasConfigErrors({
        diagnostics: [diagnostic('error', 'plugins.memory.config.config.backend')],
        pluginId: 'memory.config'
      })
    ).toBe(true);
  });

  it('matches plugin diagnostics only at supported path boundaries', () => {
    expect(
      runtimeConfigDiagnosticPathMatchesPlugin({
        path: 'plugins.memory.recall.config.backend',
        pluginId: 'memory'
      })
    ).toBe(false);
    expect(
      runtimeConfigDiagnosticPathMatchesPlugin({
        path: 'plugins.memory.recall.config.backend',
        pluginId: 'memory.recall'
      })
    ).toBe(true);
    expect(
      runtimeConfigDiagnosticPathMatchesPlugin({
        path: 'plugins.memory.enabled',
        pluginId: 'memory'
      })
    ).toBe(true);
    expect(
      runtimeConfigDiagnosticPathMatchesPlugin({
        path: 'plugins.memory.enabled.enabled',
        pluginId: 'memory'
      })
    ).toBe(false);
    expect(
      runtimeConfigDiagnosticPathMatchesPlugin({
        path: 'plugins.memory.enabled.enabled',
        pluginId: 'memory.enabled'
      })
    ).toBe(true);
    expect(
      runtimeConfigDiagnosticPathMatchesPlugin({
        path: 'plugins.memory.config',
        pluginId: 'memory'
      })
    ).toBe(true);
    expect(
      runtimeConfigDiagnosticPathMatchesPlugin({
        path: 'plugins.memory.config.backend',
        pluginId: 'memory'
      })
    ).toBe(true);
    expect(
      runtimeConfigDiagnosticPathMatchesPlugin({
        path: 'plugins.memory.configured.backend',
        pluginId: 'memory'
      })
    ).toBe(false);
  });
});

function diagnostic(
  severity: RuntimeConfigDiagnostic['severity'],
  path: string
): RuntimeConfigDiagnostic {
  return Object.freeze({
    severity,
    code: 'test_diagnostic',
    message: 'test diagnostic',
    path
  } satisfies RuntimeConfigDiagnostic);
}
