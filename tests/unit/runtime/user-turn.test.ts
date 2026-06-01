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
  type UserTurnWriteActionModule,
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
import {
  RUNTIME_OPERATION_COMPLETED_KIND,
  RUNTIME_OPERATION_REJECTED_KIND
} from '../../../src/runtime/operation-registry.ts';

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

class FailOnceOnCompletedOperationAuditRawEventLog extends InMemoryRawEventLog {
  readonly op: string;
  #failed = false;

  constructor(op: string) {
    super();
    this.op = op;
  }

  override append(entry: RawEventLogEntry): void {
    if (
      !this.#failed &&
      entry.kind === RUNTIME_OPERATION_COMPLETED_KIND &&
      entry.data['op'] === this.op
    ) {
      this.#failed = true;
      throw new Error(`failed ${this.op} completed audit`);
    }
    super.append(entry);
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

function domainEntries(
  rawLog: InMemoryRawEventLog,
  traceId = 'trace-1'
): RawEventLogEntry[] {
  return rawLog
    .query({ trace_id: traceId })
    .entries.filter((entry) => !entry.kind.startsWith('runtime_operation_'));
}

function domainLogKinds(rawLog: InMemoryRawEventLog, traceId = 'trace-1'): string[] {
  return domainEntries(rawLog, traceId).map((entry) => entry.kind);
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
      user_message_id: visibleConversation.records[0]?.['message_id'],
      assistant_output_id: visibleConversation.records[1]?.['output_id']
    });
    expect(visibleConversation.records.map((record) => record.kind)).toEqual([
      'user_visible_message',
      'assistant_visible_reply'
    ]);
    expect(adapter.inputs[0]?.allowed_actions).toEqual(['visible_reply']);
    expect(domainLogKinds(rawLog)).toEqual([
      'runtime_event_received',
      'user_visible_message_committed',
      'role_model_turn_completed',
      'visible_reply_committed'
    ]);
  });

  it('does not stop or retry after a visible commit succeeds but its completed audit fails', () => {
    const rawLog = new FailOnceOnCompletedOperationAuditRawEventLog(
      'visible_conversation.commit_user_message'
    );
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
    expect(visibleConversation.records.map((record) => record.kind)).toEqual([
      'user_visible_message',
      'assistant_visible_reply'
    ]);
    expect(domainLogKinds(rawLog)).toEqual([
      'runtime_event_received',
      'user_visible_message_committed',
      'role_model_turn_completed',
      'visible_reply_committed'
    ]);
    const completedOps = rawLog
      .query({ trace_id: 'trace-1', kinds: [RUNTIME_OPERATION_COMPLETED_KIND] })
      .entries.map((entry) => entry.data['op']);
    expect(completedOps).not.toContain('visible_conversation.commit_user_message');
    expect(completedOps).toContain('visible_conversation.commit_visible_reply');
  });

  it('passes current state into visible-only turns without enabling state patches', () => {
    const rawLog = new InMemoryRawEventLog();
    const visibleConversation = new RecordingVisibleConversation();
    const adapter = new FakeRoleModelAdapter(visibleReplyRaw());
    const ids = new SequenceIdGenerator();

    const result = runUserMessageTurn(normalizedUserMessage(), {
      adapter,
      rawEventLog: rawLog,
      visibleConversation,
      idGenerator: ids.next,
      clock: fixedClock,
      currentStateSource: currentStateSource()
    });

    expect(result.status).toBe(USER_TURN_COMMITTED_STATUS);
    if (result.status !== USER_TURN_COMMITTED_STATUS) {
      throw new Error('expected committed user turn');
    }
    expect(adapter.inputs[0]?.allowed_actions).toEqual(['visible_reply']);
    expect(adapter.inputs[0]).not.toHaveProperty('allowed_life_action_type');
    expect(result).not.toHaveProperty('living_state_patch_result');
    expect(adapter.inputs[0]?.decision_context.character_snapshot.living_state_brief).toEqual({
      character_id: 'character-1',
      current_activity: 'writing notes',
      mood: 'focused',
      toward_user: 'warm',
      updated_at: '2026-05-30T09:59:00+00:00',
      source_event_ids: ['event-prior']
    });
    expect(domainLogKinds(rawLog)).toEqual([
      'runtime_event_received',
      'user_visible_message_committed',
      'role_model_turn_completed',
      'visible_reply_committed'
    ]);
  });

  it('routes recent-message reads and context sections through registry operations', () => {
    const rawLog = new InMemoryRawEventLog();
    const visibleConversation = new RecordingVisibleConversation();
    visibleConversation.records.push({
      schema_version: '0.1',
      message_id: 'message-prior',
      trace_id: 'trace-prior',
      source_event_id: 'event-prior',
      kind: 'user_visible_message',
      role: 'user',
      conversation_id: 'conversation-1',
      created_at: '2026-05-30T09:59:00+00:00',
      text: 'prior hello',
      source: {
        runtime_event_type: 'USER_MESSAGE'
      }
    });
    const adapter = new FakeRoleModelAdapter(visibleReplyRaw());
    const ids = new SequenceIdGenerator();

    const result = runUserMessageTurn(normalizedUserMessage(), {
      adapter,
      rawEventLog: rawLog,
      visibleConversation,
      idGenerator: ids.next,
      clock: fixedClock,
      runtimeComponents: [
        {
          id: 'memory_context',
          version: '0.1',
          enabled: true,
          contextSectionProviders: [
            {
              id: 'test.context_section',
              buildDecisionContextSections: (request) => [
                {
                  schema_version: '0.1',
                  section_id: 'section-1',
                  section_type: 'test_context',
                  content: {
                    event_id: request.event_id
                  },
                  source_event_ids: [request.event_id]
                }
              ]
            }
          ]
        }
      ]
    });

    expect(result.status).toBe(USER_TURN_COMMITTED_STATUS);
    if (result.status !== USER_TURN_COMMITTED_STATUS) {
      throw new Error('expected committed user turn');
    }
    expect(
      adapter.inputs[0]?.decision_context.character_snapshot.recent_visible_messages
    ).toEqual([
      {
        schema_version: '0.1',
        message_id: 'message-prior',
        trace_id: 'trace-prior',
        source_event_id: 'event-prior',
        conversation_id: 'conversation-1',
        role: 'user',
        created_at: '2026-05-30T09:59:00+00:00',
        text: 'prior hello'
      }
    ]);
    expect(adapter.inputs[0]?.decision_context.context_sections).toEqual([
      {
        schema_version: '0.1',
        section_id: 'section-1',
        section_type: 'test_context',
        content: {
          event_id: 'event-1'
        },
        source_event_ids: ['event-1']
      }
    ]);
    const completedOps = rawLog
      .query({ trace_id: 'trace-1' })
      .entries.filter((entry) => entry.kind === RUNTIME_OPERATION_COMPLETED_KIND)
      .map((entry) => entry.data['op']);
    expect(completedOps).toContain('visible_conversation.read_recent_messages');
    expect(completedOps).toContain('character_context.build_sections');
  });

  it('rejects malformed runtime-component context section output before model calls', () => {
    const rawLog = new InMemoryRawEventLog();
    const visibleConversation = new RecordingVisibleConversation();
    const adapter = new FakeRoleModelAdapter(visibleReplyRaw());

    const result = runUserMessageTurn(normalizedUserMessage(), {
      adapter,
      rawEventLog: rawLog,
      visibleConversation,
      idGenerator: new SequenceIdGenerator().next,
      clock: fixedClock,
      runtimeComponents: [
        {
          id: 'memory_context',
          version: '0.1',
          enabled: true,
          contextSectionProviders: [
            {
              id: 'test.malformed_context_section',
              buildDecisionContextSections: () => [
                {
                  schema_version: '0.1',
                  section_id: 'section-1',
                  section_type: 'test_context',
                  source_event_ids: ['event-1']
                }
              ]
            }
          ]
        }
      ]
    });

    expect(result.status).toBe(USER_TURN_STOPPED_STATUS);
    if (result.status !== USER_TURN_STOPPED_STATUS) {
      throw new Error('expected stopped user turn');
    }
    expect(result.stopped_at).toBe('role_model_run_turn');
    expect(adapter.inputs).toEqual([]);
    const rejectedContextOperation = rawLog
      .query({ trace_id: 'trace-1' })
      .entries.find(
        (entry) =>
          entry.kind === RUNTIME_OPERATION_REJECTED_KIND &&
          entry.data['op'] === 'character_context.build_sections'
      );
    expect(rejectedContextOperation?.data['failure']).toMatchObject({
      stage: 'output_validation',
      code: 'malformed_output'
    });
    expect(domainLogKinds(rawLog)).toEqual([
      'runtime_event_received',
      'user_visible_message_committed'
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
    expect(domainLogKinds(rawLog)).toEqual([
      'runtime_event_received'
    ]);
  });

  it('stops instead of throwing when an action operation returns malformed output', () => {
    const rawLog = new InMemoryRawEventLog();
    const visibleConversation = new RecordingVisibleConversation();
    const adapter = new FakeRoleModelAdapter(visibleReplyRaw());
    const malformedAction: UserTurnWriteActionModule = {
      id: 'malformed_incident_action',
      operation: 'incident.start_from_model',
      phase: 'after_role_model',
      stop: 'malformed_action_commit',
      commit: ({ event }) =>
        ({
          schema_version: '0.1',
          trace_id: event.trace_id,
          event_id: event.event_id,
          event_type: event.type,
          status: 'not_a_registered_status'
        }) as unknown as ReturnType<UserTurnWriteActionModule['commit']>,
      isRejected: () => {
        throw new Error('malformed operation output must stop before action rejection checks');
      },
      failure: () => {
        throw new Error('malformed operation output must not use domain failure');
      },
      resultFields: () => {
        throw new Error('malformed operation output must stop before result projection');
      }
    };

    const result = runUserMessageTurn(normalizedUserMessage(), {
      adapter,
      rawEventLog: rawLog,
      visibleConversation,
      idGenerator: new SequenceIdGenerator().next,
      clock: fixedClock,
      writeActions: userTurnWriteActionRegistry(malformedAction)
    });

    expect(result.status).toBe(USER_TURN_STOPPED_STATUS);
    if (result.status !== USER_TURN_STOPPED_STATUS) {
      throw new Error('expected stopped user turn');
    }
    expect(result.stopped_at).toBe('malformed_action_commit');
    expect(result.failure).toMatchObject({
      stage: 'output_validation',
      code: 'malformed_output'
    });
    expect(result).not.toHaveProperty('visible_reply_result');
    expect(domainLogKinds(rawLog)).toEqual([
      'runtime_event_received',
      'user_visible_message_committed',
      'role_model_turn_completed'
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
    expect(domainLogKinds(rawLog)).toEqual([
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
    expect(domainLogKinds(rawLog)).toEqual([
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
    expect(domainLogKinds(rawLog)).toEqual([
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
    const entries = domainEntries(rawLog);
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
    expect(domainLogKinds(rawLog)).toEqual([
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
    const entries = domainEntries(rawLog);
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
    expect(domainLogKinds(rawLog, 'trace-2')).toEqual([
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
    expect(domainLogKinds(rawLog, 'trace-2')).toEqual([
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
    expect(domainLogKinds(rawLog, 'trace-2')).toEqual([
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
    expect(domainLogKinds(rawLog, 'trace-2')).toEqual([
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
    expect(domainLogKinds(rawLog, 'trace-2')).toEqual([
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
    expect(domainLogKinds(rawLog, 'trace-2')).toEqual([
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
    expect(domainLogKinds(rawLog)).toEqual([
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
      expect(domainLogKinds(rawLog)).toEqual(
        expectedKinds
      );
    }
  );
});
