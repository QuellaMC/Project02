import { existsSync, readFileSync } from 'node:fs';
import {
  ConversationRehydrationError,
  localCharacterProfile,
  selectRecentVisibleMessages,
  type CharacterProfile,
  type VisibleMessage,
  validateRestoredVisibleTranscript
} from '../../core/conversation.ts';
import {
  LocalRuntimeStorageContractError,
  type LocalRuntimeSessionPaths
} from './layout-contract.ts';
import { decodeConversationLogRecord } from './conversation-codec.ts';
import { decodeRawEventLogRecord } from './raw-event-codec.ts';
import {
  decodeRuntimeTraceEntry,
  encodeRuntimeTraceEntry
} from './trace-codec.ts';
import type {
  ConversationLogRecord,
  RawEventLogRecord,
  RuntimeDerivedTraceEntry,
  RuntimeTraceEntry
} from '../log.ts';
import { isTerminalRawEventLogRecord } from '../log.ts';
import type { RuntimeEventIdentity } from '../event.ts';
import { assertLocalRuntimeSessionReadable } from './session-store.ts';
import type {
  DurableRuntimeSessionEvidence,
  RuntimeEvidenceIncrementalState,
  RuntimeLogReadMode,
  RuntimeLogValidationMode,
  RuntimeTurnEvidenceState
} from './runtime-evidence-contract.ts';

export function deriveTerminalRawTraceEvidence(
  evidence: DurableRuntimeSessionEvidence
): readonly RuntimeDerivedTraceEntry[] {
  const derived: RuntimeDerivedTraceEntry[] = [];
  const traceStepsByIdentity = new Map<string, Set<RuntimeTraceEntry['step']>>();

  for (const entry of evidence.traceEntries) {
    const key = runtimeEventIdentityKey(entry);
    const steps = traceStepsByIdentity.get(key) ?? new Set();

    steps.add(entry.step);
    traceStepsByIdentity.set(key, steps);
  }

  for (const rawEvent of evidence.rawEvents) {
    if (
      rawEvent.kind !== 'runtime_turn_completed' &&
      rawEvent.kind !== 'runtime_turn_rejected'
    ) {
      continue;
    }

    const terminalStep = terminalTraceStepForRawEvent(rawEvent);
    const key = runtimeEventIdentityKey(rawEvent);
    const steps = traceStepsByIdentity.get(key) ?? new Set();

    for (const step of ['raw_event_log_appended', terminalStep] as const) {
      if (steps.has(step)) {
        continue;
      }

      steps.add(step);
      derived.push(
        Object.freeze({
          eventId: rawEvent.eventId,
          traceId: rawEvent.traceId,
          createdAt: rawEvent.createdAt,
          step,
          provenance: Object.freeze({
            source: 'terminal_raw_event',
            reason: 'missing_persisted_trace_entry',
            rawEventAnchor: Object.freeze({
              eventId: rawEvent.eventId,
              traceId: rawEvent.traceId,
              createdAt: rawEvent.createdAt,
              kind: rawEvent.kind
            })
          })
        } satisfies RuntimeDerivedTraceEntry)
      );
    }

    traceStepsByIdentity.set(key, steps);
  }

  return Object.freeze(derived);
}

export function createRuntimeEvidenceIncrementalState(
  paths: LocalRuntimeSessionPaths,
  evidence: DurableRuntimeSessionEvidence
): RuntimeEvidenceIncrementalState {
  const derivedTraceEntries = deriveTerminalRawTraceEvidence(evidence);
  const evidenceForValidation = reconcileTerminalRawTraceEvidence(evidence);

  assertDurableRuntimeSessionEvidence({
    paths,
    evidence: evidenceForValidation,
    mode: 'public'
  });

  const state: RuntimeEvidenceIncrementalState = {
    createdAtByIdentity: new Map(),
    traceStepsByIdentity: new Map(),
    traceStartedWithoutRaw: new Set(),
    terminalTraceByIdentity: new Map(),
    rawKindsByIdentity: new Map(),
    terminalRawByIdentity: new Map(),
    missingStoredTerminalTraceEvidence: new Set(
      derivedTraceEntries.map(traceStepEvidenceKey)
    ),
    startedToolCalls: new Map(),
    finishedToolCalls: new Set(),
    unfinishedToolCallIdsByIdentity: new Map(),
    messagesById: new Map(),
    messageIdsByIdentity: new Map(),
    roleModelCharacter: recordedRoleModelCharacterProfile(evidence.rawEvents),
    conversationCharacter: recordedConversationCharacterProfile(
      evidence.conversationMessages
    ),
    openRawIdentity: undefined,
    openTurnConversationStart: evidence.conversationMessages.length
  };

  for (const entry of evidenceForValidation.traceEntries) {
    recordIncrementalIdentityTimestamp(state, entry);
    const identityKey = runtimeEventIdentityKey(entry);
    const steps = state.traceStepsByIdentity.get(identityKey) ?? new Set();

    steps.add(entry.step);
    state.traceStepsByIdentity.set(identityKey, steps);

    if (isTerminalRuntimeTraceEntry(entry)) {
      state.terminalTraceByIdentity.set(identityKey, entry.step);
    }
  }

  for (const rawEvent of evidence.rawEvents) {
    recordIncrementalIdentityTimestamp(state, rawEvent);
    const identityKey = runtimeEventIdentityKey(rawEvent);
    const kinds = state.rawKindsByIdentity.get(identityKey) ?? new Set();

    kinds.add(rawEvent.kind);
    state.rawKindsByIdentity.set(identityKey, kinds);

    if (isTerminalRawEventLogRecord(rawEvent)) {
      state.terminalRawByIdentity.set(
        identityKey,
        terminalTraceStepForRawEvent(rawEvent)
      );
    }

    applyIncrementalToolCallState(state, rawEvent);
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

export function assertIncrementalTraceAppend(
  state: RuntimeEvidenceIncrementalState,
  entry: RuntimeTraceEntry
): void {
  assertIncrementalIdentityTimestamp(state, entry);
  const identityKey = runtimeEventIdentityKey(entry);
  const steps = state.traceStepsByIdentity.get(identityKey);

  if (steps === undefined && entry.step !== 'runtime_event_received') {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Runtime trace log turn evidence must start with runtime_event_received.'
    );
  }

  if (state.terminalTraceByIdentity.has(identityKey)) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Runtime trace log contains steps after terminal turn evidence.'
    );
  }

  if (isTerminalRuntimeTraceEntry(entry)) {
    const terminalRaw = state.terminalRawByIdentity.get(identityKey);

    if (terminalRaw !== entry.step) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Terminal runtime trace evidence requires matching terminal raw-event evidence.'
      );
    }
  }
}

export function applyIncrementalTraceAppend(
  state: RuntimeEvidenceIncrementalState,
  entry: RuntimeTraceEntry
): void {
  recordIncrementalIdentityTimestamp(state, entry);
  const identityKey = runtimeEventIdentityKey(entry);
  const steps = state.traceStepsByIdentity.get(identityKey) ?? new Set();

  steps.add(entry.step);
  state.traceStepsByIdentity.set(identityKey, steps);
  state.missingStoredTerminalTraceEvidence.delete(traceStepEvidenceKey(entry));

  if (isTerminalRuntimeTraceEntry(entry)) {
    state.terminalTraceByIdentity.set(identityKey, entry.step);
  }

  if (
    entry.step === 'runtime_event_received' &&
    !state.rawKindsByIdentity.has(identityKey)
  ) {
    state.traceStartedWithoutRaw.add(identityKey);
  }
}

