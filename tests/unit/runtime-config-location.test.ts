import {writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {
  defaultRuntimeConfigPath,
  loadProject02RuntimeConfigWithLocation,
  resolveProject02RuntimeLocation,
  runtimeConfigVersion,
} from '../../src/runtime/config/index.ts';
import {characterDataDirPath} from '../../src/runtime/storage/index.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

describe('resolved runtime location', () => {
  it('keeps an explicitly selected home authoritative when its config is absent', () => {
    const homeRoot = createTestTempRoot('project02-location-absent-');
    const loadedConfig = {
      source: 'none',
      path: defaultRuntimeConfigPath(homeRoot),
      diagnostics: [],
    } as const;

    expect(
      resolveProject02RuntimeLocation({
        loadedConfig,
        selection: {storeRoot: homeRoot},
      }),
    ).toEqual({
      selection: {storeRoot: homeRoot},
      configSource: 'default',
      globalConfigPath: defaultRuntimeConfigPath(homeRoot),
      homeRoot,
      characterScope: {
        characterId: 'mira',
        dataRoot: characterDataDirPath(homeRoot, 'mira'),
      },
      overlayPath: join(characterDataDirPath(homeRoot, 'mira'), 'config.json'),
    });
  });

  it('resolves authored home and explicit character through one value', () => {
    const selectedHome = createTestTempRoot('project02-location-selected-');
    const authoredHome = createTestTempRoot('project02-location-authored-');
    const loadedConfig = {
      source: 'path',
      path: join(selectedHome, 'runtime.json'),
      config: {
        version: runtimeConfigVersion,
        project02: {
          storeRoot: authoredHome,
          character: 'mira',
        },
      },
      diagnostics: [],
    } as const;

    const location = resolveProject02RuntimeLocation({
      loadedConfig,
      selection: {
        configPath: loadedConfig.path,
        storeRoot: selectedHome,
        character: 'nova',
      },
    });

    expect(location.configSource).toBe('path');
    expect(location.globalConfigPath).toBe(loadedConfig.path);
    expect(location.homeRoot).toBe(authoredHome);
    expect(location.characterScope).toEqual({
      characterId: 'nova',
      dataRoot: characterDataDirPath(authoredHome, 'nova'),
    });
    expect(location.overlayPath).toBe(
      join(characterDataDirPath(authoredHome, 'nova'), 'config.json'),
    );
  });

  it('retains environment selection as the config source', () => {
    const homeRoot = createTestTempRoot('project02-location-env-');
    const configPath = join(homeRoot, 'selected.json');

    const location = resolveProject02RuntimeLocation({
      loadedConfig: {
        source: 'env',
        path: configPath,
        diagnostics: [],
      },
      selection: {},
    });

    expect(location.configSource).toBe('env');
    expect(location.globalConfigPath).toBe(configPath);
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
    expect(snapshot.runtimeLocation.globalConfigPath).toBe(
      defaultRuntimeConfigPath(homeRoot),
    );
    expect(snapshot.runtimeLocation.characterScope.characterId).toBe('mira');
  });
});
