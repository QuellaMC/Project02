import {integer, sqliteTable, text, uniqueIndex} from 'drizzle-orm/sqlite-core';

import type {RuntimePluginSessionHistoryMessage} from '../../../api/session-history-contract.ts';

// Bumped whenever the view shape changes; a mismatched file is deleted and
// reprojected from the canonical feed, never migrated.
export const sessionIndexSchemaVersion = 2;

export const messagesTable = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    messageId: text('message_id').notNull(),
    role: text('role')
      .$type<RuntimePluginSessionHistoryMessage['role']>()
      .notNull(),
    speakerName: text('speaker_name').notNull(),
    text: text('text').notNull(),
    committedAt: text('committed_at').notNull(),
    ordinal: integer('ordinal').notNull(),
  },
  table => [
    uniqueIndex('messages_session_message').on(
      table.sessionId,
      table.messageId,
    ),
    uniqueIndex('messages_session_ordinal').on(table.sessionId, table.ordinal),
  ],
);

export const projectionStateTable = sqliteTable('projection_state', {
  sessionId: text('session_id').primaryKey(),
  nextCursor: text('next_cursor').notNull(),
  nextOrdinal: integer('next_ordinal').notNull(),
  damagedRecordCount: integer('damaged_record_count').notNull(),
});

export const indexMetaTable = sqliteTable('index_meta', {
  id: integer('id').primaryKey(),
  characterId: text('character_id').notNull(),
});

/**
 * Executed once per fresh file; must stay in step with the table
 * definitions above (Drizzle cannot express FTS5 virtual tables or
 * triggers, so the DDL is authored here beside them). Messages are
 * immutable once committed, so no UPDATE trigger exists.
 */
export const sessionIndexSchemaDdl = `
CREATE TABLE index_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  character_id TEXT NOT NULL
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  role TEXT NOT NULL,
  speaker_name TEXT NOT NULL,
  text TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  ordinal INTEGER NOT NULL
);
CREATE UNIQUE INDEX messages_session_message ON messages (session_id, message_id);
CREATE UNIQUE INDEX messages_session_ordinal ON messages (session_id, ordinal);
CREATE TABLE projection_state (
  session_id TEXT PRIMARY KEY,
  next_cursor TEXT NOT NULL,
  next_ordinal INTEGER NOT NULL,
  damaged_record_count INTEGER NOT NULL
);
CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  content='messages',
  content_rowid='id',
  tokenize='unicode61'
);
CREATE VIRTUAL TABLE messages_fts_trigram USING fts5(
  text,
  content='messages',
  content_rowid='id',
  tokenize='trigram'
);
CREATE TRIGGER messages_fts_after_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
  INSERT INTO messages_fts_trigram (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER messages_fts_after_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text)
    VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts_trigram (messages_fts_trigram, rowid, text)
    VALUES ('delete', old.id, old.text);
END;
`;
