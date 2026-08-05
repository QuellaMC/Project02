/**
 * What a valid conversation turn looks like — stated once, applied twice.
 *
 * {@link assertConversationTurnShape} walks a whole store on a cold read;
 * the incremental append path in validation.ts applies the same per-turn
 * rules record by record, so a live writer cannot append what a reopen
 * would reject. Both compositions share the rule functions here.
 */
import {
  type CharacterDecision,
  visibleReplyToolCalls,
} from '../../role-model/index.ts';
import {conversationMessageForRawEvent} from './cache.ts';
import {
  normalizeVisibleMessageText,
  runtimeEventIdentityKey,
} from '../../core/index.ts';
import {LocalRuntimeStorageContractError} from '../storage/layout-contract.ts';
import type {ConversationLogRecord, RawEventLogRecord} from './records.ts';

/**
 * The one statement of what a valid conversation turn looks like — the
 * exact shape the runtime writer produces and nothing wider:
 *
 *   1. Every message pairs 1:1 with a visible_message_committed raw
 *      event of its own turn identity, and each such event anchors
 *      exactly one message.
 *   2. A turn with messages holds exactly one user message, committed
 *      first; any number of character replies follow it.
 *   3. A character reply's commit event carries the accepted decision
 *      that produced it — named by its decision round — and the
 *      committed text is that decision's visible reply. The user
 *      message's commit event carries no decision.
 *   4. A turn records one model input text: every record that carries
 *      one agrees, and it is the committed user message's text wherever
 *      the turn committed one.
 *
 * Fragmented per-event checks are deliberately folded in here: a store
 * shape the writer cannot produce fails this one gate at first read
 * instead of slipping between scattered assertions.
 */
export function assertConversationTurnShape(options: {
  readonly messages: readonly ConversationLogRecord[];
  readonly rawEvents: readonly RawEventLogRecord[];
}): void {
  const commitEventByMessageKey = collectMessageCommitEvents(options.rawEvents);

  for (const message of options.messages) {
    if (
      !commitEventByMessageKey.has(
        visibleMessageEvidenceKey(message, message.id),
      )
    ) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        `Conversation message lacks its visible_message_committed raw event: ${message.id}.`,
      );
    }
  }

  const messagesByTurnIdentity = groupByTurnIdentity(options.messages);

  // Both terminal kinds enumerate their turn's committed messages;
  // transcript reconstruction reads prior messages from these references.
  for (const rawEvent of options.rawEvents.filter(
    isVisibleMessageTerminalRawEventLogRecord,
  )) {
    const expectedMessageIds = (
      messagesByTurnIdentity.get(runtimeEventIdentityKey(rawEvent)) ?? []
    ).map(message => message.id);

    if (
      !sameOrderedValues(rawEvent.visibleMessageIds ?? [], expectedMessageIds)
    ) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Terminal raw-event evidence must exactly match the visible conversation messages for that turn.',
      );
    }
  }

  for (const turnMessages of messagesByTurnIdentity.values()) {
    assertSingleLeadingUserMessage(turnMessages);

    for (const message of turnMessages) {
      const commitEvent = commitEventByMessageKey.get(
        visibleMessageEvidenceKey(message, message.id),
      );

      if (commitEvent === undefined) {
        continue;
      }

      assertVisibleMessageCommitEvidence(message, commitEvent);
    }

    assertCharacterRowsFollowTheirDecision(
      turnMessages,
      commitEventByMessageKey,
    );
  }

  assertTurnsRecordOneModelInput(options.rawEvents);
}

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

/**
 * One model input per turn. The visible user row, the payload summary on
 * each record, and the role-model input snapshot all restate what the
 * user said; evidence in which they disagree describes a model answering
 * a message the transcript never showed. The user row participates
 * through its own commit event, which carries its text.
 */
function assertTurnsRecordOneModelInput(
  rawEvents: readonly RawEventLogRecord[],
): void {
  const textsByIdentity = new Map<string, string[]>();

  for (const rawEvent of rawEvents) {
    const identityKey = runtimeEventIdentityKey(rawEvent);
    const texts = textsByIdentity.get(identityKey) ?? [];

    texts.push(...turnModelInputTexts(rawEvent));
    textsByIdentity.set(identityKey, texts);
  }

  for (const texts of textsByIdentity.values()) {
    assertAgreedModelInputText(texts);
  }
}

/** The model input texts one record carries, in restatement order. */
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

function collectMessageCommitEvents(
  rawEvents: readonly RawEventLogRecord[],
): ReadonlyMap<string, RawEventLogRecord> {
  const commitEventByMessageKey = new Map<string, RawEventLogRecord>();

  for (const record of rawEvents) {
    if (record.kind !== 'visible_message_committed') {
      continue;
    }

    const messageIds = record.visibleMessageIds ?? [];

    if (messageIds.length !== 1) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'A visible_message_committed raw event must anchor exactly one conversation message.',
      );
    }

    for (const messageId of messageIds) {
      const key = visibleMessageEvidenceKey(record, messageId);

      if (commitEventByMessageKey.has(key)) {
        throw new LocalRuntimeStorageContractError(
          'malformed_record',
          `Conversation message has more than one visible_message_committed raw event: ${messageId}.`,
        );
      }

      commitEventByMessageKey.set(key, record);
    }
  }

  return commitEventByMessageKey;
}

function groupByTurnIdentity(
  messages: readonly ConversationLogRecord[],
): ReadonlyMap<string, readonly ConversationLogRecord[]> {
  const messagesByTurn = new Map<string, ConversationLogRecord[]>();

  for (const message of messages) {
    const key = runtimeEventIdentityKey(message);
    const turnMessages = messagesByTurn.get(key) ?? [];

    turnMessages.push(message);
    messagesByTurn.set(key, turnMessages);
  }

  return messagesByTurn;
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
 * Replies keep the order their decisions committed them in: rows of one
 * round keep that round's reply order, and rows of a later round never
 * precede rows of an earlier one. Each row already matches an accepted
 * reply of its decision; this is what stops a writer reordering or
 * repeating them within or across the rounds of one turn.
 */
export function assertCharacterRowsFollowTheirDecision(
  turnMessages: readonly ConversationLogRecord[],
  commitEventByMessageKey: ReadonlyMap<string, RawEventLogRecord>,
): void {
  // Keyed by the sampling round the commit event records: one decision
  // commits each of its replies as its own event, and two rounds may
  // legitimately say the same thing, so the key names the round rather
  // than what it said.
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
 * A decision's replies as the commit path would have stored them, so the
 * rows compare through the same normalization. A stored reply that cannot
 * be normalized is a damaged record, named as one: this runs inside a
 * store read, where an unclassified text error would reach the operator
 * without saying which file broke.
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

  // The round is part of carrying the decision: it names which of the
  // turn's decisions produced this row, and the ordering check below
  // keys on it — a row without one would escape that check entirely.
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

function isVisibleMessageTerminalRawEventLogRecord(
  record: RawEventLogRecord,
): boolean {
  return (
    record.kind === 'runtime_turn_completed' ||
    record.kind === 'runtime_turn_rejected'
  );
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

export function sameOrderedValues(
  actualValues: readonly string[],
  expectedValues: readonly string[],
): boolean {
  return (
    actualValues.length === expectedValues.length &&
    actualValues.every((value, index) => value === expectedValues[index])
  );
}
