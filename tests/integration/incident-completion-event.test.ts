import { describe, expect, it } from 'vitest';

import { InMemoryLifeIncidentStore } from '../../src/character/state/incidents.ts';
import { commitLifeIncidentStart } from '../../src/commit-effects/incident-start.ts';
import { commitLifeIncidentCompletionEvent } from '../../src/commit-effects/incident-complete.ts';
import { InMemoryRawEventLog } from '../../src/runtime/logging.ts';
import {
  INCIDENT_COMPLETION_COMMITTED_STATUS,
  runIncidentCompletionEvent
} from '../../src/runtime/incident-completion.ts';

function sequenceIdGenerator(): (kind: string) => string {
  const calls: string[] = [];
  return (kind: string) => {
    calls.push(kind);
    return `${kind}-generated-${String(calls.length)}`;
  };
}

function fixedClock(): Date {
  return new Date('2026-05-25T09:00:00Z');
}

function userMessage(): Record<string, unknown> {
  return {
    event_id: 'event-start',
    trace_id: 'trace-start',
    type: 'USER_MESSAGE',
    created_at: '2026-05-25T08:59:00+00:00',
    schema_version: '0.1',
    payload: {
      text: 'start thinking',
      user_id: 'user-1',
      conversation_id: 'conversation-1'
    }
  };
}

function roleModelStartResult(): Record<string, unknown> {
  return {
    trace_id: 'trace-start',
    event_id: 'event-start',
    event_type: 'USER_MESSAGE',
    model_called: true,
    status: 'decision_ready_for_commit',
    decision: {
      schema_version: '0.1',
      trace_id: 'trace-start',
      event_id: 'event-start',
      action: 'visible_reply',
      visible_reply: { text: 'I will think it through.' },
      life_action: {
        type: 'start_incident',
        incident: {
          type: 'think',
          title: 'Plan the work',
          remaining_seconds: 300,
          interrupt_policy: 'interruptible',
          resume_policy: 'ask_model'
        }
      }
    }
  };
}

function incidentCompletionEvent(incidentId: string): Record<string, unknown> {
  return {
    event_id: 'event-completion-due',
    trace_id: 'trace-completion-due',
    type: 'INCIDENT_COMPLETION',
    created_at: '2026-05-25T09:05:00+00:00',
    schema_version: '0.1',
    payload: {
      incident_id: incidentId,
      user_id: 'user-1',
      conversation_id: 'conversation-1'
    }
  };
}

describe('incident completion event integration', () => {
  it('completes the active incident without role model data', () => {
    const rawLog = new InMemoryRawEventLog();
    const store = new InMemoryLifeIncidentStore({ rawEventLog: rawLog });
    const ids = sequenceIdGenerator();
    const startResult = commitLifeIncidentStart(userMessage(), roleModelStartResult(), {
      lifeIncidentStartFinalizer: store,
      rawEventLog: rawLog,
      idGenerator: ids,
      clock: fixedClock
    });
    if (startResult.status !== 'life_incident_started') {
      throw new Error('expected start to commit');
    }

    const completeResult = commitLifeIncidentCompletionEvent(
      incidentCompletionEvent(startResult.started_incident.incident_id),
      {
        activeIncidentSource: store,
        lifeIncidentCompleteFinalizer: store,
        rawEventLog: rawLog,
        idGenerator: ids,
        clock: fixedClock
      }
    );

    expect(completeResult.status).toBe('life_incident_completed');
    expect(store.readActiveIncident({
      schema_version: '0.1',
      trace_id: 'trace-completion-due',
      event_id: 'event-completion-due',
      event_type: 'INCIDENT_COMPLETION',
      user_id: 'user-1',
      conversation_id: 'conversation-1'
    })).toBeUndefined();
    const entries = rawLog.query({ trace_id: 'trace-completion-due' }).entries;
    expect(entries.map((entry) => entry.kind)).toEqual(['life_incident_completed']);
    expect(entries[0]?.data).not.toHaveProperty('role_model_result');
    expect(entries[0]?.data).not.toHaveProperty('life_action');
    expect(entries[0]?.data['completion_source']).toBe('incident_completion_event');
  });

  it('routes the completion event through RuntimeAccess without model or visible output', () => {
    const rawLog = new InMemoryRawEventLog();
    const store = new InMemoryLifeIncidentStore({ rawEventLog: rawLog });
    const ids = sequenceIdGenerator();
    const startResult = commitLifeIncidentStart(userMessage(), roleModelStartResult(), {
      lifeIncidentStartFinalizer: store,
      rawEventLog: rawLog,
      idGenerator: ids,
      clock: fixedClock
    });
    if (startResult.status !== 'life_incident_started') {
      throw new Error('expected start to commit');
    }

    const result = runIncidentCompletionEvent(
      incidentCompletionEvent(startResult.started_incident.incident_id),
      {
        activeIncidentSource: store,
        lifeIncidentCompleteFinalizer: store,
        rawEventLog: rawLog,
        idGenerator: ids,
        clock: fixedClock
      }
    );

    expect(result.status).toBe(INCIDENT_COMPLETION_COMMITTED_STATUS);
    if (result.status !== INCIDENT_COMPLETION_COMMITTED_STATUS) {
      throw new Error('expected completion route to commit');
    }
    expect(result.kernel_route).toMatchObject({
      event_type: 'INCIDENT_COMPLETION',
      model_needed: false,
      next_step: 'incident_completion_commit'
    });
    expect(result.incident_complete_result.status).toBe('life_incident_completed');

    const entries = rawLog.query({ trace_id: 'trace-completion-due' }).entries;
    expect(entries.map((entry) => entry.kind)).toEqual([
      'runtime_event_received',
      'runtime_operation_started',
      'life_incident_completed',
      'runtime_operation_completed'
    ]);
    expect(entries[2]?.data).not.toHaveProperty('role_model_result');
    expect(entries[2]?.data).not.toHaveProperty('life_action');
    expect(entries[2]?.data['completion_source']).toBe('incident_completion_event');
  });
});
