import {
  existsSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {
  bindProject02CharacterRuntimeLocation,
  loadProject02RuntimeConfigForLocation,
  loadProject02RuntimeConfigWithLocation,
  resolveRuntimeConfigScopeTarget,
  runtimeConfigVersion,
} from '../../src/runtime/config/index.ts';
import {
  characterDataDirPath,
  createProject02HomeLayout,
  ensureInitializedProject02Home,
} from '../../src/runtime/storage/index.ts';
import {loadRuntimeConfigForTest} from '../support/runtime-config.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

function writeConfigDocument(path: string, project02?: object): void {
  writeFileSync(
    path,
    `${JSON.stringify({
      version: runtimeConfigVersion,
      ...(project02 === undefined ? {} : {project02}),
    })}\n`,
    'utf8',
  );
}

describe('the home and its config file', () => {
  it('binds the selected home and its config file, with no config written yet', () => {
    const homeRoot = createTestTempRoot('project02-location-absent-');
    const physicalHomeRoot = realpathSync.native(homeRoot);
    const {loadedConfig, configLocation} =
      loadProject02RuntimeConfigWithLocation({
        selection: {storeRoot: homeRoot},
      });

    expect(configLocation).toEqual({
      homeRoot: physicalHomeRoot,
      configPath: createProject02HomeLayout({homeRoot}).configPath,
      canonicalConfigPath: join(physicalHomeRoot, 'config.json'),
    });
    expect(Object.isFrozen(configLocation)).toBe(true);
    expect(loadedConfig).toEqual({
      source: 'none',
      path: configLocation.configPath,
      diagnostics: [],
    });
    expect(
      loadProject02RuntimeConfigForLocation(configLocation).diagnostics,
    ).toEqual([]);
  });

  it('keeps a linked config file bound to the file it named when the home was bound', () => {
    const homeRoot = createTestTempRoot('project02-location-config-link-');
    const configPath = createProject02HomeLayout({homeRoot}).configPath;
    const firstTarget = join(homeRoot, 'first.json');
    const secondTarget = join(homeRoot, 'second.json');

    writeConfigDocument(firstTarget, {userDisplayName: 'First'});
    writeConfigDocument(secondTarget, {userDisplayName: 'Second'});
    symlinkSync(firstTarget, configPath);

    const {loadedConfig, configLocation} =
      loadProject02RuntimeConfigWithLocation({
        selection: {storeRoot: homeRoot},
      });

    expect(configLocation.canonicalConfigPath).toBe(
      realpathSync.native(firstTarget),
    );
    expect(loadedConfig.config?.project02?.userDisplayName).toBe('First');

    unlinkSync(configPath);
    symlinkSync(secondTarget, configPath);

    expect(() => loadProject02RuntimeConfigForLocation(configLocation)).toThrow(
      'now names another file',
    );
  });

  it('refuses a home inside a marked character-data directory', async () => {
    const homeRoot = createTestTempRoot('project02-location-character-owned-');
    const nestedHome = join(
      homeRoot,
      'character-data',
      'mira',
      'sessions',
      'rogue',
    );

    await ensureInitializedProject02Home({homeRoot});

    expect(() => loadRuntimeConfigForTest({storeRoot: nestedHome})).toThrow(
      'inside a character-data directory',
    );
    expect(existsSync(characterDataDirPath(homeRoot, 'mira'))).toBe(false);
  });

  it('does not infer character ownership from unrelated path segments', () => {
    const root = createTestTempRoot(
      'project02-location-unrelated-character-data-',
    );
    const homeRoot = join(root, 'character-data', 'report');

    mkdirSync(homeRoot, {recursive: true});
    writeConfigDocument(createProject02HomeLayout({homeRoot}).configPath);

    expect(loadRuntimeConfigForTest({storeRoot: homeRoot})).toMatchObject({
      source: 'path',
      diagnostics: [],
    });
  });

  it('binds a selected home to its physical directory before an alias can move', () => {
    const root = createTestTempRoot('project02-location-selected-home-alias-');
    const firstHome = join(root, 'home-a');
    const secondHome = join(root, 'home-b');
    const selectedHome = join(root, 'runtime-home');

    mkdirSync(firstHome);
    mkdirSync(secondHome);
    symlinkSync(firstHome, selectedHome);

    const {configLocation} = loadProject02RuntimeConfigWithLocation({
      selection: {storeRoot: selectedHome},
    });

    unlinkSync(selectedHome);
    symlinkSync(secondHome, selectedHome);

    expect(configLocation.homeRoot).toBe(realpathSync.native(firstHome));
    expect(
      bindProject02CharacterRuntimeLocation({
        configLocation,
        characterId: 'mira',
      }).characterScope.dataRoot,
    ).toBe(join(realpathSync.native(firstHome), 'character-data', 'mira'));
  });

  it('freezes a relative home before cwd can change', () => {
    const firstCwd = createTestTempRoot('project02-location-cwd-first-');
    const secondCwd = createTestTempRoot('project02-location-cwd-second-');
    const previousCwd = process.cwd();

    try {
      process.chdir(firstCwd);
      const {configLocation} = loadProject02RuntimeConfigWithLocation({
        selection: {storeRoot: 'runtime-home'},
      });

      process.chdir(secondCwd);

      expect(configLocation.homeRoot).toBe(
        join(realpathSync.native(firstCwd), 'runtime-home'),
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('does not let a legitimate location mint a foreign mutation target', () => {
    const firstHome = createTestTempRoot(
      'project02-location-target-authority-a-',
    );
    const secondHome = createTestTempRoot(
      'project02-location-target-authority-b-',
    );
    const {configLocation: location} = loadProject02RuntimeConfigWithLocation({
      selection: {storeRoot: firstHome},
    });

    expect(() =>
      resolveRuntimeConfigScopeTarget({
        runtimeLocation: {...location, homeRoot: secondHome},
        scope: 'global',
      }),
    ).toThrow(
      'Runtime config location must be created by resolveProject02ConfigLocation()',
    );
  });

  it('uses one normalized character identity for scope and storage', () => {
    const homeRoot = createTestTempRoot('project02-location-character-id-');
    const {configLocation} = loadProject02RuntimeConfigWithLocation({
      selection: {storeRoot: homeRoot},
    });
    const runtimeLocation = bindProject02CharacterRuntimeLocation({
      configLocation,
      characterId: ' mira ',
    });

    expect(runtimeLocation.characterScope).toEqual({
      characterId: 'mira',
      dataRoot: characterDataDirPath(configLocation.homeRoot, 'mira'),
    });
  });

  it('keeps the global location usable when an authored character is invalid', () => {
    const homeRoot = createTestTempRoot(
      'project02-location-invalid-character-',
    );

    writeConfigDocument(createProject02HomeLayout({homeRoot}).configPath, {
      character: '../bad',
    });

    const snapshot = loadProject02RuntimeConfigWithLocation({
      selection: {storeRoot: homeRoot},
    });

    expect(snapshot.loadedConfig.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        path: 'project02.character',
      }),
    );
    expect(snapshot.configLocation.configPath).toBe(
      createProject02HomeLayout({homeRoot}).configPath,
    );
    expect(snapshot.configLocation).not.toHaveProperty('characterScope');
  });
});
