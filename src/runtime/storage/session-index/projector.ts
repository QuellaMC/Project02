import {eq, sql} from 'drizzle-orm';
import type {BetterSQLite3Database} from 'drizzle-orm/better-sqlite3';

import {
  closeFileSync,
  openFileSync,
  readBytesFromFileSync,
  statFileSync,
} from '../../../shared/file-system.ts';
import {isNodeErrorWithCode} from '../../../shared/node-error.ts';
import {conversationMessageForRawEvent} from '../../evidence/cache.ts';
import type {ConversationLogRecord} from '../../evidence/records.ts';
import {readUndamagedJsonLines} from '../json-lines.ts';
import {
  createLocalRuntimeSessionPaths,
  LocalRuntimeStorageContractError,
  type LocalRuntimeSessionMetadata,
  type LocalRuntimeStorageLayout,
} from '../layout-contract.ts';
import {decodeRawEventLogRecord} from '../raw-event-codec.ts';
import {decodeSessionMetadata} from '../session-store.ts';
import {readOptionalStoreText} from '../store-file.ts';
import {messagesTable, projectionStateTable} from './schema.ts';

export type LenientSessionCatalog = {
  readonly sessions: readonly LocalRuntimeSessionMetadata[];
  readonly damagedEntryCount: number;
};

/**
 * Catalog rows are decoded leniently and damage is counted, mirroring the
 * per-session rule in `decodeRequestedSessionCatalogEntry`: reading history
 * must not depend on every other entry being intact.
 */
export function readLenientSessionCatalog(
  layout: LocalRuntimeStorageLayout,
): LenientSessionCatalog {
  const content = readOptionalStoreText(layout.sessionCatalogPath);

  if (content === undefined) {
    return Object.freeze({sessions: Object.freeze([]), damagedEntryCount: 0});
  }

  const parseableLines = readUndamagedJsonLines(content);
  const committedLineCount =
    content.length === 0 ? 0 : content.split('\n').length - 1;
  const bySessionId = new Map<string, LocalRuntimeSessionMetadata>();
  let decodedLineCount = 0;

  for (const line of parseableLines) {
    try {
      const metadata = decodeSessionMetadata(line);

      decodedLineCount += 1;
      bySessionId.set(metadata.sessionId, metadata);
    } catch {
      // Counted below with the unparseable lines.
    }
  }

  return Object.freeze({
    sessions: Object.freeze([...bySessionId.values()]),
    damagedEntryCount: committedLineCount - decodedLineCount,
  });
}

/**
 * Catches the view up to the canonical transcripts inside one immediate
 * transaction; concurrent projectors serialize on it and re-read the
 * watermarks they find, so double projection cannot happen.
 */
export function projectSessionIndex(options: {
  readonly database: BetterSQLite3Database;
  readonly layout: LocalRuntimeStorageLayout;
  readonly catalog: LenientSessionCatalog;
}): void {
  options.database.transaction(
    transaction => {
      for (const session of options.catalog.sessions) {
        catchUpSession(transaction, options.layout, session.sessionId);
      }
    },
    {behavior: 'immediate'},
  );
}

/** Sum of per-session transcript damage recorded across all projections. */
export function totalProjectedTranscriptDamage(
  database: BetterSQLite3Database,
): number {
  const row: {total: number} | undefined = database.get(
    sql`SELECT total(damaged_record_count) AS total FROM projection_state`,
  );

  return row === undefined ? 0 : row.total;
}

type SessionProjectionState = {
  readonly nextByteOffset: number;
  readonly nextOrdinal: number;
  readonly damagedRecordCount: number;
};

const freshProjectionState: SessionProjectionState = Object.freeze({
  nextByteOffset: 0,
  nextOrdinal: 0,
  damagedRecordCount: 0,
});

function catchUpSession(
  database: BetterSQLite3Database,
  layout: LocalRuntimeStorageLayout,
  sessionId: string,
): void {
  const rawEventsPath = createLocalRuntimeSessionPaths({
    storeRoot: layout.storeRoot,
    sessionId,
  }).rawEventsPath;
  const stored = readProjectionState(database, sessionId);
  const tail = readCommittedTranscriptTail(
    rawEventsPath,
    stored?.nextByteOffset ?? 0,
  );

  if (tail.kind === 'stale_watermark') {
    // The transcript shrank below the watermark (replaced or deleted), so
    // the projected rows describe a file that no longer exists.
    resetSessionProjection(database, sessionId);

    const fresh = readCommittedTranscriptTail(rawEventsPath, 0);

    if (fresh.kind === 'lines') {
      applyTranscriptTail(database, sessionId, freshProjectionState, fresh);
    }

    return;
  }

  if (tail.kind === 'absent') {
    if (stored !== undefined && stored.nextByteOffset > 0) {
      resetSessionProjection(database, sessionId);
    }

    return;
  }

  if (stored === undefined || tail.consumedBytes > 0) {
    applyTranscriptTail(
      database,
      sessionId,
      stored ?? freshProjectionState,
      tail,
    );
  }
}

