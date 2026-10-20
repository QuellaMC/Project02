//! The plugin's index over the character's session history: a view it
//! rebuilds from the history at will, in its own database. Each session is
//! ingested slice by slice, each slice one transaction that reads the feed
//! where the stored cursor left off, so two ingesters never take a message
//! twice and a stopped catch-up continues where it stopped.

use std::num::{NonZeroU32, NonZeroUsize};
use std::sync::LazyLock;

use p02_contracts::{
    DatabaseError, HistoryCursor, HistoryMessage, PluginDatabase, ReadMessages, SessionHistory,
    SessionHistoryError, SessionListing,
};
use p02_core::{SessionId, VisibleMessageRole};
use p02_shared::Identifier;
use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params};
use serde_json::Value;

static NAME: LazyLock<Identifier> =
    LazyLock::new(|| Identifier::new("session-index").expect("the name is an identifier"));

/// A database at another version is rebuilt from the history, never
/// migrated: raise it whenever the schema changes.
const VERSION: NonZeroU32 = NonZeroU32::MIN;

/// What one catch-up slice reads of a session's log, so a long history
/// is ingested a slice per transaction and a stopped hook stops between
/// them.
const SLICE: NonZeroUsize = NonZeroUsize::new(2 * 1024 * 1024).expect("the slice is not empty");

/// Messages on each side of a search hit, and at each end of its session.
const RADIUS: i64 = 3;
const BOOKEND: i64 = 2;

/// The trigram tokenizer cannot match fewer characters than this.
const TRIGRAM_CHARS: usize = 3;

/// Messages are immutable once committed, so the full-text index follows
/// inserts and deletes only, and a session's messages go with it. The index
/// holds each message's folded text with the tokenizer's own folding off,
/// so a phrase and a substring read one folding.
const SCHEMA: &str = "
CREATE TABLE index_owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  character_id TEXT NOT NULL
);
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  cursor TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  damaged_records INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  role TEXT NOT NULL,
  speaker_name TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  text TEXT NOT NULL,
  folded TEXT NOT NULL,
  UNIQUE (session_id, position),
  UNIQUE (session_id, message_id)
);
CREATE VIRTUAL TABLE trigrams USING fts5(
  folded, content = 'messages', content_rowid = 'id',
  tokenize = 'trigram case_sensitive 1'
);
CREATE TRIGGER messages_indexed AFTER INSERT ON messages BEGIN
  INSERT INTO trigrams (rowid, folded) VALUES (new.id, new.folded);
END;
CREATE TRIGGER messages_forgotten AFTER DELETE ON messages BEGIN
  INSERT INTO trigrams (trigrams, rowid, folded) VALUES ('delete', old.id, old.folded);
END;
CREATE TRIGGER sessions_forgotten AFTER DELETE ON sessions BEGIN
  DELETE FROM messages WHERE session_id = old.session_id;
END;
";

const MESSAGE_COLUMNS: &str = "message_id, role, speaker_name, committed_at, text";

/// Why the index answered nothing.
#[derive(Debug, thiserror::Error)]
pub(super) enum IndexError {
    #[error("session \"{0}\" is not in this character's history")]
    SessionNotFound(String),
    #[error("message \"{message}\" is not in session \"{session}\"")]
    MessageNotFound { session: String, message: String },
    #[error("the session index did not open")]
    Open(#[from] DatabaseError),
    #[error("the session index failed")]
    Database(#[from] rusqlite::Error),
    #[error("the session history could not be read")]
    History(#[from] SessionHistoryError),
}

/// A message as the index keeps it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct IndexedMessage {
    pub(super) message_id: String,
    pub(super) role: String,
    pub(super) speaker_name: String,
    pub(super) committed_at: String,
    pub(super) text: String,
}

/// One session with a hit: how it started, the messages around its best
/// hit, and how it ended. A bookend that would overlap the window is part
/// of the window instead.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct SessionView {
    pub(super) session_id: String,
    pub(super) start: Vec<IndexedMessage>,
    pub(super) around: Vec<IndexedMessage>,
    pub(super) end: Vec<IndexedMessage>,
    pub(super) hit: String,
}

/// The sessions with hits, best first, at most as many as asked for, and
/// how many sessions have one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Hits {
    pub(super) views: Vec<SessionView>,
    pub(super) sessions_with_hits: u64,
}

