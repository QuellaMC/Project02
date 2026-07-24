import {realpathSync, readFileSync, writeFileSync} from 'node:fs';
import type * as NodeFs from 'node:fs';
import {join} from 'node:path';

import {afterEach, describe, expect, it, vi} from 'vitest';

import {createTestTempRoot} from '../support/temp-root.ts';

describe('runtime config mutation error handling', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('wraps failed secret writes and failed config rollback in a mutation error', async () => {
    const storeRoot = createTestTempRoot('project02-config-rollback-error-');
    const configPath = join(storeRoot, 'config.json');

    writeFileSync(
      configPath,
      `${JSON.stringify({version: 'project02.config.v2', project02: {storeRoot}}, null, 2)}\n`,
      'utf8',
    );

    const canonicalStoreRoot = realpathSync.native(storeRoot);
    const canonicalConfigPath = realpathSync.native(configPath);
    const canonicalEnvPath = join(canonicalStoreRoot, '.env');
    let configRenameCount = 0;

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof NodeFs>('node:fs');

      return {
        ...actual,
        renameSync(from: string, to: string): void {
          if (to === canonicalConfigPath) {
            configRenameCount += 1;

            if (configRenameCount === 2) {
              throw new Error('rollback denied');
            }
          }

          if (to === canonicalEnvPath) {
            throw new Error('env write denied');
          }

          actual.renameSync(from, to);
        },
      };
    });

    const {
      applyRuntimeConfigControlOperation,
      resolveRuntimeConfigScopeTarget,
      RuntimeConfigMutationError,
    } = await import('../../src/runtime/config/index.ts');
    const {requiredSecretPlugin} =
      await import('../support/runtime-config-fixtures.ts');
    const plugin = requiredSecretPlugin('memory');

    let thrown: unknown;

    try {
      applyRuntimeConfigControlOperation({
        target: resolveRuntimeConfigScopeTarget({
          storeRoot,
          env: {PROJECT02_MEMORY_API_KEY: 'secret-value'},
          scope: 'global',
        }),
        request: {
          kind: 'plugin_config',
          manifest: plugin.manifest,
          actor: 'operator',
          fieldOperation: {
            kind: 'secret_set',
            fieldName: 'apiKey',
            envVar: 'PROJECT02_MEMORY_API_KEY',
            secretValue: 'secret-value',
          },
        },
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RuntimeConfigMutationError);
    expect((thrown as Error).message).toBe(
      'Could not write runtime config secret and failed to roll back the config update.',
    );
    expect((thrown as Error).cause).toBeInstanceOf(AggregateError);
    expect(((thrown as Error).cause as AggregateError).errors).toHaveLength(2);
    expect(readFileSync(configPath, 'utf8')).toContain(
      '"$env": "PROJECT02_MEMORY_API_KEY"',
    );
  }, 10_000);
});
