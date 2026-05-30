import { describe, expect, it } from 'vitest';

import { InMemoryLifeIncidentStore } from '../../../../src/character/state/incidents.ts';
import { InMemoryRawEventLog, type RawEventLogEntry } from '../../../../src/runtime/logging.ts';
import {
  LifeIncidentStartFinalizerError,
  buildStartedLifeIncidentSnapshot,
  buildLifeIncidentStartFinalizeRequest,
  buildLifeIncidentStartedLogEntry,
  commitLifeIncidentStart
} from '../../../../src/commit-effects/incident-start.ts';
import { commitLifeIncidentInterruption } from '../../../../src/commit-effects/incident-interrupt.ts';

function normalizedUserMessage(): Record<string, unknown> {
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

function roleModelResultWithStart(): Record<string, unknown> {
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
      visible_reply: { text: 'hello back' },
      life_action: {
        type: 'start_incident',
        incident: {
          type: 'think',
          title: 'Plan',
          interrupt_policy: 'interruptible',
          resume_policy: 'ask_model'
        }
      }
    }
  };
}

describe('InMemoryLifeIncidentStore', () => {
  it('finalizes a start and returns defensive active incident reads by scope', () => {
    const rawLog = new InMemoryRawEventLog();
    const store = new InMemoryLifeIncidentStore({ rawEventLog: rawLog });
    const event = normalizedUserMessage();
    const startedIncident = buildStartedLifeIncidentSnapshot(
      event,
      {
        type: 'think',
        title: 'Plan',
        interrupt_policy: 'interruptible',
        resume_policy: 'ask_model'
      },
      {
        commitTime: '2026-05-25T09:00:00+00:00',
        idGenerator: () => 'incident-1'
      }
    );
    const committedLogEntry = buildLifeIncidentStartedLogEntry(
      event,
      roleModelResultWithStart(),
      {
        type: 'think',
        title: 'Plan',
        interrupt_policy: 'interruptible',
        resume_policy: 'ask_model'
      },
      startedIncident,
      {
        idGenerator: () => 'log-1',
        clock: () => new Date('2026-05-25T09:00:00Z')
      }
    );
    const finalizeRequest = buildLifeIncidentStartFinalizeRequest(
      {
        schema_version: '0.1',
        trace_id: 'trace-start',
        event_id: 'event-start',
        event_type: 'USER_MESSAGE',
        decision_action: 'visible_reply',
        life_action_type: 'start_incident',
        draft: {
          type: 'think',
          title: 'Plan',
          interrupt_policy: 'interruptible',
          resume_policy: 'ask_model'
        },
        commit_time: '2026-05-25T09:00:00+00:00',
        user_id: 'user-1',
        conversation_id: 'conversation-1'
      },
      { startedIncident, committedLogEntry }
    );

    const result = store.finalizeLifeIncidentStart(finalizeRequest);
    rawLog.confirmCommittedSuccessEntry(committedLogEntry);
    store.completeLifeIncidentStartAfterLogVisible(finalizeRequest);
    const read = store.readActiveIncident({
      schema_version: '0.1',
      trace_id: 'trace-start',
      event_id: 'event-start',
      event_type: 'USER_MESSAGE',
      user_id: 'user-1',
      conversation_id: 'conversation-1'
    });
    if (read === undefined) {
      throw new Error('expected active incident read');
    }
    read['title'] = 'mutated outside store';

    expect(result.committed_log_entry_id).toBe('log-1');
    expect(
      store.readActiveIncident({
        schema_version: '0.1',
        trace_id: 'trace-start',
        event_id: 'event-start',
        event_type: 'USER_MESSAGE',
        user_id: 'user-1',
        conversation_id: 'conversation-1'
      })
    ).toEqual(startedIncident);
  });

  it('moves active incidents to interrupted storage only after visible success', () => {
    const rawLog = new InMemoryRawEventLog();
    const store = new InMemoryLifeIncidentStore({ rawEventLog: rawLog });
    const startResult = commitLifeIncidentStart(normalizedUserMessage(), roleModelResultWithStart(), {
      lifeIncidentStartFinalizer: store,
      rawEventLog: rawLog,
      idGenerator: () => 'incident-1',
      clock: () => new Date('2026-05-25T09:00:00Z')
    });
    if (startResult.status !== 'life_incident_started') {
      throw new Error('expected start success');
    }

    const interruptResult = commitLifeIncidentInterruption(
      {
        event_id: 'event-interrupt',
        trace_id: 'trace-interrupt',
        type: 'USER_MESSAGE',
        created_at: '2026-05-25T09:01:00+00:00',
        schema_version: '0.1',
        payload: {
          text: 'are you there?',
          user_id: 'user-1',
          conversation_id: 'conversation-1'
        }
      },
      {
        activeIncidentSource: store,
        lifeIncidentInterruptFinalizer: store,
        rawEventLog: rawLog,
        idGenerator: () => 'log-interrupt',
        clock: () => new Date('2026-05-25T09:01:00Z')
      }
    );

    expect(interruptResult.status).toBe('life_incident_interrupted');
    expect(
      store.readActiveIncident({
        schema_version: '0.1',
        trace_id: 'trace-interrupt',
        event_id: 'event-interrupt',
        event_type: 'USER_MESSAGE',
        user_id: 'user-1',
        conversation_id: 'conversation-1'
      })
    ).toBeUndefined();
    const interrupted = store.readInterruptedIncident({
      schema_version: '0.1',
      trace_id: 'trace-interrupt',
      event_id: 'event-interrupt',
      event_type: 'USER_MESSAGE',
      user_id: 'user-1',
      conversation_id: 'conversation-1'
    });
    expect(interrupted).toEqual(
      interruptResult.status === 'life_incident_interrupted'
        ? interruptResult.interrupted_incident
        : undefined
    );
    expect(rawLog.query({ trace_id: 'trace-interrupt' }).entries.map((entry) => entry.kind)).toEqual([
      'life_incident_interrupted'
    ]);
  });

  it('maps malformed direct finalizer requests to malformed_finalize_result', () => {
    const rawLog = new InMemoryRawEventLog();
    const store = new InMemoryLifeIncidentStore({ rawEventLog: rawLog });
    const event = normalizedUserMessage();
    const startedIncident = buildStartedLifeIncidentSnapshot(
      event,
      {
        type: 'think',
        title: 'Plan',
        interrupt_policy: 'interruptible',
        resume_policy: 'ask_model'
      },
      {
        commitTime: '2026-05-25T09:00:00+00:00',
        idGenerator: () => 'incident-1'
      }
    );
    const committedLogEntry = buildLifeIncidentStartedLogEntry(
      event,
      roleModelResultWithStart(),
      {
        type: 'think',
        title: 'Plan',
        interrupt_policy: 'interruptible',
        resume_policy: 'ask_model'
      },
      startedIncident,
      {
        idGenerator: () => 'log-1',
        clock: () => new Date('2026-05-25T09:00:00Z')
      }
    );
    const malformedLogEntry: RawEventLogEntry & { future_field: string } = {
      ...committedLogEntry,
      future_field: 'not allowed'
    };

    expect(() => {
      store.finalizeLifeIncidentStart({
        schema_version: '0.1',
        trace_id: 'trace-start',
        event_id: 'event-start',
        event_type: 'USER_MESSAGE',
        decision_action: 'visible_reply',
        life_action_type: 'start_incident',
        draft: {
          type: 'think',
          title: 'Plan',
          interrupt_policy: 'interruptible',
          resume_policy: 'ask_model'
        },
        commit_time: '2026-05-25T09:00:00+00:00',
        user_id: 'user-1',
        conversation_id: 'conversation-1',
        started_incident: startedIncident,
        committed_log_entry: malformedLogEntry
      });
    }).toThrow(LifeIncidentStartFinalizerError);
    try {
      store.finalizeLifeIncidentStart({
        schema_version: '0.1',
        trace_id: 'trace-start',
        event_id: 'event-start',
        event_type: 'USER_MESSAGE',
        decision_action: 'visible_reply',
        life_action_type: 'start_incident',
        draft: {
          type: 'think',
          title: 'Plan',
          interrupt_policy: 'interruptible',
          resume_policy: 'ask_model'
        },
        commit_time: '2026-05-25T09:00:00+00:00',
        user_id: 'user-1',
        conversation_id: 'conversation-1',
        started_incident: startedIncident,
        committed_log_entry: malformedLogEntry
      });
    } catch (error) {
      expect(error).toBeInstanceOf(LifeIncidentStartFinalizerError);
      expect((error as LifeIncidentStartFinalizerError).code).toBe('malformed_finalize_result');
      return;
    }
    throw new Error('expected finalizer error');
  });

  it('drops null identity fields on store reads to preserve default scope parity', () => {
    const rawLog = new InMemoryRawEventLog();
    const store = new InMemoryLifeIncidentStore({ rawEventLog: rawLog });
    const event = {
      ...normalizedUserMessage(),
      payload: { text: 'start thinking' }
    };
    const startResult = commitLifeIncidentStart(event, roleModelResultWithStart(), {
      lifeIncidentStartFinalizer: store,
      rawEventLog: rawLog,
      idGenerator: () => 'incident-default',
      clock: () => new Date('2026-05-25T09:00:00Z')
    });
    if (startResult.status !== 'life_incident_started') {
      throw new Error('expected start success');
    }

    const readRequest = {
      schema_version: '0.1',
      trace_id: 'trace-start',
      event_id: 'event-start',
      event_type: 'USER_MESSAGE',
      user_id: null,
      conversation_id: null
    } as const;

    expect(store.readActiveIncident(readRequest)).toEqual(startResult.started_incident);
  });
});
