import { describe, expect, it } from 'vitest';

import {
  LifeIncidentInterruptFinalizerError,
  buildInterruptedLifeIncidentSnapshot,
  buildLifeIncidentInterruptCommitRequest,
  commitLifeIncidentInterruption,
  type LifeIncidentInterruptFinalizeRequest
} from '../../../src/commit-effects/incident-interrupt.ts';
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

class StagingInterruptFinalizer {
  readonly rawLog: InMemoryRawEventLog;
  readonly requests: LifeIncidentInterruptFinalizeRequest[] = [];
  readonly completionRequests: LifeIncidentInterruptFinalizeRequest[] = [];
  readonly completionError: Error | undefined;
  readonly finalizeError: Error | undefined;

  constructor(
    rawLog: InMemoryRawEventLog,
    completionError?: Error,
    finalizeError?: Error
  ) {
    this.rawLog = rawLog;
    this.completionError = completionError;
    this.finalizeError = finalizeError;
  }

  requireLifeIncidentInterruptRawEventLog(rawLog: unknown): void {
    if (rawLog !== this.rawLog) {
      throw new LifeIncidentInterruptFinalizerError('raw log mismatch', {
        code: 'malformed_finalize_result'
      });
    }
  }

  finalizeLifeIncidentInterrupt(
    request: LifeIncidentInterruptFinalizeRequest
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

  completeLifeIncidentInterruptAfterLogVisible(
    request: LifeIncidentInterruptFinalizeRequest
  ): void {
    this.completionRequests.push(structuredClone(request));
    if (this.completionError !== undefined) {
      throw this.completionError;
    }
  }
}

function normalizedUserMessage(): Record<string, unknown> {
  return {
    event_id: 'event-interrupt',
    trace_id: 'trace-interrupt',
    type: 'USER_MESSAGE',
    created_at: '2026-05-25T08:59:00+00:00',
    schema_version: '0.1',
    payload: {
      text: 'are you there?',
      user_id: 'user-1',
      conversation_id: 'conversation-1'
    }
  };
}

function activeIncidentSnapshot(interruptPolicy = 'interruptible'): Record<string, unknown> {
  return {
    schema_version: '0.1',
    incident_id: 'incident-1',
    type: 'eat',
    status: 'active',
    title: 'Eating lunch',
    started_at: '2026-05-25T08:40:00+00:00',
    expected_end_at: '2026-05-25T09:20:00+00:00',
    remaining_seconds: 1200,
    interrupt_policy: interruptPolicy,
    resume_policy: 'resume',
    source_event_ids: ['event-start']
  };
}

function fixedClock(): Date {
  return new Date('2026-05-25T09:00:00Z');
}

describe('life incident interruption commit effects', () => {
  it('builds interrupt requests and interrupted snapshots from active incidents', () => {
    const request = buildLifeIncidentInterruptCommitRequest(
      normalizedUserMessage(),
      activeIncidentSnapshot()
    );

    expect(request).toEqual({
      schema_version: '0.1',
      trace_id: 'trace-interrupt',
      event_id: 'event-interrupt',
      event_type: 'USER_MESSAGE',
      incident_id: 'incident-1',
      user_id: 'user-1',
      conversation_id: 'conversation-1'
    });

    expect(
      buildInterruptedLifeIncidentSnapshot(activeIncidentSnapshot(), {
        ...request,
        commit_time: '2026-05-25T09:00:00+00:00'
      })
    ).toEqual({
      schema_version: '0.1',
      incident_id: 'incident-1',
      type: 'eat',
      status: 'interrupted',
      title: 'Eating lunch',
      started_at: '2026-05-25T08:40:00+00:00',
      expected_end_at: '2026-05-25T09:20:00+00:00',
      remaining_seconds: 1200,
      interrupt_policy: 'interruptible',
      resume_policy: 'resume',
      interrupted_at: '2026-05-25T09:00:00+00:00',
      source_event_ids: ['event-start', 'event-interrupt']
    });
  });

  it('commits interruptible incidents through staged success visibility', () => {
    const rawLog = new InMemoryRawEventLog();
    const finalizer = new StagingInterruptFinalizer(rawLog);
    const result = commitLifeIncidentInterruption(normalizedUserMessage(), {
      activeIncidentSource: new RecordingActiveIncidentSource(activeIncidentSnapshot()),
      lifeIncidentInterruptFinalizer: finalizer,
      rawEventLog: rawLog,
      idGenerator: new SequenceIdGenerator().next,
      clock: fixedClock
    });

    expect(result.status).toBe('life_incident_interrupted');
    if (result.status !== 'life_incident_interrupted') {
      throw new Error('expected interruption success');
    }
    expect(result.interrupted_incident.status).toBe('interrupted');
    expect(result.interrupted_incident.source_event_ids).toEqual([
      'event-start',
      'event-interrupt'
    ]);
    expect(finalizer.completionRequests).toHaveLength(1);
    expect(rawLog.query({ trace_id: 'trace-interrupt' }).entries.map((entry) => entry.kind)).toEqual([
      'life_incident_interrupted'
    ]);
  });

  it('logs background and protected policy outcomes without finalizer calls', () => {
    const rawLog = new InMemoryRawEventLog();
    const finalizer = new StagingInterruptFinalizer(rawLog);
    const ids = new SequenceIdGenerator();
    const backgroundResult = commitLifeIncidentInterruption(normalizedUserMessage(), {
      activeIncidentSource: new RecordingActiveIncidentSource(activeIncidentSnapshot('background')),
      lifeIncidentInterruptFinalizer: finalizer,
      rawEventLog: rawLog,
      idGenerator: ids.next,
      clock: fixedClock
    });
    const protectedResult = commitLifeIncidentInterruption(
      {
        ...normalizedUserMessage(),
        event_id: 'event-protected',
        trace_id: 'trace-protected'
      },
      {
        activeIncidentSource: new RecordingActiveIncidentSource(activeIncidentSnapshot('protected')),
        lifeIncidentInterruptFinalizer: finalizer,
        rawEventLog: rawLog,
        idGenerator: ids.next,
        clock: fixedClock
      }
    );

    expect(backgroundResult.status).toBe('life_incident_continued_in_background');
    expect(protectedResult.status).toBe('life_incident_protected_from_interruption');
    expect(finalizer.requests).toEqual([]);
    expect(rawLog.query({ trace_id: 'trace-interrupt' }).entries[0]?.data['outcome']).toBe(
      'continued_in_background'
    );
    expect(rawLog.query({ trace_id: 'trace-protected' }).entries[0]?.data['outcome']).toBe(
      'protected_from_interruption'
    );
  });

  it('skips without logs when no active incident exists', () => {
    const rawLog = new InMemoryRawEventLog();
    const result = commitLifeIncidentInterruption(normalizedUserMessage(), {
      activeIncidentSource: new RecordingActiveIncidentSource(undefined),
      lifeIncidentInterruptFinalizer: new StagingInterruptFinalizer(rawLog),
      rawEventLog: rawLog,
      idGenerator: new SequenceIdGenerator().next,
      clock: fixedClock
    });

    expect(result.status).toBe('life_incident_interrupt_skipped');
    expect(rawLog.query({ trace_id: 'trace-interrupt' }).entries).toEqual([]);
  });

  it('rejects invalid source event types instead of throwing', () => {
    const rawLog = new InMemoryRawEventLog();
    const activeSource = new RecordingActiveIncidentSource(activeIncidentSnapshot());
    const finalizer = new StagingInterruptFinalizer(rawLog);
    const result = commitLifeIncidentInterruption(
      { ...normalizedUserMessage(), type: 'TIMER' },
      {
        activeIncidentSource: activeSource,
        lifeIncidentInterruptFinalizer: finalizer,
        rawEventLog: rawLog,
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock
      }
    );

    expect(result.status).toBe('life_incident_interrupt_rejected');
    if (result.status !== 'life_incident_interrupt_rejected') {
      throw new Error('expected interruption rejection');
    }
    expect(result.failure.stage).toBe('life_incident_interrupt_commit_validation');
    expect(result.failure.code).toBe('malformed_commit_input');
    expect(result.failure.message).toContain('source_event.type must be "USER_MESSAGE"');
    expect(activeSource.requests).toEqual([]);
    expect(finalizer.requests).toEqual([]);
    expect(rawLog.query({ trace_id: 'trace-interrupt' }).entries.map((entry) => entry.kind)).toEqual([
      'life_incident_interrupt_rejected'
    ]);
  });

  it('rejects active source errors with a query-visible rejected log', () => {
    const rawLog = new InMemoryRawEventLog();
    const result = commitLifeIncidentInterruption(normalizedUserMessage(), {
      activeIncidentSource: new RecordingActiveIncidentSource(
        activeIncidentSnapshot(),
        new Error('source unavailable')
      ),
      lifeIncidentInterruptFinalizer: new StagingInterruptFinalizer(rawLog),
      rawEventLog: rawLog,
      idGenerator: new SequenceIdGenerator().next,
      clock: fixedClock
    });

    expect(result.status).toBe('life_incident_interrupt_rejected');
    if (result.status !== 'life_incident_interrupt_rejected') {
      throw new Error('expected interruption rejection');
    }
    expect(result.failure.stage).toBe('life_incident_interrupt_commit_validation');
    expect(result.failure.code).toBe('active_incident_source_error');
    expect(rawLog.query({ trace_id: 'trace-interrupt' }).entries.map((entry) => entry.kind)).toEqual([
      'life_incident_interrupt_rejected'
    ]);
  });

  it('keeps success log and appends rejected log when post-visible completion fails', () => {
    const rawLog = new InMemoryRawEventLog();
    const result = commitLifeIncidentInterruption(normalizedUserMessage(), {
      activeIncidentSource: new RecordingActiveIncidentSource(activeIncidentSnapshot()),
      lifeIncidentInterruptFinalizer: new StagingInterruptFinalizer(
        rawLog,
        Object.assign(new Error('completion failed after success log visibility'), {
          code: 'storage_backend_error'
        })
      ),
      rawEventLog: rawLog,
      idGenerator: new SequenceIdGenerator().next,
      clock: fixedClock
    });

    expect(result.status).toBe('life_incident_interrupt_rejected');
    if (result.status !== 'life_incident_interrupt_rejected') {
      throw new Error('expected interruption rejection');
    }
    expect(result.failure.stage).toBe('life_incident_interrupt_finalize');
    expect(result.failure.code).toBe('finalize_rejected');
    const entries = rawLog.query({ trace_id: 'trace-interrupt' }).entries;
    expect(entries.map((entry) => entry.kind)).toEqual([
      'life_incident_interrupted',
      'life_incident_interrupt_rejected'
    ]);
    expect(entries[1]?.data['failure']).toMatchObject({
      stage: 'life_incident_interrupt_finalize',
      code: 'finalize_rejected'
    });
  });

  it('maps raw-log validation errors from the interrupt finalizer to malformed finalize results', () => {
    const rawLog = new InMemoryRawEventLog();
    const result = commitLifeIncidentInterruption(normalizedUserMessage(), {
      activeIncidentSource: new RecordingActiveIncidentSource(activeIncidentSnapshot()),
      lifeIncidentInterruptFinalizer: new StagingInterruptFinalizer(
        rawLog,
        undefined,
        new RawEventLogQueryValidationError('interrupt visibility staging failed')
      ),
      rawEventLog: rawLog,
      idGenerator: new SequenceIdGenerator().next,
      clock: fixedClock
    });

    expect(result.status).toBe('life_incident_interrupt_rejected');
    if (result.status !== 'life_incident_interrupt_rejected') {
      throw new Error('expected interruption rejection');
    }
    expect(result.failure.stage).toBe('life_incident_interrupt_finalize');
    expect(result.failure.code).toBe('malformed_finalize_result');
    expect(rawLog.query({ trace_id: 'trace-interrupt' }).entries.map((entry) => entry.kind)).toEqual([
      'life_incident_interrupt_rejected'
    ]);
  });

  it('records rejected log for raw-log validation errors from interrupt post-visible completion', () => {
    const rawLog = new InMemoryRawEventLog();
    const result = commitLifeIncidentInterruption(normalizedUserMessage(), {
      activeIncidentSource: new RecordingActiveIncidentSource(activeIncidentSnapshot()),
      lifeIncidentInterruptFinalizer: new StagingInterruptFinalizer(
        rawLog,
        new RawEventLogQueryValidationError('interrupt visibility confirm failed')
      ),
      rawEventLog: rawLog,
      idGenerator: new SequenceIdGenerator().next,
      clock: fixedClock
    });

    expect(result.status).toBe('life_incident_interrupt_rejected');
    if (result.status !== 'life_incident_interrupt_rejected') {
      throw new Error('expected interruption rejection');
    }
    expect(result.failure.stage).toBe('life_incident_interrupt_finalize');
    expect(result.failure.code).toBe('finalize_rejected');
    const entries = rawLog.query({ trace_id: 'trace-interrupt' }).entries;
    expect(entries.map((entry) => entry.kind)).toEqual([
      'life_incident_interrupted',
      'life_incident_interrupt_rejected'
    ]);
    expect(entries[1]?.data['failure']).toMatchObject({
      stage: 'life_incident_interrupt_finalize',
      code: 'finalize_rejected'
    });
  });
});
