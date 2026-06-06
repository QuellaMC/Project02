import { appendFileSync, existsSync, readFileSync } from 'node:fs';

import {
  ConversationRehydrationError,
  validateRestoredVisibleTranscript
} from './conversation.ts';
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
} from './local-storage.ts';
import type {
  ConversationLogRecord,
  RawEventLogRecord,
  RuntimeLogStore,
  RuntimeTraceEntry
} from './runtime-log.ts';
import { isTerminalRawEventLogRecord } from './runtime-log.ts';
import { assertLocalRuntimeSessionReadable } from './session-store.ts';

export type CreateFileRuntimeLogStoreOptions = LocalRuntimeSessionPathsOptions;
type RuntimeLogReadMode = 'append' | 'appendTrace' | 'public';

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
    traceEntries() {
      assertSessionReadable();
      return Object.freeze([...readRuntimeTraceEntries(paths)]);
    },
    rawEvents() {
      assertSessionReadable();
      return Object.freeze([...readRawEventLogRecords(paths)]);
    },
    conversationMessages() {
      assertSessionReadable();
      return Object.freeze([...readConversationLogRecords(paths)]);
    }
  } satisfies RuntimeLogStore);
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

function readRuntimeTraceEntries(paths: LocalRuntimeSessionPaths): readonly RuntimeTraceEntry[] {
  const records = readJsonLines({
    filePath: paths.tracePath,
    decodeLine: (line) => decodeRuntimeTraceEntry(line),
    missingFileIsAllowed: () => isTraceLogOptional(paths),
    emptyFileIsAllowed: () => isTraceLogOptional(paths)
  });

  assertRuntimeTraceTerminalOrder(records);

  return Object.freeze(records);
}

function readAppendableRuntimeTraceEntries(
  paths: LocalRuntimeSessionPaths,
  nextEntry: RuntimeTraceEntry
): readonly RuntimeTraceEntry[] {
  const records = readRuntimeTraceEntries(paths);

  assertRuntimeTraceTerminalOrder(Object.freeze([...records, nextEntry]));
  assertSiblingLogsReadableForTraceAppend({
    paths,
    nextIdentity: nextEntry
  });

  return records;
}

function readRawEventLogRecords(
  paths: LocalRuntimeSessionPaths,
  mode: RuntimeLogReadMode = 'public'
): readonly RawEventLogRecord[] {
  const records = readJsonLines({
    filePath: paths.rawEventsPath,
    decodeLine: (line) => decodeRawEventLogRecord(line),
    missingFileIsAllowed: () => rawEventLogMissingFileIsAllowed(paths, mode),
    emptyFileIsAllowed: () => isRawEventLogOptional(paths)
  });

  if (mode === 'public') {
    assertRawEventLogIntegrity(paths, records);
  }

  return Object.freeze(records);
}

function readConversationLogRecords(
  paths: LocalRuntimeSessionPaths,
  mode: RuntimeLogReadMode = 'public'
): readonly ConversationLogRecord[] {
  const records = readJsonLines({
    filePath: paths.conversationPath,
    decodeLine: (line) => decodeConversationLogRecord(line),
    missingFileIsAllowed: () => !rawEventsRequireConversationLog(paths),
    emptyFileIsAllowed: () => !rawEventsRequireConversationLog(paths)
  });

  if (mode === 'public') {
    assertConversationLogIntegrity(paths, records);
  }

  return Object.freeze(records);
}

function readAppendableConversationLogRecords(
  paths: LocalRuntimeSessionPaths,
  nextRecord: ConversationLogRecord
): readonly ConversationLogRecord[] {
  assertRawEventLogPresentForConversationAppend(paths);

  const records = readConversationLogRecords(paths, 'append');
  const rawEvents = readRawEventLogRecords(paths, 'append');

  assertRawEventTerminalOrder(rawEvents);
  assertRawEventAppendFollowsOpenTurn({
    rawEvents,
    nextIdentity: nextRecord
  });
  assertRawEventVisibleReferencesMatchConversationMessages({
    messages: records,
    rawEvents
  });
  assertAppendableConversationLog({
    paths,
    messages: records,
    nextRecord,
    rawEvents
  });

  return records;
}

function readAppendableRawEventLogRecords(
  paths: LocalRuntimeSessionPaths,
  nextRecord: RawEventLogRecord
): readonly RawEventLogRecord[] {
  assertMissingRawEventLogAllowsRawAppend(paths, nextRecord);

  const records = readRawEventLogRecords(paths, 'append');

  assertAppendableRawEventLog({
    paths,
    rawEvents: records,
    nextRecord
  });

  return records;
}

