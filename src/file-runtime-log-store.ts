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
import { assertLocalRuntimeSessionReadable } from './session-store.ts';

export type CreateFileRuntimeLogStoreOptions = LocalRuntimeSessionPathsOptions;
type RuntimeLogReadMode = 'append' | 'public';

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
        validateExisting: () => readRuntimeTraceEntries(paths, 'append')
      });

      return storedEntry;
    },
    appendRawEvent(record) {
      const encoded = encodeRawEventLogRecord(record);
      const storedRecord = decodeRawEventLogRecord(encoded);
      assertReferencedConversationMessagesMatch(paths, storedRecord);

      appendJsonLine({
        filePath: paths.rawEventsPath,
        line: encodeRawEventLogRecord(storedRecord),
        assertSessionReadable,
        validateExisting: () => readRawEventLogRecords(paths, 'append')
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

function readRuntimeTraceEntries(
  paths: LocalRuntimeSessionPaths,
  mode: RuntimeLogReadMode = 'public'
): readonly RuntimeTraceEntry[] {
  return Object.freeze(
    readJsonLines({
      filePath: paths.tracePath,
      decodeLine: (line) => decodeRuntimeTraceEntry(line),
      missingFileIsAllowed: () =>
        mode === 'append' ||
        (!logFileHasContent(paths.rawEventsPath) &&
          !logFileHasContent(paths.conversationPath))
    })
  );
}

function readRawEventLogRecords(
  paths: LocalRuntimeSessionPaths,
  mode: RuntimeLogReadMode = 'public'
): readonly RawEventLogRecord[] {
  const records = readJsonLines({
    filePath: paths.rawEventsPath,
    decodeLine: (line) => decodeRawEventLogRecord(line),
    missingFileIsAllowed: () =>
      mode === 'append' ||
      (!logFileHasContent(paths.tracePath) &&
        !logFileHasContent(paths.conversationPath))
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
    missingFileIsAllowed: () => !rawEventsRequireConversationLog(paths)
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
  const records = readConversationLogRecords(paths, 'append');
  const rawEvents = readRawEventLogRecords(paths, 'append');

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

function readRequiredConversationLogRecords(
  paths: LocalRuntimeSessionPaths
): readonly ConversationLogRecord[] {
  return Object.freeze(
    readJsonLines({
      filePath: paths.conversationPath,
      decodeLine: (line) => decodeConversationLogRecord(line),
      missingFileIsAllowed: () => false
    })
  );
}

function assertRawEventLogIntegrity(
  paths: LocalRuntimeSessionPaths,
  rawEvents: readonly RawEventLogRecord[]
): void {
  if (!rawEvents.some((record) => (record.visibleMessageIds ?? []).length > 0)) {
    return;
  }

  const messages = readRequiredConversationLogRecords(paths);

  assertRestoredConversationInvariants(paths, messages);
  assertRawEventVisibleReferencesMatchConversationMessages({
    messages,
    rawEvents
  });
}

function assertReferencedConversationMessagesMatch(
  paths: LocalRuntimeSessionPaths,
  record: RawEventLogRecord
): void {
  if (record.visibleMessageIds === undefined || record.visibleMessageIds.length === 0) {
    return;
  }

  assertRawEventVisibleReferencesMatchConversationMessages({
    messages: readRequiredConversationLogRecords(paths),
    rawEvents: [record]
  });
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

function visibleMessageEvidenceKey(
  identity: { readonly eventId: string; readonly traceId: string },
  messageId: string
): string {
  return `${identity.eventId}\u0000${identity.traceId}\u0000${messageId}`;
}

function readJsonLines<T>(options: {
  readonly filePath: string;
  readonly decodeLine: (line: string) => T;
  readonly missingFileIsAllowed: () => boolean;
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
