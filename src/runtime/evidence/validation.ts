import {conversationMessageForRawEvent} from './cache.ts';
import {
  type CharacterProfile,
  isValidSpeakerDisplayName,
  localUserSpeaker,
  messageNumberFromId,
  type RuntimeEventIdentity,
  type SpeakerIdentity,
  runtimeEventIdentityKey,
  sessionIdFromMessageId,
} from '../../core/index.ts';
import {
  assertAgreedModelInputText,
  assertCharacterRowsFollowTheirDecision,
  assertSingleLeadingUserMessage,
  assertVisibleMessageCommitEvidence,
  sameOrderedValues,
  turnModelInputTexts,
  visibleMessageEvidenceKey,
} from './turn-shape.ts';
import {
  LocalRuntimeStorageContractError,
  normalizeLocalRuntimeSessionId,
} from '../storage/layout-contract.ts';
import type {ConversationLogRecord, RawEventLogRecord} from './records.ts';
import {isTerminalRawEventLogRecord} from './records.ts';
import {
  approvalToolRecordsByCallId,
  runtimeConfigEffectHasLoggedApproval,
} from './config-effect-approval.ts';
import type {
  DurableRuntimeSessionEvidence,
  RuntimeEvidenceIncrementalState,
} from './contract.ts';
import {
  assertRoleModelEvidenceMatchesSessionId,
  durableCharacterProfile,
  roleModelCharacterSnapshot,
  sameCharacterProfiles,
  speakerMatchesCharacter,
  validateDurableCharacterProfiles,
} from './identity.ts';

export function createRuntimeEvidenceIncrementalState(
  evidence: DurableRuntimeSessionEvidence,
  boundCharacter?: CharacterProfile,
  boundUserSpeaker?: SpeakerIdentity,
): RuntimeEvidenceIncrementalState {
  // Seeding state from pre-populated evidence would readmit the unasserted
  // path; every record enters through assert-then-apply.
  if (
    evidence.rawEvents.length > 0 ||
    evidence.conversationMessages.length > 0
  ) {
    throw new TypeError(
      'Runtime evidence state starts empty; replay stored records through the transition machine.',
    );
  }

  return {
    createdAtByIdentity: new Map(),
    rawKindsByIdentity: new Map(),
    terminalRawByIdentity: new Map(),
    startedToolCalls: new Map(),
    finishedToolCalls: new Set(),
    unfinishedToolCallIdsByIdentity: new Map(),
    messagesById: new Map(),
    messageIdsByIdentity: new Map(),
    commitEventByMessageKey: new Map(),
    turnModelInputByIdentity: new Map(),
    roleModelCharacter: undefined,
    conversationCharacter: undefined,
    boundCharacter,
    userSpeaker: undefined,
    boundUserSpeaker,
    openRawIdentity: undefined,
    openTurnConversationStart: 0,
  };
}

export function assertIncrementalRawEventAppend(options: {
  readonly evidence: DurableRuntimeSessionEvidence;
  readonly sessionId?: string;
  readonly state: RuntimeEvidenceIncrementalState;
  readonly record: RawEventLogRecord;
}): void {
  const {record, state} = options;
  assertIncrementalIdentityTimestamp(state, record);
  const identityKey = runtimeEventIdentityKey(record);

  // A continuation is how a session begins, never something a turn records:
  // it stands alone as the very first record and opens no turn of its own.
  if (record.kind === 'session_continued') {
    if (options.evidence.rawEvents.length > 0) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Raw event log session_continued must be the first record of a session.',
      );
    }

    if (
      options.sessionId !== undefined &&
      record.sessionContinuation?.sessionId !== options.sessionId
    ) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        `Raw event log session_continued names session "${
          record.sessionContinuation?.sessionId ?? '?'
        }" inside session "${options.sessionId}".`,
      );
    }

    return;
  }

  assertIncrementalRawSequence(state, record, identityKey);

  assertIncrementalToolCallAppend(state, record);
  assertIncrementalRawCrossLogEvidence(options);

  if (isTerminalRawEventLogRecord(record)) {
    assertIncrementalTerminalRawEvent(state, record, identityKey);
  }
}

