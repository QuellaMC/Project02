//! The engine's database, on the connection its caller opened. Memories
//! belong to a person and a character, each text once between them. The
//! store holds one embedder, its generation, and the vectors it made, each
//! stamped with it: a newer embedder replaces the generation and drops its
//! vectors in one transaction, a memory without a vector is what
//! re-embedding does next, and an engine whose generation was replaced
//! writes no vector. A write commits whole or not at all.

use std::num::NonZeroU32;

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use uuid::Uuid;

use crate::record::{Hit, Memory, MemoryId, Message, Role, Scope};

/// The version the opener holds the database to. Raising it empties the
/// store, the person's memories with it: the opener rebuilds a database at
/// another version, and nothing rebuilds a memory.
pub const SCHEMA_VERSION: NonZeroU32 = NonZeroU32::MIN;

/// How many messages of each session the extraction model is shown again.
const KEPT_MESSAGES: i64 = 10;

/// The width of the embedder's vectors is learned from the first one.
const SCHEMA: &str = "
CREATE TABLE embedders (
  generation INTEGER PRIMARY KEY,
  model TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  width INTEGER CHECK (width > 0)
);
CREATE TABLE memories (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  text TEXT NOT NULL,
  sources TEXT NOT NULL,
  UNIQUE (user_id, agent_id, text)
);
CREATE TABLE vectors (
  memory INTEGER PRIMARY KEY,
  generation INTEGER NOT NULL,
  vector BLOB NOT NULL
);
CREATE TABLE messages (
  seq INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL
);
CREATE INDEX messages_by_session ON messages (user_id, agent_id, session_id, seq);
";

/// Creates the engine's tables on a new database; its opener runs it in
/// the transaction that creates the file.
///
/// # Errors
///
/// The `rusqlite::Error` a statement of the schema met.
pub fn initialize(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(SCHEMA)
}

/// The embedder generation a vector belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Generation(i64);

/// Why the store did not do what it was asked.
#[derive(Debug, thiserror::Error)]
pub(crate) enum StoreError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(
        "the embedder answered vectors of {found} dimensions where this store's have {expected}"
    )]
    WidthChanged { expected: usize, found: usize },
    #[error("a stored vector does not have its generation's width")]
    Damaged,
    #[error("a newer embedder took over the memory store")]
    Superseded,
}

/// What one write produced, committed together: the memories with their
/// vectors, the events they came from, and the turn's messages.
pub(crate) struct Commit<'a> {
    pub(crate) generation: Generation,
    pub(crate) scope: &'a Scope,
    pub(crate) memories: &'a [(String, Vec<f32>)],
    pub(crate) sources: &'a [String],
    /// The session and the messages of a captured turn.
    pub(crate) turn: Option<(&'a str, &'a [Message])>,
}

/// The generation of the embedder `model` at `endpoint`: the store's own
/// when it is theirs, otherwise a new one that takes the old one's place
/// and drops its vectors, after which every memory waits for a vector.
pub(crate) fn adopt_generation(
    connection: &mut Connection,
    model: &str,
    endpoint: &str,
) -> rusqlite::Result<Generation> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current: Option<(i64, String, String)> = transaction
        .query_row(
            "SELECT generation, model, endpoint FROM embedders",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let generation = match current {
        Some((generation, known_model, known_endpoint))
            if known_model == model && known_endpoint == endpoint =>
        {
            generation
        }
        _ => {
            transaction.execute(
                "INSERT INTO embedders (model, endpoint) VALUES (?1, ?2)",
                params![model, endpoint],
            )?;

            let generation = transaction.last_insert_rowid();

            transaction.execute("DELETE FROM embedders WHERE generation <> ?1", [generation])?;
            transaction.execute("DELETE FROM vectors", [])?;
            generation
        }
    };

    transaction.commit()?;
    Ok(Generation(generation))
}

