import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {runRuntimeConfigCliFromArgs} from '../../src/cli/config/main.ts';
import {
  characterOverlayConfigPath,
  runtimeConfigEnvVarName,
} from '../../src/runtime/config/index.ts';
import {
  characterDataDirPath,
  ensureCharacterDataMarker,
  requireCharacterDataMarker,
} from '../../src/runtime/storage/index.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {collect} from '../support/streams.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

async function runConfigCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  let stdout = '';
  let stderr = '';
  const code = await runRuntimeConfigCliFromArgs(args, {
    stdout: collect(chunk => {
      stdout += chunk;
    }),
    stderr: collect(chunk => {
      stderr += chunk;
    }),
    env,
  });

  return {code, stdout, stderr};
}

describe('runtime-config --character verbs', () => {
  it('routes set/unset/get/path at the named character overlay', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');
    const overlayPath = characterOverlayConfigPath(dataRoot);

    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {userDisplayName: 'Global Name'},
    });

    const set = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      'set',
      'project02.userDisplayName',
      'Overlay Name',
    ]);

    expect(set.code).toBe(0);
    expect(JSON.parse(set.stdout)).toMatchObject({configPath: overlayPath});
    expect(JSON.parse(readFileSync(overlayPath, 'utf8'))).toEqual({
      version: 'project02.config.v2',
      project02: {userDisplayName: 'Overlay Name'},
      plugins: {
        'character-state': {enabled: true},
      },
    });
    // First scoped write initializes the data dir for its character.
    const marker = requireCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });
    expect(marker).toMatchObject({
      schemaVersion: 4,
      scope: 'character-data',
      characterId: 'mira',
      materializedCharacterPackageVersion: '1.1.0',
    });
    expect(Number.isNaN(Date.parse(marker.createdAt))).toBe(false);

    const scopedGet = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      'get',
      'project02.userDisplayName',
    ]);

    expect(JSON.parse(scopedGet.stdout)).toEqual({
      value: 'Overlay Name',
      origin: 'character',
    });

    const path = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      'path',
    ]);

    expect(path.stdout.trim()).toBe(overlayPath);

    const unset = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      'unset',
      'project02.userDisplayName',
    ]);

    expect(unset.code).toBe(0);

    const fallthroughGet = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      'get',
      'project02.userDisplayName',
    ]);

    expect(JSON.parse(fallthroughGet.stdout)).toEqual({
      value: 'Global Name',
      origin: 'global',
    });
  });

  it('rejects global-only fields, secrets, and env-path while check materializes under --character', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-reject-');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});

    const globalOnly = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      'set',
      'project02.character',
      'nova',
    ]);

    expect(globalOnly.code).toBe(1);
    expect(globalOnly.stderr).toContain('global-only');
    expect(
      existsSync(
        characterOverlayConfigPath(characterDataDirPath(homeRoot, 'mira')),
      ),
    ).toBe(false);

    const secret = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      'secret',
      'set',
      'demo-config',
      'apiKey',
      'MY_SECRET',
    ]);

    expect(secret.code).toBe(1);
    expect(secret.stderr).toContain('Secrets are shared across characters');

    const envPath = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      'env-path',
    ]);

    expect(envPath.code).toBe(1);
    expect(envPath.stderr).toContain('shared across characters');

    const check = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      'check',
    ]);

    expect(check.code).toBe(0);
    expect(check.stderr).toBe('');
    const checkOutput = JSON.parse(check.stdout) as {
      readonly plugins: readonly {
        readonly pluginId: string;
        readonly enabled: boolean;
        readonly activationStatus: string;
      }[];
    };
    expect(
      checkOutput.plugins.find(plugin => plugin.pluginId === 'character-state'),
    ).toMatchObject({
      enabled: true,
      activationStatus: 'active',
    });
    expect(
      JSON.parse(
        readFileSync(
          characterOverlayConfigPath(characterDataDirPath(homeRoot, 'mira')),
          'utf8',
        ),
      ),
    ).toEqual({
      version: 'project02.config.v2',
      plugins: {
        'character-state': {enabled: true},
      },
    });
  });

  it('refuses to write character data into a directory that is not a Project02 home', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-foreign-');

    // A directory holding unrelated content must fail the home guard
    // before any scoped write creates character-data inside it.
    writeFileSync(join(homeRoot, 'notes.txt'), 'not a project02 home\n');

    const rejected = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      'set',
      'project02.userDisplayName',
      'X',
    ]);

    expect(rejected.code).toBe(1);
    // The home guard's foreign-entry refusal surfaces through the CLI's
    // storage-error formatting; the durable outcome is what matters:
    // nothing was created inside the foreign directory.
    expect(rejected.stderr).toContain('Error:');
    expect(existsSync(characterDataDirPath(homeRoot, 'mira'))).toBe(false);
    expect(existsSync(join(homeRoot, 'schema.json'))).toBe(false);
  });

  it('rejects a global-only field before creating any character state', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-preflight-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});

    const rejected = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      'set',
      'project02.character',
      'nova',
    ]);

    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain(
      'Config field "project02.character" is global-only; set it in the ' +
        'home config.json, not the character overlay.',
    );
    // The dialect violation failed before ensure ran: no data marker, no
    // data directory, no home marker.
    expect(existsSync(dataRoot)).toBe(false);
    expect(existsSync(join(homeRoot, 'schema.json'))).toBe(false);
  });

  it('rejects an invalid scoped value before creating any character state', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-value-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});

    const rejected = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      'set',
      'project02.roleModelProvider',
      'nope',
    ]);

    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain(
      'Project02 roleModelProvider must be "local" or "nvidia".',
    );
    // The invalid value failed preflight, before ensure: no data marker, no
    // data directory, no home marker.
    expect(existsSync(dataRoot)).toBe(false);
    expect(existsSync(join(homeRoot, 'schema.json'))).toBe(false);
  });

  it('rejects a scoped get from a foreign home even with no data directory', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-get-foreign-');

    // A valid config next to foreign content: check and scoped set
    // refuse this home, so a scoped get must not report the global
    // fallback from it either.
    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {userDisplayName: 'Global Name'},
    });
    writeFileSync(join(homeRoot, 'notes.txt'), 'not a project02 home\n');

    const rejected = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      'get',
      'project02.userDisplayName',
    ]);

    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('Error:');
  });

  it('rejects a scoped edit when the data marker is a directory', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-marker-dir-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    // An allowlisted control NAME with the wrong type must fail the
    // preflight, before the home initializer writes the home marker.
    mkdirSync(join(dataRoot, 'schema.json'), {recursive: true});

    const rejected = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      'set',
      'project02.userDisplayName',
      'Bob',
    ]);

    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('Error:');
    expect(existsSync(join(homeRoot, 'schema.json'))).toBe(false);
  });

  it('rejects a scoped read from an unadoptable unmarked directory', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-read-adopt-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    // Unmarked with an overlay AND foreign content: writers refuse
    // this directory, so a read must not surface its overlay either.
    mkdirSync(dataRoot, {recursive: true});
    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {
      project02: {userDisplayName: 'Foreign Name'},
    });
    writeFileSync(join(dataRoot, 'notes.txt'), 'foreign\n');

    const rejected = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      'get',
      'project02.userDisplayName',
    ]);

    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('Error:');
  });

  it('rejects a scoped get when the explicit global config cannot load', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-get-invalid-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');
    const globalConfigPath = join(homeRoot, 'config.json');

    writeFileSync(globalConfigPath, '{not json\n');
    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });
    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {
      project02: {userDisplayName: 'Overlay Name'},
    });

    const rejected = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      '--config',
      globalConfigPath,
      'get',
      'project02.userDisplayName',
    ]);

    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('failed to load');
  });

  it('rejects a scoped read from a directory marked for another character', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-read-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    // A copied directory: mira's path claims nova, but carries an
    // overlay a naive read would surface as mira's config.
    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'nova',
    });
    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {
      project02: {userDisplayName: 'Foreign Name'},
    });

    const rejected = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      'get',
      'project02.userDisplayName',
    ]);

    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('holds history for character "nova"');
  });

  it('rejects a scoped edit when the data lock root is a symlink', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-lock-link-');
    const outside = createTestTempRoot('project02-scope-lock-target-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    mkdirSync(dataRoot, {recursive: true});
    writeFileSync(
      join(dataRoot, 'schema.json'),
      `${JSON.stringify({
        schemaVersion: 4,
        scope: 'character-data',
        characterId: 'mira',
        createdAt: '2026-07-23T00:00:00.000Z',
      })}\n`,
    );
    symlinkSync(outside, join(dataRoot, '.locks'));

    const rejected = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      'set',
      'project02.userDisplayName',
      'Bob',
    ]);

    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('Error:');
  });

  it('rejects a scoped edit over an existing invalid overlay before ensure', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-bad-overlay-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    mkdirSync(dataRoot, {recursive: true});
    writeFileSync(characterOverlayConfigPath(dataRoot), '{not json\n');

    const rejected = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      'set',
      'project02.userDisplayName',
      'Bob',
    ]);

    expect(rejected.code).toBe(1);
    // The invalid overlay failed the edit before ensure: no data marker, no
    // home marker.
    expect(existsSync(join(dataRoot, 'schema.json'))).toBe(false);
    expect(existsSync(join(homeRoot, 'schema.json'))).toBe(false);
  });

  it('refuses to initialize a marker-less directory holding foreign content', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-adopt-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    // A copied or corrupt tree: session artifacts without a data
    // marker. Marking it would adopt that history permanently.
    mkdirSync(dataRoot, {recursive: true});
    writeFileSync(join(dataRoot, 'sessions.jsonl'), '');

    const rejected = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      'set',
      'project02.userDisplayName',
      'X',
    ]);

    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('Error:');
    expect(existsSync(join(dataRoot, 'schema.json'))).toBe(false);
    expect(existsSync(characterOverlayConfigPath(dataRoot))).toBe(false);
    // The data dir was preflighted before the home initializer ran.
    expect(existsSync(join(homeRoot, 'schema.json'))).toBe(false);
  });

  it('rejects scoped writes while the home config cannot load', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-invalid-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    writeFileSync(join(homeRoot, 'config.json'), '{not json\n');

    const rejected = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      'set',
      'project02.userDisplayName',
      'Bob',
    ]);

    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('failed to load');
    // The broken global layer was detected before ensure: no data marker,
    // no data directory.
    expect(existsSync(dataRoot)).toBe(false);
  });

  it('refuses to write into a data directory marked for another character', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-marker-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    // Simulate a copied directory: mira's path already claims nova.
    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'nova',
    });

    const rejected = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      'set',
      'project02.userDisplayName',
      'X',
    ]);

    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('holds history for character "nova"');
    expect(existsSync(characterOverlayConfigPath(dataRoot))).toBe(false);
  });
});

