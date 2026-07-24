import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Readable} from 'node:stream';

import {describe, expect, it} from 'vitest';

import {runRuntimeConfigCliFromArgs} from '../../src/cli/config/main.ts';
import {ensureConsoleCommitTarget} from '../../src/cli/config/console-shared.ts';
import {
  characterDataDirPath,
  ensureCharacterDataMarker,
} from '../../src/runtime/storage/index.ts';
import type {RuntimeConfigConsolePromptAdapter} from '../../src/cli/config/console.ts';
import type {RuntimePlugin} from '../../src/plugins/api/types.ts';
import {
  runtimeConfigEnvVarName,
  runtimeConfigVersion,
} from '../../src/runtime/config/index.ts';
import type {RuntimePluginFactoryDefinition} from '../../src/app/index.ts';
import {
  requiredDottedConfigPlugin,
  requiredSecretPlugin,
  requiredSecretPluginWithManifestEnvVar,
} from '../support/runtime-config-fixtures.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {collect} from '../support/streams.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

type ScriptedPromptStep =
  | string
  | {
      readonly answer: string | (() => string);
      readonly beforeAnswer?: () => void;
    };

describe('runtime config console UI', () => {
  it('refuses an unscoped console commit into a foreign home', async () => {
    const homeRoot = createTestTempRoot('project02-console-foreign-home-');

    writeFileSync(join(homeRoot, 'notes.txt'), 'not a project02 home\n');

    await expect(
      ensureConsoleCommitTarget({storeRoot: homeRoot, env: {}}, undefined),
    ).rejects.toThrow();
    expect(existsSync(join(homeRoot, 'config.json'))).toBe(false);
    expect(existsSync(join(homeRoot, '.locks'))).toBe(false);
  });

  it('keeps the --store console guard when the config env var is set', async () => {
    const homeRoot = createTestTempRoot('project02-console-envvar-store-');
    const elsewhere = createTestTempRoot('project02-console-envvar-file-');
    const envSelectedPath = join(elsewhere, 'selected.json');

    writeRuntimeConfig(envSelectedPath, {});
    writeFileSync(join(homeRoot, 'notes.txt'), 'not a project02 home\n');

    await expect(
      ensureConsoleCommitTarget(
        {
          storeRoot: homeRoot,
          env: {[runtimeConfigEnvVarName]: envSelectedPath},
        },
        undefined,
      ),
    ).rejects.toThrow();
    expect(existsSync(join(homeRoot, 'config.json'))).toBe(false);
  });

  it('revalidates scoped layers before a console save materializes state', async () => {
    const homeRoot = createTestTempRoot('project02-console-bad-overlay-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    // The overlay went bad after the console opened: the save must
    // fail before ensure writes either storage marker.
    mkdirSync(dataRoot, {recursive: true});
    writeFileSync(join(dataRoot, 'config.json'), '{not json\n');

    await expect(
      ensureConsoleCommitTarget(
        {storeRoot: homeRoot, env: {}},
        {characterId: 'mira', dataRoot},
      ),
    ).rejects.toThrow();
    expect(existsSync(join(dataRoot, 'schema.json'))).toBe(false);
    expect(existsSync(join(homeRoot, 'schema.json'))).toBe(false);
  });

  it('saves a scoped edit with an explicit global config', async () => {
    const homeRoot = createTestTempRoot('project02-console-alias-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');
    const overlayPath = join(dataRoot, 'config.json');
    const globalConfigPath = join(homeRoot, 'config.json');
    let stdout = '';

    writeRuntimeConfig(globalConfigPath, {
      project02: {roleModelProvider: 'local'},
    });
    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });
    writeRuntimeConfig(overlayPath, {});

    // The snapshot fingerprints the selected global document plus the
    // overlay — the same pair the commit verifies.
    const exitCode = await runRuntimeConfigCliFromArgs(
      [
        '--store',
        homeRoot,
        '--character',
        'mira',
        '--config',
        globalConfigPath,
        'ui',
      ],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        env: {},
        prompt: scriptedPrompt(['1', '3', '1', 'Aliased Name', '1']),
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Saved project02.userDisplayName.');
    expect(JSON.parse(readFileSync(overlayPath, 'utf8'))).toMatchObject({
      project02: {userDisplayName: 'Aliased Name'},
    });
  });

  it('exits cleanly when the default prompt reaches stdin EOF', async () => {
    const storeRoot = createTestTempRoot('project02-config-console-eof-');
    let stdout = '';
    let stderr = '';

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'ui'],
      {
        stdin: Readable.from([]),
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Project02 Runtime Config');
  });

  it('accepts a quit command through the default terminal prompt', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-console-default-prompt-',
    );
    let stdout = '';
    let stderr = '';

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'ui'],
      {
        stdin: Readable.from(['q\n']),
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Select a section: ');
  });

  it('groups default catalog plugins and system services in one selectable list', async () => {
    const storeRoot = createTestTempRoot('project02-config-console-groups-');
    let stdout = '';

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'ui'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        prompt: scriptedPrompt(['2', 'q']),
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(
      /Plugins\n1\) .+ \(character-state\)\n2\) .+ \(demo-config\)\nSystem services\n3\) .+ \(first_party\.model_tools\)\n4\) .+ \(runtime\.plugin\)/,
    );
    expect(stdout.match(/\(runtime\.plugin\)/g)).toHaveLength(1);
    expect(stdout).not.toContain('runtime.plugin_discovery');
    expect(stdout).not.toContain('runtime.plugin_config');
  });

  it('cold-discovers operator packages in the same Plugins section', async () => {
    const storeRoot = createTestTempRoot('project02-config-console-operator-');
    const plugin = requiredDottedConfigPlugin('operator.console', 'endpoint');
    const packageRoot = join(storeRoot, 'plugins', plugin.manifest.id);
    let stdout = '';

    mkdirSync(packageRoot, {recursive: true});
    writeFileSync(
      join(packageRoot, 'package.json'),
      `${JSON.stringify({type: 'module'})}\n`,
      'utf8',
    );
    writeFileSync(
      join(packageRoot, 'project02.plugin.json'),
      `${JSON.stringify({
        format: 'project02.plugin.v1',
        entry: './index.mjs',
        manifest: plugin.manifest,
      })}\n`,
      'utf8',
    );
    writeFileSync(
      join(packageRoot, 'index.mjs'),
      "throw new Error('console must not import plugin entries');\n",
      'utf8',
    );

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'ui'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        prompt: scriptedPrompt(['2', 'q']),
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(
      /Plugins\n(?:\d+\) .+\n)*?\d+\) .+ \(operator\.console\)\n(?:\d+\) .+\n)*?System services/,
    );
  });

  it('shows an operator package as disabled despite its manifest default claim', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-console-operator-default-',
    );
    const plugin = requiredDottedConfigPlugin(
      'operator.console-default',
      'endpoint',
    );
    const packageRoot = join(storeRoot, 'plugins', plugin.manifest.id);
    let stdout = '';

    mkdirSync(packageRoot, {recursive: true});
    writeFileSync(
      join(packageRoot, 'package.json'),
      `${JSON.stringify({type: 'module'})}\n`,
      'utf8',
    );
    writeFileSync(
      join(packageRoot, 'project02.plugin.json'),
      `${JSON.stringify({
        format: 'project02.plugin.v1',
        entry: './index.mjs',
        manifest: plugin.manifest,
      })}\n`,
      'utf8',
    );
    writeFileSync(
      join(packageRoot, 'index.mjs'),
      "throw new Error('console must not import plugin entries');\n",
      'utf8',
    );

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'ui'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        prompt: scriptedPrompt([
          '2',
          selectPluginStep(() => stdout, 'operator.console-default'),
          'q',
        ]),
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      'Required Memory (operator.console-default)\n1) Enabled: false',
    );
  });

  it('selects a system service through the continuous plugin index', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-console-system-selection-',
    );
    let stdout = '';

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'ui'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        prompt: scriptedPrompt([
          '2',
          selectPluginStep(() => stdout, 'runtime.plugin'),
          'q',
        ]),
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(
      /System services\n(?:.*\n)*?\d+\) .+ \(runtime\.plugin\)/,
    );
    expect(stdout).toContain('(runtime.plugin)\n1) Enabled:');
  });

  it('re-enables runtime.plugin through the operator console recovery path', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-console-runtime-plugin-recovery-',
    );
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'runtime.plugin': {
          enabled: false,
        },
      },
    });
    let stdout = '';

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'ui'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        prompt: scriptedPrompt([
          '2',
          selectPluginStep(() => stdout, 'runtime.plugin'),
          '1',
          '1',
          '1',
        ]),
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Target: plugins.runtime.plugin.enabled');
    expect(stdout).toContain('Old: false');
    expect(stdout).toContain('New: true');
    expect(stdout).toContain('Saved plugins.runtime.plugin.enabled.');
    expect(
      JSON.parse(readFileSync(configPath, 'utf8')) as unknown,
    ).toMatchObject({
      plugins: {
        'runtime.plugin': {
          enabled: true,
        },
      },
    });
  });

  it('lists package factories separately from canonical bootstrap services', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-console-plugin-group-',
    );
    const plugin = requiredDottedConfigPlugin('sample.plugin', 'endpoint');
    let stdout = '';

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'ui'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories: factoriesFor(plugin),
        prompt: scriptedPrompt(['2', 'q']),
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('\nPlugins\n1) Required Memory (sample.plugin)\n');
    expect(stdout).toContain('\nSystem services\n');
    expect(stdout).toContain('runtime.plugin');
  });

  it('reports a default terminal prompt input failure without hanging', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-console-input-failure-',
    );
    const input = new Readable({
      read() {
        this.destroy(new Error('console input failed'));
      },
    });
    let stderr = '';

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'ui'],
      {
        stdin: input,
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('console input failed');
  });

  it('edits a Project02 field from shared schema metadata after a redacted preview', async () => {
    const storeRoot = createTestTempRoot('project02-config-console-host-');
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      project02: {
        storeRoot,
        roleModelProvider: 'local',
      },
    });
    let stdout = '';
    let stderr = '';

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'ui'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        prompt: scriptedPrompt(['1', '4', '1', 'unsupported', 'nvidia', '1']),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Project02');
    expect(stdout).toContain('Role-model provider');
    expect(stdout).toContain('Expected one of: local, nvidia.');
    expect(stdout).toContain('Target: project02.roleModelProvider');
    expect(stdout).toContain('Old: "local"');
    expect(stdout).toContain('New: "nvidia"');
    expect(stdout).toContain('Saved project02.roleModelProvider.');
    expect(
      JSON.parse(readFileSync(configPath, 'utf8')) as unknown,
    ).toMatchObject({
      version: runtimeConfigVersion,
      project02: {
        roleModelProvider: 'nvidia',
      },
    });
  });

  it('edits a declared non-secret plugin field through the structured operator control', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-console-plugin-field-',
    );
    const plugin = requiredDottedConfigPlugin('sample.plugin', 'endpoint');
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      project02: {storeRoot},
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {endpoint: 'local'},
        },
      },
    });
    let stdout = '';

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'ui'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories: factoriesFor(plugin),
        prompt: scriptedPrompt([
          '2',
          selectPluginStep(() => stdout, 'sample.plugin'),
          '2',
          '1',
          'remote',
          '1',
        ]),
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Target: plugins.sample.plugin.config.endpoint');
    expect(stdout).toContain('Old: "local"');
    expect(stdout).toContain('New: "remote"');
    expect(
      JSON.parse(readFileSync(configPath, 'utf8')) as unknown,
    ).toMatchObject({
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {endpoint: 'remote'},
        },
      },
    });
  });

  it.each([
    {
      finalAnswer: '1',
      expectedEnabled: false,
      expectedText: 'Saved plugins.sample.plugin.enabled.',
    },
    {
      finalAnswer: '2',
      expectedEnabled: true,
      expectedText: 'Change cancelled.',
    },
  ])(
    'supports one exact plugin activation change with explicit Save or Cancel',
    async ({finalAnswer, expectedEnabled, expectedText}) => {
      const storeRoot = createTestTempRoot(
        'project02-config-console-plugin-toggle-',
      );
      const plugin = requiredDottedConfigPlugin('sample.plugin', 'endpoint');
      const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
        project02: {storeRoot},
        plugins: {
          [plugin.manifest.id]: {
            enabled: true,
            config: {endpoint: 'local'},
          },
        },
      });
      let stdout = '';

      const exitCode = await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'ui'],
        {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(() => {}),
          factories: factoriesFor(plugin),
          prompt: scriptedPrompt([
            '2',
            selectPluginStep(() => stdout, 'sample.plugin'),
            '1',
            '2',
            finalAnswer,
          ]),
        },
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain('Target: plugins.sample.plugin.enabled');
      expect(stdout).toContain('Old: true');
      expect(stdout).toContain('New: false');
      expect(stdout).toContain(expectedText);
      expect(
        JSON.parse(readFileSync(configPath, 'utf8')) as unknown,
      ).toMatchObject({
        plugins: {
          [plugin.manifest.id]: {
            enabled: expectedEnabled,
            config: {endpoint: 'local'},
          },
        },
      });
    },
  );

  it('never displays or accepts a resolved plugin secret and directs to secret set', async () => {
    const storeRoot = createTestTempRoot('project02-config-console-secret-');
    const plugin = requiredSecretPluginWithManifestEnvVar(
      'memory.secret',
      'MEMORY_SECRET_API_KEY',
    );
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      project02: {storeRoot},
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {
            apiKey: {$env: 'MEMORY_SECRET_API_KEY'},
          },
        },
      },
    });
    const before = readFileSync(configPath, 'utf8');
    let stdout = '';

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'ui'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        env: {
          MEMORY_SECRET_API_KEY: 'must-never-appear',
        },
        factories: factoriesFor(plugin),
        prompt: scriptedPrompt([
          '2',
          selectPluginStep(() => stdout, 'memory.secret'),
          '2',
        ]),
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      'Secret values are not displayed or entered in this console.',
    );
    expect(stdout).toContain(
      "pnpm runtime-config --store '" +
        storeRoot +
        "' -- secret set 'memory.secret' 'apiKey' 'MEMORY_SECRET_API_KEY'",
    );
    expect(stdout).not.toContain('must-never-appear');
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('suggests a deterministic environment name when secret metadata omits one', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-console-secret-name-',
    );
    const plugin = requiredSecretPlugin('memory.secret-auto');
    let stdout = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {
            apiKey: {$env: 'MEMORY_SECRET_AUTO_APIKEY'},
          },
        },
      },
    });

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'ui'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories: factoriesFor(plugin),
        prompt: scriptedPrompt([
          '2',
          selectPluginStep(() => stdout, 'memory.secret-auto'),
          '2',
        ]),
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      "secret set 'memory.secret-auto' 'apiKey' 'MEMORY_SECRET_AUTO_APIKEY'",
    );
  });

  it('resolves plugin secrets from the selected runtime env file without exposing them', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-console-runtime-env-',
    );
    const envVar = 'MEMORY_RUNTIME_FILE_API_KEY';
    const secretValue = 'must-stay-in-runtime-env';
    const plugin = requiredSecretPluginWithManifestEnvVar(
      'memory.runtime-file',
      envVar,
    );
    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      project02: {storeRoot},
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
    let stdout = '';

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'ui'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        env: {},
        factories: factoriesFor(plugin),
        prompt: scriptedPrompt([
          '2',
          selectPluginStep(() => stdout, 'memory.runtime-file'),
          '2',
        ]),
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('apiKey: "[redacted]"');
    expect(stdout).not.toContain('is missing from env');
    expect(stdout).not.toContain(secretValue);
  });

  it('fails closed when the authored fingerprint changes after preview', async () => {
    const storeRoot = createTestTempRoot('project02-config-console-conflict-');
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      project02: {
        storeRoot,
        roleModelProvider: 'local',
      },
    });
    let stdout = '';
    let stderr = '';

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'ui'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        prompt: scriptedPrompt([
          '1',
          '4',
          '1',
          'nvidia',
          {
            answer: '1',
            beforeAnswer() {
              writeRuntimeConfig(configPath, {
                project02: {
                  storeRoot,
                  defaultMemoryProvider: 'memory.external',
                  roleModelProvider: 'local',
                },
              });
            },
          },
        ]),
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toContain('Target: project02.roleModelProvider');
    expect(stderr).toContain(
      'Runtime config changed before the mutation could be committed.',
    );
    expect(
      JSON.parse(readFileSync(configPath, 'utf8')) as unknown,
    ).toMatchObject({
      project02: {
        defaultMemoryProvider: 'memory.external',
        roleModelProvider: 'local',
      },
    });
  });
});

