import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

import {
  ConversationRehydrationError,
  selectRecentVisibleMessages,
  type VisibleMessage,
  validateRestoredVisibleTranscript
} from '../../core/conversation.ts';
import {
  createLocalRuntimeSessionPaths,
  decodeConversationLogRecord,
  decodeRawEventLogRecord,
  decodeRuntimeTraceEntry,
  encodeConversationLogRecord,
  encodeRawEventLogRecord,
  encodeRuntimeTraceEntry,
  LocalRuntimeStorageContractError,
  type LocalRuntimeSessionPaths,
  type LocalRuntimeSessionPathsOptions
} from './layout.ts';
import type {
  ConversationLogRecord,
  RawEventLogRecord,
  RuntimeLogStore,
  RuntimeTraceEntry
} from '../log.ts';
import { isTerminalRawEventLogRecord } from '../log.ts';
import type { RuntimeEventIdentity } from '../event.ts';
import { assertLocalRuntimeSessionReadable } from './session-store.ts';

export type CreateFileRuntimeLogStoreOptions = LocalRuntimeSessionPathsOptions;
type RuntimeLogReadMode = 'append' | 'appendTrace' | 'public' | 'publicDecode';
type RuntimeLogValidationMode =
  | 'appendConversation'
  | 'appendRawEvent'
  | 'appendTrace'
  | 'public';
type DurableRuntimeSessionEvidence = {
  readonly traceEntries: readonly RuntimeTraceEntry[];
  readonly rawEvents: readonly RawEventLogRecord[];
  readonly conversationMessages: readonly ConversationLogRecord[];
};

export function createFileRuntimeLogStore(
  options: CreateFileRuntimeLogStoreOptions = {}
): RuntimeLogStore {
  const paths = createLocalRuntimeSessionPaths(options);
  const assertSessionReadable = (): void => {
    assertLocalRuntimeSessionReadable({
      ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
      sessionId: paths.sessionId
    });
  };

  return Object.freeze({
    localRuntimeSessionPaths: paths,
    appendTrace(entry) {
      const encoded = encodeRuntimeTraceEntry(entry);
      const storedEntry = decodeRuntimeTraceEntry(encoded);

      appendJsonLine({
        filePath: paths.tracePath,
        line: encodeRuntimeTraceEntry(storedEntry),
        assertSessionReadable,
        validateExisting: () => readAppendableRuntimeTraceEntries(paths, storedEntry)
      });

      return storedEntry;
    },
    appendRawEvent(record) {
      const encoded = encodeRawEventLogRecord(record);
      const storedRecord = decodeRawEventLogRecord(encoded);

      appendJsonLine({
        filePath: paths.rawEventsPath,
        line: encodeRawEventLogRecord(storedRecord),
        assertSessionReadable,
        validateExisting: () => readAppendableRawEventLogRecords(paths, storedRecord)
      });

      return storedRecord;
    },
    appendConversationMessage(record) {
      const encoded = encodeConversationLogRecord(record);
      const storedRecord = decodeConversationLogRecord(encoded);

      appendJsonLine({
        filePath: paths.conversationPath,
        line: encodeConversationLogRecord(storedRecord),
        assertSessionReadable,
        validateExisting: () => readAppendableConversationLogRecords(paths, storedRecord)
      });

      return storedRecord;
    },
    removeConversationMessages(messageIds) {
      removeConversationLogRecords({
        paths,
        messageIds
      });
    },
    traceEntries() {
      assertSessionReadable();
      return Object.freeze([
        ...readValidatedRuntimeSessionEvidence(paths, 'public').traceEntries
      ]);
    },
    rawEvents() {
      assertSessionReadable();
      return Object.freeze([
        ...readValidatedRuntimeSessionEvidence(paths, 'public').rawEvents
      ]);
    },
    conversationMessages() {
      assertSessionReadable();
      return Object.freeze([
        ...readValidatedRuntimeSessionEvidence(paths, 'public').conversationMessages
      ]);
    }
  } satisfies RuntimeLogStore);
}

