import {and, asc, eq, gte, lte, max, or, sql} from 'drizzle-orm';
import type {BetterSQLite3Database} from 'drizzle-orm/better-sqlite3';

import type {RuntimePluginSessionHistoryMessage} from '../../../api/session-history-contract.ts';
import type {SessionIndexSessionView} from './contract.ts';
import {messagesTable} from './schema.ts';

// Hermes-style retrieval bounds: scan the best raw hits, then present one
// anchored view per session so results carry conversation context instead
// of disconnected messages.
const searchScanLimit = 300;
const anchoredViewBookendCount = 2;
const anchoredViewRadius = 3;

// The trigram tokenizer cannot match fewer than three characters.
const ftsMinimumQueryCodePoints = 3;

const cjkPattern =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export type SessionSearchHits = {
  readonly views: readonly SessionIndexSessionView[];
  readonly totalSessionsWithHits: number;
};

export function searchSessionIndex(options: {
  readonly database: BetterSQLite3Database;
  readonly query: string;
  readonly sessionId?: string;
  readonly sessionLimit: number;
}): SessionSearchHits {
  const query = options.query.trim();

  if (query.length === 0) {
    return Object.freeze({
      views: Object.freeze([]),
      totalSessionsWithHits: 0,
    });
  }

  const hits = routedSearchHits(options.database, query, options.sessionId);
  const bestHits = bestHitPerSession(hits);
  const rankedHits = [...bestHits.values()].sort(compareBestHits);
  const views = rankedHits
    .slice(0, Math.max(1, options.sessionLimit))
    .map(hit => anchoredSessionView(options.database, hit))
    .filter(view => view !== undefined);

  return Object.freeze({
    views: Object.freeze(views),
    totalSessionsWithHits: bestHits.size,
  });
}

type RawSearchHit = {
  readonly sessionId: string;
  readonly ordinal: number;
  readonly committedAt: string;
  readonly rank: number;
};

/**
 * Query routing, in Hermes's shape minus its compiled CJK tokenizer:
 * substring LIKE for queries too short to form a trigram, the trigram
 * index for CJK text unicode61 cannot segment, and the word index first
 * for everything else with a trigram retry when it finds nothing.
 */
function routedSearchHits(
  database: BetterSQLite3Database,
  query: string,
  sessionId: string | undefined,
): readonly RawSearchHit[] {
  if (codePointCount(query) < ftsMinimumQueryCodePoints) {
    return substringSearchHits(database, query, sessionId);
  }

  if (cjkPattern.test(query)) {
    return ftsSearchHits(database, 'messages_fts_trigram', query, sessionId);
  }

  const wordHits = ftsSearchHits(database, 'messages_fts', query, sessionId);

  return wordHits.length > 0
    ? wordHits
    : ftsSearchHits(database, 'messages_fts_trigram', query, sessionId);
}

function ftsSearchHits(
  database: BetterSQLite3Database,
  ftsTable: 'messages_fts' | 'messages_fts_trigram',
  query: string,
  sessionId: string | undefined,
): readonly RawSearchHit[] {
  // Always a single quoted phrase: the model's query is literal text, not
  // FTS boolean syntax.
  const phrase = `"${query.replaceAll('"', '""')}"`;
  const sessionFilter =
    sessionId === undefined ? sql`` : sql`WHERE m.session_id = ${sessionId}`;

  return database.all<RawSearchHit>(sql`
    SELECT m.session_id AS sessionId,
           m.ordinal AS ordinal,
           m.committed_at AS committedAt,
           f.rank AS rank
    FROM ${sql.raw(ftsTable)}(${phrase}) AS f
    JOIN messages AS m ON m.id = f.rowid
    ${sessionFilter}
    ORDER BY f.rank
    LIMIT ${searchScanLimit}
  `);
}

