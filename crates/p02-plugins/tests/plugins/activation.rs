//! Activation: the set of plugins a character enables, held to the host's
//! rules, and what each of them reaches.

use std::error::Error;
use std::sync::Arc;
use std::time::Duration;

use p02_contracts::{CommittedTurn, FactoryInput, PluginError, RedactionLabel, StoreAccess};
use p02_core::Timestamp;
use p02_plugins::{BeforeCallOutcome, list};
use p02_shared::Identifier;
use serde_json::{Map, Value, json};

use crate::storage::Storage;
use crate::support::{Enable, Probe, Scripted, Seen, Spec, Verbose, builder, turn};

#[test]
fn a_plugin_enabled_twice_or_built_in_vain_is_refused_at_activation() {
    let twice = builder(Storage::new())
        .enable(&Spec::new("notes"), Arc::new(Scripted::default()))
        .enable(&Spec::new("notes"), Arc::new(Scripted::default()))
        .activate()
        .unwrap_err();
    let in_vain = builder(Storage::new())
        .plugin(
            Spec::new("notes").manifest(),
            Map::new(),
            |_: &FactoryInput<'_>| Err(PluginError::new("no backend is configured")),
        )
        .activate()
        .unwrap_err();

    assert_eq!(twice.to_string(), r#"plugin "notes" is enabled twice"#);
    assert_eq!(in_vain.to_string(), r#"plugin "notes" could not be built"#);
    assert_eq!(
        in_vain.source().map(ToString::to_string),
        Some("no backend is configured".to_owned())
    );
}

#[tokio::test(start_paused = true)]
async fn a_plugins_labels_are_held_at_activation_to_what_a_record_has_room_for() {
    let fullest = (0..16)
        .map(|index| RedactionLabel::new(&format!("plug{index:0>124}")).unwrap())
        .collect::<Vec<_>>();
    let one_more = [fullest.clone(), vec![RedactionLabel::new("extra").unwrap()]].concat();
    let chatty = |labels: &[RedactionLabel]| Spec {
        before: "reject_turn",
        labels: json!(
            labels
                .iter()
                .map(RedactionLabel::as_str)
                .collect::<Vec<_>>()
        ),
        ..Spec::new("chatty")
    };
    let host = builder(Storage::new())
        .enable(&chatty(&fullest), Arc::new(Verbose::default()))
        .activate()
        .unwrap();
    let BeforeCallOutcome::Rejected(rejection) = host.before_role_model_call(&turn()).await else {
        panic!("a verbose required hook rejects the turn");
    };
    let refused = builder(Storage::new())
        .enable(&chatty(&one_more), Arc::new(Verbose::default()))
        .activate()
        .unwrap_err();

    // The fullest labels of a plugin ride even the longest record.
    assert_eq!(rejection.evidence[0].redaction_labels().len(), 16);
    assert_eq!(
        refused.to_string(),
        r#"plugin "chatty" has redaction labels its records cannot carry"#
    );
    assert_eq!(
        refused.source().map(ToString::to_string),
        Some(
            "a plugin brings at most 16 labels to each record, each of at most 128 bytes"
                .to_owned()
        )
    );
}

#[tokio::test]
async fn the_listed_plugins_activate_together() {
    // A plugin is built once it is set up: Long-Term Memory with its key.
    let set_up = Map::from_iter([("apiKey".to_owned(), Value::from("m0-key"))]);
    let host = list::plugins()
        .unwrap()
        .iter()
        .fold(
            builder(Storage::new()),
            |builder, (manifest, _, factory)| {
                builder.plugin(manifest.clone(), set_up.clone(), *factory)
            },
        )
        .activate()
        .unwrap();

    assert_eq!(
        host.plugin_ids()
            .map(Identifier::as_str)
            .collect::<Vec<_>>(),
        [
            "runtime.plugin",
            "character-memory",
            "character-state",
            "mem0",
            "phone",
            "reply-style",
            "session-history"
        ]
    );
    assert_eq!(
        host.tool_definitions()
            .definitions()
            .iter()
            .map(|definition| definition.tool.name().as_str())
            .collect::<Vec<_>>(),
        [
            "runtime.plugin.list",
            "runtime.plugin.config",
            "runtime.plugin.config.update",
            "memory.update",
            "character_state.patch",
            "mem0.search",
            "mem0.add",
            "phone.open",
            "phone.use",
            "phone.sign_in",
            "phone.install",
            "sessions.search",
            "sessions.read"
        ]
    );

    let BeforeCallOutcome::Prepared(prepared) = host.before_role_model_call(&turn()).await else {
        panic!("no listed plugin rejects the turn");
    };

    assert_eq!(
        prepared
            .runtime_notes
            .iter()
            .map(|note| note.plugin_id().map(Identifier::as_str))
            .collect::<Vec<_>>(),
        [
            Some("character-state"),
            Some("phone"),
            Some("reply-style"),
            Some("session-history")
        ]
    );
}

#[tokio::test]
async fn a_plugin_reaches_what_its_manifest_requests_and_an_ending_one_only_reads() {
    let granted = Arc::new(Probe::default());
    let reader = Arc::new(Probe::default());
    let bare = Arc::new(Probe::default());
    let declared = json!([
        "before_role_model_call",
        "after_turn_committed",
        "on_shutdown"
    ]);
    let host = builder(Storage::new())
        .enable(
            &Spec {
                declared: declared.clone(),
                access: json!({
                    "turn_context": "read",
                    "character_file_store": "write",
                    "session_history": "read",
                    "plugin_database": "write",
                }),
                ..Spec::new("granted")
            },
            Arc::clone(&granted) as _,
        )
        .enable(
            &Spec {
                declared: declared.clone(),
                access: json!({"character_file_store": "read"}),
                ..Spec::new("reader")
            },
            Arc::clone(&reader) as _,
        )
        .enable(
            &Spec {
                declared,
                access: json!({}),
                ..Spec::new("bare")
            },
            Arc::clone(&bare) as _,
        )
        .activate()
        .unwrap();
    let committed = CommittedTurn::new(Timestamp::new("2026-10-18T00:00:01.000Z").unwrap())
        .with_messages(Vec::new());

    host.before_role_model_call(&turn()).await;
    host.after_turn_committed(&turn(), &committed).await;
    host.shutdown().await;

    assert_eq!(
        granted.seen("before"),
        Some(Seen {
            message: Some("hello".to_owned()),
            store: Some(StoreAccess::ReadWrite),
            history: true,
            databases: true,
        })
    );
    assert_eq!(
        granted.seen("committed").and_then(|seen| seen.message),
        Some("0 message(s)".to_owned())
    );
    assert_eq!(
        granted.seen("shutdown"),
        Some(Seen {
            message: None,
            store: Some(StoreAccess::ReadOnly),
            history: true,
            databases: false,
        }),
        "her end serves no turn, so it shows no turn's text"
    );
    assert_eq!(
        reader.seen("before"),
        Some(Seen {
            store: Some(StoreAccess::ReadOnly),
            ..Seen::default()
        })
    );
    assert_eq!(
        bare.seen("before"),
        Some(Seen::default()),
        "without turn_context the message is absent, not empty"
    );
    assert_eq!(bare.seen("committed").and_then(|seen| seen.message), None);
}

/// The store is waited for by what remains of the hook's budget, on the
/// clock the store runs on, so a paused clock the real one has run ahead
/// of, as a slow test machine's has, refuses no lease.
#[tokio::test(start_paused = true)]
async fn a_stores_lease_is_waited_for_by_what_remains_of_the_hooks_budget() {
    let probe = Arc::new(Probe::default());
    let storage = Storage::new();
    let files = storage.files("probe");
    let host = builder(storage)
        .enable(
            &Spec {
                access: json!({"character_file_store": "write"}),
                ..Spec::new("probe")
            },
            Arc::clone(&probe) as _,
        )
        .activate()
        .unwrap();

    // The real clock runs on while the paused one stands: by the time the
    // hook begins, its one-second budget has passed on the real clock.
    std::thread::sleep(Duration::from_millis(1_500));
    host.before_role_model_call(&turn()).await;

    assert_eq!(
        probe.seen("before").and_then(|seen| seen.store),
        Some(StoreAccess::ReadWrite)
    );
    assert!(
        files
            .waited_until()
            .is_some_and(|until| until > std::time::Instant::now()),
        "the store was given a deadline already past on its clock"
    );
}
