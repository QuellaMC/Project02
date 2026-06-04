import { appendFileSync, existsSync, readFileSync } from 'node:fs';

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
        validateExisting: () => readRuntimeTraceEntries(paths)
      });

      return storedEntry;
    },
    appendRawEvent(record) {
      const encoded = encodeRawEventLogRecord(record);
      const storedRecord = decodeRawEventLogRecord(encoded);
      assertReferencedConversationMessagesExist(paths, storedRecord);

      appendJsonLine({
        filePath: paths.rawEventsPath,
        line: encodeRawEventLogRecord(storedRecord),
        assertSessionReadable,
        validateExisting: () => readRawEventLogRecords(paths)
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
        validateExisting: () => readConversationLogRecords(paths)
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
  paths: LocalRuntimeSessionPaths
): readonly RuntimeTraceEntry[] {
  return Object.freeze(
    readJsonLines({
      filePath: paths.tracePath,
      decodeLine: (line) => decodeRuntimeTraceEntry(line),
      missingFileIsAllowed: () => true
    })
  );
}

function readRawEventLogRecords(
  paths: LocalRuntimeSessionPaths
): readonly RawEventLogRecord[] {
  return Object.freeze(
    readJsonLines({
      filePath: paths.rawEventsPath,
      decodeLine: (line) => decodeRawEventLogRecord(line),
      missingFileIsAllowed: () => true
    })
  );
}

function readConversationLogRecords(
  paths: LocalRuntimeSessionPaths
): readonly ConversationLogRecord[] {
  return Object.freeze(
    readJsonLines({
      filePath: paths.conversationPath,
      decodeLine: (line) => decodeConversationLogRecord(line),
      missingFileIsAllowed: () => !rawEventsRequireConversationLog(paths)
    })
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

function assertReferencedConversationMessagesExist(
  paths: LocalRuntimeSessionPaths,
  record: RawEventLogRecord
): void {
  const visibleMessageIds = record.visibleMessageIds ?? [];

  if (visibleMessageIds.length === 0) {
    return;
  }

  const messagesById = new Set(
    readRequiredConversationLogRecords(paths).map((message) => message.id)
  );

  for (const messageId of visibleMessageIds) {
    if (!messagesById.has(messageId)) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        `Raw event references a missing visible conversation message: ${messageId}.`
      );
    }
  }
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
  return readRawEventLogRecords(paths).some((record) => {
    return (
      record.visibleMessageIds !== undefined &&
      record.visibleMessageIds.length > 0
    );
  });
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
