import {
  conversationMessageForRawEvent,
  conversationMessagesFromRawEvents,
} from './cache.ts';
import {
  type CharacterProfile,
  ConversationRehydrationError,
  isValidSpeakerDisplayName,
  localUserSpeaker,
  messageNumberFromId,
  type RuntimeEventIdentity,
  type SpeakerIdentity,
  runtimeEventIdentityKey,
  sessionIdFromMessageId,
  validateRestoredVisibleTranscript,
} from '../../core/index.ts';
import {
  assertAgreedModelInputText,
  assertCharacterRowsFollowTheirDecision,
  assertConversationTurnShape,
  assertSingleLeadingUserMessage,
  assertVisibleMessageCommitEvidence,
  sameOrderedValues,
  turnModelInputTexts,
  visibleMessageEvidenceKey,
} from './turn-shape.ts';
import {
  LocalRuntimeStorageContractError,
  normalizeLocalRuntimeSessionId,
  type LocalRuntimeSessionPaths,
} from '../storage/layout-contract.ts';
import {decodeRawEventLogRecord} from '../storage/raw-event-codec.ts';
import type {ConversationLogRecord, RawEventLogRecord} from './records.ts';
import {isTerminalRawEventLogRecord} from './records.ts';
import {assertLocalRuntimeSessionReadable} from '../storage/session-store.ts';
import {
  readOptionalStoreText,
  readStoreJsonLines,
} from '../storage/store-file.ts';
import {
  approvalToolRecordsByCallId,
  runtimeConfigEffectHasLoggedApproval,
} from './config-effect-approval.ts';
import type {
  DurableRuntimeSessionEvidence,
  RuntimeEvidenceIncrementalState,
  RuntimeLogReadMode,
  RuntimeLogValidationMode,
} from './contract.ts';
import {
  assertRoleModelEvidenceMatchesSessionId,
  durableCharacterProfile,
  recordedConversationCharacterProfile,
  recordedRoleModelCharacterProfile,
  recordedUserSpeakerIdentity,
  roleModelCharacterSnapshot,
  sameCharacterProfiles,
  speakerMatchesCharacter,
  validateDurableCharacterProfiles,
  validateDurableRuntimeSessionIdentity,
} from './identity.ts';

export function createRuntimeEvidenceIncrementalState(
  evidence: DurableRuntimeSessionEvidence,
  boundCharacter?: CharacterProfile,
  boundUserSpeaker?: SpeakerIdentity,
): RuntimeEvidenceIncrementalState {
  const state: RuntimeEvidenceIncrementalState = {
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
    roleModelCharacter: recordedRoleModelCharacterProfile(evidence.rawEvents),
    conversationCharacter: recordedConversationCharacterProfile(
      evidence.conversationMessages,
    ),
    boundCharacter,
    userSpeaker: recordedUserSpeakerIdentity(evidence.conversationMessages),
    boundUserSpeaker,
    openRawIdentity: undefined,
    openTurnConversationStart: evidence.conversationMessages.length,
  };

  for (const rawEvent of evidence.rawEvents) {
    recordIncrementalIdentityTimestamp(state, rawEvent);
    const identityKey = runtimeEventIdentityKey(rawEvent);
    const kinds = state.rawKindsByIdentity.get(identityKey) ?? new Set();

    kinds.add(rawEvent.kind);
    state.rawKindsByIdentity.set(identityKey, kinds);

    if (
      rawEvent.kind === 'runtime_turn_completed' ||
      rawEvent.kind === 'runtime_turn_rejected'
    ) {
      state.terminalRawByIdentity.set(identityKey, rawEvent.kind);
    }

    applyIncrementalToolCallState(state, rawEvent);
    applyIncrementalTurnShapeState(state, rawEvent);
  }

  for (const message of evidence.conversationMessages) {
    recordIncrementalIdentityTimestamp(state, message);
    state.messagesById.set(message.id, message);
    const identityKey = runtimeEventIdentityKey(message);
    const messageIds = state.messageIdsByIdentity.get(identityKey) ?? [];

    messageIds.push(message.id);
    state.messageIdsByIdentity.set(identityKey, messageIds);
  }

  return state;
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

  // A turn starting implicitly closes any turn a crash left open — that
  // is what a resumed session looks like. Any other record must belong to
  // the turn that is open.
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
 * The turn-shape rules of {@link assertConversationTurnShape} that a
 * commit-event append can already violate, checked before the row is
 * accepted. The cold gate re-states the whole shape on a fresh read; this
 * keeps a live writer from appending a row that gate would reject, which
 * would strand the session as unreadable on the next start.
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

  // The store's binding is a fact about the store, not a default the
  // caller outranks. The precedence above reads the other way — a
  // supplied character wins, and the loop only compares against evidence
  // already recorded — so on a session with none, a caller could append
  // `nova` into a store bound to `mira`. That append succeeded and
  // mutated durable state; the refusal arrived one call later, on the
  // terminal raw event, by which point the messages were on disk.
  //
  // Same rule, same function, same message as that later refusal and as
  // every cold read: id only, so a renamed character's sessions stay
  // appendable. Only the timing changes — the check now runs before the
  // record is accepted rather than after.
  validateDurableCharacterProfiles({
    roleModelCharacter: expectedCharacter,
    conversationCharacter: options.state.conversationCharacter,
    boundCharacter: options.state.boundCharacter,
    allowUnanchoredCustomCharacter: false,
  });

  const speakerIsValid =
    options.record.role === 'user'
      ? userRecordSpeakerIsValid(
          options.record,
          options.state.userSpeaker ?? options.state.boundUserSpeaker,
        )
      : speakerMatchesCharacter(options.record, expectedCharacter);

  if (!speakerIsValid) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      `Restored ${options.record.role} message speaker metadata is malformed.`,
    );
  }
}

