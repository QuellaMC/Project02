import {statPathSync} from '../../shared/file-system.ts';
import {basename} from 'node:path';
import {readCompleteJsonLines} from '../storage/json-lines.ts';
import {isNodeErrorWithCode} from '../../shared/node-error.ts';
import {
  LocalRuntimeStorageContractError,
  type LocalRuntimeSessionPaths,
} from '../storage/layout-contract.ts';
import {cleanupAbandonedAtomicReplacementsIn} from '../storage/atomic-file.ts';
import {
  readOptionalStoreText,
  storeWriteFailed,
} from '../storage/store-file.ts';
import {decodeConversationLogRecord} from '../storage/conversation-codec.ts';
import {decodeRawEventLogRecord} from '../storage/raw-event-codec.ts';
import {decodeRuntimeTraceEntry} from '../storage/trace-codec.ts';
import type {
  CachedRuntimeSessionEvidence,
  DurableRuntimeSessionEvidence,
  MutableDurableRuntimeSessionEvidence,
  RuntimeEvidenceFileStamp,
  RuntimeEvidenceFileStamps,
} from './contract.ts';

export function createMutableDurableRuntimeSessionEvidence(
  evidence: DurableRuntimeSessionEvidence,
): MutableDurableRuntimeSessionEvidence {
  return {
    traceEntries: [...evidence.traceEntries],
    rawEvents: [...evidence.rawEvents],
    conversationMessages: [...evidence.conversationMessages],
  };
}

export function readCoherentRuntimeSessionEvidence(
  paths: LocalRuntimeSessionPaths,
  onEvidenceFileRead:
    | ((event: {readonly filePath: string; readonly attempt: number}) => void)
    | undefined,
): CachedRuntimeSessionEvidence {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = readRuntimeEvidenceFileStamps(paths);
    const contents = readRuntimeEvidenceFileContents(
      paths,
      before,
      attempt,
      onEvidenceFileRead,
    );
    const after = readRuntimeEvidenceFileStamps(paths);

    if (!sameRuntimeEvidenceFileStamps(before, after)) {
      continue;
    }

    const evidence = createMutableDurableRuntimeSessionEvidence({
      traceEntries: decodeRuntimeEvidenceJsonLines({
        content: contents.trace,
        decodeLine: decodeRuntimeTraceEntry,
      }),
      rawEvents: decodeRuntimeEvidenceJsonLines({
        content: contents.rawEvents,
        decodeLine: decodeRawEventLogRecord,
      }),
      conversationMessages: decodeRuntimeEvidenceJsonLines({
        content: contents.conversation,
        decodeLine: decodeConversationLogRecord,
      }),
    });

    return {stamps: after, evidence};
  }

  throw new LocalRuntimeStorageContractError(
    'concurrent_write',
    `Local runtime evidence changed during a coherent read: ${paths.sessionId}.`,
  );
}

function readRuntimeEvidenceFileContents(
  paths: LocalRuntimeSessionPaths,
  stamps: RuntimeEvidenceFileStamps,
  attempt: number,
  onEvidenceFileRead:
    | ((event: {readonly filePath: string; readonly attempt: number}) => void)
    | undefined,
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
      onEvidenceFileRead,
    ),
    rawEvents: readStampedRuntimeEvidenceFile(
      paths.rawEventsPath,
      stamps.rawEvents,
      attempt,
      onEvidenceFileRead,
    ),
    conversation: readStampedRuntimeEvidenceFile(
      paths.conversationPath,
      stamps.conversation,
      attempt,
      onEvidenceFileRead,
    ),
  });
}

function readStampedRuntimeEvidenceFile(
  filePath: string,
  stamp: RuntimeEvidenceFileStamp,
  attempt: number,
  onEvidenceFileRead:
    | ((event: {readonly filePath: string; readonly attempt: number}) => void)
    | undefined,
): string | undefined {
  if (!stamp.exists) {
    return undefined;
  }

  const content = readOptionalStoreText(filePath);

  if (content === undefined) {
    return undefined;
  }

  onEvidenceFileRead?.({filePath, attempt});
  return content;
}

/**
 * Records that decode. A line a crash left unfinished is skipped rather
 * than failing the read, so an interrupted write costs its own record and
 * not the session around it.
 */
function decodeRuntimeEvidenceJsonLines<T>(options: {
  readonly content: string | undefined;
  readonly decodeLine: (line: string) => T;
}): readonly T[] {
  if (options.content === undefined || options.content.length === 0) {
    return Object.freeze([]);
  }

  return Object.freeze(
    readCompleteJsonLines(options.content).map(options.decodeLine),
  );
}

export function readRuntimeEvidenceFileStamps(
  paths: LocalRuntimeSessionPaths,
): RuntimeEvidenceFileStamps {
  return Object.freeze({
    trace: readRuntimeEvidenceFileStamp(paths.tracePath),
    rawEvents: readRuntimeEvidenceFileStamp(paths.rawEventsPath),
    conversation: readRuntimeEvidenceFileStamp(paths.conversationPath),
  });
}

function readRuntimeEvidenceFileStamp(
  filePath: string,
): RuntimeEvidenceFileStamp {
  try {
    const stat = statPathSync(filePath);

    return Object.freeze({
      exists: true,
      device: stat.dev,
      inode: stat.ino,
      size: stat.size,
      modifiedAtNanoseconds: stat.mtimeNs,
      changedAtNanoseconds: stat.ctimeNs,
    });
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return Object.freeze({exists: false});
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not inspect local runtime log file: ${filePath}.`,
      {cause: error},
    );
  }
}

export function sameRuntimeEvidenceFileStamps(
  left: RuntimeEvidenceFileStamps,
  right: RuntimeEvidenceFileStamps,
): boolean {
  return (
    sameRuntimeEvidenceFileStamp(left.trace, right.trace) &&
    sameRuntimeEvidenceFileStamp(left.rawEvents, right.rawEvents) &&
    sameRuntimeEvidenceFileStamp(left.conversation, right.conversation)
  );
}

function sameRuntimeEvidenceFileStamp(
  left: RuntimeEvidenceFileStamp,
  right: RuntimeEvidenceFileStamp,
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
  paths: LocalRuntimeSessionPaths,
): void {
  try {
    cleanupAbandonedAtomicReplacementsIn(paths.sessionRoot, [
      basename(paths.tracePath),
      basename(paths.rawEventsPath),
      basename(paths.conversationPath),
    ]);
  } catch (error: unknown) {
    throw storeWriteFailed(paths.sessionRoot, error);
  }
}
