import { describe, expect, it } from 'vitest';

import {
  LifeIncidentStartFinalizerError,
  buildLifeIncidentStartCommitRequest,
  commitLifeIncidentStart
} from '../../../src-ts/commit-effects/incident-start.ts';
import { InMemoryRawEventLog } from '../../../src-ts/runtime/logging.ts';

function normalizedUserMessage(): Record<string, unknown> {
  return {
    event_id: 'event-1',
    trace_id: 'trace-1',
    type: 'USER_MESSAGE',
    created_at: '2026-05-19T08:59:00+00:00',
    schema_version: '0.1',
    payload: {
      text: 'hello',
      user_id: 'user-1',
      conversation_id: 'conversation-1'
    }
  };
}

function roleModelResultWithIncident(): Record<string, unknown> {
  return {
    trace_id: 'trace-1',
    event_id: 'event-1',
    event_type: 'USER_MESSAGE',
    model_called: true,
    status: 'decision_ready_for_commit',
    decision: {
      schema_version: '0.1',
      trace_id: 'trace-1',
      event_id: 'event-1',
      action: 'visible_reply',
      visible_reply: { text: 'hello back' },
      life_action: {
        type: 'start_incident',
        incident: {
          type: 'think',
          title: ' Thinking ',
          remaining_seconds: 300,
          interrupt_policy: 'interruptible',
          resume_policy: 'ask_model'
        }
      }
    }
  };
}

describe('life incident start commit effects', () => {
  it('builds a start commit request without model-authored committed fields', () => {
    const request = buildLifeIncidentStartCommitRequest(
      normalizedUserMessage(),
      roleModelResultWithIncident()
    );

    expect(request).toEqual({
      schema_version: '0.1',
      trace_id: 'trace-1',
      event_id: 'event-1',
      event_type: 'USER_MESSAGE',
      decision_action: 'visible_reply',
      life_action_type: 'start_incident',
      draft: {
        type: 'think',
        title: 'Thinking',
        remaining_seconds: 300,
        interrupt_policy: 'interruptible',
        resume_policy: 'ask_model'
      },
      user_id: 'user-1',
      conversation_id: 'conversation-1'
    });
  });

  it('keeps visible success when post-visible completion fails', () => {
    const rawLog = new InMemoryRawEventLog();
    const completionRequests: unknown[] = [];
    const finalizer = {
      requireRawEventLog(candidateRawLog: unknown): void {
        if (candidateRawLog !== rawLog) {
          throw new LifeIncidentStartFinalizerError('Raw Event Log mismatch.', {
            code: 'malformed_finalize_result'
          });
        }
      },
      finalizeLifeIncidentStart(request: {
        committed_log_entry: Parameters<InMemoryRawEventLog['exposeCommittedSuccessEntry']>[0];
        trace_id: string;
        event_id: string;
        event_type: 'USER_MESSAGE';
      }): Record<string, string> {
        rawLog.exposeCommittedSuccessEntry(request.committed_log_entry);
        return {
          schema_version: '0.1',
          trace_id: request.trace_id,
          event_id: request.event_id,
          event_type: request.event_type,
          committed_log_entry_id: request.committed_log_entry.log_id
        };
      },
      completeLifeIncidentStartAfterLogVisible(request: unknown): void {
        completionRequests.push(structuredClone(request));
        throw new LifeIncidentStartFinalizerError('post-visible completion failed', {
          code: 'finalize_rejected'
        });
      }
    };

    const result = commitLifeIncidentStart(
      normalizedUserMessage(),
      roleModelResultWithIncident(),
      {
        lifeIncidentStartFinalizer: finalizer,
        rawEventLog: rawLog,
        idGenerator: (kind) => `${kind}-generated`,
        clock: () => new Date('2026-05-19T09:00:00Z')
      }
    );

    const entries = rawLog.query({ trace_id: 'trace-1' }).entries;
    expect(result.status).toBe('life_incident_started');
    if (result.status !== 'life_incident_started') {
      throw new Error('expected start commit to succeed');
    }
    expect(result.committed_log_entry_id).toBe(entries[0]?.log_id);
    expect(completionRequests).toHaveLength(1);
    expect(entries.map((entry) => entry.kind)).toEqual(['life_incident_started']);
  });

  it('propagates unexpected finalizer failures without rejected lifecycle logs', () => {
    const rawLog = new InMemoryRawEventLog();
    const finalizer = {
      finalizeLifeIncidentStart(): never {
        throw new Error('storage unavailable');
      }
    };

    expect(() => {
      commitLifeIncidentStart(
        normalizedUserMessage(),
        roleModelResultWithIncident(),
        {
          lifeIncidentStartFinalizer: finalizer,
          rawEventLog: rawLog,
          idGenerator: (kind) => `${kind}-generated`,
          clock: () => new Date('2026-05-19T09:00:00Z')
        }
      );
    }).toThrow('storage unavailable');
    expect(rawLog.query({ trace_id: 'trace-1' }).entries).toEqual([]);
  });
});