/// How many memories have no vector of `generation` yet.
pub(crate) fn unembedded(connection: &Connection, generation: Generation) -> rusqlite::Result<u64> {
    let count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM memories AS m
         LEFT JOIN vectors AS v ON v.memory = m.seq AND v.generation = ?1
         WHERE v.memory IS NULL",
        [generation.0],
        |row| row.get(0),
    )?;

    Ok(count.unsigned_abs())
}

/// The oldest memory with no vector of `generation`, and its text.
pub(crate) fn next_unembedded(
    connection: &Connection,
    generation: Generation,
) -> rusqlite::Result<Option<(i64, String)>> {
    connection
        .query_row(
            "SELECT m.seq, m.text FROM memories AS m
             LEFT JOIN vectors AS v ON v.memory = m.seq AND v.generation = ?1
             WHERE v.memory IS NULL ORDER BY m.seq LIMIT 1",
            [generation.0],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
}

/// Gives the memory `vector` as its vector of `generation`.
pub(crate) fn store_vector(
    connection: &mut Connection,
    generation: Generation,
    memory: i64,
    vector: &[f32],
) -> Result<(), StoreError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

    if !is_current(&transaction, generation)? {
        return Err(StoreError::Superseded);
    }

    hold_width(&transaction, generation, vector.len())?;
    transaction.execute(
        "INSERT INTO vectors (memory, generation, vector) VALUES (?1, ?2, ?3)
         ON CONFLICT (memory) DO NOTHING",
        params![memory, generation.0, encode(vector)],
    )?;
    transaction.commit()?;
    Ok(())
}

/// The memories of `scope` nearest to `query` among the vectors of
/// `generation`, best first and the newest of equals first: at most
/// `limit`, and with a `threshold` only those at least that similar.
pub(crate) fn nearest(
    connection: &Connection,
    generation: Generation,
    scope: &Scope,
    query: &[f32],
    limit: usize,
    threshold: Option<f64>,
) -> Result<Vec<Hit>, StoreError> {
    let Some(width) = width(connection, generation)? else {
        return Ok(Vec::new());
    };

    if width != query.len() {
        return Err(StoreError::WidthChanged {
            expected: width,
            found: query.len(),
        });
    }

    let mut statement = connection.prepare_cached(
        "SELECT m.seq, m.id, m.text, v.vector FROM memories AS m
         JOIN vectors AS v ON v.memory = m.seq
         WHERE v.generation = ?1 AND m.user_id = ?2 AND m.agent_id = ?3",
    )?;
    let rows = statement.query_map(params![generation.0, scope.user(), scope.agent()], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Vec<u8>>(3)?,
        ))
    })?;
    let mut scored = Vec::new();

    for row in rows {
        let (seq, id, text, blob) = row?;
        let similarity = cosine(query, &decode(&blob, width)?);

        if threshold.is_none_or(|threshold| similarity >= threshold) {
            scored.push((
                seq,
                Hit {
                    memory: Memory {
                        id: MemoryId(id),
                        text,
                    },
                    score: similarity,
                },
            ));
        }
    }

    scored.sort_by(|(seq, hit), (other_seq, other)| {
        other.score.total_cmp(&hit.score).then(other_seq.cmp(seq))
    });
    Ok(scored.into_iter().take(limit).map(|(_, hit)| hit).collect())
}

/// The session's last messages, oldest first.
pub(crate) fn last_messages(
    connection: &Connection,
    scope: &Scope,
    session: &str,
) -> rusqlite::Result<Vec<Message>> {
    let mut statement = connection.prepare_cached(
        "SELECT role, content FROM (
           SELECT seq, role, content FROM messages
           WHERE user_id = ?1 AND agent_id = ?2 AND session_id = ?3
           ORDER BY seq DESC LIMIT ?4
         ) ORDER BY seq",
    )?;
    let rows = statement.query_map(
        params![scope.user(), scope.agent(), session, KEPT_MESSAGES],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )?;

    rows.map(|row| {
        let (role, content) = row?;
        let role = Role::parse(&role).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                "a message role is user or assistant".into(),
            )
        })?;

        Ok(Message { role, content })
    })
    .collect()
}

