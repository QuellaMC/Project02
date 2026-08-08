/**
 * The only module that may import the SQLite driver; `pnpm arch:check`
 * enforces that with zero exemptions. Databases opened here are rebuildable
 * views over canonical JSONL: on corruption or a schema-version mismatch
 * the file is deleted and recreated, never migrated.
 */
import Database from 'better-sqlite3';
import {dirname} from 'node:path';

import {
  chmodPathSync,
  makeDirectorySync,
  removePathSync,
} from '../../shared/file-system.ts';
import {isRecord, LocalRuntimeStorageContractError} from './layout-contract.ts';

export type RuntimeSqliteDatabase = Database.Database;

export type OpenRuntimeSqliteDatabaseOptions = {
  readonly filePath: string;
  /** Compared against `PRAGMA user_version`; a mismatch rebuilds the file. */
  readonly schemaVersion: number;
  /** Full DDL for a fresh database, run inside one transaction. */
  readonly initializeSchema: (database: RuntimeSqliteDatabase) => void;
};

export function openRuntimeSqliteDatabase(
  options: OpenRuntimeSqliteDatabaseOptions,
): RuntimeSqliteDatabase {
  try {
    makeDirectorySync(dirname(options.filePath), {recursive: true});
  } catch (error: unknown) {
    throw sqliteViewFailure('write_failed', options.filePath, error);
  }

  try {
    return openAtExpectedVersion(options);
  } catch (error: unknown) {
    // Delete only a positively unusable view: corruption or a schema
    // version this build does not serve. A transient failure (another
    // window's lock, a full disk) propagates and leaves the database to
    // its current owner; the JSONL log stays canonical either way.
    if (!isRebuildableSqliteViewFailure(error)) {
      throw sqliteViewFailure('write_failed', options.filePath, error);
    }

    deleteRuntimeSqliteDatabase(options.filePath);
  }

  try {
    return openAtExpectedVersion(options);
  } catch (error: unknown) {
    throw sqliteViewFailure('write_failed', options.filePath, error);
  }
}

export function deleteRuntimeSqliteDatabase(filePath: string): void {
  for (const path of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
    try {
      removePathSync(path, {force: true});
    } catch (error: unknown) {
      throw sqliteViewFailure('write_failed', path, error);
    }
  }
}

function openAtExpectedVersion(
  options: OpenRuntimeSqliteDatabaseOptions,
): RuntimeSqliteDatabase {
  const database = new Database(options.filePath);

  try {
    // The view carries the same conversation text as the 0o600 transcripts.
    chmodPathSync(options.filePath, 0o600);
    // The busy timeout comes first: journal-mode conversion takes a lock,
    // and a second window must wait on it rather than fail.
    database.pragma('busy_timeout = 2000');
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = NORMAL');
    database.pragma('foreign_keys = ON');

    const version = readUserVersion(database);

    if (version === options.schemaVersion) {
      return database;
    }

    if (version !== 0 || !isEmptyDatabase(database)) {
      throw new LocalRuntimeStorageContractError(
        'unsupported_schema_version',
        `SQLite view "${options.filePath}" has schema version ` +
          `${String(version)}, expected ${String(options.schemaVersion)}.`,
      );
    }

    const initialize = database.transaction(() => {
      options.initializeSchema(database);
      database.pragma(`user_version = ${String(options.schemaVersion)}`);
    });

    initialize.immediate();
    return database;
  } catch (error: unknown) {
    closeQuietly(database);
    throw error;
  }
}

function readUserVersion(database: RuntimeSqliteDatabase): number {
  const version: unknown = database.pragma('user_version', {simple: true});

  if (typeof version !== 'number') {
    throw new LocalRuntimeStorageContractError(
      'read_failed',
      'SQLite view did not report a numeric user_version.',
    );
  }

  return version;
}

function isEmptyDatabase(database: RuntimeSqliteDatabase): boolean {
  const row: unknown = database
    .prepare('SELECT count(*) AS objectCount FROM sqlite_master')
    .get();

  return isRecord(row) && row['objectCount'] === 0;
}

function isRebuildableSqliteViewFailure(error: unknown): boolean {
  if (error instanceof LocalRuntimeStorageContractError) {
    return error.code === 'unsupported_schema_version';
  }

  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const code = (error as {readonly code?: unknown}).code;

  return (
    typeof code === 'string' &&
    (code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB')
  );
}

function closeQuietly(database: RuntimeSqliteDatabase): void {
  try {
    database.close();
  } catch {
    // The database is being abandoned; a failed close changes nothing.
  }
}

function sqliteViewFailure(
  code: 'read_failed' | 'write_failed',
  filePath: string,
  cause: unknown,
): LocalRuntimeStorageContractError {
  return new LocalRuntimeStorageContractError(
    code,
    `Could not maintain SQLite view: ${filePath}.`,
    {cause},
  );
}
