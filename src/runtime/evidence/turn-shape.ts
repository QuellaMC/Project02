/** The turn rules the append gate applies to live and replayed records. */
import {
  roleModelCommitValidationFailureRejectionReason,
  roleModelToolRoundsExhaustedRejectionReason,
  visibleReplyToolCalls,
  type CharacterDecision,
  type RoleModelDecisionResult,
} from '../../role-model/index.ts';
import {conversationMessageForRawEvent} from './cache.ts';
import {
  normalizeVisibleMessageText,
  runtimeEventIdentityKey,
} from '../../core/index.ts';
import {sameOrderedValues} from '../storage/codec-primitives.ts';
import {LocalRuntimeStorageContractError} from '../storage/layout-contract.ts';
import type {ConversationLogRecord, RawEventLogRecord} from './records.ts';

/**
 * A turn's rounds are numbered as they happen, and everything else that
 * names a round names one the turn already ran.
 */
export function assertRoundReference(
  record: RawEventLogRecord,
  turnRounds: readonly RawEventLogRecord[],
): void {
  if (record.kind === 'role_model_round') {
    if (record.round !== turnRounds.length + 1) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        `Model round ${String(record.round)} is out of sequence: the turn has run ${String(turnRounds.length)}.`,
      );
    }

    return;
  }

  if (record.round === undefined) {
    return;
  }

  const round = turnRounds[record.round - 1];

  if (round === undefined) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      `Raw event references model round ${String(record.round)}, which the turn never ran.`,
    );
  }

  if (
    record.commitValidation !== undefined &&
    record.commitValidation.sessionId !== round.roleModelIOSnapshot?.sessionId
  ) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Commit validation must belong to the session of the round it judges.',
    );
  }
}

/**
 * A terminal record that judges a round agrees with what the round said: a
 * completed turn ends on an accepted decision, and a rejection repeats the
 * parser's refusal or names one of the runtime's own.
 */
export function assertTerminalJudgesItsRound(
  record: RawEventLogRecord,
  turnRounds: readonly RawEventLogRecord[],
): void {
  const commitResult = record.commitValidation?.result;
  const parsedResult = referencedDecision(record, turnRounds);

  if (commitResult === undefined || parsedResult === undefined) {
    return;
  }

  if (commitResult.status === 'accepted') {
    if (parsedResult.status !== 'accepted') {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'A completed turn must end on a round the parser accepted.',
      );
    }

    const replies = storedDecisionReplyTexts(parsedResult.decision);
    const anchored = commitResult.acceptedVisibleReplyText;

    if (
      anchored === undefined
        ? replies.length !== 0
        : !replies.includes(anchored)
    ) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'A completed turn must anchor a reply the round it ended on asked for.',
      );
    }

    return;
  }

  const agrees =
    parsedResult.status === 'rejected'
      ? parsedResult.rejection.reason === commitResult.rejection.reason &&
        parsedResult.rejection.details === commitResult.rejection.details
      : commitResult.rejection.reason ===
          roleModelToolRoundsExhaustedRejectionReason ||
        commitResult.rejection.reason ===
          roleModelCommitValidationFailureRejectionReason;

  if (!agrees) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'A turn rejection must repeat the refusal of the round it judged, or name a refusal of the runtime itself.',
    );
  }
}

export function assertVisibleMessageCommitEvidence(
  message: ConversationLogRecord,
  commitEvent: RawEventLogRecord,
  turnRounds: readonly RawEventLogRecord[],
): void {
  if (message.role !== 'character') {
    return;
  }

  if (referencedDecision(commitEvent, turnRounds)?.status !== 'accepted') {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      `Character message commit must reference the accepted round that produced its text: ${message.id}.`,
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
  turnRounds: readonly RawEventLogRecord[],
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
    const round = commitEvent?.round;
    const decision =
      commitEvent === undefined
        ? undefined
        : referencedDecision(commitEvent, turnRounds);

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

function referencedDecision(
  record: RawEventLogRecord,
  turnRounds: readonly RawEventLogRecord[],
): RoleModelDecisionResult | undefined {
  return record.round === undefined
    ? undefined
    : turnRounds[record.round - 1]?.parsedRoleModelDecisionSnapshot?.result;
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
