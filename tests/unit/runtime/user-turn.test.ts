import { describe, expect, it } from 'vitest';

import {
  USER_TURN_COMMITTED_STATUS,
  USER_TURN_STOPPED_STATUS,
  runUserMessageTurn
} from '../../../src/runtime/user-turn.ts';
import {
  incidentCancelUserTurnAction,
  incidentCompleteUserTurnAction,
  incidentInterruptUserTurnAction,
  incidentStartUserTurnAction,
  livingStatePatchUserTurnAction,
  userTurnWriteActionRegistry
} from '../../../src/runtime/user-turn-actions.ts';
import {
  type RoleModelAdapter,
  type RoleModelInputEnvelope
} from '../../../src/role-model/loop.ts';
import {
  InMemoryRawEventLog,
  type IdGenerator,
  type RawEventLogEntry
} from '../../../src/runtime/logging.ts';
import type { VisibleConversationRecord } from '../../../src/commit-effects/visible-reply.ts';
import type {
  LivingStatePatchFinalizeRequest,
  LivingStatePatchPrepareRequest
} from '../../../src/commit-effects/living-state.ts';
import { InMemoryLifeIncidentStore } from '../../../src/character/state/incidents.ts';
import type { ActiveIncidentSnapshot } from '../../../src/character/state/current.ts';

class SequenceIdGenerator {
  readonly calls: string[] = [];

  next: IdGenerator = (kind: string): string => {
    this.calls.push(kind);
    return `${kind}-generated-${String(this.calls.length)}`;
  };
}

class RecordingVisibleConversation {
  readonly records: VisibleConversationRecord[] = [];

  append(record: VisibleConversationRecord): void {
    this.records.push(structuredClone(record));
  }

  readVisibleConversationRecords(): VisibleConversationRecord[] {
    return structuredClone(this.records);
  }
}

class FakeRoleModelAdapter implements RoleModelAdapter {
  readonly inputs: RoleModelInputEnvelope[] = [];
  readonly rawText: string;

  constructor(rawText: string) {
    this.rawText = rawText;
  }

  generate(modelInput: RoleModelInputEnvelope): unknown {
    this.inputs.push(structuredClone(modelInput));
    return {
      model_id: 'fake-role-model',
      created_at: '2026-05-30T10:01:00+00:00',
      raw_text: this.rawText
    };
  }
}

class RecordingLivingStatePatchStore {
  readonly requests: LivingStatePatchPrepareRequest[] = [];

  prepareLivingStatePatchCommit(request: LivingStatePatchPrepareRequest): unknown {
    this.requests.push(structuredClone(request));
    return {
      schema_version: '0.1',
      character_id: 'character-1',
      living_state: {
        current_activity: 'writing notes',
        mood: request.patch.living_state.mood,
        toward_user: 'warm'
      },
      updated_at: request.commit_time,
      source_event_ids: ['event-prior', request.event_id]
    };
  }
}

class RawLogExposingLivingStatePatchFinalizer {
  readonly rawLog: InMemoryRawEventLog;
  readonly requests: LivingStatePatchFinalizeRequest[] = [];

  constructor(rawLog: InMemoryRawEventLog) {
    this.rawLog = rawLog;
  }

  finalizeLivingStatePatchCommit(request: LivingStatePatchFinalizeRequest): unknown {
    this.requests.push(structuredClone(request));
    this.rawLog.exposeCommittedSuccessEntry(request.committed_log_entry);
    return {
      schema_version: '0.1',
      trace_id: request.trace_id,
      event_id: request.event_id,
      event_type: request.event_type,
      committed_log_entry_id: request.committed_log_entry.log_id
    };
  }
}

