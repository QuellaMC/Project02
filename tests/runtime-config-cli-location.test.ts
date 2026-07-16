import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestTempRoot } from './support/temp-root.ts';
import { defaultRuntimeConfigPath, runtimeConfigEnvVarName } from '../src/runtime/config/index.ts';
import { runRuntimeConfigCliFromArgs } from '../src/cli/config.ts';
import {
  collect,
  writeRuntimeConfig
} from './support/runtime-config.ts';
import {
  restoreProcessEnvValue
} from './support/runtime-config-fixtures.ts';

describe('runtime config CLI location selection', () => {
  it('prints the env-selected config path from PROJECT02_RUNTIME_CONFIG', async () => {
    const configRoot = createTestTempRoot('project02-config-path-env-');
    const configPath = join(configRoot, 'runtime.json');
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(['path'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        }),
        env: {
          PROJECT02_RUNTIME_CONFIG: configPath
        }
      })
    ).toBe(0);

    expect(stdout).toBe(`${configPath}\n`);
    expect(stderr).toBe('');
  });

  it('prints process-env-selected location paths without reading unreadable cwd dotenv', async () => {
    const cwdRoot = createTestTempRoot('project02-config-process-env-cwd-dotenv-error-');
    const storeRoot = createTestTempRoot('project02-config-process-env-selected-store-');
    const configPath = writeRuntimeConfig(join(cwdRoot, 'runtime.json'), {
      storeRoot
    });
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];

    mkdirSync(join(cwdRoot, '.env'));

    try {
      process.env[runtimeConfigEnvVarName] = configPath;
      process.chdir(cwdRoot);

      for (const example of [
        {
          args: ['path'] as const,
          expected: configPath
        },
        {
          args: ['env-path'] as const,
          expected: join(storeRoot, '.env')
        }
      ]) {
        let stdout = '';
        let stderr = '';

        expect(
          await runRuntimeConfigCliFromArgs(example.args, {
            stdout: collect((chunk) => {
              stdout += chunk;
            }),
            stderr: collect((chunk) => {
              stderr += chunk;
            }),
            env: process.env
          })
        ).toBe(0);

        expect(stdout).toBe(`${example.expected}\n`);
        expect(stderr).toBe('');
      }
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
    }
  });

  it('uses process-env-selected config for get and non-secret mutations before reading unreadable cwd dotenv', async () => {
    const cwdRoot = createTestTempRoot('project02-config-process-env-cwd-dotenv-get-set-');
    const storeRoot = createTestTempRoot('project02-config-process-env-get-set-store-');
    const configRoot = createTestTempRoot('project02-config-process-env-get-set-');
    const configPath = writeRuntimeConfig(
      join(configRoot, 'runtime.json'),
      {
        storeRoot,
        plugins: {
          foo: {
            config: {
              backend: 'selected'
            }
          }
        }
      }
    );
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    let getStdout = '';
    let getStderr = '';
    let setStdout = '';
    let setStderr = '';

    mkdirSync(join(cwdRoot, '.env'));

    try {
      process.env[runtimeConfigEnvVarName] = configPath;
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(['get', 'plugins.foo.config.backend'], {
          stdout: collect((chunk) => {
            getStdout += chunk;
          }),
          stderr: collect((chunk) => {
            getStderr += chunk;
          })
        })
      ).toBe(0);
      expect(JSON.parse(getStdout) as unknown).toBe('selected');
      expect(getStderr).toBe('');

      expect(
        await runRuntimeConfigCliFromArgs(
          ['set', 'plugins.foo.config.backend', 'remote'],
          {
            stdout: collect((chunk) => {
              setStdout += chunk;
            }),
            stderr: collect((chunk) => {
              setStderr += chunk;
            })
          }
        )
      ).toBe(0);

      expect(JSON.parse(setStdout) as { readonly configPath: string }).toMatchObject({
        configPath,
        envPath: join(storeRoot, '.env')
      });
      expect(setStderr).toBe('');
      expect(JSON.parse(readFileSync(configPath, 'utf8')) as unknown).toMatchObject({
        plugins: {
          foo: {
            config: {
              backend: 'remote'
            }
          }
        }
      });
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
    }
  });

  it('uses process-env-selected config for secret set before reading unreadable cwd dotenv when the secret is present', async () => {
    const cwdRoot = createTestTempRoot('project02-config-process-env-cwd-dotenv-secret-');
    const storeRoot = createTestTempRoot('project02-config-process-env-secret-store-');
    const configRoot = createTestTempRoot('project02-config-process-env-secret-config-');
    const configPath = writeRuntimeConfig(join(configRoot, 'runtime.json'), {
      storeRoot
    });
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    const envVar = 'PROJECT02_SECRET_PROCESS_ENV_SELECTED_3451627428';
    const previousEnvValue = process.env[envVar];
    const secretValue = 'from-process-env';
    let stdout = '';
    let stderr = '';

    mkdirSync(join(cwdRoot, '.env'));

    try {
      process.env[runtimeConfigEnvVarName] = configPath;
      process.env[envVar] = secretValue;
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(
          ['secret', 'set', 'mem0-local', 'cloudApiKey', envVar],
          {
            stdout: collect((chunk) => {
              stdout += chunk;
            }),
            stderr: collect((chunk) => {
              stderr += chunk;
            })
          }
        )
      ).toBe(0);

      expect(stderr).toBe('');
      expect(JSON.parse(stdout) as { readonly configPath: string }).toMatchObject({
        configPath,
        envPath: join(storeRoot, '.env')
      });
      expect(JSON.parse(readFileSync(configPath, 'utf8')) as unknown).toMatchObject({
        plugins: {
          'mem0-local': {
            config: {
              cloudApiKey: { $env: envVar }
            }
          }
        }
      });
      expect(readFileSync(join(storeRoot, '.env'), 'utf8')).toBe(
        `${envVar}="${secretValue}"\n`
      );
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
      restoreProcessEnvValue(envVar, previousEnvValue);
    }
  });

  it('uses cwd dotenv secret fallback for process-env-selected secret set when the secret is absent from process env', async () => {
    const cwdRoot = createTestTempRoot('project02-config-process-env-secret-cwd-fallback-');
    const storeRoot = createTestTempRoot('project02-config-process-env-secret-fallback-store-');
    const configPath = writeRuntimeConfig(join(cwdRoot, 'runtime.json'), {
      storeRoot
    });
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    const envVar = 'PROJECT02_SECRET_CWD_FALLBACK_3451627428';
    const previousEnvValue = process.env[envVar];
    const secretValue = 'from-cwd-dotenv';
    let stdout = '';
    let stderr = '';

    writeFileSync(join(cwdRoot, '.env'), `${envVar}="${secretValue}"\n`, 'utf8');

    try {
      process.env[runtimeConfigEnvVarName] = configPath;
      Reflect.deleteProperty(process.env, envVar);
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(
          ['secret', 'set', 'mem0-local', 'cloudApiKey', envVar],
          {
            stdout: collect((chunk) => {
              stdout += chunk;
            }),
            stderr: collect((chunk) => {
              stderr += chunk;
            })
          }
        )
      ).toBe(0);

      expect(stderr).toBe('');
      expect(JSON.parse(stdout) as { readonly configPath: string }).toMatchObject({
        configPath,
        envPath: join(storeRoot, '.env')
      });
      expect(readFileSync(join(storeRoot, '.env'), 'utf8')).toBe(
        `${envVar}="${secretValue}"\n`
      );
      expect(process.env[envVar]).toBeUndefined();
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
      restoreProcessEnvValue(envVar, previousEnvValue);
    }
  });

  it('uses explicit runtime locations for secret set before reading unreadable cwd dotenv when the secret is present', async () => {
    const cwdRoot = createTestTempRoot('project02-config-explicit-cwd-dotenv-secret-');
    const storeRoot = createTestTempRoot('project02-config-explicit-secret-store-');
    const configStoreRoot = createTestTempRoot('project02-config-explicit-secret-config-store-');
    const configPath = writeRuntimeConfig(
      join(
        createTestTempRoot('project02-config-explicit-secret-config-'),
        'runtime.json'
      ),
      { storeRoot: configStoreRoot }
    );
    const storeConfigPath = writeRuntimeConfig(defaultRuntimeConfigPath(storeRoot), {
      storeRoot
    });
    const previousCwd = process.cwd();
    const envVar = 'PROJECT02_SECRET_EXPLICIT_PRESENT_3451970615';
    const previousEnvValue = process.env[envVar];
    const secretValue = 'from-process-env';

    mkdirSync(join(cwdRoot, '.env'));

    try {
      process.env[envVar] = secretValue;
      process.chdir(cwdRoot);

      for (const example of [
        {
          args: ['--store', storeRoot] as const,
          configPath: storeConfigPath,
          envPath: join(storeRoot, '.env')
        },
        {
          args: ['--config', configPath] as const,
          configPath,
          envPath: join(configStoreRoot, '.env')
        }
      ]) {
        let stdout = '';
        let stderr = '';

        expect(
          await runRuntimeConfigCliFromArgs(
            [...example.args, 'secret', 'set', 'mem0-local', 'cloudApiKey', envVar],
            {
              stdout: collect((chunk) => {
                stdout += chunk;
              }),
              stderr: collect((chunk) => {
                stderr += chunk;
              })
            }
          )
        ).toBe(0);

        expect(stderr).toBe('');
        expect(JSON.parse(stdout) as { readonly configPath: string }).toMatchObject({
          configPath: example.configPath,
          envPath: example.envPath
        });
        expect(JSON.parse(readFileSync(example.configPath, 'utf8')) as unknown).toMatchObject({
          plugins: {
            'mem0-local': {
              config: {
                cloudApiKey: { $env: envVar }
              }
            }
          }
        });
        expect(readFileSync(example.envPath, 'utf8')).toBe(
          `${envVar}="${secretValue}"\n`
        );
      }
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(envVar, previousEnvValue);
    }
  });

  it('uses cwd dotenv secret fallback for explicit runtime locations when the secret is absent from process env', async () => {
    const cwdRoot = createTestTempRoot('project02-config-explicit-secret-cwd-fallback-');
    const storeRoot = createTestTempRoot('project02-config-explicit-secret-fallback-store-');
    const configStoreRoot = createTestTempRoot('project02-config-explicit-secret-fallback-config-store-');
    const configPath = writeRuntimeConfig(
      join(
        createTestTempRoot('project02-config-explicit-secret-fallback-config-'),
        'runtime.json'
      ),
      { storeRoot: configStoreRoot }
    );
    const storeConfigPath = writeRuntimeConfig(defaultRuntimeConfigPath(storeRoot), {
      storeRoot
    });
    const previousCwd = process.cwd();
    const envVar = 'PROJECT02_SECRET_EXPLICIT_CWD_FALLBACK_3451970615';
    const previousEnvValue = process.env[envVar];
    const secretValue = 'from-cwd-dotenv';

    writeFileSync(join(cwdRoot, '.env'), `${envVar}="${secretValue}"\n`, 'utf8');

    try {
      Reflect.deleteProperty(process.env, envVar);
      process.chdir(cwdRoot);

      for (const example of [
        {
          args: ['--store', storeRoot] as const,
          configPath: storeConfigPath,
          envPath: join(storeRoot, '.env')
        },
        {
          args: ['--config', configPath] as const,
          configPath,
          envPath: join(configStoreRoot, '.env')
        }
      ]) {
        let stdout = '';
        let stderr = '';

        expect(
          await runRuntimeConfigCliFromArgs(
            [...example.args, 'secret', 'set', 'mem0-local', 'cloudApiKey', envVar],
            {
              stdout: collect((chunk) => {
                stdout += chunk;
              }),
              stderr: collect((chunk) => {
                stderr += chunk;
              })
            }
          )
        ).toBe(0);

        expect(stderr).toBe('');
        expect(JSON.parse(stdout) as { readonly configPath: string }).toMatchObject({
          configPath: example.configPath,
          envPath: example.envPath
        });
        expect(readFileSync(example.envPath, 'utf8')).toBe(
          `${envVar}="${secretValue}"\n`
        );
      }

      expect(process.env[envVar]).toBeUndefined();
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(envVar, previousEnvValue);
    }
  });

  it('uses cwd dotenv runtime config selectors for unflagged config reads and mutations', async () => {
    const cwdRoot = createTestTempRoot('project02-config-cli-cwd-env-');
    const storeRoot = createTestTempRoot('project02-config-cli-cwd-store-');
    const configPath = writeRuntimeConfig(join(cwdRoot, 'runtime.json'), {
      storeRoot,
      plugins: {
        foo: {
          config: {
            backend: 'local'
          }
        }
      }
    });
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    let pathStdout = '';
    let envPathStdout = '';
    let getStdout = '';
    let setStdout = '';

    writeFileSync(
      join(cwdRoot, '.env'),
      `${runtimeConfigEnvVarName}=${configPath}\n`,
      'utf8'
    );

    try {
      Reflect.deleteProperty(process.env, runtimeConfigEnvVarName);
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(['path'], {
          stdout: collect((chunk) => {
            pathStdout += chunk;
          }),
          stderr: collect(() => {})
        })
      ).toBe(0);
      expect(pathStdout).toBe(`${configPath}\n`);

      expect(
        await runRuntimeConfigCliFromArgs(['env-path'], {
          stdout: collect((chunk) => {
            envPathStdout += chunk;
          }),
          stderr: collect(() => {})
        })
      ).toBe(0);
      expect(envPathStdout).toBe(`${join(storeRoot, '.env')}\n`);

      expect(
        await runRuntimeConfigCliFromArgs(['get', 'plugins.foo.config.backend'], {
          stdout: collect((chunk) => {
            getStdout += chunk;
          }),
          stderr: collect(() => {})
        })
      ).toBe(0);
      expect(JSON.parse(getStdout) as unknown).toBe('local');

      expect(
        await runRuntimeConfigCliFromArgs(
          ['set', 'plugins.foo.config.backend', 'remote'],
          {
            stdout: collect((chunk) => {
              setStdout += chunk;
            }),
            stderr: collect(() => {})
          }
        )
      ).toBe(0);

      const setOutput = JSON.parse(setStdout) as {
        readonly configPath: string;
        readonly envPath: string;
      };
      const afterSet: unknown = JSON.parse(readFileSync(configPath, 'utf8'));

      expect(setOutput).toMatchObject({
        configPath,
        envPath: join(storeRoot, '.env')
      });
      expect(afterSet).toMatchObject({
        plugins: {
          foo: {
            config: {
              backend: 'remote'
            }
          }
        }
      });
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
    }
  });

  it('keeps explicit config and store locations ahead of env runtime config selectors', async () => {
    const cwdRoot = createTestTempRoot('project02-config-cli-explicit-');
    const dotenvStoreRoot = createTestTempRoot('project02-config-cli-dotenv-store-');
    const processStoreRoot = createTestTempRoot('project02-config-cli-process-store-');
    const explicitStoreRoot = createTestTempRoot('project02-config-cli-explicit-store-');
    const selectedStoreRoot = createTestTempRoot('project02-config-cli-selected-store-');
    const explicitNextStoreRoot = createTestTempRoot('project02-config-cli-explicit-next-');
    const selectedNextStoreRoot = createTestTempRoot('project02-config-cli-selected-next-');
    const dotenvConfigPath = writeRuntimeConfig(join(cwdRoot, 'dotenv.json'), {
      storeRoot: dotenvStoreRoot
    });
    const processConfigPath = writeRuntimeConfig(join(cwdRoot, 'process.json'), {
      storeRoot: processStoreRoot
    });
    const explicitConfigPath = writeRuntimeConfig(join(cwdRoot, 'explicit.json'), {
      storeRoot: explicitStoreRoot
    });
    const selectedConfigPath = join(selectedStoreRoot, 'config.json');
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    let explicitGetStdout = '';
    let storePathStdout = '';
    let explicitSetStdout = '';
    let storeSetStdout = '';

    writeFileSync(
      join(cwdRoot, '.env'),
      `${runtimeConfigEnvVarName}=${dotenvConfigPath}\n`,
      'utf8'
    );

    try {
      process.env[runtimeConfigEnvVarName] = processConfigPath;
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(
          ['--config', explicitConfigPath, 'get', 'storeRoot'],
          {
            stdout: collect((chunk) => {
              explicitGetStdout += chunk;
            }),
            stderr: collect(() => {})
          }
        )
      ).toBe(0);
      expect(JSON.parse(explicitGetStdout) as unknown).toBe(explicitStoreRoot);

      expect(
        await runRuntimeConfigCliFromArgs(['--store', selectedStoreRoot, 'path'], {
          stdout: collect((chunk) => {
            storePathStdout += chunk;
          }),
          stderr: collect(() => {})
        })
      ).toBe(0);
      expect(storePathStdout).toBe(`${selectedConfigPath}\n`);

      expect(
        await runRuntimeConfigCliFromArgs(
          ['--config', explicitConfigPath, 'set', 'storeRoot', explicitNextStoreRoot],
          {
            stdout: collect((chunk) => {
              explicitSetStdout += chunk;
            }),
            stderr: collect(() => {})
          }
        )
      ).toBe(0);
      expect(JSON.parse(explicitSetStdout) as { readonly configPath: string }).toMatchObject({
        configPath: explicitConfigPath
      });

      expect(
        await runRuntimeConfigCliFromArgs(
          ['--store', selectedStoreRoot, 'set', 'storeRoot', selectedNextStoreRoot],
          {
            stdout: collect((chunk) => {
              storeSetStdout += chunk;
            }),
            stderr: collect(() => {})
          }
        )
      ).toBe(0);
      expect(JSON.parse(storeSetStdout) as { readonly configPath: string }).toMatchObject({
        configPath: selectedConfigPath
      });

      expect(JSON.parse(readFileSync(explicitConfigPath, 'utf8')) as unknown).toMatchObject(
        {
          project02: { storeRoot: explicitNextStoreRoot }
        }
      );
      expect(JSON.parse(readFileSync(selectedConfigPath, 'utf8')) as unknown).toMatchObject(
        {
          project02: { storeRoot: selectedNextStoreRoot }
        }
      );
      expect(JSON.parse(readFileSync(dotenvConfigPath, 'utf8')) as unknown).toMatchObject(
        {
          project02: { storeRoot: dotenvStoreRoot }
        }
      );
      expect(JSON.parse(readFileSync(processConfigPath, 'utf8')) as unknown).toMatchObject(
        {
          project02: { storeRoot: processStoreRoot }
        }
      );
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
    }
  });

  it('keeps process env runtime config selectors ahead of cwd dotenv defaults', async () => {
    const cwdRoot = createTestTempRoot('project02-config-cli-process-env-');
    const dotenvConfigPath = writeRuntimeConfig(join(cwdRoot, 'dotenv.json'), {
      storeRoot: 'dotenv-store'
    });
    const processConfigPath = writeRuntimeConfig(join(cwdRoot, 'process.json'), {
      storeRoot: 'process-store'
    });
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    let stdout = '';

    writeFileSync(
      join(cwdRoot, '.env'),
      `${runtimeConfigEnvVarName}=${dotenvConfigPath}\n`,
      'utf8'
    );

    try {
      process.env[runtimeConfigEnvVarName] = processConfigPath;
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(['path'], {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect(() => {})
        })
      ).toBe(0);

      expect(stdout).toBe(`${processConfigPath}\n`);
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
    }
  });

  it.each([
    {
      args: ['--config', '   ', 'path'] as const,
      message: 'Local runtime store is missing required files.'
    },
    {
      args: ['--store', '   ', 'path'] as const,
      message: 'Local runtime store root must be non-empty.'
    }
  ])('reports invalid runtime location for %j without throwing', async (example) => {
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(example.args, {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        })
      })
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toBe(`Error: ${example.message}\n`);
  });

  it('rejects extra set operands instead of truncating the configured value', async () => {
    const storeRoot = createTestTempRoot('project02-config-set-extra-');
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        [
          '--store',
          storeRoot,
          'set',
          'plugins.foo.config.prompt',
          'hello',
          'world'
        ],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect((chunk) => {
            stderr += chunk;
          })
        }
      )
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toBe('Error: set does not accept extra arguments.\n');
    expect(existsSync(join(storeRoot, 'config.json'))).toBe(false);
  });

  it.each([
    {
      label: 'path',
      args: ['path', 'extra'] as const,
      message: 'path does not accept extra arguments.'
    },
    {
      label: 'env-path',
      args: ['env-path', 'extra'] as const,
      message: 'env-path does not accept extra arguments.'
    },
    {
      label: 'check',
      args: ['check', 'extra'] as const,
      message: 'check does not accept extra arguments.'
    },
    {
      label: 'get',
      args: ['get', 'storeRoot', 'extra'] as const,
      message: 'get does not accept extra arguments.'
    },
    {
      label: 'unset',
      args: ['unset', 'storeRoot', 'extra'] as const,
      message: 'unset does not accept extra arguments.'
    },
    {
      label: 'plugin enable',
      args: ['plugin', 'enable', 'foo', 'extra'] as const,
      message: 'plugin enable does not accept extra arguments.'
    },
    {
      label: 'plugin disable',
      args: ['plugin', 'disable', 'foo', 'extra'] as const,
      message: 'plugin disable does not accept extra arguments.'
    },
    {
      label: 'default-memory-provider',
      args: ['default-memory-provider', 'foo', 'extra'] as const,
      message: 'default-memory-provider does not accept extra arguments.'
    },
    {
      label: 'default-memory-provider unset',
      args: ['default-memory-provider', '--unset', 'extra'] as const,
      message: 'default-memory-provider does not accept extra arguments.'
    },
    {
      label: 'secret set',
      args: ['secret', 'set', 'foo', 'apiKey', 'PROJECT02_SECRET', 'extra'] as const,
      message:
        'secret set reads the secret from the named env var; do not pass the secret value as an argument.'
    }
  ])('rejects extra operands for $label', async (example) => {
    const storeRoot = createTestTempRoot('project02-config-extra-args-');
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, ...example.args], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        })
      })
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toBe(`Error: ${example.message}\n`);
  });

  it('prints env-path from the effective configured store root', async () => {
    const configRoot = createTestTempRoot('project02-config-env-path-');
    const storeRoot = createTestTempRoot('project02-config-env-store-');
    const configPath = writeRuntimeConfig(join(configRoot, 'runtime.json'), {
      storeRoot
    });
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(['--config', configPath, 'env-path'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        })
      })
    ).toBe(0);

    expect(stdout).toBe(`${join(storeRoot, '.env')}\n`);
    expect(stderr).toBe('');
  });

  it('prints env-path from an inferred store-default config root', async () => {
    const storeRoot = createTestTempRoot('project02-config-env-path-inferred-');
    const seededStoreRoot = realpathSync.native(storeRoot);
    const configPath = writeRuntimeConfig(defaultRuntimeConfigPath(storeRoot), {});
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(['--config', configPath, 'env-path'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        })
      })
    ).toBe(0);

    expect(stdout).toBe(`${join(seededStoreRoot, '.env')}\n`);
    expect(stderr).toBe('');
  });

  it('keeps env-path explicit store behavior when no config exists', async () => {
    const storeRoot = createTestTempRoot('project02-config-env-store-only-');
    let stdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'env-path'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {})
      })
    ).toBe(0);

    expect(stdout).toBe(`${join(storeRoot, '.env')}\n`);
  });

  it('sets and unsets dotted plugin IDs through generic config paths', async () => {
    const storeRoot = createTestTempRoot('project02-config-dotted-set-');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'set', 'plugins.memory.recall.config.backend', 'local'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    const afterSet = readFileSync(join(storeRoot, 'config.json'), 'utf8');

    expect(afterSet).toContain('"memory.recall"');
    expect(afterSet).toContain('"backend": "local"');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'unset', 'plugins.memory.recall.config.backend'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    const afterUnset = readFileSync(join(storeRoot, 'config.json'), 'utf8');

    expect(afterUnset).not.toContain('"memory.recall"');
    expect(afterUnset).not.toContain('"backend"');

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
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'set', 'plugins.memory.config.config.backend', 'local'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    const afterConfigSegmentSet: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(afterConfigSegmentSet).toMatchObject({
      plugins: {
        'memory.config': {
          enabled: true,
          config: {
            backend: 'local'
          }
        }
      }
    });
    expect(JSON.stringify(afterConfigSegmentSet)).not.toContain('"config.backend"');
  });

  it('rejects exact wrapper mutation paths before fallback parsing', async () => {
    for (const example of [
      {
        exactPluginId: 'memory.enabled',
        args: ['set', 'plugins.memory.enabled', 'false']
      },
      {
        exactPluginId: 'memory.enabled',
        args: ['unset', 'plugins.memory.enabled']
      },
      {
        exactPluginId: 'memory.config.api',
        args: ['set', 'plugins.memory.config.api', 'remote']
      }
    ] as const) {
      const storeRoot = createTestTempRoot('project02-config-exact-wrapper-mutation-');
      let stderr = '';

      expect(
        await runRuntimeConfigCliFromArgs(
          ['--store', storeRoot, 'plugin', 'enable', example.exactPluginId],
          {
            stdout: collect(() => {}),
            stderr: collect(() => {})
          }
        )
      ).toBe(0);

      expect(
        await runRuntimeConfigCliFromArgs(['--store', storeRoot, ...example.args], {
          stdout: collect(() => {}),
          stderr: collect((chunk) => {
            stderr += chunk;
          })
        })
      ).toBe(1);

      expect(stderr).toContain('Ambiguous runtime config plugin path');
      expect(stderr).toContain(example.args[1]);
      expect(stderr).toContain(example.exactPluginId);

      const configText = readFileSync(join(storeRoot, 'config.json'), 'utf8');
      const config: unknown = JSON.parse(configText);

      expect(config).toMatchObject({
        plugins: {
          [example.exactPluginId]: {
            enabled: true
          }
        }
      });
      expect(configText).not.toContain('"memory":');
    }
  });
});
