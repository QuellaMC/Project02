import {describe, expect, it} from 'vitest';

import {
  createTodayRuntimeNote,
  todayRuntimeNoteId,
} from '../../src/role-model/prompt/prompt-text.ts';

describe('runtime prompt text', () => {
  it('writes the day note in the given zone', () => {
    const createdAt = '2026-08-15T03:00:00.000Z';

    expect(createTodayRuntimeNote(createdAt, 'America/Los_Angeles')).toEqual({
      id: todayRuntimeNoteId,
      text: 'Today is Friday, August 14, 2026.',
    });
    expect(createTodayRuntimeNote(createdAt, 'UTC').text).toBe(
      'Today is Saturday, August 15, 2026.',
    );
  });
});