/// Messages of one session, oldest first, and whether it has more on
/// either side.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct Window {
    pub(super) messages: Vec<IndexedMessage>,
    pub(super) has_before: bool,
    pub(super) has_after: bool,
}

/// What a search may match: one session or all, never a message the
/// model already sees, and how many sessions to return.
pub(super) struct Scope<'a> {
    pub(super) session: Option<&'a SessionId>,
    pub(super) unseen: &'a [String],
    pub(super) limit: u32,
}

#[derive(Debug)]
pub(super) struct SessionIndex {
    connection: Connection,
}

struct Hit {
    session_id: String,
    position: i64,
    sessions_with_hits: i64,
}

impl SessionIndex {
    /// Opens the plugin's index and makes it the character's: an index
    /// another character left is emptied before anything is read from it.
    pub(super) fn open(
        databases: &PluginDatabase,
        character_id: &Identifier,
    ) -> Result<Self, IndexError> {
        let mut connection = databases.open(&NAME, VERSION, |connection| {
            connection.execute_batch(SCHEMA)
        })?;
        let owner: Option<String> = connection
            .query_row("SELECT character_id FROM index_owner", [], |row| row.get(0))
            .optional()?;

        match owner {
            Some(owner) if owner == character_id.as_str() => {}
            Some(_) => {
                let transaction =
                    connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

                transaction.execute("DELETE FROM sessions", [])?;
                transaction.execute(
                    "UPDATE index_owner SET character_id = ?1",
                    [character_id.as_str()],
                )?;
                transaction.commit()?;
            }
            None => {
                connection.execute(
                    "INSERT INTO index_owner (id, character_id) VALUES (1, ?1)",
                    [character_id.as_str()],
                )?;
            }
        }

        Ok(Self { connection })
    }

    /// Brings the index to the history, whose listing is the authority: a
    /// session it no longer lists is forgotten, and what it committed since
    /// the last catch-up is ingested, of every session or of `only`.
    /// Returns the listing it read.
    pub(super) fn catch_up(
        &mut self,
        history: &SessionHistory,
        only: Option<&SessionId>,
    ) -> Result<SessionListing, IndexError> {
        let listing = history.list_sessions()?;
        let listed = Value::from(
            listing
                .sessions
                .iter()
                .map(|session| session.session_id.to_string())
                .collect::<Vec<_>>(),
        )
        .to_string();

        self.connection.execute(
            "DELETE FROM sessions WHERE session_id NOT IN (SELECT value FROM json_each(?1))",
            [listed],
        )?;

        for session in &listing.sessions {
            if only.is_none_or(|only| only == &session.session_id) {
                while self.ingest_slice(history, &session.session_id)? {}
            }
        }

        Ok(listing)
    }

