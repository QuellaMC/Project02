import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {
  runtimeConfigVersion,
  runtimeConfigDiagnosticIsReadinessFailure,
  runtimeConfigDiagnosticMatchesSection,
  type RuntimeConfigDiagnostic,
  resolveLayeredProject02RuntimeConfig,
} from '../../src/runtime/config/index.ts';
import {runtimeConfigSnapshotForTest} from '../support/runtime-config.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {memorySearchPluginManifest} from '../support/plugin-host-fixtures.ts';
import {resolveRuntimePluginActivation} from '../../src/app/index.ts';
import {createRuntimePluginManifest} from '../../src/plugins/api/index.ts';

describe('runtime config readiness classification', () => {
  it('classifies only the two required-supply codes as readiness failures', () => {
    const readiness = [
      'runtime_config_required_value_missing',
      'runtime_config_required_secret_missing',
    ];
    const authoring = [
      'runtime_config_unknown_plugin_config_field',
      'runtime_config_value_type_invalid',
      'runtime_config_secret_ref_for_non_secret',
      'runtime_config_secret_value_invalid',
      'runtime_config_reserved_control_env_var',
      'some_future_resolver_error',
    ];

    for (const code of readiness) {
      expect(
        runtimeConfigDiagnosticIsReadinessFailure(codedDiagnostic(code)),
      ).toBe(true);
    }
    for (const code of authoring) {
      expect(
        runtimeConfigDiagnosticIsReadinessFailure(codedDiagnostic(code)),
      ).toBe(false);
    }
  });
});

function codedDiagnostic(code: string): RuntimeConfigDiagnostic {
  return Object.freeze({
    severity: 'error',
    code,
    message: 'test diagnostic',
    path: 'plugins.memory.config.field',
    scope: 'section',
    namespace: 'plugins',
    id: 'memory',
  });
}

describe('runtime config diagnostic plugin matching', () => {
  it('attributes generated unknown dotted-plugin diagnostics to the exact plugin id', () => {
    const configPath = join(
      createTestTempRoot('project02-runtime-config-diagnostics-'),
      'config.json',
    );
    const loadedConfig = Object.freeze({
      source: 'path' as const,
      path: configPath,
      config: Object.freeze({
        version: runtimeConfigVersion,
        plugins: Object.freeze({
          'memory.config': Object.freeze({enabled: true}),
        }),
      }),
      diagnostics: Object.freeze([]),
    });
    const resolvedConfig = resolveLayeredProject02RuntimeConfig({
      ...runtimeConfigSnapshotForTest({loadedConfig: loadedConfig}),

      sections: {plugins: [], connectors: []},
    });
    const activation = resolveRuntimePluginActivation({
      effectiveConfig: loadedConfig,
      resolvedConfig,
      pluginManifests: [],
    });
    const unknownDiagnostic = activation.diagnostics.find(
      item => item.code === 'runtime_config_unknown_plugin',
    );

    expect(unknownDiagnostic).toMatchObject({
      namespace: 'plugins',
      id: 'memory.config',
      path: 'plugins.memory.config',
    });
    expect(
      runtimeConfigDiagnosticMatchesSection({
        diagnostic: unknownDiagnostic as RuntimeConfigDiagnostic,
        namespace: 'plugins',
        id: 'memory.config',
      }),
    ).toBe(true);
    expect(
      runtimeConfigDiagnosticMatchesSection({
        diagnostic: unknownDiagnostic as RuntimeConfigDiagnostic,
        namespace: 'plugins',
        id: 'memory',
      }),
    ).toBe(false);
  });

  it('grants trusted_context only to provenance-eligible plugins and warns otherwise', () => {
    const manifest = createRuntimePluginManifest({
      ...memorySearchPluginManifest('memory.curated.fixture'),
      declaredPlugins: ['plugin_discovery'],
      requestedAccess: {trusted_context: 'write'},
    });
    const configPath = join(
      createTestTempRoot('project02-runtime-config-curated-'),
      'config.json',
    );
    const loadedConfig = Object.freeze({
      source: 'path' as const,
      path: configPath,
      config: Object.freeze({
        version: runtimeConfigVersion,
        plugins: Object.freeze({
          'memory.curated.fixture': Object.freeze({enabled: true}),
        }),
      }),
      diagnostics: Object.freeze([]),
    });
    const resolvedConfig = resolveLayeredProject02RuntimeConfig({
      ...runtimeConfigSnapshotForTest({loadedConfig}),
      sections: {plugins: [manifest], connectors: []},
    });
    const activationInput = {
      effectiveConfig: loadedConfig,
      resolvedConfig,
      pluginManifests: [manifest],
    };
    const withheld = resolveRuntimePluginActivation(activationInput);
    const granted = resolveRuntimePluginActivation({
      ...activationInput,
      trustedContextEligiblePluginIds: new Set(['memory.curated.fixture']),
    });
    const withheldSnapshot = withheld.plugins.find(
      plugin => plugin.pluginId === 'memory.curated.fixture',
    );
    const grantedSnapshot = granted.plugins.find(
      plugin => plugin.pluginId === 'memory.curated.fixture',
    );

    expect(withheldSnapshot?.requestedAccess).toEqual({
      trusted_context: 'write',
    });
    expect(withheldSnapshot?.grantedAccess).toEqual({});
    expect(withheld.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'trusted_context_not_first_party',
        namespace: 'plugins',
        id: 'memory.curated.fixture',
      }),
    );
    expect(grantedSnapshot?.grantedAccess).toEqual({trusted_context: 'write'});
    expect(
      granted.diagnostics.some(
        diagnosticItem =>
          diagnosticItem.code === 'trusted_context_not_first_party',
      ),
    ).toBe(false);
  });

  it('never infers plugin scope from a dotted diagnostic path', () => {
    const globalDiagnostic = diagnostic(
      'error',
      'plugins.memory.config.backend',
    );

    expect(
      runtimeConfigDiagnosticMatchesSection({
        diagnostic: globalDiagnostic,
        namespace: 'plugins',
        id: 'memory',
      }),
    ).toBe(false);
  });
});

function diagnostic(
  severity: RuntimeConfigDiagnostic['severity'],
  path: string,
  id?: string,
  field?: string,
): RuntimeConfigDiagnostic {
  const base = {
    severity,
    code: 'test_diagnostic',
    message: 'test diagnostic',
    path,
  } as const;

  return id === undefined
    ? Object.freeze({...base, scope: 'global'})
    : Object.freeze({
        ...base,
        scope: 'section',
        namespace: 'plugins',
        id,
        ...(field === undefined ? {} : {field}),
      });
}
