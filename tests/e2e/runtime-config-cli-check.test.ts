import {mkdirSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {createTestTempRoot} from '../support/temp-root.ts';
import {runtimeConfigEnvVarName} from '../../src/runtime/config/index.ts';
import {
  createProject02HomeLayout,
  defaultProject02HomeRoot,
} from '../../src/runtime/storage/index.ts';
import {runRuntimeConfigCliFromArgs} from '../../src/cli/config/main.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {collect} from '../support/streams.ts';
import {
  initializeTestStore,
  requiredDottedConfigPlugin,
  restoreProcessEnvValue,
} from '../support/runtime-config-fixtures.ts';
import {requiredSecretPlugin} from '../support/runtime-config-activation-fixtures.ts';

describe('runtime config CLI reads and checks', () => {
  it('rejects check when the character-data root is a symlink', async () => {
    const storeRoot = createTestTempRoot('project02-config-check-root-link-');
    const outside = createTestTempRoot('project02-config-check-root-target-');
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    mkdirSync(join(outside, 'mira'), {recursive: true});
    writeRuntimeConfig(join(outside, 'mira', 'config.json'), {
      project02: {userDisplayName: 'Outside Name'},
    });
    symlinkSync(outside, join(storeRoot, 'character-data'));

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Error:');
  });

  it('rejects check for a marker-less home holding foreign content', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-check-foreign-home-',
    );
    let stderr = '';

    writeFileSync(join(storeRoot, 'notes.txt'), 'not a project02 home\n');

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Error:');
  });

  it('rejects check when the data marker is a directory', async () => {
    const storeRoot = createTestTempRoot('project02-config-check-marker-dir-');
    const dataRoot = join(storeRoot, 'character-data', 'mira');
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    mkdirSync(join(dataRoot, 'schema.json'), {recursive: true});

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    // A formatted storage refusal, never a raw EISDIR stack trace.
    expect(stderr).toMatch(/^Error: /);
  });

  it('rejects check when the character-data root is a regular file', async () => {
    const storeRoot = createTestTempRoot('project02-config-check-root-file-');
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    writeFileSync(join(storeRoot, 'character-data'), 'not a directory\n');

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    // A formatted storage refusal, never a raw ENOTDIR stack trace.
    expect(stderr).toMatch(/^Error: /);
  });

  it('rejects check for an absent character dir under a symlinked root', async () => {
    const storeRoot = createTestTempRoot('project02-config-check-link-empty-');
    const outside = createTestTempRoot('project02-config-check-link-tgt-');
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    // No mira/ exists anywhere, so the symlinked root alone is the refusal.
    symlinkSync(outside, join(storeRoot, 'character-data'));

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Error:');
  });

  it('rejects check when a marker-less data directory holds foreign content', async () => {
    const storeRoot = createTestTempRoot('project02-config-check-foreign-');
    const dataRoot = join(storeRoot, 'character-data', 'mira');
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    // A marker-less directory with an overlay and foreign content, which the
    // first durable run would refuse.
    mkdirSync(dataRoot, {recursive: true});
    writeRuntimeConfig(join(dataRoot, 'config.json'), {
      project02: {userDisplayName: 'Foreign Name'},
    });
    writeFileSync(join(dataRoot, 'notes.txt'), 'foreign\n');

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Error:');
  });

  it('rejects check when the data directory is marked for another character', async () => {
    const storeRoot = createTestTempRoot('project02-config-check-marker-');
    const dataRoot = join(storeRoot, 'character-data', 'mira');
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    // A copied directory: mira's path claims nova but carries an overlay.
    mkdirSync(dataRoot, {recursive: true});
    writeFileSync(
      join(dataRoot, 'schema.json'),
      `${JSON.stringify({
        schemaVersion: 9,
        scope: 'character-data',
        characterId: 'nova',
        createdAt: '2026-07-23T00:00:00.000Z',
      })}\n`,
    );
    writeRuntimeConfig(join(dataRoot, 'config.json'), {
      project02: {userDisplayName: 'Foreign Name'},
    });

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('holds history for character "nova"');
  });

  it('reports activation warnings from runtime config check', async () => {
    const storeRoot = createTestTempRoot('project02-config-check-');
    let stdout = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'unknown-plugin': {
          enabled: true,
        },
      },
    });

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
      }),
    ).toBe(0);
    expect(stdout).toContain('"activationDiagnostics"');
    expect(stdout).toContain('"runtime_config_unknown_plugin"');
  });

  it('reports check config load errors before runtime env file errors', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-check-load-error-before-env-',
    );
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      storeRoot: 42,
    });
    mkdirSync(join(storeRoot, '.env'));

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
      }),
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
      path: 'project02.storeRoot',
    });
    expect(output.activationDiagnostics[0]).toMatchObject({
      code: 'runtime_config_string_invalid',
      path: 'project02.storeRoot',
    });
    expect(stdout).not.toContain('Could not load runtime config env file');
    expect(stderr).not.toContain('Could not load runtime config env file');
  });

  it('reports check activation config errors before runtime env file errors', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-check-activation-before-env-',
    );
    const plugin = requiredDottedConfigPlugin(
      'memory.required-config',
      'endpoint',
    );
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
        },
      },
    });
    mkdirSync(join(storeRoot, '.env'));

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        factories: {
          [plugin.manifest.id]: {
            manifest: plugin.manifest,
            create() {
              throw new Error(
                'runtime-config check should not construct plugins',
              );
            },
          },
        },
      }),
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
          path: `plugins.${plugin.manifest.id}.config.endpoint`,
        }),
      ]),
    );
    expect(stdout).not.toContain('Could not load runtime config env file');
  });

  it('reports explicit check config load errors before unrelated cwd dotenv errors', async () => {
    const cwdRoot = createTestTempRoot(
      'project02-config-check-cwd-dotenv-error-',
    );
    const storeRoot = createTestTempRoot(
      'project02-config-check-selected-store-error-',
    );
    const configPath = join(
      createTestTempRoot('project02-config-check-selected-path-error-'),
      'runtime.json',
    );
    const previousCwd = process.cwd();

    writeRuntimeConfig(
      createProject02HomeLayout({homeRoot: storeRoot}).configPath,
      {
        storeRoot: 42,
      },
    );
    writeRuntimeConfig(configPath, {
      storeRoot: 42,
    });
    mkdirSync(join(cwdRoot, '.env'));
    // The authored storeRoot is the invalid value, so both runs fall back to
    // the default home beside the cwd.
    await initializeTestStore(join(cwdRoot, defaultProject02HomeRoot));
    await initializeTestStore(storeRoot);

    try {
      process.chdir(cwdRoot);

      for (const example of [
        ['--store', storeRoot, 'check'],
        ['--config', configPath, 'check'],
      ] as const) {
        let stdout = '';
        let stderr = '';

        expect(
          await runRuntimeConfigCliFromArgs(example, {
            stdout: collect(chunk => {
              stdout += chunk;
            }),
            stderr: collect(chunk => {
              stderr += chunk;
            }),
          }),
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
          path: 'project02.storeRoot',
        });
        expect(output.activationDiagnostics[0]).toMatchObject({
          code: 'runtime_config_string_invalid',
          path: 'project02.storeRoot',
        });
        expect(stdout).not.toContain('Could not load .env file');
        expect(stderr).not.toContain('Could not load .env file');
      }
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('reports env-selected check config load errors before unrelated cwd dotenv errors', async () => {
    const cwdRoot = createTestTempRoot(
      'project02-config-check-env-cwd-dotenv-error-',
    );
    const storeRoot = createTestTempRoot(
      'project02-config-check-env-selected-store-error-',
    );
    const configPath = createProject02HomeLayout({
      homeRoot: storeRoot,
    }).configPath;
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(configPath, {
      storeRoot: 42,
    });
    mkdirSync(join(cwdRoot, '.env'));
    await initializeTestStore(join(cwdRoot, defaultProject02HomeRoot));

    try {
      process.env[runtimeConfigEnvVarName] = configPath;
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(['check'], {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(chunk => {
            stderr += chunk;
          }),
        }),
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
        path: 'project02.storeRoot',
      });
      expect(output.activationDiagnostics[0]).toMatchObject({
        code: 'runtime_config_string_invalid',
        path: 'project02.storeRoot',
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
    const laterStoreRoot = createTestTempRoot(
      'project02-config-check-env-later-',
    );
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
            apiKey: {$env: envVar},
          },
        },
      },
    });
    writeFileSync(
      join(storeRoot, '.env'),
      `${envVar}="${secretValue}"\n`,
      'utf8',
    );
    writeRuntimeConfig(join(laterStoreRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {
            apiKey: {$env: envVar},
          },
        },
      },
    });

    try {
      expect(
        await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(() => {}),
          factories: {
            [plugin.manifest.id]: {
              manifest: plugin.manifest,
              create() {
                factoryCalls += 1;
                throw new Error(
                  'runtime-config check should not construct plugins',
                );
              },
            },
          },
        }),
      ).toBe(0);

      const output = JSON.parse(stdout) as {
        readonly activationDiagnostics: readonly {readonly code: string}[];
        readonly plugins: readonly {
          readonly pluginId: string;
          readonly activationStatus: string;
          readonly enabled: boolean;
        }[];
      };

      expect(factoryCalls).toBe(0);
      expect(output.activationDiagnostics.map(item => item.code)).not.toContain(
        'runtime_config_required_secret_missing',
      );
      // Same projected plugin shape `inspect` reports, redaction included.
      expect(
        output.plugins.find(entry => entry.pluginId === plugin.manifest.id),
      ).toMatchObject({
        activationStatus: 'active',
        enabled: true,
        config: {apiKey: {secret: true, resolved: true, value: '[redacted]'}},
      });
      expect(stdout).not.toContain(secretValue);
      expect(process.env[envVar]).toBeUndefined();

      expect(
        await runRuntimeConfigCliFromArgs(
          ['--store', laterStoreRoot, 'check'],
          {
            stdout: collect(chunk => {
              laterStdout += chunk;
            }),
            stderr: collect(() => {}),
            factories: {
              [plugin.manifest.id]: {
                manifest: plugin.manifest,
                create() {
                  laterFactoryCalls += 1;
                  throw new Error(
                    'missing-secret check should not construct plugins',
                  );
                },
              },
            },
          },
        ),
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
            apiKey: {$env: envVar},
          },
        },
      },
    });
    writeFileSync(
      join(cwdRoot, '.env'),
      `${runtimeConfigEnvVarName}=${join(storeRoot, 'config.json')}\n${envVar}="${secretValue}"\n`,
      'utf8',
    );
    // The selected config authors no storeRoot, so the home stays the default
    // one beside the working directory.
    await initializeTestStore(join(cwdRoot, defaultProject02HomeRoot));

    try {
      Reflect.deleteProperty(process.env, runtimeConfigEnvVarName);
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(['check'], {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(() => {}),
          factories: {
            [plugin.manifest.id]: {
              manifest: plugin.manifest,
              create() {
                factoryCalls += 1;
                throw new Error(
                  'runtime-config check should not construct plugins',
                );
              },
            },
          },
        }),
      ).toBe(0);

      const output = JSON.parse(stdout) as {
        readonly activationDiagnostics: readonly {readonly code: string}[];
        readonly plugins: readonly {
          readonly pluginId: string;
          readonly activationStatus: string;
          readonly enabled: boolean;
        }[];
      };

      expect(factoryCalls).toBe(0);
      expect(output.activationDiagnostics.map(item => item.code)).not.toContain(
        'runtime_config_required_secret_missing',
      );
      expect(output.plugins).toContainEqual(
        expect.objectContaining({
          pluginId: plugin.manifest.id,
          activationStatus: 'active',
          enabled: true,
        }),
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
    const cwdRoot = createTestTempRoot(
      'project02-config-check-explicit-cwd-env-',
    );
    const storeRoot = createTestTempRoot(
      'project02-config-check-explicit-store-',
    );
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
            apiKey: {$env: envVar},
          },
        },
      },
    });
    writeFileSync(
      join(cwdRoot, '.env'),
      `${envVar}="from-cwd-dotenv"\n`,
      'utf8',
    );
    await initializeTestStore(join(cwdRoot, defaultProject02HomeRoot));

    try {
      process.chdir(cwdRoot);

      for (const args of [
        ['--store', storeRoot, 'check'],
        ['--config', configPath, 'check'],
      ] as const) {
        let stdout = '';
        let factoryCalls = 0;

        expect(
          await runRuntimeConfigCliFromArgs(args, {
            stdout: collect(chunk => {
              stdout += chunk;
            }),
            stderr: collect(() => {}),
            factories: {
              [plugin.manifest.id]: {
                manifest: plugin.manifest,
                create() {
                  factoryCalls += 1;
                  throw new Error(
                    'runtime-config check should not construct plugins',
                  );
                },
              },
            },
          }),
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
    const cwdRoot = createTestTempRoot(
      'project02-config-check-cwd-env-override-',
    );
    const storeRoot = createTestTempRoot(
      'project02-config-check-store-env-override-',
    );
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
            apiKey: {$env: envVar},
          },
        },
      },
    });
    writeFileSync(
      join(cwdRoot, '.env'),
      `${envVar}="${secretValue}"\n`,
      'utf8',
    );
    writeFileSync(join(storeRoot, '.env'), `${envVar}=\n`, 'utf8');

    try {
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(() => {}),
          factories: {
            [plugin.manifest.id]: {
              manifest: plugin.manifest,
              create() {
                factoryCalls += 1;
                throw new Error(
                  'runtime-config check should not construct plugins',
                );
              },
            },
          },
        }),
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
    const storeRoot = createTestTempRoot(
      'project02-config-check-process-store-',
    );
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
            apiKey: {$env: envVar},
          },
        },
      },
    });
    writeFileSync(join(cwdRoot, '.env'), `${envVar}=\n`, 'utf8');

    try {
      process.env[envVar] = secretValue;
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(() => {}),
          factories: {
            [plugin.manifest.id]: {
              manifest: plugin.manifest,
              create() {
                factoryCalls += 1;
                throw new Error(
                  'runtime-config check should not construct plugins',
                );
              },
            },
          },
        }),
      ).toBe(0);

      const output = JSON.parse(stdout) as {
        readonly activationDiagnostics: readonly {readonly code: string}[];
        readonly plugins: readonly {
          readonly pluginId: string;
          readonly activationStatus: string;
          readonly enabled: boolean;
        }[];
      };

      expect(factoryCalls).toBe(0);
      expect(output.activationDiagnostics.map(item => item.code)).not.toContain(
        'runtime_config_required_secret_missing',
      );
      expect(output.plugins).toContainEqual(
        expect.objectContaining({
          pluginId: plugin.manifest.id,
          activationStatus: 'active',
          enabled: true,
        }),
      );
      expect(stdout).not.toContain(secretValue);
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(envVar, previousEnvValue);
    }
  });

  it('keeps supplied check env values ahead of runtime env file values', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-check-env-precedence-',
    );
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
            apiKey: {$env: envVar},
          },
        },
      },
    });
    writeFileSync(join(storeRoot, '.env'), `${envVar}=\n`, 'utf8');

    try {
      expect(
        await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(() => {}),
          env: {[envVar]: suppliedSecretValue},
          factories: {
            [plugin.manifest.id]: {
              manifest: plugin.manifest,
              create() {
                factoryCalls += 1;
                throw new Error(
                  'runtime-config check should not construct plugins',
                );
              },
            },
          },
        }),
      ).toBe(0);

      const output = JSON.parse(stdout) as {
        readonly activationDiagnostics: readonly {readonly code: string}[];
        readonly plugins: readonly {
          readonly pluginId: string;
          readonly activationStatus: string;
          readonly enabled: boolean;
        }[];
      };

      expect(factoryCalls).toBe(0);
      expect(output.activationDiagnostics.map(item => item.code)).not.toContain(
        'runtime_config_required_secret_missing',
      );
      expect(output.plugins).toContainEqual(
        expect.objectContaining({
          pluginId: plugin.manifest.id,
          activationStatus: 'active',
          enabled: true,
        }),
      );
      expect(stdout).not.toContain(suppliedSecretValue);
    } finally {
      Reflect.deleteProperty(process.env, envVar);
    }
  });
});
