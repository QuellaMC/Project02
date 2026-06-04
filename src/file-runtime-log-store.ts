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
    readJsonLines(paths.tracePath, (line) => decodeRuntimeTraceEntry(line))
  );
}

function readRawEventLogRecords(
  paths: LocalRuntimeSessionPaths
): readonly RawEventLogRecord[] {
  return Object.freeze(
    readJsonLines(paths.rawEventsPath, (line) => decodeRawEventLogRecord(line))
  );
}

function readConversationLogRecords(
  paths: LocalRuntimeSessionPaths
): readonly ConversationLogRecord[] {
  return Object.freeze(
    readJsonLines(paths.conversationPath, (line) => decodeConversationLogRecord(line))
  );
}

function readJsonLines<T>(
  filePath: string,
  decodeLine: (line: string) => T
): T[] {
  const content = readLogFile(filePath);

  if (content === undefined || content.length === 0) {
    return [];
  }

  if (!content.endsWith('\n')) {
    throw new LocalRuntimeStorageContractError(
      'partial_write',
      `Local runtime log file ended without a complete JSONL record: ${filePath}.`
    );
  }

  const lines = content.split('\n');
  const records: T[] = [];

  for (const [index, line] of lines.entries()) {
    const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line;

    if (index === lines.length - 1 && normalizedLine.length === 0) {
      continue;
    }

    records.push(decodeLine(normalizedLine));
  }

  return records;
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