// With no recorded and no store-bound user speaker, the first user
// record anchors the session's speaker (a direct-runtime store may
// carry a custom display name); the id is never negotiable.
//
// The anchoring name is judged by the same rule every other speaker
// name is. A looser check here only decided *which* write produced an
// unreadable session: a non-empty but multiline or overlong name was
// accepted and appended, and the next read of that session ran it
// through `createUserSpeaker`, which rejects it — so the store held
// durable evidence that could never be opened again. Two boundaries
// judging one field by two rules, with the lenient one writing first.
function userRecordSpeakerIsValid(
  record: {readonly speakerId: string; readonly speakerName: string},
  expectedUserSpeaker: SpeakerIdentity | undefined,
): boolean {
  return expectedUserSpeaker === undefined
    ? record.speakerId === localUserSpeaker.id &&
        isValidSpeakerDisplayName(record.speakerName)
    : record.speakerId === expectedUserSpeaker.id &&
        record.speakerName === expectedUserSpeaker.displayName;
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
 * A message ID names its session and climbs.
 *
 * Climbing rather than counting: the session chooses message numbers and
 * the log records them, so a write that failed leaves a number the log
 * never sees. Demanding the next number here would make the session's own
 * count a second answer to a question it already answers, and the two
 * would disagree on exactly the lagging log this design expects. What a
 * damaged or forged log looks like is a number that repeats or goes
 * backwards, and that is what this rejects.
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

function findValidatedTerminalRawEventForIdentity(
  rawEvents: readonly RawEventLogRecord[],
  identity: RuntimeEventIdentity,
): RawEventLogRecord | undefined {
  assertRawEventTerminalOrder(rawEvents);
  assertRawEventStartsWithReceived(rawEvents);
  assertRawEventTurnsDoNotOverlap(rawEvents);
  assertToolCallRawEventsAreComplete(rawEvents);

  const matchingIdentityKey = runtimeEventIdentityKey(identity);
  const createdAtByIdentity = new Map<string, string>();

  for (const rawEvent of rawEvents) {
    const baseIdentityKey = runtimeEventBaseIdentityKey(rawEvent);
    const priorCreatedAt = createdAtByIdentity.get(baseIdentityKey);

    if (priorCreatedAt !== undefined && priorCreatedAt !== rawEvent.createdAt) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Raw event log contains inconsistent createdAt values for one event identity.',
      );
    }

    createdAtByIdentity.set(baseIdentityKey, rawEvent.createdAt);
  }

  if (
    createdAtByIdentity.get(runtimeEventBaseIdentityKey(identity)) !==
    identity.createdAt
  ) {
    return undefined;
  }

  return [...rawEvents]
    .reverse()
    .find(
      rawEvent =>
        isTerminalRawEventLogRecord(rawEvent) &&
        runtimeEventIdentityKey(rawEvent) === matchingIdentityKey,
    );
}