function assertIncrementalRawSequence(
  state: RuntimeEvidenceIncrementalState,
  record: RawEventLogRecord,
  identityKey: string,
): void {
  const priorKinds = state.rawKindsByIdentity.get(identityKey);
  const terminalKind = state.terminalRawByIdentity.get(identityKey);

  if (priorKinds === undefined && record.kind !== 'runtime_event_received') {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Raw event log turn evidence must start with runtime_event_received.',
    );
  }

  if (terminalKind !== undefined && record.kind !== 'after_turn_committed') {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Raw event log contains records after terminal turn evidence.',
    );
  }

  // A turn starting implicitly closes any turn a crash left open; any other
  // record must belong to the open turn.
  if (
    record.kind !== 'after_turn_committed' &&
    record.kind !== 'runtime_event_received' &&
    state.openRawIdentity !== undefined &&
    state.openRawIdentity !== identityKey
  ) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Raw event log contains overlapping turn evidence.',
    );
  }

  if (
    isTerminalRawEventLogRecord(record) &&
    state.openRawIdentity !== identityKey
  ) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Raw event log contains terminal turn evidence before start evidence.',
    );
  }
}

function assertIncrementalRawCrossLogEvidence(options: {
  readonly evidence: DurableRuntimeSessionEvidence;
  readonly sessionId?: string;
  readonly state: RuntimeEvidenceIncrementalState;
  readonly record: RawEventLogRecord;
}): void {
  const {record, state} = options;

  if (record.runtimeConfigEffects !== undefined) {
    assertRuntimeConfigEffectsHaveApprovedToolEvidence([
      ...options.evidence.rawEvents,
      record,
    ]);
  }
  assertIncrementalRawVisibleReferences(state, record);
  assertIncrementalVisibleCommitShape(state, record);
  assertIncrementalRecordedModelInput(state, record);
  assertIncrementalCharacterEvidence(state, record);
  if (options.sessionId !== undefined) {
    assertRoleModelEvidenceMatchesSessionId({
      sessionId: options.sessionId,
      rawEvents: [record],
    });
  }
}

function assertIncrementalTerminalRawEvent(
  state: RuntimeEvidenceIncrementalState,
  record: RawEventLogRecord,
  identityKey: string,
): void {
  const unfinished = state.unfinishedToolCallIdsByIdentity.get(identityKey);
  const turnMessageIds = state.messageIdsByIdentity.get(identityKey) ?? [];

  if (record.kind === 'runtime_turn_completed' && (unfinished?.size ?? 0) > 0) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      `Tool call started without finish: ${unfinished?.values().next().value ?? 'unknown'}.`,
    );
  }

  for (const callId of record.toolCallIds ?? []) {
    if (!state.finishedToolCalls.has(callId)) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        `Terminal raw event references unfinished tool call: ${callId}.`,
      );
    }
  }

  if (!sameOrderedValues(record.visibleMessageIds ?? [], turnMessageIds)) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Terminal raw-event evidence must exactly match the visible conversation messages for that turn.',
    );
  }
}

export function applyIncrementalRawEventAppend(options: {
  readonly evidence: DurableRuntimeSessionEvidence;
  readonly state: RuntimeEvidenceIncrementalState;
  readonly record: RawEventLogRecord;
}): void {
  const {record, state} = options;
  recordIncrementalIdentityTimestamp(state, record);

  if (record.kind === 'session_continued') {
    return;
  }

  const identityKey = runtimeEventIdentityKey(record);
  const kinds = state.rawKindsByIdentity.get(identityKey) ?? new Set();

  kinds.add(record.kind);
  state.rawKindsByIdentity.set(identityKey, kinds);
  applyIncrementalToolCallState(state, record);
  applyIncrementalTurnShapeState(state, record);
  const character = roleModelCharacterSnapshot(record);

  if (state.roleModelCharacter === undefined && character !== undefined) {
    state.roleModelCharacter = character;
  }

  if (record.kind === 'after_turn_committed') {
    return;
  }

  if (record.kind === 'runtime_event_received') {
    state.openRawIdentity = identityKey;
    state.openTurnConversationStart =
      options.evidence.conversationMessages.length;
  }

  if (
    record.kind === 'runtime_turn_completed' ||
    record.kind === 'runtime_turn_rejected'
  ) {
    state.terminalRawByIdentity.set(identityKey, record.kind);
    state.openRawIdentity = undefined;
  }
}

