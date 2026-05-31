import { describe, expect, it } from 'vitest';

import {
  InMemoryRawEventLog,
  RawEventLogQueryValidationError,
  buildRawLogEntry,
  validateRawEventLogEntry
} from '../../../src/runtime/logging.ts';

function fixedClock(): Date {
  return new Date('2026-05-19T10:00:00.000Z');
}

class SequenceIdGenerator {
  readonly calls: string[] = [];

  next = (kind: string): string => {
    this.calls.push(kind);
    return `${kind}-generated-${String(this.calls.length)}`;
  };
}

function rawEntry(
  idGenerator: SequenceIdGenerator,
  {
    traceId = 'trace-1',
    eventId = 'event-1',
    kind = 'kind-1',
    data = { payload: { value: 'original' } }
  }: {
    traceId?: string;
    eventId?: string;
    kind?: string;
    data?: Record<string, unknown>;
  } = {}
) {
  return buildRawLogEntry({
    trace_id: traceId,
    event_id: eventId,
    kind,
    data,
    idGenerator: idGenerator.next,
    clock: fixedClock
  });
}

function payloadData(entry: { data: Record<string, unknown> }): { value: string } {
  const payload = entry.data['payload'];
  if (!isPayloadData(payload)) {
    throw new Error('Expected test payload with string value.');
  }
  return payload;
}

function isPayloadData(value: unknown): value is { value: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'value' in value &&
    typeof value.value === 'string'
  );
}

class CustomData {
  readonly value = 'custom';
}