export function assertIncrementalRawEventAppend(options: {
  readonly paths: LocalRuntimeSessionPaths;
  readonly evidence: DurableRuntimeSessionEvidence;
  readonly state: RuntimeEvidenceIncrementalState;
  readonly record: RawEventLogRecord;
}): void {
  const { record, state } = options;
  assertIncrementalIdentityTimestamp(state, record);
  const identityKey = runtimeEventIdentityKey(record);
  const priorKinds = state.rawKindsByIdentity.get(identityKey);
  const terminalKind = state.terminalRawByIdentity.get(identityKey);

  if (priorKinds === undefined && record.kind !== 'runtime_event_received') {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Raw event log turn evidence must start with runtime_event_received.'
    );
  }

  if (terminalKind !== undefined && record.kind !== 'after_turn_committed') {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Raw event log contains records after terminal turn evidence.'
    );
  }

  if (
    record.kind !== 'after_turn_committed' &&
    state.openRawIdentity !== undefined &&
    state.openRawIdentity !== identityKey
  ) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Raw event log contains overlapping turn evidence.'
    );
  }

  if (
    record.kind !== 'after_turn_committed' &&
    !state.traceStepsByIdentity.get(identityKey)?.has('runtime_event_received')
  ) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Raw event log contains started turn evidence without matching runtime trace start evidence.'
    );
  }

  if (
    isTerminalRawEventLogRecord(record) &&
    state.openRawIdentity !== identityKey
  ) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Raw event log contains terminal turn evidence before start evidence.'
    );
  }

  assertIncrementalToolCallAppend(state, record);
  assertIncrementalRawVisibleReferences(state, record);
  assertIncrementalCharacterEvidence(state, record);
  assertRoleModelInputTextMatchesCommittedUserMessage({
    messagesById: state.messagesById,
    rawEvent: record
  });
  assertRoleModelEvidenceMatchesSessionPath({
    paths: options.paths,
    rawEvents: [record]
  });
  assertIncrementalRoleModelRecentContext({
    evidence: options.evidence,
    state,
    record
  });

  if (isTerminalRawEventLogRecord(record)) {
    const unfinished = state.unfinishedToolCallIdsByIdentity.get(identityKey);
    const turnMessageIds = state.messageIdsByIdentity.get(identityKey) ?? [];

    if (turnMessageIds.length !== 0 && turnMessageIds.length !== 2) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'A terminal runtime turn must commit exactly one user/character message pair.'
      );
    }

    if (record.kind === 'runtime_turn_completed' && (unfinished?.size ?? 0) > 0) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        `Tool call started without finish: ${unfinished?.values().next().value ?? 'unknown'}.`
      );
    }

    for (const callId of record.toolCallIds ?? []) {
      if (!state.finishedToolCalls.has(callId)) {
        throw new LocalRuntimeStorageContractError(
          'malformed_record',
          `Terminal raw event references unfinished tool call: ${callId}.`
        );
      }
    }

    if (record.kind === 'runtime_turn_completed') {
      if (!sameOrderedValues(record.visibleMessageIds ?? [], turnMessageIds)) {
        throw new LocalRuntimeStorageContractError(
          'malformed_record',
          'Completed terminal raw-event evidence must exactly match the visible conversation messages for that turn.'
        );
      }
    }
  }
}

export function applyIncrementalRawEventAppend(options: {
  readonly evidence: DurableRuntimeSessionEvidence;
  readonly state: RuntimeEvidenceIncrementalState;
  readonly record: RawEventLogRecord;
}): void {
  const { record, state } = options;
  recordIncrementalIdentityTimestamp(state, record);
  const identityKey = runtimeEventIdentityKey(record);
  const kinds = state.rawKindsByIdentity.get(identityKey) ?? new Set();

  kinds.add(record.kind);
  state.rawKindsByIdentity.set(identityKey, kinds);
  applyIncrementalToolCallState(state, record);
  const character = roleModelCharacterSnapshot(record);

  if (state.roleModelCharacter === undefined && character !== undefined) {
    state.roleModelCharacter = character;
  }

  if (record.kind === 'after_turn_committed') {
    return;
  }

  if (record.kind === 'runtime_event_received') {
    state.openRawIdentity = identityKey;
    state.openTurnConversationStart = options.evidence.conversationMessages.length;
    state.traceStartedWithoutRaw.delete(identityKey);
  }

  if (isTerminalRawEventLogRecord(record)) {
    const traceSteps = state.traceStepsByIdentity.get(identityKey) ?? new Set();
    const terminalStep = terminalTraceStepForRawEvent(record);

    for (const step of ['raw_event_log_appended', terminalStep] as const) {
      if (!traceSteps.has(step)) {
        state.missingStoredTerminalTraceEvidence.add(
          traceStepEvidenceKey({ ...record, step })
        );
      }
    }

    state.terminalRawByIdentity.set(
      identityKey,
      terminalStep
    );
    state.openRawIdentity = undefined;
  }
}

function assertIncrementalToolCallAppend(
  state: RuntimeEvidenceIncrementalState,
  record: RawEventLogRecord
): void {
  if (record.kind === 'tool_call_started') {
    const callId = requiredToolCallId(record);

    if (state.startedToolCalls.has(callId)) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        `Tool call started more than once: ${callId}.`
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
      `Tool call finished before start: ${callId}.`
    );
  }

  if (state.finishedToolCalls.has(callId)) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      `Tool call finished more than once: ${callId}.`
    );
  }

  if (started.identityKey !== runtimeEventIdentityKey(record)) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      `Tool call finished under another event identity: ${callId}.`
    );
  }
}

function applyIncrementalToolCallState(
  state: RuntimeEvidenceIncrementalState,
  record: RawEventLogRecord
): void {
  const identityKey = runtimeEventIdentityKey(record);

  if (record.kind === 'tool_call_started') {
    const callId = requiredToolCallId(record);
    state.startedToolCalls.set(callId, { identityKey, record });
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
  record: RawEventLogRecord
): void {
  for (const messageId of record.visibleMessageIds ?? []) {
    const message = state.messagesById.get(messageId);

    if (message === undefined) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        `Raw event references a missing visible conversation message: ${messageId}.`
      );
    }

    if (
      runtimeEventIdentityKey(message) !== runtimeEventIdentityKey(record) ||
      message.createdAt !== record.createdAt
    ) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        `Raw event references a visible conversation message from another event: ${messageId}.`
      );
    }
  }
}

function assertIncrementalRoleModelRecentContext(options: {
  readonly evidence: DurableRuntimeSessionEvidence;
  readonly state: RuntimeEvidenceIncrementalState;
  readonly record: RawEventLogRecord;
}): void {
  const recent =
    options.record.roleModelIOSnapshot?.inputEnvelope.decisionContext
      .recentVisibleMessages;

  if (recent === undefined) {
    return;
  }

  const end = options.state.openTurnConversationStart;
  const start = Math.max(0, end - recent.length);

  if (end - start !== recent.length) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Role-model recent visible context must match the durable prior conversation messages for the turn.'
    );
  }

  for (let index = 0; index < recent.length; index += 1) {
    const expected = options.evidence.conversationMessages[start + index];
    const actual = recent[index];

    if (
      expected === undefined ||
      actual === undefined ||
      !sameVisibleMessages([actual], [expected])
    ) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Role-model recent visible context must match the durable prior conversation messages for the turn.'
      );
    }
  }
}

export function assertIncrementalConversationAppend(options: {
  readonly paths: LocalRuntimeSessionPaths;
  readonly evidence: DurableRuntimeSessionEvidence;
  readonly state: RuntimeEvidenceIncrementalState;
  readonly record: ConversationLogRecord;
  readonly expectedCharacter?: CharacterProfile;
}): void {
  assertIncrementalIdentityTimestamp(options.state, options.record);
  const identityKey = runtimeEventIdentityKey(options.record);

  if (options.state.openRawIdentity !== identityKey) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Conversation message must belong to the active raw-event turn.'
    );
  }

  const messageNumber = options.evidence.conversationMessages.length + 1;
  const expectedId = `${options.paths.sessionId}:message-${String(messageNumber)}`;
  const expectedRole = messageNumber % 2 === 1 ? 'user' : 'character';

  if (options.record.id !== expectedId || options.record.role !== expectedRole) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      `Restored visible message must have sequential ID "${expectedId}" and preserve user/character commit order.`
    );
  }

  const expectedCharacter =
    options.expectedCharacter ??
    options.state.roleModelCharacter ??
    options.state.conversationCharacter ??
    localCharacterProfile;

  for (const recordedCharacter of [
    options.state.roleModelCharacter,
    options.state.conversationCharacter
  ]) {
    if (
      recordedCharacter !== undefined &&
      !sameCharacterProfiles(recordedCharacter, expectedCharacter)
    ) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Conversation character must match the durable session character evidence.'
      );
    }
  }

  const speakerIsValid =
    options.record.role === 'user'
      ? options.record.speakerId === 'local-user' &&
        options.record.speakerName === 'You'
      : speakerMatchesCharacter(options.record, expectedCharacter);

  if (!speakerIsValid) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      `Restored ${options.record.role} message speaker metadata is malformed.`
    );
  }
}

