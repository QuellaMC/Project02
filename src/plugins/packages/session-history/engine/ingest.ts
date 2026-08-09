import {eq, sql} from 'drizzle-orm';
import type {BetterSQLite3Database} from 'drizzle-orm/better-sqlite3';

import type {RuntimePluginSessionHistoryFeed} from '../../../api/session-history-contract.ts';
import {messagesTable, projectionStateTable} from './schema.ts';

/**
 * One transactional ingestion step; concurrent ingesters serialize on
 * the immediate transaction and re-read the cursors they find, so
 * double ingestion cannot happen. Without maxBytes it consumes the
 * whole feed tail; with it, at most one slice, so the catch-up loop can
 * yield to the event loop between slices. Returns whether it advanced.
 */
export function ingestSessionSlice(options: {
  readonly database: BetterSQLite3Database;
  readonly feed: RuntimePluginSessionHistoryFeed;
  readonly sessionId: string;
  readonly maxBytes?: number;
}): boolean {
  return options.database.transaction(
    transaction =>
      ingestSessionSliceInTransaction(
        transaction,
        options.feed,
        options.sessionId,
        options.maxBytes,
      ),
    {behavior: 'immediate'},
  );
}

/** Sum of per-session feed damage recorded across all ingestions. */
export function totalIngestedDamage(database: BetterSQLite3Database): number {
  const row: {total: number} | undefined = database.get(
    sql`SELECT total(damaged_record_count) AS total FROM projection_state`,
  );

  return row === undefined ? 0 : row.total;
}

type SessionIngestState = {
  readonly nextCursor: string | undefined;
  readonly nextOrdinal: number;
  readonly damagedRecordCount: number;
};

const freshIngestState: SessionIngestState = Object.freeze({
  nextCursor: undefined,
  nextOrdinal: 0,
  damagedRecordCount: 0,
});

function ingestSessionSliceInTransaction(
  database: BetterSQLite3Database,
  feed: RuntimePluginSessionHistoryFeed,
  sessionId: string,
  maxBytes: number | undefined,
): boolean {
  const stored = readIngestState(database, sessionId);
  let state = stored ?? freshIngestState;
  const batch = feed.readNewMessages({
    sessionId,
    ...(state.nextCursor === undefined ? {} : {cursor: state.nextCursor}),
    ...(maxBytes === undefined ? {} : {maxBytes}),
  });

  if (batch.reset) {
    // The transcript no longer matches the cursor: previously ingested
    // rows describe history that no longer exists.
    resetSessionIngest(database, sessionId);
    state = freshIngestState;
  }

  const cursorAdvanced = batch.reset || batch.nextCursor !== state.nextCursor;

  if (!cursorAdvanced && stored !== undefined) {
    return false;
  }

  let ordinal = state.nextOrdinal;
  const rows: (typeof messagesTable.$inferInsert)[] = batch.messages.map(
    message => ({
      sessionId,
      messageId: message.messageId,
      role: message.role,
      speakerName: message.speakerName,
      text: message.text,
      committedAt: message.committedAt,
      ordinal: ordinal++,
    }),
  );

  for (const chunk of chunked(rows, 200)) {
    database.insert(messagesTable).values(chunk).onConflictDoNothing().run();
  }

  database
    .insert(projectionStateTable)
    .values({
      sessionId,
      nextCursor: batch.nextCursor,
      nextOrdinal: ordinal,
      damagedRecordCount: state.damagedRecordCount + batch.damagedRecordCount,
    })
    .onConflictDoUpdate({
      target: projectionStateTable.sessionId,
      set: {
        nextCursor: batch.nextCursor,
        nextOrdinal: ordinal,
        damagedRecordCount: state.damagedRecordCount + batch.damagedRecordCount,
      },
    })
    .run();

  return cursorAdvanced;
}

function readIngestState(
  database: BetterSQLite3Database,
  sessionId: string,
): SessionIngestState | undefined {
  return database
    .select({
      nextCursor: projectionStateTable.nextCursor,
      nextOrdinal: projectionStateTable.nextOrdinal,
      damagedRecordCount: projectionStateTable.damagedRecordCount,
    })
    .from(projectionStateTable)
    .where(eq(projectionStateTable.sessionId, sessionId))
    .get();
}

function resetSessionIngest(
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
