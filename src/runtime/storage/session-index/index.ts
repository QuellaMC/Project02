import {drizzle, type BetterSQLite3Database} from 'drizzle-orm/better-sqlite3';
import {join} from 'node:path';
import {setImmediate as yieldToEventLoop} from 'node:timers/promises';

import {requireCharacterDataMarker} from '../character-data.ts';
import {
  characterPluginDataDirPath,
  createLocalRuntimeStorageLayout,
  LocalRuntimeStorageContractError,
  normalizeLocalRuntimeCharacterId,
  normalizeLocalRuntimeSessionId,
} from '../layout-contract.ts';
import {
  deleteRuntimeSqliteDatabase,
  openRuntimeSqliteDatabase,
  type RuntimeSqliteDatabase,
} from '../sqlite.ts';
import type {
  LocalRuntimeSessionIndex,
  SessionIndexConversationWindow,
  SessionIndexReadAroundOptions,
  SessionIndexSearchOptions,
  SessionIndexSearchResult,
  SessionIndexWarmUpOptions,
} from './contract.ts';
import {
  catchUpSessionSlice,
  projectSessionIndex,
  readLenientSessionCatalog,
  totalProjectedTranscriptDamage,
  type LenientSessionCatalog,
} from './projector.ts';
import {readAroundSessionIndex} from './read.ts';
import {
  indexMetaTable,
  sessionIndexSchemaDdl,
  sessionIndexSchemaVersion,
} from './schema.ts';
import {searchSessionIndex} from './search.ts';

export type {
  LocalRuntimeSessionIndex,
  SessionIndexConversationWindow,
  SessionIndexMessage,
  SessionIndexReadAroundOptions,
  SessionIndexSearchOptions,
  SessionIndexSearchResult,
  SessionIndexSessionView,
  SessionIndexWarmUpOptions,
} from './contract.ts';

// Sized so one warm-up slice decodes in well under a second; anything left
// behind is picked up by the next slice or an uncapped query pass.
const warmUpSliceMaxBytes = 2 * 1024 * 1024;

export type CreateLocalRuntimeSessionIndexOptions = {
  readonly storeRoot: string;
  readonly characterId: string;
  /** The plugin whose data directory holds (and owns) the view. */
  readonly ownerPluginId: string;
};

/** Where the owning plugin's view lives; exported for tests and tooling. */
export function sessionIndexDatabasePath(options: {
  readonly storeRoot: string;
  readonly ownerPluginId: string;
}): string {
  return join(
    characterPluginDataDirPath({
      storeRoot: options.storeRoot,
      pluginId: options.ownerPluginId,
    }),
    'session-index.sqlite',
  );
}

/**
 * A rebuildable SQLite view over one character's canonical transcripts.
 * Construction validates the store marker and nothing else; the database
 * opens lazily on the first query or warm-up, and every query first
 * catches the view up to the JSONL log it is derived from.
 */
export function createLocalRuntimeSessionIndex(
  options: CreateLocalRuntimeSessionIndexOptions,
): LocalRuntimeSessionIndex {
  const characterId = normalizeLocalRuntimeCharacterId(options.characterId);

  requireCharacterDataMarker({
    storageOptions: {storeRoot: options.storeRoot},
    characterId,
  });

  const layout = createLocalRuntimeStorageLayout({
    storeRoot: options.storeRoot,
  });
  const databasePath = sessionIndexDatabasePath({
    storeRoot: options.storeRoot,
    ownerPluginId: options.ownerPluginId,
  });
  let handle: RuntimeSqliteDatabase | undefined;
  let orm: BetterSQLite3Database | undefined;
  let closed = false;

  const openedDatabase = (): BetterSQLite3Database => {
    if (closed) {
      throw new LocalRuntimeStorageContractError(
        'read_failed',
        `Session index for character "${characterId}" is closed.`,
      );
    }

    if (orm === undefined) {
      const opened = openSessionIndexHandles(databasePath, characterId);

      handle = opened.handle;
      orm = opened.orm;
    }

    return orm;
  };

  const refreshedView = (): {
    readonly database: BetterSQLite3Database;
    readonly catalog: LenientSessionCatalog;
  } => {
    const database = openedDatabase();
    const catalog = readLenientSessionCatalog(layout);

    projectSessionIndex({database, layout, catalog});
    return {database, catalog};
  };

  return Object.freeze({
    characterId,

    async warmUp(warmUpOptions: SessionIndexWarmUpOptions = {}): Promise<void> {
      const database = openedDatabase();
      const catalog = readLenientSessionCatalog(layout);
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

          const consumedBytes = catchUpSessionSlice({
            database,
            layout,
            sessionId,
            maxBytes: warmUpSliceMaxBytes,
          });

          if (consumedBytes === 0) {
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
          catalog.damagedEntryCount + totalProjectedTranscriptDamage(database),
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
          catalog.damagedEntryCount + totalProjectedTranscriptDamage(database),
      });
    },

    close(): void {
      closed = true;
      handle?.close();
      handle = undefined;
      orm = undefined;
    },
  } satisfies LocalRuntimeSessionIndex);
}

function requiredKnownSessionId(
  catalog: LenientSessionCatalog,
  sessionId: string,
): string {
  const normalized = normalizeLocalRuntimeSessionId(sessionId);

  if (!catalog.sessions.some(session => session.sessionId === normalized)) {
    throw new LocalRuntimeStorageContractError(
      'missing_file',
      `Session "${normalized}" is not in this character's history.`,
    );
  }

  return normalized;
}

type SessionIndexHandles = {
  readonly handle: RuntimeSqliteDatabase;
  readonly orm: BetterSQLite3Database;
};

function openSessionIndexHandles(
  databasePath: string,
  characterId: string,
): SessionIndexHandles {
  const opened = openSessionIndexDatabase(databasePath);
  const meta = opened.orm.select().from(indexMetaTable).get();

  if (meta === undefined) {
    opened.orm
      .insert(indexMetaTable)
      .values({id: 1, characterId})
      .onConflictDoNothing()
      .run();
    return opened;
  }

  if (meta.characterId === characterId) {
    return opened;
  }

  // A view copied from another character's store is derived data: rebuild
  // it for this store rather than trusting or repairing it.
  opened.handle.close();
  deleteRuntimeSqliteDatabase(databasePath);

  const rebuilt = openSessionIndexDatabase(databasePath);

  rebuilt.orm.insert(indexMetaTable).values({id: 1, characterId}).run();
  return rebuilt;
}

function openSessionIndexDatabase(databasePath: string): SessionIndexHandles {
  const handle = openRuntimeSqliteDatabase({
    filePath: databasePath,
    schemaVersion: sessionIndexSchemaVersion,
    initializeSchema: database => {
      database.exec(sessionIndexSchemaDdl);
    },
  });

  return {handle, orm: drizzle(handle)};
}