function substringSearchHits(
  database: BetterSQLite3Database,
  query: string,
  sessionId: string | undefined,
): readonly RawSearchHit[] {
  const pattern = `%${escapeLikePattern(query.toLowerCase())}%`;
  const sessionFilter =
    sessionId === undefined ? sql`` : sql`AND m.session_id = ${sessionId}`;

  return database.all<RawSearchHit>(sql`
    SELECT m.session_id AS sessionId,
           m.ordinal AS ordinal,
           m.committed_at AS committedAt,
           0 AS rank
    FROM messages AS m
    WHERE lower(m.text) LIKE ${pattern} ESCAPE '\\' ${sessionFilter}
    ORDER BY m.committed_at DESC, m.session_id ASC, m.ordinal DESC
    LIMIT ${searchScanLimit}
  `);
}

function escapeLikePattern(text: string): string {
  return text.replaceAll(/[\\%_]/gu, match => `\\${match}`);
}

function codePointCount(text: string): number {
  let count = 0;

  for (let index = 0; index < text.length; count += 1) {
    const codePoint = text.codePointAt(index) ?? 0;

    index += codePoint > 0xffff ? 2 : 1;
  }

  return count;
}

/** Hits arrive best-first, so the first hit seen per session is its best. */
function bestHitPerSession(
  hits: readonly RawSearchHit[],
): Map<string, RawSearchHit> {
  const bySessionId = new Map<string, RawSearchHit>();

  for (const hit of hits) {
    if (!bySessionId.has(hit.sessionId)) {
      bySessionId.set(hit.sessionId, hit);
    }
  }

  return bySessionId;
}

/** BM25 rank first (lower is better); recency breaks ties. */
function compareBestHits(left: RawSearchHit, right: RawSearchHit): number {
  if (left.rank !== right.rank) {
    return left.rank - right.rank;
  }
  if (left.committedAt === right.committedAt) {
    return 0;
  }

  return left.committedAt < right.committedAt ? 1 : -1;
}

function anchoredSessionView(
  database: BetterSQLite3Database,
  hit: RawSearchHit,
): SessionIndexSessionView | undefined {
  const lastOrdinal = database
    .select({value: max(messagesTable.ordinal)})
    .from(messagesTable)
    .where(eq(messagesTable.sessionId, hit.sessionId))
    .get()?.value;

  if (lastOrdinal === null || lastOrdinal === undefined) {
    return undefined;
  }

  // Ordinals are dense per session, so the view boundaries are arithmetic;
  // bookends that would overlap the window collapse to nothing.
  const windowStart = Math.max(0, hit.ordinal - anchoredViewRadius);
  const windowEnd = Math.min(lastOrdinal, hit.ordinal + anchoredViewRadius);
  const bookendStartLast = Math.min(
    anchoredViewBookendCount - 1,
    windowStart - 1,
  );
  const bookendEndFirst = Math.max(
    windowEnd + 1,
    lastOrdinal - anchoredViewBookendCount + 1,
  );
  const rows = database
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.sessionId, hit.sessionId),
        or(
          lte(messagesTable.ordinal, bookendStartLast),
          and(
            gte(messagesTable.ordinal, windowStart),
            lte(messagesTable.ordinal, windowEnd),
          ),
          gte(messagesTable.ordinal, bookendEndFirst),
        ),
      ),
    )
    .orderBy(asc(messagesTable.ordinal))
    .all();
  const matchRow = rows.find(row => row.ordinal === hit.ordinal);

  if (matchRow === undefined) {
    return undefined;
  }

  return Object.freeze({
    sessionId: hit.sessionId,
    bookendStart: Object.freeze(
      rows.filter(row => row.ordinal < windowStart).map(indexedMessage),
    ),
    window: Object.freeze(
      rows
        .filter(row => row.ordinal >= windowStart && row.ordinal <= windowEnd)
        .map(indexedMessage),
    ),
    bookendEnd: Object.freeze(
      rows.filter(row => row.ordinal > windowEnd).map(indexedMessage),
    ),
    matchMessageId: matchRow.messageId,
  });
}

export function indexedMessage(row: {
  readonly sessionId: string;
  readonly messageId: string;
  readonly role: RuntimePluginSessionHistoryMessage['role'];
  readonly speakerName: string;
  readonly text: string;
  readonly committedAt: string;
}): RuntimePluginSessionHistoryMessage {
  return Object.freeze({
    sessionId: row.sessionId,
    messageId: row.messageId,
    role: row.role,
    speakerName: row.speakerName,
    text: row.text,
    committedAt: row.committedAt,
  });
}
