import {testCharacterProfile} from '../support/character-fixtures.ts';
import {describe, expect, it} from 'vitest';

import {
  runtimePluginContractVersion,
  createRuntimePluginTurnEvidenceSnapshot,
} from '../../src/plugins/api/index.ts';
import {createRuntimeLogStore} from '../../src/runtime/evidence/index.ts';
import {createRoleModelCommitValidationSnapshot} from '../../src/runtime/evidence/records.ts';
import type {
  ConversationLogRecordInput,
  RawEventLogRecordInput,
} from '../../src/runtime/evidence/records.ts';
import {
  createDecisionContext,
  createDefaultRoleModelPluginToolDefinitions,
  createParsedRoleModelDecisionSnapshot,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot,
  parseRoleModelExecutionDecision,
} from '../../src/role-model/index.ts';
import type {RuntimePluginTurnEvidenceSnapshot} from '../../src/plugins/api/index.ts';
import {
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
  type CharacterProfile,
  type RuntimeEventIdentity,
} from '../../src/core/index.ts';

const identity = {
  eventId: 'evt_log_001',
  traceId: 'trace_log_001',
  createdAt: '2026-06-04T00:00:00.000Z',
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
    // A direct-runtime store may omit boundUserSpeaker while the
    // session carries a custom display name: the first user record
    // anchors the speaker (the id is never negotiable), and later
    // records must match the anchor.
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
    store.appendRawEvent({
      ...identity,
      kind: 'visible_message_committed',
      eventType: 'USER_MESSAGE',
      visibleMessageIds: ['local-session:message-2'],
      visibleMessage: {
        id: 'local-session:message-2',
        role: 'character',
        speakerId: 'mira',
        speakerName: 'Mira',
        text: 'hello back',
      },
      committedAt: '2026-06-04T00:00:02.000Z',
    });
    expect(() =>
      store.appendRawEvent({
        ...identity,
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
    // The anchoring name is judged by the rule every speaker name is
    // judged by, not merely "non-empty". A multiline or overlong name
    // used to append, and the next read of the session ran it through
    // createUserSpeaker and threw — leaving durable evidence that could
    // never be opened again. Refusing the write is the only outcome
    // that does not strand the session.
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

    // Nothing landed: message 1 is still the slot a user record may
    // take. Had a refused record been appended, the store would now
    // require message 2 and the character role.
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
    // The binding is a fact about the store, not a default the caller
    // outranks. A supplied character used to win outright, and with no
    // recorded evidence yet to compare against, `nova` messages landed
    // in a `mira`-bound store; the refusal arrived on the terminal raw
    // event, after the appends were durable.
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

    // Nothing landed, and only the timing changed: message 1 is still
    // free, the bound character still appends, and a renamed character
    // stays appendable because the binding is compared by id.
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

  it('stamps user messages against the bound user speaker and rejects drift', () => {
    const store = createRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      boundUserSpeaker: {id: 'local-user', displayName: 'Mike'},
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
          speakerId: 'local-user',
          speakerName: 'You',
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
    store.appendRawEvent({
      ...identity,
      kind: 'visible_message_committed',
      eventType: 'USER_MESSAGE',
      visibleMessageIds: ['local-session:message-2'],
      visibleMessage: {
        id: 'local-session:message-2',
        role: 'character',
        speakerId: 'mira',
        speakerName: 'Mira',
        text: 'hello back',
      },
      committedAt: '2026-06-04T00:00:02.000Z',
    });

    // Once recorded, the session's user speaker wins over later intent:
    // one user speaker per session, mirroring the character rule.
    expect(() =>
      store.appendRawEvent({
        ...identity,
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

/**
 * The commit anchor the runtime writes for every visible message, so a
 * fixture transcript has the shape validation requires: user rows carry
 * no model evidence, character rows carry the accepted decision that
 * produced their text.
 */
function appendVisibleMessageWithCommitAnchor(
  store: ReturnType<typeof createRuntimeLogStore>,
  message: ConversationLogRecordInput,
  expectedCharacter?: CharacterProfile,
): void {
  const eventIdentity = {
    eventId: message.eventId,
    traceId: message.traceId,
    createdAt: message.createdAt,
  };

  store.appendRawEvent({
    ...eventIdentity,
    kind: 'visible_message_committed',
    eventType: 'USER_MESSAGE',
    visibleMessageIds: [message.id],
    visibleMessage: {
      id: message.id,
      role: message.role,
      speakerId: message.speakerId,
      speakerName: message.speakerName,
      text: message.text,
    },
    committedAt: message.committedAt,
    ...(message.role === 'user'
      ? {}
      : {
          roleModelIOSnapshot: createRoleModelIOSnapshot({
            ...eventIdentity,
            sessionId: 'local-session',
            inputEnvelope: createRoleModelInputEnvelope({
              event: createUserMessageRuntimeEvent(
                'hello',
                createRuntimeEventIdentity(eventIdentity),
              ),
              decisionContext: createDecisionContext({
                sessionId: 'local-session',
                characterSnapshot: expectedCharacter ?? testCharacterProfile,
              }),
              pluginToolDefinitions:
                createDefaultRoleModelPluginToolDefinitions(),
            }),
            rawOutputText: JSON.stringify({
              toolCalls: [{name: 'visible_reply', input: {text: message.text}}],
            }),
          }),
          parsedRoleModelDecisionSnapshot:
            createParsedRoleModelDecisionSnapshot({
              ...eventIdentity,
              sessionId: 'local-session',
              result: parseRoleModelExecutionDecision(
                JSON.stringify({
                  toolCalls: [
                    {name: 'visible_reply', input: {text: message.text}},
                  ],
                }),
              ),
            }),
          commitValidation: createRoleModelCommitValidationSnapshot({
            ...eventIdentity,
            sessionId: 'local-session',
            result: {
              status: 'accepted',
              acceptedVisibleReplyText: message.text,
            },
          }),
        }),
  });
}

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
