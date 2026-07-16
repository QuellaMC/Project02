import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runRuntimeConfigCliFromArgs } from '../src/cli/config.ts';
import * as runtimeConfig from '../src/runtime/config/index.ts';
import { collect } from './support/runtime-config.ts';
import { createTestTempRoot } from './support/temp-root.ts';

const canonicalRuntimeConfigVersion = 'project02.config.v2';
const legacyRuntimeConfigVersion = 'project02.runtime_config.v1';

describe('config system v2 compatibility contract', () => {
  it('exports both config versions and accepts the canonical project02 section', () => {
    expect(runtimeConfig.runtimeConfigVersion).toBe(canonicalRuntimeConfigVersion);
    expect(Reflect.get(runtimeConfig, 'legacyRuntimeConfigVersion')).toBe(
      legacyRuntimeConfigVersion
    );

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

  it('loads a valid v1 file as canonical v2 with one legacy warning', () => {
    const root = createTestTempRoot('project02-config-v2-legacy-load-');
    const configPath = join(root, 'config.json');

    writeJson(configPath, {
      version: legacyRuntimeConfigVersion,
      storeRoot: 'legacy-store',
      defaultMemoryProvider: 'memory.legacy',
      plugins: {
        'memory.legacy': {
          enabled: true,
          config: {
            backend: 'local'
          }
        }
      }
    });

    const loaded = runtimeConfig.loadProject02RuntimeConfig({ configPath });

    expect(loaded.source).toBe('path');
    expect(loaded.path).toBe(configPath);
    expect(loaded.config).toEqual({
      version: canonicalRuntimeConfigVersion,
      project02: {
        storeRoot: 'legacy-store',
        defaultMemoryProvider: 'memory.legacy'
      },
      plugins: {
        'memory.legacy': {
          enabled: true,
          config: {
            backend: 'local'
          }
        }
      }
    });
    expect(loaded.diagnostics).toHaveLength(1);
    expect(loaded.diagnostics[0]).toMatchObject({
      severity: 'warning',
      code: 'runtime_config_legacy_version'
    });
  });

  it('rejects legacy flat Project02 fields in a v2 document', () => {
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

  it('persists v2 after legacy mutation and supports canonical and alias CLI paths', async () => {
    const root = createTestTempRoot('project02-config-v2-cli-');
    const configPath = join(root, 'config.json');
    const canonicalStoreRoot = join(root, 'canonical-store');

    writeJson(configPath, {
      version: legacyRuntimeConfigVersion,
      storeRoot: 'legacy-store',
      defaultMemoryProvider: 'memory.legacy',
      plugins: {
        'memory.legacy': {
          enabled: true
        }
      }
    });

    expect(
      await runConfigCli(configPath, ['set', 'storeRoot', 'migrated-store'])
    ).toMatchObject({ exitCode: 0, stderr: '' });
    expect(readJson(configPath)).toEqual({
      version: canonicalRuntimeConfigVersion,
      project02: {
        storeRoot: 'migrated-store',
        defaultMemoryProvider: 'memory.legacy'
      },
      plugins: {
        'memory.legacy': {
          enabled: true
        }
      }
    });

    expect(
      await runConfigCli(configPath, [
        'set',
        'project02.storeRoot',
        canonicalStoreRoot
      ])
    ).toMatchObject({ exitCode: 0, stderr: '' });
    expect(
      await runConfigCli(configPath, [
        'set',
        'defaultMemoryProvider',
        'memory.alias'
      ])
    ).toMatchObject({ exitCode: 0, stderr: '' });
    expect(
      await runConfigCli(configPath, [
        'set',
        'project02.roleModelProvider',
        'nvidia'
      ])
    ).toMatchObject({ exitCode: 0, stderr: '' });

    const legacyGet = await runConfigCli(configPath, ['get', 'storeRoot']);
    const canonicalGet = await runConfigCli(configPath, [
      'get',
      'project02.defaultMemoryProvider'
    ]);

    expect(legacyGet).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify(canonicalStoreRoot, null, 2)}\n`,
      stderr: ''
    });
    expect(canonicalGet).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify('memory.alias', null, 2)}\n`,
      stderr: ''
    });
    expect(readJson(configPath)).toEqual({
      version: canonicalRuntimeConfigVersion,
      project02: {
        storeRoot: canonicalStoreRoot,
        defaultMemoryProvider: 'memory.alias',
        roleModelProvider: 'nvidia'
      },
      plugins: {
        'memory.legacy': {
          enabled: true
        }
      }
    });
  });
});

function writeJson(path: string, value: Readonly<Record<string, unknown>>): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

async function runConfigCli(
  configPath: string,
  command: readonly string[]
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  let stdout = '';
  let stderr = '';
  const exitCode = await runRuntimeConfigCliFromArgs(
    ['--config', configPath, ...command],
    {
      stdout: collect((chunk) => {
        stdout += chunk;
      }),
      stderr: collect((chunk) => {
        stderr += chunk;
      }),
      env: {}
    }
  );

  return { exitCode, stdout, stderr };
}
