import type Database from 'better-sqlite3';

/**
 * The driver handle a plugin-database capability serves. Only the
 * runtime's sqlite seam may open one; plugins receive it, never create it.
 */
export type RuntimePluginDatabase = Database.Database;

export type OpenRuntimePluginDatabaseOptions = {
  /** File name stem inside the plugin's data directory; .sqlite is added. */
  readonly name: string;
  /** Compared against PRAGMA user_version; a mismatch rebuilds the file. */
  readonly schemaVersion: number;
  /** Full DDL for a fresh database, run inside one transaction. */
  readonly initializeSchema: (database: RuntimePluginDatabase) => void;
};

/**
 * Opens databases inside one plugin's character-scoped data directory.
 * The composition root scopes it to the owning plugin before injection,
 * so a plugin cannot open another plugin's database. Requires the
 * plugin_database access declaration.
 */
export type RuntimePluginDatabaseOpener = (
  options: OpenRuntimePluginDatabaseOptions,
) => RuntimePluginDatabase;