function assertConversationLogIntegrity(
  paths: LocalRuntimeSessionPaths,
  messages: readonly ConversationLogRecord[]
): void {
  const rawEvents = readRawEventLogRecords(paths);

  assertCompleteConversationLog(messages);
  assertRawEventVisibleReferencesMatchConversationMessages({
    messages,
    rawEvents
  });
  assertRestoredConversationInvariants(paths, messages);
  assertConversationMessagesHaveTerminalRawEvidence({
    messages,
    rawEvents
  });
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

function assertAppendableConversationLog(options: {
  readonly paths: LocalRuntimeSessionPaths;
  readonly messages: readonly ConversationLogRecord[];
  readonly nextRecord: ConversationLogRecord;
  readonly rawEvents: readonly RawEventLogRecord[];
}): void {
  const completeExistingMessages =
    options.messages.length % 2 === 0
      ? options.messages
      : options.messages.slice(0, -1);

  assertConversationMessagesHaveTerminalRawEvidence({
    messages: completeExistingMessages,
    rawEvents: options.rawEvents
  });

  const nextMessages = Object.freeze([...options.messages, options.nextRecord]);

  if (options.messages.length % 2 === 0 && options.nextRecord.role === 'user') {
    assertRestoredConversationInvariants(options.paths, nextMessages, {
      allowIncompleteFinalTurn: true
    });

    return;
  }

  if (options.messages.length % 2 === 0) {
    throwIncompleteConversationLog();
  }

  const previousRecord = options.messages.at(-1);

  if (
    previousRecord?.role === 'user' &&
    options.nextRecord.role === 'character' &&
    previousRecord.eventId === options.nextRecord.eventId &&
    previousRecord.traceId === options.nextRecord.traceId
  ) {
    assertRestoredConversationInvariants(options.paths, nextMessages);
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

function readRequiredConversationLogRecords(
  paths: LocalRuntimeSessionPaths
): readonly ConversationLogRecord[] {
  return Object.freeze(
    readJsonLines({
      filePath: paths.conversationPath,
      decodeLine: (line) => decodeConversationLogRecord(line),
      missingFileIsAllowed: () => false,
      emptyFileIsAllowed: () => false
    })
  );
}

function assertRawEventLogIntegrity(
  paths: LocalRuntimeSessionPaths,
  rawEvents: readonly RawEventLogRecord[]
): void {
  assertRawEventTurnTerminalCompleteness(rawEvents);

  if (rawEventsHaveVisibleMessageReferences(rawEvents)) {
    const messages = readRequiredConversationLogRecords(paths);

    assertRestoredConversationInvariants(paths, messages);
    assertRawEventVisibleReferencesMatchConversationMessages({
      messages,
      rawEvents
    });
  }

  assertTerminalRawEventsHaveMatchingTerminalTraceEvidence({
    traceEntries: readRuntimeTraceEntries(paths),
    rawEvents
  });
}

function assertTerminalRawEventsHaveMatchingTerminalTraceEvidence(options: {
  readonly traceEntries: readonly RuntimeTraceEntry[];
  readonly rawEvents: readonly RawEventLogRecord[];
}): void {
  const terminalTraceEvidence = new Set(
    options.traceEntries
      .filter(isTerminalRuntimeTraceEntry)
      .map(terminalTraceEvidenceKey)
  );

  for (const rawEvent of options.rawEvents.filter(isTerminalRawEventLogRecord)) {
    if (
      terminalTraceEvidence.has(terminalTraceEvidenceKey({
        ...rawEvent,
        step: terminalTraceStepForRawEvent(rawEvent)
      }))
    ) {
      continue;
    }

    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Terminal raw-event evidence lacks matching terminal runtime trace evidence.'
    );
  }
}

function assertAppendableRawEventLog(options: {
  readonly paths: LocalRuntimeSessionPaths;
  readonly rawEvents: readonly RawEventLogRecord[];
  readonly nextRecord: RawEventLogRecord;
}): void {
  const nextRawEvents = Object.freeze([
    ...options.rawEvents,
    options.nextRecord
  ]);

  assertRawEventAppendFollowsOpenTurn({
    rawEvents: options.rawEvents,
    nextIdentity: options.nextRecord
  });
  assertRawEventTerminalOrder(nextRawEvents);
  assertRawEventVisibleEvidenceMatchesConversationMessages({
    paths: options.paths,
    rawEvents: nextRawEvents
  });
}

function assertMissingRawEventLogAllowsRawAppend(
  paths: LocalRuntimeSessionPaths,
  nextIdentity: { readonly eventId: string; readonly traceId: string }
): void {
  if (existsSync(paths.rawEventsPath) || !logFileHasContent(paths.tracePath)) {
    return;
  }

  const traceEntries = readRuntimeTraceEntries(paths);
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

  readRuntimeTraceEntries(paths);
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
  readonly nextIdentity: { readonly eventId: string; readonly traceId: string };
}): void {
  const rawEvents = readRawEventLogRecords(options.paths, 'appendTrace');

  assertRawEventAppendFollowsOpenTurn({
    rawEvents,
    nextIdentity: options.nextIdentity
  });
  assertRawEventVisibleEvidenceMatchesConversationMessages({
    paths: options.paths,
    rawEvents
  });
  assertConversationLogReadableForTraceAppend({
    paths: options.paths,
    rawEvents
  });
}

function assertConversationLogReadableForTraceAppend(options: {
  readonly paths: LocalRuntimeSessionPaths;
  readonly rawEvents: readonly RawEventLogRecord[];
}): void {
  const messages = readConversationLogRecords(options.paths, 'append');
  const openTurnIdentities = startedRawEventIdentitiesWithoutTerminal(
    options.rawEvents
  );
  const allowIncompleteFinalTurn = finalMessageBelongsToOpenRawTurn({
    messages,
    openTurnIdentities
  });

  if (messages.length % 2 !== 0 && !allowIncompleteFinalTurn) {
    throwIncompleteConversationLog();
  }

  assertRawEventVisibleReferencesMatchConversationMessages({
    messages,
    rawEvents: options.rawEvents
  });
  assertRestoredConversationInvariants(options.paths, messages, {
    allowIncompleteFinalTurn
  });
  assertConversationMessagesHaveTerminalRawEvidence({
    messages: messages.filter(
      (message) => !openTurnIdentities.has(runtimeEventIdentityKey(message))
    ),
    rawEvents: options.rawEvents
  });
}

function finalMessageBelongsToOpenRawTurn(options: {
  readonly messages: readonly ConversationLogRecord[];
  readonly openTurnIdentities: ReadonlySet<string>;
}): boolean {
  const finalMessage = options.messages.at(-1);

  return (
    finalMessage !== undefined &&
    options.openTurnIdentities.has(runtimeEventIdentityKey(finalMessage))
  );
}

function assertRawEventVisibleEvidenceMatchesConversationMessages(options: {
  readonly paths: LocalRuntimeSessionPaths;
  readonly rawEvents: readonly RawEventLogRecord[];
}): void {
  if (!rawEventsHaveVisibleMessageReferences(options.rawEvents)) {
    return;
  }

  const messages = readRequiredConversationLogRecords(options.paths);

  assertRestoredConversationInvariants(options.paths, messages);
  assertRawEventVisibleReferencesMatchConversationMessages({
    messages,
    rawEvents: options.rawEvents
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
  readonly recordAfterTerminalMessage: string;
  readonly terminalWithoutPrerequisiteMessage: string;
}): void {
  const prerequisiteEvidenceIdentities = new Set<string>();
  const terminalTurnIdentities = new Set<string>();

  for (const record of options.records) {
    const identityKey = runtimeEventIdentityKey(record);

    if (terminalTurnIdentities.has(identityKey)) {
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

function startedRawEventIdentitiesWithoutTerminal(
  rawEvents: readonly RawEventLogRecord[]
): ReadonlySet<string> {
  const startedTurnIdentities = new Set<string>();
  const terminalTurnIdentities = new Set<string>();

  for (const rawEvent of rawEvents) {
    const identityKey = runtimeEventIdentityKey(rawEvent);

    if (isTerminalRawEventLogRecord(rawEvent)) {
      terminalTurnIdentities.add(identityKey);
    } else {
      startedTurnIdentities.add(identityKey);
    }
  }

  for (const identityKey of terminalTurnIdentities) {
    startedTurnIdentities.delete(identityKey);
  }

  return startedTurnIdentities;
}

function rawEventsHaveVisibleMessageReferences(
  rawEvents: readonly RawEventLogRecord[]
): boolean {
  return rawEvents.some((record) => (record.visibleMessageIds ?? []).length > 0);
}

function isTraceLogOptional(paths: LocalRuntimeSessionPaths): boolean {
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
  }

  assertCompletedTerminalRawEventsMatchConversationMessages(options);
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
      .filter(isCompletedTerminalRawEventLogRecord)
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
