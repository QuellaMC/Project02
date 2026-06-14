import { describe, expect, it } from 'vitest';

import {
  runtimePluginContractVersion,
  createRuntimePluginTurnEvidenceSnapshot,
  createRuntimeLogStore,
  type ConversationLogRecordInput,
  type RuntimePluginTurnEvidenceSnapshot,
  type RawEventLogRecordInput,
  type RuntimeEventIdentity,
  type RuntimeTraceEntryInput
} from '../src/index.ts';

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
    const completed: RawEventLogRecordInput = {
      ...identity,
      kind: 'runtime_turn_completed',
      eventType: 'USER_MESSAGE',
      status: 'completed',
      visibleMessageIds,
      payloadSummary,
      runtimePluginTurnEvidence: createMinimalPluginTurnEvidence(identity)
    };

    const receivedRecord = store.appendRawEvent(received);
    const appended = store.appendRawEvent(completed);

    visibleMessageIds.push('local-session:message-3');
    payloadSummary.normalizedCurrentUserMessage = 'mutated after append';

    expect(receivedRecord).toEqual(received);
    expect(appended).toEqual({
      ...completed,
      visibleMessageIds: ['local-session:message-1', 'local-session:message-2'],
      payloadSummary: {
        normalizedCurrentUserMessage: 'hello'
      },
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
    expect(Object.isFrozen(appended)).toBe(true);
    expect(Object.isFrozen(appended.visibleMessageIds)).toBe(true);
    expect(Object.isFrozen(appended.payloadSummary)).toBe(true);
    expect(store.rawEvents()).toEqual([receivedRecord, appended]);
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

    store.appendConversationMessage(userMessage);
    store.appendConversationMessage(characterMessage);

    expect(store.conversationMessages()).toEqual([userMessage, characterMessage]);
    expect(store.traceEntries()).toEqual([]);
    expect(store.rawEvents()).toEqual([]);
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

    store.appendRawEvent(rejection);

    expect(store.rawEvents()).toEqual([rejection]);
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