function reconcileTerminalRawTraceEvidence(
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

    if (matchingSteps.has(terminalStep)) {
      continue;
    }

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
    const identityKey = runtimeEventIdentityKey(rawEvent);
    const priorCreatedAt = createdAtByIdentity.get(identityKey);

    if (priorCreatedAt !== undefined && priorCreatedAt !== rawEvent.createdAt) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        'Raw event log contains inconsistent createdAt values for one event identity.'
      );
    }

    createdAtByIdentity.set(identityKey, rawEvent.createdAt);
  }

  if (createdAtByIdentity.get(matchingIdentityKey) !== identity.createdAt) {
    return undefined;
  }

  return [...rawEvents]
    .reverse()
    .find(
      (rawEvent) =>
        isTerminalRawEventLogRecord(rawEvent) &&
        rawEvent.eventId === identity.eventId &&
        rawEvent.traceId === identity.traceId &&
        rawEvent.createdAt === identity.createdAt
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

function appendJsonLine(options: {
  readonly filePath: string;
  readonly line: string;
  readonly assertSessionReadable: () => void;
  readonly validateExisting: () => readonly unknown[];
}): void {
  options.assertSessionReadable();
  options.validateExisting();

  try {
    appendFileSync(options.filePath, `${options.line}\n`, 'utf8');
  } catch {
    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not append local runtime log file: ${options.filePath}.`
    );
  }
}

function writeJsonLines(options: {
  readonly filePath: string;
  readonly lines: readonly string[];
}): void {
  try {
    writeFileSync(
      options.filePath,
      options.lines.map((line) => `${line}\n`).join(''),
      'utf8'
    );
  } catch {
    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not rewrite local runtime log file: ${options.filePath}.`
    );
  }
}

type RuntimeTurnEvidenceState =
  | 'completed'
  | 'empty'
  | 'raw_started'
  | 'rejected'
  | 'trace_started';

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

