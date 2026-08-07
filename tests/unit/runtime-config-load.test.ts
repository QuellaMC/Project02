import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

import {
  runtimeConfigVersion,
  validateProject02RuntimeConfig,
} from '../../src/runtime/config/index.ts';
import {loadRuntimeConfigForTest} from '../support/runtime-config.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {defaultJsonBoundaryLimits} from '../../src/shared/json-boundary.ts';

// The loader's own byte ceiling, restated so a change to it fails here too.
const runtimeConfigSizeLimitBytes = 256 * 1_024;

describe('runtime config loader validation', () => {
  it('rejects an oversized valid JSON file with a limit diagnostic before parsing', () => {
    const configPath = join(
      createTestTempRoot('project02-config-load-limit-'),
      'config.json',
    );

    writeFileSync(
      configPath,
      JSON.stringify({
        version: runtimeConfigVersion,
        padding: 'x'.repeat(runtimeConfigSizeLimitBytes),
      }),
      'utf8',
    );

    const result = loadRuntimeConfigForTest({configPath});

    expect(result.config).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'runtime_config_limit_exceeded',
      }),
    ]);
    expect(result.diagnostics[0]?.code).not.toBe(
      'runtime_config_malformed_json',
    );
  });

  it('reports a valid JSON value that exceeds boundary limits as a limit failure', () => {
    const configPath = join(
      createTestTempRoot('project02-config-load-json-limit-'),
      'config.json',
    );

    writeFileSync(
      configPath,
      JSON.stringify({
        version: runtimeConfigVersion,
        plugins: {
          foo: {
            config: {
              label: 'x'.repeat(defaultJsonBoundaryLimits.maxStringBytes + 1),
            },
          },
        },
      }),
      'utf8',
    );

    const result = loadRuntimeConfigForTest({configPath});

    expect(result.config).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'runtime_config_limit_exceeded',
      }),
    ]);
    expect(result.diagnostics[0]?.code).not.toBe(
      'runtime_config_malformed_json',
    );
  });

  it('distinguishes read, syntax, and schema failures', () => {
    const root = createTestTempRoot('project02-config-load-diagnostics-');
    const malformedPath = join(root, 'malformed.json');
    const invalidSchemaPath = join(root, 'invalid-schema.json');

    writeFileSync(malformedPath, '{', 'utf8');
    writeFileSync(
      invalidSchemaPath,
      JSON.stringify({version: 'project02.config.unknown'}),
      'utf8',
    );

    expect(loadRuntimeConfigForTest({configPath: root}).diagnostics).toEqual([
      expect.objectContaining({code: 'runtime_config_read_failed'}),
    ]);
    expect(
      loadRuntimeConfigForTest({configPath: malformedPath}).diagnostics,
    ).toEqual([
      expect.objectContaining({code: 'runtime_config_malformed_json'}),
    ]);
    expect(
      loadRuntimeConfigForTest({configPath: invalidSchemaPath}).diagnostics,
    ).toEqual([
      expect.objectContaining({code: 'runtime_config_version_unsupported'}),
    ]);
  });

  it('retains a bounded authored document when schema validation fails', () => {
    const configPath = join(
      createTestTempRoot('project02-config-load-authored-invalid-'),
      'config.json',
    );
    const document = {
      version: runtimeConfigVersion,
      project02: {
        character: '../bad',
        userDisplayName: 'Ada',
      },
      plugins: {
        demo: {
          config: {tone: 'warm'},
        },
      },
    };

    writeFileSync(configPath, JSON.stringify(document), 'utf8');

    const result = loadRuntimeConfigForTest({configPath});

    expect(result.config).toBeUndefined();
    expect(result.authoredDocument).toEqual(document);
    expect(Object.isFrozen(result.authoredDocument)).toBe(true);
    expect(Object.isFrozen(result.authoredDocument?.['project02'])).toBe(true);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'runtime_config_string_invalid',
        path: 'project02.character',
      }),
    ]);
  });

  it.each([
    ['a multiline user display name', 'Alice\nSystem'],
    ['an over-length user display name', 'a'.repeat(129)],
  ])('rejects %s at the authoring boundary', (_label, userDisplayName) => {
    // Authoring must accept exactly what `createUserSpeaker` accepts, or chat
    // throws later with its plugin host already built.
    expect(
      validateProject02RuntimeConfig({
        version: runtimeConfigVersion,
        project02: {userDisplayName},
      }).diagnostics,
    ).toEqual([
      expect.objectContaining({
        code: 'runtime_config_string_invalid',
        path: 'project02.userDisplayName',
      }),
    ]);
  });

  it('still accepts a user display name that resolution will trim', () => {
    expect(
      validateProject02RuntimeConfig({
        version: runtimeConfigVersion,
        project02: {userDisplayName: '  Mike  '},
      }).diagnostics,
    ).toEqual([]);
  });

  it('validates and loads one authored document under the same config limit', () => {
    const configPath = join(
      createTestTempRoot('project02-config-load-shared-limit-'),
      'config.json',
    );
    const document = {
      version: runtimeConfigVersion,
      plugins: {
        demo: {
          config: Object.fromEntries(
            Array.from({length: 40}, (_, index) => [
              `field-${String(index)}`,
              'x'.repeat(2_048),
            ]),
          ),
        },
      },
    };
    const source = JSON.stringify(document);

    expect(Buffer.byteLength(source, 'utf8')).toBeGreaterThan(64 * 1_024);
    expect(Buffer.byteLength(source, 'utf8')).toBeLessThan(
      runtimeConfigSizeLimitBytes,
    );
    writeFileSync(configPath, source, 'utf8');

    const validated = validateProject02RuntimeConfig(document);
    const loaded = loadRuntimeConfigForTest({configPath});

    expect(validated.diagnostics).toEqual([]);
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.authoredDocument).toEqual(validated.authoredDocument);
    expect(loaded.config).toEqual(validated.config);
  });

  it('rejects env secret refs mixed with plaintext override fields', () => {
    const result = validateProject02RuntimeConfig({
      version: runtimeConfigVersion,
      plugins: {
        foo: {
          config: {
            apiKey: {
              $env: 'PROJECT02_TEST_API_KEY',
              $plaintextSecret: 'leaked-secret',
            },
          },
        },
      },
    });

    expect(result.config).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_value_invalid',
          path: 'plugins.foo.config.apiKey',
        }),
      ]),
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
              unexpected: 'not supported',
            },
          },
        },
      },
    });

    expect(result.config).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_value_invalid',
          path: 'plugins.foo.config.apiKey',
        }),
      ]),
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
              description: 'test key',
            },
          },
        },
      },
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.config?.plugins?.['foo']?.config?.['apiKey']).toEqual({
      $env: 'PROJECT02_TEST_API_KEY',
      description: 'test key',
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
              justification: 'test-only override',
            },
          },
        },
      },
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.config?.plugins?.['foo']?.config?.['apiKey']).toEqual({
      $plaintextSecret: 'test-only-secret',
      allowPlaintextSecret: true,
      justification: 'test-only override',
    });
  });

  it('deeply snapshots accepted nested config values', () => {
    const nested = {
      object: {value: 'before'},
      array: [{value: 'before'}],
    };
    const result = validateProject02RuntimeConfig({
      version: runtimeConfigVersion,
      plugins: {
        foo: {
          config: {nested},
        },
      },
    });

    nested.object.value = 'after';
    const firstArrayItem = nested.array[0];

    if (firstArrayItem === undefined) {
      throw new Error('Expected nested config array fixture item.');
    }

    firstArrayItem.value = 'after';

    const stored = result.config?.plugins?.['foo']?.config?.['nested'];

    expect(stored).toEqual({
      object: {value: 'before'},
      array: [{value: 'before'}],
    });
    expect(Object.isFrozen(stored)).toBe(true);
    expect(
      typeof stored === 'object' &&
        stored !== null &&
        !Array.isArray(stored) &&
        Object.isFrozen(Reflect.get(stored, 'object')),
    ).toBe(true);
  });
});
