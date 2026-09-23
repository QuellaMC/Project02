import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {selectSoleEnabledCharacterId} from '../../src/app/character.ts';
import {
  listProject02Characters,
  loadProject02Home,
} from '../../src/app/index.ts';
import {writeTestCharacterPackage} from '../support/character-fixtures.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

describe('project02 sole-enabled startup selection', () => {
  it('routes an invalid global config to activation instead of ambiguity', () => {
    const homeRoot = createTestTempRoot('project02-selection-invalid-config-');

    writeTestCharacterPackage(homeRoot, {id: 'zeta', displayName: 'Zeta'});
    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {contextWindowTokens: -5},
    });

    const home = loadProject02Home({location: {storeRoot: homeRoot}});

    expect(selectSoleEnabledCharacterId(home)).toBe(
      listProject02Characters(home).characters[0]?.id,
    );
  });
});

describe('project02 character listing', () => {
  it('lists installed characters as enabled unless config says otherwise', () => {
    const homeRoot = createTestTempRoot('project02-character-listing-');

    writeTestCharacterPackage(homeRoot, {id: 'zeta', displayName: 'Zeta'});
    writeRuntimeConfig(join(homeRoot, 'config.json'), {});

    const home = loadProject02Home({location: {storeRoot: homeRoot}});

    expect(listProject02Characters(home)).toEqual({
      characters: [
        {id: 'mira', displayName: 'Mira', enabled: true},
        {id: 'zeta', displayName: 'Zeta', enabled: true},
      ],
      diagnostics: [],
    });

    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {enabled: false},
    });

    const disabledHome = loadProject02Home({
      location: {storeRoot: homeRoot},
    });

    expect(
      listProject02Characters(disabledHome).characters.map(
        character => character.enabled,
      ),
    ).toEqual([false, false]);
  });

  it('keeps listing when one character has a damaged data directory', () => {
    const homeRoot = createTestTempRoot('project02-character-damaged-');

    writeTestCharacterPackage(homeRoot, {id: 'zeta', displayName: 'Zeta'});
    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    mkdirSync(join(homeRoot, 'character-data', 'zeta'), {recursive: true});
    writeFileSync(
      join(homeRoot, 'character-data', 'zeta', 'schema.json'),
      'not json',
      'utf8',
    );

    const home = loadProject02Home({location: {storeRoot: homeRoot}});

    expect(
      listProject02Characters(home).characters.map(character => character.id),
    ).toEqual(['mira', 'zeta']);
  });

  it('fails closed on a config still carrying the retired character field', () => {
    const homeRoot = createTestTempRoot('project02-character-retired-');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {character: 'mira'},
    });

    const home = loadProject02Home({location: {storeRoot: homeRoot}});

    expect(home.loadedConfig.config).toBeUndefined();
    expect(home.loadedConfig.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'runtime_config_unknown_project02_field',
        message: 'Unknown Project02 config field "character".',
        path: 'project02.character',
      }),
    ]);
  });
});
