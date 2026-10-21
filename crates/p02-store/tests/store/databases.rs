//! A plugin's databases, as its hooks open them through the character's
//! storage: in the plugin's own data, at the plugin's version, made anew
//! when unusable as the view they are, and left as they are while another
//! program holds them.

use std::cell::Cell;
use std::num::NonZeroU32;
use std::path::PathBuf;

use p02_contracts::{CharacterStorage, DatabaseError};
use p02_store::{OpenDatabaseError, StorageError};
use rusqlite::types::Value;
use rusqlite::{Connection, ErrorCode};

use crate::support::{World, id};

fn index_path(world: &World) -> PathBuf {
    world
        .data
        .root()
        .join("plugin-data")
        .join("session-history")
        .join("session-index.sqlite")
}

/// Session-history's index at version `version`; `made` counts the times
/// it was made.
fn open(world: &World, version: u32, made: &Cell<u32>) -> Result<Connection, DatabaseError> {
    world.data.databases(&id("session-history")).open(
        &id("session-index"),
        NonZeroU32::new(version).unwrap(),
        &|connection| {
            made.set(made.get() + 1);
            connection.execute_batch("CREATE TABLE messages (id INTEGER PRIMARY KEY, text TEXT)")
        },
    )
}

fn rows(connection: &Connection) -> i64 {
    connection
        .query_row("SELECT count(*) FROM messages", [], |row| row.get(0))
        .unwrap()
}

#[test]
fn a_database_opens_owner_only_in_its_plugins_data_at_its_version_and_is_made_once() {
    let world = World::new();
    let made = Cell::new(0);
    let connection = open(&world, 2, &made).unwrap();
    let pragma = |name: &str| -> Value {
        connection
            .pragma_query_value(None, name, |row| row.get(0))
            .unwrap()
    };

    assert_eq!(connection.path(), index_path(&world).to_str());
    assert_eq!(
        [
            "journal_mode",
            "synchronous",
            "foreign_keys",
            "busy_timeout",
            "user_version",
        ]
        .map(pragma),
        [
            Value::Text("wal".to_owned()),
            Value::Integer(1),
            Value::Integer(1),
            Value::Integer(2_000),
            Value::Integer(2),
        ]
    );

    connection
        .execute("INSERT INTO messages (text) VALUES ('Tea, always.')", [])
        .unwrap();
    #[cfg(unix)]
    for suffix in ["", "-wal", "-shm"] {
        use std::os::unix::fs::PermissionsExt as _;

        let mut path = index_path(&world).into_os_string();

        path.push(suffix);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600,
            "{suffix}"
        );
    }
    drop(connection);

    let again = open(&world, 2, &made).unwrap();

    assert_eq!((made.get(), rows(&again)), (1, 1));
}

#[test]
fn a_database_of_another_version_or_that_is_no_database_is_made_anew() {
    for damage in ["newer version", "no version", "no database"] {
        let world = World::new();
        let made = Cell::new(0);

        {
            let connection = open(&world, 2, &made).unwrap();

            connection
                .execute("INSERT INTO messages (text) VALUES ('Tea, always.')", [])
                .unwrap();
        }

        match damage {
            "newer version" | "no version" => {
                let version = if damage == "newer version" { 3 } else { 0 };

                Connection::open(index_path(&world))
                    .unwrap()
                    .pragma_update(None, "user_version", version)
                    .unwrap();
            }
            _ => std::fs::write(index_path(&world), "This is no database.").unwrap(),
        }

        let connection = open(&world, 2, &made).unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();

        assert_eq!(
            (made.get(), rows(&connection), version),
            (2, 0, 2),
            "{damage}"
        );
    }
}

/// Another program's database in the place of the view, which it holds
/// locked: the open waits its while, then says so, and deletes nothing.
#[test]
fn a_database_another_program_holds_is_reported_busy_and_left_as_it_is() {
    let world = World::new();
    let made = Cell::new(0);
    let path = index_path(&world);

    std::fs::create_dir_all(path.parent().unwrap()).unwrap();

    let holder = Connection::open(&path).unwrap();

    holder
        .execute_batch(
            "CREATE TABLE keepsake (id INTEGER PRIMARY KEY);
             INSERT INTO keepsake (id) VALUES (7);
             BEGIN EXCLUSIVE;",
        )
        .unwrap();

    let DatabaseError::Open(refused) = open(&world, 1, &made).unwrap_err() else {
        panic!("the open was not refused by the store");
    };
    let refused = refused.downcast_ref::<StorageError>().unwrap();

    assert_eq!(refused.code(), "write_failed");
    assert!(
        matches!(
            refused,
            StorageError::Database {
                source: OpenDatabaseError::Sqlite(error),
                ..
            } if error.sqlite_error_code() == Some(ErrorCode::DatabaseBusy)
        ),
        "{refused:?}"
    );

    holder.execute_batch("ROLLBACK").unwrap();
    assert_eq!(
        holder
            .query_row("SELECT id FROM keepsake", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        7
    );
    assert_eq!(made.get(), 0);
}