/// Commits `write` in one transaction, so a failure leaves nothing of it
/// behind. A memory whose text the person and character already keep is
/// not stored again; one that an engine whose generation was replaced
/// writes is stored without a vector, for the new embedder to make.
/// Returns the memories stored.
pub(crate) fn commit(
    connection: &mut Connection,
    write: &Commit<'_>,
) -> Result<Vec<Memory>, StoreError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let sources =
        serde_json::to_string(write.sources).expect("a list of strings always serializes");
    let current = is_current(&transaction, write.generation)?;
    let mut stored = Vec::new();

    for (text, vector) in write.memories {
        if current {
            hold_width(&transaction, write.generation, vector.len())?;
        }

        let id = Uuid::new_v4().to_string();
        let inserted = transaction.execute(
            "INSERT INTO memories (id, user_id, agent_id, text, sources)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (user_id, agent_id, text) DO NOTHING",
            params![id, write.scope.user(), write.scope.agent(), text, sources],
        )?;

        if inserted == 0 {
            continue;
        }

        if current {
            transaction.execute(
                "INSERT INTO vectors (memory, generation, vector) VALUES (?1, ?2, ?3)",
                params![
                    transaction.last_insert_rowid(),
                    write.generation.0,
                    encode(vector)
                ],
            )?;
        }

        stored.push(Memory {
            id: MemoryId(id),
            text: text.clone(),
        });
    }

    if let Some((session, messages)) = write.turn {
        keep_messages(&transaction, write.scope, session, messages)?;
    }

    transaction.commit()?;
    Ok(stored)
}

fn keep_messages(
    transaction: &Transaction<'_>,
    scope: &Scope,
    session: &str,
    messages: &[Message],
) -> rusqlite::Result<()> {
    for message in messages {
        transaction.execute(
            "INSERT INTO messages (user_id, agent_id, session_id, role, content)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                scope.user(),
                scope.agent(),
                session,
                message.role.as_str(),
                message.content
            ],
        )?;
    }

    transaction.execute(
        "DELETE FROM messages
         WHERE user_id = ?1 AND agent_id = ?2 AND session_id = ?3 AND seq NOT IN (
           SELECT seq FROM messages
           WHERE user_id = ?1 AND agent_id = ?2 AND session_id = ?3
           ORDER BY seq DESC LIMIT ?4
         )",
        params![scope.user(), scope.agent(), session, KEPT_MESSAGES],
    )?;
    Ok(())
}

/// Whether `generation` is still the store's.
fn is_current(transaction: &Transaction<'_>, generation: Generation) -> rusqlite::Result<bool> {
    transaction.query_row(
        "SELECT EXISTS (SELECT 1 FROM embedders WHERE generation = ?1)",
        [generation.0],
        |row| row.get(0),
    )
}

/// The width of `generation`'s vectors, once its first one was stored.
fn width(connection: &Connection, generation: Generation) -> rusqlite::Result<Option<usize>> {
    let width: Option<i64> = connection
        .query_row(
            "SELECT width FROM embedders WHERE generation = ?1",
            [generation.0],
            |row| row.get(0),
        )
        .optional()?
        .flatten();

    Ok(width.and_then(|width| usize::try_from(width).ok()))
}

/// Holds a vector of `found` dimensions to its generation's width,
/// learning the width from the first vector stored.
fn hold_width(
    transaction: &Transaction<'_>,
    generation: Generation,
    found: usize,
) -> Result<(), StoreError> {
    match width(transaction, generation)? {
        Some(expected) if expected != found => Err(StoreError::WidthChanged { expected, found }),
        Some(_) => Ok(()),
        None => {
            let found = i64::try_from(found)
                .expect("a vector's length fits an i64: no allocation holds 2^63 values");

            transaction.execute(
                "UPDATE embedders SET width = ?2 WHERE generation = ?1",
                params![generation.0, found],
            )?;
            Ok(())
        }
    }
}

