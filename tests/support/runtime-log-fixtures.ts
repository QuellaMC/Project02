import {testCharacterProfile} from './character-fixtures.ts';
import type {RuntimeLogStore} from '../../src/runtime/evidence/contract.ts';
import type {ConversationLogRecord} from '../../src/runtime/evidence/records.ts';
import {createRoleModelCommitValidationSnapshot} from '../../src/runtime/evidence/records.ts';
import {createFileRuntimeLogStore} from '../../src/runtime/storage/file-runtime-log-store.ts';
import {createLocalRuntimeMutationLockOwnerToken} from '../../src/runtime/storage/mutation-lock.ts';
import {
  acquireLocalRuntimeSessionWriterLease,
  createLocalRuntimeSessionStore,
} from '../../src/runtime/storage/session-store.ts';
import {
  createDecisionContext,
  createParsedRoleModelDecisionSnapshot,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot,
  parseRoleModelExecutionDecision,
} from '../../src/role-model/index.ts';
import {
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
  sessionIdFromMessageId,
  type CharacterProfile,
} from '../../src/core/index.ts';

export type DurableConversationExchange = readonly [string, string];

/** Creates the session, then commits one turn per [user, character] pair. */
export async function writeDurableConversationSession(options: {
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly exchanges: readonly DurableConversationExchange[];
  readonly character?: CharacterProfile;
}): Promise<void> {
  const character = options.character ?? testCharacterProfile;

  await createLocalRuntimeSessionStore({
    storeRoot: options.storeRoot,
    characterId: character.id,
  }).createSession({
    sessionId: options.sessionId,
    createdAt: '2026-07-16T00:00:00.000Z',
  });
  await appendDurableConversationExchanges({
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    exchanges: options.exchanges,
    firstTurn: 0,
    character,
  });
}

export async function appendDurableConversationExchanges(options: {
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly exchanges: readonly DurableConversationExchange[];
  readonly firstTurn: number;
  readonly character?: CharacterProfile;
}): Promise<void> {
  const character = options.character ?? testCharacterProfile;
  const ownerToken = createLocalRuntimeMutationLockOwnerToken();
  const logStore = createFileRuntimeLogStore({
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    characterId: character.id,
    writerLockOwnerToken: ownerToken,
    boundCharacter: character,
  });
  const writerLease = await acquireLocalRuntimeSessionWriterLease({
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    ownerToken,
  });

  try {
    for (const [
      offset,
      [userText, characterText],
    ] of options.exchanges.entries()) {
      appendConversationExchange(
        logStore,
        options.sessionId,
        options.firstTurn + offset,
        userText,
        characterText,
        character,
      );
    }
  } finally {
    await writerLease.release();
  }
}

function appendConversationExchange(
  logStore: RuntimeLogStore,
  sessionId: string,
  turn: number,
  userText: string,
  characterText: string,
  character: CharacterProfile,
): void {
  const identity = {
    eventId: `evt_${sessionId}_${String(turn)}`,
    traceId: `trace_${sessionId}_${String(turn)}`,
    createdAt: conversationTurnTimestamp(turn, 0),
  };
  const userMessageId = `${sessionId}:message-${String(turn * 2 + 1)}`;
  const characterMessageId = `${sessionId}:message-${String(turn * 2 + 2)}`;

  logStore.appendRawEvent({
    ...identity,
    kind: 'runtime_event_received',
    eventType: 'USER_MESSAGE',
  });
  logStore.appendRawEvent({
    ...identity,
    kind: 'visible_message_committed',
    eventType: 'USER_MESSAGE',
    visibleMessageIds: [userMessageId],
    visibleMessage: {
      id: userMessageId,
      role: 'user',
      speakerId: 'local-user',
      speakerName: 'You',
      text: userText,
    },
    committedAt: conversationTurnTimestamp(turn, 1),
  });
  appendVisibleMessageWithCommitAnchor(
    logStore,
    {
      ...identity,
      id: characterMessageId,
      role: 'character',
      speakerId: character.id,
      speakerName: character.displayName,
      text: characterText,
      committedAt: conversationTurnTimestamp(turn, 2),
    },
    character,
    userText,
  );
  logStore.appendRawEvent({
    ...identity,
    kind: 'runtime_turn_completed',
    eventType: 'USER_MESSAGE',
    status: 'completed',
    visibleMessageIds: [userMessageId, characterMessageId],
  });
}

function conversationTurnTimestamp(turn: number, step: number): string {
  return new Date(
    Date.parse('2026-07-16T01:00:00.000Z') + turn * 1_000 + step * 100,
  ).toISOString();
}

// The model input inside the character evidence must match the turn's
// committed user message; callers whose turn committed something other than
// the default `hello` pass that text.
export function appendVisibleMessageWithCommitAnchor(
  store: RuntimeLogStore,
  message: ConversationLogRecord,
  expectedCharacter?: CharacterProfile,
  modelInputText = 'hello',
): void {
  const eventIdentity = {
    eventId: message.eventId,
    traceId: message.traceId,
    createdAt: message.createdAt,
  };
  const sessionId = sessionIdFromMessageId(message.id) ?? 'local-session';

  store.appendRawEvent(
    {
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
              sessionId,
              inputEnvelope: createRoleModelInputEnvelope({
                event: createUserMessageRuntimeEvent(
                  modelInputText,
                  createRuntimeEventIdentity(eventIdentity),
                ),
                decisionContext: createDecisionContext({
                  sessionId,
                  characterSnapshot: expectedCharacter ?? testCharacterProfile,
                }),
                pluginToolDefinitions: [],
              }),
              rawOutputText: JSON.stringify({
                toolCalls: [
                  {name: 'visible_reply', input: {text: message.text}},
                ],
              }),
            }),
            parsedRoleModelDecisionSnapshot:
              createParsedRoleModelDecisionSnapshot({
                ...eventIdentity,
                sessionId,
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
              sessionId,
              result: {
                status: 'accepted',
                acceptedVisibleReplyText: message.text,
              },
            }),
            decisionRound: 1,
          }),
    },
    expectedCharacter,
  );
}