export function findValidatedTerminalRawEventForSession(
  paths: LocalRuntimeSessionPaths,
  identity: RuntimeEventIdentity,
): RawEventLogRecord | undefined {
  assertLocalRuntimeSessionReadable({
    storeRoot: paths.storeRoot,
    sessionId: paths.sessionId,
  });

  const evidence = readRuntimeSessionEvidence(paths, 'publicDecode');

  assertDurableRuntimeSessionEvidence({
    paths,
    evidence,
    mode: 'appendRawEvent',
  });

  return findValidatedTerminalRawEventForIdentity(evidence.rawEvents, identity);
}

function readValidatedRuntimeSessionEvidence(
  paths: LocalRuntimeSessionPaths,
  mode: RuntimeLogValidationMode,
): DurableRuntimeSessionEvidence {
  const evidence = readRuntimeSessionEvidence(paths, 'publicDecode');

  assertDurableRuntimeSessionEvidence({
    paths,
    evidence,
    mode,
  });

  return evidence;
}

function readRuntimeSessionEvidence(
  paths: LocalRuntimeSessionPaths,
  readMode: RuntimeLogReadMode,
): DurableRuntimeSessionEvidence {
  return Object.freeze({
    rawEvents: readRawEventLogRecords(paths, readMode),
    conversationMessages: readConversationLogRecords(paths, readMode),
  } satisfies DurableRuntimeSessionEvidence);
}

export function assertDurableRuntimeSessionEvidence(options: {
  readonly paths: LocalRuntimeSessionPaths;
  readonly evidence: DurableRuntimeSessionEvidence;
  readonly mode: RuntimeLogValidationMode;
  readonly boundCharacter?: CharacterProfile;
  readonly boundUserSpeaker?: SpeakerIdentity;
  readonly nextConversationMessage?: ConversationLogRecord;
  readonly nextRawEvent?: RawEventLogRecord;
}): void {
  const rawEvents = Object.freeze([
    ...options.evidence.rawEvents,
    ...(options.nextRawEvent === undefined ? [] : [options.nextRawEvent]),
  ]);
  const conversationMessages = Object.freeze([
    ...options.evidence.conversationMessages,
    ...(options.nextConversationMessage === undefined
      ? []
      : [options.nextConversationMessage]),
  ]);

  // A trailing turn with no terminal event is not checked for here: a
  // crash produces exactly that log, so it is a state the reader
  // surfaces, never damage it rejects.
  assertRuntimeEvidenceCreatedAtAgreement(rawEvents);
  assertRawEventTerminalOrder(rawEvents);
  assertRawEventStartsWithReceived(rawEvents);
  assertRawEventTurnsDoNotOverlap(rawEvents);
  assertToolCallRawEventsAreComplete(rawEvents);
  assertRawEventVisibleReferencesMatchConversationMessages({
    messages: conversationMessages,
    rawEvents,
  });
  const identity = validateDurableRuntimeSessionIdentity({
    paths: options.paths,
    evidence: {rawEvents, conversationMessages},
    boundCharacter: options.boundCharacter,
    boundUserSpeaker: options.boundUserSpeaker,
    allowUnanchoredCustomCharacter: false,
  });

  assertRestoredConversationInvariants(options.paths, conversationMessages, {
    ...(identity.character === undefined
      ? {}
      : {character: identity.character}),
    ...(identity.userSpeaker === undefined
      ? {}
      : {userDisplayName: identity.userSpeaker.displayName}),
  });
  assertConversationTurnShape({
    messages: conversationMessages,
    rawEvents,
  });
}

function assertRuntimeEvidenceCreatedAtAgreement(
  rawEvents: readonly RawEventLogRecord[],
): void {
  const createdAtByIdentity = new Map<string, string>();

  for (const record of rawEvents) {
    const key = runtimeEventBaseIdentityKey(record);
    const prior = createdAtByIdentity.get(key);

    if (prior !== undefined && prior !== record.createdAt) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Runtime evidence for one event identity must share one createdAt timestamp.',
      );
    }

    createdAtByIdentity.set(key, record.createdAt);
  }
}

