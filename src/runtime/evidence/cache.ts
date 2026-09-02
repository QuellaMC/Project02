import {statPathSync} from '../../shared/file-system.ts';
import {basename} from 'node:path';
import {isNodeErrorWithCode} from '../../shared/node-error.ts';
import {filesystemMetadataIdentity} from '../../shared/package-metadata.ts';
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
import type {ConversationLogRecord, RawEventLogRecord} from './records.ts';
import type {
  RuntimeEvidenceFileStamp,
  RuntimeEvidenceFileStamps,
} from './contract.ts';

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
    ...(rawEvent.source === undefined ? {} : {source: rawEvent.source}),
    ...(rawEvent.clientMessageId === undefined
      ? {}
      : {clientMessageId: rawEvent.clientMessageId}),
  } satisfies ConversationLogRecord);
}

/**
 * Codec-valid lines, not yet a validated session: only what replays through
 * the transition machine is evidence.
 */
export function readCoherentRuntimeSessionRecords(
  paths: LocalRuntimeSessionPaths,
  onEvidenceFileRead:
    | ((event: {readonly filePath: string; readonly attempt: number}) => void)
    | undefined,
): {
  readonly stamps: RuntimeEvidenceFileStamps;
  readonly rawEvents: readonly RawEventLogRecord[];
} {
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

    return {
      stamps: after,
      rawEvents: decodeRuntimeEvidenceJsonLines({
        filePath: paths.rawEventsPath,
        content: contents.rawEvents,
        decodeLine: decodeRawEventLogRecord,
      }),
    };
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
  readonly rawEvents: string | undefined;
} {
  return Object.freeze({
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
 * A record a crash left unfinished is skipped; a damaged committed record
 * fails the read.
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
    rawEvents: readRuntimeEvidenceFileStamp(paths.rawEventsPath),
  });
}

function readRuntimeEvidenceFileStamp(
  filePath: string,
): RuntimeEvidenceFileStamp {
  try {
    return Object.freeze({
      exists: true,
      identity: filesystemMetadataIdentity(statPathSync(filePath)),
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
  return sameRuntimeEvidenceFileStamp(left.rawEvents, right.rawEvents);
}

function sameRuntimeEvidenceFileStamp(
  left: RuntimeEvidenceFileStamp,
  right: RuntimeEvidenceFileStamp,
): boolean {
  return left.exists && right.exists
    ? left.identity === right.identity
    : left.exists === right.exists;
}

export function scavengeAbandonedRuntimeEvidenceTemporaryFiles(
  paths: LocalRuntimeSessionPaths,
): void {
  try {
    cleanupAbandonedAtomicReplacementsIn(paths.sessionRoot, [
      basename(paths.rawEventsPath),
    ]);
  } catch (error: unknown) {
    throw storeWriteFailed(paths.sessionRoot, error);
  }
}
