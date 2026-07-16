import { describe, expect, it } from 'vitest';

import * as runtimeConfig from '../src/runtime/config/index.ts';

const canonicalRuntimeConfigVersion = 'project02.config.v2';

describe('config system v2 contract', () => {
  it('exports the canonical config version and accepts the project02 section', () => {
    expect(runtimeConfig.runtimeConfigVersion).toBe(canonicalRuntimeConfigVersion);

    const result = runtimeConfig.validateProject02RuntimeConfig({
      version: canonicalRuntimeConfigVersion,
      project02: {
        storeRoot: 'runtime-store',
        defaultMemoryProvider: 'memory.primary',
        roleModelProvider: 'nvidia'
      },
      plugins: {
        'memory.primary': {
          enabled: true,
          config: {
            endpoint: 'https://memory.example.test'
          }
        }
      }
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.config).toEqual({
      version: canonicalRuntimeConfigVersion,
      project02: {
        storeRoot: 'runtime-store',
        defaultMemoryProvider: 'memory.primary',
        roleModelProvider: 'nvidia'
      },
      plugins: {
        'memory.primary': {
          enabled: true,
          config: {
            endpoint: 'https://memory.example.test'
          }
        }
      }
    });
  });

  it('rejects flat Project02 fields in a v2 document', () => {
    const result = runtimeConfig.validateProject02RuntimeConfig({
      version: canonicalRuntimeConfigVersion,
      project02: {},
      storeRoot: 'flat-store',
      defaultMemoryProvider: 'memory.flat',
      roleModelProvider: 'nvidia'
    });

    expect(result.config).toBeUndefined();
    expect(
      result.diagnostics.map((diagnostic) => ({
        severity: diagnostic.severity,
        code: diagnostic.code,
        path: diagnostic.path
      }))
    ).toEqual([
      {
        severity: 'error',
        code: 'runtime_config_unknown_top_level_field',
        path: 'defaultMemoryProvider'
      },
      {
        severity: 'error',
        code: 'runtime_config_unknown_top_level_field',
        path: 'roleModelProvider'
      },
      {
        severity: 'error',
        code: 'runtime_config_unknown_top_level_field',
        path: 'storeRoot'
      }
    ]);
  });
});
