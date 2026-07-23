import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {applyRuntimeConfigMutation} from '../../src/runtime/config/mutate.ts';
import {ensureInitializedProject02Home} from '../../src/runtime/storage/index.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {
  defaultRuntimeConfigPath,
  loadProject02RuntimeConfig,
  resolveProject02RuntimeConfig,
  roleModelProviderEnvVarName,
  runtimeControlEnvVarNames,
  runtimeConfigEnvVarName,
  runtimeConfigVersion,
} from '../../src/runtime/config/index.ts';
import {runRuntimeConfigCliFromArgs} from '../../src/cli/config/main.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {collect} from '../support/streams.ts';
import {
  requiredSecretPlugin,
  restoreProcessEnvValue,
} from '../support/runtime-config-fixtures.ts';

const installedSecretPlugin = requiredSecretPlugin('mem0-local');
const installedSecretFactories = Object.freeze({
  [installedSecretPlugin.manifest.id]: Object.freeze({
    manifest: installedSecretPlugin.manifest,
    create: () => installedSecretPlugin,
  }),
});

describe('runtime config CLI mutation and storage', () => {
  it('refuses global config writes when an initialized home cannot hold character data', async () => {
    const storeRoot = createTestTempRoot('project02-config-home-data-file-');
    let stderr = '';

    await ensureInitializedProject02Home({homeRoot: storeRoot});
    rmSync(join(storeRoot, 'character-data'), {recursive: true});
    writeFileSync(join(storeRoot, 'character-data'), 'not a directory\n');

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'set', 'project02.userDisplayName', 'Bob'],
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
    expect(existsSync(join(storeRoot, 'config.json'))).toBe(false);
  });

  it('validates the configured secret env home, not just the selected one', async () => {
    const storeA = createTestTempRoot('project02-config-env-home-a-');
    const storeB = createTestTempRoot('project02-config-env-home-b-');
    const outside = createTestTempRoot('project02-config-env-home-target-');
    const targetPath = join(outside, 'external.env');
    let stderr = '';

    // A's config points the store at B: the secret would land in
    // B/.env, so B's env file is the one that must be real.
    writeRuntimeConfig(join(storeA, 'config.json'), {
      project02: {storeRoot: storeB},
      plugins: {
        'mem0-local': {
          enabled: true,
          config: {apiKey: {$env: 'MEM0_API_KEY'}},
        },
      },
    });
    writeFileSync(targetPath, '');
    symlinkSync(targetPath, join(storeB, '.env'));

    const exitCode = await runRuntimeConfigCliFromArgs(
      [
        '--store',
        storeA,
        'secret',
        'set',
        'mem0-local',
        'apiKey',
        'MEM0_API_KEY',
      ],
      {
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        factories: installedSecretFactories,
        env: {MEM0_API_KEY: 'stored-secret'},
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Error:');
    expect(readFileSync(targetPath, 'utf8')).toBe('');
  });

  it('keeps the --store home guard when the config env var is set', async () => {
    const storeRoot = createTestTempRoot('project02-config-envvar-store-');
    const elsewhere = createTestTempRoot('project02-config-envvar-file-');
    const envSelectedPath = join(elsewhere, 'selected.json');
    let stderr = '';

    // With --store supplied the loader ignores the env var, so the
    // selected home must still pass the guard.
    writeRuntimeConfig(envSelectedPath, {});
    writeFileSync(join(storeRoot, 'notes.txt'), 'not a project02 home\n');

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'set', 'project02.userDisplayName', 'Bob'],
      {
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {[runtimeConfigEnvVarName]: envSelectedPath},
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Error:');
    expect(existsSync(join(storeRoot, 'config.json'))).toBe(false);
  });

  it('refuses secret writes through an explicit home config with a symlinked env', async () => {
    const storeRoot = createTestTempRoot('project02-config-explicit-env-link-');
    const outside = createTestTempRoot('project02-config-explicit-env-target-');
    const targetPath = join(outside, 'external.env');
    let stderr = '';

    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'mem0-local': {
          enabled: true,
          config: {apiKey: {$env: 'MEM0_API_KEY'}},
        },
      },
    });
    writeFileSync(targetPath, '');
    symlinkSync(targetPath, join(storeRoot, '.env'));

    // The explicit --config IS the home's default config: the derived
    // env file must still be a real in-home file.
    const exitCode = await runRuntimeConfigCliFromArgs(
      [
        '--config',
        configPath,
        'secret',
        'set',
        'mem0-local',
        'apiKey',
        'MEM0_API_KEY',
      ],
      {
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        factories: installedSecretFactories,
        env: {MEM0_API_KEY: 'stored-secret'},
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Error:');
    expect(readFileSync(targetPath, 'utf8')).toBe('');
  });

  it('refuses secret writes when the home env file is a symlink', async () => {
    const storeRoot = createTestTempRoot('project02-config-env-link-');
    const outside = createTestTempRoot('project02-config-env-link-target-');
    const targetPath = join(outside, 'external.env');
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'mem0-local': {
          enabled: true,
          config: {apiKey: {$env: 'MEM0_API_KEY'}},
        },
      },
    });
    writeFileSync(targetPath, '');
    symlinkSync(targetPath, join(storeRoot, '.env'));

    const exitCode = await runRuntimeConfigCliFromArgs(
      [
        '--store',
        storeRoot,
        'secret',
        'set',
        'mem0-local',
        'apiKey',
        'MEM0_API_KEY',
      ],
      {
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        factories: installedSecretFactories,
        env: {MEM0_API_KEY: 'stored-secret'},
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Error:');
    // The secret never lands outside the validated home.
    expect(readFileSync(targetPath, 'utf8')).toBe('');
  });

  it('refuses to read config values from a home the runtime would not adopt', async () => {
    const storeRoot = createTestTempRoot('project02-config-foreign-read-');
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      project02: {userDisplayName: 'Foreign Name'},
    });
    writeFileSync(join(storeRoot, 'notes.txt'), 'not a project02 home\n');

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'get', 'project02.userDisplayName'],
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

  it('refuses global writes when the home lock root is a symlink', async () => {
    const storeRoot = createTestTempRoot('project02-config-home-lock-link-');
    const outside = createTestTempRoot('project02-config-lock-target-');
    let stderr = '';

    symlinkSync(outside, join(storeRoot, '.locks'));

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'set', 'project02.userDisplayName', 'Bob'],
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
    expect(existsSync(join(storeRoot, 'config.json'))).toBe(false);
  });

  it('refuses global writes when the home config file is a symlink', async () => {
    const storeRoot = createTestTempRoot('project02-config-home-cfg-link-');
    const outside = createTestTempRoot('project02-config-cfg-target-');
    const targetPath = join(outside, 'external-config.json');
    let stderr = '';

    writeRuntimeConfig(targetPath, {
      project02: {userDisplayName: 'External'},
    });
    const targetBefore = readFileSync(targetPath, 'utf8');
    symlinkSync(targetPath, join(storeRoot, 'config.json'));

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'set', 'project02.userDisplayName', 'Bob'],
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
    // Authored config never moves outside the validated home.
    expect(readFileSync(targetPath, 'utf8')).toBe(targetBefore);
  });

  it('refuses to author global config into a home the runtime would not adopt', async () => {
    const storeRoot = createTestTempRoot('project02-config-foreign-home-');
    let stderr = '';

    writeFileSync(join(storeRoot, 'notes.txt'), 'not a project02 home\n');

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'set', 'project02.userDisplayName', 'Bob'],
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
    // The runtime would refuse this directory; authoritative settings
    // must not be written into it.
    expect(existsSync(join(storeRoot, 'config.json'))).toBe(false);
  });

  it('seeds explicit store roots into newly created store configs', async () => {
    const storeRoot = createTestTempRoot('project02-config-cli-store-seed-');
    const seededStoreRoot = realpathSync.native(storeRoot);
    const configPath = join(storeRoot, 'config.json');
    let setStdout = '';
    let envPathStdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'set', 'project02.roleModelProvider', 'local'],
        {
          stdout: collect(chunk => {
            setStdout += chunk;
          }),
          stderr: collect(() => {}),
        },
      ),
    ).toBe(0);

    expect(JSON.parse(setStdout) as unknown).toMatchObject({
      configPath,
      envPath: join(seededStoreRoot, '.env'),
    });
    expect(
      JSON.parse(readFileSync(configPath, 'utf8')) as unknown,
    ).toMatchObject({
      project02: {
        storeRoot: seededStoreRoot,
        roleModelProvider: 'local',
      },
    });

    expect(
      await runRuntimeConfigCliFromArgs(['env-path'], {
        stdout: collect(chunk => {
          envPathStdout += chunk;
        }),
        stderr: collect(() => {}),
        env: {
          [runtimeConfigEnvVarName]: configPath,
        },
      }),
    ).toBe(0);

    expect(envPathStdout).toBe(`${join(seededStoreRoot, '.env')}\n`);
  });

  it('seeds relative explicit store roots as absolute paths', async () => {
    const cwdRoot = createTestTempRoot(
      'project02-config-cli-relative-store-cwd-',
    );
    const otherCwd = createTestTempRoot(
      'project02-config-cli-relative-store-other-',
    );
    const relativeStoreRoot = 'runtime-store';
    const storeRoot = join(realpathSync.native(cwdRoot), relativeStoreRoot);
    const configPath = join(storeRoot, 'config.json');
    const previousCwd = process.cwd();
    let setStdout = '';
    let envPathStdout = '';

    try {
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(
          [
            '--store',
            relativeStoreRoot,
            'set',
            'project02.roleModelProvider',
            'local',
          ],
          {
            stdout: collect(chunk => {
              setStdout += chunk;
            }),
            stderr: collect(() => {}),
          },
        ),
      ).toBe(0);

      expect(JSON.parse(setStdout) as unknown).toMatchObject({
        configPath: join(relativeStoreRoot, 'config.json'),
        envPath: join(storeRoot, '.env'),
      });
      expect(
        JSON.parse(readFileSync(configPath, 'utf8')) as unknown,
      ).toMatchObject({
        project02: {
          storeRoot,
          roleModelProvider: 'local',
        },
      });

      process.chdir(otherCwd);

      expect(
        await runRuntimeConfigCliFromArgs(
          ['--config', configPath, 'env-path'],
          {
            stdout: collect(chunk => {
              envPathStdout += chunk;
            }),
            stderr: collect(() => {}),
          },
        ),
      ).toBe(0);

      expect(envPathStdout).toBe(`${join(storeRoot, '.env')}\n`);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('seeds env-selected missing store-default configs with their store root', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-cli-env-store-seed-',
    );
    const seededStoreRoot = realpathSync.native(storeRoot);
    const configPath = defaultRuntimeConfigPath(storeRoot);
    let setStdout = '';
    let envPathStdout = '';

    expect(existsSync(configPath)).toBe(false);

    expect(
      await runRuntimeConfigCliFromArgs(
        ['set', 'project02.roleModelProvider', 'local'],
        {
          stdout: collect(chunk => {
            setStdout += chunk;
          }),
          stderr: collect(() => {}),
          env: {
            [runtimeConfigEnvVarName]: configPath,
          },
        },
      ),
    ).toBe(0);

    expect(JSON.parse(setStdout) as unknown).toMatchObject({
      configPath,
      envPath: join(seededStoreRoot, '.env'),
    });
    expect(
      JSON.parse(readFileSync(configPath, 'utf8')) as unknown,
    ).toMatchObject({
      project02: {
        storeRoot: seededStoreRoot,
        roleModelProvider: 'local',
      },
    });

    const loaded = loadProject02RuntimeConfig({
      env: {
        [runtimeConfigEnvVarName]: configPath,
      },
    });
    const resolved = resolveProject02RuntimeConfig({loadedConfig: loaded});

    expect(resolved.project02.storeRoot).toBe(seededStoreRoot);

    expect(
      await runRuntimeConfigCliFromArgs(['env-path'], {
        stdout: collect(chunk => {
          envPathStdout += chunk;
        }),
        stderr: collect(() => {}),
        env: {
          [runtimeConfigEnvVarName]: configPath,
        },
      }),
    ).toBe(0);

    expect(envPathStdout).toBe(`${join(seededStoreRoot, '.env')}\n`);
  });

  it.each([
    {
      label: 'explicit --config',
      args(configPath: string) {
        return ['--config', configPath, 'env-path'] as const;
      },
      env(configPath: string) {
        void configPath;
        return {};
      },
    },
    {
      label: 'PROJECT02_RUNTIME_CONFIG',
      args() {
        return ['env-path'] as const;
      },
      env(configPath: string) {
        return {
          [runtimeConfigEnvVarName]: configPath,
        };
      },
    },
  ])(
    'infers env-path from a missing store-default config selected by $label',
    async example => {
      const storeRoot = createTestTempRoot(
        'project02-config-cli-missing-env-path-store-',
      );
      const seededStoreRoot = realpathSync.native(storeRoot);
      const configPath = defaultRuntimeConfigPath(storeRoot);
      let stdout = '';
      let stderr = '';

      expect(existsSync(configPath)).toBe(false);

      expect(
        await runRuntimeConfigCliFromArgs(example.args(configPath), {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(chunk => {
            stderr += chunk;
          }),
          env: example.env(configPath),
        }),
      ).toBe(0);

      expect(stdout).toBe(`${join(seededStoreRoot, '.env')}\n`);
      expect(stderr).toBe('');
      expect(existsSync(configPath)).toBe(false);
    },
  );

  it('seeds cwd dotenv-selected missing store-default configs with their store root', async () => {
    const cwdRoot = createTestTempRoot(
      'project02-config-cli-dotenv-store-seed-',
    );
    const storeRoot = createTestTempRoot(
      'project02-config-cli-dotenv-selected-store-',
    );
    const seededStoreRoot = realpathSync.native(storeRoot);
    const configPath = defaultRuntimeConfigPath(storeRoot);
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    let setStdout = '';
    let envPathStdout = '';

    writeFileSync(
      join(cwdRoot, '.env'),
      `${runtimeConfigEnvVarName}=${configPath}\n`,
      'utf8',
    );

    try {
      Reflect.deleteProperty(process.env, runtimeConfigEnvVarName);
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(
          ['set', 'project02.roleModelProvider', 'local'],
          {
            stdout: collect(chunk => {
              setStdout += chunk;
            }),
            stderr: collect(() => {}),
          },
        ),
      ).toBe(0);

      expect(JSON.parse(setStdout) as unknown).toMatchObject({
        configPath,
        envPath: join(seededStoreRoot, '.env'),
      });
      expect(
        JSON.parse(readFileSync(configPath, 'utf8')) as unknown,
      ).toMatchObject({
        project02: {
          storeRoot: seededStoreRoot,
          roleModelProvider: 'local',
        },
      });

      expect(
        await runRuntimeConfigCliFromArgs(['env-path'], {
          stdout: collect(chunk => {
            envPathStdout += chunk;
          }),
          stderr: collect(() => {}),
        }),
      ).toBe(0);

      expect(envPathStdout).toBe(`${join(seededStoreRoot, '.env')}\n`);
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
    }
  });

  it('keeps missing explicit non-default config bootstraps store-neutral', async () => {
    const configRoot = createTestTempRoot(
      'project02-config-cli-explicit-neutral-',
    );
    const configPath = join(configRoot, 'runtime.json');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'set', 'project02.roleModelProvider', 'local'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
        },
      ),
    ).toBe(0);

    expect(JSON.parse(readFileSync(configPath, 'utf8')) as unknown).toEqual({
      version: runtimeConfigVersion,
      project02: {
        roleModelProvider: 'local',
      },
    });
  });

  it('treats operands after -- as config values instead of location flags', async () => {
    const configRoot = createTestTempRoot(
      'project02-config-cli-delimiter-value-',
    );
    const configPath = join(configRoot, 'runtime.json');
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['set', 'project02.defaultMemoryProvider', '--', '--store'],
        {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(chunk => {
            stderr += chunk;
          }),
          env: {
            [runtimeConfigEnvVarName]: configPath,
          },
        },
      ),
    ).toBe(0);

    expect(stderr).toBe('');
    expect(JSON.parse(stdout) as unknown).toMatchObject({configPath});
    expect(
      JSON.parse(readFileSync(configPath, 'utf8')) as unknown,
    ).toMatchObject({
      project02: {
        defaultMemoryProvider: '--store',
      },
    });
  });

  it('keeps location flags before -- while escaping later operands', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-cli-delimiter-store-',
    );
    const seededStoreRoot = realpathSync.native(storeRoot);
    const configPath = join(storeRoot, 'config.json');
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        [
          '--store',
          storeRoot,
          'set',
          'project02.defaultMemoryProvider',
          '--',
          '--config',
        ],
        {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(chunk => {
            stderr += chunk;
          }),
        },
      ),
    ).toBe(0);

    expect(stderr).toBe('');
    expect(JSON.parse(stdout) as unknown).toMatchObject({configPath});
    expect(
      JSON.parse(readFileSync(configPath, 'utf8')) as unknown,
    ).toMatchObject({
      project02: {
        storeRoot: seededStoreRoot,
        defaultMemoryProvider: '--config',
      },
    });
  });

  it('rejects location flags after runtime-config command operands have started', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-cli-late-location-store-',
    );
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        [
          'set',
          'project02.defaultMemoryProvider',
          'hello',
          '--store',
          storeRoot,
        ],
        {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(chunk => {
            stderr += chunk;
          }),
        },
      ),
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toBe('Error: set does not accept extra arguments.\n');
    expect(existsSync(join(storeRoot, 'config.json'))).toBe(false);
  });

  it.each([
    {
      label: 'explicit --config',
      args(configPath: string) {
        return [
          '--config',
          configPath,
          'set',
          'project02.roleModelProvider',
          'nvidia',
        ] as const;
      },
      env(configPath: string) {
        void configPath;
        return {};
      },
    },
    {
      label: 'PROJECT02_RUNTIME_CONFIG',
      args() {
        return ['set', 'project02.roleModelProvider', 'nvidia'] as const;
      },
      env(configPath: string) {
        return {
          [runtimeConfigEnvVarName]: configPath,
        };
      },
    },
  ])('preserves symlinked config files for $label mutations', async example => {
    const configRoot = createTestTempRoot('project02-config-link-');
    const targetPath = writeRuntimeConfig(join(configRoot, 'target.json'), {
      project02: {
        roleModelProvider: 'local',
      },
    });
    const linkPath = join(configRoot, 'linked.json');
    let stdout = '';

    symlinkSync(targetPath, linkPath);

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);

    expect(
      await runRuntimeConfigCliFromArgs(example.args(linkPath), {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        env: example.env(linkPath),
      }),
    ).toBe(0);

    expect(JSON.parse(stdout) as unknown).toMatchObject({
      configPath: linkPath,
    });
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(targetPath);
    expect(
      JSON.parse(readFileSync(targetPath, 'utf8')) as unknown,
    ).toMatchObject({
      project02: {
        roleModelProvider: 'nvidia',
      },
    });
  });

  it.each([
    {
      label: 'explicit --config',
      args(configPath: string) {
        return [
          '--config',
          configPath,
          'set',
          'project02.roleModelProvider',
          'nvidia',
        ] as const;
      },
      env(configPath: string) {
        void configPath;
        return {};
      },
    },
    {
      label: 'PROJECT02_RUNTIME_CONFIG',
      args() {
        return ['set', 'project02.roleModelProvider', 'nvidia'] as const;
      },
      env(configPath: string) {
        return {
          [runtimeConfigEnvVarName]: configPath,
        };
      },
    },
  ])(
    'bootstraps missing config through dangling symlink files for $label mutations',
    async example => {
      const configRoot = createTestTempRoot('project02-config-dangling-link-');
      const targetName = 'target.json';
      const targetPath = join(configRoot, targetName);
      const linkPath = join(configRoot, 'linked.json');
      let stdout = '';

      symlinkSync(targetName, linkPath);

      expect(existsSync(linkPath)).toBe(false);
      expect(existsSync(targetPath)).toBe(false);
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);

      expect(
        await runRuntimeConfigCliFromArgs(example.args(linkPath), {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(() => {}),
          env: example.env(linkPath),
        }),
      ).toBe(0);

      expect(JSON.parse(stdout) as unknown).toMatchObject({
        configPath: linkPath,
      });
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(linkPath)).toBe(targetName);
      expect(JSON.parse(readFileSync(targetPath, 'utf8')) as unknown).toEqual({
        version: runtimeConfigVersion,
        project02: {
          roleModelProvider: 'nvidia',
        },
      });
    },
  );

  it.each([
    {
      label: 'explicit --config',
      args(configPath: string) {
        return [
          '--config',
          configPath,
          'set',
          'project02.roleModelProvider',
          'nvidia',
        ] as const;
      },
      env(configPath: string) {
        void configPath;
        return {};
      },
    },
    {
      label: 'PROJECT02_RUNTIME_CONFIG',
      args() {
        return ['set', 'project02.roleModelProvider', 'nvidia'] as const;
      },
      env(configPath: string) {
        return {
          [runtimeConfigEnvVarName]: configPath,
        };
      },
    },
  ])(
    'bootstraps symlinked store-default configs from canonical target store roots for $label mutations',
    async example => {
      const targetStoreRoot = createTestTempRoot(
        'project02-config-link-default-target-',
      );
      const linkStoreRoot = createTestTempRoot(
        'project02-config-link-default-selected-',
      );
      const seededStoreRoot = realpathSync.native(targetStoreRoot);
      const targetConfigPath = defaultRuntimeConfigPath(targetStoreRoot);
      const linkConfigPath = defaultRuntimeConfigPath(linkStoreRoot);
      let stdout = '';

      symlinkSync(targetConfigPath, linkConfigPath);

      expect(existsSync(linkConfigPath)).toBe(false);
      expect(existsSync(targetConfigPath)).toBe(false);
      expect(lstatSync(linkConfigPath).isSymbolicLink()).toBe(true);

      expect(
        await runRuntimeConfigCliFromArgs(example.args(linkConfigPath), {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(() => {}),
          env: example.env(linkConfigPath),
        }),
      ).toBe(0);

      expect(JSON.parse(stdout) as unknown).toMatchObject({
        configPath: linkConfigPath,
        envPath: join(seededStoreRoot, '.env'),
      });
      expect(lstatSync(linkConfigPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(linkConfigPath)).toBe(targetConfigPath);
      expect(
        JSON.parse(readFileSync(targetConfigPath, 'utf8')) as unknown,
      ).toEqual({
        version: runtimeConfigVersion,
        project02: {
          storeRoot: seededStoreRoot,
          roleModelProvider: 'nvidia',
        },
      });
    },
  );

  it('writes secret env files under the configured store root', async () => {
    const configRoot = createTestTempRoot('project02-config-file-');
    const storeRoot = createTestTempRoot('project02-config-effective-store-');
    const configPath = join(configRoot, 'runtime.json');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'set', 'project02.storeRoot', storeRoot],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
        },
      ),
    ).toBe(0);
    expect(
      await runRuntimeConfigCliFromArgs(
        [
          '--config',
          configPath,
          'secret',
          'set',
          'mem0-local',
          'apiKey',
          'MEM0_API_KEY',
        ],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
          factories: installedSecretFactories,
          env: {MEM0_API_KEY: 'stored-secret'},
        },
      ),
    ).toBe(0);

    expect(readFileSync(join(storeRoot, '.env'), 'utf8')).toContain(
      'MEM0_API_KEY="stored-secret"',
    );
  });

  it.each(runtimeControlEnvVarNames)(
    'rejects reserved runtime control env var %s before creating secret files',
    async envVar => {
      const storeRoot = createTestTempRoot('project02-config-secret-reserved-');
      let stdout = '';
      let stderr = '';

      expect(
        await runRuntimeConfigCliFromArgs(
          [
            '--store',
            storeRoot,
            'secret',
            'set',
            'mem0-local',
            'apiKey',
            envVar,
          ],
          {
            stdout: collect(chunk => {
              stdout += chunk;
            }),
            stderr: collect(chunk => {
              stderr += chunk;
            }),
            factories: installedSecretFactories,
            env: {[envVar]: 'stored-secret'},
          },
        ),
      ).toBe(1);

      expect(stdout).toBe('');
      expect(stderr).toContain(
        `cannot use reserved Project02 runtime control env var "${envVar}"`,
      );
      expect(existsSync(join(storeRoot, '.env'))).toBe(false);
      expect(existsSync(join(storeRoot, 'config.json'))).toBe(false);
    },
  );

  it('rejects the role-model provider control env var without modifying existing secret files', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-secret-reserved-existing-',
    );
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'mem0-local': {
          config: {
            apiKey: {$env: 'PROJECT02_EXISTING_SECRET'},
          },
        },
      },
    });
    const envPath = join(storeRoot, '.env');
    const originalConfig = readFileSync(configPath, 'utf8');
    const originalEnv = [
      '# keep existing env material',
      'PROJECT02_EXISTING_SECRET="keep-existing"',
      '',
    ].join('\n');
    let stdout = '';
    let stderr = '';

    writeFileSync(envPath, originalEnv, 'utf8');

    expect(
      await runRuntimeConfigCliFromArgs(
        [
          '--store',
          storeRoot,
          'secret',
          'set',
          'mem0-local',
          'apiKey',
          roleModelProviderEnvVarName,
        ],
        {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(chunk => {
            stderr += chunk;
          }),
          factories: installedSecretFactories,
          env: {[roleModelProviderEnvVarName]: 'stored-secret'},
        },
      ),
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toContain(
      `cannot use reserved Project02 runtime control env var "${roleModelProviderEnvVarName}"`,
    );
    expect(readFileSync(configPath, 'utf8')).toBe(originalConfig);
    expect(readFileSync(envPath, 'utf8')).toBe(originalEnv);
  });

  it.each([
    {
      label: 'explicit --config',
      args(configPath: string) {
        return [
          '--config',
          configPath,
          'secret',
          'set',
          'mem0-local',
          'apiKey',
          'MEM0_API_KEY',
        ] as const;
      },
      env(configPath: string) {
        void configPath;
        return {MEM0_API_KEY: 'stored-secret'};
      },
    },
    {
      label: 'PROJECT02_RUNTIME_CONFIG',
      args() {
        return [
          'secret',
          'set',
          'mem0-local',
          'apiKey',
          'MEM0_API_KEY',
        ] as const;
      },
      env(configPath: string) {
        return {
          PROJECT02_RUNTIME_CONFIG: configPath,
          MEM0_API_KEY: 'stored-secret',
        };
      },
    },
  ])(
    'rejects secret writes when $label aliases the runtime env path',
    async example => {
      const storeRoot = createTestTempRoot('project02-config-secret-alias-');
      const configPath = writeRuntimeConfig(join(storeRoot, '.env'), {
        storeRoot,
      });
      const originalConfig = readFileSync(configPath, 'utf8');
      let stdout = '';
      let stderr = '';

      expect(
        await runRuntimeConfigCliFromArgs(example.args(configPath), {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(chunk => {
            stderr += chunk;
          }),
          factories: installedSecretFactories,
          env: example.env(configPath),
        }),
      ).toBe(1);

      expect(stdout).toBe('');
      expect(stderr).toContain(
        'selected config path and runtime env path resolve to the same file',
      );
      expect(readFileSync(configPath, 'utf8')).toBe(originalConfig);
      expect(readFileSync(configPath, 'utf8')).not.toContain('stored-secret');
    },
  );

  it('rejects secret writes when a missing config path aliases the env path through a symlink parent', async () => {
    const storeRoot = createTestTempRoot('project02-config-secret-link-store-');
    const configRoot = createTestTempRoot(
      'project02-config-secret-link-config-',
    );
    const configParent = join(configRoot, 'linked-store');
    const configPath = join(configParent, '.env');
    const envPath = join(storeRoot, '.env');
    const existingPath = join(storeRoot, 'existing.txt');
    let stdout = '';
    let stderr = '';

    writeFileSync(existingPath, 'preserve existing file\n', 'utf8');
    symlinkSync(storeRoot, configParent, 'dir');

    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(envPath)).toBe(false);

    expect(
      await runRuntimeConfigCliFromArgs(
        [
          '--store',
          storeRoot,
          '--config',
          configPath,
          'secret',
          'set',
          'mem0-local',
          'apiKey',
          'MEM0_API_KEY',
        ],
        {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(chunk => {
            stderr += chunk;
          }),
          factories: installedSecretFactories,
          env: {MEM0_API_KEY: 'stored-secret'},
        },
      ),
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toContain(
      'selected config path and runtime env path resolve to the same file',
    );
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(envPath)).toBe(false);
    expect(readFileSync(existingPath, 'utf8')).toBe('preserve existing file\n');
  });

  it('rejects secret writes when a dangling config symlink targets the runtime env path', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-secret-dangling-link-store-',
    );
    const configRoot = createTestTempRoot(
      'project02-config-secret-dangling-link-config-',
    );
    const envPath = join(storeRoot, '.env');
    const configPath = join(configRoot, 'linked-env.json');
    let stdout = '';
    let stderr = '';

    symlinkSync(envPath, configPath);

    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(envPath)).toBe(false);
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);

    expect(
      await runRuntimeConfigCliFromArgs(
        [
          '--store',
          storeRoot,
          '--config',
          configPath,
          'secret',
          'set',
          'mem0-local',
          'apiKey',
          'MEM0_API_KEY',
        ],
        {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(chunk => {
            stderr += chunk;
          }),
          factories: installedSecretFactories,
          env: {MEM0_API_KEY: 'stored-secret'},
        },
      ),
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toContain(
      'selected config path and runtime env path resolve to the same file',
    );
    expect(existsSync(envPath)).toBe(false);
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(configPath)).toBe(envPath);
  });

  it('reports config write failures without leaking raw filesystem exceptions', async () => {
    const root = createTestTempRoot('project02-config-write-blocked-');
    const blockedParent = join(root, 'not-a-directory');
    const configPath = join(blockedParent, 'runtime.json');
    let stdout = '';
    let stderr = '';

    writeFileSync(blockedParent, 'blocks recursive mkdir', 'utf8');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'set', 'project02.storeRoot', 'next-store'],
        {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(chunk => {
            stderr += chunk;
          }),
        },
      ),
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toBe(
      `Error: Could not write runtime config file at ${configPath}.\n`,
    );
    expect(stderr).not.toContain('EEXIST');
  });

  it('reports env secret write failures and rolls back the config update', async () => {
    const configRoot = createTestTempRoot('project02-config-env-blocked-');
    const blockedStoreRoot = join(configRoot, 'not-a-directory');
    const configPath = writeRuntimeConfig(join(configRoot, 'runtime.json'), {
      storeRoot: blockedStoreRoot,
    });
    const originalConfig = readFileSync(configPath, 'utf8');
    let stdout = '';
    let stderr = '';

    writeFileSync(blockedStoreRoot, 'blocks recursive mkdir', 'utf8');

    expect(
      await runRuntimeConfigCliFromArgs(
        [
          '--config',
          configPath,
          'secret',
          'set',
          'mem0-local',
          'apiKey',
          'MEM0_API_KEY',
        ],
        {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(chunk => {
            stderr += chunk;
          }),
          factories: installedSecretFactories,
          env: {MEM0_API_KEY: 'stored-secret'},
        },
      ),
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toBe(
      `Error: Could not write runtime config env file at ${join(blockedStoreRoot, '.env')}.\n`,
    );
    expect(stderr).not.toContain('EEXIST');
    expect(readFileSync(configPath, 'utf8')).toBe(originalConfig);
  });

  it('preserves dangling config symlinks when secret env write rollback removes a created target', async () => {
    const configRoot = createTestTempRoot(
      'project02-config-env-blocked-dangling-link-',
    );
    const blockedStoreRoot = join(configRoot, 'not-a-directory');
    const canonicalBlockedStoreRoot = join(
      realpathSync.native(configRoot),
      'not-a-directory',
    );
    const targetName = 'target.json';
    const targetPath = join(configRoot, targetName);
    const configPath = join(configRoot, 'linked.json');
    let stdout = '';
    let stderr = '';

    writeFileSync(blockedStoreRoot, 'blocks recursive mkdir', 'utf8');
    symlinkSync(targetName, configPath);

    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(targetPath)).toBe(false);
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);

    expect(
      await runRuntimeConfigCliFromArgs(
        [
          '--store',
          blockedStoreRoot,
          '--config',
          configPath,
          'secret',
          'set',
          'mem0-local',
          'apiKey',
          'MEM0_API_KEY',
        ],
        {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(chunk => {
            stderr += chunk;
          }),
          factories: installedSecretFactories,
          env: {MEM0_API_KEY: 'stored-secret'},
        },
      ),
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toBe(
      `Error: Could not write runtime config env file at ${join(canonicalBlockedStoreRoot, '.env')}.\n`,
    );
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(targetPath)).toBe(false);
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(configPath)).toBe(targetName);
  });

  it('reports env secret read failures before writing config updates', async () => {
    const storeRoot = createTestTempRoot('project02-config-env-read-blocked-');
    const envPath = join(realpathSync.native(storeRoot), '.env');
    const displayEnvPath = join(storeRoot, '.env');
    let stdout = '';
    let stderr = '';

    mkdirSync(envPath);

    expect(
      await runRuntimeConfigCliFromArgs(
        [
          '--store',
          storeRoot,
          'secret',
          'set',
          'mem0-local',
          'apiKey',
          'MEM0_API_KEY',
        ],
        {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(chunk => {
            stderr += chunk;
          }),
          factories: installedSecretFactories,
          env: {MEM0_API_KEY: 'stored-secret'},
        },
      ),
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toBe(
      `Error: Could not read runtime config env file at ${displayEnvPath}.\n`,
    );
    expect(stderr).not.toContain('EISDIR');
    expect(existsSync(join(storeRoot, 'config.json'))).toBe(false);
  });

  it('uses unique temporary names when a stale predictable temp path exists', () => {
    const configRoot = createTestTempRoot('project02-config-write-fail-');
    const storeRoot = createTestTempRoot('project02-config-orphan-secret-');
    const configPath = writeRuntimeConfig(join(configRoot, 'runtime.json'), {
      storeRoot,
    });
    const timestamp = 3448006099;
    const configTempPath = `${configPath}.${String(process.pid)}.${String(timestamp)}.tmp`;

    mkdirSync(configTempPath);

    applyRuntimeConfigMutation({
      configPath,
      operation: {
        kind: 'secret_set',
        pluginId: 'mem0-local',
        fieldName: 'apiKey',
        envVar: 'MEM0_API_KEY',
        secretValue: 'stored-secret',
      },
    });

    expect(readFileSync(configPath, 'utf8')).toContain(
      '"$env": "MEM0_API_KEY"',
    );
    expect(readFileSync(join(storeRoot, '.env'), 'utf8')).toContain(
      'MEM0_API_KEY="stored-secret"',
    );
    expect(statSync(configTempPath).isDirectory()).toBe(true);
  });

  it('reports env paths from the post-mutation store root', () => {
    const configRoot = createTestTempRoot('project02-config-env-output-');
    const initialStoreRoot = createTestTempRoot(
      'project02-config-env-output-initial-',
    );
    const nextStoreRoot = createTestTempRoot(
      'project02-config-env-output-next-',
    );
    const configPath = writeRuntimeConfig(join(configRoot, 'runtime.json'), {
      storeRoot: initialStoreRoot,
    });

    const setResult = applyRuntimeConfigMutation({
      configPath,
      operation: {
        kind: 'set',
        path: 'project02.storeRoot',
        value: nextStoreRoot,
      },
    });

    expect(setResult.config.project02?.storeRoot).toBe(nextStoreRoot);
    expect(setResult.envPath).toBe(join(nextStoreRoot, '.env'));

    const unsetResult = applyRuntimeConfigMutation({
      configPath,
      storeRoot: initialStoreRoot,
      operation: {kind: 'unset', path: 'project02.storeRoot'},
    });

    expect(unsetResult.config.project02?.storeRoot).toBeUndefined();
    expect(unsetResult.envPath).toBe(join(initialStoreRoot, '.env'));
  });

  it('writes mutations to the normalized selected config path', () => {
    const configRoot = createTestTempRoot('project02-config-normalized-write-');
    const configPath = writeRuntimeConfig(join(configRoot, 'runtime.json'), {
      storeRoot: 'initial-store',
    });
    const paddedConfigPath = ' runtime.json ';
    const previousCwd = process.cwd();

    try {
      process.chdir(configRoot);

      const result = applyRuntimeConfigMutation({
        configPath: paddedConfigPath,
        operation: {
          kind: 'set',
          path: 'project02.storeRoot',
          value: 'next-store',
        },
      });
      const config: unknown = JSON.parse(readFileSync(configPath, 'utf8'));

      expect(result.configPath).toBe('runtime.json');
      expect(config).toMatchObject({
        project02: {storeRoot: 'next-store'},
      });
      expect(existsSync(join(configRoot, paddedConfigPath))).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('prints the explicit config path selected by --config', async () => {
    const configRoot = createTestTempRoot('project02-config-path-');
    const configPath = join(configRoot, 'runtime.json');
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(['--config', configPath, 'path'], {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
      }),
    ).toBe(0);

    expect(stdout).toBe(`${configPath}\n`);
    expect(stderr).toBe('');
  });

  it('prints explicit location paths without reading unrelated cwd dotenv', async () => {
    const cwdRoot = createTestTempRoot('project02-config-path-cwd-env-');
    const storeRoot = createTestTempRoot(
      'project02-config-path-explicit-store-',
    );
    const configPath = join(
      createTestTempRoot('project02-config-path-explicit-config-'),
      'runtime.json',
    );
    const previousCwd = process.cwd();

    mkdirSync(join(cwdRoot, '.env'));

    try {
      process.chdir(cwdRoot);

      for (const example of [
        {
          args: ['--store', storeRoot, 'path'] as const,
          expected: defaultRuntimeConfigPath(storeRoot),
        },
        {
          args: ['--config', configPath, 'path'] as const,
          expected: configPath,
        },
      ]) {
        let stdout = '';
        let stderr = '';

        expect(
          await runRuntimeConfigCliFromArgs(example.args, {
            stdout: collect(chunk => {
              stdout += chunk;
            }),
            stderr: collect(chunk => {
              stderr += chunk;
            }),
          }),
        ).toBe(0);

        expect(stdout).toBe(`${example.expected}\n`);
        expect(stderr).toBe('');
      }
    } finally {
      process.chdir(previousCwd);
    }
  });
});
