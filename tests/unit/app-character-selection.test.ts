import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {
  listProject02Characters,
  loadProject02Home,
  selectProject02CharacterId,
} from '../../src/app/index.ts';
import {writeTestCharacterPackage} from '../support/character-fixtures.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

const listing = (id: string, enabled: boolean) => ({
  id,
  displayName: id,
  enabled,
});

describe('project02 character selection rule', () => {
  it('an explicit id wins, trimmed, without consulting the enabled set', () => {
    expect(
      selectProject02CharacterId([listing('mira', false)], ' zeta '),
    ).toEqual({status: 'selected', characterId: 'zeta'});
  });

  it('selects the sole enabled character and refuses none or several', () => {
    expect(
      selectProject02CharacterId([
        listing('mira', true),
        listing('zeta', false),
      ]),
    ).toEqual({status: 'selected', characterId: 'mira'});

    const none = selectProject02CharacterId([listing('mira', false)]);

    expect(none.status).toBe('failed');
    expect(none.status === 'failed' && none.message).toContain(
      'No enabled character',
    );

    const several = selectProject02CharacterId([
      listing('mira', true),
      listing('zeta', true),
    ]);

    expect(several.status).toBe('failed');
    expect(several.status === 'failed' && several.message).toContain(
      'Several characters are enabled: mira, zeta.',
    );
  });
});

describe('project02 character listing', () => {
  it('lists installed characters as enabled unless config says otherwise', () => {
    const homeRoot = createTestTempRoot('project02-character-listing-');

    writeTestCharacterPackage(homeRoot, {id: 'zeta', displayName: 'Zeta'});
    writeRuntimeConfig(join(homeRoot, 'config.json'), {});

    const home = loadProject02Home({location: {storeRoot: homeRoot}, env: {}});

    expect(listProject02Characters(home)).toEqual([
      {id: 'mira', displayName: 'Mira', enabled: true},
      {id: 'zeta', displayName: 'Zeta', enabled: true},
    ]);

    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {enabled: false},
    });

    const disabledHome = loadProject02Home({
      location: {storeRoot: homeRoot},
      env: {},
    });

    expect(
      listProject02Characters(disabledHome).map(character => character.enabled),
    ).toEqual([false, false]);
  });

  it('fails closed on a config still carrying the retired character field', () => {
    const homeRoot = createTestTempRoot('project02-character-retired-');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {character: 'mira'},
    });

    const home = loadProject02Home({location: {storeRoot: homeRoot}, env: {}});

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
