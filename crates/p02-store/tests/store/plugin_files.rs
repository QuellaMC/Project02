//! A plugin's own files, as its hooks reach them through the character's
//! storage: documents and logs under one lease at a time, every path and
//! value held to the store's rules.

use std::sync::Arc;
use std::time::{Duration, Instant};

use p02_contracts::{CharacterStorage, FileStoreBackend, LeasedFiles, StoreError};
use p02_store::StorageError;
use serde_json::{Value, json};

use crate::layout::snapshot;
use crate::support::{World, id};

fn store(world: &World, plugin: &str) -> Arc<dyn FileStoreBackend> {
    world.data.file_store(&id(plugin))
}

fn leased(store: &dyn FileStoreBackend) -> Box<dyn LeasedFiles + '_> {
    store
        .lease(Instant::now() + Duration::from_secs(10))
        .unwrap()
}

/// The code of the store's own error inside a refused call.
fn code(error: &StoreError) -> &'static str {
    let StoreError::Store(source) = error else {
        panic!("not the store's own error: {error}");
    };

    source.downcast_ref::<StorageError>().unwrap().code()
}

fn deep(levels: usize) -> Value {
    (0..levels).fold(json!("bottom"), |inner, _| json!({ "inner": inner }))
}

#[test]
fn what_a_plugin_writes_the_next_lease_reads_back_as_written() {
    let world = World::new();
    let memory = store(&world, "character-memory");
    let root = world
        .data
        .root()
        .join("plugin-data")
        .join("character-memory");
    let note = json!({"kind": "character_memory.store", "notes": ["Likes tea."]});

    {
        let mut files = leased(memory.as_ref());

        assert_eq!(files.read_json("memory.json").unwrap(), None);
        assert_eq!(
            files.read_jsonl("events.jsonl").unwrap(),
            Vec::<Value>::new()
        );

        files
            .write_json("memory.json", &json!({"notes": []}))
            .unwrap();
        files.write_json("memory.json", &note).unwrap();
        files
            .append_jsonl("events.jsonl", &json!({"n": 1}))
            .unwrap();
        files
            .append_jsonl("events.jsonl", &json!({"n": 2}))
            .unwrap();
        files
            .write_json("idempotency/0f3a.json", &json!(true))
            .unwrap();
    }

    let files = leased(memory.as_ref());

    assert_eq!(files.read_json("memory.json").unwrap(), Some(note.clone()));
    assert_eq!(
        files.read_jsonl("events.jsonl").unwrap(),
        [json!({"n": 1}), json!({"n": 2})]
    );
    drop(files);
    assert_eq!(
        snapshot(&root),
        [
            ("events.jsonl", "{\"n\":1}\n{\"n\":2}\n".to_owned()),
            ("idempotency/0f3a.json", "true\n".to_owned()),
            ("memory.json", format!("{note}\n")),
        ]
        .into_iter()
        .map(|(name, content)| (name.to_owned(), content))
        .collect()
    );
    #[cfg(unix)]
    for name in ["memory.json", "events.jsonl"] {
        use std::os::unix::fs::PermissionsExt as _;

        assert_eq!(
            std::fs::metadata(root.join(name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600,
            "{name}"
        );
    }
}

#[test]
fn each_plugin_keeps_its_own_files_and_its_own_lease() {
    let world = World::new();
    let memory = store(&world, "character-memory");
    let state = store(&world, "character-state");
    let mut held = leased(memory.as_ref());

    held.write_json("notes.json", &json!(["Likes tea."]))
        .unwrap();

    let started = Instant::now();
    let other = leased(state.as_ref());

    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(other.read_json("notes.json").unwrap(), None);
    assert_eq!(
        code(
            &memory
                .lease(Instant::now() + Duration::from_millis(100))
                .unwrap_err()
        ),
        "storage_busy"
    );
}

#[test]
fn a_path_that_could_leave_the_store_or_name_what_it_keeps_is_refused() {
    let world = World::new();
    let memory = store(&world, "character-memory");
    let mut files = leased(memory.as_ref());
    let unsafe_paths = [
        "",
        "../memory.json",
        "/memory.json",
        "notes//memory.json",
        "notes/./memory.json",
        "notes\\memory.json",
        ".memory.json.0b9b1a7e-6f3d-4b8a-9a43-2a1f6c5d7e8f.tmp",
        "session-index.sqlite",
        "session-index.sqlite-wal",
        "memory.txt",
        "memory",
        "memory .json",
        "m\u{e9}moire.json",
        "memory.json\n",
    ];

    for path in unsafe_paths {
        assert_eq!(
            code(&files.write_json(path, &json!({})).unwrap_err()),
            "invalid_store_path",
            "{path:?}"
        );
        assert_eq!(
            code(&files.read_json(path).unwrap_err()),
            "invalid_store_path",
            "{path:?}"
        );
    }

    for refused in [
        files.write_json("events.jsonl", &json!({})).unwrap_err(),
        files.append_jsonl("memory.json", &json!({})).unwrap_err(),
        files.read_json("events.jsonl").unwrap_err(),
        files.read_jsonl("memory.json").unwrap_err(),
        files.count_jsonl("memory.json").unwrap_err(),
    ] {
        assert_eq!(code(&refused), "invalid_store_path", "{refused}");
    }

    assert!(
        !world.data.root().join("plugin-data").exists(),
        "a refused call made the store"
    );
}

#[test]
fn a_value_past_the_json_limits_is_refused_whether_written_or_read() {
    let world = World::new();
    let memory = store(&world, "character-memory");
    let root = world
        .data
        .root()
        .join("plugin-data")
        .join("character-memory");
    let mut files = leased(memory.as_ref());
    let crowded = Value::Array((0..257).map(Value::from).collect());

    files.write_json("memory.json", &deep(16)).unwrap();

    for refused in [
        files.write_json("memory.json", &deep(17)).unwrap_err(),
        files.append_jsonl("events.jsonl", &crowded).unwrap_err(),
        files
            .write_json("memory.json", &json!("x".repeat(16 * 1_024 + 1)))
            .unwrap_err(),
    ] {
        assert_eq!(code(&refused), "invalid_store_value", "{refused}");
    }

    assert_eq!(files.read_json("memory.json").unwrap(), Some(deep(16)));

    std::fs::write(root.join("memory.json"), format!("{}\n", deep(17))).unwrap();
    std::fs::write(root.join("events.jsonl"), format!("{crowded}\n")).unwrap();

    let refused = files.read_json("memory.json").unwrap_err();

    assert_eq!(code(&refused), "malformed_record", "{refused}");
    assert_eq!(files.read_jsonl("events.jsonl").unwrap(), [Value::Null]);
}
