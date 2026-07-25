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
  defaultRuntimeConfigPath,
  loadProject02RuntimeConfig,
  loadProject02RuntimeConfigForLocation,
  loadProject02RuntimeConfigWithLocation,
  resolveProject02ConfigLocation,
  resolveRuntimeConfigScopeTarget,
  runtimeConfigEnvVarName,
  runtimeConfigVersion,
} from '../../src/runtime/config/index.ts';
import {
  characterDataDirPath,
  ensureInitializedProject02Home,
} from '../../src/runtime/storage/index.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

describe('selected config and activated runtime locations', () => {
  it('keeps an explicitly selected home authoritative when its config is absent', () => {
    const homeRoot = createTestTempRoot('project02-location-absent-');
    const physicalHomeRoot = realpathSync.native(homeRoot);
    const loadedConfig = loadProject02RuntimeConfig({storeRoot: homeRoot});

    expect(resolveProject02ConfigLocation({loadedConfig})).toEqual({
      selectedConfig: {
        source: 'default',
        path: defaultRuntimeConfigPath(homeRoot),
        canonicalPath: loadedConfig.selectedConfig.canonicalPath,
        owner: {kind: 'home', homeRoot: physicalHomeRoot},
      },
      homeRoot: physicalHomeRoot,
    });
  });

  it('retains absent custom-home selection provenance across exported APIs', () => {
    const homeRoot = createTestTempRoot('project02-location-exported-absent-');
    const loadedConfig = loadProject02RuntimeConfig({storeRoot: homeRoot});

    const configLocation = resolveProject02ConfigLocation({loadedConfig});
    const reloaded = loadProject02RuntimeConfigForLocation(configLocation);

    expect(configLocation.selectedConfig.source).toBe('default');
    expect(configLocation.selectedConfig.path).toBe(
      defaultRuntimeConfigPath(homeRoot),
    );
    expect(reloaded.source).toBe('none');
    expect(reloaded.diagnostics).toEqual([]);
  });

  it('keeps a selected physical config bound when its display alias moves', () => {
    const root = createTestTempRoot('project02-location-bound-alias-');
    const configA = join(root, 'a.json');
    const configB = join(root, 'b.json');
    const alias = join(root, 'runtime.json');

    writeFileSync(
      configA,
      `${JSON.stringify({
        version: runtimeConfigVersion,
        project02: {userDisplayName: 'A'},
      })}\n`,
      'utf8',
    );
    writeFileSync(
      configB,
      `${JSON.stringify({
        version: runtimeConfigVersion,
        project02: {userDisplayName: 'B'},
      })}\n`,
      'utf8',
    );
    symlinkSync(configA, alias);

    const snapshot = loadProject02RuntimeConfigWithLocation({
      selection: {configPath: alias},
      env: {},
    });

    unlinkSync(alias);
    symlinkSync(configB, alias);

    expect(() =>
      loadProject02RuntimeConfigForLocation(snapshot.configLocation),
    ).toThrow('now names another file');
  });

  it('rejects a missing path below a marked Project02 character root', async () => {
    const homeRoot = createTestTempRoot('project02-location-character-owned-');
    const nestedPath = join(
      homeRoot,
      'character-data',
      'mira',
      'sessions',
      'rogue',
      'config.json',
    );

    await ensureInitializedProject02Home({homeRoot});

    expect(() =>
      loadProject02RuntimeConfig({configPath: nestedPath, env: {}}),
    ).toThrow('inside a character-data directory');
  });

  it('does not infer character ownership from unrelated path segments', () => {
    const root = createTestTempRoot(
      'project02-location-unrelated-character-data-',
    );
    const nestedRoot = join(root, 'character-data', 'report');
    const configPath = join(nestedRoot, 'archive.json');

    mkdirSync(nestedRoot, {recursive: true});
    writeFileSync(
      configPath,
      `${JSON.stringify({version: runtimeConfigVersion})}\n`,
      'utf8',
    );

    const loadedConfig = loadProject02RuntimeConfig({configPath, env: {}});

    expect(loadedConfig.diagnostics).toEqual([]);
    expect(loadedConfig.selectedConfig.owner).toEqual({kind: 'standalone'});
  });

  it('binds an explicit character only after resolving the authored home', () => {
    const selectedHome = createTestTempRoot('project02-location-selected-');
    const authoredHome = createTestTempRoot('project02-location-authored-');
    const configPath = join(selectedHome, 'runtime.json');

    writeFileSync(
      configPath,
      `${JSON.stringify({
        version: runtimeConfigVersion,
        project02: {
          storeRoot: authoredHome,
          character: 'mira',
        },
      })}\n`,
      'utf8',
    );
    const loadedConfig = loadProject02RuntimeConfig({configPath, env: {}});
    const configLocation = resolveProject02ConfigLocation({loadedConfig});
    const physicalAuthoredHome = realpathSync.native(authoredHome);

    const location = bindProject02CharacterRuntimeLocation({
      configLocation,
      characterId: 'nova',
    });

    expect(configLocation.selectedConfig.source).toBe('path');
    expect(configLocation.selectedConfig.path).toBe(loadedConfig.path);
    expect(configLocation.homeRoot).toBe(physicalAuthoredHome);
    expect(location.characterScope).toEqual({
      characterId: 'nova',
      dataRoot: characterDataDirPath(physicalAuthoredHome, 'nova'),
    });
    expect(location.overlayPath).toBe(
      join(characterDataDirPath(physicalAuthoredHome, 'nova'), 'config.json'),
    );
  });

  it('keeps selected-file ownership separate from an explicit runtime home', () => {
    const selectedHome = createTestTempRoot(
      'project02-location-selected-owner-',
    );
    const runtimeHome = createTestTempRoot(
      'project02-location-explicit-runtime-home-',
    );
    const configPath = defaultRuntimeConfigPath(selectedHome);

    writeFileSync(
      configPath,
      `${JSON.stringify({version: runtimeConfigVersion})}\n`,
      'utf8',
    );
    const {configLocation} = loadProject02RuntimeConfigWithLocation({
      selection: {configPath, storeRoot: runtimeHome},
      env: {},
    });

    expect(configLocation.selectedConfig).toMatchObject({
      source: 'path',
      path: configPath,
      owner: {kind: 'standalone'},
      runtimeHomeRoot: realpathSync.native(runtimeHome),
    });
    expect(configLocation.homeRoot).toBe(realpathSync.native(runtimeHome));
  });

  it('binds a selected home to its physical directory before an alias can move', () => {
    const root = createTestTempRoot('project02-location-selected-home-alias-');
    const firstHome = join(root, 'home-a');
    const secondHome = join(root, 'home-b');
    const selectedHome = join(root, 'runtime-home');

    mkdirSync(firstHome);
    mkdirSync(secondHome);
    symlinkSync(firstHome, selectedHome);

    const snapshot = loadProject02RuntimeConfigWithLocation({
      selection: {storeRoot: selectedHome},
      env: {},
    });

    unlinkSync(selectedHome);
    symlinkSync(secondHome, selectedHome);

    expect(snapshot.configLocation.selectedConfig.owner).toEqual({
      kind: 'home',
      homeRoot: realpathSync.native(firstHome),
    });
    expect(snapshot.configLocation.homeRoot).toBe(
      realpathSync.native(firstHome),
    );
  });

  it('binds an authored runtime home to its physical directory before an alias can move', () => {
    const root = createTestTempRoot('project02-location-authored-home-alias-');
    const firstHome = join(root, 'home-a');
    const secondHome = join(root, 'home-b');
    const authoredHome = join(root, 'runtime-home');
    const configPath = join(root, 'runtime.json');

    mkdirSync(firstHome);
    mkdirSync(secondHome);
    symlinkSync(firstHome, authoredHome);
    writeFileSync(
      configPath,
      `${JSON.stringify({
        version: runtimeConfigVersion,
        project02: {storeRoot: authoredHome},
      })}\n`,
      'utf8',
    );

    const snapshot = loadProject02RuntimeConfigWithLocation({
      selection: {configPath},
      env: {},
    });

    unlinkSync(authoredHome);
    symlinkSync(secondHome, authoredHome);

    expect(snapshot.configLocation.homeRoot).toBe(
      realpathSync.native(firstHome),
    );
    expect(
      bindProject02CharacterRuntimeLocation({
        configLocation: snapshot.configLocation,
        characterId: 'mira',
      }).characterScope.dataRoot,
    ).toBe(join(realpathSync.native(firstHome), 'character-data', 'mira'));
  });

  it('freezes a relative explicit runtime home before cwd can change', () => {
    const firstCwd = createTestTempRoot('project02-location-cwd-first-');
    const secondCwd = createTestTempRoot('project02-location-cwd-second-');
    const configPath = join(firstCwd, 'runtime.json');
    const previousCwd = process.cwd();

    try {
      process.chdir(firstCwd);
      const snapshot = loadProject02RuntimeConfigWithLocation({
        selection: {configPath, storeRoot: 'runtime-home'},
        env: {},
      });

      process.chdir(secondCwd);

      expect(snapshot.configLocation.selectedConfig.runtimeHomeRoot).toBe(
        join(realpathSync.native(firstCwd), 'runtime-home'),
      );
      expect(snapshot.configLocation.homeRoot).toBe(
        join(realpathSync.native(firstCwd), 'runtime-home'),
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('binds a relative authored runtime home before cwd can change', () => {
    const firstCwd = createTestTempRoot(
      'project02-location-authored-cwd-first-',
    );
    const secondCwd = createTestTempRoot(
      'project02-location-authored-cwd-second-',
    );
    const authoredHome = join(firstCwd, 'runtime-home');
    const configPath = join(firstCwd, 'runtime.json');
    const previousCwd = process.cwd();

    mkdirSync(authoredHome);
    writeFileSync(
      configPath,
      `${JSON.stringify({
        version: runtimeConfigVersion,
        project02: {storeRoot: 'runtime-home'},
      })}\n`,
      'utf8',
    );

    try {
      process.chdir(firstCwd);
      const snapshot = loadProject02RuntimeConfigWithLocation({
        selection: {configPath},
        env: {},
      });

      process.chdir(secondCwd);

      expect(snapshot.configLocation.homeRoot).toBe(
        realpathSync.native(authoredHome),
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('binds a default-source config alias to its selected home', () => {
    const homeRoot = createTestTempRoot('project02-location-default-alias-');
    const targetPath = join(homeRoot, 'Config.json');
    const selectedPath = defaultRuntimeConfigPath(homeRoot);

    writeFileSync(
      targetPath,
      `${JSON.stringify({version: runtimeConfigVersion})}\n`,
      'utf8',
    );
    if (!existsSync(selectedPath)) {
      symlinkSync(targetPath, selectedPath);
    }

    const loadedConfig = loadProject02RuntimeConfig({
      storeRoot: homeRoot,
      env: {},
    });

    expect(loadedConfig.selectedConfig).toMatchObject({
      source: 'default',
      canonicalPath: realpathSync.native(targetPath),
      owner: {
        kind: 'home',
        homeRoot: realpathSync.native(homeRoot),
      },
    });
  });

  it('keeps an explicitly selected default-named config standalone', () => {
    const homeRoot = createTestTempRoot(
      'project02-location-explicit-default-name-',
    );
    const selectedPath = defaultRuntimeConfigPath(homeRoot);

    writeFileSync(
      selectedPath,
      `${JSON.stringify({version: runtimeConfigVersion})}\n`,
      'utf8',
    );

    const loadedConfig = loadProject02RuntimeConfig({
      configPath: selectedPath,
      env: {},
    });

    expect(loadedConfig.selectedConfig.source).toBe('path');
    expect(loadedConfig.selectedConfig.owner).toEqual({kind: 'standalone'});
  });

  it('keeps an env-selected missing default-named config standalone', () => {
    const homeRoot = createTestTempRoot('project02-location-env-default-name-');
    const selectedPath = defaultRuntimeConfigPath(homeRoot);

    const loadedConfig = loadProject02RuntimeConfig({
      env: {[runtimeConfigEnvVarName]: selectedPath},
    });

    expect(loadedConfig.selectedConfig.source).toBe('env');
    expect(loadedConfig.selectedConfig.owner).toEqual({kind: 'standalone'});
  });

  it('keeps standalone ownership when a sibling default alias appears later', () => {
    const root = createTestTempRoot('project02-location-standalone-stable-');
    const targetPath = join(root, 'Target.json');
    const selectedPath = join(root, 'runtime.json');

    writeFileSync(
      targetPath,
      `${JSON.stringify({
        version: runtimeConfigVersion,
        project02: {userDisplayName: 'Stable'},
      })}\n`,
      'utf8',
    );
    symlinkSync(targetPath, selectedPath);

    const snapshot = loadProject02RuntimeConfigWithLocation({
      selection: {configPath: selectedPath},
      env: {},
    });

    symlinkSync(targetPath, defaultRuntimeConfigPath(root));

    expect(
      loadProject02RuntimeConfigForLocation(snapshot.configLocation).config
        ?.project02?.userDisplayName,
    ).toBe('Stable');
    expect(snapshot.configLocation.selectedConfig.owner).toEqual({
      kind: 'standalone',
    });
  });

  it('retains environment selection as the config source', () => {
    const homeRoot = createTestTempRoot('project02-location-env-');
    const configPath = join(homeRoot, 'selected.json');

    const loadedConfig = loadProject02RuntimeConfig({
      env: {[runtimeConfigEnvVarName]: configPath},
    });
    const location = resolveProject02ConfigLocation({loadedConfig});

    expect(location.selectedConfig.source).toBe('env');
    expect(location.selectedConfig.path).toBe(configPath);
  });

  it('accepts only the exact selected snapshot returned by the loader', () => {
    const selectedHome = createTestTempRoot(
      'project02-location-selected-snapshot-',
    );
    const selected = loadProject02RuntimeConfig({
      storeRoot: selectedHome,
      env: {},
    });
    const location = resolveProject02ConfigLocation({loadedConfig: selected});

    expect(location.selectedConfig).toEqual({
      source: 'default',
      path: defaultRuntimeConfigPath(selectedHome),
      canonicalPath: selected.selectedConfig.canonicalPath,
      owner: {
        kind: 'home',
        homeRoot: realpathSync.native(selectedHome),
      },
    });
    expect(Object.isFrozen(location.selectedConfig)).toBe(true);

    expect(() =>
      resolveProject02ConfigLocation({
        loadedConfig: {
          ...selected,
          selectedConfig: {
            ...selected.selectedConfig,
            owner: {...selected.selectedConfig.owner},
          },
        },
      }),
    ).toThrow('selected snapshot returned by the runtime config loader');
  });

  it('does not let a legitimate location mint a foreign mutation target', () => {
    const firstHome = createTestTempRoot(
      'project02-location-target-authority-a-',
    );
    const secondHome = createTestTempRoot(
      'project02-location-target-authority-b-',
    );
    const loadedConfig = loadProject02RuntimeConfig({storeRoot: firstHome});
    const location = resolveProject02ConfigLocation({loadedConfig});

    expect(() =>
      resolveRuntimeConfigScopeTarget({
        runtimeLocation: {...location, homeRoot: secondHome},
        env: {},
        scope: 'global',
      }),
    ).toThrow(
      'Runtime config location must be created by resolveProject02ConfigLocation()',
    );
  });

  it('uses one normalized character identity for scope and storage', () => {
    const homeRoot = createTestTempRoot('project02-location-character-id-');
    const loadedConfig = loadProject02RuntimeConfig({storeRoot: homeRoot});
    const configLocation = resolveProject02ConfigLocation({loadedConfig});
    const runtimeLocation = bindProject02CharacterRuntimeLocation({
      configLocation,
      characterId: ' mira ',
    });

    expect(runtimeLocation.characterScope).toEqual({
      characterId: 'mira',
      dataRoot: characterDataDirPath(configLocation.homeRoot, 'mira'),
    });
  });

  it('keeps global location usable when an authored character is invalid', () => {
    const homeRoot = createTestTempRoot(
      'project02-location-invalid-character-',
    );

    writeFileSync(
      defaultRuntimeConfigPath(homeRoot),
      `${JSON.stringify({
        version: runtimeConfigVersion,
        project02: {character: '../bad'},
      })}\n`,
      'utf8',
    );

    const snapshot = loadProject02RuntimeConfigWithLocation({
      selection: {storeRoot: homeRoot},
      env: {},
    });

    expect(snapshot.loadedConfig.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        path: 'project02.character',
      }),
    );
    expect(snapshot.configLocation.selectedConfig.path).toBe(
      defaultRuntimeConfigPath(homeRoot),
    );
    expect(snapshot.configLocation).not.toHaveProperty('characterScope');
  });
});
