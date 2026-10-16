import {mkdirSync, writeFileSync} from 'node:fs';
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
    const homeWithDirectory = join(root, 'directory');
    const homeWithMalformed = join(root, 'malformed');
    const homeWithInvalidSchema = join(root, 'invalid-schema');

    mkdirSync(join(homeWithDirectory, 'config.json'), {recursive: true});
    mkdirSync(homeWithMalformed);
    writeFileSync(join(homeWithMalformed, 'config.json'), '{', 'utf8');
    mkdirSync(homeWithInvalidSchema);
    writeFileSync(
      join(homeWithInvalidSchema, 'config.json'),
      JSON.stringify({version: 'project02.config.unknown'}),
      'utf8',
    );

    expect(
      loadRuntimeConfigForTest({storeRoot: homeWithDirectory}).diagnostics,
    ).toEqual([expect.objectContaining({code: 'runtime_config_read_failed'})]);
    expect(
      loadRuntimeConfigForTest({storeRoot: homeWithMalformed}).diagnostics,
    ).toEqual([
      expect.objectContaining({code: 'runtime_config_malformed_json'}),
    ]);
    expect(
      loadRuntimeConfigForTest({storeRoot: homeWithInvalidSchema}).diagnostics,
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
        contextWindowTokens: -5,
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
        code: 'runtime_config_context_window_tokens_invalid',
        path: 'project02.contextWindowTokens',
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

  it('accepts a positive whole context window and rejects anything else', () => {
    expect(
      validateProject02RuntimeConfig({
        version: runtimeConfigVersion,
        project02: {contextWindowTokens: 65536},
      }).diagnostics,
    ).toEqual([]);

    for (const contextWindowTokens of [0, 1.5, '32768']) {
      expect(
        validateProject02RuntimeConfig({
          version: runtimeConfigVersion,
          project02: {contextWindowTokens},
        }).diagnostics,
      ).toEqual([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_context_window_tokens_invalid',
          path: 'project02.contextWindowTokens',
        }),
      ]);
    }
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

  it('loads a connectors stanza as it loads a plugin stanza, and warns of a connector this version does not have', () => {
    const telegram = {
      enabled: false,
      config: {managementBotToken: '123456:AA', mirror: false},
    };
    const loaded = validateProject02RuntimeConfig({
      version: runtimeConfigVersion,
      connectors: {telegram, discord: {enabled: true}},
    });

    expect(loaded.config?.connectors?.['telegram']).toEqual(telegram);
    // The only diagnostic is the unknown id's: the key itself is known.
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'runtime_config_unknown_connector',
        path: 'connectors.discord',
      }),
    ]);
    expect(
      validateProject02RuntimeConfig({
        version: runtimeConfigVersion,
        connectors: {telegram: 'on'},
      }).diagnostics,
    ).toEqual([
      expect.objectContaining({severity: 'error', path: 'connectors.telegram'}),
    ]);
  });
});
