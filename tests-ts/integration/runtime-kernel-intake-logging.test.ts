import { describe, expect, it } from 'vitest';

import { RuntimeKernel, RuntimeValidationError } from '../../src-ts/runtime/kernel.ts';
import type { RawEventLogEntry } from '../../src-ts/runtime/logging.ts';

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

class FailingRawEventLog {
  append(): void {
    throw new Error('append failed');
  }
}

describe('RuntimeKernel intake logging integration', () => {
  it('appends one user-message raw log and routes user turn', () => {
    const rawEventLog = new RecordingRawEventLog();
    const kernel = new RuntimeKernel(rawEventLog, {
      idGenerator: new SequenceIdGenerator().next,
      clock: fixedClock
    });

    const route = kernel.handleEvent({
      type: 'USER_MESSAGE',
      payload: {
        text: 'hello',
        user_id: 'u-1',
        conversation_id: 'c-1'
      }
    });

    expect(route).toEqual({
      trace_id: 'trace-generated-2',
      event_id: 'event-generated-1',
      event_type: 'USER_MESSAGE',
      model_needed: true,
      next_step: 'user_turn'
    });
    expect(rawEventLog.entries).toHaveLength(1);
    expect(rawEventLog.entries[0]).toMatchObject({
      log_id: 'log-generated-3',
      kind: 'runtime_event_received',
      trace_id: 'trace-generated-2',
      event_id: 'event-generated-1',
      schema_version: '0.1',
      data: {
        event: {
          payload: { text: 'hello', user_id: 'u-1', conversation_id: 'c-1' }
        }
      }
    });
  });

  it('appends one incident-completion raw log and routes without model', () => {
    const rawEventLog = new RecordingRawEventLog();
    const kernel = new RuntimeKernel(rawEventLog, {
      idGenerator: new SequenceIdGenerator().next,
      clock: fixedClock
    });

    const route = kernel.handleEvent({
      type: 'INCIDENT_COMPLETION',
      payload: {
        incident_id: 'incident-1',
        user_id: 'u-1',
        conversation_id: 'c-1'
      }
    });

    expect(route).toEqual({
      trace_id: 'trace-generated-2',
      event_id: 'event-generated-1',
      event_type: 'INCIDENT_COMPLETION',
      model_needed: false,
      next_step: 'incident_completion_commit'
    });
    expect(rawEventLog.entries).toHaveLength(1);
    expect(rawEventLog.entries[0]).toMatchObject({
      log_id: 'log-generated-3',
      kind: 'runtime_event_received',
      trace_id: 'trace-generated-2',
      event_id: 'event-generated-1',
      schema_version: '0.1',
      data: {
        event: {
          payload: {
            incident_id: 'incident-1',
            user_id: 'u-1',
            conversation_id: 'c-1'
          }
        }
      }
    });
  });

  it('does not append raw logs on validation failure', () => {
    const rawEventLog = new RecordingRawEventLog();
    const kernel = new RuntimeKernel(rawEventLog, {
      idGenerator: new SequenceIdGenerator().next,
      clock: fixedClock
    });

    expect(() => {
      kernel.handleEvent({ type: 'TIMER', payload: { text: 'hello' } });
    }).toThrow(RuntimeValidationError);

    expect(rawEventLog.entries).toEqual([]);
  });

  it('does not append raw logs on malformed created_at', () => {
    for (const createdAt of [null, '2026-05-14']) {
      const rawEventLog = new RecordingRawEventLog();
      const kernel = new RuntimeKernel(rawEventLog, {
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock
      });

      expect(() => {
        kernel.handleEvent({
          type: 'USER_MESSAGE',
          created_at: createdAt,
          payload: { text: 'hello' }
        });
      }).toThrow(/created_at/);

      expect(rawEventLog.entries).toEqual([]);
    }
  });

  it('propagates raw-log append failure without returning a successful route', () => {
    const kernel = new RuntimeKernel(new FailingRawEventLog(), {
      idGenerator: new SequenceIdGenerator().next,
      clock: fixedClock
    });

    expect(() => {
      kernel.handleEvent({ type: 'USER_MESSAGE', payload: { text: 'hello' } });
    }).toThrow(/append failed/);
  });
});
