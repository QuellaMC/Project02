import {drizzle, type BetterSQLite3Database} from 'drizzle-orm/better-sqlite3';
import {setImmediate as yieldToEventLoop} from 'node:timers/promises';

import type {
  RuntimePluginDatabase,
  RuntimePluginDatabaseOpener,
  RuntimePluginSessionHistoryFeed,
  RuntimePluginSessionHistoryListing,
} from '../../../api/index.ts';
import {
  SessionHistoryEngineError,
  type SessionHistoryEngine,
  type SessionIndexConversationWindow,
  type SessionIndexReadAroundOptions,
  type SessionIndexSearchOptions,
  type SessionIndexSearchResult,
  type SessionIndexWarmUpOptions,
} from './contract.ts';
import {
  ingestSessionHistory,
  ingestSessionSlice,
  totalIngestedDamage,
} from './ingest.ts';
import {readAroundSessionIndex} from './read.ts';
import {
  indexMetaTable,
  messagesTable,
  projectionStateTable,
  sessionIndexSchemaDdl,
  sessionIndexSchemaVersion,
} from './schema.ts';
import {searchSessionIndex} from './search.ts';

export {
  SessionHistoryEngineError,
  type SessionHistoryEngine,
  type SessionHistoryEngineErrorCode,
  type SessionIndexConversationWindow,
  type SessionIndexReadAroundOptions,
  type SessionIndexSearchOptions,
  type SessionIndexSearchResult,
  type SessionIndexSessionView,
  type SessionIndexWarmUpOptions,
} from './contract.ts';

export const sessionIndexDatabaseName = 'session-index';

// Sized so one warm-up slice decodes in well under a second; anything left
// behind is picked up by the next slice or an uncapped query pass.
const warmUpSliceMaxBytes = 2 * 1024 * 1024;

/**
 * The plugin's search index, built entirely from its two declared
 * capabilities: the session-history feed and the plugin database. The
 * database opens lazily on the first query or warm-up, and every query
 * first catches the index up to the feed.
 */
export function createSessionHistoryEngine(options: {
  readonly feed: RuntimePluginSessionHistoryFeed;
  readonly openDatabase: RuntimePluginDatabaseOpener;
}): SessionHistoryEngine {
  const {feed, openDatabase} = options;
  let orm: BetterSQLite3Database | undefined;
  let handle: RuntimePluginDatabase | undefined;
  let closed = false;

  const openedDatabase = (): BetterSQLite3Database => {
    if (closed) {
      throw new SessionHistoryEngineError(
        'engine_closed',
        `Session history engine for character "${feed.characterId}" is closed.`,
      );
    }

    if (orm === undefined) {
      handle = openDatabase({
        name: sessionIndexDatabaseName,
        schemaVersion: sessionIndexSchemaVersion,
        initializeSchema: database => {
          database.exec(sessionIndexSchemaDdl);
        },
      });
      orm = drizzle(handle);
      adoptSessionIndexForCharacter(orm, feed.characterId);
    }

    return orm;
  };

  const refreshedView = (): {
    readonly database: BetterSQLite3Database;
    readonly catalog: RuntimePluginSessionHistoryListing;
  } => {
    const database = openedDatabase();
    const catalog = feed.listSessions();

    ingestSessionHistory({database, feed, catalog});
    return {database, catalog};
  };

  return Object.freeze({
    characterId: feed.characterId,

    async warmUp(warmUpOptions: SessionIndexWarmUpOptions = {}): Promise<void> {
      const database = openedDatabase();
      const catalog = feed.listSessions();
      const sessionIds = catalog.sessions
        .map(session => session.sessionId)
        .filter(
          sessionId =>
            warmUpOptions.sessionId === undefined ||
            sessionId === warmUpOptions.sessionId,
        );

      for (const sessionId of sessionIds) {
        for (;;) {
          if (closed) {
            return;
          }

          const advanced = ingestSessionSlice({
            database,
            feed,
            sessionId,
            maxBytes: warmUpSliceMaxBytes,
          });

          if (!advanced) {
            break;
          }

          await yieldToEventLoop();
        }
      }
    },

    search(searchOptions: SessionIndexSearchOptions): SessionIndexSearchResult {
      const {database, catalog} = refreshedView();
      const requestedSessionId =
        searchOptions.sessionId === undefined
          ? undefined
          : requiredKnownSessionId(catalog, searchOptions.sessionId);
      const hits = searchSessionIndex({
        database,
        query: searchOptions.query,
        sessionLimit: searchOptions.sessionLimit,
        ...(requestedSessionId === undefined
          ? {}
          : {sessionId: requestedSessionId}),
      });

      return Object.freeze({
        sessions: hits.views,
        totalSessionsWithHits: hits.totalSessionsWithHits,
        damagedRecordCount:
          catalog.damagedEntryCount + totalIngestedDamage(database),
      });
    },

    readAround(
      readOptions: SessionIndexReadAroundOptions,
    ): SessionIndexConversationWindow {
      const {database, catalog} = refreshedView();
      const sessionId = requiredKnownSessionId(catalog, readOptions.sessionId);
      const rows = readAroundSessionIndex({
        database,
        sessionId,
        window: readOptions.window,
        ...(readOptions.anchorMessageId === undefined
          ? {}
          : {anchorMessageId: readOptions.anchorMessageId}),
      });

      return Object.freeze({
        messages: rows.messages,
        hasBefore: rows.hasBefore,
        hasAfter: rows.hasAfter,
        damagedRecordCount:
          catalog.damagedEntryCount + totalIngestedDamage(database),
      });
    },

    close(): void {
      closed = true;
      handle?.close();
      handle = undefined;
      orm = undefined;
    },
  } satisfies SessionHistoryEngine);
}

/**
 * A database copied from another character's store is derived data: wipe
 * the rows and adopt it for this character rather than trusting them.
 * (File deletion belongs to the runtime seam; row-level reset is
 * equivalent for a rebuildable view.)
 */
function adoptSessionIndexForCharacter(
  database: BetterSQLite3Database,
  characterId: string,
): void {
  const meta = database.select().from(indexMetaTable).get();

  if (meta === undefined) {
    database
      .insert(indexMetaTable)
      .values({id: 1, characterId})
      .onConflictDoNothing()
      .run();
    return;
  }

  if (meta.characterId === characterId) {
    return;
  }

  database.transaction(
    transaction => {
      transaction.delete(messagesTable).run();
      transaction.delete(projectionStateTable).run();
      transaction.update(indexMetaTable).set({characterId}).run();
    },
    {behavior: 'immediate'},
  );
}

function requiredKnownSessionId(
  catalog: RuntimePluginSessionHistoryListing,
  sessionId: string,
): string {
  if (!catalog.sessions.some(session => session.sessionId === sessionId)) {
    throw new SessionHistoryEngineError(
      'session_not_found',
      `Session "${sessionId}" is not in this character's history.`,
    );
  }

  return sessionId;
}