describe('overlay files reached through --config directly', () => {
  it('rejects an overlay-shaped --config before any filesystem side effect', async () => {
    const homeRoot = createTestTempRoot('project02-scope-config-reject-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');
    const overlayPath = characterOverlayConfigPath(dataRoot);

    const rejected = await runConfigCli([
      '--store',
      homeRoot,
      '--config',
      overlayPath,
      'set',
      'project02.userDisplayName',
      'Bob',
    ]);

    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('is a character overlay');
    expect(rejected.stderr).toContain(`--store "${homeRoot}"`);
    expect(rejected.stderr).toContain('--character "mira"');
    expect(rejected.stderr).toContain(
      'instead of selecting a character overlay with --config',
    );
    expect(existsSync(join(homeRoot, 'character-data'))).toBe(false);
    expect(existsSync(join(homeRoot, '.locks'))).toBe(false);
    expect(existsSync(join(homeRoot, '.env'))).toBe(false);
    expect(existsSync(join(homeRoot, 'config.json'))).toBe(false);
    expect(existsSync(join(homeRoot, 'schema.json'))).toBe(false);
  });

  it('rejects an overlay selected by the config environment variable without side effects', async () => {
    const homeRoot = createTestTempRoot('project02-scope-config-env-reject-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');
    const overlayPath = characterOverlayConfigPath(dataRoot);

    const rejected = await runConfigCli(
      ['set', 'project02.userDisplayName', 'Bob'],
      {[runtimeConfigEnvVarName]: overlayPath},
    );

    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('is a character overlay');
    expect(rejected.stderr).toContain(runtimeConfigEnvVarName);
    expect(existsSync(join(homeRoot, 'character-data'))).toBe(false);
    expect(existsSync(join(homeRoot, '.locks'))).toBe(false);
    expect(existsSync(join(homeRoot, '.env'))).toBe(false);
    expect(existsSync(join(homeRoot, 'config.json'))).toBe(false);
    expect(existsSync(join(homeRoot, 'schema.json'))).toBe(false);
  });

  it('rejects an outside symlink whose canonical target is an overlay', async () => {
    const homeRoot = createTestTempRoot('project02-scope-config-link-reject-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');
    const overlayPath = characterOverlayConfigPath(dataRoot);
    const selectedPath = join(homeRoot, 'runtime.json');

    symlinkSync(overlayPath, selectedPath);

    const rejected = await runConfigCli([
      '--config',
      selectedPath,
      'set',
      'project02.userDisplayName',
      'Bob',
    ]);

    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('is a character overlay');
    expect(rejected.stderr).toContain(`--store "${realpathSync(homeRoot)}"`);
    expect(existsSync(join(homeRoot, 'character-data'))).toBe(false);
    expect(existsSync(join(homeRoot, '.locks'))).toBe(false);
    expect(existsSync(join(homeRoot, '.env'))).toBe(false);
    expect(existsSync(join(homeRoot, 'config.json'))).toBe(false);
    expect(existsSync(join(homeRoot, 'schema.json'))).toBe(false);
  });

  it('keeps an explicit global config compatible with character scope', async () => {
    const homeRoot = createTestTempRoot('project02-scope-global-config-');
    const globalConfigPath = join(homeRoot, 'config.json');

    writeRuntimeConfig(globalConfigPath, {
      project02: {userDisplayName: 'Global Name'},
    });

    const scopedGet = await runConfigCli([
      '--config',
      globalConfigPath,
      '--character',
      'mira',
      'get',
      'project02.userDisplayName',
    ]);

    expect(scopedGet.code).toBe(0);
    expect(JSON.parse(scopedGet.stdout)).toEqual({
      value: 'Global Name',
      origin: 'global',
    });
  });
});

describe('scoped console sessions', () => {
  it('materializes character config when the UI is opened and quit', async () => {
    const homeRoot = createTestTempRoot('project02-scope-ui-readonly-');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});

    const outcome = await runRuntimeConfigCliFromArgs(
      ['--store', homeRoot, '--character', 'mira', 'ui'],
      {
        stdout: collect(() => {}),
        stderr: collect(() => {}),
        env: {},
        prompt: {
          question: () => Promise.resolve('q'),
        },
      },
    );

    expect(outcome).toBe(0);
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    expect(
      JSON.parse(readFileSync(characterOverlayConfigPath(dataRoot), 'utf8')),
    ).toEqual({
      version: 'project02.config.v2',
      plugins: {
        'character-state': {enabled: true},
      },
    });
    expect(
      requireCharacterDataMarker({
        storageOptions: {storeRoot: dataRoot},
        characterId: 'mira',
      }),
    ).toMatchObject({
      materializedCharacterPackageVersion: '1.1.0',
    });
  });
});