export function applyIncrementalConversationAppend(
  state: RuntimeEvidenceIncrementalState,
  record: ConversationLogRecord
): void {
  recordIncrementalIdentityTimestamp(state, record);
  state.messagesById.set(record.id, record);
  const identityKey = runtimeEventIdentityKey(record);
  const messageIds = state.messageIdsByIdentity.get(identityKey) ?? [];

  messageIds.push(record.id);
  state.messageIdsByIdentity.set(identityKey, messageIds);

  if (record.role === 'character' && state.conversationCharacter === undefined) {
    state.conversationCharacter = Object.freeze({
      id: record.speakerId,
      displayName: record.speakerName
    } satisfies CharacterProfile);
  }
}

export function applyIncrementalConversationRemoval(
  state: RuntimeEvidenceIncrementalState,
  messageIds: readonly string[]
): void {
  for (const messageId of messageIds) {
    const message = state.messagesById.get(messageId);

    if (message === undefined) {
      continue;
    }

    state.messagesById.delete(messageId);
    const identityKey = runtimeEventIdentityKey(message);
    const remainingIds =
      state.messageIdsByIdentity
        .get(identityKey)
        ?.filter((candidate) => candidate !== messageId) ?? [];

    if (remainingIds.length === 0) {
      state.messageIdsByIdentity.delete(identityKey);
    } else {
      state.messageIdsByIdentity.set(identityKey, remainingIds);
    }
  }

  state.conversationCharacter = recordedConversationCharacterProfile(
    [...state.messagesById.values()]
  );
}

function assertIncrementalIdentityTimestamp(
  state: RuntimeEvidenceIncrementalState,
  identity: RuntimeEventIdentity
): void {
  const prior = state.createdAtByIdentity.get(runtimeEventBaseIdentityKey(identity));

  if (prior !== undefined && prior !== identity.createdAt) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Runtime evidence for one event identity must share one createdAt timestamp.'
    );
  }
}

function recordIncrementalIdentityTimestamp(
  state: RuntimeEvidenceIncrementalState,
  identity: RuntimeEventIdentity
): void {
  assertIncrementalIdentityTimestamp(state, identity);
  state.createdAtByIdentity.set(
    runtimeEventBaseIdentityKey(identity),
    identity.createdAt
  );
}

function runtimeEventBaseIdentityKey(identity: {
  readonly eventId: string;
  readonly traceId: string;
}): string {
  return `${identity.eventId}\u0000${identity.traceId}`;
}

export function assertIncrementalStatePublicReadable(
  state: RuntimeEvidenceIncrementalState
): void {
  if (state.traceStartedWithoutRaw.size > 0 || state.openRawIdentity !== undefined) {
    throw new LocalRuntimeStorageContractError(
      'partial_write',
      'Local runtime evidence contains an unfinished turn from a prior writer.'
    );
  }

  validateDurableCharacterProfiles({
    roleModelCharacter: state.roleModelCharacter,
    conversationCharacter: state.conversationCharacter,
    allowUnanchoredCustomCharacter: false
  });
}

export function reconcileTerminalRawTraceEvidence(
  evidence: DurableRuntimeSessionEvidence
): DurableRuntimeSessionEvidence {
  const traceEntries = [...evidence.traceEntries];

  for (const rawEvent of evidence.rawEvents.filter(isTerminalRawEventLogRecord)) {
    if (
      rawEvent.kind !== 'runtime_turn_completed' &&
      rawEvent.kind !== 'runtime_turn_rejected'
    ) {
      continue;
    }

    const terminalStep: RuntimeTraceEntry['step'] = rawEvent.kind;
    const matchingSteps = new Set(
      traceEntries
        .filter(
          (entry) =>
            entry.eventId === rawEvent.eventId &&
            entry.traceId === rawEvent.traceId
        )
        .map((entry) => entry.step)
    );

    for (const step of ['raw_event_log_appended', terminalStep] as const) {
      if (matchingSteps.has(step)) {
        continue;
      }

      const entry = decodeRuntimeTraceEntry(
        encodeRuntimeTraceEntry({
          eventId: rawEvent.eventId,
          traceId: rawEvent.traceId,
          createdAt: rawEvent.createdAt,
          step
        })
      );

      matchingSteps.add(step);

      if (step === 'raw_event_log_appended') {
        const storedTerminalIndex = traceEntries.findIndex(
          (candidate) =>
            runtimeEventIdentityKey(candidate) ===
              runtimeEventIdentityKey(rawEvent) &&
            candidate.step === terminalStep
        );

        if (storedTerminalIndex >= 0) {
          traceEntries.splice(storedTerminalIndex, 0, entry);
          continue;
        }
      }

      traceEntries.push(entry);
    }
  }

  return Object.freeze({
    traceEntries: Object.freeze(traceEntries),
    rawEvents: evidence.rawEvents,
    conversationMessages: evidence.conversationMessages
  } satisfies DurableRuntimeSessionEvidence);
}

function findValidatedTerminalRawEventForIdentity(
  rawEvents: readonly RawEventLogRecord[],
  identity: RuntimeEventIdentity
): RawEventLogRecord | undefined {
  assertRawEventTerminalOrder(rawEvents);
  assertRawEventStartsWithReceived(rawEvents);
  assertRawEventTurnsDoNotOverlap(rawEvents);
  assertToolCallRawEventsAreComplete({
    mode: 'appendRawEvent',
    rawEvents
  });

  const matchingIdentityKey = runtimeEventIdentityKey(identity);
  const createdAtByIdentity = new Map<string, string>();

  for (const rawEvent of rawEvents) {
    const baseIdentityKey = runtimeEventBaseIdentityKey(rawEvent);
    const priorCreatedAt = createdAtByIdentity.get(baseIdentityKey);

    if (priorCreatedAt !== undefined && priorCreatedAt !== rawEvent.createdAt) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Raw event log contains inconsistent createdAt values for one event identity.'
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
      (rawEvent) =>
        isTerminalRawEventLogRecord(rawEvent) &&
        runtimeEventIdentityKey(rawEvent) === matchingIdentityKey
    );
}

export function findValidatedTerminalRawEventForSession(
  paths: LocalRuntimeSessionPaths,
  identity: RuntimeEventIdentity
): RawEventLogRecord | undefined {
  assertLocalRuntimeSessionReadable({
    storeRoot: paths.storeRoot,
    sessionId: paths.sessionId
  });

  const evidence = reconcileTerminalRawTraceEvidence(
    readRuntimeSessionEvidence(paths, 'publicDecode')
  );

  // Recovery must accept a valid open final turn so absence of a terminal can
  // be distinguished from malformed or contradictory durable evidence.
  assertDurableRuntimeSessionEvidence({
    paths,
    evidence,
    mode: 'appendRawEvent'
  });

  return findValidatedTerminalRawEventForIdentity(evidence.rawEvents, identity);
}

const runtimeTurnEvidenceStateRules = Object.freeze({
  completed: { isOpen: false, isTerminal: true, requiresRawStart: false },
  empty: { isOpen: false, isTerminal: false, requiresRawStart: false },
  raw_started: { isOpen: true, isTerminal: false, requiresRawStart: false },
  rejected: { isOpen: false, isTerminal: true, requiresRawStart: false },
  trace_started: { isOpen: false, isTerminal: false, requiresRawStart: true }
} satisfies Record<
  RuntimeTurnEvidenceState,
  {
    readonly isOpen: boolean;
    readonly isTerminal: boolean;
    readonly requiresRawStart: boolean;
  }
>);

