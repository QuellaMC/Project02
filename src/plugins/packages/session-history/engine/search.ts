import {and, asc, eq, gte, lte, max, or, sql, type SQL} from 'drizzle-orm';
import type {BetterSQLite3Database} from 'drizzle-orm/better-sqlite3';

import type {RuntimePluginSessionHistoryMessage} from '../../../api/session-history-contract.ts';
import type {SessionIndexSessionView} from './contract.ts';
import {messagesTable} from './schema.ts';

// Retrieval returns one best hit per session, chosen and ranked in SQL
// so a hit-heavy session can never crowd others out of the result, then
// presented as an anchored view so results carry conversation context
// instead of disconnected messages.
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
  readonly excludeSessionId?: string;
  readonly sessionLimit: number;
}): SessionSearchHits {
  const query = options.query.trim();

  if (query.length === 0) {
    return Object.freeze({
      views: Object.freeze([]),
      totalSessionsWithHits: 0,
    });
  }

  const scope: SearchScope = {
    sessionId: options.sessionId,
    excludeSessionId:
      options.sessionId === undefined ? options.excludeSessionId : undefined,
    sessionLimit: Math.max(1, options.sessionLimit),
  };
  const hits = routedSearchHits(options.database, query, scope);
  const views = hits
    .map(hit => anchoredSessionView(options.database, hit))
    .filter(view => view !== undefined);

  return Object.freeze({
    views: Object.freeze(views),
    totalSessionsWithHits: hits[0]?.totalSessionsWithHits ?? 0,
  });
}

type SearchScope = {
  readonly sessionId: string | undefined;
  readonly excludeSessionId: string | undefined;
  readonly sessionLimit: number;
};

type RawSearchHit = {
  readonly sessionId: string;
  readonly ordinal: number;
  readonly committedAt: string;
  readonly rank: number;
  readonly totalSessionsWithHits: number;
};

/**
 * Query routing: substring LIKE for queries too short to form a trigram,
 * the trigram index for CJK text unicode61 cannot segment, and the word
 * index first for everything else with a trigram retry when it finds
 * nothing.
 */
function routedSearchHits(
  database: BetterSQLite3Database,
  query: string,
  scope: SearchScope,
): readonly RawSearchHit[] {
  if (codePointCount(query) < ftsMinimumQueryCodePoints) {
    return substringSearchHits(database, query, scope);
  }

  if (cjkPattern.test(query)) {
    return ftsSearchHits(database, 'messages_fts_trigram', query, scope);
  }

  const wordHits = ftsSearchHits(database, 'messages_fts', query, scope);

  return wordHits.length > 0
    ? wordHits
    : ftsSearchHits(database, 'messages_fts_trigram', query, scope);
}

/**
 * Each session's best hit is its lowest BM25 rank with recency breaking
 * ties (higher rowid = newer); sessions rank against each other the same
 * way. The window count carries the exact number of matching sessions
 * independently of the returned limit.
 */
function ftsSearchHits(
  database: BetterSQLite3Database,
  ftsTable: 'messages_fts' | 'messages_fts_trigram',
  query: string,
  scope: SearchScope,
): readonly RawSearchHit[] {
  // Always a single quoted phrase: the model's query is literal text, not
  // FTS boolean syntax.
  const phrase = `"${query.replaceAll('"', '""')}"`;

  return database.all<RawSearchHit>(sql`
    WITH best_hits AS (
      SELECT m.session_id AS sessionId,
             m.ordinal AS ordinal,
             m.committed_at AS committedAt,
             f.rank AS rank,
             ROW_NUMBER() OVER (
               PARTITION BY m.session_id
               ORDER BY f.rank, m.id DESC
             ) AS hitOrder
      FROM ${sql.raw(ftsTable)}(${phrase}) AS f
      JOIN messages AS m ON m.id = f.rowid
      ${scopeWhereClause(scope)}
    )
    SELECT sessionId, ordinal, committedAt, rank,
           COUNT(*) OVER () AS totalSessionsWithHits
    FROM best_hits
    WHERE hitOrder = 1
    ORDER BY rank, committedAt DESC, sessionId ASC
    LIMIT ${scope.sessionLimit}
  `);
}

/** Substring hits carry no rank; sessions order by their newest hit. */
function substringSearchHits(
  database: BetterSQLite3Database,
  query: string,
  scope: SearchScope,
): readonly RawSearchHit[] {
  const pattern = `%${escapeLikePattern(query.toLowerCase())}%`;

  return database.all<RawSearchHit>(sql`
    WITH best_hits AS (
      SELECT m.session_id AS sessionId,
             m.ordinal AS ordinal,
             m.committed_at AS committedAt,
             0 AS rank,
             ROW_NUMBER() OVER (
               PARTITION BY m.session_id
               ORDER BY m.id DESC
             ) AS hitOrder
      FROM messages AS m
      WHERE unicode_fold(m.text) LIKE ${pattern} ESCAPE '\\'
      ${scopeAndClause(scope)}
    )
    SELECT sessionId, ordinal, committedAt, rank,
           COUNT(*) OVER () AS totalSessionsWithHits
    FROM best_hits
    WHERE hitOrder = 1
    ORDER BY committedAt DESC, sessionId ASC
    LIMIT ${scope.sessionLimit}
  `);
}

function scopeWhereClause(scope: SearchScope): SQL {
  if (scope.sessionId !== undefined) {
    return sql`WHERE m.session_id = ${scope.sessionId}`;
  }

  if (scope.excludeSessionId !== undefined) {
    return sql`WHERE m.session_id <> ${scope.excludeSessionId}`;
  }

  return sql``;
}

function scopeAndClause(scope: SearchScope): SQL {
  if (scope.sessionId !== undefined) {
    return sql`AND m.session_id = ${scope.sessionId}`;
  }

  if (scope.excludeSessionId !== undefined) {
    return sql`AND m.session_id <> ${scope.excludeSessionId}`;
  }

  return sql``;
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
