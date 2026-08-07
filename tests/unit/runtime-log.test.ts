import {testCharacterProfile} from '../support/character-fixtures.ts';
import {describe, expect, it} from 'vitest';

import {
  runtimePluginContractVersion,
  createRuntimePluginTurnEvidenceSnapshot,
} from '../../src/plugins/api/index.ts';
import {createRuntimeLogStore} from '../../src/runtime/evidence/index.ts';
import type {
  ConversationLogRecordInput,
  RawEventLogRecordInput,
} from '../../src/runtime/evidence/records.ts';
import type {RuntimePluginTurnEvidenceSnapshot} from '../../src/plugins/api/index.ts';
import type {RuntimeEventIdentity} from '../../src/core/index.ts';
import {appendVisibleMessageWithCommitAnchor} from '../support/runtime-log-fixtures.ts';

const identity = {
  eventId: 'evt_log_001',
  traceId: 'trace_log_001',
  createdAt: '2026-06-04T00:00:00.000Z',
} as const;
const secondTurnIdentity = {
  eventId: 'evt_log_002',
  traceId: 'trace_log_002',
  createdAt: '2026-06-04T00:00:03.000Z',
} as const;

describe('runtime log store', () => {
  it('derives the trace from the event log in append order', () => {
    const store = createRuntimeLogStore({boundCharacter: testCharacterProfile});
    store.appendRawEvent({
      ...identity,
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE',
    });
    store.appendRawEvent({
      ...identity,
      kind: 'runtime_event_normalized',
      eventType: 'USER_MESSAGE',
    });
    store.appendRawEvent({
      ...identity,
      kind: 'runtime_turn_completed',
      eventType: 'USER_MESSAGE',
      status: 'completed',
    });

    const snapshot = store.traceEntries();

    expect(snapshot.map(entry => entry.step)).toEqual([
      'runtime_event_received',
      'runtime_event_normalized',
      'runtime_turn_started',
      'raw_event_log_appended',
      'runtime_turn_completed',
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
  });

  it('copies raw event records with source event and trace identity', () => {
    const store = createRuntimeLogStore({boundCharacter: testCharacterProfile});
    const received: RawEventLogRecordInput = {
      ...identity,
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE',
      payloadSummary: {
        rawInput: ' hello ',
      },
    };
    const visibleMessageIds = [
      'local-session:message-1',
      'local-session:message-2',
    ];
    const payloadSummary = {
      normalizedCurrentUserMessage: 'hello',
    };
    const normalized: RawEventLogRecordInput = {
      ...identity,
      kind: 'runtime_event_normalized',
      eventType: 'USER_MESSAGE',
      payloadSummary,
    };
    const completed: RawEventLogRecordInput = {
      ...identity,
      kind: 'runtime_turn_completed',
      eventType: 'USER_MESSAGE',
      status: 'completed',
      visibleMessageIds,
      runtimePluginTurnEvidence: createMinimalPluginTurnEvidence(identity),
    };
    const receivedRecord = store.appendRawEvent(received);
    const normalizedRecord = store.appendRawEvent(normalized);
    appendVisibleMessageWithCommitAnchor(store, {
      ...identity,
      id: 'local-session:message-1',
      role: 'user',
      speakerId: 'local-user',
      speakerName: 'You',
      text: 'hello',
      committedAt: '2026-06-04T00:00:01.000Z',
    });
    appendVisibleMessageWithCommitAnchor(store, {
      ...identity,
      id: 'local-session:message-2',
      role: 'character',
      speakerId: 'mira',
      speakerName: 'Mira',
      text: 'hello back',
      committedAt: '2026-06-04T00:00:02.000Z',
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
            summary: 'handler token=secret-token',
            policyOutcome: 'handler_rejected',
            redactionLabels: ['secret'],
          },
        ],
      },
    });
    expect(normalizedRecord.payloadSummary).toEqual({
      normalizedCurrentUserMessage: 'hello',
    });
    expect(Object.isFrozen(appended)).toBe(true);
    expect(Object.isFrozen(appended.visibleMessageIds)).toBe(true);
    expect(Object.isFrozen(normalizedRecord.payloadSummary)).toBe(true);
    expect(
      store
        .rawEvents()
        .filter(event => event.kind !== 'visible_message_committed'),
    ).toEqual([receivedRecord, normalizedRecord, appended]);
  });

  it('deeply snapshots tool input and result evidence before storing it', () => {
    const store = createRuntimeLogStore({boundCharacter: testCharacterProfile});
    const nestedInput = {query: 'before'};
    const nestedOutput = {answer: 'before'};
    const started: RawEventLogRecordInput = {
      ...identity,
      kind: 'tool_call_started',
      eventType: 'USER_MESSAGE',
      toolCallId: 'call_snapshot_001',
      toolRound: 1,
      toolName: 'memory.search',
      toolPluginId: 'memory.fixture',
      toolInput: {nested: nestedInput},
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
        output: {nested: nestedOutput},
        evidence: [],
      },
    };
    store.appendRawEvent({
      ...identity,
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE',
    });
    const storedStart = store.appendRawEvent(started);
    const storedFinish = store.appendRawEvent(finished);

    nestedInput.query = 'after';
    nestedOutput.answer = 'after';

    expect(storedStart.toolInput).toEqual({nested: {query: 'before'}});
    expect(storedFinish.toolResult).toEqual({
      status: 'accepted',
      output: {nested: {answer: 'before'}},
      evidence: [],
    });
    expect(Object.isFrozen(storedStart.toolInput?.['nested'])).toBe(true);
    expect(
      storedFinish.toolResult?.status === 'accepted' &&
        Object.isFrozen(storedFinish.toolResult.output),
    ).toBe(true);
  });

  it('appends visible conversation records only through explicit committed-message inputs', () => {
    const store = createRuntimeLogStore({boundCharacter: testCharacterProfile});
    const userMessage: ConversationLogRecordInput = {
      ...identity,
      id: 'local-session:message-1',
      role: 'user',
      speakerId: 'local-user',
      speakerName: 'You',
      text: 'hello',
      committedAt: '2026-06-04T00:00:01.000Z',
    };
    const characterMessage: ConversationLogRecordInput = {
      ...identity,
      id: 'local-session:message-2',
      role: 'character',
      speakerId: 'mira',
      speakerName: 'Mira',
      text: "I'm here. Tell me what you need.",
      committedAt: '2026-06-04T00:00:02.000Z',
    };
    store.appendRawEvent({
      ...identity,
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE',
    });
    appendVisibleMessageWithCommitAnchor(store, userMessage);
    appendVisibleMessageWithCommitAnchor(store, characterMessage);
    store.appendRawEvent({
      ...identity,
      kind: 'runtime_turn_completed',
      eventType: 'USER_MESSAGE',
      status: 'completed',
      visibleMessageIds: [userMessage.id, characterMessage.id],
    });

    expect(store.conversationMessages()).toEqual([
      userMessage,
      characterMessage,
    ]);
    expect(
      store
        .rawEvents()
        .filter(event => event.kind !== 'visible_message_committed'),
    ).toHaveLength(2);
  });

  it('records failed raw rejections without adding visible conversation records', () => {
    const store = createRuntimeLogStore({boundCharacter: testCharacterProfile});
    const rejection: RawEventLogRecordInput = {
      ...identity,
      kind: 'runtime_turn_rejected',
      eventType: 'USER_MESSAGE',
      status: 'rejected',
      reason: 'Provide exactly one non-empty message.',
    };
    const received = store.appendRawEvent({
      ...identity,
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE',
    });
    store.appendRawEvent(rejection);

    expect(store.rawEvents()).toEqual([received, rejection]);
    expect(store.conversationMessages()).toEqual([]);
  });

  it('rejects a conversation append when no character is expected, recorded, or bound', () => {
    const store = createRuntimeLogStore();
    store.appendRawEvent({
      ...identity,
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE',
    });

    expect(() =>
      store.appendRawEvent({
        ...identity,
        kind: 'visible_message_committed',
        eventType: 'USER_MESSAGE',
        visibleMessageIds: ['local-session:message-1'],
        visibleMessage: {
          id: 'local-session:message-1',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'hello',
        },
        committedAt: '2026-06-04T00:00:01.000Z',
      }),
    ).toThrow(
      'Conversation append requires a session character: none was expected, recorded, or store-bound.',
    );
  });

  it('anchors a custom first user speaker when the store binds none', () => {
    const store = createRuntimeLogStore({
      boundCharacter: testCharacterProfile,
    });
    store.appendRawEvent({
      ...identity,
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE',
    });
    expect(() =>
      store.appendRawEvent({
        ...identity,
        kind: 'visible_message_committed',
        eventType: 'USER_MESSAGE',
        visibleMessageIds: ['local-session:message-1'],
        visibleMessage: {
          id: 'local-session:message-1',
          role: 'user',
          speakerId: 'someone-else',
          speakerName: 'Custom Name',
          text: 'hello',
        },
        committedAt: '2026-06-04T00:00:01.000Z',
      }),
    ).toThrow('speaker metadata is malformed');

    store.appendRawEvent({
      ...identity,
      kind: 'visible_message_committed',
      eventType: 'USER_MESSAGE',
      visibleMessageIds: ['local-session:message-1'],
      visibleMessage: {
        id: 'local-session:message-1',
        role: 'user',
        speakerId: 'local-user',
        speakerName: 'Custom Name',
        text: 'hello',
      },
      committedAt: '2026-06-04T00:00:01.000Z',
    });
    appendVisibleMessageWithCommitAnchor(store, {
      ...identity,
      id: 'local-session:message-2',
      role: 'character',
      speakerId: 'mira',
      speakerName: 'Mira',
      text: 'hello back',
      committedAt: '2026-06-04T00:00:02.000Z',
    });

    store.appendRawEvent({
      ...secondTurnIdentity,
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE',
    });
    expect(() =>
      store.appendRawEvent({
        ...secondTurnIdentity,
        kind: 'visible_message_committed',
        eventType: 'USER_MESSAGE',
        visibleMessageIds: ['local-session:message-3'],
        visibleMessage: {
          id: 'local-session:message-3',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'Different Name',
          text: 'again',
        },
        committedAt: '2026-06-04T00:00:03.000Z',
      }),
    ).toThrow('speaker metadata is malformed');
  });

  it('refuses an anchoring user name a later read would reject', () => {
    // An anchoring name that only `createUserSpeaker` rejects strands the
    // session: the evidence appends, and the next read of it throws.
    const store = createRuntimeLogStore({
      boundCharacter: testCharacterProfile,
    });
    store.appendRawEvent({
      ...identity,
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE',
    });

    for (const speakerName of ['Bad\nName', ' Padded ', 'x'.repeat(129)]) {
      expect(() =>
        store.appendRawEvent({
          ...identity,
          kind: 'visible_message_committed',
          eventType: 'USER_MESSAGE',
          visibleMessageIds: ['local-session:message-1'],
          visibleMessage: {
            id: 'local-session:message-1',
            role: 'user',
            speakerId: 'local-user',
            speakerName,
            text: 'hello',
          },
          committedAt: '2026-06-04T00:00:01.000Z',
        }),
      ).toThrow('speaker metadata is malformed');
    }

    // Had a refusal landed, the store would now require message 2 and the
    // character role.
    expect(
      store.appendRawEvent({
        ...identity,
        kind: 'visible_message_committed',
        eventType: 'USER_MESSAGE',
        visibleMessageIds: ['local-session:message-1'],
        visibleMessage: {
          id: 'local-session:message-1',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'Custom Name',
          text: 'hello',
        },
        committedAt: '2026-06-04T00:00:01.000Z',
      }).visibleMessage?.speakerName,
    ).toBe('Custom Name');
  });

  it('refuses a supplied character the store binding disagrees with', () => {
    // With no recorded evidence to compare against yet, a supplied character
    // used to win, and the refusal arrived only after the appends were durable.
    const store = createRuntimeLogStore({
      boundCharacter: testCharacterProfile,
    });
    const nova = {id: 'nova', displayName: 'Nova'} as const;
    store.appendRawEvent({
      ...identity,
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE',
    });
    expect(() =>
      store.appendRawEvent(
        {
          ...identity,
          kind: 'visible_message_committed',
          eventType: 'USER_MESSAGE',
          visibleMessageIds: ['local-session:message-1'],
          visibleMessage: {
            id: 'local-session:message-1',
            role: 'user',
            speakerId: 'local-user',
            speakerName: 'You',
            text: 'hello',
          },
          committedAt: '2026-06-04T00:00:01.000Z',
        },
        nova,
      ),
    ).toThrow(
      'Durable character evidence must match the store-bound character',
    );

    // A renamed character stays appendable: the binding is compared by id.
    expect(
      store.appendRawEvent(
        {
          ...identity,
          kind: 'visible_message_committed',
          eventType: 'USER_MESSAGE',
          visibleMessageIds: ['local-session:message-1'],
          visibleMessage: {
            id: 'local-session:message-1',
            role: 'user',
            speakerId: 'local-user',
            speakerName: 'You',
            text: 'hello',
          },
          committedAt: '2026-06-04T00:00:01.000Z',
        },
        {id: testCharacterProfile.id, displayName: 'Renamed Mira'},
      ).visibleMessage?.id,
    ).toBe('local-session:message-1');
  });

  it('pins the bound user id and rejects drift from the anchored name', () => {
    const store = createRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      boundUserSpeaker: {id: 'local-user', displayName: 'Mike'},
    });
    store.appendRawEvent({
      ...identity,
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE',
    });
    // The binding pins the id only; a display name is a per-session fact.
    expect(() =>
      store.appendRawEvent({
        ...identity,
        kind: 'visible_message_committed',
        eventType: 'USER_MESSAGE',
        visibleMessageIds: ['local-session:message-1'],
        visibleMessage: {
          id: 'local-session:message-1',
          role: 'user',
          speakerId: 'someone-else',
          speakerName: 'Mike',
          text: 'hello',
        },
        committedAt: '2026-06-04T00:00:01.000Z',
      }),
    ).toThrow('speaker metadata is malformed');

    store.appendRawEvent({
      ...identity,
      kind: 'visible_message_committed',
      eventType: 'USER_MESSAGE',
      visibleMessageIds: ['local-session:message-1'],
      visibleMessage: {
        id: 'local-session:message-1',
        role: 'user',
        speakerId: 'local-user',
        speakerName: 'Mike',
        text: 'hello',
      },
      committedAt: '2026-06-04T00:00:01.000Z',
    });
    appendVisibleMessageWithCommitAnchor(store, {
      ...identity,
      id: 'local-session:message-2',
      role: 'character',
      speakerId: 'mira',
      speakerName: 'Mira',
      text: 'hello back',
      committedAt: '2026-06-04T00:00:02.000Z',
    });

    // One user speaker per session: once recorded it outranks later intent.
    store.appendRawEvent({
      ...secondTurnIdentity,
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE',
    });
    expect(() =>
      store.appendRawEvent({
        ...secondTurnIdentity,
        kind: 'visible_message_committed',
        eventType: 'USER_MESSAGE',
        visibleMessageIds: ['local-session:message-3'],
        visibleMessage: {
          id: 'local-session:message-3',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'Michael',
          text: 'renamed mid-session',
        },
        committedAt: '2026-06-04T00:00:03.000Z',
      }),
    ).toThrow('speaker metadata is malformed');
  });
});

function createMinimalPluginTurnEvidence(
  eventIdentity: RuntimeEventIdentity,
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
        redactionLabels: ['secret'],
      },
    ],
    health: [],
  });
}