function readValidatedRuntimeSessionEvidence(
  paths: LocalRuntimeSessionPaths,
  mode: RuntimeLogValidationMode
): DurableRuntimeSessionEvidence {
  const storedEvidence = readRuntimeSessionEvidence(paths, 'publicDecode');
  const evidence =
    mode === 'public'
      ? reconcileTerminalRawTraceEvidence(storedEvidence)
      : storedEvidence;

  assertDurableRuntimeSessionEvidence({
    paths,
    evidence,
    mode
  });

  return evidence;
}

function readRuntimeSessionEvidence(
  paths: LocalRuntimeSessionPaths,
  readMode: RuntimeLogReadMode
): DurableRuntimeSessionEvidence {
  return Object.freeze({
    traceEntries: readRuntimeTraceEntries(paths, readMode),
    rawEvents: readRawEventLogRecords(paths, readMode),
    conversationMessages: readConversationLogRecords(paths, readMode)
  } satisfies DurableRuntimeSessionEvidence);
}

export function assertDurableRuntimeSessionEvidence(options: {
  readonly paths: LocalRuntimeSessionPaths;
  readonly evidence: DurableRuntimeSessionEvidence;
  readonly mode: RuntimeLogValidationMode;
  readonly nextConversationMessage?: ConversationLogRecord;
  readonly nextRawEvent?: RawEventLogRecord;
  readonly nextTraceEntry?: RuntimeTraceEntry;
}): void {
  const traceEntries = Object.freeze([
    ...options.evidence.traceEntries,
    ...(options.nextTraceEntry === undefined ? [] : [options.nextTraceEntry])
  ]);
  const rawEvents = Object.freeze([
    ...options.evidence.rawEvents,
    ...(options.nextRawEvent === undefined ? [] : [options.nextRawEvent])
  ]);
  const conversationMessages = Object.freeze([
    ...options.evidence.conversationMessages,
    ...(options.nextConversationMessage === undefined
      ? []
      : [options.nextConversationMessage])
  ]);
  const nextIdentity = nextRuntimeEventIdentity(options);

  assertRuntimeEvidenceCreatedAtAgreement({
    traceEntries,
    rawEvents,
    conversationMessages
  });
  assertRuntimeTraceTerminalOrder(traceEntries);
  assertTraceStartsWithReceived(traceEntries);
  assertRawEventTerminalOrder(rawEvents);
  assertRawEventStartsWithReceived(rawEvents);
  assertRawEventTurnsDoNotOverlap(rawEvents);
  assertOpenRawTurnAllowsNextIdentity({
    rawEvents: options.evidence.rawEvents,
    nextIdentity
  });
  assertRawStartedTurnsHaveTraceEvidence({
    traceEntries,
    rawEvents
  });
  assertTraceStartedTurnsHaveRawEvidence({
    mode: options.mode,
    traceEntries,
    rawEvents,
    allowedTraceOnlyIdentity:
      options.nextTraceEntry?.step === 'runtime_event_received'
        ? runtimeEventIdentityKey(options.nextTraceEntry)
        : undefined
  });
  assertTerminalRawEventsHaveMatchingTerminalTraceEvidence({
    traceEntries,
    rawEvents,
    allowedTerminalRawWithoutTrace: allowedTerminalRawWithoutTrace(options)
  });
  assertToolCallRawEventsAreComplete({
    mode: options.mode,
    rawEvents
  });

  if (options.mode === 'public') {
    assertRawEventTurnTerminalCompleteness(rawEvents);
    assertCompleteConversationLog(conversationMessages);
  }

  assertRawEventVisibleReferencesMatchConversationMessages({
    messages: conversationMessages,
    rawEvents
  });
  assertRoleModelEvidenceMatchesSessionPath({
    paths: options.paths,
    rawEvents
  });
  const character = durableCharacterProfile({
    messages: conversationMessages,
    rawEvents,
    allowUnanchoredCustomCharacter: options.mode === 'appendConversation'
  });

  assertRestoredConversationInvariants(options.paths, conversationMessages, {
    ...(character === undefined ? {} : { character }),
    allowIncompleteFinalTurn: appendModeAllowsIncompleteConversationTurn({
      mode: options.mode,
      messages: conversationMessages,
      rawEvents
    })
  });
  assertConversationMessagesHaveTerminalRawEvidence({
    messages: conversationMessages.filter((message, index) =>
      messageRequiresTerminalRawEvidence({
        mode: options.mode,
        message,
        isFinalIncompleteAppendMessage:
          index === conversationMessages.length - 1 &&
          appendModeAllowsIncompleteConversationTurn({
            mode: options.mode,
            messages: conversationMessages,
            rawEvents
          }),
        rawEvents
      })
    ),
    rawEvents
  });
}

function assertRuntimeEvidenceCreatedAtAgreement(options: {
  readonly traceEntries: readonly RuntimeTraceEntry[];
  readonly rawEvents: readonly RawEventLogRecord[];
  readonly conversationMessages: readonly ConversationLogRecord[];
}): void {
  const createdAtByIdentity = new Map<string, string>();

  for (const record of [
    ...options.traceEntries,
    ...options.rawEvents,
    ...options.conversationMessages
  ]) {
    const key = runtimeEventBaseIdentityKey(record);
    const prior = createdAtByIdentity.get(key);

    if (prior !== undefined && prior !== record.createdAt) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Runtime evidence for one event identity must share one createdAt timestamp.'
      );
    }

    createdAtByIdentity.set(key, record.createdAt);
  }
}

function assertToolCallRawEventsAreComplete(options: {
  readonly mode: RuntimeLogValidationMode;
  readonly rawEvents: readonly RawEventLogRecord[];
}): void {
  const started = new Map<string, RawEventLogRecord>();
  const finished = new Map<string, RawEventLogRecord>();
  const rejectedTerminalIdentityKeys = terminalRejectedRawEventIdentityKeys(
    options.rawEvents
  );

  for (const rawEvent of options.rawEvents) {
    if (rawEvent.kind === 'tool_call_started') {
      const callId = requiredToolCallId(rawEvent);

      if (started.has(callId)) {
        throw new LocalRuntimeStorageContractError(
          'malformed_record',
          `Tool call started more than once: ${callId}.`
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
          `Tool call finished before start: ${callId}.`
        );
      }

      if (finished.has(callId)) {
        throw new LocalRuntimeStorageContractError(
          'malformed_record',
          `Tool call finished more than once: ${callId}.`
        );
      }

      finished.set(callId, rawEvent);
    }
  }

  if (options.mode === 'public') {
    for (const [callId, rawEvent] of started) {
      if (finished.has(callId)) {
        continue;
      }

      if (
        rejectedTerminalIdentityKeys.has(runtimeEventIdentityKey(rawEvent))
      ) {
        continue;
      }

      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        `Tool call started without finish: ${callId}.`
      );
    }
  }

  for (const rawEvent of options.rawEvents.filter(isTerminalRawEventLogRecord)) {
    for (const callId of rawEvent.toolCallIds ?? []) {
      if (finished.has(callId)) {
        continue;
      }

      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        `Terminal raw event references unfinished tool call: ${callId}.`
      );
    }
  }
}

function terminalRejectedRawEventIdentityKeys(
  rawEvents: readonly RawEventLogRecord[]
): ReadonlySet<string> {
  const identityKeys = new Set<string>();

  for (const rawEvent of rawEvents) {
    if (rawEvent.kind !== 'runtime_turn_rejected') {
      continue;
    }

    identityKeys.add(runtimeEventIdentityKey(rawEvent));
  }

  return identityKeys;
}

function requiredToolCallId(rawEvent: RawEventLogRecord): string {
  if (rawEvent.toolCallId === undefined) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Tool call raw event is missing toolCallId.'
    );
  }

  return rawEvent.toolCallId;
}