function roleModelResultDecision(entry: RawEventLogEntry | undefined): Record<string, unknown> {
  const roleModelResult = entry?.data['role_model_result'];
  if (!isRecord(roleModelResult)) {
    throw new Error('expected role model result record');
  }
  const decision = roleModelResult['decision'];
  if (!isRecord(decision)) {
    throw new Error('expected role model decision record');
  }
  return decision;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fixedClock(): Date {
  return new Date('2026-05-30T10:01:00.000Z');
}

function normalizedUserMessage({
  eventId = 'event-1',
  traceId = 'trace-1',
  text = 'hello',
  createdAt = '2026-05-30T10:00:00+00:00'
}: {
  eventId?: string;
  traceId?: string;
  text?: string;
  createdAt?: string;
} = {}): Record<string, unknown> {
  return {
    event_id: eventId,
    trace_id: traceId,
    type: 'USER_MESSAGE',
    created_at: createdAt,
    schema_version: '0.1',
    payload: {
      text,
      conversation_id: 'conversation-1'
    }
  };
}

function visibleReplyRaw(text = 'hello back'): string {
  return JSON.stringify({
    schema_version: '0.1',
    action: 'visible_reply',
    visible_reply: { text }
  });
}

function statePatchRaw(): string {
  return JSON.stringify({
    schema_version: '0.1',
    action: 'visible_reply',
    visible_reply: { text: 'hello back' },
    state_patch: {
      living_state: {
        mood: 'attentive'
      }
    }
  });
}

function startIncidentRaw(): string {
  return JSON.stringify({
    schema_version: '0.1',
    action: 'visible_reply',
    visible_reply: { text: 'I will think about it.' },
    life_action: {
      type: 'start_incident',
      incident: {
        type: 'think',
        title: 'Think through the plan',
        remaining_seconds: 300,
        interrupt_policy: 'interruptible',
        resume_policy: 'ask_model'
      }
    }
  });
}

function cancelIncidentRaw(incidentId: string): string {
  return JSON.stringify({
    schema_version: '0.1',
    action: 'visible_reply',
    visible_reply: { text: 'I will stop.' },
    life_action: {
      type: 'cancel_incident',
      incident_id: incidentId,
      reason: 'User asked to stop.'
    }
  });
}

function completeIncidentRaw(incidentId: string): string {
  return JSON.stringify({
    schema_version: '0.1',
    action: 'visible_reply',
    visible_reply: { text: 'That is complete.' },
    life_action: {
      type: 'complete_incident',
      incident_id: incidentId
    }
  });
}

function currentStateSource(): { readCurrentState: () => unknown } {
  return {
    readCurrentState: () => ({
      schema_version: '0.1',
      character_id: 'character-1',
      living_state: {
        current_activity: 'writing notes',
        mood: 'focused',
        toward_user: 'warm'
      },
      updated_at: '2026-05-30T09:59:00+00:00',
      source_event_ids: ['event-prior']
    })
  };
}

function activeIncidentSnapshot({
  incidentId = 'incident-1',
  interruptPolicy = 'interruptible'
}: {
  incidentId?: string;
  interruptPolicy?: ActiveIncidentSnapshot['interrupt_policy'];
} = {}): ActiveIncidentSnapshot {
  return {
    schema_version: '0.1',
    incident_id: incidentId,
    type: 'think',
    status: 'active',
    title: 'Think through the plan',
    started_at: '2026-05-30T09:55:00+00:00',
    remaining_seconds: 300,
    interrupt_policy: interruptPolicy,
    resume_policy: 'ask_model',
    source_event_ids: ['event-existing']
  };
}

function seedActiveIncident({
  rawLog,
  visibleConversation,
  incidentStore,
  ids
}: {
  rawLog: InMemoryRawEventLog;
  visibleConversation: RecordingVisibleConversation;
  incidentStore: InMemoryLifeIncidentStore;
  ids: SequenceIdGenerator;
}): string {
  const firstResult = runUserMessageTurn(
    normalizedUserMessage({ eventId: 'event-existing', traceId: 'trace-existing' }),
    {
      adapter: new FakeRoleModelAdapter(startIncidentRaw()),
      rawEventLog: rawLog,
      visibleConversation,
      idGenerator: ids.next,
      clock: fixedClock,
      writeActions: userTurnWriteActionRegistry(
        incidentStartUserTurnAction({ finalizer: incidentStore })
      )
    }
  );
  if (
    firstResult.status !== USER_TURN_COMMITTED_STATUS ||
    firstResult.life_incident_start_result?.status !== 'life_incident_started'
  ) {
    throw new Error('expected seeded active incident');
  }
  return firstResult.life_incident_start_result.started_incident.incident_id;
}

describe('user message turn orchestration', () => {
  it('commits a complete visible user turn through the public boundary', () => {
    const rawLog = new InMemoryRawEventLog();
    const visibleConversation = new RecordingVisibleConversation();
    const adapter = new FakeRoleModelAdapter(visibleReplyRaw());
    const ids = new SequenceIdGenerator();

    const result = runUserMessageTurn(normalizedUserMessage(), {
      adapter,
      rawEventLog: rawLog,
      visibleConversation,
      idGenerator: ids.next,
      clock: fixedClock
    });

    expect(result.status).toBe(USER_TURN_COMMITTED_STATUS);
    if (result.status !== USER_TURN_COMMITTED_STATUS) {
      throw new Error('expected committed user turn');
    }
    expect(result.visible_record_ids).toEqual({
      user_message_id: 'message-generated-2',
      assistant_output_id: 'output-generated-5'
    });
    expect(visibleConversation.records.map((record) => record.kind)).toEqual([
      'user_visible_message',
      'assistant_visible_reply'
    ]);
    expect(adapter.inputs[0]?.allowed_actions).toEqual(['visible_reply']);
    expect(rawLog.query({ trace_id: 'trace-1' }).entries.map((entry) => entry.kind)).toEqual([
      'runtime_event_received',
      'user_visible_message_committed',
      'role_model_turn_completed',
      'visible_reply_committed'
    ]);
  });

  it('stops conflicting write opt-ins before visible commits or model calls', () => {
    const rawLog = new InMemoryRawEventLog();
    const visibleConversation = new RecordingVisibleConversation();
    const adapter = new FakeRoleModelAdapter(visibleReplyRaw());

    const result = runUserMessageTurn(normalizedUserMessage(), {
      adapter,
      rawEventLog: rawLog,
      visibleConversation,
      idGenerator: new SequenceIdGenerator().next,
      clock: fixedClock,
      writeActions: userTurnWriteActionRegistry(
        livingStatePatchUserTurnAction({
          currentStateSource: {
            readCurrentState: () => ({
              schema_version: '0.1',
              character_id: 'character-1',
              living_state: { mood: 'focused' },
              updated_at: '2026-05-30T09:59:00+00:00',
              source_event_ids: ['event-prior']
            })
          },
          store: {
            prepareLivingStatePatchCommit: () => {
              throw new Error('must not prepare state patch');
            }
          },
          finalizer: {
            finalizeLivingStatePatchCommit: () => {
              throw new Error('must not finalize state patch');
            }
          }
        }),
        incidentStartUserTurnAction({
          finalizer: {
            finalizeLifeIncidentStart: () => {
              throw new Error('must not finalize incident');
            }
          }
        })
      )
    });

    expect(result.status).toBe(USER_TURN_STOPPED_STATUS);
    if (result.status !== USER_TURN_STOPPED_STATUS) {
      throw new Error('expected stopped user turn');
    }
    expect(result.stopped_at).toBe('user_turn_preflight');
    expect(result.failure.code).toBe('conflicting_write_action_opt_in');
    expect(result).not.toHaveProperty('user_visible_message_result');
    expect(result).not.toHaveProperty('role_model_result');
    expect(adapter.inputs).toEqual([]);
    expect(visibleConversation.records).toEqual([]);
    expect(rawLog.query({ trace_id: 'trace-1' }).entries.map((entry) => entry.kind)).toEqual([
      'runtime_event_received'
    ]);
  });

  it('stops incident cancel opt-in without an active incident source before visible commits', () => {
    const rawLog = new InMemoryRawEventLog();
    const visibleConversation = new RecordingVisibleConversation();
    const adapter = new FakeRoleModelAdapter(visibleReplyRaw());

    const result = runUserMessageTurn(normalizedUserMessage(), {
      adapter,
      rawEventLog: rawLog,
      visibleConversation,
      idGenerator: new SequenceIdGenerator().next,
      clock: fixedClock,
      writeActions: userTurnWriteActionRegistry(
        incidentCancelUserTurnAction({
          activeIncidentSource: undefined,
          finalizer: {
            finalizeLifeIncidentCancel: () => {
              throw new Error('must not finalize cancel');
            },
            completeLifeIncidentCancelAfterLogVisible: () => {
              throw new Error('must not complete cancel');
            }
          }
        })
      )
    });

    expect(result.status).toBe(USER_TURN_STOPPED_STATUS);
    if (result.status !== USER_TURN_STOPPED_STATUS) {
      throw new Error('expected stopped user turn');
    }
    expect(result.stopped_at).toBe('user_turn_preflight');
    expect(result.failure.code).toBe('missing_incident_cancel_source');
    expect(result.failure.message).toContain('active_incident_source');
    expect(adapter.inputs).toEqual([]);
    expect(visibleConversation.records).toEqual([]);
    expect(rawLog.query({ trace_id: 'trace-1' }).entries.map((entry) => entry.kind)).toEqual([
      'runtime_event_received'
    ]);
  });

  it('stops incident complete opt-in without an active incident source before visible commits', () => {
    const rawLog = new InMemoryRawEventLog();
    const visibleConversation = new RecordingVisibleConversation();
    const adapter = new FakeRoleModelAdapter(visibleReplyRaw());

    const result = runUserMessageTurn(normalizedUserMessage(), {
      adapter,
      rawEventLog: rawLog,
      visibleConversation,
      idGenerator: new SequenceIdGenerator().next,
      clock: fixedClock,
      writeActions: userTurnWriteActionRegistry(
        incidentCompleteUserTurnAction({
          activeIncidentSource: undefined,
          finalizer: {
            finalizeLifeIncidentComplete: () => {
              throw new Error('must not finalize complete');
            },
            completeLifeIncidentCompleteAfterLogVisible: () => {
              throw new Error('must not complete complete');
            }
          }
        })
      )
    });

    expect(result.status).toBe(USER_TURN_STOPPED_STATUS);
    if (result.status !== USER_TURN_STOPPED_STATUS) {
      throw new Error('expected stopped user turn');
    }
    expect(result.stopped_at).toBe('user_turn_preflight');
    expect(result.failure.code).toBe('missing_incident_complete_source');
    expect(result.failure.message).toContain('active_incident_source');
    expect(adapter.inputs).toEqual([]);
    expect(visibleConversation.records).toEqual([]);
    expect(rawLog.query({ trace_id: 'trace-1' }).entries.map((entry) => entry.kind)).toEqual([
      'runtime_event_received'
    ]);
  });

  it('stops incident interrupt opt-in without an active incident source before visible commits', () => {
    const rawLog = new InMemoryRawEventLog();
    const visibleConversation = new RecordingVisibleConversation();
    const adapter = new FakeRoleModelAdapter(visibleReplyRaw());

    const result = runUserMessageTurn(normalizedUserMessage(), {
      adapter,
      rawEventLog: rawLog,
      visibleConversation,
      idGenerator: new SequenceIdGenerator().next,
      clock: fixedClock,
      writeActions: userTurnWriteActionRegistry(
        incidentInterruptUserTurnAction({
          activeIncidentSource: undefined,
          finalizer: {
            finalizeLifeIncidentInterrupt: () => {
              throw new Error('must not finalize interrupt');
            },
            completeLifeIncidentInterruptAfterLogVisible: () => {
              throw new Error('must not complete interrupt');
            }
          }
        })
      )
    });

    expect(result.status).toBe(USER_TURN_STOPPED_STATUS);
    if (result.status !== USER_TURN_STOPPED_STATUS) {
      throw new Error('expected stopped user turn');
    }
    expect(result.stopped_at).toBe('user_turn_preflight');
    expect(result.failure.code).toBe('missing_incident_interrupt_source');
    expect(result.failure.message).toContain('active_incident_source');
    expect(adapter.inputs).toEqual([]);
    expect(visibleConversation.records).toEqual([]);
    expect(rawLog.query({ trace_id: 'trace-1' }).entries.map((entry) => entry.kind)).toEqual([
      'runtime_event_received'
    ]);
  });

  it('commits an opted-in living-state patch before the visible reply projection', () => {
    const rawLog = new InMemoryRawEventLog();
    const visibleConversation = new RecordingVisibleConversation();
    const adapter = new FakeRoleModelAdapter(statePatchRaw());
    const store = new RecordingLivingStatePatchStore();
    const finalizer = new RawLogExposingLivingStatePatchFinalizer(rawLog);

    const result = runUserMessageTurn(normalizedUserMessage(), {
      adapter,
      rawEventLog: rawLog,
      visibleConversation,
      idGenerator: new SequenceIdGenerator().next,
      clock: fixedClock,
      writeActions: userTurnWriteActionRegistry(
        livingStatePatchUserTurnAction({
          currentStateSource: currentStateSource(),
          store,
          finalizer
        })
      )
    });

    expect(result.status).toBe(USER_TURN_COMMITTED_STATUS);
    if (result.status !== USER_TURN_COMMITTED_STATUS) {
      throw new Error('expected committed user turn');
    }
    expect(adapter.inputs[0]?.allowed_actions).toEqual(['visible_reply', 'state_patch']);
    expect(result.role_model_result.decision).toHaveProperty('state_patch');
    expect(result.living_state_patch_result?.status).toBe('living_state_patch_committed');
    expect(store.requests).toHaveLength(1);
    expect(finalizer.requests).toHaveLength(1);
    const entries = rawLog.query({ trace_id: 'trace-1' }).entries;
    expect(entries.map((entry) => entry.kind)).toEqual([
      'runtime_event_received',
      'user_visible_message_committed',
      'role_model_turn_completed',
      'living_state_patch_committed',
      'visible_reply_committed'
    ]);
    expect(entries.at(-1)?.data['role_model_result']).toMatchObject({
      decision: {
        action: 'visible_reply',
        visible_reply: { text: 'hello back' }
      }
    });
    expect(roleModelResultDecision(entries.at(-1))).not.toHaveProperty('state_patch');
  });

  it('stops before assistant visible reply when living-state patch commit rejects', () => {
    const rawLog = new InMemoryRawEventLog();
    const visibleConversation = new RecordingVisibleConversation();

    const result = runUserMessageTurn(normalizedUserMessage(), {
      adapter: new FakeRoleModelAdapter(statePatchRaw()),
      rawEventLog: rawLog,
      visibleConversation,
      idGenerator: new SequenceIdGenerator().next,
      clock: fixedClock,
      writeActions: userTurnWriteActionRegistry(
        livingStatePatchUserTurnAction({
          currentStateSource: currentStateSource(),
          store: {
            prepareLivingStatePatchCommit: (request) => ({
              schema_version: '0.1',
              character_id: 'character-1',
              living_state: {
                current_activity: 'writing notes',
                mood: 'wrong-mood',
                toward_user: 'warm'
              },
              updated_at: request.commit_time,
              source_event_ids: ['event-prior', request.event_id]
            })
          },
          finalizer: {
            finalizeLivingStatePatchCommit: () => {
              throw new Error('must not finalize rejected state patch');
            }
          }
        })
      )
    });

    expect(result.status).toBe(USER_TURN_STOPPED_STATUS);
    if (result.status !== USER_TURN_STOPPED_STATUS) {
      throw new Error('expected stopped user turn');
    }
    expect(result.stopped_at).toBe('living_state_patch_commit');
    expect(result.living_state_patch_result?.status).toBe('living_state_patch_rejected');
    expect(visibleConversation.records.map((record) => record.kind)).toEqual([
      'user_visible_message'
    ]);
    expect(rawLog.query({ trace_id: 'trace-1' }).entries.map((entry) => entry.kind)).toEqual([
      'runtime_event_received',
      'user_visible_message_committed',
      'role_model_turn_completed',
      'living_state_patch_rejected'
    ]);
  });

  it('commits an opted-in incident start before the visible reply projection', () => {
    const rawLog = new InMemoryRawEventLog();
    const visibleConversation = new RecordingVisibleConversation();
    const adapter = new FakeRoleModelAdapter(startIncidentRaw());
    const incidentStore = new InMemoryLifeIncidentStore({ rawEventLog: rawLog });

    const result = runUserMessageTurn(normalizedUserMessage(), {
      adapter,
      rawEventLog: rawLog,
      visibleConversation,
      idGenerator: new SequenceIdGenerator().next,
      clock: fixedClock,
      writeActions: userTurnWriteActionRegistry(
        incidentStartUserTurnAction({ finalizer: incidentStore })
      )
    });

    expect(result.status).toBe(USER_TURN_COMMITTED_STATUS);
    if (result.status !== USER_TURN_COMMITTED_STATUS) {
      throw new Error('expected committed user turn');
    }
    expect(adapter.inputs[0]?.allowed_actions).toEqual(['visible_reply', 'life_action']);
    expect(adapter.inputs[0]?.allowed_life_action_type).toBe('start_incident');
    expect(result.life_incident_start_result?.status).toBe('life_incident_started');
    const entries = rawLog.query({ trace_id: 'trace-1' }).entries;
    expect(entries.map((entry) => entry.kind)).toEqual([
      'runtime_event_received',
      'user_visible_message_committed',
      'role_model_turn_completed',
      'life_incident_started',
      'visible_reply_committed'
    ]);
    expect(roleModelResultDecision(entries.at(-1))).not.toHaveProperty('life_action');
  });

  it('stops before assistant visible reply when incident start is rejected', () => {
    const rawLog = new InMemoryRawEventLog();
    const visibleConversation = new RecordingVisibleConversation();
    const incidentStore = new InMemoryLifeIncidentStore({ rawEventLog: rawLog });
    const ids = new SequenceIdGenerator();

    seedActiveIncident({ rawLog, visibleConversation, incidentStore, ids });

    const secondResult = runUserMessageTurn(
      normalizedUserMessage({
        eventId: 'event-2',
        traceId: 'trace-2',
        createdAt: '2026-05-30T10:01:30+00:00'
      }),
      {
        adapter: new FakeRoleModelAdapter(startIncidentRaw()),
        rawEventLog: rawLog,
        visibleConversation,
        idGenerator: ids.next,
        clock: () => new Date('2026-05-30T10:02:00.000Z'),
        writeActions: userTurnWriteActionRegistry(
          incidentStartUserTurnAction({ finalizer: incidentStore })
        )
      }
    );

    expect(secondResult.status).toBe(USER_TURN_STOPPED_STATUS);
    if (secondResult.status !== USER_TURN_STOPPED_STATUS) {
      throw new Error('expected stopped user turn');
    }
    expect(secondResult.stopped_at).toBe('life_incident_start_commit');
    expect(secondResult.life_incident_start_result?.status).toBe('life_incident_start_rejected');
    expect(visibleConversation.records.map((record) => record.kind)).toEqual([
      'user_visible_message',
      'assistant_visible_reply',
      'user_visible_message'
    ]);
    expect(rawLog.query({ trace_id: 'trace-2' }).entries.map((entry) => entry.kind)).toEqual([
      'runtime_event_received',
      'user_visible_message_committed',
      'role_model_turn_completed',
      'life_incident_start_rejected'
    ]);
  });

  it('commits an interrupt before the role-model context and exposes interrupted context', () => {
    const rawLog = new InMemoryRawEventLog();
    const visibleConversation = new RecordingVisibleConversation();
    const incidentStore = new InMemoryLifeIncidentStore({ rawEventLog: rawLog });
    const ids = new SequenceIdGenerator();

    seedActiveIncident({ rawLog, visibleConversation, incidentStore, ids });

    const adapter = new FakeRoleModelAdapter(visibleReplyRaw('I am here.'));
    const interruptResult = runUserMessageTurn(
      normalizedUserMessage({
        eventId: 'event-2',
        traceId: 'trace-2',
        text: 'are you there?',
        createdAt: '2026-05-30T10:01:30+00:00'
      }),
      {
        adapter,
        rawEventLog: rawLog,
        visibleConversation,
        idGenerator: ids.next,
        clock: () => new Date('2026-05-30T10:02:00.000Z'),
        writeActions: userTurnWriteActionRegistry(
          incidentInterruptUserTurnAction({
            activeIncidentSource: incidentStore,
            finalizer: incidentStore
          })
        )
      }
    );

    expect(interruptResult.status).toBe(USER_TURN_COMMITTED_STATUS);
    if (interruptResult.status !== USER_TURN_COMMITTED_STATUS) {
      throw new Error('expected committed user turn');
    }
    expect(interruptResult.life_incident_interrupt_result?.status).toBe(
      'life_incident_interrupted'
    );
    const characterSnapshot = adapter.inputs[0]?.decision_context.character_snapshot;
    expect(characterSnapshot).toHaveProperty('interrupted_incident');
    expect(characterSnapshot).not.toHaveProperty('active_incident');
    expect(rawLog.query({ trace_id: 'trace-2' }).entries.map((entry) => entry.kind)).toEqual([
      'runtime_event_received',
      'user_visible_message_committed',
      'life_incident_interrupted',
      'role_model_turn_completed',
      'visible_reply_committed'
    ]);
  });

  it('commits an opted-in incident cancel before the visible reply projection', () => {
    const rawLog = new InMemoryRawEventLog();
    const visibleConversation = new RecordingVisibleConversation();
    const incidentStore = new InMemoryLifeIncidentStore({ rawEventLog: rawLog });
    const ids = new SequenceIdGenerator();
    const incidentId = seedActiveIncident({ rawLog, visibleConversation, incidentStore, ids });

    const result = runUserMessageTurn(
      normalizedUserMessage({
        eventId: 'event-2',
        traceId: 'trace-2',
        createdAt: '2026-05-30T10:01:30+00:00'
      }),
      {
        adapter: new FakeRoleModelAdapter(cancelIncidentRaw(incidentId)),
        rawEventLog: rawLog,
        visibleConversation,
        idGenerator: ids.next,
        clock: () => new Date('2026-05-30T10:02:00.000Z'),
        writeActions: userTurnWriteActionRegistry(
          incidentCancelUserTurnAction({
            activeIncidentSource: incidentStore,
            finalizer: incidentStore
          })
        )
      }
    );

    expect(result.status).toBe(USER_TURN_COMMITTED_STATUS);
    if (result.status !== USER_TURN_COMMITTED_STATUS) {
      throw new Error('expected committed user turn');
    }
    expect(result.life_incident_cancel_result?.status).toBe('life_incident_cancelled');
    expect(rawLog.query({ trace_id: 'trace-2' }).entries.map((entry) => entry.kind)).toEqual([
      'runtime_event_received',
      'user_visible_message_committed',
      'role_model_turn_completed',
      'life_incident_cancelled',
      'visible_reply_committed'
    ]);
  });

  it('stops before assistant visible reply when incident cancel is rejected', () => {
    const rawLog = new InMemoryRawEventLog();
    const visibleConversation = new RecordingVisibleConversation();
    const incidentStore = new InMemoryLifeIncidentStore({ rawEventLog: rawLog });
    const ids = new SequenceIdGenerator();
    seedActiveIncident({ rawLog, visibleConversation, incidentStore, ids });

    const result = runUserMessageTurn(
      normalizedUserMessage({
        eventId: 'event-2',
        traceId: 'trace-2',
        createdAt: '2026-05-30T10:01:30+00:00'
      }),
      {
        adapter: new FakeRoleModelAdapter(cancelIncidentRaw('incident-mismatch')),
        rawEventLog: rawLog,
        visibleConversation,
        idGenerator: ids.next,
        clock: () => new Date('2026-05-30T10:02:00.000Z'),
        writeActions: userTurnWriteActionRegistry(
          incidentCancelUserTurnAction({
            activeIncidentSource: incidentStore,
            finalizer: incidentStore
          })
        )
      }
    );

    expect(result.status).toBe(USER_TURN_STOPPED_STATUS);
    if (result.status !== USER_TURN_STOPPED_STATUS) {
      throw new Error('expected stopped user turn');
    }
    expect(result.stopped_at).toBe('life_incident_cancel_commit');
    expect(result.life_incident_cancel_result?.status).toBe('life_incident_cancel_rejected');
    expect(rawLog.query({ trace_id: 'trace-2' }).entries.map((entry) => entry.kind)).toEqual([
      'runtime_event_received',
      'user_visible_message_committed',
      'role_model_turn_completed',
      'life_incident_cancel_rejected'
    ]);
  });

  it('commits an opted-in incident complete before the visible reply projection', () => {
    const rawLog = new InMemoryRawEventLog();
    const visibleConversation = new RecordingVisibleConversation();
    const incidentStore = new InMemoryLifeIncidentStore({ rawEventLog: rawLog });
    const ids = new SequenceIdGenerator();
    const incidentId = seedActiveIncident({ rawLog, visibleConversation, incidentStore, ids });

    const result = runUserMessageTurn(
      normalizedUserMessage({
        eventId: 'event-2',
        traceId: 'trace-2',
        createdAt: '2026-05-30T10:01:30+00:00'
      }),
      {
        adapter: new FakeRoleModelAdapter(completeIncidentRaw(incidentId)),
        rawEventLog: rawLog,
        visibleConversation,
        idGenerator: ids.next,
        clock: () => new Date('2026-05-30T10:02:00.000Z'),
        writeActions: userTurnWriteActionRegistry(
          incidentCompleteUserTurnAction({
            activeIncidentSource: incidentStore,
            finalizer: incidentStore
          })
        )
      }
    );

    expect(result.status).toBe(USER_TURN_COMMITTED_STATUS);
    if (result.status !== USER_TURN_COMMITTED_STATUS) {
      throw new Error('expected committed user turn');
    }
    expect(result.life_incident_complete_result?.status).toBe('life_incident_completed');
    expect(rawLog.query({ trace_id: 'trace-2' }).entries.map((entry) => entry.kind)).toEqual([
      'runtime_event_received',
      'user_visible_message_committed',
      'role_model_turn_completed',
      'life_incident_completed',
      'visible_reply_committed'
    ]);
  });

  it('stops before assistant visible reply when incident complete is rejected', () => {
    const rawLog = new InMemoryRawEventLog();
    const visibleConversation = new RecordingVisibleConversation();
    const incidentStore = new InMemoryLifeIncidentStore({ rawEventLog: rawLog });
    const ids = new SequenceIdGenerator();
    seedActiveIncident({ rawLog, visibleConversation, incidentStore, ids });

    const result = runUserMessageTurn(
      normalizedUserMessage({
        eventId: 'event-2',
        traceId: 'trace-2',
        createdAt: '2026-05-30T10:01:30+00:00'
      }),
      {
        adapter: new FakeRoleModelAdapter(completeIncidentRaw('incident-mismatch')),
        rawEventLog: rawLog,
        visibleConversation,
        idGenerator: ids.next,
        clock: () => new Date('2026-05-30T10:02:00.000Z'),
        writeActions: userTurnWriteActionRegistry(
          incidentCompleteUserTurnAction({
            activeIncidentSource: incidentStore,
            finalizer: incidentStore
          })
        )
      }
    );

    expect(result.status).toBe(USER_TURN_STOPPED_STATUS);
    if (result.status !== USER_TURN_STOPPED_STATUS) {
      throw new Error('expected stopped user turn');
    }
    expect(result.stopped_at).toBe('life_incident_complete_commit');
    expect(result.life_incident_complete_result?.status).toBe('life_incident_complete_rejected');
    expect(rawLog.query({ trace_id: 'trace-2' }).entries.map((entry) => entry.kind)).toEqual([
      'runtime_event_received',
      'user_visible_message_committed',
      'role_model_turn_completed',
      'life_incident_complete_rejected'
    ]);
  });

  it('stops before the role model when incident interruption is rejected', () => {
    const rawLog = new InMemoryRawEventLog();
    const visibleConversation = new RecordingVisibleConversation();
    const adapter = new FakeRoleModelAdapter(visibleReplyRaw('I am here.'));

    const result = runUserMessageTurn(normalizedUserMessage(), {
      adapter,
      rawEventLog: rawLog,
      visibleConversation,
      idGenerator: new SequenceIdGenerator().next,
      clock: fixedClock,
      writeActions: userTurnWriteActionRegistry(
        incidentInterruptUserTurnAction({
          activeIncidentSource: {
            readActiveIncident: () => {
              throw new Error('incident source unavailable');
            }
          },
          finalizer: {
            finalizeLifeIncidentInterrupt: () => {
              throw new Error('must not finalize interrupt');
            },
            completeLifeIncidentInterruptAfterLogVisible: () => {
              throw new Error('must not complete interrupt');
            }
          }
        })
      )
    });

    expect(result.status).toBe(USER_TURN_STOPPED_STATUS);
    if (result.status !== USER_TURN_STOPPED_STATUS) {
      throw new Error('expected stopped user turn');
    }
    expect(result.stopped_at).toBe('life_incident_interrupt_commit');
    expect(result.life_incident_interrupt_result?.status).toBe('life_incident_interrupt_rejected');
    expect(adapter.inputs).toEqual([]);
    expect(rawLog.query({ trace_id: 'trace-1' }).entries.map((entry) => entry.kind)).toEqual([
      'runtime_event_received',
      'user_visible_message_committed',
      'life_incident_interrupt_rejected'
    ]);
  });

  it.each([
    {
      policy: 'background' as const,
      status: 'life_incident_continued_in_background',
      rawKind: 'life_incident_continued_in_background',
      hasActive: true,
      hasInterrupted: false
    },
    {
      policy: 'protected' as const,
      status: 'life_incident_protected_from_interruption',
      rawKind: 'life_incident_protected_from_interruption',
      hasActive: true,
      hasInterrupted: false
    },
    {
      policy: undefined,
      status: 'life_incident_interrupt_skipped',
      rawKind: undefined,
      hasActive: false,
      hasInterrupted: false
    }
  ])(
    'sets role-model incident context for interrupt outcome $status',
    ({ policy, status, rawKind, hasActive, hasInterrupted }) => {
      const rawLog = new InMemoryRawEventLog();
      const visibleConversation = new RecordingVisibleConversation();
      const adapter = new FakeRoleModelAdapter(visibleReplyRaw('I am here.'));

      const result = runUserMessageTurn(normalizedUserMessage(), {
        adapter,
        rawEventLog: rawLog,
        visibleConversation,
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock,
        writeActions: userTurnWriteActionRegistry(
          incidentInterruptUserTurnAction({
            activeIncidentSource: {
              readActiveIncident: () =>
                policy === undefined
                  ? undefined
                  : activeIncidentSnapshot({ interruptPolicy: policy })
            },
            finalizer: {
              finalizeLifeIncidentInterrupt: () => {
                throw new Error('must not finalize policy interrupt');
              },
              completeLifeIncidentInterruptAfterLogVisible: () => {
                throw new Error('must not complete policy interrupt');
              }
            }
          })
        )
      });

      expect(result.status).toBe(USER_TURN_COMMITTED_STATUS);
      if (result.status !== USER_TURN_COMMITTED_STATUS) {
        throw new Error('expected committed user turn');
      }
      expect(result.life_incident_interrupt_result?.status).toBe(status);
      const characterSnapshot = adapter.inputs[0]?.decision_context.character_snapshot;
      expect(Object.hasOwn(characterSnapshot ?? {}, 'active_incident')).toBe(hasActive);
      expect(Object.hasOwn(characterSnapshot ?? {}, 'interrupted_incident')).toBe(
        hasInterrupted
      );
      const expectedKinds = [
        'runtime_event_received',
        'user_visible_message_committed',
        ...(rawKind === undefined ? [] : [rawKind]),
        'role_model_turn_completed',
        'visible_reply_committed'
      ];
      expect(rawLog.query({ trace_id: 'trace-1' }).entries.map((entry) => entry.kind)).toEqual(
        expectedKinds
      );
    }
  );
});