    /// Ingests one slice of a session; whether the session moved on.
    fn ingest_slice(
        &mut self,
        history: &SessionHistory,
        session_id: &SessionId,
    ) -> Result<bool, IndexError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let stored: Option<(String, i64, i64)> = transaction
            .query_row(
                "SELECT cursor, message_count, damaged_records FROM sessions WHERE session_id = ?1",
                [session_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let request = ReadMessages::from_start(session_id.clone()).within(SLICE);
        let request = match &stored {
            Some((cursor, ..)) => request.after(HistoryCursor::new(cursor.as_str())),
            None => request,
        };
        let batch = history.read_messages(&request)?;
        let moved = batch.reset
            || stored.as_ref().map(|(cursor, ..)| cursor.as_str())
                != Some(batch.next_cursor.as_str());

        if !moved {
            return Ok(false);
        }

        let (mut count, mut damaged) = match stored {
            Some((_, count, damaged)) if !batch.reset => (count, damaged),
            _ => (0, 0),
        };

        if batch.reset {
            transaction.execute(
                "DELETE FROM messages WHERE session_id = ?1",
                [session_id.as_str()],
            )?;
        }

        {
            let mut insert = transaction.prepare_cached(
                "INSERT INTO messages
                   (session_id, position, message_id, role, speaker_name, committed_at, text, folded)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT (session_id, message_id) DO NOTHING",
            )?;

            for HistoryMessage {
                message,
                committed_at,
            } in &batch.messages
            {
                let role = match message.role {
                    VisibleMessageRole::User => "user",
                    VisibleMessageRole::Character => "character",
                };
                let inserted = insert.execute(params![
                    session_id.as_str(),
                    count,
                    message.id.to_string(),
                    role,
                    message.speaker_name.as_str(),
                    committed_at.as_str(),
                    message.text.as_str(),
                    fold(message.text.as_str()),
                ])?;

                if inserted > 0 {
                    count += 1;
                }
            }
        }

        damaged = damaged.saturating_add_unsigned(batch.damaged_record_count);
        transaction.execute(
            "INSERT INTO sessions (session_id, cursor, message_count, damaged_records)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (session_id) DO UPDATE SET
               cursor = excluded.cursor,
               message_count = excluded.message_count,
               damaged_records = excluded.damaged_records",
            params![
                session_id.as_str(),
                batch.next_cursor.as_str(),
                count,
                damaged
            ],
        )?;
        transaction.commit()?;
        Ok(true)
    }

    /// The damaged records the history skipped, every session's together.
    pub(super) fn damaged_records(&self) -> Result<u64, IndexError> {
        let damaged: i64 = self.connection.query_row(
            "SELECT COALESCE(SUM(damaged_records), 0) FROM sessions",
            [],
            |row| row.get(0),
        )?;

        Ok(damaged.try_into().unwrap_or_default())
    }

    /// The sessions whose messages hold `query` as written, case aside, the
    /// literal text the tool promises: a space at either end counts like
    /// any other character, and a query of spaces is literal too. The query
    /// folds as the indexed text did, and is a trigram phrase, or a
    /// substring when it is too short for a trigram. Each session's best
    /// hit is its best rank, the newest of equals, and sessions rank the
    /// same way.
    pub(super) fn search(&self, query: &str, scope: &Scope<'_>) -> Result<Hits, IndexError> {
        let folded = fold(query);
        let hits = if folded.chars().count() < TRIGRAM_CHARS {
            self.substring_hits(&folded, scope)?
        } else {
            self.ranked_hits(&folded, scope)?
        };
        let sessions_with_hits = hits.first().map_or(0, |hit| {
            hit.sessions_with_hits.try_into().unwrap_or_default()
        });
        let mut views = Vec::with_capacity(hits.len());

        for hit in hits {
            views.extend(self.view(&hit)?);
        }

        Ok(Hits {
            views,
            sessions_with_hits,
        })
    }

    /// Up to `window` messages on each side of `anchor`, or the last
    /// `window` messages without one.
    pub(super) fn read(
        &self,
        session_id: &SessionId,
        anchor: Option<&str>,
        window: i64,
    ) -> Result<Window, IndexError> {
        let session = session_id.as_str();
        let last = self.message_count(session)? - 1;
        let (start, end) = match anchor {
            None => ((last - window + 1).max(0), last),
            Some(anchor) => {
                let at = self
                    .connection
                    .query_row(
                        "SELECT position FROM messages WHERE session_id = ?1 AND message_id = ?2",
                        [session, anchor],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?
                    .ok_or_else(|| IndexError::MessageNotFound {
                        session: session.to_owned(),
                        message: anchor.to_owned(),
                    })?;

                ((at - window).max(0), (at + window).min(last))
            }
        };

        Ok(Window {
            messages: self.messages(
                &format!(
                    "SELECT {MESSAGE_COLUMNS}, position FROM messages
                     WHERE session_id = ?1 AND position BETWEEN ?2 AND ?3 ORDER BY position"
                ),
                params![session, start, end],
            )?,
            has_before: start > 0,
            has_after: end < last,
        })
    }

    fn message_count(&self, session_id: &str) -> Result<i64, IndexError> {
        Ok(self
            .connection
            .query_row(
                "SELECT message_count FROM sessions WHERE session_id = ?1",
                [session_id],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0))
    }

    /// A phrase on the trigram index holds the folded query as written: no
    /// operator of the query language is read.
    fn ranked_hits(&self, folded: &str, scope: &Scope<'_>) -> Result<Vec<Hit>, IndexError> {
        let phrase = format!("\"{}\"", folded.replace('"', "\"\""));

        self.hits(
            "WITH best AS (
               SELECT m.session_id, m.position, m.committed_at, f.rank AS rank,
                      ROW_NUMBER() OVER (
                        PARTITION BY m.session_id ORDER BY f.rank, m.id DESC
                      ) AS place
               FROM trigrams(?1) AS f JOIN messages AS m ON m.id = f.rowid
               WHERE (?2 IS NULL OR m.session_id = ?2)
                 AND m.message_id NOT IN (SELECT value FROM json_each(?3))
             )
             SELECT session_id, position, COUNT(*) OVER () FROM best WHERE place = 1
             ORDER BY rank, committed_at DESC, session_id LIMIT ?4",
            &phrase,
            scope,
        )
    }

    /// Substring hits carry no rank, so sessions order by their newest.
    fn substring_hits(&self, folded: &str, scope: &Scope<'_>) -> Result<Vec<Hit>, IndexError> {
        self.hits(
            "WITH best AS (
               SELECT session_id, position, committed_at,
                      ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY id DESC) AS place
               FROM messages
               WHERE instr(folded, ?1) > 0
                 AND (?2 IS NULL OR session_id = ?2)
                 AND message_id NOT IN (SELECT value FROM json_each(?3))
             )
             SELECT session_id, position, COUNT(*) OVER () FROM best WHERE place = 1
             ORDER BY committed_at DESC, session_id LIMIT ?4",
            folded,
            scope,
        )
    }

    fn hits(&self, sql: &str, matching: &str, scope: &Scope<'_>) -> Result<Vec<Hit>, IndexError> {
        let unseen = Value::from(scope.unseen.to_vec()).to_string();

        self.connection
            .prepare_cached(sql)?
            .query_map(
                params![
                    matching,
                    scope.session.map(SessionId::as_str),
                    unseen,
                    scope.limit
                ],
                |row| {
                    Ok(Hit {
                        session_id: row.get(0)?,
                        position: row.get(1)?,
                        sessions_with_hits: row.get(2)?,
                    })
                },
            )?
            .collect::<Result<_, _>>()
            .map_err(IndexError::from)
    }

    /// The anchored view of a hit's session; its positions are dense, so
    /// the view's bounds are arithmetic.
    fn view(&self, hit: &Hit) -> Result<Option<SessionView>, IndexError> {
        let last = self.message_count(&hit.session_id)? - 1;
        let start = (hit.position - RADIUS).max(0);
        let end = (hit.position + RADIUS).min(last);
        let rows = self.positioned_messages(
            &format!(
                "SELECT {MESSAGE_COLUMNS}, position FROM messages
                 WHERE session_id = ?1
                   AND (position <= ?2 OR position BETWEEN ?3 AND ?4 OR position >= ?5)
                 ORDER BY position"
            ),
            params![
                hit.session_id,
                (BOOKEND - 1).min(start - 1),
                start,
                end,
                (end + 1).max(last - BOOKEND + 1)
            ],
        )?;
        let Some(hit_message) = rows
            .iter()
            .find(|(position, _)| *position == hit.position)
            .map(|(_, message)| message.message_id.clone())
        else {
            return Ok(None);
        };
        let mut view = SessionView {
            session_id: hit.session_id.clone(),
            start: Vec::new(),
            around: Vec::new(),
            end: Vec::new(),
            hit: hit_message,
        };

        for (position, message) in rows {
            if position < start {
                view.start.push(message);
            } else if position > end {
                view.end.push(message);
            } else {
                view.around.push(message);
            }
        }

        Ok(Some(view))
    }

    fn messages(
        &self,
        sql: &str,
        params: impl rusqlite::Params,
    ) -> Result<Vec<IndexedMessage>, IndexError> {
        Ok(self
            .positioned_messages(sql, params)?
            .into_iter()
            .map(|(_, message)| message)
            .collect())
    }

    fn positioned_messages(
        &self,
        sql: &str,
        params: impl rusqlite::Params,
    ) -> Result<Vec<(i64, IndexedMessage)>, IndexError> {
        self.connection
            .prepare_cached(sql)?
            .query_map(params, positioned_message)?
            .collect::<Result<_, _>>()
            .map_err(IndexError::from)
    }
}

fn positioned_message(row: &Row<'_>) -> rusqlite::Result<(i64, IndexedMessage)> {
    Ok((
        row.get(5)?,
        IndexedMessage {
            message_id: row.get(0)?,
            role: row.get(1)?,
            speaker_name: row.get(2)?,
            committed_at: row.get(3)?,
            text: row.get(4)?,
        },
    ))
}

/// Text as a case-insensitive match reads it: every character lowercased
/// by itself, so a query and the text it is found in fold alike.
pub(super) fn fold(text: &str) -> String {
    text.chars().flat_map(char::to_lowercase).collect()
}