function nextRuntimeEventIdentity(options: {
  readonly nextConversationMessage?: ConversationLogRecord;
  readonly nextRawEvent?: RawEventLogRecord;
  readonly nextTraceEntry?: RuntimeTraceEntry;
}): RuntimeEventIdentity | undefined {
  return options.nextTraceEntry ?? options.nextRawEvent ?? options.nextConversationMessage;
}

function allowedTerminalRawWithoutTrace(options: {
  readonly evidence: DurableRuntimeSessionEvidence;
  readonly mode: RuntimeLogValidationMode;
  readonly nextRawEvent?: RawEventLogRecord;
  readonly nextTraceEntry?: RuntimeTraceEntry;
}): string | undefined {
  if (
    options.mode === 'appendRawEvent' &&
    options.nextRawEvent !== undefined &&
    isTerminalRawEventLogRecord(options.nextRawEvent)
  ) {
    return terminalTraceEvidenceKey({
      ...options.nextRawEvent,
      step: terminalTraceStepForRawEvent(options.nextRawEvent)
    });
  }

  if (options.mode !== 'appendTrace' || options.nextTraceEntry === undefined) {
    return undefined;
  }

  const nextTraceEntry = options.nextTraceEntry;

  if (
    nextTraceEntry.step !== 'raw_event_log_appended' &&
    !isTerminalRuntimeTraceEntry(nextTraceEntry)
  ) {
    return undefined;
  }

  const terminalRawEvent = options.evidence.rawEvents
    .filter(isTerminalRawEventLogRecord)
    .find((rawEvent) =>
      runtimeEventIdentityKey(rawEvent) ===
      runtimeEventIdentityKey(nextTraceEntry)
    );

  if (terminalRawEvent === undefined) {
    return undefined;
  }

  return terminalTraceEvidenceKey({
    ...terminalRawEvent,
    step: terminalTraceStepForRawEvent(terminalRawEvent)
  });
}

function readRuntimeTraceEntries(
  paths: LocalRuntimeSessionPaths,
  mode: RuntimeLogReadMode = 'public'
): readonly RuntimeTraceEntry[] {
  if (mode === 'public') {
    return readValidatedRuntimeSessionEvidence(paths, 'public').traceEntries;
  }

  const records = readJsonLines({
    filePath: paths.tracePath,
    decodeLine: (line) => decodeRuntimeTraceEntry(line),
    missingFileIsAllowed: () => traceLogIsOptional(paths, mode),
    emptyFileIsAllowed: () => traceLogIsOptional(paths, mode)
  });

  assertRuntimeTraceTerminalOrder(records);

  return Object.freeze(records);
}

function readRawEventLogRecords(
  paths: LocalRuntimeSessionPaths,
  mode: RuntimeLogReadMode = 'public'
): readonly RawEventLogRecord[] {
  if (mode === 'public') {
    return readValidatedRuntimeSessionEvidence(paths, 'public').rawEvents;
  }

  const records = readJsonLines({
    filePath: paths.rawEventsPath,
    decodeLine: (line) => decodeRawEventLogRecord(line),
    missingFileIsAllowed: () => rawEventLogMissingFileIsAllowed(paths, mode),
    emptyFileIsAllowed: () => isRawEventLogOptional(paths)
  });

  return Object.freeze(records);
}

function readConversationLogRecords(
  paths: LocalRuntimeSessionPaths,
  mode: RuntimeLogReadMode = 'public'
): readonly ConversationLogRecord[] {
  if (mode === 'public') {
    return readValidatedRuntimeSessionEvidence(paths, 'public').conversationMessages;
  }

  const records = readJsonLines({
    filePath: paths.conversationPath,
    decodeLine: (line) => decodeConversationLogRecord(line),
    missingFileIsAllowed: () => !rawEventsRequireConversationLog(paths),
    emptyFileIsAllowed: () => !rawEventsRequireConversationLog(paths)
  });

  return Object.freeze(records);
}

function assertRestoredConversationInvariants(
  paths: LocalRuntimeSessionPaths,
  messages: readonly ConversationLogRecord[],
  options: {
    readonly allowIncompleteFinalTurn?: boolean;
    readonly character?: CharacterProfile;
  } = {}
): void {
  try {
    validateRestoredVisibleTranscript({
      id: paths.sessionId,
      ...(options.character === undefined
        ? {}
        : { character: options.character }),
      visibleTranscript: messages,
      allowIncompleteFinalTurn: options.allowIncompleteFinalTurn ?? false
    });
  } catch (error: unknown) {
    if (error instanceof ConversationRehydrationError) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        error.message
      );
    }

    throw error;
  }
}

function durableCharacterProfile(options: {
  readonly messages: readonly ConversationLogRecord[];
  readonly rawEvents: readonly RawEventLogRecord[];
  readonly allowUnanchoredCustomCharacter: boolean;
}): CharacterProfile | undefined {
  return validateDurableCharacterProfiles({
    roleModelCharacter: recordedRoleModelCharacterProfile(options.rawEvents),
    conversationCharacter: recordedConversationCharacterProfile(
      options.messages
    ),
    allowUnanchoredCustomCharacter: options.allowUnanchoredCustomCharacter
  });
}

function recordedRoleModelCharacterProfile(
  rawEvents: readonly RawEventLogRecord[]
): CharacterProfile | undefined {
  let recordedCharacter: CharacterProfile | undefined;

  for (const rawEvent of rawEvents) {
    const candidate = roleModelCharacterSnapshot(rawEvent);

    if (candidate === undefined) {
      continue;
    }

    if (
      recordedCharacter !== undefined &&
      !sameCharacterProfiles(recordedCharacter, candidate)
    ) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Role-model character evidence must identify one durable session character.'
      );
    }

    recordedCharacter = candidate;
  }

  return recordedCharacter;
}

function recordedConversationCharacterProfile(
  messages: readonly ConversationLogRecord[]
): CharacterProfile | undefined {
  let messageCharacter: CharacterProfile | undefined;

  for (const message of messages) {
    if (message.role !== 'character') {
      continue;
    }

    const candidate = Object.freeze({
      id: message.speakerId,
      displayName: message.speakerName
    } satisfies CharacterProfile);

    if (
      messageCharacter !== undefined &&
      !sameCharacterProfiles(messageCharacter, candidate)
    ) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Durable character messages must identify one session character.'
      );
    }

    messageCharacter = candidate;
  }

  return messageCharacter;
}

function validateDurableCharacterProfiles(options: {
  readonly roleModelCharacter: CharacterProfile | undefined;
  readonly conversationCharacter: CharacterProfile | undefined;
  readonly allowUnanchoredCustomCharacter: boolean;
}): CharacterProfile | undefined {
  if (
    options.roleModelCharacter !== undefined &&
    options.conversationCharacter !== undefined &&
    !sameCharacterProfiles(
      options.roleModelCharacter,
      options.conversationCharacter
    )
  ) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Durable character speaker metadata must match recorded role-model character evidence.'
    );
  }

  if (
    options.conversationCharacter !== undefined &&
    options.roleModelCharacter === undefined &&
    !sameCharacterProfiles(
      options.conversationCharacter,
      localCharacterProfile
    ) &&
    !options.allowUnanchoredCustomCharacter
  ) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'A custom durable character speaker requires matching role-model character evidence.'
    );
  }

  return options.roleModelCharacter ?? options.conversationCharacter;
}

function assertIncrementalCharacterEvidence(
  state: RuntimeEvidenceIncrementalState,
  rawEvent: RawEventLogRecord
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
      'Role-model character evidence must identify one durable session character.'
    );
  }

  if (isTerminalRawEventLogRecord(rawEvent)) {
    validateDurableCharacterProfiles({
      roleModelCharacter: state.roleModelCharacter ?? candidate,
      conversationCharacter: state.conversationCharacter,
      allowUnanchoredCustomCharacter: false
    });
  }
}

function roleModelCharacterSnapshot(
  rawEvent: RawEventLogRecord
): CharacterProfile | undefined {
  return rawEvent.roleModelIOSnapshot?.inputEnvelope.decisionContext
    .characterSnapshot;
}