type CommittedTranscriptTail =
  | {readonly kind: 'absent'}
  | {readonly kind: 'stale_watermark'}
  | {
      readonly kind: 'lines';
      readonly lines: readonly string[];
      readonly consumedBytes: number;
    };

const noNewLines: CommittedTranscriptTail = Object.freeze({
  kind: 'lines',
  lines: Object.freeze([]),
  consumedBytes: 0,
});

function readCommittedTranscriptTail(
  filePath: string,
  fromOffset: number,
): CommittedTranscriptTail {
  let fileDescriptor: number;

  try {
    fileDescriptor = openFileSync(filePath, 'r');
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return {kind: 'absent'};
    }

    throw transcriptReadFailed(filePath, error);
  }

  try {
    const size = Number(statFileSync(fileDescriptor).size);

    if (size < fromOffset) {
      return {kind: 'stale_watermark'};
    }

    if (size === fromOffset) {
      return noNewLines;
    }

    const tail = Buffer.alloc(size - fromOffset);
    const bytesRead = readBytesFromFileSync(
      fileDescriptor,
      tail,
      0,
      tail.length,
      fromOffset,
    );
    // A newline byte never occurs inside a UTF-8 sequence, so a byte slice
    // ending at one is a valid string boundary; text after the final
    // newline is an unfinished append and stays unconsumed.
    const lastNewline = tail.subarray(0, bytesRead).lastIndexOf(0x0a);

    if (lastNewline === -1) {
      return noNewLines;
    }

    const consumedBytes = lastNewline + 1;
    const lines = tail
      .subarray(0, consumedBytes)
      .toString('utf8')
      .split('\n')
      .map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));

    lines.pop();
    return {kind: 'lines', lines: Object.freeze(lines), consumedBytes};
  } catch (error: unknown) {
    throw transcriptReadFailed(filePath, error);
  } finally {
    closeFileSync(fileDescriptor);
  }
}

function applyTranscriptTail(
  database: BetterSQLite3Database,
  sessionId: string,
  stored: SessionProjectionState,
  tail: {readonly lines: readonly string[]; readonly consumedBytes: number},
): void {
  const rows: (typeof messagesTable.$inferInsert)[] = [];
  let ordinal = stored.nextOrdinal;
  let damagedRecordCount = 0;

  for (const line of tail.lines) {
    let message: ConversationLogRecord | undefined;

    try {
      message = conversationMessageForRawEvent(decodeRawEventLogRecord(line));
    } catch {
      damagedRecordCount += 1;
      continue;
    }

    if (message === undefined) {
      continue;
    }

    rows.push({
      sessionId,
      messageId: message.id,
      role: message.role,
      speakerName: message.speakerName,
      text: message.text,
      committedAt: message.committedAt,
      ordinal,
    });
    ordinal += 1;
  }

  for (const chunk of chunked(rows, 200)) {
    database.insert(messagesTable).values(chunk).onConflictDoNothing().run();
  }

  database
    .insert(projectionStateTable)
    .values({
      sessionId,
      nextByteOffset: stored.nextByteOffset + tail.consumedBytes,
      nextOrdinal: ordinal,
      damagedRecordCount: stored.damagedRecordCount + damagedRecordCount,
    })
    .onConflictDoUpdate({
      target: projectionStateTable.sessionId,
      set: {
        nextByteOffset: stored.nextByteOffset + tail.consumedBytes,
        nextOrdinal: ordinal,
        damagedRecordCount: stored.damagedRecordCount + damagedRecordCount,
      },
    })
    .run();
}

function readProjectionState(
  database: BetterSQLite3Database,
  sessionId: string,
): SessionProjectionState | undefined {
  return database
    .select({
      nextByteOffset: projectionStateTable.nextByteOffset,
      nextOrdinal: projectionStateTable.nextOrdinal,
      damagedRecordCount: projectionStateTable.damagedRecordCount,
    })
    .from(projectionStateTable)
    .where(eq(projectionStateTable.sessionId, sessionId))
    .get();
}

function resetSessionProjection(
  database: BetterSQLite3Database,
  sessionId: string,
): void {
  database
    .delete(messagesTable)
    .where(eq(messagesTable.sessionId, sessionId))
    .run();
  database
    .delete(projectionStateTable)
    .where(eq(projectionStateTable.sessionId, sessionId))
    .run();
}

function chunked<T>(items: readonly T[], size: number): readonly T[][] {
  const chunks: T[][] = [];

  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }

  return chunks;
}

function transcriptReadFailed(
  filePath: string,
  cause: unknown,
): LocalRuntimeStorageContractError {
  return new LocalRuntimeStorageContractError(
    'read_failed',
    `Could not read local runtime transcript: ${filePath}.`,
    {cause},
  );
}
