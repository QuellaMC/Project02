import { describe, expect, it } from 'vitest';

import {
  RuntimeValidationError,
  buildRawEventLogEntry,
  intakeRuntimeEvent,
  normalizeRuntimeEvent,
  routeRuntimeEvent
} from '../../../src/runtime/kernel.ts';
import type { RawEventLogEntry } from '../../../src/runtime/logging.ts';

function fixedClock(): Date {
  return new Date('2026-05-14T11:30:00.000Z');
}

class SequenceIdGenerator {
  readonly calls: string[] = [];

  next = (kind: string): string => {
    this.calls.push(kind);
    return `${kind}-generated-${String(this.calls.length)}`;
  };
}

class RecordingRawEventLog {
  readonly entries: RawEventLogEntry[] = [];

  append(entry: RawEventLogEntry): void {
    this.entries.push(entry);
  }
}

function objectWithPrototypeFields(
  prototypeFields: Record<string, unknown>
): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  Object.setPrototypeOf(target, prototypeFields);
  return target;
}

describe('runtime kernel normalization and routing', () => {
  it('normalizes user messages with missing ids', () => {
    const ids = new SequenceIdGenerator();

    const event = normalizeRuntimeEvent(
      {
        type: 'USER_MESSAGE',
        payload: { text: '  hello  ', user_id: 'u-1' }
      },
      { idGenerator: ids.next, clock: fixedClock }
    );

    expect(event).toEqual({
      event_id: 'event-generated-1',
      trace_id: 'trace-generated-2',
      type: 'USER_MESSAGE',
      created_at: '2026-05-14T11:30:00+00:00',
      schema_version: '0.1',
      payload: { text: '  hello  ', user_id: 'u-1' }
    });
    expect(ids.calls).toEqual(['event', 'trace']);
  });

  it('normalizes incident completion with missing ids', () => {
    const ids = new SequenceIdGenerator();

    const event = normalizeRuntimeEvent(
      {
        type: 'INCIDENT_COMPLETION',
        payload: {
          incident_id: ' incident-1 ',
          user_id: 'u-1',
          conversation_id: 'c-1'
        }
      },
      { idGenerator: ids.next, clock: fixedClock }
    );

    expect(event).toEqual({
      event_id: 'event-generated-1',
      trace_id: 'trace-generated-2',
      type: 'INCIDENT_COMPLETION',
      created_at: '2026-05-14T11:30:00+00:00',
      schema_version: '0.1',
      payload: {
        incident_id: 'incident-1',
        user_id: 'u-1',
        conversation_id: 'c-1'
      }
    });
    expect(ids.calls).toEqual(['event', 'trace']);
  });

  it('generates blank ids in event then trace order', () => {
    const ids = new SequenceIdGenerator();

    const event = normalizeRuntimeEvent(
      {
        event_id: '   ',
        trace_id: '',
        type: 'USER_MESSAGE',
        payload: { text: 'hello' }
      },
      { idGenerator: ids.next, clock: fixedClock }
    );

    expect(event.event_id).toBe('event-generated-1');
    expect(event.trace_id).toBe('trace-generated-2');
    expect(ids.calls).toEqual(['event', 'trace']);
  });

  it('preserves existing ids schema and created_at', () => {
    const ids = new SequenceIdGenerator();

    const event = normalizeRuntimeEvent(
      {
        event_id: 'event-existing',
        trace_id: 'trace-existing',
        type: 'USER_MESSAGE',
        created_at: '2026-05-14T10:20:30Z',
        schema_version: '0.1',
        payload: { text: 'hello' }
      },
      { idGenerator: ids.next, clock: fixedClock }
    );

    expect(event.event_id).toBe('event-existing');
    expect(event.trace_id).toBe('trace-existing');
    expect(event.created_at).toBe('2026-05-14T10:20:30Z');
    expect(ids.calls).toEqual([]);
  });

  it('assigns schema version when missing and rejects unsupported schema versions', () => {
    const event = normalizeRuntimeEvent(
      { type: 'USER_MESSAGE', payload: { text: 'hello' } },
      { idGenerator: new SequenceIdGenerator().next, clock: fixedClock }
    );

    expect(event.schema_version).toBe('0.1');
    expect(() =>
      normalizeRuntimeEvent(
        { type: 'USER_MESSAGE', schema_version: '0.2', payload: { text: 'hello' } },
        { idGenerator: new SequenceIdGenerator().next, clock: fixedClock }
      )
    ).toThrow(RuntimeValidationError);
  });

  it('preserves valid provided created_at and rejects malformed created_at', () => {
    const event = normalizeRuntimeEvent(
      {
        type: 'USER_MESSAGE',
        created_at: '2026-05-14T10:20:30+00:00',
        payload: { text: 'hello' }
      },
      { idGenerator: new SequenceIdGenerator().next, clock: fixedClock }
    );

    expect(event.created_at).toBe('2026-05-14T10:20:30+00:00');

    for (const createdAt of [null, 'not a timestamp', '2026-05-14']) {
      expect(() =>
        normalizeRuntimeEvent(
          {
            type: 'USER_MESSAGE',
            created_at: createdAt,
            payload: { text: 'hello' }
          },
          { idGenerator: new SequenceIdGenerator().next, clock: fixedClock }
        )
      ).toThrow(/created_at/);
    }
  });

  it('rejects unsupported event types empty text and malformed incident payloads', () => {
    expect(() =>
      normalizeRuntimeEvent(
        { type: 'TIMER', payload: { text: 'hello' } },
        { idGenerator: new SequenceIdGenerator().next, clock: fixedClock }
      )
    ).toThrow(/Unsupported event type/);

    for (const text of ['', '   ']) {
      expect(() =>
        normalizeRuntimeEvent(
          { type: 'USER_MESSAGE', payload: { text } },
          { idGenerator: new SequenceIdGenerator().next, clock: fixedClock }
        )
      ).toThrow(/payload.text/);
    }

    for (const [payload, errorPattern] of [
      [null, /payload/],
      [{}, /incident_id/],
      [{ incident_id: '' }, /incident_id/],
      [{ incident_id: '   ' }, /incident_id/],
      [{ incident_id: 'incident-1', user_id: 123 }, /user_id/],
      [{ incident_id: 'incident-1', conversation_id: {} }, /conversation_id/],
      [{ incident_id: 'incident-1', future: 'nope' }, /future/]
    ] as const) {
      expect(() =>
        normalizeRuntimeEvent(
          { type: 'INCIDENT_COMPLETION', payload },
          { idGenerator: new SequenceIdGenerator().next, clock: fixedClock }
        )
      ).toThrow(errorPattern);
    }
  });

  it('rejects inherited event and payload fields at unknown boundaries', () => {
    const inheritedEvent = objectWithPrototypeFields({
      type: 'USER_MESSAGE',
      payload: { text: 'hello' }
    });
    const inheritedUserPayload = objectWithPrototypeFields({ text: 'hello' });
    const inheritedIncidentPayload = objectWithPrototypeFields({
      incident_id: 'incident-1'
    });

    expect(() =>
      normalizeRuntimeEvent(inheritedEvent, {
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock
      })
    ).toThrow(/Runtime event input/);
    expect(() =>
      normalizeRuntimeEvent(
        { type: 'USER_MESSAGE', payload: inheritedUserPayload },
        { idGenerator: new SequenceIdGenerator().next, clock: fixedClock }
      )
    ).toThrow(/payload/);
    expect(() =>
      normalizeRuntimeEvent(
        { type: 'INCIDENT_COMPLETION', payload: inheritedIncidentPayload },
        { idGenerator: new SequenceIdGenerator().next, clock: fixedClock }
      )
    ).toThrow(/payload/);
  });

  it('returns deterministic routes for supported events', () => {
    expect(
      routeRuntimeEvent({
        event_id: 'event-1',
        trace_id: 'trace-1',
        type: 'USER_MESSAGE',
        created_at: '2026-05-14T11:30:00+00:00',
        schema_version: '0.1',
        payload: { text: 'hello' }
      })
    ).toEqual({
      trace_id: 'trace-1',
      event_id: 'event-1',
      event_type: 'USER_MESSAGE',
      model_needed: true,
      next_step: 'user_turn'
    });

    expect(
      routeRuntimeEvent({
        event_id: 'event-1',
        trace_id: 'trace-1',
        type: 'INCIDENT_COMPLETION',
        created_at: '2026-05-14T11:30:00+00:00',
        schema_version: '0.1',
        payload: { incident_id: 'incident-1' }
      })
    ).toEqual({
      trace_id: 'trace-1',
      event_id: 'event-1',
      event_type: 'INCIDENT_COMPLETION',
      model_needed: false,
      next_step: 'incident_completion_commit'
    });
  });

  it('rejects unknown event routes instead of defaulting or throwing TypeError', () => {
    expect(() =>
      routeRuntimeEvent({
        event_id: 'event-1',
        trace_id: 'trace-1',
        type: 'FUTURE_EVENT_SENTINEL'
      })
    ).toThrow(RuntimeValidationError);
  });

  it('rejects incomplete direct route inputs instead of emitting malformed routes', () => {
    expect(() =>
      routeRuntimeEvent({
        type: 'USER_MESSAGE'
      })
    ).toThrow(/event_id/);
  });

  it('shared intake appends raw logs and returns normalized event plus route', () => {
    const ids = new SequenceIdGenerator();
    const rawEventLog = new RecordingRawEventLog();

    const result = intakeRuntimeEvent(
      { type: 'USER_MESSAGE', payload: { text: 'hello' } },
      { rawEventLog, idGenerator: ids.next, clock: fixedClock }
    );

    expect(result.event.event_id).toBe('event-generated-1');
    expect(result.event.trace_id).toBe('trace-generated-2');
    expect(result.route).toEqual({
      trace_id: 'trace-generated-2',
      event_id: 'event-generated-1',
      event_type: 'USER_MESSAGE',
      model_needed: true,
      next_step: 'user_turn'
    });
    expect(rawEventLog.entries).toHaveLength(1);
    expect(rawEventLog.entries[0]?.kind).toBe('runtime_event_received');
  });

  it('shared intake appends incident completion raw logs and route', () => {
    const ids = new SequenceIdGenerator();
    const rawEventLog = new RecordingRawEventLog();

    const result = intakeRuntimeEvent(
      { type: 'INCIDENT_COMPLETION', payload: { incident_id: 'incident-1' } },
      { rawEventLog, idGenerator: ids.next, clock: fixedClock }
    );

    expect(result.event.event_id).toBe('event-generated-1');
    expect(result.event.trace_id).toBe('trace-generated-2');
    expect(result.route).toEqual({
      trace_id: 'trace-generated-2',
      event_id: 'event-generated-1',
      event_type: 'INCIDENT_COMPLETION',
      model_needed: false,
      next_step: 'incident_completion_commit'
    });
    expect(rawEventLog.entries).toHaveLength(1);
    expect(rawEventLog.entries[0]?.kind).toBe('runtime_event_received');
    expect(rawEventLog.entries[0]?.data['event']).toMatchObject({
      type: 'INCIDENT_COMPLETION'
    });
  });

  it('raw event log entry copies the event snapshot', () => {
    const event = {
      event_id: 'event-1',
      trace_id: 'trace-1',
      type: 'USER_MESSAGE' as const,
      created_at: '2026-05-14T11:30:00+00:00',
      schema_version: '0.1' as const,
      payload: { text: 'hello' }
    };

    const entry = buildRawEventLogEntry(event, {
      idGenerator: new SequenceIdGenerator().next,
      clock: fixedClock
    });
    event.payload.text = 'mutated';

    expect(entry.data['event']).toMatchObject({
      payload: { text: 'hello' }
    });
  });
});