function factoriesFor(
  plugin: RuntimePlugin,
): Readonly<Record<string, RuntimePluginFactoryDefinition>> {
  return Object.freeze({
    [plugin.manifest.id]: Object.freeze({
      manifest: plugin.manifest,
      create: () => plugin,
    } satisfies RuntimePluginFactoryDefinition),
  });
}

function scriptedPrompt(
  steps: readonly ScriptedPromptStep[],
): RuntimeConfigConsolePromptAdapter {
  let index = 0;

  return Object.freeze({
    question(): Promise<string | undefined> {
      const step = steps[index];
      index += 1;

      if (typeof step === 'string') {
        return Promise.resolve(step);
      }

      if (step === undefined) {
        return Promise.resolve(undefined);
      }

      step.beforeAnswer?.();
      return Promise.resolve(
        typeof step.answer === 'function' ? step.answer() : step.answer,
      );
    },
  });
}

/**
 * Selects a plugin by id instead of by hard-coded list position: reads
 * the rendered "N) Display Name (plugin-id)" line from the accumulated
 * console output at answer time, so adding a bundled package never
 * shifts these scripts.
 */
function selectPluginStep(
  readStdout: () => string,
  pluginId: string,
): ScriptedPromptStep {
  return {
    answer: () => {
      const listing = readStdout();
      const escapedId = pluginId.replaceAll(
        /[.*+?^${}()|[\]\\]/gu,
        String.raw`\$&`,
      );
      const match = new RegExp(`(\\d+)\\) [^\\n]*\\(${escapedId}\\)`, 'u').exec(
        listing,
      );

      if (match?.[1] === undefined) {
        throw new Error(
          `Plugin "${pluginId}" not found in the rendered console list:\n${listing}`,
        );
      }

      return match[1];
    },
  };
}
