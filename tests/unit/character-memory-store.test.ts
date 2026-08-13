import {describe, expect, it} from 'vitest';

import {
  characterMemoryAppliedRecordFor,
  characterMemoryAppliedRecordLimit,
  characterMemoryCapChars,
  characterMemoryUsedChars,
  decodeCharacterMemoryStoreDocument,
  emptyCharacterMemoryStore,
  encodeCharacterMemoryStoreDocument,
  planCharacterMemoryOperations,
  renderCharacterMemoryEntries,
  withCharacterMemoryAppliedRecord,
  type CharacterMemoryAppliedRecord,
  type CharacterMemoryStore,
} from '../../src/plugins/packages/character-memory/store.ts';

describe('character memory store', () => {
  it('applies an atomic batch of add, replace, and remove operations', () => {
    const result = planCharacterMemoryOperations({
      store: storeWith({
        notes: ['Prefers tea over coffee.', 'Runs Linux on the laptop.'],
        userProfile: ['Reads TypeScript fluently.'],
      }),
      operations: [
        {action: 'add', target: 'notes', text: 'Enjoys sci-fi novels.'},
        {
          action: 'replace',
          target: 'user_profile',
          text: 'Reads TypeScript and Rust fluently.',
          oldText: 'TypeScript fluently',
        },
        {action: 'remove', target: 'notes', oldText: 'Linux'},
      ],
    });

    expect(result).toMatchObject({status: 'accepted'});
    if (result.status !== 'accepted') {
      return;
    }

    expect(result.after.notes).toEqual([
      'Prefers tea over coffee.',
      'Enjoys sci-fi novels.',
    ]);
    expect(result.after.userProfile).toEqual([
      'Reads TypeScript and Rust fluently.',
    ]);
    expect(result.appliedChanges).toEqual([
      {action: 'add', target: 'notes', status: 'applied'},
      {action: 'replace', target: 'user_profile', status: 'applied'},
      {action: 'remove', target: 'notes', status: 'applied'},
    ]);
  });

  it('reports an exact-duplicate add as a no-op without growing the store', () => {
    const result = planCharacterMemoryOperations({
      store: storeWith({notes: ['Prefers tea over coffee.']}),
      operations: [
        {action: 'add', target: 'notes', text: 'Prefers tea over coffee.'},
      ],
    });

    expect(result).toMatchObject({status: 'accepted'});
    if (result.status !== 'accepted') {
      return;
    }

    expect(result.after.notes).toEqual(['Prefers tea over coffee.']);
    expect(result.appliedChanges).toEqual([
      {action: 'add', target: 'notes', status: 'duplicate'},
    ]);
  });

  it('collapses a replace onto an existing identical entry instead of duplicating it', () => {
    const result = planCharacterMemoryOperations({
      store: storeWith({notes: ['Prefers tea.', 'Drinks coffee at noon.']}),
      operations: [
        {
          action: 'replace',
          target: 'notes',
          text: 'Drinks coffee at noon.',
          oldText: 'Prefers tea.',
        },
      ],
    });

    expect(result).toMatchObject({status: 'accepted'});
    if (result.status !== 'accepted') {
      return;
    }

    // Two identical entries would make every old_text selecting one
    // select both, leaving the store unrepairable through the tool.
    expect(result.after.notes).toEqual(['Drinks coffee at noon.']);
    expect(result.appliedChanges).toEqual([
      {action: 'replace', target: 'notes', status: 'duplicate'},
    ]);
  });

  it('rejects the whole batch when a later operation fails', () => {
    const result = planCharacterMemoryOperations({
      store: storeWith({notes: ['Prefers tea over coffee.']}),
      operations: [
        {action: 'add', target: 'notes', text: 'A perfectly valid entry.'},
        {action: 'remove', target: 'notes', oldText: 'no such entry'},
      ],
    });

    expect(result).toEqual({
      status: 'rejected',
      reason: 'memory_old_text_not_found',
      details: 'No notes entry contains the given old_text.',
    });
  });

  it('rejects an ambiguous old_text with the match count and no entry texts', () => {
    const result = planCharacterMemoryOperations({
      store: storeWith({
        notes: ['Prefers tea over coffee.', 'Drinks green tea daily.'],
      }),
      operations: [{action: 'remove', target: 'notes', oldText: 'tea'}],
    });

    expect(result).toEqual({
      status: 'rejected',
      reason: 'memory_old_text_ambiguous',
      details:
        'old_text selects 2 notes entries; use a longer unique substring.',
    });
  });

  it('rejects a batch whose rendered target would exceed its capacity', () => {
    const nearCap = 'x'.repeat(characterMemoryCapChars.user_profile - 2);
    const result = planCharacterMemoryOperations({
      store: storeWith({userProfile: [nearCap]}),
      operations: [
        {action: 'add', target: 'user_profile', text: 'One more entry.'},
      ],
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'memory_capacity_exceeded',
    });
    if (result.status !== 'rejected') {
      return;
    }

    expect(result.details).toContain(
      `/${String(characterMemoryCapChars.user_profile)} chars`,
    );
  });

  it('normalizes carriage returns and rejects other control characters', () => {
    const normalized = planCharacterMemoryOperations({
      store: emptyCharacterMemoryStore(),
      operations: [
        {action: 'add', target: 'notes', text: 'line one\r\nline two'},
      ],
    });

    expect(normalized).toMatchObject({status: 'accepted'});
    if (normalized.status === 'accepted') {
      expect(normalized.after.notes).toEqual(['line one\nline two']);
    }

    expect(
      planCharacterMemoryOperations({
        store: emptyCharacterMemoryStore(),
        operations: [{action: 'add', target: 'notes', text: 'tab\tembedded'}],
      }),
    ).toMatchObject({status: 'rejected', reason: 'memory_entry_invalid'});
  });

  it('measures capacity on the rendered join, separators included', () => {
    expect(characterMemoryUsedChars(['aa', 'bb'])).toBe(
      renderCharacterMemoryEntries(['aa', 'bb']).length,
    );
    expect(renderCharacterMemoryEntries(['aa', 'bb'])).toBe('aa\n§\nbb');
  });

  it('matches a retry against the window, not only the newest identity', () => {
    const older = {
      eventId: 'evt_a',
      traceId: 'trace_a',
      createdAt: '2026-08-10T00:00:00.000Z',
      inputDigest: 'sha256:a',
      output: {status: 'accepted'},
    };
    const newer = {
      eventId: 'evt_b',
      traceId: 'trace_b',
      createdAt: '2026-08-10T00:00:01.000Z',
      inputDigest: 'sha256:b',
      output: {status: 'accepted'},
    };
    const document = {
      store: emptyCharacterMemoryStore(),
      appliedRecords: withCharacterMemoryAppliedRecord([older], newer),
    };

    // A second session committing in between must not make the first
    // session's retry look new and re-apply it.
    expect(
      characterMemoryAppliedRecordFor(document, {
        eventId: 'evt_a',
        traceId: 'trace_a',
        createdAt: '2026-08-10T00:00:00.000Z',
      }),
    ).toEqual(older);
    expect(
      characterMemoryAppliedRecordFor(document, {
        eventId: 'evt_a',
        traceId: 'trace_a',
        createdAt: '2026-08-10T00:00:00.000Z',
        toolCallId: 'call-1',
      }),
    ).toBeUndefined();
  });

  it('bounds the applied-record window so the document cannot grow forever', () => {
    const total = characterMemoryAppliedRecordLimit + 4;
    let window: readonly CharacterMemoryAppliedRecord[] = [];

    for (let index = 0; index < total; index += 1) {
      window = withCharacterMemoryAppliedRecord(window, {
        eventId: `evt_${String(index)}`,
        traceId: 'trace',
        createdAt: '2026-08-10T00:00:00.000Z',
        inputDigest: `sha256:${String(index)}`,
        output: {status: 'accepted'},
      });
    }

    expect(window).toHaveLength(characterMemoryAppliedRecordLimit);
    expect(window.at(-1)?.eventId).toBe(`evt_${String(total - 1)}`);
    expect(window.at(0)?.eventId).toBe(
      `evt_${String(total - characterMemoryAppliedRecordLimit)}`,
    );
  });

  it('round-trips a document with an idempotency record through the codec', () => {
    const document = {
      store: storeWith({
        notes: ['Prefers tea over coffee.'],
        userProfile: ['Reads TypeScript fluently.'],
      }),
      appliedRecords: [
        {
          eventId: 'evt_memory',
          traceId: 'trace_memory',
          toolCallId: 'call_memory',
          createdAt: '2026-08-10T00:00:00.000Z',
          inputDigest: 'sha256:abc',
          output: {status: 'accepted'},
        },
      ],
    };

    expect(
      decodeCharacterMemoryStoreDocument(
        encodeCharacterMemoryStoreDocument(document),
      ),
    ).toEqual(document);
  });

  it('decodes an absent document as the empty store and fails closed on malformed ones', () => {
    expect(decodeCharacterMemoryStoreDocument(undefined)).toEqual({
      store: emptyCharacterMemoryStore(),
      appliedRecords: [],
    });

    for (const malformed of [
      {
        kind: 'character_memory.store',
        formatVersion: 2,
        notes: [],
        userProfile: [],
      },
      {kind: 'something.else', formatVersion: 1, notes: [], userProfile: []},
      {
        kind: 'character_memory.store',
        formatVersion: 1,
        notes: 'no',
        userProfile: [],
      },
      {
        kind: 'character_memory.store',
        formatVersion: 1,
        notes: [''],
        userProfile: [],
      },
    ]) {
      expect(() => decodeCharacterMemoryStoreDocument(malformed)).toThrow(
        /malformed|unsupported version|must be/u,
      );
    }
  });
});

function storeWith(overrides: {
  readonly notes?: readonly string[];
  readonly userProfile?: readonly string[];
}): CharacterMemoryStore {
  return Object.freeze({
    notes: Object.freeze([...(overrides.notes ?? [])]),
    userProfile: Object.freeze([...(overrides.userProfile ?? [])]),
  });
}
