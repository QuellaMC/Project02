import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {
  applyRuntimeConfigControlOperation,
  runtimeConfigVersion,
  resolveRuntimeConfigScopeTarget,
} from '../../src/runtime/config/index.ts';
import {ensureInitializedProject02Home} from '../../src/runtime/storage/index.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {requiredSecretPlugin} from '../support/runtime-config-activation-fixtures.ts';
import {runtimeLocationForTest} from '../support/runtime-config.ts';

describe('runtime config atomic temporary-file cleanup', () => {
  it('removes an abandoned plaintext env replacement under the env lock', async () => {
    const storeRoot = createTestTempRoot('project02-config-dead-temp-');
    const configPath = join(storeRoot, 'config.json');
    const abandonedPath = join(
      storeRoot,
      '..env.2147483647.00000000-0000-4000-8000-000000000000.tmp',
    );
    const unrelatedPath = join(
      storeRoot,
      '.unrelated.2147483647.00000000-0000-4000-8000-000000000000.tmp',
    );

    await ensureInitializedProject02Home({homeRoot: storeRoot});
    writeFileSync(
      configPath,
      `${JSON.stringify({
        version: runtimeConfigVersion,
        project02: {storeRoot},
      })}\n`,
      'utf8',
    );
    writeFileSync(abandonedPath, 'plaintext-abandoned-sentinel\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    writeFileSync(unrelatedPath, 'keep-me\n', 'utf8');

    const plugin = requiredSecretPlugin('memory');

    applyRuntimeConfigControlOperation({
      pluginManifests: [],
      target: resolveRuntimeConfigScopeTarget({
        runtimeLocation: runtimeLocationForTest({
          storeRoot: storeRoot,
          env: {PROJECT02_MEMORY_API_KEY: 'current-secret'},
        }),

        env: {PROJECT02_MEMORY_API_KEY: 'current-secret'},
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
          secretValue: 'current-secret',
        },
      },
    });

    expect(existsSync(abandonedPath)).toBe(false);
    expect(readFileSync(unrelatedPath, 'utf8')).toBe('keep-me\n');
    expect(readFileSync(join(storeRoot, '.env'), 'utf8')).not.toContain(
      'plaintext-abandoned-sentinel',
    );
  });
});
