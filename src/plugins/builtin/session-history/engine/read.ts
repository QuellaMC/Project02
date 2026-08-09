import {and, asc, eq, gte, lte, max} from 'drizzle-orm';
import type {BetterSQLite3Database} from 'drizzle-orm/better-sqlite3';

import type {RuntimePluginSessionHistoryMessage} from '../../../api/session-history-contract.ts';
import {SessionHistoryEngineError} from './contract.ts';
import {indexedMessage} from './search.ts';
import {messagesTable} from './schema.ts';

export type SessionIndexWindowRows = {
  readonly messages: readonly RuntimePluginSessionHistoryMessage[];
  readonly hasBefore: boolean;
  readonly hasAfter: boolean;
};

const emptyWindow: SessionIndexWindowRows = Object.freeze({
  messages: Object.freeze([]),
  hasBefore: false,
  hasAfter: false,
});

/**
 * Anchored scrolling: ±window around the anchor message, or the last
 * `window` messages when no anchor is given. The caller scrolls by passing
 * the first or last returned message as the next anchor.
 */
export function readAroundSessionIndex(options: {
  readonly database: BetterSQLite3Database;
  readonly sessionId: string;
  readonly anchorMessageId?: string;
  readonly window: number;
}): SessionIndexWindowRows {
  const lastOrdinal = options.database
    .select({value: max(messagesTable.ordinal)})
    .from(messagesTable)
    .where(eq(messagesTable.sessionId, options.sessionId))
    .get()?.value;

  if (lastOrdinal === null || lastOrdinal === undefined) {
    return emptyWindow;
  }

  const window = Math.max(1, options.window);
  let windowStart: number;
  let windowEnd: number;

  if (options.anchorMessageId === undefined) {
    windowEnd = lastOrdinal;
    windowStart = Math.max(0, lastOrdinal - window + 1);
  } else {
    const anchorOrdinal = requiredAnchorOrdinal(
      options.database,
      options.sessionId,
      options.anchorMessageId,
    );

    windowStart = Math.max(0, anchorOrdinal - window);
    windowEnd = Math.min(lastOrdinal, anchorOrdinal + window);
  }

  const rows = options.database
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.sessionId, options.sessionId),
        gte(messagesTable.ordinal, windowStart),
        lte(messagesTable.ordinal, windowEnd),
      ),
    )
    .orderBy(asc(messagesTable.ordinal))
    .all();

  return Object.freeze({
    messages: Object.freeze(rows.map(indexedMessage)),
    hasBefore: windowStart > 0,
    hasAfter: windowEnd < lastOrdinal,
  });
}

function requiredAnchorOrdinal(
  database: BetterSQLite3Database,
  sessionId: string,
  anchorMessageId: string,
): number {
  const anchor = database
    .select({ordinal: messagesTable.ordinal})
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.sessionId, sessionId),
        eq(messagesTable.messageId, anchorMessageId),
      ),
    )
    .get();

  if (anchor === undefined) {
    throw new SessionHistoryEngineError(
      'message_not_found',
      `Message "${anchorMessageId}" is not in session "${sessionId}".`,
    );
  }

  return anchor.ordinal;
}
