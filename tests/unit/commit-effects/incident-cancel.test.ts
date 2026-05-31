import { describe, expect, it } from 'vitest';

import {
  LifeIncidentCancelCommitValidationError,
  buildCancelledLifeIncidentSnapshot,
  buildLifeIncidentCancelCommitRequest,
  buildLifeIncidentCancelFinalizeRequest,
  buildLifeIncidentCancelledLogEntry,
  commitLifeIncidentCancel,
  type LifeIncidentCancelFinalizeRequest
} from '../../../src/commit-effects/incident-cancel.ts';
import {
  InMemoryRawEventLog,
  RawEventLogQueryValidationError,
  type RawEventLogEntry
} from '../../../src/runtime/logging.ts';

class SequenceIdGenerator {
  readonly calls: string[] = [];

  next = (kind: string): string => {
    this.calls.push(kind);
    return `${kind}-generated-${String(this.calls.length)}`;
  };
}

class RecordingActiveIncidentSource {
  readonly requests: unknown[] = [];
  readonly snapshot: unknown;
  readonly error: Error | undefined;

  constructor(snapshot: unknown, error?: Error) {
    this.snapshot = structuredClone(snapshot);
    this.error = error;
  }

  readActiveIncident(request: unknown): unknown {
    this.requests.push(structuredClone(request));
    if (this.error !== undefined) {
      throw this.error;
    }
    return structuredClone(this.snapshot);
  }
}

class StagingCancelFinalizer {
  readonly rawLog: InMemoryRawEventLog;
  readonly requests: LifeIncidentCancelFinalizeRequest[] = [];
  readonly completionRequests: LifeIncidentCancelFinalizeRequest[] = [];
  readonly finalizeError: Error | undefined;
  readonly completionError: Error | undefined;

  constructor(
    rawLog: InMemoryRawEventLog,
    finalizeError?: Error,
    completionError?: Error
  ) {
    this.rawLog = rawLog;
    this.finalizeError = finalizeError;
    this.completionError = completionError;
  }

  requireLifeIncidentCancelRawEventLog(rawLog: unknown): void {
    if (rawLog !== this.rawLog) {
      throw new Error('raw log mismatch');
    }
  }

  finalizeLifeIncidentCancel(
    request: LifeIncidentCancelFinalizeRequest
  ): Record<string, string> {
    this.requests.push(structuredClone(request));
    if (this.finalizeError !== undefined) {
      throw this.finalizeError;
    }
    this.rawLog.exposeCommittedSuccessEntry(request.committed_log_entry);
    return {
      schema_version: '0.1',
      trace_id: request.trace_id,
      event_id: request.event_id,
      event_type: request.event_type,
      committed_log_entry_id: request.committed_log_entry.log_id
    };
  }

  completeLifeIncidentCancelAfterLogVisible(request: LifeIncidentCancelFinalizeRequest): void {
    this.completionRequests.push(structuredClone(request));
    if (this.completionError !== undefined) {
      throw this.completionError;
    }
  }
}

function normalizedUserMessage(): Record<string, unknown> {
  return {
    event_id: 'event-cancel',
    trace_id: 'trace-cancel',
    type: 'USER_MESSAGE',
    created_at: '2026-05-22T08:59:00+00:00',
    schema_version: '0.1',
    payload: {
      text: 'stop that',
      user_id: 'user-1',
      conversation_id: 'conversation-1'
    }
  };
}

function roleModelResultWithCancel(): Record<string, unknown> {
  return {
    trace_id: 'trace-cancel',
    event_id: 'event-cancel',
    event_type: 'USER_MESSAGE',
    model_called: true,
    status: 'decision_ready_for_commit',
    decision: {
      schema_version: '0.1',
      trace_id: 'trace-cancel',
      event_id: 'event-cancel',
      action: 'visible_reply',
      visible_reply: { text: 'hello back' },
      life_action: {
        type: 'cancel_incident',
        incident_id: ' incident-1 ',
        reason: ' User needs attention now. '
      }
    }
  };
}

