import {describe, expect, it} from 'vitest';

import {selectCharacterId} from '../../src/core/index.ts';

const listing = (id: string, enabled: boolean) => ({id, enabled});

describe('character selection rule', () => {
  it('an explicit id wins, trimmed, without consulting the enabled set', () => {
    expect(selectCharacterId([listing('mira', false)], ' zeta ')).toEqual({
      status: 'selected',
      characterId: 'zeta',
    });
  });

  it('selects the sole enabled character and refuses none or several', () => {
    expect(
      selectCharacterId([listing('mira', true), listing('zeta', false)]),
    ).toEqual({status: 'selected', characterId: 'mira'});

    const none = selectCharacterId([listing('mira', false)]);

    expect(none.status).toBe('failed');
    expect(none.status === 'failed' && none.message).toContain(
      'No enabled character',
    );

    const several = selectCharacterId([
      listing('mira', true),
      listing('zeta', true),
    ]);

    expect(several.status).toBe('failed');
    expect(several.status === 'failed' && several.message).toContain(
      'Several characters are enabled: mira, zeta.',
    );
  });
});