/// Cosine similarity, accumulated in double precision; zero for a vector
/// with no direction.
fn cosine(left: &[f32], right: &[f32]) -> f64 {
    let (mut dot, mut left_norm, mut right_norm) = (0.0_f64, 0.0_f64, 0.0_f64);

    for (&left, &right) in left.iter().zip(right) {
        let (left, right) = (f64::from(left), f64::from(right));

        dot += left * right;
        left_norm += left * left;
        right_norm += right * right;
    }

    if left_norm == 0.0 || right_norm == 0.0 {
        0.0
    } else {
        dot / (left_norm.sqrt() * right_norm.sqrt())
    }
}

/// Little-endian `f32`s, four bytes each.
fn encode(vector: &[f32]) -> Vec<u8> {
    vector
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

fn decode(blob: &[u8], width: usize) -> Result<Vec<f32>, StoreError> {
    let (values, rest) = blob.as_chunks::<4>();

    if values.len() != width || !rest.is_empty() {
        return Err(StoreError::Damaged);
    }

    Ok(values
        .iter()
        .map(|bytes| f32::from_le_bytes(*bytes))
        .collect())
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::time::Duration;

    use tempfile::TempDir;

    use super::*;

    #[expect(
        clippy::disallowed_methods,
        reason = "the store crate opens every database of the daemon; until it exists, a test \
                  opens the file as it will"
    )]
    fn connect(path: &Path) -> Connection {
        let connection = Connection::open(path).unwrap();

        connection
            .pragma_update(None, "journal_mode", "WAL")
            .unwrap();
        connection.busy_timeout(Duration::from_millis(50)).unwrap();
        connection
    }

    /// A new store in a directory of its own, and its embedder's generation.
    fn store() -> (TempDir, Connection, Generation) {
        let directory = TempDir::new().unwrap();
        let mut connection = connect(&directory.path().join("memory.sqlite"));

        initialize(&connection).unwrap();

        let generation =
            adopt_generation(&mut connection, "embed-a", "http://127.0.0.1:9/v1").unwrap();

        (directory, connection, generation)
    }

    fn sam() -> Scope {
        Scope::new("project02-user", "mira")
    }

    fn keep(
        connection: &mut Connection,
        generation: Generation,
        scope: &Scope,
        memories: &[(&str, &[f32])],
        turn: Option<(&str, &[Message])>,
    ) -> Result<Vec<String>, StoreError> {
        let memories: Vec<(String, Vec<f32>)> = memories
            .iter()
            .map(|(text, vector)| ((*text).to_owned(), vector.to_vec()))
            .collect();

        commit(
            connection,
            &Commit {
                generation,
                scope,
                memories: &memories,
                sources: &["evt_1".to_owned()],
                turn,
            },
        )
        .map(|stored| stored.into_iter().map(|memory| memory.text).collect())
    }

    fn found(hits: &[Hit]) -> Vec<(&str, f64)> {
        hits.iter()
            .map(|hit| (hit.memory.text.as_str(), hit.score))
            .collect()
    }

    fn count(connection: &Connection, table: &str) -> i64 {
        connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    #[test]
    fn recall_ranks_by_cosine_and_leaves_out_the_less_alike_than_its_threshold() {
        let (_directory, mut connection, generation) = store();

        keep(
            &mut connection,
            generation,
            &sam(),
            &[
                ("Sam likes tea.", &[1.0, 0.0, 0.0]),
                ("Sam likes coffee.", &[3.0, 4.0, 0.0]),
                ("Sam has a cat.", &[0.0, 1.0, 0.0]),
                ("Sam drinks tea daily.", &[2.0, 0.0, 0.0]),
                ("Sam once saw a teapot.", &[0.05, 1.0, 0.0]),
            ],
            None,
        )
        .unwrap();
        keep(
            &mut connection,
            generation,
            &Scope::new("project02-user", "nova"),
            &[("Nova's own memory.", &[1.0, 0.0, 0.0])],
            None,
        )
        .unwrap();

        let query = [3.0, 0.0, 0.0];
        let recalled = nearest(&connection, generation, &sam(), &query, 5, Some(0.1)).unwrap();

        assert_eq!(
            found(&recalled),
            [
                ("Sam drinks tea daily.", 1.0),
                ("Sam likes tea.", 1.0),
                ("Sam likes coffee.", 0.6),
            ]
        );
        assert_eq!(
            nearest(&connection, generation, &sam(), &query, 2, Some(0.1))
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            nearest(&connection, generation, &sam(), &query, 10, None)
                .unwrap()
                .len(),
            5
        );
    }

    #[test]
    fn a_text_is_kept_once_for_a_person_and_character_whatever_the_session() {
        let (_directory, mut connection, generation) = store();
        let tea: &[(&str, &[f32])] = &[("Sam likes tea.", &[1.0, 0.0])];
        let said = [Message {
            role: Role::User,
            content: "Sam: I like tea.".to_owned(),
        }];

        assert_eq!(
            keep(
                &mut connection,
                generation,
                &sam(),
                tea,
                Some(("chat.1", &said))
            )
            .unwrap(),
            ["Sam likes tea."]
        );
        assert_eq!(
            keep(
                &mut connection,
                generation,
                &sam(),
                tea,
                Some(("chat.2", &said))
            )
            .unwrap(),
            Vec::<String>::new()
        );
        assert_eq!(
            keep(
                &mut connection,
                generation,
                &Scope::new("project02-user", "nova"),
                tea,
                None
            )
            .unwrap(),
            ["Sam likes tea."]
        );
        assert_eq!(count(&connection, "memories"), 2);
        assert_eq!(count(&connection, "messages"), 2);
    }

    #[test]
    fn a_session_keeps_its_last_ten_messages() {
        let (_directory, mut connection, generation) = store();
        let line = |number: usize| Message {
            role: if number.is_multiple_of(2) {
                Role::User
            } else {
                Role::Assistant
            },
            content: format!("Line {number}."),
        };

        for turn in 0..6 {
            let messages = [line(2 * turn), line(2 * turn + 1)];

            keep(
                &mut connection,
                generation,
                &sam(),
                &[],
                Some(("chat.1", &messages)),
            )
            .unwrap();
        }

        keep(
            &mut connection,
            generation,
            &sam(),
            &[],
            Some(("chat.2", &[line(0)])),
        )
        .unwrap();

        assert_eq!(
            last_messages(&connection, &sam(), "chat.1").unwrap(),
            (2..12).map(line).collect::<Vec<_>>()
        );
        assert_eq!(
            last_messages(&connection, &sam(), "chat.2").unwrap(),
            [line(0)]
        );
    }

    #[test]
    fn a_new_embedder_takes_over_and_every_memory_waits_to_be_re_embedded_for_it() {
        let (_directory, mut connection, first) = store();

        keep(
            &mut connection,
            first,
            &sam(),
            &[
                ("Sam likes tea.", &[1.0, 0.0]),
                ("Sam likes coffee.", &[0.0, 1.0]),
            ],
            None,
        )
        .unwrap();

        assert_eq!(
            adopt_generation(&mut connection, "embed-a", "http://127.0.0.1:9/v1").unwrap(),
            first
        );

        let second = adopt_generation(&mut connection, "embed-b", "http://127.0.0.1:9/v1").unwrap();

        assert_ne!(second, first);
        assert_eq!(unembedded(&connection, second).unwrap(), 2);
        assert_eq!(
            nearest(&connection, second, &sam(), &[1.0, 0.0, 0.0], 5, None).unwrap(),
            []
        );

        let (memory, text) = next_unembedded(&connection, second).unwrap().unwrap();

        assert_eq!(text, "Sam likes tea.");
        store_vector(&mut connection, second, memory, &[1.0, 0.0, 0.0]).unwrap();

        assert_eq!(unembedded(&connection, second).unwrap(), 1);
        assert_eq!(
            next_unembedded(&connection, second)
                .unwrap()
                .map(|(_, text)| text),
            Some("Sam likes coffee.".to_owned())
        );
        assert_eq!(
            found(&nearest(&connection, second, &sam(), &[1.0, 0.0, 0.0], 5, None).unwrap()),
            [("Sam likes tea.", 1.0)]
        );

        let third = adopt_generation(&mut connection, "embed-a", "http://127.0.0.1:9/v1").unwrap();

        assert_eq!(
            unembedded(&connection, third).unwrap(),
            2,
            "a third embedder, though it was the first, embeds every memory again"
        );
    }

    /// Another engine on the store, such as the one a reload replaced,
    /// keeps the generation it opened with.
    #[test]
    fn an_engine_whose_embedder_was_replaced_writes_no_vector_and_loses_no_memory() {
        let (_directory, mut connection, replaced) = store();

        keep(
            &mut connection,
            replaced,
            &sam(),
            &[("Sam likes tea.", &[1.0, 0.0])],
            None,
        )
        .unwrap();

        let current =
            adopt_generation(&mut connection, "embed-b", "http://127.0.0.1:9/v1").unwrap();
        let (memory, _) = next_unembedded(&connection, current).unwrap().unwrap();

        assert!(matches!(
            store_vector(&mut connection, replaced, memory, &[1.0, 0.0]),
            Err(StoreError::Superseded)
        ));
        assert_eq!(
            keep(
                &mut connection,
                replaced,
                &sam(),
                &[("Sam likes cocoa.", &[1.0, 0.0])],
                None
            )
            .unwrap(),
            ["Sam likes cocoa."]
        );
        assert_eq!(count(&connection, "vectors"), 0);
        assert_eq!(unembedded(&connection, current).unwrap(), 2);
        assert_eq!(
            nearest(&connection, replaced, &sam(), &[1.0, 0.0], 5, None).unwrap(),
            []
        );
    }

    #[test]
    fn a_generation_takes_its_width_from_its_first_vector_and_refuses_another() {
        let (_directory, mut connection, generation) = store();

        keep(
            &mut connection,
            generation,
            &sam(),
            &[("Sam likes tea.", &[1.0, 0.0, 0.0])],
            None,
        )
        .unwrap();

        let refused = keep(
            &mut connection,
            generation,
            &sam(),
            &[
                ("Sam likes coffee.", &[1.0, 0.0, 0.0]),
                ("Sam likes cocoa.", &[1.0, 0.0]),
            ],
            None,
        );

        assert!(
            matches!(
                refused,
                Err(StoreError::WidthChanged {
                    expected: 3,
                    found: 2
                })
            ),
            "{refused:?}"
        );
        assert!(matches!(
            nearest(&connection, generation, &sam(), &[1.0, 0.0], 5, None),
            Err(StoreError::WidthChanged {
                expected: 3,
                found: 2
            })
        ));
        assert_eq!(count(&connection, "memories"), 1);
    }

    #[test]
    fn a_commit_that_meets_a_locked_store_stores_nothing_and_says_so() {
        let (directory, mut connection, generation) = store();
        let other = connect(&directory.path().join("memory.sqlite"));
        let said = [Message {
            role: Role::User,
            content: "Sam: I like tea.".to_owned(),
        }];

        other.execute_batch("BEGIN IMMEDIATE").unwrap();

        let refused = keep(
            &mut connection,
            generation,
            &sam(),
            &[("Sam likes tea.", &[1.0, 0.0])],
            Some(("chat.1", &said)),
        );

        assert!(
            matches!(&refused, Err(StoreError::Sqlite(error)) if error.to_string() == "database is locked"),
            "{refused:?}"
        );

        other.execute_batch("ROLLBACK").unwrap();

        assert_eq!(count(&connection, "memories"), 0);
        assert_eq!(count(&connection, "vectors"), 0);
        assert_eq!(count(&connection, "messages"), 0);
    }
}
