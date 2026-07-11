import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestTempRoot } from './support/temp-root.ts';
import {
  defaultRuntimeConfigPath,
  runtimeConfigEnvVarName,
  runtimeConfigVersion
} from '../src/runtime/config/index.ts';
import { runRuntimeConfigCliFromArgs } from '../src/cli/config.ts';
import {
  collect,
  writeRuntimeConfig
} from './support/runtime-config.ts';
import {
  requiredDottedConfigPlugin,
  requiredSecretPlugin,
  restoreProcessEnvValue
} from './support/runtime-config-fixtures.ts';

describe('runtime config CLI reads and checks', () => {
  it('sets and unsets plugin config fields named enabled literally', async () => {
    const storeRoot = createTestTempRoot('project02-config-enabled-field-');
    const seededStoreRoot = realpathSync.native(storeRoot);

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'plugin', 'enable', 'memory'], {
        stdout: collect(() => {}),
        stderr: collect(() => {})
      })
    ).toBe(0);

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'set', 'plugins.memory.config.enabled', 'true'],
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
          enabled: true,
          config: {
            enabled: true
          }
        }
      }
    });
    expect(JSON.stringify(afterSet)).not.toContain('"memory.config"');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'unset', 'plugins.memory.config.enabled'],
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
      storeRoot: seededStoreRoot,
      plugins: {
        memory: {
          enabled: true
        }
      }
    });
  });

  it('drops empty plugin wrappers after unsetting the last plugin field', async () => {
    const storeRoot = createTestTempRoot('project02-config-unset-empty-');
    const seededStoreRoot = realpathSync.native(storeRoot);
    let enabledUnsetCheckStdout = '';
    let configUnsetCheckStdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'plugin', 'enable', 'typo'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'unset', 'plugins.typo.enabled'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(JSON.parse(readFileSync(join(storeRoot, 'config.json'), 'utf8')) as unknown)
      .toEqual({ version: runtimeConfigVersion, storeRoot: seededStoreRoot });

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect((chunk) => {
          enabledUnsetCheckStdout += chunk;
        }),
        stderr: collect(() => {})
      })
    ).toBe(0);
    expect(enabledUnsetCheckStdout).not.toContain('runtime_config_unknown_plugin');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'set', 'plugins.typo.config.backend', 'local'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'unset', 'plugins.typo.config.backend'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(JSON.parse(readFileSync(join(storeRoot, 'config.json'), 'utf8')) as unknown)
      .toEqual({ version: runtimeConfigVersion, storeRoot: seededStoreRoot });

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect((chunk) => {
          configUnsetCheckStdout += chunk;
        }),
        stderr: collect(() => {})
      })
    ).toBe(0);
    expect(configUnsetCheckStdout).not.toContain('runtime_config_unknown_plugin');
  });

  it('reports activation warnings from runtime config check', async () => {
    const storeRoot = createTestTempRoot('project02-config-check-');
    let stdout = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'unknown-plugin': {
          enabled: true
        }
      }
    });

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {})
      })
    ).toBe(0);
    expect(stdout).toContain('"activationDiagnostics"');
    expect(stdout).toContain('"runtime_config_unknown_plugin"');
  });

  it('reports check config load errors before runtime env file errors', async () => {
    const storeRoot = createTestTempRoot('project02-config-check-load-error-before-env-');
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      storeRoot: 42
    });
    mkdirSync(join(storeRoot, '.env'));

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        })
      })
    ).toBe(1);

    const output = JSON.parse(stdout) as {
      readonly runtimeConfig: {
        readonly diagnostics: readonly {
          readonly code: string;
          readonly path?: string;
        }[];
      };
      readonly activationDiagnostics: readonly {
        readonly code: string;
        readonly path?: string;
      }[];
    };

    expect(stderr).toBe('');
    expect(output.runtimeConfig.diagnostics[0]).toMatchObject({
      code: 'runtime_config_string_invalid',
      path: 'storeRoot'
    });
    expect(output.activationDiagnostics[0]).toMatchObject({
      code: 'runtime_config_string_invalid',
      path: 'storeRoot'
    });
    expect(stdout).not.toContain('Could not load runtime config env file');
    expect(stderr).not.toContain('Could not load runtime config env file');
  });

  it('reports check activation config errors before runtime env file errors', async () => {
    const storeRoot = createTestTempRoot('project02-config-check-activation-before-env-');
    const plugin = requiredDottedConfigPlugin('memory.required-config', 'endpoint');
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true
        }
      }
    });
    mkdirSync(join(storeRoot, '.env'));

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        }),
        factories: {
          [plugin.manifest.id]: {
            manifest: plugin.manifest,
            create() {
              throw new Error('runtime-config check should not construct plugins');
            }
          }
        }
      })
    ).toBe(1);

    const output = JSON.parse(stdout) as {
      readonly activationDiagnostics: readonly {
        readonly code: string;
        readonly path?: string;
      }[];
    };

    expect(stderr).toBe('');
    expect(output.activationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_required_value_missing',
          path: `plugins.${plugin.manifest.id}.config.endpoint`
        })
      ])
    );
    expect(stdout).not.toContain('Could not load runtime config env file');
  });

  it('reports explicit check config load errors before unrelated cwd dotenv errors', async () => {
    const cwdRoot = createTestTempRoot('project02-config-check-cwd-dotenv-error-');
    const storeRoot = createTestTempRoot('project02-config-check-selected-store-error-');
    const configPath = join(
      createTestTempRoot('project02-config-check-selected-path-error-'),
      'runtime.json'
    );
    const previousCwd = process.cwd();

    writeRuntimeConfig(defaultRuntimeConfigPath(storeRoot), {
      storeRoot: 42
    });
    writeRuntimeConfig(configPath, {
      storeRoot: 42
    });
    mkdirSync(join(cwdRoot, '.env'));

    try {
      process.chdir(cwdRoot);

      for (const example of [
        ['--store', storeRoot, 'check'],
        ['--config', configPath, 'check']
      ] as const) {
        let stdout = '';
        let stderr = '';

        expect(
          await runRuntimeConfigCliFromArgs(example, {
            stdout: collect((chunk) => {
              stdout += chunk;
            }),
            stderr: collect((chunk) => {
              stderr += chunk;
            })
          })
        ).toBe(1);

        const output = JSON.parse(stdout) as {
          readonly runtimeConfig: {
            readonly diagnostics: readonly {
              readonly code: string;
              readonly path?: string;
            }[];
          };
          readonly activationDiagnostics: readonly {
            readonly code: string;
            readonly path?: string;
          }[];
        };

        expect(stderr).toBe('');
        expect(output.runtimeConfig.diagnostics[0]).toMatchObject({
          code: 'runtime_config_string_invalid',
          path: 'storeRoot'
        });
        expect(output.activationDiagnostics[0]).toMatchObject({
          code: 'runtime_config_string_invalid',
          path: 'storeRoot'
        });
        expect(stdout).not.toContain('Could not load .env file');
        expect(stderr).not.toContain('Could not load .env file');
      }
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('reports env-selected check config load errors before unrelated cwd dotenv errors', async () => {
    const cwdRoot = createTestTempRoot('project02-config-check-env-cwd-dotenv-error-');
    const storeRoot = createTestTempRoot('project02-config-check-env-selected-store-error-');
    const configPath = defaultRuntimeConfigPath(storeRoot);
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(configPath, {
      storeRoot: 42
    });
    mkdirSync(join(cwdRoot, '.env'));

    try {
      process.env[runtimeConfigEnvVarName] = configPath;
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(['check'], {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect((chunk) => {
            stderr += chunk;
          })
        })
      ).toBe(1);

      const output = JSON.parse(stdout) as {
        readonly runtimeConfig: {
          readonly diagnostics: readonly {
            readonly code: string;
            readonly path?: string;
          }[];
        };
        readonly activationDiagnostics: readonly {
          readonly code: string;
          readonly path?: string;
        }[];
      };

      expect(stderr).toBe('');
      expect(output.runtimeConfig.diagnostics[0]).toMatchObject({
        code: 'runtime_config_string_invalid',
        path: 'storeRoot'
      });
      expect(output.activationDiagnostics[0]).toMatchObject({
        code: 'runtime_config_string_invalid',
        path: 'storeRoot'
      });
      expect(stdout).not.toContain('Could not load .env file');
      expect(stderr).not.toContain('Could not load .env file');
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
    }
  });

  it('resolves check secrets from each runtime env file without leaking to later stores', async () => {
    const storeRoot = createTestTempRoot('project02-config-check-env-');
    const laterStoreRoot = createTestTempRoot('project02-config-check-env-later-');
    const envVar = 'PROJECT02_CHECK_ENV_FILE_SECRET_3447850555';
    const secretValue = 'from-runtime-env-file';
    const plugin = requiredSecretPlugin();
    let stdout = '';
    let laterStdout = '';
    let factoryCalls = 0;
    let laterFactoryCalls = 0;

    Reflect.deleteProperty(process.env, envVar);
    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {
            apiKey: { $env: envVar }
          }
        }
      }
    });
    writeFileSync(join(storeRoot, '.env'), `${envVar}="${secretValue}"\n`, 'utf8');
    writeRuntimeConfig(join(laterStoreRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {
            apiKey: { $env: envVar }
          }
        }
      }
    });

    try {
      expect(
        await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect(() => {}),
          factories: {
            [plugin.manifest.id]: {
              manifest: plugin.manifest,
              create() {
                factoryCalls += 1;
                throw new Error('runtime-config check should not construct plugins');
              }
            }
          }
        })
      ).toBe(0);

      const output = JSON.parse(stdout) as {
        readonly activationDiagnostics: readonly { readonly code: string }[];
        readonly plugins: readonly {
          readonly pluginId: string;
          readonly activationStatus: string;
          readonly enabled: boolean;
        }[];
      };

      expect(factoryCalls).toBe(0);
      expect(output.activationDiagnostics.map((item) => item.code)).not.toContain(
        'runtime_config_required_secret_missing'
      );
      expect(output.plugins).toContainEqual(
        expect.objectContaining({
          pluginId: plugin.manifest.id,
          activationStatus: 'active',
          enabled: true
        })
      );
      expect(stdout).not.toContain(secretValue);
      expect(process.env[envVar]).toBeUndefined();

      expect(
        await runRuntimeConfigCliFromArgs(['--store', laterStoreRoot, 'check'], {
          stdout: collect((chunk) => {
            laterStdout += chunk;
          }),
          stderr: collect(() => {}),
          factories: {
            [plugin.manifest.id]: {
              manifest: plugin.manifest,
              create() {
                laterFactoryCalls += 1;
                throw new Error('missing-secret check should not construct plugins');
              }
            }
          }
        })
      ).toBe(1);
      expect(laterFactoryCalls).toBe(0);
      expect(laterStdout).toContain('runtime_config_required_secret_missing');
      expect(laterStdout).not.toContain(secretValue);
    } finally {
      Reflect.deleteProperty(process.env, envVar);
    }
  });

  it('uses cwd dotenv defaults for unflagged runtime config check secrets', async () => {
    const cwdRoot = createTestTempRoot('project02-config-check-cwd-env-');
    const storeRoot = createTestTempRoot('project02-config-check-cwd-store-');
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    const envVar = 'PROJECT02_CHECK_CWD_DOTENV_SECRET_3449004103';
    const previousEnvValue = process.env[envVar];
    const secretValue = 'from-cwd-dotenv';
    const plugin = requiredSecretPlugin();
    let stdout = '';
    let factoryCalls = 0;

    Reflect.deleteProperty(process.env, envVar);
    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {
            apiKey: { $env: envVar }
          }
        }
      }
    });
    writeFileSync(
      join(cwdRoot, '.env'),
      `${runtimeConfigEnvVarName}=${join(storeRoot, 'config.json')}\n${envVar}="${secretValue}"\n`,
      'utf8'
    );

    try {
      Reflect.deleteProperty(process.env, runtimeConfigEnvVarName);
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(['check'], {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect(() => {}),
          factories: {
            [plugin.manifest.id]: {
              manifest: plugin.manifest,
              create() {
                factoryCalls += 1;
                throw new Error('runtime-config check should not construct plugins');
              }
            }
          }
        })
      ).toBe(0);

      const output = JSON.parse(stdout) as {
        readonly activationDiagnostics: readonly { readonly code: string }[];
        readonly plugins: readonly {
          readonly pluginId: string;
          readonly activationStatus: string;
          readonly enabled: boolean;
        }[];
      };

      expect(factoryCalls).toBe(0);
      expect(output.activationDiagnostics.map((item) => item.code)).not.toContain(
        'runtime_config_required_secret_missing'
      );
      expect(output.plugins).toContainEqual(
        expect.objectContaining({
          pluginId: plugin.manifest.id,
          activationStatus: 'active',
          enabled: true
        })
      );
      expect(stdout).not.toContain(secretValue);
      expect(process.env[envVar]).toBeUndefined();
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
      restoreProcessEnvValue(envVar, previousEnvValue);
    }
  });

  it('does not use cwd dotenv secrets for explicit runtime config check locations', async () => {
    const cwdRoot = createTestTempRoot('project02-config-check-explicit-cwd-env-');
    const storeRoot = createTestTempRoot('project02-config-check-explicit-store-');
    const configPath = join(storeRoot, 'config.json');
    const previousCwd = process.cwd();
    const envVar = 'PROJECT02_CHECK_EXPLICIT_CWD_DOTENV_SECRET_3450049746';
    const previousEnvValue = process.env[envVar];
    const plugin = requiredSecretPlugin();

    Reflect.deleteProperty(process.env, envVar);
    writeRuntimeConfig(configPath, {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {
            apiKey: { $env: envVar }
          }
        }
      }
    });
    writeFileSync(join(cwdRoot, '.env'), `${envVar}="from-cwd-dotenv"\n`, 'utf8');

    try {
      process.chdir(cwdRoot);

      for (const args of [
        ['--store', storeRoot, 'check'],
        ['--config', configPath, 'check']
      ] as const) {
        let stdout = '';
        let factoryCalls = 0;

        expect(
          await runRuntimeConfigCliFromArgs(args, {
            stdout: collect((chunk) => {
              stdout += chunk;
            }),
            stderr: collect(() => {}),
            factories: {
              [plugin.manifest.id]: {
                manifest: plugin.manifest,
                create() {
                  factoryCalls += 1;
                  throw new Error('runtime-config check should not construct plugins');
                }
              }
            }
          })
        ).toBe(1);

        expect(factoryCalls).toBe(0);
        expect(stdout).toContain('runtime_config_required_secret_missing');
        expect(stdout).not.toContain('from-cwd-dotenv');
      }
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(envVar, previousEnvValue);
    }
  });

  it('keeps runtime env file values ahead of cwd dotenv defaults during check', async () => {
    const cwdRoot = createTestTempRoot('project02-config-check-cwd-env-override-');
    const storeRoot = createTestTempRoot('project02-config-check-store-env-override-');
    const previousCwd = process.cwd();
    const envVar = 'PROJECT02_CHECK_STORE_OVER_CWD_SECRET_3449004103';
    const previousEnvValue = process.env[envVar];
    const secretValue = 'from-cwd-dotenv';
    const plugin = requiredSecretPlugin();
    let stdout = '';
    let factoryCalls = 0;

    Reflect.deleteProperty(process.env, envVar);
    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {
            apiKey: { $env: envVar }
          }
        }
      }
    });
    writeFileSync(join(cwdRoot, '.env'), `${envVar}="${secretValue}"\n`, 'utf8');
    writeFileSync(join(storeRoot, '.env'), `${envVar}=\n`, 'utf8');

    try {
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect(() => {}),
          factories: {
            [plugin.manifest.id]: {
              manifest: plugin.manifest,
              create() {
                factoryCalls += 1;
                throw new Error('runtime-config check should not construct plugins');
              }
            }
          }
        })
      ).toBe(1);

      expect(factoryCalls).toBe(0);
      expect(stdout).toContain('runtime_config_required_secret_missing');
      expect(stdout).not.toContain(secretValue);
      expect(process.env[envVar]).toBeUndefined();
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(envVar, previousEnvValue);
    }
  });

  it('keeps process env values ahead of cwd dotenv defaults during check', async () => {
    const cwdRoot = createTestTempRoot('project02-config-check-process-env-');
    const storeRoot = createTestTempRoot('project02-config-check-process-store-');
    const previousCwd = process.cwd();
    const envVar = 'PROJECT02_CHECK_PROCESS_OVER_CWD_SECRET_3449004103';
    const previousEnvValue = process.env[envVar];
    const secretValue = 'from-process-env';
    const plugin = requiredSecretPlugin();
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {
            apiKey: { $env: envVar }
          }
        }
      }
    });
    writeFileSync(join(cwdRoot, '.env'), `${envVar}=\n`, 'utf8');

    try {
      process.env[envVar] = secretValue;
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect(() => {}),
          factories: {
            [plugin.manifest.id]: {
              manifest: plugin.manifest,
              create() {
                factoryCalls += 1;
                throw new Error('runtime-config check should not construct plugins');
              }
            }
          }
        })
      ).toBe(0);

      const output = JSON.parse(stdout) as {
        readonly activationDiagnostics: readonly { readonly code: string }[];
        readonly plugins: readonly {
          readonly pluginId: string;
          readonly activationStatus: string;
          readonly enabled: boolean;
        }[];
      };

      expect(factoryCalls).toBe(0);
      expect(output.activationDiagnostics.map((item) => item.code)).not.toContain(
        'runtime_config_required_secret_missing'
      );
      expect(output.plugins).toContainEqual(
        expect.objectContaining({
          pluginId: plugin.manifest.id,
          activationStatus: 'active',
          enabled: true
        })
      );
      expect(stdout).not.toContain(secretValue);
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(envVar, previousEnvValue);
    }
  });

  it('keeps supplied check env values ahead of runtime env file values', async () => {
    const storeRoot = createTestTempRoot('project02-config-check-env-precedence-');
    const envVar = 'PROJECT02_CHECK_SUPPLIED_ENV_SECRET_3447850555';
    const suppliedSecretValue = 'from-supplied-env';
    const plugin = requiredSecretPlugin();
    let stdout = '';
    let factoryCalls = 0;

    Reflect.deleteProperty(process.env, envVar);
    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {
            apiKey: { $env: envVar }
          }
        }
      }
    });
    writeFileSync(join(storeRoot, '.env'), `${envVar}=\n`, 'utf8');

    try {
      expect(
        await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect(() => {}),
          env: { [envVar]: suppliedSecretValue },
          factories: {
            [plugin.manifest.id]: {
              manifest: plugin.manifest,
              create() {
                factoryCalls += 1;
                throw new Error('runtime-config check should not construct plugins');
              }
            }
          }
        })
      ).toBe(0);

      const output = JSON.parse(stdout) as {
        readonly activationDiagnostics: readonly { readonly code: string }[];
        readonly plugins: readonly {
          readonly pluginId: string;
          readonly activationStatus: string;
          readonly enabled: boolean;
        }[];
      };

      expect(factoryCalls).toBe(0);
      expect(output.activationDiagnostics.map((item) => item.code)).not.toContain(
        'runtime_config_required_secret_missing'
      );
      expect(output.plugins).toContainEqual(
        expect.objectContaining({
          pluginId: plugin.manifest.id,
          activationStatus: 'active',
          enabled: true
        })
      );
      expect(stdout).not.toContain(suppliedSecretValue);
    } finally {
      Reflect.deleteProperty(process.env, envVar);
    }
  });

  it('redacts get secrets while preserving non-secret values', async () => {
    const rawSecret = 'runtime-config-get-plaintext-secret';
    const rawLegacySecret = 'runtime-config-get-legacy-secret';
    const rawExactPluginSecret = 'runtime-config-get-exact-plugin-secret';
    const configPath = writeRuntimeConfig(
      join(createTestTempRoot('project02-config-get-secret-'), 'config.json'),
      {
        plugins: {
          foo: {
            config: {
              apiKey: {
                $plaintextSecret: rawSecret,
                allowPlaintextSecret: true,
                justification: 'test-only plaintext override'
              },
              legacyApiKey: rawLegacySecret,
              backend: 'local'
            }
          },
          'memory.config.api': {
            enabled: true,
            config: {
              apiKey: rawExactPluginSecret,
              backend: 'remote'
            }
          }
        }
      }
    );
    let secretStdout = '';
    let legacySecretStdout = '';
    let backendStdout = '';
    let configStdout = '';
    let exactPluginStdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'get', 'plugins.foo.config.apiKey'],
        {
          stdout: collect((chunk) => {
            secretStdout += chunk;
          }),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(JSON.parse(secretStdout) as unknown).toBe('[redacted]');
    expect(secretStdout).not.toContain(rawSecret);

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'get', 'plugins.foo.config.legacyApiKey'],
        {
          stdout: collect((chunk) => {
            legacySecretStdout += chunk;
          }),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(JSON.parse(legacySecretStdout) as unknown).toBe('[redacted]');
    expect(legacySecretStdout).not.toContain(rawLegacySecret);

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'get', 'plugins.foo.config.backend'],
        {
          stdout: collect((chunk) => {
            backendStdout += chunk;
          }),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(JSON.parse(backendStdout) as unknown).toBe('local');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'get', 'plugins.foo.config'],
        {
          stdout: collect((chunk) => {
            configStdout += chunk;
          }),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(JSON.parse(configStdout) as unknown).toEqual({
      apiKey: '[redacted]',
      legacyApiKey: '[redacted]',
      backend: 'local'
    });
    expect(configStdout).not.toContain(rawSecret);
    expect(configStdout).not.toContain(rawLegacySecret);

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'get', 'plugins.memory.config.api'],
        {
          stdout: collect((chunk) => {
            exactPluginStdout += chunk;
          }),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(JSON.parse(exactPluginStdout) as unknown).toEqual({
      enabled: true,
      config: {
        apiKey: '[redacted]',
        backend: 'remote'
      }
    });
    expect(exactPluginStdout).not.toContain(rawExactPluginSecret);
  });
});
