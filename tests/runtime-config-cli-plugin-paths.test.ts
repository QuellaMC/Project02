import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { describe, expect, it } from 'vitest';
import { createTestTempRoot } from './support/temp-root.ts';
import { runtimeConfigVersion } from '../src/runtime/config/index.ts';
import { runRuntimeConfigCliFromArgs } from '../src/cli/config.ts';
import {
  collect,
  writeRuntimeConfig
} from './support/runtime-config.ts';
import {
  requiredDottedConfigPlugin
} from './support/runtime-config-fixtures.ts';

describe('runtime config CLI plugin paths', () => {
  it('sets, gets, and unsets dotted plugin config field names', async () => {
    const storeRoot = createTestTempRoot('project02-config-dotted-field-');
    const seededStoreRoot = realpathSync.native(storeRoot);
    let stdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        [
          '--store',
          storeRoot,
          'set',
          'plugins.memory.config.api.endpoint',
          'local-endpoint'
        ],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    const afterSet: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(afterSet).toMatchObject({
      plugins: {
        memory: {
          config: {
            'api.endpoint': 'local-endpoint'
          }
        }
      }
    });
    expect(JSON.stringify(afterSet)).not.toContain('"memory.config.api"');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'get', 'plugins.memory.config.api.endpoint'],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);
    expect(JSON.parse(stdout) as unknown).toBe('local-endpoint');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'unset', 'plugins.memory.config.api.endpoint'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    const afterUnset: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(afterUnset).toEqual({
      version: runtimeConfigVersion,
      storeRoot: seededStoreRoot
    });
  });

  it('redacts dotted credential plugin config field names on get', async () => {
    const storeRoot = createTestTempRoot('project02-config-dotted-credential-field-');
    let stdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'set', 'plugins.memory.config.api.key', 'local-key'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    const afterSet: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(afterSet).toMatchObject({
      plugins: {
        memory: {
          config: {
            'api.key': 'local-key'
          }
        }
      }
    });

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'get', 'plugins.memory.config.api.key'],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);
    expect(JSON.parse(stdout) as unknown).toBe('[redacted]');
    expect(stdout).not.toContain('local-key');
  });

  it('sets, gets, and unsets plugin config fields containing config', async () => {
    const storeRoot = createTestTempRoot('project02-config-config-field-');
    const seededStoreRoot = realpathSync.native(storeRoot);
    const path = 'plugins.memory.config.api.config.key';
    let stdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'plugin', 'enable', 'memory'], {
        stdout: collect(() => {}),
        stderr: collect(() => {})
      })
    ).toBe(0);

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'set', path, 'local-key'], {
        stdout: collect(() => {}),
        stderr: collect(() => {})
      })
    ).toBe(0);

    const afterSet: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(afterSet).toMatchObject({
      plugins: {
        memory: {
          enabled: true,
          config: {
            'api.config.key': 'local-key'
          }
        }
      }
    });
    expect(JSON.stringify(afterSet)).not.toContain('"memory.config.api"');

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'get', path], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {})
      })
    ).toBe(0);
    expect(JSON.parse(stdout) as unknown).toBe('local-key');

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'unset', path], {
        stdout: collect(() => {}),
        stderr: collect(() => {})
      })
    ).toBe(0);

    const afterUnset: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(afterUnset).toMatchObject({
      version: runtimeConfigVersion,
      storeRoot: seededStoreRoot,
      plugins: {
        memory: {
          enabled: true
        }
      }
    });
  });

  it('rejects ambiguous first-time plugin config paths containing config segments', async () => {
    for (const path of [
      'plugins.memory.config.api.config.key',
      'plugins.memory.config.config.key',
      'plugins.memory.config.enabled'
    ]) {
      const storeRoot = createTestTempRoot('project02-config-ambiguous-config-');
      let stderr = '';

      expect(
        await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'set', path, 'local-key'], {
          stdout: collect(() => {}),
          stderr: collect((chunk) => {
            stderr += chunk;
          })
        })
      ).toBe(1);

      expect(stderr).toContain('Ambiguous runtime config plugin path');
      expect(stderr).toContain(path);
      expect(existsSync(join(storeRoot, 'config.json'))).toBe(false);
    }
  });

  it('rejects ambiguous known plugin config paths instead of preferring dotted plugin ids', async () => {
    const storeRoot = createTestTempRoot('project02-config-known-ambiguous-config-');
    const path = 'plugins.memory.config.enabled';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'plugin', 'enable', 'memory'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);
    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'plugin', 'enable', 'memory.config'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'set', path, 'true'], {
        stdout: collect(() => {}),
        stderr: collect((chunk) => {
          stderr += chunk;
        })
      })
    ).toBe(1);

    expect(stderr).toContain('Ambiguous runtime config plugin path');
    expect(stderr).toContain(path);
    expect(stderr).toContain('memory');
    expect(stderr).toContain('memory.config');

    const config: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(config).toMatchObject({
      plugins: {
        memory: {
          enabled: true
        },
        'memory.config': {
          enabled: true
        }
      }
    });
    expect(JSON.stringify(config)).not.toContain('"config":{"enabled"');
  });

  it('rejects ambiguous known plugin config paths on get', async () => {
    const configPath = writeRuntimeConfig(
      join(
        createTestTempRoot('project02-config-known-ambiguous-get-'),
        'config.json'
      ),
      {
        plugins: {
          memory: {
            enabled: true,
            config: {
              enabled: true
            }
          },
          'memory.config': {
            enabled: false
          }
        }
      }
    );
    const path = 'plugins.memory.config.enabled';
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(['--config', configPath, 'get', path], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        })
      })
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toContain('Ambiguous runtime config plugin path');
    expect(stderr).toContain(path);
    expect(stderr).toContain('memory');
    expect(stderr).toContain('memory.config');
  });

  it('rejects exact-wrapper get paths that conflict with known plugin config fields', async () => {
    const path = 'plugins.memory.config.api';
    const configPath = writeRuntimeConfig(
      join(
        createTestTempRoot('project02-config-exact-wrapper-ambiguous-get-'),
        'config.json'
      ),
      {
        plugins: {
          memory: {
            config: {
              api: 'field-api'
            }
          },
          'memory.config.api': {
            enabled: true,
            config: {
              backend: 'wrapper-backend'
            }
          }
        }
      }
    );
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(['--config', configPath, 'get', path], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        })
      })
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toContain('Ambiguous runtime config plugin path');
    expect(stderr).toContain(path);
    expect(stderr).toContain('memory');
    expect(stderr).toContain('memory.config.api');
  });

  it('sets, gets, unsets, and checks plugin config fields starting with config', async () => {
    const storeRoot = createTestTempRoot('project02-config-leading-config-field-');
    const seededStoreRoot = realpathSync.native(storeRoot);
    const path = 'plugins.memory.config.config.key';
    const plugin = requiredDottedConfigPlugin('memory', 'config.key');
    const factories = {
      memory: {
        manifest: plugin.manifest,
        create() {
          throw new Error('runtime-config check should not construct plugins');
        }
      }
    };
    let missingStdout = '';
    let getStdout = '';
    let passStdout = '';
    let afterUnsetStdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect((chunk) => {
          missingStdout += chunk;
        }),
        stderr: collect(() => {}),
        factories
      })
    ).toBe(1);
    expect(missingStdout).toContain('runtime_config_required_value_missing');
    expect(missingStdout).toContain(path);

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'plugin', 'enable', 'memory'], {
        stdout: collect(() => {}),
        stderr: collect(() => {})
      })
    ).toBe(0);

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'set', path, 'local-key'], {
        stdout: collect(() => {}),
        stderr: collect(() => {})
      })
    ).toBe(0);

    const afterSet: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(afterSet).toMatchObject({
      plugins: {
        memory: {
          enabled: true,
          config: {
            'config.key': 'local-key'
          }
        }
      }
    });
    expect(JSON.stringify(afterSet)).not.toContain('"memory.config"');

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect((chunk) => {
          passStdout += chunk;
        }),
        stderr: collect(() => {}),
        factories
      })
    ).toBe(0);

    const passOutput = JSON.parse(passStdout) as {
      readonly activationDiagnostics: readonly { readonly code: string }[];
      readonly plugins: readonly {
        readonly pluginId: string;
        readonly activationStatus: string;
        readonly enabled: boolean;
      }[];
    };

    expect(passOutput.activationDiagnostics.map((item) => item.code)).not.toContain(
      'runtime_config_required_value_missing'
    );
    expect(passOutput.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: 'memory',
        activationStatus: 'active',
        enabled: true
      })
    );

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'get', path], {
        stdout: collect((chunk) => {
          getStdout += chunk;
        }),
        stderr: collect(() => {})
      })
    ).toBe(0);
    expect(JSON.parse(getStdout) as unknown).toBe('local-key');

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'unset', path], {
        stdout: collect(() => {}),
        stderr: collect(() => {})
      })
    ).toBe(0);

    const afterUnset: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(afterUnset).toEqual({
      version: runtimeConfigVersion,
      storeRoot: seededStoreRoot,
      plugins: {
        memory: {
          enabled: true
        }
      }
    });

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect((chunk) => {
          afterUnsetStdout += chunk;
        }),
        stderr: collect(() => {}),
        factories
      })
    ).toBe(1);
    expect(afterUnsetStdout).toContain('runtime_config_required_value_missing');
    expect(afterUnsetStdout).toContain(path);
  });

  it('sets, gets, and unsets plugin IDs that contain config segments', async () => {
    const storeRoot = createTestTempRoot('project02-config-plugin-config-id-');
    const path = 'plugins.memory.config.api.config.key';
    let pluginStdout = '';
    let fieldStdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'plugin', 'enable', 'memory.config.api'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'set', path, 'local-key'], {
        stdout: collect(() => {}),
        stderr: collect(() => {})
      })
    ).toBe(0);

    const afterSet: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(afterSet).toMatchObject({
      plugins: {
        'memory.config.api': {
          enabled: true,
          config: {
            key: 'local-key'
          }
        }
      }
    });
    expect(JSON.stringify(afterSet)).not.toContain('"memory":{"config"');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'get', 'plugins.memory.config.api'],
        {
          stdout: collect((chunk) => {
            pluginStdout += chunk;
          }),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);
    expect(JSON.parse(pluginStdout) as unknown).toEqual({
      enabled: true,
      config: {
        key: 'local-key'
      }
    });

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'get', path], {
        stdout: collect((chunk) => {
          fieldStdout += chunk;
        }),
        stderr: collect(() => {})
      })
    ).toBe(0);
    expect(JSON.parse(fieldStdout) as unknown).toBe('local-key');

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'unset', path], {
        stdout: collect(() => {}),
        stderr: collect(() => {})
      })
    ).toBe(0);

    const afterUnset: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(afterUnset).toMatchObject({
      plugins: {
        'memory.config.api': {
          enabled: true
        }
      }
    });
  });

  it('refuses to mutate malformed existing config files', async () => {
    const configRoot = createTestTempRoot('project02-config-malformed-');
    const configPath = join(configRoot, 'config.json');
    const malformedConfig = '{"version":';
    let stderr = '';

    writeFileSync(configPath, malformedConfig, 'utf8');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'set', 'storeRoot', 'next-store'],
        {
          stdout: collect(() => {}),
          stderr: collect((chunk) => {
            stderr += chunk;
          })
        }
      )
    ).toBe(1);

    expect(stderr).toContain('Cannot mutate runtime config because it failed to load');
    expect(stderr).toContain('Runtime config file is not valid JSON');
    expect(readFileSync(configPath, 'utf8')).toBe(malformedConfig);
  });

  it('rejects mutations for the removed enabledPlugins field', async () => {
    const storeRoot = createTestTempRoot('project02-config-removed-set-');
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'set', 'enabledPlugins', '[]'],
        {
          stdout: collect(() => {}),
          stderr: collect((chunk) => {
            stderr += chunk;
          })
        }
      )
    ).toBe(1);
    expect(stderr).toContain('Unsupported runtime config path: enabledPlugins');
    expect(existsSync(join(storeRoot, 'config.json'))).toBe(false);
  });

  it('refuses to write mutations that would fail runtime config validation', async () => {
    const configRoot = createTestTempRoot('project02-config-invalid-env-ref-');
    const configPath = writeRuntimeConfig(join(configRoot, 'config.json'), {
      storeRoot: 'original-store'
    });
    const originalConfig = readFileSync(configPath, 'utf8');
    let envRefStderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'set', 'plugins.foo.config.bar', '{"$env":""}'],
        {
          stdout: collect(() => {}),
          stderr: collect((chunk) => {
            envRefStderr += chunk;
          })
        }
      )
    ).toBe(1);
    expect(envRefStderr).toContain(
      'Cannot mutate runtime config because the mutation would produce invalid config'
    );
    expect(envRefStderr).toContain('Runtime config values must be JSON-compatible');
    expect(readFileSync(configPath, 'utf8')).toBe(originalConfig);
  });

  it('writes dotenv secrets so quotes and backslashes round-trip through env loading', async () => {
    const storeRoot = createTestTempRoot('project02-config-secret-escaping-');
    const envVar = 'PROJECT02_SECRET_ROUNDTRIP_QUOTES';
    const secretValue = String.raw`single' double" slash\ value`;

    Reflect.deleteProperty(process.env, envVar);
    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'cloudApiKey', envVar],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
          env: { [envVar]: secretValue }
        }
      )
    ).toBe(0);

    const envPath = join(storeRoot, '.env');

    expect(readFileSync(envPath, 'utf8')).toBe(`${envVar}=\`${secretValue}\`\n`);

    try {
      loadEnvFile(envPath);
      expect(process.env[envVar]).toBe(secretValue);
    } finally {
      Reflect.deleteProperty(process.env, envVar);
    }
  });

  it('writes backslash-only dotenv secrets with a non-escaping delimiter', async () => {
    const storeRoot = createTestTempRoot('project02-config-secret-slashes-');
    const envVar = 'PROJECT02_SECRET_ROUNDTRIP_SLASHES';
    const secretValue = String.raw`token\npart C:\Users\mira\AppData\Local\project02`;

    Reflect.deleteProperty(process.env, envVar);
    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'cloudApiKey', envVar],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
          env: { [envVar]: secretValue }
        }
      )
    ).toBe(0);

    const envPath = join(storeRoot, '.env');

    expect(readFileSync(envPath, 'utf8')).toBe(`${envVar}='${secretValue}'\n`);

    try {
      loadEnvFile(envPath);
      expect(process.env[envVar]).toBe(secretValue);
    } finally {
      Reflect.deleteProperty(process.env, envVar);
    }
  });

  it('rejects carriage-return dotenv secrets without changing config or env files', async () => {
    const storeRoot = createTestTempRoot('project02-config-secret-crlf-');
    const envVar = 'PROJECT02_SECRET_CRLF_PRIVATE_KEY';
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'mem0-local': {
          config: {
            cloudApiKey: { $env: 'PROJECT02_EXISTING_SECRET' }
          }
        }
      }
    });
    const envPath = join(storeRoot, '.env');
    const originalConfig = readFileSync(configPath, 'utf8');
    const originalEnv = [
      '# keep existing env material',
      'PROJECT02_EXISTING_SECRET="keep-existing"',
      ''
    ].join('\n');
    const secretValue = '-----BEGIN PRIVATE KEY-----\r\nsecret-line\r\n-----END PRIVATE KEY-----';
    let stdout = '';
    let stderr = '';

    writeFileSync(envPath, originalEnv, 'utf8');
    Reflect.deleteProperty(process.env, envVar);

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'cloudApiKey', envVar],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect((chunk) => {
            stderr += chunk;
          }),
          env: { [envVar]: secretValue }
        }
      )
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toContain('does not preserve carriage returns');
    expect(readFileSync(configPath, 'utf8')).toBe(originalConfig);
    expect(readFileSync(envPath, 'utf8')).toBe(originalEnv);
  });

  it('rejects unquoted dotenv fallback secrets that start with a quote delimiter', async () => {
    const storeRoot = createTestTempRoot('project02-config-secret-quote-start-');
    const envVar = 'PROJECT02_SECRET_QUOTE_START';
    const secretValue = `"starts-and-ends"with'single-and\`backtick`;
    let stdout = '';
    let stderr = '';

    Reflect.deleteProperty(process.env, envVar);
    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'cloudApiKey', envVar],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect((chunk) => {
            stderr += chunk;
          }),
          env: { [envVar]: secretValue }
        }
      )
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toContain(
      'no non-escaping dotenv quote delimiter and cannot be safely written as an unquoted value'
    );
    expect(existsSync(join(storeRoot, '.env'))).toBe(false);
    expect(existsSync(join(storeRoot, 'config.json'))).toBe(false);
  });

  it('rotates multi-line dotenv secrets without leaving stale continuation lines', async () => {
    const storeRoot = createTestTempRoot('project02-config-secret-rotate-');
    const envVar = 'PROJECT02_SECRET_ROTATION_MULTILINE';
    const otherEnvVar = 'PROJECT02_SECRET_ROTATION_OTHER';
    const oldSecret = 'old first line\nold second line\nold third line';
    const newSecret = 'new first line\nnew second line';
    const envPath = join(storeRoot, '.env');

    Reflect.deleteProperty(process.env, envVar);
    Reflect.deleteProperty(process.env, otherEnvVar);
    writeFileSync(
      envPath,
      `# keep comment\n${otherEnvVar}="other-value"\n${envVar}="${oldSecret}"\n`,
      'utf8'
    );

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'cloudApiKey', envVar],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
          env: { [envVar]: newSecret }
        }
      )
    ).toBe(0);

    const envFile = readFileSync(envPath, 'utf8');

    expect(envFile).toContain('# keep comment');
    expect(envFile).toContain(`${otherEnvVar}="other-value"`);
    expect(envFile).toContain(`${envVar}="${newSecret}"`);
    expect(envFile).not.toContain('old first line');
    expect(envFile).not.toContain('old second line');
    expect(envFile).not.toContain('old third line');

    try {
      loadEnvFile(envPath);
      expect(process.env[envVar]).toBe(newSecret);
      expect(process.env[otherEnvVar]).toBe('other-value');
    } finally {
      Reflect.deleteProperty(process.env, envVar);
      Reflect.deleteProperty(process.env, otherEnvVar);
    }
  });

  it('preserves later dotenv entries when rotating an unclosed quoted secret', async () => {
    const storeRoot = createTestTempRoot('project02-config-secret-unclosed-');
    const envVar = 'PROJECT02_SECRET_ROTATION_UNCLOSED';
    const otherEnvVar = 'PROJECT02_SECRET_ROTATION_UNCLOSED_OTHER';
    const newSecret = 'new top-level secret';
    const envPath = join(storeRoot, '.env');

    Reflect.deleteProperty(process.env, envVar);
    Reflect.deleteProperty(process.env, otherEnvVar);
    writeFileSync(envPath, [`${envVar}='old`, `${otherEnvVar}=keep`, ''].join('\n'), 'utf8');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'cloudApiKey', envVar],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
          env: { [envVar]: newSecret }
        }
      )
    ).toBe(0);

    const envFile = readFileSync(envPath, 'utf8');

    expect(envFile).toBe(
      [`${otherEnvVar}=keep`, `${envVar}="${newSecret}"`, ''].join('\n')
    );

    try {
      loadEnvFile(envPath);
      expect(process.env[envVar]).toBe(newSecret);
      expect(process.env[otherEnvVar]).toBe('keep');
    } finally {
      Reflect.deleteProperty(process.env, envVar);
      Reflect.deleteProperty(process.env, otherEnvVar);
    }
  });

  it('preserves unrelated multiline dotenv blocks when rotating another secret', async () => {
    const storeRoot = createTestTempRoot('project02-config-secret-rotate-unrelated-block-');
    const envVar = 'PROJECT02_SECRET_ROTATION_API_KEY';
    const otherEnvVar = 'PROJECT02_SECRET_ROTATION_OTHER_BLOCK';
    const tailEnvVar = 'PROJECT02_SECRET_ROTATION_TAIL';
    const oldSecret = 'old top-level secret';
    const newSecret = 'new top-level secret';
    const preservedBlock = `${otherEnvVar}='first\n\n${envVar}=inside\nlast'`;
    const envPath = join(storeRoot, '.env');

    Reflect.deleteProperty(process.env, envVar);
    Reflect.deleteProperty(process.env, otherEnvVar);
    Reflect.deleteProperty(process.env, tailEnvVar);
    writeFileSync(
      envPath,
      [
        '# keep unrelated multiline block',
        preservedBlock,
        `${tailEnvVar}=visible-tail`,
        `${envVar}="${oldSecret}"`,
        ''
      ].join('\n'),
      'utf8'
    );

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'cloudApiKey', envVar],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
          env: { [envVar]: newSecret }
        }
      )
    ).toBe(0);

    const envFile = readFileSync(envPath, 'utf8');

    expect(envFile).toBe(
      [
        '# keep unrelated multiline block',
        preservedBlock,
        `${tailEnvVar}=visible-tail`,
        `${envVar}="${newSecret}"`,
        ''
      ].join('\n')
    );
    expect(envFile).not.toContain(oldSecret);

    try {
      loadEnvFile(envPath);
      expect(process.env[envVar]).toBe(newSecret);
      expect(process.env[otherEnvVar]).toBe(`first\n\n${envVar}=inside\nlast`);
      expect(process.env[tailEnvVar]).toBe('visible-tail');
    } finally {
      Reflect.deleteProperty(process.env, envVar);
      Reflect.deleteProperty(process.env, otherEnvVar);
      Reflect.deleteProperty(process.env, tailEnvVar);
    }
  });

  it('rotates exported dotenv secrets without preserving stale assignment blocks', async () => {
    const storeRoot = createTestTempRoot('project02-config-secret-export-');
    const envVar = 'PROJECT02_SECRET_ROTATION_EXPORTED';
    const otherEnvVar = 'PROJECT02_SECRET_ROTATION_EXPORTED_OTHER';
    const oldSecret = 'old exported first line\nold exported second line';
    const newSecret = 'new exported first line\nnew exported second line';
    const envPath = join(storeRoot, '.env');

    Reflect.deleteProperty(process.env, envVar);
    Reflect.deleteProperty(process.env, otherEnvVar);
    writeFileSync(
      envPath,
      [
        '# keep exported comment',
        `export ${envVar}=old-unquoted-exported`,
        `${otherEnvVar}="other-exported-value"`,
        `  export ${envVar}="${oldSecret}"`,
        ''
      ].join('\n'),
      'utf8'
    );

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'cloudApiKey', envVar],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
          env: { [envVar]: newSecret }
        }
      )
    ).toBe(0);

    const envFile = readFileSync(envPath, 'utf8');

    expect(envFile).toContain('# keep exported comment');
    expect(envFile).toContain(`${otherEnvVar}="other-exported-value"`);
    expect(envFile).toContain(`${envVar}="${newSecret}"`);
    expect(envFile).not.toContain(`export ${envVar}=`);
    expect(envFile).not.toContain(`export ${envVar}="`);
    expect(envFile).not.toContain('old-unquoted-exported');
    expect(envFile).not.toContain('old exported first line');
    expect(envFile).not.toContain('old exported second line');

    try {
      loadEnvFile(envPath);
      expect(process.env[envVar]).toBe(newSecret);
      expect(process.env[otherEnvVar]).toBe('other-exported-value');
    } finally {
      Reflect.deleteProperty(process.env, envVar);
      Reflect.deleteProperty(process.env, otherEnvVar);
    }
  });

  it('fails get when config loading reports errors', async () => {
    const configPath = writeRuntimeConfig(
      join(createTestTempRoot('project02-config-invalid-get-'), 'config.json'),
      {
        storeRoot: 42
      }
    );
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(['--config', configPath, 'get', 'storeRoot'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        })
      })
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toContain('Runtime config field must be a non-empty string.');
  });

  it('gets dotted plugin ID config paths', async () => {
    const configPath = writeRuntimeConfig(
      join(createTestTempRoot('project02-config-dotted-get-'), 'config.json'),
      {
        plugins: {
          'memory.recall': {
            config: {
              backend: 'local'
            }
          }
        }
      }
    );
    let stdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'get', 'plugins.memory.recall.config.backend'],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(JSON.parse(stdout) as unknown).toBe('local');
  });

  it('gets terminal plugin config objects for plain and dotted plugin IDs', async () => {
    const configPath = writeRuntimeConfig(
      join(
        createTestTempRoot('project02-config-object-get-'),
        'config.json'
      ),
      {
        plugins: {
          foo: {
            config: {
              backend: 'local',
              options: {
                mode: 'sync'
              }
            }
          },
          'memory.recall': {
            config: {
              backend: 'vector',
              topK: 5
            }
          }
        }
      }
    );
    let plainStdout = '';
    let dottedStdout = '';
    let pluginStdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'get', 'plugins.foo.config'],
        {
          stdout: collect((chunk) => {
            plainStdout += chunk;
          }),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(JSON.parse(plainStdout) as unknown).toEqual({
      backend: 'local',
      options: {
        mode: 'sync'
      }
    });

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'get', 'plugins.memory.recall.config'],
        {
          stdout: collect((chunk) => {
            dottedStdout += chunk;
          }),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(JSON.parse(dottedStdout) as unknown).toEqual({
      backend: 'vector',
      topK: 5
    });

    expect(
      await runRuntimeConfigCliFromArgs(['--config', configPath, 'get', 'plugins.foo'], {
        stdout: collect((chunk) => {
          pluginStdout += chunk;
        }),
        stderr: collect(() => {})
      })
    ).toBe(0);

    expect(JSON.parse(pluginStdout) as unknown).toEqual({
      config: {
        backend: 'local',
        options: {
          mode: 'sync'
        }
      }
    });
  });
});
