import Database from 'better-sqlite3';
import {existsSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

import {createTestTempRoot} from '../support/temp-root.ts';

import {
  openRuntimeSqliteDatabase,
  type RuntimeSqliteDatabase,
} from '../../src/runtime/storage/sqlite.ts';

describe('runtime sqlite seam', () => {
  it('keeps a locked database intact instead of treating the lock as corruption', () => {
    const filePath = join(
      createTestTempRoot('project02-sqlite-'),
      'view.sqlite',
    );
    // A rollback-journal database whose holder blocks the WAL conversion,
    // the way a second application window would.
    const holder = new Database(filePath);

    holder.exec('CREATE TABLE keepsake (id INTEGER PRIMARY KEY)');
    holder.exec('INSERT INTO keepsake (id) VALUES (7)');
    holder.exec('BEGIN EXCLUSIVE');

    expect(() => openView(filePath)).toThrow(/Could not maintain SQLite view/);
    expect(existsSync(filePath)).toBe(true);

    holder.exec('ROLLBACK');

    const row: unknown = holder
      .prepare('SELECT count(*) AS total FROM keepsake')
      .get();

    expect(row).toMatchObject({total: 1});
    holder.close();
  });

  it('rebuilds a positively corrupt file', () => {
    const filePath = join(
      createTestTempRoot('project02-sqlite-'),
      'view.sqlite',
    );

    writeFileSync(filePath, 'this is not a database', 'utf8');

    const database = openView(filePath);
    const row: unknown = database
      .prepare('SELECT count(*) AS total FROM sample')
      .get();

    expect(row).toMatchObject({total: 0});
    database.close();
  });
});

function openView(filePath: string): RuntimeSqliteDatabase {
  return openRuntimeSqliteDatabase({
    filePath,
    schemaVersion: 1,
    initializeSchema: database => {
      database.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
    },
  });
}
