import {drizzle, type BetterSQLite3Database} from 'drizzle-orm/better-sqlite3';

import {requireCharacterDataMarker} from '../character-data.ts';
import {
  createLocalRuntimeStorageLayout,
  LocalRuntimeStorageContractError,
  normalizeLocalRuntimeCharacterId,
  normalizeLocalRuntimeSessionId,
  type LocalRuntimeStorageLayout,
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
} from './contract.ts';
import {
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
} from './contract.ts';

export type CreateLocalRuntimeSessionIndexOptions = {
  readonly storeRoot: string;
  readonly characterId: string;
};

/**
 * A rebuildable SQLite view over one character's canonical transcripts.
 * Construction validates the store marker and nothing else; the database
 * opens lazily on the first query, and every query first catches the view
 * up to the JSONL log it is derived from.
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
  let handle: RuntimeSqliteDatabase | undefined;
  let orm: BetterSQLite3Database | undefined;
  let closed = false;

  const refreshedView = (): {
    readonly database: BetterSQLite3Database;
    readonly catalog: LenientSessionCatalog;
  } => {
    if (closed) {
      throw new LocalRuntimeStorageContractError(
        'read_failed',
        `Session index for character "${characterId}" is closed.`,
      );
    }

    if (orm === undefined) {
      const opened = openSessionIndexHandles(layout, characterId);

      handle = opened.handle;
      orm = opened.orm;
    }

    const catalog = readLenientSessionCatalog(layout);

    projectSessionIndex({database: orm, layout, catalog});
    return {database: orm, catalog};
  };

  return Object.freeze({
    characterId,

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
  layout: LocalRuntimeStorageLayout,
  characterId: string,
): SessionIndexHandles {
  const opened = openSessionIndexDatabase(layout);
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
  deleteRuntimeSqliteDatabase(layout.sessionIndexPath);

  const rebuilt = openSessionIndexDatabase(layout);

  rebuilt.orm.insert(indexMetaTable).values({id: 1, characterId}).run();
  return rebuilt;
}

function openSessionIndexDatabase(
  layout: LocalRuntimeStorageLayout,
): SessionIndexHandles {
  const handle = openRuntimeSqliteDatabase({
    filePath: layout.sessionIndexPath,
    schemaVersion: sessionIndexSchemaVersion,
    initializeSchema: database => {
      database.exec(sessionIndexSchemaDdl);
    },
  });

  return {handle, orm: drizzle(handle)};
}
