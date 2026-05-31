import { describe, expect, it } from 'vitest';

import {
  buildLifeIncidentCompleteCommitRequest,
  buildLifeIncidentCompletionEventCommitRequest,
  commitLifeIncidentComplete,
  commitLifeIncidentCompletionEvent,
  type LifeIncidentCompleteFinalizeRequest
} from '../../../src/commit-effects/incident-complete.ts';
import {
  InMemoryRawEventLog,
  RawEventLogQueryValidationError
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

class StagingCompleteFinalizer {
  readonly rawLog: InMemoryRawEventLog;
  readonly requests: LifeIncidentCompleteFinalizeRequest[] = [];
  readonly completionRequests: LifeIncidentCompleteFinalizeRequest[] = [];
  readonly resultOverride: Record<string, string> | undefined;
  readonly completionError: Error | undefined;
  readonly finalizeError: Error | undefined;

  constructor(
    rawLog: InMemoryRawEventLog,
    resultOverride?: Record<string, string>,
    completionError?: Error,
    finalizeError?: Error
  ) {
    this.rawLog = rawLog;
    this.resultOverride = resultOverride;
    this.completionError = completionError;
    this.finalizeError = finalizeError;
  }

  requireLifeIncidentCompleteRawEventLog(rawLog: unknown): void {
    if (rawLog !== this.rawLog) {
      throw new Error('raw log mismatch');
    }
  }

  finalizeLifeIncidentComplete(
    request: LifeIncidentCompleteFinalizeRequest
  ): Record<string, string> {
    this.requests.push(structuredClone(request));
    if (this.finalizeError !== undefined) {
      throw this.finalizeError;
    }
    this.rawLog.exposeCommittedSuccessEntry(request.committed_log_entry);
    if (this.resultOverride !== undefined) {
      return structuredClone(this.resultOverride);
    }
    return {
      schema_version: '0.1',
      trace_id: request.trace_id,
      event_id: request.event_id,
      event_type: request.event_type,
      committed_log_entry_id: request.committed_log_entry.log_id
    };
  }

  completeLifeIncidentCompleteAfterLogVisible(request: LifeIncidentCompleteFinalizeRequest): void {
    this.completionRequests.push(structuredClone(request));
    if (this.completionError !== undefined) {
      throw this.completionError;
    }
  }
}

function normalizedUserMessage(): Record<string, unknown> {
  return {
    event_id: 'event-complete',
    trace_id: 'trace-complete',
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

function normalizedIncidentCompletionEvent(incidentId = 'incident-1'): Record<string, unknown> {
  return {
    event_id: 'event-completion-due',
    trace_id: 'trace-completion-due',
    type: 'INCIDENT_COMPLETION',
    created_at: '2026-05-22T08:59:30+00:00',
    schema_version: '0.1',
    payload: {
      incident_id: incidentId,
      user_id: 'user-1',
      conversation_id: 'conversation-1'
    }
  };
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

function roleModelResultWithComplete(incidentId = 'incident-1'): Record<string, unknown> {
  return {
    trace_id: 'trace-complete',
    event_id: 'event-complete',
    event_type: 'USER_MESSAGE',
    model_called: true,
    status: 'decision_ready_for_commit',
    decision: {
      schema_version: '0.1',
      trace_id: 'trace-complete',
      event_id: 'event-complete',
      action: 'visible_reply',
      visible_reply: { text: 'hello back' },
      life_action: {
        type: 'complete_incident',
        incident_id: incidentId
      }
    }
  };
}

function roleModelResultWithoutLifeAction(): Record<string, unknown> {
  const result = roleModelResultWithComplete();
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

function fixedClock(): Date {
  return new Date('2026-05-22T09:00:00Z');
}

describe('life incident complete commit effects', () => {
  it('builds model-driven and event-driven complete commit requests', () => {
    expect(
      buildLifeIncidentCompleteCommitRequest(normalizedUserMessage(), {
        ...roleModelResultWithComplete(' incident-1 ')
      })
    ).toEqual({
      schema_version: '0.1',
      trace_id: 'trace-complete',
      event_id: 'event-complete',
      event_type: 'USER_MESSAGE',
      decision_action: 'visible_reply',
      life_action_type: 'complete_incident',
      incident_id: 'incident-1',
      user_id: 'user-1',
      conversation_id: 'conversation-1'
    });

    expect(
      buildLifeIncidentCompletionEventCommitRequest({
        ...normalizedIncidentCompletionEvent(' incident-1 ')
      })
    ).toEqual({
      schema_version: '0.1',
      trace_id: 'trace-completion-due',
      event_id: 'event-completion-due',
      event_type: 'INCIDENT_COMPLETION',
      incident_id: 'incident-1',
      user_id: 'user-1',
      conversation_id: 'conversation-1'
    });
  });

  it('commits model-driven complete success and confirms success log visibility', () => {
    const rawLog = new InMemoryRawEventLog();
    const result = commitLifeIncidentComplete(
      normalizedUserMessage(),
      roleModelResultWithComplete(),
      {
        activeIncidentSource: new RecordingActiveIncidentSource(activeIncidentSnapshot()),
        lifeIncidentCompleteFinalizer: new StagingCompleteFinalizer(rawLog),
        rawEventLog: rawLog,
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock
      }
    );

    expect(result.status).toBe('life_incident_completed');
    if (result.status !== 'life_incident_completed') {
      throw new Error('expected complete success');
    }
    expect(result.completed_incident.status).toBe('completed');
    expect(result.completed_incident.source_event_ids).toEqual(['event-start', 'event-complete']);
    expect(rawLog.query({ trace_id: 'trace-complete' }).entries.map((entry) => entry.kind)).toEqual([
      'life_incident_completed'
    ]);
  });

  it('skips model-driven complete when the decision has no life action', () => {
    const rawLog = new InMemoryRawEventLog();
    const activeSource = new RecordingActiveIncidentSource(activeIncidentSnapshot());
    const finalizer = new StagingCompleteFinalizer(rawLog);
    const result = commitLifeIncidentComplete(
      normalizedUserMessage(),
      roleModelResultWithoutLifeAction(),
      {
        activeIncidentSource: activeSource,
        lifeIncidentCompleteFinalizer: finalizer,
        rawEventLog: rawLog,
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock
      }
    );

    expect(result.status).toBe('life_incident_complete_skipped');
    expect(activeSource.requests).toEqual([]);
    expect(finalizer.requests).toEqual([]);
    expect(rawLog.query({ trace_id: 'trace-complete' }).entries).toEqual([]);
  });

  it('rejects invalid model-driven source event types instead of throwing', () => {
    const rawLog = new InMemoryRawEventLog();
    const activeSource = new RecordingActiveIncidentSource(activeIncidentSnapshot());
    const finalizer = new StagingCompleteFinalizer(rawLog);
    const result = commitLifeIncidentComplete(
      { ...normalizedUserMessage(), type: 'TIMER' },
      roleModelResultWithComplete(),
      {
        activeIncidentSource: activeSource,
        lifeIncidentCompleteFinalizer: finalizer,
        rawEventLog: rawLog,
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock
      }
    );

    expect(result.status).toBe('life_incident_complete_rejected');
    if (result.status !== 'life_incident_complete_rejected') {
      throw new Error('expected complete rejection');
    }
    expect(result.failure.stage).toBe('life_incident_complete_commit_validation');
    expect(result.failure.code).toBe('malformed_commit_input');
    expect(result.failure.message).toContain('source_event.type must be "USER_MESSAGE"');
    expect(activeSource.requests).toEqual([]);
    expect(finalizer.requests).toEqual([]);
    expect(rawLog.query({ trace_id: 'trace-complete' }).entries.map((entry) => entry.kind)).toEqual([
      'life_incident_complete_rejected'
    ]);
  });

  it('rejects completion event active-source errors before finalizer calls', () => {
    const rawLog = new InMemoryRawEventLog();
    const finalizer = new StagingCompleteFinalizer(rawLog);
    const result = commitLifeIncidentCompletionEvent(normalizedIncidentCompletionEvent(), {
      activeIncidentSource: new RecordingActiveIncidentSource(
        undefined,
        new Error('incident store unavailable')
      ),
      lifeIncidentCompleteFinalizer: finalizer,
      rawEventLog: rawLog,
      idGenerator: new SequenceIdGenerator().next,
      clock: fixedClock
    });

    expect(result.status).toBe('life_incident_complete_rejected');
    if (result.status !== 'life_incident_complete_rejected') {
      throw new Error('expected complete rejection');
    }
    expect(result.failure.stage).toBe('incident_completion_event_commit_validation');
    expect(result.failure.code).toBe('active_incident_source_error');
    expect(result.failure.message).toContain('incident store unavailable');
    expect(finalizer.requests).toEqual([]);
    expect(rawLog.query({ trace_id: 'trace-completion-due' }).entries[0]?.data).not.toHaveProperty(
      'role_model_result_snapshot'
    );
  });

  it('discards staged success when finalizer result is malformed', () => {
    const rawLog = new InMemoryRawEventLog();
    const result = commitLifeIncidentComplete(
      normalizedUserMessage(),
      roleModelResultWithComplete(),
      {
        activeIncidentSource: new RecordingActiveIncidentSource(activeIncidentSnapshot()),
        lifeIncidentCompleteFinalizer: new StagingCompleteFinalizer(rawLog, {
          schema_version: '0.1',
          trace_id: 'trace-complete',
          event_id: 'event-complete',
          event_type: 'USER_MESSAGE',
          committed_log_entry_id: 'wrong-log-id'
        }),
        rawEventLog: rawLog,
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock
      }
    );

    expect(result.status).toBe('life_incident_complete_rejected');
    if (result.status !== 'life_incident_complete_rejected') {
      throw new Error('expected complete rejection');
    }
    expect(result.failure.stage).toBe('life_incident_complete_finalize');
    expect(result.failure.code).toBe('malformed_finalize_result');
    expect(rawLog.query({ trace_id: 'trace-complete' }).entries.map((entry) => entry.kind)).toEqual([
      'life_incident_complete_rejected'
    ]);
  });

  it('maps raw-log validation errors from the complete finalizer to malformed finalize results', () => {
    const rawLog = new InMemoryRawEventLog();
    const result = commitLifeIncidentComplete(
      normalizedUserMessage(),
      roleModelResultWithComplete(),
      {
        activeIncidentSource: new RecordingActiveIncidentSource(activeIncidentSnapshot()),
        lifeIncidentCompleteFinalizer: new StagingCompleteFinalizer(
          rawLog,
          undefined,
          undefined,
          new RawEventLogQueryValidationError('complete visibility staging failed')
        ),
        rawEventLog: rawLog,
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock
      }
    );

    expect(result.status).toBe('life_incident_complete_rejected');
    if (result.status !== 'life_incident_complete_rejected') {
      throw new Error('expected complete rejection');
    }
    expect(result.failure.stage).toBe('life_incident_complete_finalize');
    expect(result.failure.code).toBe('malformed_finalize_result');
    expect(rawLog.query({ trace_id: 'trace-complete' }).entries.map((entry) => entry.kind)).toEqual([
      'life_incident_complete_rejected'
    ]);
  });

  it('keeps success log and appends rejected log when post-visible completion fails', () => {
    const rawLog = new InMemoryRawEventLog();
    const result = commitLifeIncidentComplete(
      normalizedUserMessage(),
      roleModelResultWithComplete(),
      {
        activeIncidentSource: new RecordingActiveIncidentSource(activeIncidentSnapshot()),
        lifeIncidentCompleteFinalizer: new StagingCompleteFinalizer(
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

    expect(result.status).toBe('life_incident_complete_rejected');
    if (result.status !== 'life_incident_complete_rejected') {
      throw new Error('expected complete rejection');
    }
    expect(result.failure.stage).toBe('life_incident_complete_finalize');
    expect(result.failure.code).toBe('finalize_rejected');
    expect(result.failure.message).toContain('completion failed');
    expect(rawLog.query({ trace_id: 'trace-complete' }).entries.map((entry) => entry.kind)).toEqual([
      'life_incident_completed',
      'life_incident_complete_rejected'
    ]);
  });

  it('maps raw-log validation errors from complete post-visible completion to malformed finalize results', () => {
    const rawLog = new InMemoryRawEventLog();
    const result = commitLifeIncidentComplete(
      normalizedUserMessage(),
      roleModelResultWithComplete(),
      {
        activeIncidentSource: new RecordingActiveIncidentSource(activeIncidentSnapshot()),
        lifeIncidentCompleteFinalizer: new StagingCompleteFinalizer(
          rawLog,
          undefined,
          new RawEventLogQueryValidationError('complete visibility confirm failed')
        ),
        rawEventLog: rawLog,
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock
      }
    );

    expect(result.status).toBe('life_incident_complete_rejected');
    if (result.status !== 'life_incident_complete_rejected') {
      throw new Error('expected complete rejection');
    }
    expect(result.failure.stage).toBe('life_incident_complete_finalize');
    expect(result.failure.code).toBe('malformed_finalize_result');
    expect(rawLog.query({ trace_id: 'trace-complete' }).entries.map((entry) => entry.kind)).toEqual([
      'life_incident_completed',
      'life_incident_complete_rejected'
    ]);
  });
});
