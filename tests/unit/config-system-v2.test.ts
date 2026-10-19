import {describe, expect, it} from 'vitest';

import * as runtimeConfig from '../../src/runtime/config/index.ts';

const canonicalRuntimeConfigVersion = 'project02.config.v2';

describe('config system v2 contract', () => {
  it('exposes one target-aware prepare/apply control seam', () => {
    expect(runtimeConfig.applyRuntimeConfigControlOperation).toBeTypeOf(
      'function',
    );
    expect(runtimeConfig.prepareRuntimeConfigControlOperation).toBeTypeOf(
      'function',
    );
    expect(runtimeConfig.resolveRuntimeConfigScopeTarget).toBeTypeOf(
      'function',
    );

    for (const displacedName of [
      'applyScopedRuntimeConfigControlOperation',
      'applyRuntimePluginConfigControlOperation',
      'applyScopedRuntimePluginConfigControlOperation',
      'prepareRuntimePluginConfigControlOperation',
      'prepareScopedRuntimePluginConfigControlOperation',
      'assertRuntimeConfigSecretScopeAllowed',
    ]) {
      expect(runtimeConfig).not.toHaveProperty(displacedName);
    }
  });

  it('exports the canonical config version and accepts the project02 section', () => {
    expect(runtimeConfig.runtimeConfigVersion).toBe(
      canonicalRuntimeConfigVersion,
    );

    const result = runtimeConfig.validateProject02RuntimeConfig({
      version: canonicalRuntimeConfigVersion,
      project02: {
        defaultMemoryProvider: 'memory.primary',
        roleModelProvider: 'nvidia',
      },
      plugins: {
        'memory.primary': {
          enabled: true,
          config: {
            endpoint: 'https://memory.example.test',
          },
        },
      },
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.config).toEqual({
      version: canonicalRuntimeConfigVersion,
      project02: {
        defaultMemoryProvider: 'memory.primary',
        roleModelProvider: 'nvidia',
      },
      plugins: {
        'memory.primary': {
          enabled: true,
          config: {
            endpoint: 'https://memory.example.test',
          },
        },
      },
    });
  });

  it('rejects flat Project02 fields in a v2 document', () => {
    const result = runtimeConfig.validateProject02RuntimeConfig({
      version: canonicalRuntimeConfigVersion,
      project02: {},
      storeRoot: 'flat-store',
      defaultMemoryProvider: 'memory.flat',
      roleModelProvider: 'nvidia',
    });

    expect(result.config).toBeUndefined();
    expect(
      result.diagnostics.map(diagnostic => ({
        severity: diagnostic.severity,
        code: diagnostic.code,
        path: diagnostic.path,
      })),
    ).toEqual([
      {
        severity: 'error',
        code: 'runtime_config_unknown_top_level_field',
        path: 'defaultMemoryProvider',
      },
      {
        severity: 'error',
        code: 'runtime_config_unknown_top_level_field',
        path: 'roleModelProvider',
      },
      {
        severity: 'error',
        code: 'runtime_config_unknown_top_level_field',
        path: 'storeRoot',
      },
    ]);
  });

  it('takes the provider base URL only as an http or https base address, and never says the one it refused', () => {
    const diagnosticsFor = (nvidiaBaseUrl: string) =>
      runtimeConfig.validateProject02RuntimeConfig({
        version: canonicalRuntimeConfigVersion,
        project02: {nvidiaBaseUrl},
      }).diagnostics;

    expect(diagnosticsFor('http://localhost:1234/v1')).toEqual([]);
    expect(diagnosticsFor('https://nim.example.test/v1/')).toEqual([]);

    for (const refused of [
      'localhost:1234/v1',
      'ftp://nim.example.test/v1',
      'https://nim.example.test/v1?key=hunter2',
      'https://nim.example.test/v1#hunter2',
      'https://operator:hunter2@nim.example.test/v1',
    ]) {
      const diagnostics = diagnosticsFor(refused);

      expect(diagnostics).toEqual([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_nvidia_base_url_invalid',
          path: 'project02.nvidiaBaseUrl',
        }),
      ]);
      expect(JSON.stringify(diagnostics)).not.toContain('hunter2');
    }
  });
});