function assertIncrementalToolCallAppend(
  state: RuntimeEvidenceIncrementalState,
  record: RawEventLogRecord,
): void {
  if (record.kind === 'tool_call_started') {
    const callId = requiredToolCallId(record);

    if (state.startedToolCalls.has(callId)) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        `Tool call started more than once: ${callId}.`,
      );
    }

    return;
  }

  if (record.kind !== 'tool_call_finished') {
    return;
  }

  const callId = requiredToolCallId(record);
  const started = state.startedToolCalls.get(callId);

  if (started === undefined) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      `Tool call finished before start: ${callId}.`,
    );
  }

  if (state.finishedToolCalls.has(callId)) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      `Tool call finished more than once: ${callId}.`,
    );
  }

  if (started.identityKey !== runtimeEventIdentityKey(record)) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      `Tool call finished under another event identity: ${callId}.`,
    );
  }
}

function applyIncrementalToolCallState(
  state: RuntimeEvidenceIncrementalState,
  record: RawEventLogRecord,
): void {
  const identityKey = runtimeEventIdentityKey(record);

  if (record.kind === 'tool_call_started') {
    const callId = requiredToolCallId(record);
    state.startedToolCalls.set(callId, {identityKey, record});
    const unfinished =
      state.unfinishedToolCallIdsByIdentity.get(identityKey) ?? new Set();
    unfinished.add(callId);
    state.unfinishedToolCallIdsByIdentity.set(identityKey, unfinished);
    return;
  }

  if (record.kind === 'tool_call_finished') {
    const callId = requiredToolCallId(record);
    state.finishedToolCalls.add(callId);
    state.unfinishedToolCallIdsByIdentity.get(identityKey)?.delete(callId);
  }
}

function assertIncrementalRawVisibleReferences(
  state: RuntimeEvidenceIncrementalState,
  record: RawEventLogRecord,
): void {
  const ownMessage = conversationMessageForRawEvent(record);

  for (const messageId of record.visibleMessageIds ?? []) {
    // A commit event carries the message it references, so it satisfies
    // its own reference before the message is registered.
    const message =
      ownMessage?.id === messageId
        ? ownMessage
        : state.messagesById.get(messageId);

    if (message === undefined) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        `Raw event references a missing visible conversation message: ${messageId}.`,
      );
    }

    if (
      runtimeEventIdentityKey(message) !== runtimeEventIdentityKey(record) ||
      message.createdAt !== record.createdAt
    ) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        `Raw event references a visible conversation message from another event: ${messageId}.`,
      );
    }
  }
}

/**
 * Checked live so a writer cannot append a row the cold gate would reject,
 * stranding the session as unreadable on the next start.
 */
