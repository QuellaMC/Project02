import { describe, expect, it } from 'vitest';

import {
  runtimeConfigVersion,
  validateProject02RuntimeConfig
} from '../src/runtime/config/index.ts';

describe('runtime config loader secret reference validation', () => {
  it('rejects env secret refs mixed with plaintext override fields', () => {
    const result = validateProject02RuntimeConfig({
      version: runtimeConfigVersion,
      plugins: {
        foo: {
          config: {
            apiKey: {
              $env: 'PROJECT02_TEST_API_KEY',
              $plaintextSecret: 'leaked-secret'
            }
          }
        }
      }
    });

    expect(result.config).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_value_invalid',
          path: 'plugins.foo.config.apiKey'
        })
      ])
    );
  });

  it('rejects env secret refs with unknown fields', () => {
    const result = validateProject02RuntimeConfig({
      version: runtimeConfigVersion,
      plugins: {
        foo: {
          config: {
            apiKey: {
              $env: 'PROJECT02_TEST_API_KEY',
              description: 'test key',
              unexpected: 'not supported'
            }
          }
        }
      }
    });

    expect(result.config).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_value_invalid',
          path: 'plugins.foo.config.apiKey'
        })
      ])
    );
  });

  it('accepts env secret refs with an optional description', () => {
    const result = validateProject02RuntimeConfig({
      version: runtimeConfigVersion,
      plugins: {
        foo: {
          config: {
            apiKey: {
              $env: 'PROJECT02_TEST_API_KEY',
              description: 'test key'
            }
          }
        }
      }
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.config?.plugins?.['foo']?.config?.['apiKey']).toEqual({
      $env: 'PROJECT02_TEST_API_KEY',
      description: 'test key'
    });
  });

  it('preserves valid plaintext secret override loading behavior', () => {
    const result = validateProject02RuntimeConfig({
      version: runtimeConfigVersion,
      plugins: {
        foo: {
          config: {
            apiKey: {
              $plaintextSecret: 'test-only-secret',
              allowPlaintextSecret: true,
              justification: 'test-only override'
            }
          }
        }
      }
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.config?.plugins?.['foo']?.config?.['apiKey']).toEqual({
      $plaintextSecret: 'test-only-secret',
      allowPlaintextSecret: true,
      justification: 'test-only override'
    });
  });

  it('deeply snapshots accepted nested config values', () => {
    const nested = {
      object: { value: 'before' },
      array: [{ value: 'before' }]
    };
    const result = validateProject02RuntimeConfig({
      version: runtimeConfigVersion,
      plugins: {
        foo: {
          config: { nested }
        }
      }
    });

    nested.object.value = 'after';
    const firstArrayItem = nested.array[0];

    if (firstArrayItem === undefined) {
      throw new Error('Expected nested config array fixture item.');
    }

    firstArrayItem.value = 'after';

    const stored = result.config?.plugins?.['foo']?.config?.['nested'];

    expect(stored).toEqual({
      object: { value: 'before' },
      array: [{ value: 'before' }]
    });
    expect(Object.isFrozen(stored)).toBe(true);
    expect(
      typeof stored === 'object' &&
        stored !== null &&
        !Array.isArray(stored) &&
        Object.isFrozen(Reflect.get(stored, 'object'))
    ).toBe(true);
  });
});
