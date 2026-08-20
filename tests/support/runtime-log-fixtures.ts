import {testCharacterProfile} from './character-fixtures.ts';
import type {RuntimeLogStore} from '../../src/runtime/evidence/contract.ts';
import type {
  ConversationLogRecord,
  RawEventLogRecordInput,
} from '../../src/runtime/evidence/records.ts';
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
  runtimeEventIdentityKey,
  sessionIdFromMessageId,
  type CharacterProfile,
  type RuntimeEventIdentity,
} from '../../src/core/index.ts';

export type DurableConversationExchange = readonly [string, string];

/** Creates the session, then commits one turn per [user, character] pair. */
export async function writeDurableSession(options: {
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
  logStore.appendRawEvent(
    completedTerminalRecord(identity, {
      sessionId,
      visibleMessageIds: [userMessageId, characterMessageId],
      acceptedVisibleReplyText: characterText,
    }),
  );
}

/** A completed terminal that judges round 1, as the runtime writes one. */
export function completedTerminalRecord(
  identity: RuntimeEventIdentity,
  options: {
    readonly sessionId: string;
    readonly visibleMessageIds?: readonly string[];
    readonly acceptedVisibleReplyText?: string;
    readonly round?: number;
  },
): RawEventLogRecordInput {
  return {
    ...identity,
    kind: 'runtime_turn_completed',
    eventType: 'USER_MESSAGE',
    status: 'completed',
    ...(options.visibleMessageIds === undefined
      ? {}
      : {visibleMessageIds: options.visibleMessageIds}),
    round: options.round ?? 1,
    commitValidation: createRoleModelCommitValidationSnapshot({
      ...identity,
      sessionId: options.sessionId,
      result: {
        status: 'accepted',
        ...(options.acceptedVisibleReplyText === undefined
          ? {}
          : {acceptedVisibleReplyText: options.acceptedVisibleReplyText}),
      },
    }),
  };
}

function conversationTurnTimestamp(turn: number, step: number): string {
  return new Date(
    Date.parse('2026-07-16T01:00:00.000Z') + turn * 1_000 + step * 100,
  ).toISOString();
}

/**
 * One model round as the runtime records it: what the model was shown and
 * the decision it made. `decision` is the raw model output.
 */
export function appendModelRound(
  store: RuntimeLogStore,
  identity: RuntimeEventIdentity,
  options: {
    readonly round: number;
    readonly sessionId: string;
    readonly decision: unknown;
    readonly character?: CharacterProfile;
    readonly modelInputText?: string;
  },
): void {
  const rawOutputText = JSON.stringify(options.decision);

  store.appendRawEvent({
    ...identity,
    kind: 'role_model_round',
    eventType: 'USER_MESSAGE',
    round: options.round,
    roleModelIOSnapshot: createRoleModelIOSnapshot({
      ...identity,
      sessionId: options.sessionId,
      inputEnvelope: createRoleModelInputEnvelope({
        event: createUserMessageRuntimeEvent(
          options.modelInputText ?? 'hello',
          createRuntimeEventIdentity(identity),
        ),
        decisionContext: createDecisionContext({
          sessionId: options.sessionId,
          characterSnapshot: options.character ?? testCharacterProfile,
        }),
        pluginToolDefinitions: [],
      }),
      rawOutputText,
    }),
    parsedRoleModelDecisionSnapshot: createParsedRoleModelDecisionSnapshot({
      ...identity,
      sessionId: options.sessionId,
      result: parseRoleModelExecutionDecision(rawOutputText),
    }),
  });
}

// The model input inside the round evidence must match the turn's committed
// user message; callers whose turn committed something other than the
// default `hello` pass that text. A character row appends the round that
// said it first, numbered after the turn's earlier rounds.
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
  const round =
    store
      .rawEvents()
      .filter(
        record =>
          record.kind === 'role_model_round' &&
          runtimeEventIdentityKey(record) ===
            runtimeEventIdentityKey(eventIdentity),
      ).length + 1;

  if (message.role === 'character') {
    appendModelRound(store, eventIdentity, {
      round,
      sessionId,
      decision: {
        toolCalls: [{name: 'visible_reply', input: {text: message.text}}],
      },
      ...(expectedCharacter === undefined
        ? {}
        : {character: expectedCharacter}),
      modelInputText,
    });
  }

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
            round,
            commitValidation: createRoleModelCommitValidationSnapshot({
              ...eventIdentity,
              sessionId,
              result: {
                status: 'accepted',
                acceptedVisibleReplyText: message.text,
              },
            }),
          }),
    },
    expectedCharacter,
  );
}
