import {statPathSync} from '../../shared/file-system.ts';
import {basename} from 'node:path';
import {isNodeErrorWithCode} from '../../shared/node-error.ts';
import {
  LocalRuntimeStorageContractError,
  type LocalRuntimeSessionPaths,
} from '../storage/layout-contract.ts';
import {cleanupAbandonedAtomicReplacementsIn} from '../storage/atomic-file.ts';
import {
  readOptionalStoreText,
  readStoreJsonLines,
  storeWriteFailed,
} from '../storage/store-file.ts';
import {decodeRawEventLogRecord} from '../storage/raw-event-codec.ts';
import {decodeRuntimeTraceEntry} from '../storage/trace-codec.ts';
import type {ConversationLogRecord, RawEventLogRecord} from './records.ts';
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

/**
 * The transcript, rebuilt from the events that committed it. Message text
 * has one home: the commit event that made it visible.
 */
export function conversationMessagesFromRawEvents(
  rawEvents: readonly RawEventLogRecord[],
): readonly ConversationLogRecord[] {
  return Object.freeze(
    rawEvents.flatMap(rawEvent => {
      const message = conversationMessageForRawEvent(rawEvent);

      return message === undefined ? [] : [message];
    }),
  );
}

/** The message a commit event carries, or undefined for any other event. */
export function conversationMessageForRawEvent(
  rawEvent: RawEventLogRecord,
): ConversationLogRecord | undefined {
  if (
    rawEvent.kind !== 'visible_message_committed' ||
    rawEvent.visibleMessage === undefined ||
    rawEvent.committedAt === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    eventId: rawEvent.eventId,
    traceId: rawEvent.traceId,
    createdAt: rawEvent.createdAt,
    committedAt: rawEvent.committedAt,
    ...rawEvent.visibleMessage,
  } satisfies ConversationLogRecord);
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
        filePath: paths.tracePath,
        content: contents.trace,
        decodeLine: decodeRuntimeTraceEntry,
      }),
      rawEvents: decodeRuntimeEvidenceJsonLines({
        filePath: paths.rawEventsPath,
        content: contents.rawEvents,
        decodeLine: decodeRawEventLogRecord,
      }),
      conversationMessages: [],
    });

    evidence.conversationMessages.push(
      ...conversationMessagesFromRawEvents(evidence.rawEvents),
    );

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
 * The file's committed records. A record a crash left unfinished is
 * skipped, so an interrupted write costs its own record rather than the
 * session around it; a committed record that is damaged fails the read
 * as a store contract error naming the file.
 */
function decodeRuntimeEvidenceJsonLines<T>(options: {
  readonly filePath: string;
  readonly content: string | undefined;
  readonly decodeLine: (line: string) => T;
}): readonly T[] {
  if (options.content === undefined || options.content.length === 0) {
    return Object.freeze([]);
  }

  return Object.freeze(
    readStoreJsonLines(options.filePath, options.content).map(
      options.decodeLine,
    ),
  );
}

export function readRuntimeEvidenceFileStamps(
  paths: LocalRuntimeSessionPaths,
): RuntimeEvidenceFileStamps {
  return Object.freeze({
    trace: readRuntimeEvidenceFileStamp(paths.tracePath),
    rawEvents: readRuntimeEvidenceFileStamp(paths.rawEventsPath),
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
    sameRuntimeEvidenceFileStamp(left.rawEvents, right.rawEvents)
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
    ]);
  } catch (error: unknown) {
    throw storeWriteFailed(paths.sessionRoot, error);
  }
}
