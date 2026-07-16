import { type Dirent, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename } from 'node:path';
import {
  CompleteJsonLinesError,
  splitCompleteJsonLines
} from './json-lines.ts';
import { isNodeErrorWithCode } from '../../shared/node-error.ts';
import {
  LocalRuntimeStorageContractError,
  type LocalRuntimeSessionPaths
} from './layout-contract.ts';
import {
  atomicReplacementFileBelongsToTarget,
  isAbandonedAtomicReplacementFile
} from './atomic-file.ts';
import { decodeConversationLogRecord } from './conversation-codec.ts';
import { decodeRawEventLogRecord } from './raw-event-codec.ts';
import { decodeRuntimeTraceEntry } from './trace-codec.ts';
import type {
  CachedRuntimeSessionEvidence,
  DurableRuntimeSessionEvidence,
  MutableDurableRuntimeSessionEvidence,
  RuntimeEvidenceFileStamp,
  RuntimeEvidenceFileStamps
} from './runtime-evidence-contract.ts';

export function createMutableDurableRuntimeSessionEvidence(
  evidence: DurableRuntimeSessionEvidence
): MutableDurableRuntimeSessionEvidence {
  return {
    traceEntries: [...evidence.traceEntries],
    rawEvents: [...evidence.rawEvents],
    conversationMessages: [...evidence.conversationMessages]
  };
}

export function readCoherentRuntimeSessionEvidence(
  paths: LocalRuntimeSessionPaths,
  onEvidenceFileRead:
    | ((event: { readonly filePath: string; readonly attempt: number }) => void)
    | undefined
): CachedRuntimeSessionEvidence {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = readRuntimeEvidenceFileStamps(paths);
    const contents = readRuntimeEvidenceFileContents(
      paths,
      before,
      attempt,
      onEvidenceFileRead
    );
    const after = readRuntimeEvidenceFileStamps(paths);

    if (!sameRuntimeEvidenceFileStamps(before, after)) {
      continue;
    }

    const evidence = createMutableDurableRuntimeSessionEvidence({
      traceEntries: decodeRuntimeEvidenceJsonLines({
        filePath: paths.tracePath,
        content: contents.trace,
        decodeLine: decodeRuntimeTraceEntry
      }),
      rawEvents: decodeRuntimeEvidenceJsonLines({
        filePath: paths.rawEventsPath,
        content: contents.rawEvents,
        decodeLine: decodeRawEventLogRecord
      }),
      conversationMessages: decodeRuntimeEvidenceJsonLines({
        filePath: paths.conversationPath,
        content: contents.conversation,
        decodeLine: decodeConversationLogRecord
      })
    });

    return { stamps: after, evidence };
  }

  throw new LocalRuntimeStorageContractError(
    'concurrent_write',
    `Local runtime evidence changed during a coherent read: ${paths.sessionId}.`
  );
}

function readRuntimeEvidenceFileContents(
  paths: LocalRuntimeSessionPaths,
  stamps: RuntimeEvidenceFileStamps,
  attempt: number,
  onEvidenceFileRead:
    | ((event: { readonly filePath: string; readonly attempt: number }) => void)
    | undefined
): {
  readonly trace: string | undefined;
  readonly rawEvents: string | undefined;
  readonly conversation: string | undefined;
} {
  return Object.freeze({
    trace: readStampedRuntimeEvidenceFile(
      paths.tracePath,
      stamps.trace,
      attempt,
      onEvidenceFileRead
    ),
    rawEvents: readStampedRuntimeEvidenceFile(
      paths.rawEventsPath,
      stamps.rawEvents,
      attempt,
      onEvidenceFileRead
    ),
    conversation: readStampedRuntimeEvidenceFile(
      paths.conversationPath,
      stamps.conversation,
      attempt,
      onEvidenceFileRead
    )
  });
}

