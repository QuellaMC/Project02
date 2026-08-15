/** The turn rules the append gate applies to live and replayed records. */
import {
  type CharacterDecision,
  visibleReplyToolCalls,
} from '../../role-model/index.ts';
import {conversationMessageForRawEvent} from './cache.ts';
import {
  normalizeVisibleMessageText,
  runtimeEventIdentityKey,
} from '../../core/index.ts';
import {sameOrderedValues} from '../storage/codec-primitives.ts';
import {LocalRuntimeStorageContractError} from '../storage/layout-contract.ts';
import type {ConversationLogRecord, RawEventLogRecord} from './records.ts';

export function assertVisibleMessageCommitEvidence(
  message: ConversationLogRecord,
  commitEvent: RawEventLogRecord,
): void {
  if (message.role === 'character') {
    assertCharacterCommitCarriesItsDecision(message, commitEvent);
    return;
  }

  // The writer never stamps model commit validation on the user row; its
  // text is pinned by the turn's one recorded model input instead.
  if (commitEvent.commitValidation !== undefined) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      `User message commit must not carry model commit validation: ${message.id}.`,
    );
  }
}

export function turnModelInputTexts(
  record: RawEventLogRecord,
): readonly string[] {
  const ownMessage = conversationMessageForRawEvent(record);

  return [
    ...(ownMessage?.role === 'user' ? [ownMessage.text] : []),
    ...(record.payloadSummary?.normalizedCurrentUserMessage === undefined
      ? []
      : [record.payloadSummary.normalizedCurrentUserMessage]),
    ...(record.roleModelIOSnapshot === undefined
      ? []
      : [
          record.roleModelIOSnapshot.inputEnvelope.event.payload
            .currentUserMessage,
        ]),
  ];
}

export function assertAgreedModelInputText(texts: readonly string[]): void {
  for (const text of texts) {
    if (text !== texts[0]) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        "A turn must record one model input text, matching the turn's committed user message.",
      );
    }
  }
}

export function assertSingleLeadingUserMessage(
  turnMessages: readonly ConversationLogRecord[],
): void {
  const userMessages = turnMessages.filter(message => message.role === 'user');

  if (userMessages.length !== 1 || turnMessages[0]?.role !== 'user') {
    // Name the turn by its recorded eventId - identity keys are opaque
    // map keys, never parsed back into their parts.
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      `A runtime turn must commit exactly one user message before its replies: ${turnMessages[0]?.eventId ?? 'unknown event'}.`,
    );
  }
}

/**
 * Rows of one round keep that round's reply order, and rows of a later
 * round never precede rows of an earlier one.
 */
export function assertCharacterRowsFollowTheirDecision(
  turnMessages: readonly ConversationLogRecord[],
  commitEventByMessageKey: ReadonlyMap<string, RawEventLogRecord>,
): void {
  // Keyed by round, not by text: two rounds may legitimately say the same
  // thing.
  const rowsByDecision = new Map<
    number,
    {readonly texts: string[]; readonly replies: readonly string[]}
  >();
  let previousRound: number | undefined;

  for (const message of turnMessages) {
    const commitEvent = commitEventByMessageKey.get(
      visibleMessageEvidenceKey(message, message.id),
    );
    const decision = commitEvent?.parsedRoleModelDecisionSnapshot?.result;
    const round = commitEvent?.decisionRound;

    if (
      message.role !== 'character' ||
      round === undefined ||
      decision?.status !== 'accepted'
    ) {
      continue;
    }

    if (previousRound !== undefined && round < previousRound) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Character messages must follow the order their decision asked for.',
      );
    }

    previousRound = round;

    const seen = rowsByDecision.get(round) ?? {
      texts: [],
      replies: storedDecisionReplyTexts(decision.decision),
    };

    seen.texts.push(message.text);
    rowsByDecision.set(round, seen);
  }

  for (const {texts, replies} of rowsByDecision.values()) {
    if (!sameOrderedValues(texts, replies.slice(0, texts.length))) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Character messages must follow the order their decision asked for.',
      );
    }
  }
}

/**
 * Normalized the way the commit path stored them, so rows compare through
 * one normalization.
 */
function storedDecisionReplyTexts(
  decision: CharacterDecision,
): readonly string[] {
  return visibleReplyToolCalls(decision).map(call => {
    try {
      return normalizeVisibleMessageText(call.input.text);
    } catch (error: unknown) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Character message decision carries a reply text that is not a visible message.',
        {cause: error},
      );
    }
  });
}

function assertCharacterCommitCarriesItsDecision(
  message: ConversationLogRecord,
  commitEvent: RawEventLogRecord,
): void {
  const commitResult = commitEvent.commitValidation?.result;
  const decisionResult = commitEvent.parsedRoleModelDecisionSnapshot?.result;

  // The round is required: the ordering check keys on it, so a row without
  // one would escape that check.
  if (
    commitResult?.status !== 'accepted' ||
    commitResult.acceptedVisibleReplyText === undefined ||
    decisionResult?.status !== 'accepted' ||
    commitEvent.decisionRound === undefined
  ) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      `Character message commit must carry the accepted decision that produced its text: ${message.id}.`,
    );
  }

  // The commit anchor holds the reply text verbatim, so any difference
  // between it and the row is edited text rather than a projection.
  if (commitResult.acceptedVisibleReplyText !== message.text) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      `Character message text must match the accepted reply its commit anchored: ${message.id}.`,
    );
  }
}

export function visibleMessageEvidenceKey(
  identity: {
    readonly eventId: string;
    readonly traceId: string;
    readonly createdAt: string;
  },
  messageId: string,
): string {
  return `${runtimeEventIdentityKey(identity)}\u0000${messageId}`;
}