function assertToolCallRawEventsAreComplete(
  rawEvents: readonly RawEventLogRecord[],
): void {
  const started = new Map<string, RawEventLogRecord>();
  const finished = new Map<string, RawEventLogRecord>();
  const completedTerminalIdentityKeys = new Set(
    rawEvents
      .filter(rawEvent => rawEvent.kind === 'runtime_turn_completed')
      .map(runtimeEventIdentityKey),
  );

  for (const rawEvent of rawEvents) {
    if (rawEvent.kind === 'tool_call_started') {
      const callId = requiredToolCallId(rawEvent);

      if (started.has(callId)) {
        throw new LocalRuntimeStorageContractError(
          'malformed_record',
          `Tool call started more than once: ${callId}.`,
        );
      }

      started.set(callId, rawEvent);
      continue;
    }

    if (rawEvent.kind === 'tool_call_finished') {
      const callId = requiredToolCallId(rawEvent);

      if (!started.has(callId)) {
        throw new LocalRuntimeStorageContractError(
          'malformed_record',
          `Tool call finished before start: ${callId}.`,
        );
      }

      if (finished.has(callId)) {
        throw new LocalRuntimeStorageContractError(
          'malformed_record',
          `Tool call finished more than once: ${callId}.`,
        );
      }

      finished.set(callId, rawEvent);
    }
  }

  for (const [callId, rawEvent] of started) {
    if (finished.has(callId)) {
      continue;
    }

    // A crash mid-call leaves started-without-finish in an unterminated
    // or rejected turn; only a turn that claims completion may not.
    if (!completedTerminalIdentityKeys.has(runtimeEventIdentityKey(rawEvent))) {
      continue;
    }

    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      `Tool call started without finish: ${callId}.`,
    );
  }

  for (const rawEvent of rawEvents.filter(isTerminalRawEventLogRecord)) {
    for (const callId of rawEvent.toolCallIds ?? []) {
      if (finished.has(callId)) {
        continue;
      }

      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        `Terminal raw event references unfinished tool call: ${callId}.`,
      );
    }
  }
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

function readRawEventLogRecords(
  paths: LocalRuntimeSessionPaths,
  mode: RuntimeLogReadMode = 'public',
): readonly RawEventLogRecord[] {
  if (mode === 'public') {
    return readValidatedRuntimeSessionEvidence(paths, 'public').rawEvents;
  }

  const records = readJsonLines({
    filePath: paths.rawEventsPath,
    decodeLine: line => decodeRawEventLogRecord(line),
    missingFileIsAllowed: () => true,
    emptyFileIsAllowed: () => true,
  });

  return Object.freeze(records);
}

function readConversationLogRecords(
  paths: LocalRuntimeSessionPaths,
  mode: RuntimeLogReadMode = 'public',
): readonly ConversationLogRecord[] {
  if (mode === 'public') {
    return readValidatedRuntimeSessionEvidence(paths, 'public')
      .conversationMessages;
  }

  return conversationMessagesFromRawEvents(readRawEventLogRecords(paths, mode));
}

function assertRestoredConversationInvariants(
  paths: LocalRuntimeSessionPaths,
  messages: readonly ConversationLogRecord[],
  options: {
    readonly character?: CharacterProfile;
    readonly userDisplayName?: string;
  } = {},
): void {
  try {
    validateRestoredVisibleTranscript({
      id: paths.sessionId,
      ...(options.userDisplayName === undefined
        ? {}
        : {userDisplayName: options.userDisplayName}),
      // The character is undefined only for transcripts with zero
      // character-role messages (it is derived from them), so the
      // placeholder below can never be consulted by a speaker check.
      character: options.character ?? unboundSessionCharacterPlaceholder,
      visibleTranscript: messages,
    });
  } catch (error: unknown) {
    if (error instanceof ConversationRehydrationError) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        error.message,
      );
    }

    throw error;
  }
}

const unboundSessionCharacterPlaceholder: CharacterProfile = Object.freeze({
  id: 'runtime.unbound-character',
  displayName: 'Runtime Unbound Character',
});

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
      allowUnanchoredCustomCharacter: false,
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
      allowUnanchoredCustomCharacter: false,
    }) ?? boundCharacter
  );
}

function assertRawEventStartsWithReceived(
  rawEvents: readonly RawEventLogRecord[],
): void {
  const startedRawEventIdentities = new Set<string>();

  for (const rawEvent of rawEvents) {
    const identityKey = runtimeEventIdentityKey(rawEvent);

    if (startedRawEventIdentities.has(identityKey)) {
      continue;
    }

    if (rawEvent.kind !== 'runtime_event_received') {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Raw event log turn evidence must start with runtime_event_received.',
      );
    }

    startedRawEventIdentities.add(identityKey);
  }
}

