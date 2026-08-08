import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
  runtimeConfigVersion,
} from '../../src/runtime/config/index.ts';
import {
  characterDataDirPath,
  ensureCharacterDataMarker,
  ensureInitializedProject02Home,
  requireCharacterDataMarker,
} from '../../src/runtime/storage/index.ts';
import {requiredSecretPlugin} from '../support/runtime-config-fixtures.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {collect} from '../support/streams.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

const secretPlugin = requiredSecretPlugin('memory.scope-readiness');
const secretFactories = Object.freeze({
  [secretPlugin.manifest.id]: Object.freeze({
    manifest: secretPlugin.manifest,
    create: () => secretPlugin,
  }),
});

async function runConfigCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
  factories?: Parameters<typeof runRuntimeConfigCliFromArgs>[1]['factories'],
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
    ...(factories === undefined ? {} : {factories}),
  });

  return {code, stdout, stderr};
}

describe('runtime-config --character verbs', () => {
  // Storage staying clean is startup-seam behavior, covered in
  // tests/unit/runtime-config-overlay.test.ts.
  it('maps an invalid explicit character to a usage error', async () => {
    const homeRoot = createTestTempRoot('project02-config-invalid-character-');

    const result = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      '../bad',
      'path',
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--character must start with a letter');
  });

  it('routes set/unset/get/path at the named character overlay', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-');
    const dataRoot = characterDataDirPath(
      realpathSync.native(homeRoot),
      'mira',
    );
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
    expect(JSON.parse(set.stdout)).toMatchObject({
      configPath: characterOverlayConfigPath(
        characterDataDirPath(realpathSync.native(homeRoot), 'mira'),
      ),
    });
    expect(JSON.parse(readFileSync(overlayPath, 'utf8'))).toEqual({
      version: 'project02.config.v2',
      project02: {userDisplayName: 'Overlay Name'},
      plugins: {
        'character-state': {enabled: true},
      },
    });
    const marker = requireCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });
    expect(marker).toMatchObject({
      schemaVersion: 7,
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

  it.each(['constructor', 'toString', 'hasOwnProperty'])(
    'reports an inherited object key like "%s" as an uninstalled plugin',
    async pluginId => {
      const homeRoot = createTestTempRoot('project02-scope-verbs-inherited-');

      writeRuntimeConfig(join(homeRoot, 'config.json'), {});

      const rejected = await runConfigCli([
        '--store',
        homeRoot,
        '--character',
        'mira',
        'plugin',
        'enable',
        pluginId,
      ]);

      expect(rejected.code).toBe(1);
      expect(rejected.stderr).toContain(
        `Plugin "${pluginId}" is not installed`,
      );
    },
  );

  it('refuses to write character data into a directory that is not a Project02 home', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-foreign-');

    // Unrelated content must fail the home guard before a scoped write
    // creates character-data inside it.
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
    // The dialect violation failed before ensure ran.
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
    // The invalid value failed preflight, before ensure.
    expect(existsSync(dataRoot)).toBe(false);
    expect(existsSync(join(homeRoot, 'schema.json'))).toBe(false);
  });

  it('rejects an edit that leaves a second authored value invalid', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-partial-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    mkdirSync(dataRoot, {recursive: true});
    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {
      project02: {roleModelProvider: 'nope', userDisplayName: 'Old'},
    });

    // An edit repairs only the values it names, so the overlay it would
    // produce still carries the bad provider.
    const rejected = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      'set',
      'project02.userDisplayName',
      'Mike',
    ]);

    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain(
      'Project02 roleModelProvider must be "local" or "nvidia".',
    );
    expect(existsSync(join(homeRoot, 'schema.json'))).toBe(false);
    expect(existsSync(join(dataRoot, 'schema.json'))).toBe(false);
    expect(
      JSON.parse(readFileSync(characterOverlayConfigPath(dataRoot), 'utf8')),
    ).toMatchObject({
      project02: {roleModelProvider: 'nope', userDisplayName: 'Old'},
    });
  });

  it('commits an edit that repairs every invalid authored value', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-repair-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    mkdirSync(dataRoot, {recursive: true});
    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {
      project02: {roleModelProvider: 'nope', userDisplayName: 'Old'},
    });

    // Judging the assembled candidate must still admit the edit that makes
    // it valid, or the overlay is repairable only by hand.
    const repaired = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      'set',
      'project02.roleModelProvider',
      'local',
    ]);

    expect(repaired.code).toBe(0);
    expect(
      JSON.parse(readFileSync(characterOverlayConfigPath(dataRoot), 'utf8')),
    ).toMatchObject({
      project02: {roleModelProvider: 'local', userDisplayName: 'Old'},
    });
  });

  it('rejects a scoped edit when the shared env file cannot be read', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-env-dir-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    // An unreadable env file must be reported before the overlay commits.
    mkdirSync(join(homeRoot, '.env'));

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
    expect(existsSync(dataRoot)).toBe(false);
    expect(existsSync(join(homeRoot, 'schema.json'))).toBe(false);
  });

  it('rejects a scoped get from a foreign home even with no data directory', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-get-foreign-');

    // A valid config next to foreign content, which writers already refuse.
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
    // An allowlisted control name with the wrong type.
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
    // Unmarked with an overlay and foreign content, which writers refuse.
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

  it('keeps scoped reads available while a required secret is missing', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-readiness-');
    const dataRoot = characterDataDirPath(
      realpathSync.native(homeRoot),
      'mira',
    );

    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {userDisplayName: 'Global Name'},
      plugins: {[secretPlugin.manifest.id]: {enabled: true}},
    });

    // A missing secret says the environment is incomplete, not the document.
    const path = await runConfigCli(
      ['--store', homeRoot, '--character', 'mira', 'path'],
      {},
      secretFactories,
    );

    expect(path.code).toBe(0);
    expect(path.stdout.trim()).toBe(characterOverlayConfigPath(dataRoot));

    const get = await runConfigCli(
      [
        '--store',
        homeRoot,
        '--character',
        'mira',
        'get',
        'project02.userDisplayName',
      ],
      {},
      secretFactories,
    );

    expect(get.code).toBe(0);
    expect(JSON.parse(get.stdout)).toMatchObject({value: 'Global Name'});

    const set = await runConfigCli(
      [
        '--store',
        homeRoot,
        '--character',
        'mira',
        'set',
        'project02.userDisplayName',
        'Overlay Name',
      ],
      {},
      secretFactories,
    );

    expect(set.code).toBe(0);
  });

  it('still rejects a scoped read over an authoring error', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-authoring-');

    // A plaintext secret is an invalid authored document, not an incomplete
    // environment.
    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      plugins: {
        [secretPlugin.manifest.id]: {enabled: true, config: {apiKey: 'oops'}},
      },
    });

    const rejected = await runConfigCli(
      ['--store', homeRoot, '--character', 'mira', 'path'],
      {},
      secretFactories,
    );

    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('must use an env ref');
  });

  it('rejects a scoped read from a directory marked for another character', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-read-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    // A copied directory: mira's path claims nova but carries an overlay.
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
        schemaVersion: 7,
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
    // The invalid overlay failed the edit before ensure.
    expect(existsSync(join(dataRoot, 'schema.json'))).toBe(false);
    expect(existsSync(join(homeRoot, 'schema.json'))).toBe(false);
  });

  it('repairs an invalid authored overlay value, preserving the rest', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-repair-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });
    // Authored by hand and invalid: userDisplayName must be a string.
    writeFileSync(
      characterOverlayConfigPath(dataRoot),
      `${JSON.stringify({
        version: runtimeConfigVersion,
        project02: {userDisplayName: 42},
        plugins: {demo: {enabled: false, config: {tone: 'warm'}}},
      })}\n`,
    );

    const repaired = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      'set',
      'project02.userDisplayName',
      'Bob',
    ]);

    expect(repaired.stderr).toBe('');
    expect(repaired.code).toBe(0);
    const written = JSON.parse(
      readFileSync(characterOverlayConfigPath(dataRoot), 'utf8'),
    ) as Record<string, unknown>;

    expect(written['project02']).toEqual({userDisplayName: 'Bob'});
    expect(written['plugins']).toMatchObject({
      demo: {enabled: false, config: {tone: 'warm'}},
    });
  });

  it('does not write when an overlay repair leaves another invalid field', async () => {
    const homeRoot = createTestTempRoot(
      'project02-scope-verbs-repair-partial-',
    );
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });
    writeFileSync(
      characterOverlayConfigPath(dataRoot),
      `${JSON.stringify({
        version: runtimeConfigVersion,
        project02: {userDisplayName: 42, roleModelProvider: 'unsupported'},
      })}\n`,
    );
    const before = readFileSync(characterOverlayConfigPath(dataRoot), 'utf8');

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
    expect(readFileSync(characterOverlayConfigPath(dataRoot), 'utf8')).toBe(
      before,
    );
  });

  it('still refuses to read an invalid overlay it is not repairing', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-repair-read-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });
    writeFileSync(
      characterOverlayConfigPath(dataRoot),
      `${JSON.stringify({
        version: runtimeConfigVersion,
        project02: {userDisplayName: 42},
      })}\n`,
    );

    const rejected = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      'get',
      'project02.userDisplayName',
    ]);

    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('[character mira]');
  });

  it('refuses to initialize a marker-less directory holding foreign content', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-adopt-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    // A copied or corrupt tree: session artifacts without a data marker.
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
    // The broken global layer was detected before ensure.
    expect(existsSync(dataRoot)).toBe(false);
  });

  it('refuses to write into a data directory marked for another character', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-marker-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    // A copied directory: mira's path already claims nova.
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

    await ensureInitializedProject02Home({homeRoot});
    const homeEntriesBefore = readdirSync(homeRoot).sort();

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
    expect(rejected.stderr).toContain('is inside a character-data directory');
    expect(rejected.stderr).toContain('Use --store with --character');
    expect(existsSync(dataRoot)).toBe(false);
    expect(existsSync(join(homeRoot, '.env'))).toBe(false);
    expect(existsSync(join(homeRoot, 'config.json'))).toBe(false);
    expect(readdirSync(homeRoot).sort()).toEqual(homeEntriesBefore);
  });

  it('rejects an overlay selected by the config environment variable without side effects', async () => {
    const homeRoot = createTestTempRoot('project02-scope-config-env-reject-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');
    const overlayPath = characterOverlayConfigPath(dataRoot);

    await ensureInitializedProject02Home({homeRoot});
    const homeEntriesBefore = readdirSync(homeRoot).sort();

    const rejected = await runConfigCli(
      ['set', 'project02.userDisplayName', 'Bob'],
      {[runtimeConfigEnvVarName]: overlayPath},
    );

    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('is inside a character-data directory');
    expect(rejected.stderr).toContain('Use --store with --character');
    expect(existsSync(dataRoot)).toBe(false);
    expect(existsSync(join(homeRoot, '.env'))).toBe(false);
    expect(existsSync(join(homeRoot, 'config.json'))).toBe(false);
    expect(readdirSync(homeRoot).sort()).toEqual(homeEntriesBefore);
  });

  it('rejects an outside symlink whose canonical target is an overlay', async () => {
    const homeRoot = createTestTempRoot('project02-scope-config-link-reject-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');
    const overlayPath = characterOverlayConfigPath(dataRoot);
    const selectedPath = join(homeRoot, 'runtime.json');

    await ensureInitializedProject02Home({homeRoot});
    symlinkSync(overlayPath, selectedPath);
    const homeEntriesBefore = readdirSync(homeRoot).sort();

    const rejected = await runConfigCli([
      '--config',
      selectedPath,
      'set',
      'project02.userDisplayName',
      'Bob',
    ]);

    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('is inside a character-data directory');
    expect(rejected.stderr).toContain('Use --store with --character');
    expect(existsSync(dataRoot)).toBe(false);
    expect(existsSync(join(homeRoot, '.env'))).toBe(false);
    expect(existsSync(join(homeRoot, 'config.json'))).toBe(false);
    expect(readdirSync(homeRoot).sort()).toEqual(homeEntriesBefore);
  });

  it('keeps an explicit global config compatible with character scope', async () => {
    const homeRoot = createTestTempRoot('project02-scope-global-config-');
    const globalConfigPath = join(homeRoot, 'config.json');

    writeRuntimeConfig(globalConfigPath, {
      project02: {userDisplayName: 'Global Name'},
    });

    // Without --store the character scope resolves against the default home
    // under the cwd, since the config's filename implies nothing.
    const scopedGet = await runConfigCli([
      '--store',
      homeRoot,
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