function assertIncrementalVisibleCommitShape(
  state: RuntimeEvidenceIncrementalState,
  record: RawEventLogRecord,
): void {
  if (record.kind !== 'visible_message_committed') {
    return;
  }

  const messageIds = record.visibleMessageIds ?? [];

  if (messageIds.length !== 1) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'A visible_message_committed raw event must anchor exactly one conversation message.',
    );
  }

  for (const messageId of messageIds) {
    if (
      state.commitEventByMessageKey.has(
        visibleMessageEvidenceKey(record, messageId),
      )
    ) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        `Conversation message has more than one visible_message_committed raw event: ${messageId}.`,
      );
    }
  }

  const ownMessage = conversationMessageForRawEvent(record);

  if (ownMessage === undefined) {
    return;
  }

  const identityKey = runtimeEventIdentityKey(record);
  const turnMessages = [
    ...(state.messageIdsByIdentity.get(identityKey) ?? []).flatMap(
      messageId => {
        const message = state.messagesById.get(messageId);

        return message === undefined ? [] : [message];
      },
    ),
    ownMessage,
  ];

  assertSingleLeadingUserMessage(turnMessages);
  assertVisibleMessageCommitEvidence(ownMessage, record);

  const commitEventByMessageKey = new Map<string, RawEventLogRecord>();

  for (const message of turnMessages) {
    const key = visibleMessageEvidenceKey(message, message.id);
    const commitEvent = state.commitEventByMessageKey.get(key);

    if (commitEvent !== undefined) {
      commitEventByMessageKey.set(key, commitEvent);
    }
  }

  commitEventByMessageKey.set(
    visibleMessageEvidenceKey(record, ownMessage.id),
    record,
  );
  assertCharacterRowsFollowTheirDecision(turnMessages, commitEventByMessageKey);
}

function assertIncrementalRecordedModelInput(
  state: RuntimeEvidenceIncrementalState,
  record: RawEventLogRecord,
): void {
  const texts = turnModelInputTexts(record);
  const recorded = state.turnModelInputByIdentity.get(
    runtimeEventIdentityKey(record),
  );

  assertAgreedModelInputText(
    recorded === undefined ? texts : [recorded, ...texts],
  );
}

function applyIncrementalTurnShapeState(
  state: RuntimeEvidenceIncrementalState,
  record: RawEventLogRecord,
): void {
  if (record.kind === 'visible_message_committed') {
    for (const messageId of record.visibleMessageIds ?? []) {
      state.commitEventByMessageKey.set(
        visibleMessageEvidenceKey(record, messageId),
        record,
      );
    }
  }

  const identityKey = runtimeEventIdentityKey(record);

  if (!state.turnModelInputByIdentity.has(identityKey)) {
    const text = turnModelInputTexts(record)[0];

    if (text !== undefined) {
      state.turnModelInputByIdentity.set(identityKey, text);
    }
  }
}

export function assertIncrementalConversationAppend(options: {
  readonly evidence: DurableRuntimeSessionEvidence;
  readonly sessionId?: string;
  readonly state: RuntimeEvidenceIncrementalState;
  readonly record: ConversationLogRecord;
  readonly expectedCharacter?: CharacterProfile;
  /**
   * The display name is a per-session historical fact, so the row's own
   * decision evidence supplies it on the session's first character row.
   */
  readonly recordCharacter?: CharacterProfile;
}): void {
  assertIncrementalIdentityTimestamp(options.state, options.record);
  const identityKey = runtimeEventIdentityKey(options.record);

  if (options.state.openRawIdentity !== identityKey) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Conversation message must belong to the active raw-event turn.',
    );
  }

  assertConversationMessageIdClimbs(options);

  const expectedCharacter =
    options.expectedCharacter ??
    options.state.roleModelCharacter ??
    options.state.conversationCharacter ??
    options.recordCharacter ??
    options.state.boundCharacter;

  if (expectedCharacter === undefined) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Conversation append requires a session character: none was expected, recorded, or store-bound.',
    );
  }

  for (const recordedCharacter of [
    options.state.roleModelCharacter,
    options.state.conversationCharacter,
  ]) {
    if (
      recordedCharacter !== undefined &&
      !sameCharacterProfiles(recordedCharacter, expectedCharacter)
    ) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Conversation character must match the durable session character evidence.',
      );
    }
  }

  // Runs before the record is accepted: the store's binding is a fact about
  // the store, not a default a caller outranks.
  validateDurableCharacterProfiles({
    roleModelCharacter: expectedCharacter,
    conversationCharacter: options.state.conversationCharacter,
    boundCharacter: options.state.boundCharacter,
  });

  const speakerIsValid =
    options.record.role === 'user'
      ? userRecordSpeakerIsValid(
          options.record,
          options.state.userSpeaker,
          options.state.boundUserSpeaker,
        )
      : speakerMatchesCharacter(options.record, expectedCharacter);

  if (!speakerIsValid) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      `Restored ${options.record.role} message speaker metadata is malformed.`,
    );
  }
}