describe('raw event log query and visibility', () => {
  it('builds raw log entries with deterministic IDs timestamps and cloned data', () => {
    const ids = new SequenceIdGenerator();
    const data = { payload: { value: 'original' } };
    const entry = buildRawLogEntry({
      trace_id: 'trace-1',
      event_id: 'event-1',
      kind: 'runtime_event_received',
      data,
      idGenerator: ids.next,
      clock: fixedClock
    });
    data.payload.value = 'mutated';

    expect(entry).toEqual({
      log_id: 'log-generated-1',
      trace_id: 'trace-1',
      event_id: 'event-1',
      kind: 'runtime_event_received',
      created_at: '2026-05-19T10:00:00+00:00',
      schema_version: '0.1',
      data: { payload: { value: 'original' } }
    });
  });

  it('normalizes generated Date clock timestamps to UTC plus-zero offset', () => {
    const ids = new SequenceIdGenerator();
    const entry = buildRawLogEntry({
      trace_id: 'trace-1',
      event_id: 'event-1',
      kind: 'runtime_event_received',
      data: {},
      idGenerator: ids.next,
      clock: () => new Date('2026-05-19T12:00:00+02:00')
    });

    expect(entry.created_at).toBe('2026-05-19T10:00:00+00:00');
  });

  it('preserves explicit string clock offsets and fractional precision', () => {
    const ids = new SequenceIdGenerator();
    const entry = buildRawLogEntry({
      trace_id: 'trace-1',
      event_id: 'event-1',
      kind: 'runtime_event_received',
      data: {},
      idGenerator: ids.next,
      clock: () => '2026-05-19T12:00:00.123456+02:00'
    });

    expect(entry.created_at).toBe('2026-05-19T12:00:00.123456+02:00');
  });

  it('queries append-path entries as deep copies', () => {
    const ids = new SequenceIdGenerator();
    const store = new InMemoryRawEventLog();
    const storedEntry = rawEntry(ids, { kind: 'runtime_event_received' });
    const otherTraceEntry = rawEntry(ids, {
      traceId: 'trace-2',
      kind: 'runtime_event_received'
    });

    store.append(storedEntry);
    store.append(otherTraceEntry);
    payloadData(storedEntry).value = 'mutated input';

    const result = store.query({ trace_id: 'trace-1' });
    expect(result.entries[0]).toBeDefined();
    payloadData(result.entries[0] ?? { data: {} }).value = 'mutated result';
    const secondResult = store.query({ trace_id: 'trace-1' });

    expect(result.schema_version).toBe('0.1');
    expect(result.trace_id).toBe('trace-1');
    expect(result.entries).toHaveLength(1);
    expect(secondResult.entries[0]?.data['payload']).toEqual({ value: 'original' });
  });

  it('filters by event id and kinds across appended and finalizer entries', () => {
    const ids = new SequenceIdGenerator();
    const store = new InMemoryRawEventLog();
    store.append(rawEntry(ids, { kind: 'runtime_event_received' }));
    const successEntry = rawEntry(ids, { kind: 'living_state_patch_committed' });
    store.exposeCommittedSuccessEntry(successEntry);
    store.confirmCommittedSuccessEntry(successEntry);
    store.append(rawEntry(ids, { eventId: 'event-2', kind: 'visible_reply_committed' }));

    const eventResult = store.query({
      trace_id: 'trace-1',
      event_id: 'event-1',
      kinds: ['runtime_event_received', 'living_state_patch_committed']
    });
    const successResult = store.query({
      trace_id: 'trace-1',
      kinds: ['living_state_patch_committed']
    });

    expect(eventResult.entries.map((entry) => entry.kind)).toEqual([
      'runtime_event_received',
      'living_state_patch_committed'
    ]);
    expect(successResult.entries.map((entry) => entry.kind)).toEqual([
      'living_state_patch_committed'
    ]);
  });

  it('keeps finalizer success entries duplicate-free and hidden until confirmed', () => {
    const ids = new SequenceIdGenerator();
    const store = new InMemoryRawEventLog();
    const successEntry = rawEntry(ids, { kind: 'life_incident_interrupted' });

    store.exposeCommittedSuccessEntry(successEntry);
    expect(store.query({ trace_id: 'trace-1' }).entries).toEqual([]);
    store.confirmCommittedSuccessEntry(successEntry);
    store.exposeCommittedSuccessEntry(successEntry);
    store.confirmCommittedSuccessEntry(successEntry);
    store.append(successEntry);

    expect(
      store.query({ trace_id: 'trace-1', kinds: ['life_incident_interrupted'] }).entries
    ).toHaveLength(1);
  });

  it('rejects direct append and non-atomic expose for atomic success entries', () => {
    const ids = new SequenceIdGenerator();
    const store = new InMemoryRawEventLog();

    expect(() => {
      store.append(rawEntry(ids, { kind: 'living_state_patch_committed' }));
    }).toThrow(/must be exposed and confirmed before append/);
    expect(store.query({ trace_id: 'trace-1' }).entries).toEqual([]);

    expect(() => {
      store.exposeCommittedSuccessEntry(rawEntry(ids, { kind: 'visible_reply_committed' }));
    }).toThrow(/atomic finalizer success kind/);
  });

  it('does not corrupt pending entries on confirm or non-atomic discard failures', () => {
    const ids = new SequenceIdGenerator();
    const store = new InMemoryRawEventLog();
    const successEntry = rawEntry(ids, { kind: 'living_state_patch_committed' });
    const conflictingEntry = structuredClone(successEntry);
    payloadData(conflictingEntry).value = 'conflicting';

    store.exposeCommittedSuccessEntry(successEntry);
    expect(() => {
      store.confirmCommittedSuccessEntry(conflictingEntry);
    }).toThrow(
      /does not match pending success data/
    );
    expect(() => {
      store.discardCommittedSuccessEntry({
        ...successEntry,
        kind: 'visible_reply_committed'
      });
    }).toThrow(/atomic finalizer success kind/);
    store.confirmCommittedSuccessEntry(successEntry);

    expect(store.query({ trace_id: 'trace-1' }).entries.map((entry) => entry.kind)).toEqual([
      'living_state_patch_committed'
    ]);
  });

  it('can discard an unconfirmed success entry without exposing it', () => {
    const ids = new SequenceIdGenerator();
    const store = new InMemoryRawEventLog();
    const successEntry = rawEntry(ids, { kind: 'living_state_patch_committed' });

    store.exposeCommittedSuccessEntry(successEntry);
    expect(store.query({ trace_id: 'trace-1' }).entries).toEqual([]);
    store.discardCommittedSuccessEntry(successEntry);

    expect(store.query({ trace_id: 'trace-1' }).entries).toEqual([]);
    expect(() => {
      store.confirmCommittedSuccessEntry(successEntry);
    }).toThrow(/not staged by finalizer visibility/);
  });

  it('matches Python discard behavior by removing staged success entries by log id', () => {
    const ids = new SequenceIdGenerator();
    const store = new InMemoryRawEventLog();
    const successEntry = rawEntry(ids, { kind: 'living_state_patch_committed' });
    const conflictingEntry = structuredClone(successEntry);
    payloadData(conflictingEntry).value = 'conflicting';

    store.exposeCommittedSuccessEntry(successEntry);
    store.discardCommittedSuccessEntry(conflictingEntry);

    expect(store.query({ trace_id: 'trace-1' }).entries).toEqual([]);
    expect(() => {
      store.confirmCommittedSuccessEntry(successEntry);
    }).toThrow(/not staged by finalizer visibility/);
  });

  it('rejects confirm for non-atomic and unstaged success entries without mutation', () => {
    const ids = new SequenceIdGenerator();
    const store = new InMemoryRawEventLog();
    const nonAtomicEntry = rawEntry(ids, { kind: 'visible_reply_committed' });
    const unstagedSuccessEntry = rawEntry(ids, { kind: 'living_state_patch_committed' });

    store.append(nonAtomicEntry);
    expect(() => {
      store.confirmCommittedSuccessEntry(nonAtomicEntry);
    }).toThrow(/atomic finalizer success kind/);
    expect(() => {
      store.confirmCommittedSuccessEntry(unstagedSuccessEntry);
    }).toThrow(/not staged by finalizer visibility/);

    expect(store.query({ trace_id: 'trace-1' }).entries.map((entry) => entry.kind)).toEqual([
      'visible_reply_committed'
    ]);
  });

  it('rejects malformed queries and conflicting duplicate log ids without mutation', () => {
    const ids = new SequenceIdGenerator();
    const store = new InMemoryRawEventLog();
    const entry = rawEntry(ids, { kind: 'runtime_event_received' });
    const conflictingEntry = structuredClone(entry);
    conflictingEntry.kind = 'role_model_turn_completed';

    store.append(entry);

    for (const query of [
      {},
      { trace_id: 'trace-1', kind: 'runtime_event_received' },
      { trace_id: 'trace-1', kinds: 'runtime_event_received' },
      { trace_id: 'trace-1', kinds: [] },
      { trace_id: 'trace-1', kinds: [123] },
      { trace_id: ' ' },
      { trace_id: 'trace-1', event_id: '' }
    ]) {
      expect(() => {
        store.query(query);
      }).toThrow(RawEventLogQueryValidationError);
      expect(store.query({ trace_id: 'trace-1' }).entries).toHaveLength(1);
    }

    expect(() => {
      store.append(conflictingEntry);
    }).toThrow(/already exists/);
    expect(store.query({ trace_id: 'trace-1' }).entries[0]?.kind).toBe(
      'runtime_event_received'
    );
  });

  it('rejects expose duplicate conflicts without mutating stored entries', () => {
    const ids = new SequenceIdGenerator();
    const store = new InMemoryRawEventLog();
    const entry = rawEntry(ids, { kind: 'runtime_event_received' });
    const conflictingEntry = structuredClone(entry);
    conflictingEntry.kind = 'role_model_turn_completed';

    store.append(entry);

    expect(() => {
      store.exposeCommittedSuccessEntry(conflictingEntry);
    }).toThrow(RawEventLogQueryValidationError);
    expect(store.query({ trace_id: 'trace-1' }).entries).toHaveLength(1);
    expect(store.query({ trace_id: 'trace-1' }).entries[0]?.kind).toBe(
      'runtime_event_received'
    );
  });

  it('rejects non-plain raw entry data objects', () => {
    const ids = new SequenceIdGenerator();
    const store = new InMemoryRawEventLog();

    for (const data of [
      new Date('2026-05-19T10:00:00.000Z'),
      new Map(),
      new Set(),
      new CustomData()
    ]) {
      expect(() => {
        validateRawEventLogEntry({
          ...rawEntry(ids, { kind: 'runtime_event_received' }),
          data
        });
      }).toThrow(/data must be a mapping/);
    }

    expect(store.query({ trace_id: 'trace-1' }).entries).toEqual([]);
  });

  it('keeps Python-style raw data snapshots for nested non-cloneable values', () => {
    const ids = new SequenceIdGenerator();
    const store = new InMemoryRawEventLog();
    const callback = () => 'not cloneable';

    const entry = buildRawLogEntry({
      trace_id: 'trace-1',
      event_id: 'event-1',
      kind: 'runtime_event_received',
      data: { callback, payload: { value: 'original' } },
      idGenerator: ids.next,
      clock: fixedClock
    });

    expect(entry.data['callback']).toBe(callback);
    expect(entry.data['payload']).toEqual({ value: 'original' });

    store.append(entry);
    payloadData(entry).value = 'mutated input';

    const result = store.query({ trace_id: 'trace-1' });
    expect(result.entries[0]?.data['callback']).toBe(callback);
    expect(result.entries[0]?.data['payload']).toEqual({ value: 'original' });
  });
});
