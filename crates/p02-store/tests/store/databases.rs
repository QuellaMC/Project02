//! A plugin's databases, as its hooks open them through the character's
//! storage: in the plugin's own data, at the plugin's version.

use std::cell::Cell;
use std::num::NonZeroU32;
use std::path::PathBuf;

use p02_contracts::{CharacterStorage, DatabaseError};
use rusqlite::Connection;
use rusqlite::types::Value;

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
