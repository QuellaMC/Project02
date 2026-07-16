import { describe, expect, it } from 'vitest';

import {
  runtimePluginContractVersion,
  createRuntimePluginTurnEvidenceSnapshot
} from '../src/plugins/types.ts';
import {
  createRuntimeLogStore
} from '../src/runtime/log.ts';
import type {
  ConversationLogRecordInput,
  RawEventLogRecordInput,
  RuntimeTraceEntryInput
} from '../src/runtime/log.ts';
import type {
  RuntimePluginTurnEvidenceSnapshot
} from '../src/plugins/types.ts';
import type {
  RuntimeEventIdentity
} from '../src/core/message-event.ts';

const identity = {
  eventId: 'evt_log_001',
  traceId: 'trace_log_001',
  createdAt: '2026-06-04T00:00:00.000Z'
} as const;

describe('runtime log store', () => {
  it('appends trace entries in order and returns immutable snapshots', () => {
    const store = createRuntimeLogStore();
    const received: RuntimeTraceEntryInput = {
      ...identity,
      step: 'runtime_event_received'
    };
    const started: RuntimeTraceEntryInput = {
      ...identity,
      step: 'runtime_turn_started'
    };

    store.appendTrace(received);
    store.appendTrace(started);
    store.appendRawEvent({
      ...identity,
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE'
    });
    store.appendRawEvent({
      ...identity,
      kind: 'runtime_turn_completed',
      eventType: 'USER_MESSAGE',
      status: 'completed'
    });

    const snapshot = store.traceEntries();

    expect(snapshot).toEqual([received, started]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(
      Reflect.set(snapshot, '0', {
        ...identity,
        step: 'runtime_turn_completed'
      } satisfies RuntimeTraceEntryInput)
    ).toBe(false);
    expect(store.traceEntries()).toEqual([received, started]);
  });

  it('copies raw event records with source event and trace identity', () => {
    const store = createRuntimeLogStore();
    const received: RawEventLogRecordInput = {
      ...identity,
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE',
      payloadSummary: {
        rawInput: ' hello '
      }
    };
    const visibleMessageIds = ['local-session:message-1', 'local-session:message-2'];
    const payloadSummary = {
      normalizedCurrentUserMessage: 'hello'
    };
    const normalized: RawEventLogRecordInput = {
      ...identity,
      kind: 'runtime_event_normalized',
      eventType: 'USER_MESSAGE',
      payloadSummary
    };
    const completed: RawEventLogRecordInput = {
      ...identity,
      kind: 'runtime_turn_completed',
      eventType: 'USER_MESSAGE',
      status: 'completed',
      visibleMessageIds,
      runtimePluginTurnEvidence: createMinimalPluginTurnEvidence(identity)
    };

    store.appendTrace({ ...identity, step: 'runtime_event_received' });
    const receivedRecord = store.appendRawEvent(received);
    const normalizedRecord = store.appendRawEvent(normalized);
    store.appendConversationMessage({
      ...identity,
      id: 'local-session:message-1',
      role: 'user',
      speakerId: 'local-user',
      speakerName: 'You',
      text: 'hello',
      committedAt: '2026-06-04T00:00:01.000Z'
    });
    store.appendConversationMessage({
      ...identity,
      id: 'local-session:message-2',
      role: 'character',
      speakerId: 'mira',
      speakerName: 'Mira',
      text: 'hello back',
      committedAt: '2026-06-04T00:00:02.000Z'
    });
    const appended = store.appendRawEvent(completed);

    visibleMessageIds.push('local-session:message-3');
    payloadSummary.normalizedCurrentUserMessage = 'mutated after append';

    expect(receivedRecord).toEqual(received);
    expect(appended).toEqual({
      ...completed,
      visibleMessageIds: ['local-session:message-1', 'local-session:message-2'],
      runtimePluginTurnEvidence: {
        ...createMinimalPluginTurnEvidence(identity),
        evidence: [
          {
            ...identity,
            kind: 'runtime_plugin_evidence_snapshot',
            pluginId: 'memory.fixture',
            evidenceKind: 'policy',
            status: 'failed',
            summary: 'handler token=[redacted]',
            policyOutcome: 'handler_rejected',
            redactionLabels: ['secret']
          }
        ]
      }
    });
    expect(normalizedRecord.payloadSummary).toEqual({
      normalizedCurrentUserMessage: 'hello'
    });
    expect(Object.isFrozen(appended)).toBe(true);
    expect(Object.isFrozen(appended.visibleMessageIds)).toBe(true);
    expect(Object.isFrozen(normalizedRecord.payloadSummary)).toBe(true);
    expect(store.rawEvents()).toEqual([
      receivedRecord,
      normalizedRecord,
      appended
    ]);
  });

  it('deeply snapshots tool input and result evidence before storing it', () => {
    const store = createRuntimeLogStore();
    const nestedInput = { query: 'before' };
    const nestedOutput = { answer: 'before' };
    const started: RawEventLogRecordInput = {
      ...identity,
      kind: 'tool_call_started',
      eventType: 'USER_MESSAGE',
      toolCallId: 'call_snapshot_001',
      toolRound: 1,
      toolName: 'memory.search',
      toolPluginId: 'memory.fixture',
      toolInput: { nested: nestedInput }
    };
    const finished: RawEventLogRecordInput = {
      ...identity,
      kind: 'tool_call_finished',
      eventType: 'USER_MESSAGE',
      status: 'completed',
      toolCallId: 'call_snapshot_001',
      toolRound: 1,
      toolName: 'memory.search',
      toolPluginId: 'memory.fixture',
      dispatchedToHost: true,
      toolResult: {
        status: 'accepted',
        output: { nested: nestedOutput },
        evidence: []
      }
    };

    store.appendTrace({ ...identity, step: 'runtime_event_received' });
    store.appendRawEvent({
      ...identity,
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE'
    });
    const storedStart = store.appendRawEvent(started);
    const storedFinish = store.appendRawEvent(finished);

    nestedInput.query = 'after';
    nestedOutput.answer = 'after';

    expect(storedStart.toolInput).toEqual({ nested: { query: 'before' } });
    expect(storedFinish.toolResult).toEqual({
      status: 'accepted',
      output: { nested: { answer: 'before' } },
      evidence: []
    });
    expect(Object.isFrozen(storedStart.toolInput?.['nested'])).toBe(true);
    expect(
      storedFinish.toolResult?.status === 'accepted' &&
        Object.isFrozen(storedFinish.toolResult.output)
    ).toBe(true);
  });

  it('appends visible conversation records only through explicit committed-message inputs', () => {
    const store = createRuntimeLogStore();
    const userMessage: ConversationLogRecordInput = {
      ...identity,
      id: 'local-session:message-1',
      role: 'user',
      speakerId: 'local-user',
      speakerName: 'You',
      text: 'hello',
      committedAt: '2026-06-04T00:00:01.000Z'
    };
    const characterMessage: ConversationLogRecordInput = {
      ...identity,
      id: 'local-session:message-2',
      role: 'character',
      speakerId: 'mira',
      speakerName: 'Mira',
      text: "I'm here. Tell me what you need.",
      committedAt: '2026-06-04T00:00:02.000Z'
    };

    store.appendTrace({ ...identity, step: 'runtime_event_received' });
    store.appendRawEvent({
      ...identity,
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE'
    });
    store.appendConversationMessage(userMessage);
    store.appendConversationMessage(characterMessage);
    store.appendRawEvent({
      ...identity,
      kind: 'runtime_turn_completed',
      eventType: 'USER_MESSAGE',
      status: 'completed',
      visibleMessageIds: [userMessage.id, characterMessage.id]
    });

    expect(store.conversationMessages()).toEqual([userMessage, characterMessage]);
    expect(store.traceEntries()).toHaveLength(1);
    expect(store.rawEvents()).toHaveLength(2);
  });

  it('records failed raw rejections without adding visible conversation records', () => {
    const store = createRuntimeLogStore();
    const rejection: RawEventLogRecordInput = {
      ...identity,
      kind: 'runtime_turn_rejected',
      eventType: 'USER_MESSAGE',
      status: 'rejected',
      reason: 'Provide exactly one non-empty message.'
    };

    store.appendTrace({ ...identity, step: 'runtime_event_received' });
    const received = store.appendRawEvent({
      ...identity,
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE'
    });
    store.appendRawEvent(rejection);

    expect(store.rawEvents()).toEqual([received, rejection]);
    expect(store.conversationMessages()).toEqual([]);
  });
});

function createMinimalPluginTurnEvidence(
  eventIdentity: RuntimeEventIdentity
): RuntimePluginTurnEvidenceSnapshot {
  return createRuntimePluginTurnEvidenceSnapshot({
    ...eventIdentity,
    kind: 'runtime_plugin_turn_evidence_snapshot',
    contractVersion: runtimePluginContractVersion,
    plugins: [],
    contextItems: [],
    evidence: [
      {
        ...eventIdentity,
        kind: 'runtime_plugin_evidence_snapshot',
        pluginId: 'memory.fixture',
        evidenceKind: 'policy',
        status: 'failed',
        summary: 'handler token=secret-token',
        policyOutcome: 'handler_rejected',
        redactionLabels: ['secret']
      }
    ],
    health: []
  });
}