// The first user record anchors the session's speaker name, judged by the
// same rule as every other name: a looser one here writes a session no
// later read accepts.
function userRecordSpeakerIsValid(
  record: {readonly speakerId: string; readonly speakerName: string},
  recordedUserSpeaker: SpeakerIdentity | undefined,
  boundUserSpeaker: SpeakerIdentity | undefined,
): boolean {
  if (recordedUserSpeaker !== undefined) {
    return (
      record.speakerId === recordedUserSpeaker.id &&
      record.speakerName === recordedUserSpeaker.displayName
    );
  }

  return (
    record.speakerId === (boundUserSpeaker?.id ?? localUserSpeaker.id) &&
    isValidSpeakerDisplayName(record.speakerName)
  );
}

export function applyIncrementalConversationAppend(
  state: RuntimeEvidenceIncrementalState,
  record: ConversationLogRecord,
): void {
  recordIncrementalIdentityTimestamp(state, record);
  state.messagesById.set(record.id, record);
  const identityKey = runtimeEventIdentityKey(record);
  const messageIds = state.messageIdsByIdentity.get(identityKey) ?? [];

  messageIds.push(record.id);
  state.messageIdsByIdentity.set(identityKey, messageIds);

  if (
    record.role === 'character' &&
    state.conversationCharacter === undefined
  ) {
    state.conversationCharacter = Object.freeze({
      id: record.speakerId,
      displayName: record.speakerName,
    } satisfies CharacterProfile);
  }
  if (record.role === 'user' && state.userSpeaker === undefined) {
    state.userSpeaker = Object.freeze({
      id: record.speakerId,
      displayName: record.speakerName,
    } satisfies SpeakerIdentity);
  }
}

/**
 * Message numbers climb rather than count: a failed write leaves a number
 * the log never sees, so only a repeat or a reversal is damage.
 */
function assertConversationMessageIdClimbs(options: {
  readonly evidence: DurableRuntimeSessionEvidence;
  readonly sessionId?: string;
  readonly state: RuntimeEvidenceIncrementalState;
  readonly record: ConversationLogRecord;
}): void {
  const messageNumber = messageNumberFromId(options.record.id);
  const messageSessionId = sessionIdFromMessageId(options.record.id);

  if (messageNumber === undefined || messageSessionId === undefined) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Restored visible message must have a sequential session message ID.',
    );
  }

  assertConversationMessageSessionId({...options, messageSessionId});

  const previousMessage = options.evidence.conversationMessages.at(-1);
  const previousNumber =
    previousMessage === undefined
      ? 0
      : (messageNumberFromId(previousMessage.id) ?? 0);

  if (messageNumber <= previousNumber) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      `Restored visible message must climb in session order: "${options.record.id}" follows message ${String(previousNumber)}.`,
    );
  }
}

function assertConversationMessageSessionId(options: {
  readonly sessionId?: string;
  readonly state: RuntimeEvidenceIncrementalState;
  readonly messageSessionId: string;
}): void {
  const firstMessage = options.state.messagesById.values().next().value;
  const expectedSessionId =
    options.sessionId ??
    (firstMessage === undefined
      ? undefined
      : sessionIdFromMessageId(firstMessage.id));

  if (expectedSessionId === undefined) {
    assertValidLocalRuntimeSessionId(options.messageSessionId);
    return;
  }

  if (options.messageSessionId !== expectedSessionId) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      `Restored visible message must belong to session "${expectedSessionId}".`,
    );
  }
}

function assertValidLocalRuntimeSessionId(sessionId: string): void {
  try {
    normalizeLocalRuntimeSessionId(sessionId);
  } catch (error: unknown) {
    if (
      error instanceof LocalRuntimeStorageContractError &&
      error.code === 'invalid_session_id'
    ) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Restored visible message must contain a valid local runtime session ID.',
        {cause: error},
      );
    }

    throw error;
  }
}

