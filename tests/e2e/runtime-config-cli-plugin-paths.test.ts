import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { describe, expect, it } from 'vitest';
import { createTestTempRoot } from '../support/temp-root.ts';
import { runRuntimeConfigCliFromArgs } from '../../src/cli/config/main.ts';
import {
  writeRuntimeConfig
} from '../support/runtime-config.ts';
import { collect } from '../support/streams.ts';
import { requiredSecretPlugin } from '../support/runtime-config-fixtures.ts';

const installedSecretPlugin = requiredSecretPlugin('mem0-local');
const installedSecretFactories = Object.freeze({
  [installedSecretPlugin.manifest.id]: Object.freeze({
    manifest: installedSecretPlugin.manifest,
    create: () => installedSecretPlugin
  })
});

describe('runtime config CLI plugin paths', () => {
  it('rejects plugin writes outside installed manifest metadata', async () => {
    const plugin = requiredSecretPlugin('memory.required');
    const secretValue = 'h02-secret-value';
    const cases = [
      {
        label: 'generic set on a declared secret field',
        args: [
          'set',
          'plugins.memory.required.config.apiKey',
          'plaintext-value'
        ],
        env: {}
      },
      {
        label: 'secret set on an uninstalled plugin',
        args: [
          'secret',
          'set',
          'not.installed',
          'apiKey',
          'PROJECT02_H02_SECRET'
        ],
        env: { PROJECT02_H02_SECRET: secretValue }
      },
      {
        label: 'secret set on an undeclared field',
        args: [
          'secret',
          'set',
          plugin.manifest.id,
          'notDeclared',
          'PROJECT02_H02_SECRET'
        ],
        env: { PROJECT02_H02_SECRET: secretValue }
      }
    ] as const;
    const results = await Promise.all(
      cases.map(async (example) => {
        const storeRoot = createTestTempRoot('project02-config-manifest-write-');
        let stdout = '';
        let stderr = '';
        const exitCode = await runRuntimeConfigCliFromArgs(
          ['--store', storeRoot, ...example.args],
          {
            stdout: collect((chunk) => {
              stdout += chunk;
            }),
            stderr: collect((chunk) => {
              stderr += chunk;
            }),
            env: example.env,
            factories: {
              [plugin.manifest.id]: {
                manifest: plugin.manifest,
                create: () => plugin
              }
            }
          }
        );

        return {
          label: example.label,
          storeRoot,
          exitCode,
          stdout,
          stderr
        };
      })
    );

    expect(results.map(({ label, exitCode }) => ({ label, exitCode }))).toEqual(
      cases.map(({ label }) => ({ label, exitCode: 1 }))
    );

    for (const result of results) {
      expect(result.stdout, result.label).toBe('');
      expect(result.stderr, result.label).not.toContain(secretValue);
      expect(existsSync(join(result.storeRoot, 'config.json')), result.label).toBe(
        false
      );
      expect(existsSync(join(result.storeRoot, '.env')), result.label).toBe(false);
    }
  });

  it('refuses to mutate malformed existing config files', async () => {
    const configRoot = createTestTempRoot('project02-config-malformed-');
    const configPath = join(configRoot, 'config.json');
    const malformedConfig = '{"version":';
    let stderr = '';

    writeFileSync(configPath, malformedConfig, 'utf8');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'set', 'project02.storeRoot', 'next-store'],
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

  it('writes dotenv secrets so quotes and backslashes round-trip through env loading', async () => {
    const storeRoot = createTestTempRoot('project02-config-secret-escaping-');
    const envVar = 'PROJECT02_SECRET_ROUNDTRIP_QUOTES';
    const secretValue = String.raw`single' double" slash\ value`;

    Reflect.deleteProperty(process.env, envVar);
    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'apiKey', envVar],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
          env: { [envVar]: secretValue },
          factories: installedSecretFactories
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
        ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'apiKey', envVar],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
          env: { [envVar]: secretValue },
          factories: installedSecretFactories
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
            apiKey: { $env: 'PROJECT02_EXISTING_SECRET' }
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
        ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'apiKey', envVar],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect((chunk) => {
            stderr += chunk;
          }),
          env: { [envVar]: secretValue },
          factories: installedSecretFactories
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
        ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'apiKey', envVar],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect((chunk) => {
            stderr += chunk;
          }),
          env: { [envVar]: secretValue },
          factories: installedSecretFactories
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
        ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'apiKey', envVar],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
          env: { [envVar]: newSecret },
          factories: installedSecretFactories
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
        ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'apiKey', envVar],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
          env: { [envVar]: newSecret },
          factories: installedSecretFactories
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
        ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'apiKey', envVar],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
          env: { [envVar]: newSecret },
          factories: installedSecretFactories
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
        ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'apiKey', envVar],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
          env: { [envVar]: newSecret },
          factories: installedSecretFactories
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
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'get', 'project02.storeRoot'],
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
    expect(stderr).toContain('Runtime config field must be a non-empty string.');
  });

});