function assertDurableRuntimeSessionEvidence(options: {
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
  assertRestoredConversationInvariants(options.paths, conversationMessages, {
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
}): { readonly eventId: string; readonly traceId: string } | undefined {
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

function readAppendableRuntimeTraceEntries(
  paths: LocalRuntimeSessionPaths,
  nextEntry: RuntimeTraceEntry
): readonly RuntimeTraceEntry[] {
  const evidence = readRuntimeSessionEvidence(paths, 'appendTrace');

  assertSiblingLogsReadableForTraceAppend({
    paths,
    evidence,
    nextEntry
  });

  return evidence.traceEntries;
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

function readAppendableConversationLogRecords(
  paths: LocalRuntimeSessionPaths,
  nextRecord: ConversationLogRecord
): readonly ConversationLogRecord[] {
  assertRawEventLogPresentForConversationAppend(paths);

  const evidence = readRuntimeSessionEvidence(paths, 'append');

  assertDurableRuntimeSessionEvidence({
    paths,
    evidence,
    mode: 'appendConversation',
    nextConversationMessage: nextRecord
  });

  return evidence.conversationMessages;
}

function removeConversationLogRecords(options: {
  readonly paths: LocalRuntimeSessionPaths;
  readonly messageIds: readonly string[];
}): void {
  const ids = new Set(options.messageIds);

  if (ids.size === 0) {
    return;
  }

  const evidence = readRuntimeSessionEvidence(options.paths, 'append');
  const conversationMessages = evidence.conversationMessages.filter(
    (message) => !ids.has(message.id)
  );

  if (conversationMessages.length === evidence.conversationMessages.length) {
    return;
  }

  assertDurableRuntimeSessionEvidence({
    paths: options.paths,
    evidence: Object.freeze({
      traceEntries: evidence.traceEntries,
      rawEvents: evidence.rawEvents,
      conversationMessages: Object.freeze(conversationMessages)
    } satisfies DurableRuntimeSessionEvidence),
    mode: 'appendConversation'
  });

  writeJsonLines({
    filePath: options.paths.conversationPath,
    lines: conversationMessages.map(encodeConversationLogRecord)
  });
}

function readAppendableRawEventLogRecords(
  paths: LocalRuntimeSessionPaths,
  nextRecord: RawEventLogRecord
): readonly RawEventLogRecord[] {
  assertMissingRawEventLogAllowsRawAppend(paths, nextRecord);

  const evidence = readRuntimeSessionEvidence(paths, 'append');

  assertAppendableRawEventLog({
    paths,
    evidence,
    nextRecord
  });

  return evidence.rawEvents;
}

function assertRestoredConversationInvariants(
  paths: LocalRuntimeSessionPaths,
  messages: readonly ConversationLogRecord[],
  options: { readonly allowIncompleteFinalTurn?: boolean } = {}
): void {
  try {
    validateRestoredVisibleTranscript({
      id: paths.sessionId,
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
  readonly nextIdentity:
    | { readonly eventId: string; readonly traceId: string }
    | undefined;
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

function assertAppendableRawEventLog(options: {
  readonly paths: LocalRuntimeSessionPaths;
  readonly evidence: DurableRuntimeSessionEvidence;
  readonly nextRecord: RawEventLogRecord;
}): void {
  assertDurableRuntimeSessionEvidence({
    paths: options.paths,
    evidence: options.evidence,
    mode: 'appendRawEvent',
    nextRawEvent: options.nextRecord
  });
}

function assertMissingRawEventLogAllowsRawAppend(
  paths: LocalRuntimeSessionPaths,
  nextIdentity: { readonly eventId: string; readonly traceId: string }
): void {
  if (existsSync(paths.rawEventsPath) || !logFileHasContent(paths.tracePath)) {
    return;
  }

  const traceEntries = readRuntimeTraceEntries(paths, 'appendTrace');
  const firstTraceEntry = traceEntries.at(0);

  if (
    traceEntries.length === 1 &&
    firstTraceEntry?.step === 'runtime_event_received' &&
    runtimeEventIdentityKey(firstTraceEntry) === runtimeEventIdentityKey(nextIdentity)
  ) {
    return;
  }

  throwMissingRequiredRawEventLog(paths);
}

function assertRawEventLogPresentForConversationAppend(
  paths: LocalRuntimeSessionPaths
): void {
  if (existsSync(paths.rawEventsPath) || !logFileHasContent(paths.tracePath)) {
    return;
  }

  readRuntimeTraceEntries(paths, 'appendTrace');
  throwMissingRequiredRawEventLog(paths);
}

function throwMissingRequiredRawEventLog(paths: LocalRuntimeSessionPaths): never {
  throw new LocalRuntimeStorageContractError(
    'missing_file',
    `Required local runtime log file is missing: ${paths.rawEventsPath}.`
  );
}

function assertSiblingLogsReadableForTraceAppend(options: {
  readonly paths: LocalRuntimeSessionPaths;
  readonly evidence: DurableRuntimeSessionEvidence;
  readonly nextEntry: RuntimeTraceEntry;
}): void {
  assertDurableRuntimeSessionEvidence({
    paths: options.paths,
    evidence: options.evidence,
    mode: 'appendTrace',
    nextTraceEntry: options.nextEntry
  });
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

function assertTerminalEvidenceOrder<T extends {
  readonly eventId: string;
  readonly traceId: string;
}>(options: {
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
  readonly nextIdentity: { readonly eventId: string; readonly traceId: string };
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

function startedRawEventIdentitiesWithoutTerminal(
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
  readonly step: 'runtime_turn_completed' | 'runtime_turn_rejected';
}): string {
  return `${runtimeEventIdentityKey(entry)}\u0000${entry.step}`;
}

function runtimeEventIdentityKey(identity: {
  readonly eventId: string;
  readonly traceId: string;
}): string {
  return `${identity.eventId}\u0000${identity.traceId}`;
}

function visibleMessageEvidenceKey(
  identity: { readonly eventId: string; readonly traceId: string },
  messageId: string
): string {
  return `${identity.eventId}\u0000${identity.traceId}\u0000${messageId}`;
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