export function durableRuntimeSessionCharacterProfile(
  evidence: DurableRuntimeSessionEvidence
): CharacterProfile {
  return (
    durableCharacterProfile({
      messages: evidence.conversationMessages,
      rawEvents: evidence.rawEvents,
      allowUnanchoredCustomCharacter: false
    }) ?? localCharacterProfile
  );
}

function sameCharacterProfiles(
  left: CharacterProfile,
  right: CharacterProfile
): boolean {
  return left.id === right.id && left.displayName === right.displayName;
}

function speakerMatchesCharacter(
  message: ConversationLogRecord,
  character: CharacterProfile
): boolean {
  return (
    message.speakerId === character.id &&
    message.speakerName === character.displayName
  );
}

function assertCompleteConversationLog(
  messages: readonly ConversationLogRecord[]
): void {
  if (messages.length % 2 === 0) {
    return;
  }

  throwIncompleteConversationLog();
}

function throwIncompleteConversationLog(): never {
  throw new LocalRuntimeStorageContractError(
    'malformed_record',
    'Local runtime conversation log ended before a complete user/character turn.'
  );
}

function assertRuntimeTraceTerminalOrder(
  traceEntries: readonly RuntimeTraceEntry[]
): void {
  assertTerminalEvidenceOrder({
    records: traceEntries,
    isTerminalRecord: isTerminalRuntimeTraceEntry,
    isPrerequisiteEvidence: (traceEntry) =>
      traceEntry.step === 'runtime_event_received',
    recordAfterTerminalMessage:
      'Runtime trace log contains steps after terminal turn evidence.',
    terminalWithoutPrerequisiteMessage:
      'Runtime trace log contains terminal turn evidence without prior received trace evidence.'
  });
}

function isTerminalRuntimeTraceEntry(
  entry: RuntimeTraceEntry
): entry is RuntimeTraceEntry & {
  readonly step: 'runtime_turn_completed' | 'runtime_turn_rejected';
} {
  return (
    entry.step === 'runtime_turn_completed' ||
    entry.step === 'runtime_turn_rejected'
  );
}

function assertTerminalRawEventsHaveMatchingTerminalTraceEvidence(options: {
  readonly allowedTerminalRawWithoutTrace: string | undefined;
  readonly traceEntries: readonly RuntimeTraceEntry[];
  readonly rawEvents: readonly RawEventLogRecord[];
}): void {
  const terminalTraceEvidence = new Set(
    options.traceEntries
      .filter(isTerminalRuntimeTraceEntry)
      .map(terminalTraceEvidenceKey)
  );

  for (const rawEvent of options.rawEvents.filter(isTerminalRawEventLogRecord)) {
    const expectedTerminalTraceKey = terminalTraceEvidenceKey({
      ...rawEvent,
      step: terminalTraceStepForRawEvent(rawEvent)
    });

    if (
      terminalTraceEvidence.has(expectedTerminalTraceKey) ||
      options.allowedTerminalRawWithoutTrace === expectedTerminalTraceKey
    ) {
      continue;
    }

    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Terminal raw-event evidence lacks matching terminal runtime trace evidence.'
    );
  }
}

function assertRawEventStartsWithReceived(
  rawEvents: readonly RawEventLogRecord[]
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
        'Raw event log turn evidence must start with runtime_event_received.'
      );
    }

    startedRawEventIdentities.add(identityKey);
  }
}

function assertTraceStartsWithReceived(
  traceEntries: readonly RuntimeTraceEntry[]
): void {
  const startedTraceIdentities = new Set<string>();

  for (const traceEntry of traceEntries) {
    const identityKey = runtimeEventIdentityKey(traceEntry);

    if (startedTraceIdentities.has(identityKey)) {
      continue;
    }

    if (traceEntry.step !== 'runtime_event_received') {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Runtime trace log turn evidence must start with runtime_event_received.'
      );
    }

    startedTraceIdentities.add(identityKey);
  }
}

function assertRawStartedTurnsHaveTraceEvidence(options: {
  readonly rawEvents: readonly RawEventLogRecord[];
  readonly traceEntries: readonly RuntimeTraceEntry[];
}): void {
  const traceStartedIdentities = new Set(
    options.traceEntries
      .filter((traceEntry) => traceEntry.step === 'runtime_event_received')
      .map(runtimeEventIdentityKey)
  );

  for (const rawEvent of options.rawEvents) {
    if (rawEvent.kind !== 'runtime_event_received') {
      continue;
    }

    if (traceStartedIdentities.has(runtimeEventIdentityKey(rawEvent))) {
      continue;
    }

    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Raw event log contains started turn evidence without matching runtime trace start evidence.'
    );
  }
}

function assertTraceStartedTurnsHaveRawEvidence(options: {
  readonly allowedTraceOnlyIdentity: string | undefined;
  readonly mode: RuntimeLogValidationMode;
  readonly rawEvents: readonly RawEventLogRecord[];
  readonly traceEntries: readonly RuntimeTraceEntry[];
}): void {
  const rawStates = runtimeTurnEvidenceStatesForRawEvents(options.rawEvents);

  for (const traceEntry of options.traceEntries) {
    if (traceEntry.step !== 'runtime_event_received') {
      continue;
    }

    const identityKey = runtimeEventIdentityKey(traceEntry);
    const state = traceStartedRuntimeTurnEvidenceState(
      rawStates.get(identityKey) ?? 'empty'
    );

    if (!runtimeTurnEvidenceStateRules[state].requiresRawStart) {
      continue;
    }

    if (
      options.mode === 'appendTrace' &&
      options.allowedTraceOnlyIdentity === identityKey
    ) {
      continue;
    }

    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Runtime trace log contains started turn evidence without matching raw-event start evidence.'
    );
  }
}

function traceStartedRuntimeTurnEvidenceState(
  rawState: RuntimeTurnEvidenceState
): RuntimeTurnEvidenceState {
  if (rawState === 'empty') {
    return 'trace_started';
  }

  return rawState;
}

function assertOpenRawTurnAllowsNextIdentity(options: {
  readonly nextIdentity: RuntimeEventIdentity | undefined;
  readonly rawEvents: readonly RawEventLogRecord[];
}): void {
  if (options.nextIdentity === undefined) {
    return;
  }

  assertRawEventAppendFollowsOpenTurn({
    rawEvents: options.rawEvents,
    nextIdentity: options.nextIdentity
  });
}

function appendModeAllowsIncompleteConversationTurn(options: {
  readonly messages: readonly ConversationLogRecord[];
  readonly mode: RuntimeLogValidationMode;
  readonly rawEvents: readonly RawEventLogRecord[];
}): boolean {
  if (options.mode !== 'appendConversation') {
    return false;
  }

  if (options.messages.length % 2 === 0) {
    return false;
  }

  const finalMessage = options.messages.at(-1);

  if (finalMessage?.role !== 'user') {
    return false;
  }

  return startedRawEventIdentitiesWithoutTerminal(options.rawEvents).has(
    runtimeEventIdentityKey(finalMessage)
  );
}

function messageRequiresTerminalRawEvidence(options: {
  readonly isFinalIncompleteAppendMessage: boolean;
  readonly message: ConversationLogRecord;
  readonly mode: RuntimeLogValidationMode;
  readonly rawEvents: readonly RawEventLogRecord[];
}): boolean {
  if (
    options.mode === 'appendConversation' &&
    options.isFinalIncompleteAppendMessage
  ) {
    return false;
  }

  if (options.mode === 'public') {
    return true;
  }

  return !startedRawEventIdentitiesWithoutTerminal(options.rawEvents).has(
    runtimeEventIdentityKey(options.message)
  );
}

function assertRawEventTurnTerminalCompleteness(
  rawEvents: readonly RawEventLogRecord[]
): void {
  assertRawEventTerminalOrder(rawEvents);

  const openTurnIdentities = startedRawEventIdentitiesWithoutTerminal(rawEvents);

  if (openTurnIdentities.size > 0) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Raw event log contains a turn without terminal evidence.'
    );
  }
}

