import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { applyRuntimeConfigMutation } from '../../src/runtime/config/mutate.ts';
import { runtimeConfigVersion } from '../../src/runtime/config/types.ts';
import { createTestTempRoot } from '../support/temp-root.ts';

describe('runtime config atomic temporary-file cleanup', () => {
  it('removes an abandoned plaintext env replacement under the env lock', () => {
    const storeRoot = createTestTempRoot('project02-config-dead-temp-');
    const configPath = join(storeRoot, 'config.json');
    const abandonedPath = join(
      storeRoot,
      '..env.2147483647.00000000-0000-4000-8000-000000000000.tmp'
    );
    const unrelatedPath = join(
      storeRoot,
      '.unrelated.2147483647.00000000-0000-4000-8000-000000000000.tmp'
    );

    writeFileSync(
      configPath,
      `${JSON.stringify({
        version: runtimeConfigVersion,
        project02: { storeRoot }
      })}\n`,
      'utf8'
    );
    writeFileSync(abandonedPath, 'plaintext-abandoned-sentinel\n', {
      encoding: 'utf8',
      mode: 0o600
    });
    writeFileSync(unrelatedPath, 'keep-me\n', 'utf8');

    applyRuntimeConfigMutation({
      storeRoot,
      operation: {
        kind: 'secret_set',
        pluginId: 'memory',
        fieldName: 'apiKey',
        envVar: 'PROJECT02_MEMORY_API_KEY',
        secretValue: 'current-secret'
      }
    });

    expect(existsSync(abandonedPath)).toBe(false);
    expect(readFileSync(unrelatedPath, 'utf8')).toBe('keep-me\n');
    expect(readFileSync(join(storeRoot, '.env'), 'utf8')).not.toContain(
      'plaintext-abandoned-sentinel'
    );
  });
});
