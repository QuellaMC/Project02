import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {runRuntimeConfigCliFromArgs} from '../../src/cli/config/main.ts';
import {characterOverlayConfigPath} from '../../src/runtime/config/index.ts';
import {
  characterDataDirPath,
  ensureCharacterDataStamp,
} from '../../src/runtime/storage/index.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {collect} from '../support/streams.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

async function runConfigCli(args: readonly string[]): Promise<{
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
    env: {},
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
    });
    // First scoped write stamps the data dir for its character.
    expect(
      JSON.parse(
        readFileSync(join(dataRoot, 'character-binding.json'), 'utf8'),
      ),
    ).toMatchObject({characterId: 'mira'});

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

  it('rejects global-only fields, secrets, env-path, and check under --character', async () => {
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

    expect(check.code).toBe(1);
    expect(check.stderr).toContain('--character does not apply to check');
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
    // The dialect violation failed before ensure ran: no stamp, no
    // data directory, no home marker.
    expect(existsSync(dataRoot)).toBe(false);
    expect(existsSync(join(homeRoot, 'schema.json'))).toBe(false);
  });

  it('refuses to bind a character to a marker-less directory holding foreign content', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-adopt-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    // A copied or corrupt tree: session artifacts without a data
    // marker. Stamping it would adopt that history permanently.
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
    expect(existsSync(join(dataRoot, 'character-binding.json'))).toBe(false);
    expect(existsSync(characterOverlayConfigPath(dataRoot))).toBe(false);
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
    // The broken global layer was detected before ensure: no stamp,
    // no data directory.
    expect(existsSync(dataRoot)).toBe(false);
  });

  it('refuses to write into a data directory stamped for another character', async () => {
    const homeRoot = createTestTempRoot('project02-scope-verbs-stamp-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    // Simulate a copied directory: mira's path already claims nova.
    await ensureCharacterDataStamp({
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
  it('never bootstraps a store root into an overlay-located config', async () => {
    const homeRoot = createTestTempRoot('project02-scope-config-flag-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');
    const overlayPath = characterOverlayConfigPath(dataRoot);

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    await ensureCharacterDataStamp({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });

    const set = await runConfigCli([
      '--store',
      homeRoot,
      '--config',
      overlayPath,
      'set',
      'project02.roleModelProvider',
      'local',
    ]);

    expect(set.code).toBe(0);
    expect(JSON.parse(readFileSync(overlayPath, 'utf8'))).toEqual({
      version: 'project02.config.v2',
      project02: {roleModelProvider: 'local'},
    });
  });

  it('refuses a direct overlay write into an unstamped data directory', async () => {
    const homeRoot = createTestTempRoot('project02-scope-config-flag-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');
    const overlayPath = characterOverlayConfigPath(dataRoot);

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});

    const rejected = await runConfigCli([
      '--store',
      homeRoot,
      '--config',
      overlayPath,
      'set',
      'project02.roleModelProvider',
      'local',
    ]);

    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('has no binding stamp');
    // The guard runs before the mutation lock: the data directory was
    // never created, not even its lock root.
    expect(existsSync(dataRoot)).toBe(false);
  });

  it('rejects global-only fields instead of writing them into the overlay', async () => {
    const homeRoot = createTestTempRoot('project02-scope-config-flag-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');
    const overlayPath = characterOverlayConfigPath(dataRoot);

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    await ensureCharacterDataStamp({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });

    const rejected = await runConfigCli([
      '--store',
      homeRoot,
      '--config',
      overlayPath,
      'set',
      'project02.character',
      'nova',
    ]);

    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain(
      'Config field "project02.character" is global-only; set it in the ' +
        'home config.json, not the character overlay.',
    );
    expect(existsSync(overlayPath)).toBe(false);
  });

  it('still writes the overlay when --config selects the overlay path under --character', async () => {
    const homeRoot = createTestTempRoot('project02-scope-config-flag-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');
    const overlayPath = characterOverlayConfigPath(dataRoot);

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    const globalBefore = readFileSync(join(homeRoot, 'config.json'), 'utf8');

    // The global layer aliases the overlay here; taking the global-layer
    // lock would deadlock against the scoped overlay lock.
    const set = await runConfigCli([
      '--store',
      homeRoot,
      '--character',
      'mira',
      '--config',
      overlayPath,
      'set',
      'project02.userDisplayName',
      'Overlay Name',
    ]);

    expect(set.code).toBe(0);
    expect(JSON.parse(readFileSync(overlayPath, 'utf8'))).toEqual({
      version: 'project02.config.v2',
      project02: {userDisplayName: 'Overlay Name'},
    });
    expect(readFileSync(join(homeRoot, 'config.json'), 'utf8')).toBe(
      globalBefore,
    );
  });
});

describe('scoped console sessions', () => {
  it('creates no durable character state when the UI is only opened and quit', async () => {
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
    expect(existsSync(characterDataDirPath(homeRoot, 'mira'))).toBe(false);
  });
});