function assertRawEventTerminalOrder(
  rawEvents: readonly RawEventLogRecord[]
): void {
  assertTerminalEvidenceOrder({
    records: rawEvents,
    isTerminalRecord: isTerminalRawEventLogRecord,
    isPrerequisiteEvidence: (rawEvent) =>
      rawEvent.kind === 'runtime_event_received',
    isAllowedAfterTerminalRecord: (rawEvent) =>
      rawEvent.kind === 'after_turn_committed',
    recordAfterTerminalMessage:
      'Raw event log contains records after terminal turn evidence.',
    terminalWithoutPrerequisiteMessage:
      'Raw event log contains terminal turn evidence before start evidence.'
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
        options.recordAfterTerminalMessage
      );
    }

    if (options.isTerminalRecord(record)) {
      if (!prerequisiteEvidenceIdentities.has(identityKey)) {
        throw new LocalRuntimeStorageContractError(
          'malformed_record',
          options.terminalWithoutPrerequisiteMessage
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

function assertRawEventAppendFollowsOpenTurn(options: {
  readonly rawEvents: readonly RawEventLogRecord[];
  readonly nextIdentity: RuntimeEventIdentity;
}): void {
  assertRawEventTerminalOrder(options.rawEvents);

  const openTurnIdentities = startedRawEventIdentitiesWithoutTerminal(options.rawEvents);

  if (openTurnIdentities.size === 0) {
    return;
  }

  if (
    openTurnIdentities.size === 1 &&
    openTurnIdentities.has(runtimeEventIdentityKey(options.nextIdentity))
  ) {
    return;
  }

  throw new LocalRuntimeStorageContractError(
    'malformed_record',
    'Raw event log contains an unfinished turn before the next event.'
  );
}

function assertRawEventTurnsDoNotOverlap(
  rawEvents: readonly RawEventLogRecord[]
): void {
  let openTurnIdentity: string | undefined;

  for (const rawEvent of rawEvents) {
    const identityKey = runtimeEventIdentityKey(rawEvent);

    if (rawEvent.kind === 'after_turn_committed') {
      continue;
    }

    if (openTurnIdentity !== undefined && openTurnIdentity !== identityKey) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Raw event log contains overlapping turn evidence.'
      );
    }

    if (isTerminalRawEventLogRecord(rawEvent)) {
      openTurnIdentity = undefined;
      continue;
    }

    openTurnIdentity = identityKey;
  }
}

export function startedRawEventIdentitiesWithoutTerminal(
  rawEvents: readonly RawEventLogRecord[]
): ReadonlySet<string> {
  const states = runtimeTurnEvidenceStatesForRawEvents(rawEvents);
  const openTurnIdentities = new Set<string>();

  for (const [identityKey, state] of states) {
    if (runtimeTurnEvidenceStateRules[state].isOpen) {
      openTurnIdentities.add(identityKey);
    }
  }

  return openTurnIdentities;
}

function runtimeTurnEvidenceStatesForRawEvents(
  rawEvents: readonly RawEventLogRecord[]
): ReadonlyMap<string, RuntimeTurnEvidenceState> {
  const states = new Map<string, RuntimeTurnEvidenceState>();

  for (const rawEvent of rawEvents) {
    const identityKey = runtimeEventIdentityKey(rawEvent);

    states.set(
      identityKey,
      runtimeTurnEvidenceStateAfterRawEvent(
        states.get(identityKey) ?? 'empty',
        rawEvent
      )
    );
  }

  return states;
}

function runtimeTurnEvidenceStateAfterRawEvent(
  state: RuntimeTurnEvidenceState,
  rawEvent: RawEventLogRecord
): RuntimeTurnEvidenceState {
  if (rawEvent.kind === 'runtime_turn_completed') {
    return 'completed';
  }

  if (rawEvent.kind === 'runtime_turn_rejected') {
    return 'rejected';
  }

  if (runtimeTurnEvidenceStateRules[state].isTerminal) {
    return state;
  }

  return 'raw_started';
}

function traceLogIsOptional(
  paths: LocalRuntimeSessionPaths,
  mode: RuntimeLogReadMode
): boolean {
  if (mode === 'append' && !logFileHasContent(paths.rawEventsPath)) {
    return true;
  }

  return (
    !logFileHasContent(paths.rawEventsPath) &&
    !logFileHasContent(paths.conversationPath)
  );
}

function isRawEventLogOptional(paths: LocalRuntimeSessionPaths): boolean {
  return (
    !logFileHasContent(paths.tracePath) &&
    !logFileHasContent(paths.conversationPath)
  );
}

function rawEventLogMissingFileIsAllowed(
  paths: LocalRuntimeSessionPaths,
  mode: RuntimeLogReadMode
): boolean {
  if (mode === 'append') {
    return true;
  }

  return isRawEventLogOptional(paths);
}

function assertRawEventVisibleReferencesMatchConversationMessages(options: {
  readonly messages: readonly ConversationLogRecord[];
  readonly rawEvents: readonly RawEventLogRecord[];
}): void {
  const messagesById = new Map(
    options.messages.map((message) => [message.id, message])
  );
  const priorVisibleMessages: ConversationLogRecord[] = [];

  for (const rawEvent of options.rawEvents) {
    for (const messageId of rawEvent.visibleMessageIds ?? []) {
      const message = messagesById.get(messageId);

      if (message === undefined) {
        throw new LocalRuntimeStorageContractError(
          'malformed_record',
          `Raw event references a missing visible conversation message: ${messageId}.`
        );
      }

      if (message.eventId !== rawEvent.eventId || message.traceId !== rawEvent.traceId) {
        throw new LocalRuntimeStorageContractError(
          'malformed_record',
          `Raw event references a visible conversation message from another event: ${messageId}.`
        );
      }
    }

    assertRoleModelInputTextMatchesCommittedUserMessage({
      messagesById,
      rawEvent
    });
    assertRoleModelDecisionContextMatchesPriorConversation({
      priorVisibleMessages,
      rawEvent
    });

    if (isVisibleMessageTerminalRawEventLogRecord(rawEvent)) {
      priorVisibleMessages.push(
        ...visibleConversationMessagesForRawEvent({
          messagesById,
          rawEvent
        })
      );
    }
  }

  assertCompletedTerminalRawEventsMatchConversationMessages(options);
}

function assertRoleModelInputTextMatchesCommittedUserMessage(options: {
  readonly messagesById: ReadonlyMap<string, ConversationLogRecord>;
  readonly rawEvent: RawEventLogRecord;
}): void {
  const inputText =
    options.rawEvent.roleModelIOSnapshot?.inputEnvelope.event.payload.currentUserMessage;

  if (inputText === undefined || options.rawEvent.visibleMessageIds === undefined) {
    return;
  }

  const userMessages = options.rawEvent.visibleMessageIds
    .map((messageId) => options.messagesById.get(messageId))
    .filter((message): message is ConversationLogRecord => {
      return message?.role === 'user';
    });

  const userMessage = userMessages[0];

  if (userMessages.length !== 1 || userMessage === undefined || userMessage.text !== inputText) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Role-model input text must match the committed user visible message for the turn.'
    );
  }
}

function assertRoleModelDecisionContextMatchesPriorConversation(options: {
  readonly priorVisibleMessages: readonly ConversationLogRecord[];
  readonly rawEvent: RawEventLogRecord;
}): void {
  const recentVisibleMessages =
    options.rawEvent.roleModelIOSnapshot?.inputEnvelope.decisionContext
      .recentVisibleMessages;

  if (recentVisibleMessages === undefined) {
    return;
  }

  const expectedVisibleMessages = selectRecentVisibleMessages(
    options.priorVisibleMessages,
    recentVisibleMessages.length
  );

  if (sameVisibleMessages(recentVisibleMessages, expectedVisibleMessages)) {
    return;
  }

  throw new LocalRuntimeStorageContractError(
    'malformed_record',
    'Role-model recent visible context must match the durable prior conversation messages for the turn.'
  );
}