function assertRawEventTerminalOrder(
  rawEvents: readonly RawEventLogRecord[],
): void {
  assertTerminalEvidenceOrder({
    records: rawEvents,
    isTerminalRecord: isTerminalRawEventLogRecord,
    isPrerequisiteEvidence: rawEvent =>
      rawEvent.kind === 'runtime_event_received',
    isAllowedAfterTerminalRecord: rawEvent =>
      rawEvent.kind === 'after_turn_committed',
    recordAfterTerminalMessage:
      'Raw event log contains records after terminal turn evidence.',
    terminalWithoutPrerequisiteMessage:
      'Raw event log contains terminal turn evidence before start evidence.',
  });
}

function assertTerminalEvidenceOrder<T extends RuntimeEventIdentity>(options: {
  readonly records: readonly T[];
  readonly isTerminalRecord: (record: T) => boolean;
  readonly isPrerequisiteEvidence: (record: T) => boolean;
  readonly isAllowedAfterTerminalRecord?: (record: T) => boolean;
  readonly recordAfterTerminalMessage: string;
  readonly terminalWithoutPrerequisiteMessage: string;
}): void {
  const prerequisiteEvidenceIdentities = new Set<string>();
  const terminalTurnIdentities = new Set<string>();

  for (const record of options.records) {
    const identityKey = runtimeEventIdentityKey(record);

    if (
      terminalTurnIdentities.has(identityKey) &&
      options.isAllowedAfterTerminalRecord?.(record) !== true
    ) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        options.recordAfterTerminalMessage,
      );
    }

    if (options.isTerminalRecord(record)) {
      if (!prerequisiteEvidenceIdentities.has(identityKey)) {
        throw new LocalRuntimeStorageContractError(
          'malformed_record',
          options.terminalWithoutPrerequisiteMessage,
        );
      }

      terminalTurnIdentities.add(identityKey);
      continue;
    }

    if (options.isPrerequisiteEvidence(record)) {
      prerequisiteEvidenceIdentities.add(identityKey);
    }
  }
}

function assertRawEventTurnsDoNotOverlap(
  rawEvents: readonly RawEventLogRecord[],
): void {
  let openTurnIdentity: string | undefined;

  for (const rawEvent of rawEvents) {
    const identityKey = runtimeEventIdentityKey(rawEvent);

    if (rawEvent.kind === 'after_turn_committed') {
      continue;
    }

    // A turn start closes any turn a crash left open; only a non-start
    // record belonging to neither the open turn nor a new one overlaps.
    if (
      rawEvent.kind !== 'runtime_event_received' &&
      openTurnIdentity !== undefined &&
      openTurnIdentity !== identityKey
    ) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Raw event log contains overlapping turn evidence.',
      );
    }

    if (isTerminalRawEventLogRecord(rawEvent)) {
      openTurnIdentity = undefined;
      continue;
    }

    openTurnIdentity = identityKey;
  }
}

function assertRawEventVisibleReferencesMatchConversationMessages(options: {
  readonly messages: readonly ConversationLogRecord[];
  readonly rawEvents: readonly RawEventLogRecord[];
}): void {
  const messagesById = new Map(
    options.messages.map(message => [message.id, message]),
  );

  for (const rawEvent of options.rawEvents) {
    for (const messageId of rawEvent.visibleMessageIds ?? []) {
      const message = messagesById.get(messageId);

      if (message === undefined) {
        throw new LocalRuntimeStorageContractError(
          'malformed_record',
          `Raw event references a missing visible conversation message: ${messageId}.`,
        );
      }

      if (
        message.eventId !== rawEvent.eventId ||
        message.traceId !== rawEvent.traceId
      ) {
        throw new LocalRuntimeStorageContractError(
          'malformed_record',
          `Raw event references a visible conversation message from another event: ${messageId}.`,
        );
      }
    }
  }
}

function readJsonLines<T>(options: {
  readonly filePath: string;
  readonly decodeLine: (line: string) => T;
  readonly missingFileIsAllowed: () => boolean;
  readonly emptyFileIsAllowed: () => boolean;
}): T[] {
  const content = readOptionalStoreText(options.filePath);

  if (content === undefined) {
    if (!options.missingFileIsAllowed()) {
      throw new LocalRuntimeStorageContractError(
        'missing_file',
        `Required local runtime log file is missing: ${options.filePath}.`,
      );
    }

    return [];
  }

  if (content.length === 0) {
    if (!options.emptyFileIsAllowed()) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        `Required local runtime log file is empty: ${options.filePath}.`,
      );
    }

    return [];
  }

  return readStoreJsonLines(options.filePath, content).map(options.decodeLine);
}