function readStampedRuntimeEvidenceFile(
  filePath: string,
  stamp: RuntimeEvidenceFileStamp,
  attempt: number,
  onEvidenceFileRead:
    | ((event: { readonly filePath: string; readonly attempt: number }) => void)
    | undefined
): string | undefined {
  if (!stamp.exists) {
    return undefined;
  }

  try {
    const content = readFileSync(filePath, 'utf8');
    onEvidenceFileRead?.({ filePath, attempt });
    return content;
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return undefined;
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not read local runtime log file: ${filePath}.`,
      { cause: error }
    );
  }
}

function decodeRuntimeEvidenceJsonLines<T>(options: {
  readonly filePath: string;
  readonly content: string | undefined;
  readonly decodeLine: (line: string) => T;
}): readonly T[] {
  if (options.content === undefined || options.content.length === 0) {
    return Object.freeze([]);
  }

  try {
    return Object.freeze(
      splitCompleteJsonLines(options.content).map(options.decodeLine)
    );
  } catch (error: unknown) {
    if (error instanceof CompleteJsonLinesError) {
      throw new LocalRuntimeStorageContractError(
        error.reason === 'missing_terminal_newline'
          ? 'partial_write'
          : 'malformed_record',
        error.reason === 'missing_terminal_newline'
          ? `Local runtime log file ended without a complete JSONL record: ${options.filePath}.`
          : `Local runtime log file contains a blank JSONL record: ${options.filePath}.`,
        { cause: error }
      );
    }

    throw error;
  }
}

export function readRuntimeEvidenceFileStamps(
  paths: LocalRuntimeSessionPaths
): RuntimeEvidenceFileStamps {
  return Object.freeze({
    trace: readRuntimeEvidenceFileStamp(paths.tracePath),
    rawEvents: readRuntimeEvidenceFileStamp(paths.rawEventsPath),
    conversation: readRuntimeEvidenceFileStamp(paths.conversationPath)
  });
}

function readRuntimeEvidenceFileStamp(filePath: string): RuntimeEvidenceFileStamp {
  try {
    const stat = statSync(filePath, { bigint: true });

    return Object.freeze({
      exists: true,
      device: stat.dev,
      inode: stat.ino,
      size: stat.size,
      modifiedAtNanoseconds: stat.mtimeNs,
      changedAtNanoseconds: stat.ctimeNs
    });
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return Object.freeze({ exists: false });
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not inspect local runtime log file: ${filePath}.`,
      { cause: error }
    );
  }
}

export function sameRuntimeEvidenceFileStamps(
  left: RuntimeEvidenceFileStamps,
  right: RuntimeEvidenceFileStamps
): boolean {
  return (
    sameRuntimeEvidenceFileStamp(left.trace, right.trace) &&
    sameRuntimeEvidenceFileStamp(left.rawEvents, right.rawEvents) &&
    sameRuntimeEvidenceFileStamp(left.conversation, right.conversation)
  );
}

function sameRuntimeEvidenceFileStamp(
  left: RuntimeEvidenceFileStamp,
  right: RuntimeEvidenceFileStamp
): boolean {
  if (!left.exists || !right.exists) {
    return left.exists === right.exists;
  }

  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAtNanoseconds === right.modifiedAtNanoseconds &&
    left.changedAtNanoseconds === right.changedAtNanoseconds
  );
}

export function scavengeAbandonedRuntimeEvidenceTemporaryFiles(
  paths: LocalRuntimeSessionPaths
): void {
  let entries: Dirent[];

  try {
    entries = readdirSync(paths.sessionRoot, { withFileTypes: true });
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return;
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not inspect local runtime evidence temporary files: ${paths.sessionRoot}.`,
      { cause: error }
    );
  }

  const targetNames = [
    basename(paths.tracePath),
    basename(paths.rawEventsPath),
    basename(paths.conversationPath)
  ];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    if (
      !targetNames.some((targetName) =>
        atomicReplacementFileBelongsToTarget(entry.name, targetName)
      ) ||
      !isAbandonedAtomicReplacementFile(entry.name)
    ) {
      continue;
    }

    try {
      unlinkSync(`${paths.sessionRoot}/${entry.name}`);
    } catch (error: unknown) {
      if (!isNodeErrorWithCode(error, 'ENOENT')) {
        throw new LocalRuntimeStorageContractError(
          'write_failed',
          `Could not remove abandoned local runtime evidence temporary file: ${entry.name}.`,
          { cause: error }
        );
      }
    }
  }
}