function assertIncrementalIdentityTimestamp(
  state: RuntimeEvidenceIncrementalState,
  identity: RuntimeEventIdentity,
): void {
  const prior = state.createdAtByIdentity.get(
    runtimeEventBaseIdentityKey(identity),
  );

  if (prior !== undefined && prior !== identity.createdAt) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Runtime evidence for one event identity must share one createdAt timestamp.',
    );
  }
}

function recordIncrementalIdentityTimestamp(
  state: RuntimeEvidenceIncrementalState,
  identity: RuntimeEventIdentity,
): void {
  assertIncrementalIdentityTimestamp(state, identity);
  state.createdAtByIdentity.set(
    runtimeEventBaseIdentityKey(identity),
    identity.createdAt,
  );
}

function runtimeEventBaseIdentityKey(identity: {
  readonly eventId: string;
  readonly traceId: string;
}): string {
  return `${identity.eventId}\u0000${identity.traceId}`;
}

function assertRuntimeConfigEffectsHaveApprovedToolEvidence(
  rawEvents: readonly RawEventLogRecord[],
): void {
  const approvalRecords = approvalToolRecordsByCallId(rawEvents);

  for (const terminal of rawEvents) {
    if (terminal.kind !== 'runtime_turn_completed') {
      continue;
    }

    for (const effect of terminal.runtimeConfigEffects ?? []) {
      if (!runtimeConfigEffectHasLoggedApproval(effect, approvalRecords)) {
        throw new LocalRuntimeStorageContractError(
          'malformed_record',
          `Runtime config effect "${effect.effectId}" is missing matching approved config-update tool evidence.`,
        );
      }
    }
  }
}

function requiredToolCallId(rawEvent: RawEventLogRecord): string {
  if (rawEvent.toolCallId === undefined) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Tool call raw event is missing toolCallId.',
    );
  }

  return rawEvent.toolCallId;
}

function assertIncrementalCharacterEvidence(
  state: RuntimeEvidenceIncrementalState,
  rawEvent: RawEventLogRecord,
): void {
  const candidate = roleModelCharacterSnapshot(rawEvent);

  if (
    candidate !== undefined &&
    ((state.roleModelCharacter !== undefined &&
      !sameCharacterProfiles(state.roleModelCharacter, candidate)) ||
      (state.conversationCharacter !== undefined &&
        !sameCharacterProfiles(state.conversationCharacter, candidate)))
  ) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Role-model character evidence must identify one durable session character.',
    );
  }

  if (isTerminalRawEventLogRecord(rawEvent)) {
    validateDurableCharacterProfiles({
      roleModelCharacter: state.roleModelCharacter ?? candidate,
      conversationCharacter: state.conversationCharacter,
      boundCharacter: state.boundCharacter,
    });
  }
}

export function durableRuntimeSessionCharacterProfile(
  evidence: DurableRuntimeSessionEvidence,
  boundCharacter: CharacterProfile,
): CharacterProfile {
  return (
    durableCharacterProfile({
      messages: evidence.conversationMessages,
      rawEvents: evidence.rawEvents,
      boundCharacter,
    }) ?? boundCharacter
  );
}

/**
 * Pass an already-validated record list, never a raw decode; records with a
 * different createdAt are a different occurrence of the same ids.
 */
export function findRuntimeTurnTerminalRawEvent(
  rawEvents: readonly RawEventLogRecord[],
  identity: RuntimeEventIdentity,
): RawEventLogRecord | undefined {
  const matchingIdentityKey = runtimeEventIdentityKey(identity);

  return [...rawEvents]
    .reverse()
    .find(
      rawEvent =>
        isTerminalRawEventLogRecord(rawEvent) &&
        runtimeEventIdentityKey(rawEvent) === matchingIdentityKey &&
        rawEvent.createdAt === identity.createdAt,
    );
}