function visibleConversationMessagesForRawEvent(options: {
  readonly messagesById: ReadonlyMap<string, ConversationLogRecord>;
  readonly rawEvent: RawEventLogRecord;
}): readonly ConversationLogRecord[] {
  return (options.rawEvent.visibleMessageIds ?? [])
    .map((messageId) => options.messagesById.get(messageId))
    .filter((message): message is ConversationLogRecord => {
      return message !== undefined;
    });
}

function assertRoleModelEvidenceMatchesSessionPath(options: {
  readonly paths: LocalRuntimeSessionPaths;
  readonly rawEvents: readonly RawEventLogRecord[];
}): void {
  for (const rawEvent of options.rawEvents) {
    const sessionIds = [
      rawEvent.roleModelIOSnapshot?.sessionId,
      rawEvent.roleModelIOSnapshot?.inputEnvelope.decisionContext.sessionId,
      rawEvent.parsedRoleModelDecisionSnapshot?.sessionId,
      rawEvent.commitValidation?.sessionId
    ];

    for (const sessionId of sessionIds) {
      if (sessionId === undefined || sessionId === options.paths.sessionId) {
        continue;
      }

      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Runtime evidence session identity must match the durable session path.'
      );
    }
  }
}

function assertCompletedTerminalRawEventsMatchConversationMessages(options: {
  readonly messages: readonly ConversationLogRecord[];
  readonly rawEvents: readonly RawEventLogRecord[];
}): void {
  const messagesByTurnIdentity = new Map<string, readonly ConversationLogRecord[]>();

  for (const message of options.messages) {
    const identityKey = runtimeEventIdentityKey(message);
    const messages = messagesByTurnIdentity.get(identityKey) ?? [];

    messagesByTurnIdentity.set(identityKey, Object.freeze([...messages, message]));
  }

  for (const rawEvent of options.rawEvents.filter(isCompletedTerminalRawEventLogRecord)) {
    const expectedMessageIds = (
      messagesByTurnIdentity.get(runtimeEventIdentityKey(rawEvent)) ?? []
    ).map((message) => message.id);
    const visibleMessageIds = rawEvent.visibleMessageIds ?? [];

    if (expectedMessageIds.length !== 0 && expectedMessageIds.length !== 2) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'A completed runtime turn must commit exactly one user/character message pair.'
      );
    }

    if (!sameOrderedValues(visibleMessageIds, expectedMessageIds)) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Completed terminal raw-event evidence must exactly match the visible conversation messages for that turn.'
      );
    }
  }
}

function assertConversationMessagesHaveTerminalRawEvidence(options: {
  readonly messages: readonly ConversationLogRecord[];
  readonly rawEvents: readonly RawEventLogRecord[];
}): void {
  if (options.messages.length === 0) {
    return;
  }

  const completedTurnEvidence = new Set(
    options.rawEvents
      .filter(isVisibleMessageTerminalRawEventLogRecord)
      .flatMap((record) =>
        (record.visibleMessageIds ?? []).map((messageId) =>
          visibleMessageEvidenceKey(record, messageId)
        )
      )
  );

  for (const message of options.messages) {
    if (!completedTurnEvidence.has(visibleMessageEvidenceKey(message, message.id))) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        `Conversation message lacks terminal raw-event evidence: ${message.id}.`
      );
    }
  }
}

function isCompletedTerminalRawEventLogRecord(record: RawEventLogRecord): boolean {
  return record.kind === 'runtime_turn_completed';
}

function isVisibleMessageTerminalRawEventLogRecord(
  record: RawEventLogRecord
): boolean {
  return (
    record.kind === 'runtime_turn_completed' ||
    record.kind === 'runtime_turn_rejected'
  );
}

function terminalTraceStepForRawEvent(
  record: RawEventLogRecord
): 'runtime_turn_completed' | 'runtime_turn_rejected' {
  if (record.kind === 'runtime_turn_completed') {
    return 'runtime_turn_completed';
  }

  if (record.kind === 'runtime_turn_rejected') {
    return 'runtime_turn_rejected';
  }

  throw new LocalRuntimeStorageContractError(
    'malformed_record',
    'Terminal raw-event evidence must use a terminal raw-event kind.'
  );
}

function terminalTraceEvidenceKey(entry: {
  readonly eventId: string;
  readonly traceId: string;
  readonly createdAt: string;
  readonly step: 'runtime_turn_completed' | 'runtime_turn_rejected';
}): string {
  return `${runtimeEventIdentityKey(entry)}\u0000${entry.step}`;
}

function traceStepEvidenceKey(entry: {
  readonly eventId: string;
  readonly traceId: string;
  readonly createdAt: string;
  readonly step: RuntimeTraceEntry['step'];
}): string {
  return `${runtimeEventIdentityKey(entry)}\u0000${entry.step}`;
}

export function runtimeEventIdentityKey(identity: {
  readonly eventId: string;
  readonly traceId: string;
  readonly createdAt: string;
}): string {
  return `${identity.eventId}\u0000${identity.traceId}\u0000${identity.createdAt}`;
}

function visibleMessageEvidenceKey(
  identity: {
    readonly eventId: string;
    readonly traceId: string;
    readonly createdAt: string;
  },
  messageId: string
): string {
  return `${runtimeEventIdentityKey(identity)}\u0000${messageId}`;
}

function sameOrderedValues(
  actualValues: readonly string[],
  expectedValues: readonly string[]
): boolean {
  return (
    actualValues.length === expectedValues.length &&
    actualValues.every((value, index) => value === expectedValues[index])
  );
}

function sameVisibleMessages(
  actualMessages: readonly VisibleMessage[],
  expectedMessages: readonly VisibleMessage[]
): boolean {
  return (
    actualMessages.length === expectedMessages.length &&
    actualMessages.every((actualMessage, index) => {
      const expectedMessage = expectedMessages[index];

      return (
        expectedMessage !== undefined &&
        actualMessage.id === expectedMessage.id &&
        actualMessage.role === expectedMessage.role &&
        actualMessage.speakerId === expectedMessage.speakerId &&
        actualMessage.speakerName === expectedMessage.speakerName &&
        actualMessage.text === expectedMessage.text
      );
    })
  );
}

function readJsonLines<T>(options: {
  readonly filePath: string;
  readonly decodeLine: (line: string) => T;
  readonly missingFileIsAllowed: () => boolean;
  readonly emptyFileIsAllowed: () => boolean;
}): T[] {
  const content = readLogFile(options.filePath);

  if (content === undefined) {
    if (!options.missingFileIsAllowed()) {
      throw new LocalRuntimeStorageContractError(
        'missing_file',
        `Required local runtime log file is missing: ${options.filePath}.`
      );
    }

    return [];
  }

  if (content.length === 0) {
    if (!options.emptyFileIsAllowed()) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        `Required local runtime log file is empty: ${options.filePath}.`
      );
    }

    return [];
  }

  if (!content.endsWith('\n')) {
    throw new LocalRuntimeStorageContractError(
      'partial_write',
      `Local runtime log file ended without a complete JSONL record: ${options.filePath}.`
    );
  }

  const lines = content.split('\n');
  const records: T[] = [];

  for (const [index, line] of lines.entries()) {
    const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line;

    if (index === lines.length - 1 && normalizedLine.length === 0) {
      continue;
    }

    records.push(options.decodeLine(normalizedLine));
  }

  return records;
}

function rawEventsRequireConversationLog(paths: LocalRuntimeSessionPaths): boolean {
  return readRawEventLogRecords(paths, 'append').some((record) => {
    return (
      record.visibleMessageIds !== undefined &&
      record.visibleMessageIds.length > 0
    );
  });
}

function logFileHasContent(filePath: string): boolean {
  const content = readLogFile(filePath);

  return content !== undefined && content.length > 0;
}

function readLogFile(filePath: string): string | undefined {
  try {
    if (!existsSync(filePath)) {
      return undefined;
    }

    return readFileSync(filePath, 'utf8');
  } catch {
    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not read local runtime log file: ${filePath}.`
    );
  }
}
