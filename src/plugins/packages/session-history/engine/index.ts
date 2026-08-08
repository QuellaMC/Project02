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
import {ingestSessionSlice, totalIngestedDamage} from './ingest.ts';
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

// Sized so one catch-up slice decodes in well under a second; the loop
// yields to the event loop between slices, so a cold index catches up
// cooperatively instead of freezing the process.
const catchUpSliceMaxBytes = 2 * 1024 * 1024;

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

  const engineClosedError = (): SessionHistoryEngineError =>
    new SessionHistoryEngineError(
      'engine_closed',
      `Session history engine for character "${feed.characterId}" is closed.`,
    );

  const abortedError = (): SessionHistoryEngineError =>
    new SessionHistoryEngineError(
      'aborted',
      'Session history catch-up stopped: the calling hook was aborted.',
    );

  const openedDatabase = (): BetterSQLite3Database => {
    if (closed) {
      throw engineClosedError();
    }

    if (orm === undefined) {
      // The handles are cached only after adoption succeeds; a failed
      // adoption must not leave a foreign character's rows queryable.
      const openedHandle = openDatabase({
        name: sessionIndexDatabaseName,
        schemaVersion: sessionIndexSchemaVersion,
        initializeSchema: database => {
          database.exec(sessionIndexSchemaDdl);
        },
      });

      registerUnicodeFold(openedHandle);

      const openedOrm = drizzle(openedHandle);

      try {
        adoptSessionIndexForCharacter(openedOrm, feed.characterId);
      } catch (error: unknown) {
        closeQuietly(openedHandle);
        throw error;
      }

      handle = openedHandle;
      orm = openedOrm;
    }

    return orm;
  };

  // The one catch-up loop behind every query and warm-up: slice by
  // slice, yielding between slices, stopping when the engine closes or
  // the caller's hook scope is aborted.
  const caughtUpView = async (
    sessionFilter: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{
    readonly database: BetterSQLite3Database;
    readonly catalog: RuntimePluginSessionHistoryListing;
  }> => {
    const database = openedDatabase();
    const catalog = feed.listSessions();

    for (const session of catalog.sessions) {
      if (sessionFilter !== undefined && session.sessionId !== sessionFilter) {
        continue;
      }

      for (;;) {
        if (closed) {
          throw engineClosedError();
        }

        if (signal?.aborted) {
          throw abortedError();
        }

        let advanced = ingestSessionSlice({
          database,
          feed,
          sessionId: session.sessionId,
          maxBytes: catchUpSliceMaxBytes,
        });

        if (!advanced) {
          // One committed record can exceed the slice cap, leaving the
          // capped read without a newline; retry uncapped so it cannot
          // stall the session forever. When the session is simply caught
          // up the retry is a cheap size check.
          advanced = ingestSessionSlice({
            database,
            feed,
            sessionId: session.sessionId,
          });
        }

        if (!advanced) {
          break;
        }

        await yieldToEventLoop();
      }
    }

    return {database, catalog};
  };

  return Object.freeze({
    characterId: feed.characterId,

    async warmUp(warmUpOptions: SessionIndexWarmUpOptions = {}): Promise<void> {
      try {
        await caughtUpView(warmUpOptions.sessionId, warmUpOptions.signal);
      } catch (error: unknown) {
        // Closing or aborting mid-warm-up ends advisory work, not a
        // failure.
        if (
          error instanceof SessionHistoryEngineError &&
          (error.code === 'engine_closed' || error.code === 'aborted')
        ) {
          return;
        }

        throw error;
      }
    },

    async search(
      searchOptions: SessionIndexSearchOptions,
    ): Promise<SessionIndexSearchResult> {
      const {database, catalog} = await caughtUpView(
        searchOptions.sessionId,
        searchOptions.signal,
      );
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
        ...(requestedSessionId !== undefined ||
        searchOptions.excludeSessionId === undefined
          ? {}
          : {excludeSessionId: searchOptions.excludeSessionId}),
      });

      return Object.freeze({
        sessions: hits.views,
        totalSessionsWithHits: hits.totalSessionsWithHits,
        damagedRecordCount:
          catalog.damagedEntryCount + totalIngestedDamage(database),
      });
    },

    async readAround(
      readOptions: SessionIndexReadAroundOptions,
    ): Promise<SessionIndexConversationWindow> {
      const {database, catalog} = await caughtUpView(
        readOptions.sessionId,
        readOptions.signal,
      );
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
      if (handle !== undefined) {
        closeQuietly(handle);
      }
      handle = undefined;
      orm = undefined;
    },
  } satisfies SessionHistoryEngine);
}

/**
 * SQLite's built-in lower() folds ASCII only; short-query LIKE search
 * folds through this function so Cyrillic, Greek, and other cased
 * scripts match case-insensitively too.
 */
function registerUnicodeFold(handle: RuntimePluginDatabase): void {
  handle.function('unicode_fold', {deterministic: true}, (value: unknown) =>
    typeof value === 'string' ? value.toLowerCase() : null,
  );
}

function closeQuietly(handle: RuntimePluginDatabase): void {
  try {
    handle.close();
  } catch {
    // The handle is being abandoned; a failed close changes nothing.
  }
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
