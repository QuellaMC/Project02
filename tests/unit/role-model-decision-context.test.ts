import {testCharacterProfile} from '../support/character-fixtures.ts';
import {describe, expect, it} from 'vitest';

import {createDecisionContext} from '../../src/role-model/index.ts';

const base = {
  sessionId: 'session-notes',
  characterSnapshot: testCharacterProfile,
};

describe('decision context', () => {
  it('freezes structured runtime notes and keeps the plugin attribution', () => {
    const notes = [
      {id: 'today', text: 'Today is Saturday, August 15, 2026.'},
      {id: 'current', text: 'mood=steady', pluginId: 'character-state'},
    ];

    const context = createDecisionContext({...base, runtimeNotes: notes});

    notes[0] = {id: 'today', text: 'mutated'};

    expect(context.runtimeNotes).toEqual([
      {id: 'today', text: 'Today is Saturday, August 15, 2026.'},
      {id: 'current', text: 'mood=steady', pluginId: 'character-state'},
    ]);
    expect(Object.isFrozen(context.runtimeNotes[0])).toBe(true);
    expect(context.historyWindow).toEqual({turnEventIds: []});
  });

  it('rejects notes with empty text or malformed identifiers', () => {
    expect(() =>
      createDecisionContext({
        ...base,
        runtimeNotes: [{id: 'today', text: ' '}],
      }),
    ).toThrow('Decision runtime note text must be non-empty.');
    expect(() =>
      createDecisionContext({
        ...base,
        runtimeNotes: [{id: '9 lives', text: 'x'}],
      }),
    ).toThrow('runtime note id');
    expect(() =>
      createDecisionContext({
        ...base,
        runtimeNotes: [{id: 'note', text: 'x', pluginId: 'bad plugin'}],
      }),
    ).toThrow('runtime note pluginId');
  });

  it('copies the history window and rejects blank turn ids', () => {
    const turnEventIds = ['evt_1', 'evt_2'];
    const context = createDecisionContext({
      ...base,
      historyWindow: {turnEventIds},
    });

    turnEventIds.push('evt_3');

    expect(context.historyWindow).toEqual({turnEventIds: ['evt_1', 'evt_2']});
    expect(() =>
      createDecisionContext({...base, historyWindow: {turnEventIds: ['']}}),
    ).toThrow('History window turn ids must be non-empty strings.');
  });
});