function roleModelResultWithoutLifeAction(): Record<string, unknown> {
  const result = roleModelResultWithCancel();
  const decision = result['decision'];
  if (!isRecord(decision)) {
    throw new Error('expected decision');
  }
  delete decision['life_action'];
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function activeIncidentSnapshot(): Record<string, unknown> {
  return {
    schema_version: '0.1',
    incident_id: 'incident-1',
    type: 'think',
    status: 'active',
    title: 'Thinking through the plan',
    started_at: '2026-05-22T08:40:00+00:00',
    remaining_seconds: 300,
    interrupt_policy: 'interruptible',
    resume_policy: 'ask_model',
    source_event_ids: ['event-start']
  };
}

function fixedClock(): Date {
  return new Date('2026-05-22T09:00:00Z');
}

describe('life incident cancel commit effects', () => {
  it('builds a cancel commit request from a cancel life action', () => {
    expect(
      buildLifeIncidentCancelCommitRequest(
        normalizedUserMessage(),
        roleModelResultWithCancel()
      )
    ).toEqual({
      schema_version: '0.1',
      trace_id: 'trace-cancel',
      event_id: 'event-cancel',
      event_type: 'USER_MESSAGE',
      decision_action: 'visible_reply',
      life_action_type: 'cancel_incident',
      incident_id: 'incident-1',
      reason: 'User needs attention now.',
      user_id: 'user-1',
      conversation_id: 'conversation-1'
    });
  });

  it('commits cancel success through atomic raw-log visibility', () => {
    const rawLog = new InMemoryRawEventLog();
    const finalizer = new StagingCancelFinalizer(rawLog);
    const result = commitLifeIncidentCancel(
      normalizedUserMessage(),
      roleModelResultWithCancel(),
      {
        activeIncidentSource: new RecordingActiveIncidentSource(activeIncidentSnapshot()),
        lifeIncidentCancelFinalizer: finalizer,
        rawEventLog: rawLog,
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock
      }
    );

    const entries = rawLog.query({ trace_id: 'trace-cancel' }).entries;
    expect(result.status).toBe('life_incident_cancelled');
    if (result.status !== 'life_incident_cancelled') {
      throw new Error('expected cancel success');
    }
    expect(finalizer.requests).toHaveLength(1);
    expect(finalizer.completionRequests).toHaveLength(1);
    expect(result.cancelled_incident.status).toBe('cancelled');
    expect(result.cancelled_incident.source_event_ids).toEqual(['event-start', 'event-cancel']);
    expect(entries.map((entry) => entry.kind)).toEqual(['life_incident_cancelled']);
    expect(entries[0]?.data['active_incident']).toEqual(activeIncidentSnapshot());
    expect(entries[0]?.data['cancelled_incident']).toEqual(result.cancelled_incident);
  });

  it('skips without active read or finalizer call when no life action is present', () => {
    const rawLog = new InMemoryRawEventLog();
    const activeSource = new RecordingActiveIncidentSource(activeIncidentSnapshot());
    const finalizer = new StagingCancelFinalizer(rawLog);

    const result = commitLifeIncidentCancel(
      normalizedUserMessage(),
      roleModelResultWithoutLifeAction(),
      {
        activeIncidentSource: activeSource,
        lifeIncidentCancelFinalizer: finalizer,
        rawEventLog: rawLog,
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock
      }
    );

    expect(result.status).toBe('life_incident_cancel_skipped');
    expect(activeSource.requests).toEqual([]);
    expect(finalizer.requests).toEqual([]);
    expect(rawLog.query({ trace_id: 'trace-cancel' }).entries).toEqual([]);
  });

  it('wraps finalizer runtime errors as rejected audit entries', () => {
    const rawLog = new InMemoryRawEventLog();
    const result = commitLifeIncidentCancel(
      normalizedUserMessage(),
      roleModelResultWithCancel(),
      {
        activeIncidentSource: new RecordingActiveIncidentSource(activeIncidentSnapshot()),
        lifeIncidentCancelFinalizer: new StagingCancelFinalizer(
          rawLog,
          Object.assign(new Error('finalizer storage failed'), {
            code: 'storage_backend_error'
          })
        ),
        rawEventLog: rawLog,
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock
      }
    );

    expect(result.status).toBe('life_incident_cancel_rejected');
    if (result.status !== 'life_incident_cancel_rejected') {
      throw new Error('expected cancel rejection');
    }
    expect(result.failure.stage).toBe('life_incident_cancel_finalize');
    expect(result.failure.code).toBe('finalize_rejected');
    expect(result.failure.message).toContain('finalizer storage failed');
    expect(rawLog.query({ trace_id: 'trace-cancel' }).entries.map((entry) => entry.kind)).toEqual([
      'life_incident_cancel_rejected'
    ]);
  });

  it('maps raw-log validation errors from the cancel finalizer to malformed finalize results', () => {
    const rawLog = new InMemoryRawEventLog();
    const result = commitLifeIncidentCancel(
      normalizedUserMessage(),
      roleModelResultWithCancel(),
      {
        activeIncidentSource: new RecordingActiveIncidentSource(activeIncidentSnapshot()),
        lifeIncidentCancelFinalizer: new StagingCancelFinalizer(
          rawLog,
          new RawEventLogQueryValidationError('cancel visibility staging failed')
        ),
        rawEventLog: rawLog,
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock
      }
    );

    expect(result.status).toBe('life_incident_cancel_rejected');
    if (result.status !== 'life_incident_cancel_rejected') {
      throw new Error('expected cancel rejection');
    }
    expect(result.failure.stage).toBe('life_incident_cancel_finalize');
    expect(result.failure.code).toBe('malformed_finalize_result');
    expect(rawLog.query({ trace_id: 'trace-cancel' }).entries.map((entry) => entry.kind)).toEqual([
      'life_incident_cancel_rejected'
    ]);
  });

  it('keeps success log and appends rejected log when post-visible completion fails', () => {
    const rawLog = new InMemoryRawEventLog();
    const result = commitLifeIncidentCancel(
      normalizedUserMessage(),
      roleModelResultWithCancel(),
      {
        activeIncidentSource: new RecordingActiveIncidentSource(activeIncidentSnapshot()),
        lifeIncidentCancelFinalizer: new StagingCancelFinalizer(
          rawLog,
          undefined,
          Object.assign(new Error('completion failed after success visibility'), {
            code: 'storage_backend_error'
          })
        ),
        rawEventLog: rawLog,
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock
      }
    );

    expect(result.status).toBe('life_incident_cancel_rejected');
    if (result.status !== 'life_incident_cancel_rejected') {
      throw new Error('expected cancel rejection');
    }
    expect(result.failure.stage).toBe('life_incident_cancel_finalize');
    expect(result.failure.code).toBe('finalize_rejected');
    expect(result.failure.message).toContain('completion failed');
    expect(rawLog.query({ trace_id: 'trace-cancel' }).entries.map((entry) => entry.kind)).toEqual([
      'life_incident_cancelled',
      'life_incident_cancel_rejected'
    ]);
  });

  it('maps raw-log validation errors from cancel post-visible completion to malformed finalize results', () => {
    const rawLog = new InMemoryRawEventLog();
    const result = commitLifeIncidentCancel(
      normalizedUserMessage(),
      roleModelResultWithCancel(),
      {
        activeIncidentSource: new RecordingActiveIncidentSource(activeIncidentSnapshot()),
        lifeIncidentCancelFinalizer: new StagingCancelFinalizer(
          rawLog,
          undefined,
          new RawEventLogQueryValidationError('cancel visibility confirm failed')
        ),
        rawEventLog: rawLog,
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock
      }
    );

    expect(result.status).toBe('life_incident_cancel_rejected');
    if (result.status !== 'life_incident_cancel_rejected') {
      throw new Error('expected cancel rejection');
    }
    expect(result.failure.stage).toBe('life_incident_cancel_finalize');
    expect(result.failure.code).toBe('malformed_finalize_result');
    expect(rawLog.query({ trace_id: 'trace-cancel' }).entries.map((entry) => entry.kind)).toEqual([
      'life_incident_cancelled',
      'life_incident_cancel_rejected'
    ]);
  });

  it('rejects incident id mismatches before finalizer calls', () => {
    const rawLog = new InMemoryRawEventLog();
    const finalizer = new StagingCancelFinalizer(rawLog);
    const result = commitLifeIncidentCancel(
      normalizedUserMessage(),
      roleModelResultWithCancel(),
      {
        activeIncidentSource: new RecordingActiveIncidentSource({
          ...activeIncidentSnapshot(),
          incident_id: 'incident-other'
        }),
        lifeIncidentCancelFinalizer: finalizer,
        rawEventLog: rawLog,
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock
      }
    );

    expect(result.status).toBe('life_incident_cancel_rejected');
    if (result.status !== 'life_incident_cancel_rejected') {
      throw new Error('expected cancel rejection');
    }
    expect(result.failure.code).toBe('incident_id_mismatch');
    expect(finalizer.requests).toEqual([]);
    expect(rawLog.query({ trace_id: 'trace-cancel' }).entries[0]?.data['failure']).toEqual(
      result.failure
    );
  });

  it('validates full raw-log entry shape for finalize requests', () => {
    const event = normalizedUserMessage();
    const roleModelResult = roleModelResultWithCancel();
    const activeIncident = activeIncidentSnapshot();
    const request = {
      ...buildLifeIncidentCancelCommitRequest(event, roleModelResult),
      commit_time: '2026-05-22T09:00:00+00:00'
    };
    const cancelledIncident = buildCancelledLifeIncidentSnapshot(activeIncident, request);
    const committedLogEntry = buildLifeIncidentCancelledLogEntry(
      event,
      roleModelResult,
      { type: 'cancel_incident', incident_id: 'incident-1', reason: 'User needs attention now.' },
      activeIncident,
      cancelledIncident,
      { idGenerator: new SequenceIdGenerator().next, clock: fixedClock }
    );
    const malformedLogEntry: RawEventLogEntry & { future_field: string } = {
      ...committedLogEntry,
      future_field: 'not allowed'
    };

    expect(() => {
      buildLifeIncidentCancelFinalizeRequest(request, {
        activeIncident,
        cancelledIncident,
        committedLogEntry: malformedLogEntry
      });
    }).toThrow(LifeIncidentCancelCommitValidationError);
  });
});
