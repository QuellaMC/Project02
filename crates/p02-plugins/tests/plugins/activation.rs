//! Activation: the set of plugins a character enables, held to the host's
//! rules, and what each of them reaches.

use std::error::Error;
use std::sync::Arc;

use p02_contracts::{
    CommittedTurn, FactoryInput, MissingConfigValueError, PluginError, RedactionLabel,
    RegistrationError, StoreAccess,
};
use p02_core::Timestamp;
use p02_plugins::{
    ActivationError, BeforeCallOutcome, BuildPluginError, PluginHost, RecordLabelsError, list,
};
use p02_shared::Identifier;
use serde_json::{Map, json};

use crate::storage::Storage;
use crate::support::{Enable, Probe, Scripted, Seen, Spec, Verbose, tool, turn};

/// plugins.manifest-validation: two enabled plugins offering one tool name, or one plugin offering a tool twice, are refused at activation
#[test]
fn a_tool_name_offered_twice_is_refused_at_activation() {
    let searching = |tools: &[&str]| {
        Arc::new(Scripted {
            tools: tools.iter().map(|name| tool(name)).collect(),
            ..Scripted::default()
        })
    };
    let across = PluginHost::builder(Storage::new())
        .enable(&Spec::tools("notes"), searching(&["notes.search"]))
        .enable(&Spec::tools("archive"), searching(&["notes.search"]))
        .activate()
        .unwrap_err();
    let within = PluginHost::builder(Storage::new())
        .enable(
            &Spec::tools("notes"),
            searching(&["notes.search", "notes.search"]),
        )
        .activate()
        .unwrap_err();

    assert!(
        matches!(across, ActivationError::DuplicateTool(_)),
        "{across:?}"
    );
    assert_eq!(
        across.to_string(),
        r#"tool "notes.search" is offered by both "notes" and "archive""#
    );
    assert!(
        matches!(
            within,
            ActivationError::Build {
                source: BuildPluginError::Registration(RegistrationError::DuplicateTool { .. }),
                ..
            }
        ),
        "{within:?}"
    );
    assert_eq!(
        within.source().map(ToString::to_string),
        Some(r#"plugin "notes" provides tool "notes.search" more than once"#.to_owned())
    );
}

#[test]
fn a_plugin_enabled_twice_missing_a_required_value_or_built_in_vain_is_refused_at_activation() {
    let twice = PluginHost::builder(Storage::new())
        .enable(&Spec::new("notes"), Arc::new(Scripted::default()))
        .enable(&Spec::new("notes"), Arc::new(Scripted::default()))
        .activate()
        .unwrap_err();
    let unset = PluginHost::builder(Storage::new())
        .enable(
            &Spec {
                config_fields: json!([{
                    "name": "backend",
                    "description": "Where the notes are kept.",
                    "required": true,
                    "secret": false,
                    "valueType": "string",
                    "redactionLabels": [],
                }]),
                ..Spec::new("notes")
            },
            Arc::new(Scripted::default()),
        )
        .activate()
        .unwrap_err();
    let in_vain = PluginHost::builder(Storage::new())
        .plugin(
            Spec::new("notes").manifest(),
            Map::new(),
            |_: &FactoryInput<'_>| Err(PluginError::new("no backend is configured")),
        )
        .activate()
        .unwrap_err();

    assert_eq!(twice.to_string(), r#"plugin "notes" is enabled twice"#);
    assert!(
        matches!(
            &unset,
            ActivationError::Build {
                source: BuildPluginError::Config(MissingConfigValueError { field }),
                ..
            } if field.as_str() == "backend"
        ),
        "{unset:?}"
    );
    assert_eq!(
        unset.source().map(ToString::to_string),
        Some(
            r#"required plugin config field "backend" is not set to a value it accepts"#.to_owned()
        )
    );
    assert_eq!(in_vain.to_string(), r#"plugin "notes" could not be built"#);
    assert_eq!(
        in_vain.source().map(ToString::to_string),
        Some("no backend is configured".to_owned())
    );
}

#[tokio::test(start_paused = true)]
async fn labels_are_held_where_they_enter_to_what_a_record_has_room_for() {
    let fullest = |source: &str| {
        (0..16)
            .map(|index| RedactionLabel::new(&format!("{source}{index:0>124}")).unwrap())
            .collect::<Vec<_>>()
    };
    let one_more =
        |source: &str| [fullest(source), vec![RedactionLabel::new("extra").unwrap()]].concat();
    let chatty = |labels: Vec<RedactionLabel>| Spec {
        before: "reject_turn",
        labels: json!(
            labels
                .iter()
                .map(RedactionLabel::as_str)
                .collect::<Vec<_>>()
        ),
        ..Spec::new("chatty")
    };
    let host = PluginHost::builder(Storage::new())
        .enable(&chatty(fullest("plug")), Arc::new(Verbose::default()))
        .activate()
        .unwrap();
    let labeled = turn().with_privacy_labels(fullest("turn")).unwrap();
    let BeforeCallOutcome::Rejected(rejection) = host.before_role_model_call(&labeled).await else {
        panic!("a verbose required hook rejects the turn");
    };
    let refused = PluginHost::builder(Storage::new())
        .enable(&chatty(one_more("plug")), Arc::new(Verbose::default()))
        .activate()
        .unwrap_err();

    // The fullest labels of a turn and of a plugin ride even the longest record.
    assert_eq!(rejection.evidence[0].redaction_labels().len(), 32);
    assert_eq!(
        refused.to_string(),
        r#"plugin "chatty" has redaction labels its records cannot carry"#
    );
    assert_eq!(
        refused.source().map(ToString::to_string),
        Some(
            "a turn or a plugin brings at most 16 labels to each record, each of at most 128 \
             bytes"
                .to_owned()
        )
    );
    assert_eq!(
        turn().with_privacy_labels(one_more("turn")).unwrap_err(),
        RecordLabelsError
    );
    assert_eq!(
        turn()
            .with_privacy_labels(vec![RedactionLabel::new(&"x".repeat(129)).unwrap()])
            .unwrap_err(),
        RecordLabelsError
    );
}

#[tokio::test]
async fn the_listed_plugins_activate_together() {
    let host = list::plugins()
        .unwrap()
        .iter()
        .fold(
            PluginHost::builder(Storage::new()),
            |builder, (manifest, factory)| builder.plugin(manifest.clone(), Map::new(), *factory),
        )
        .activate()
        .unwrap();

    assert_eq!(
        host.plugin_ids()
            .map(Identifier::as_str)
            .collect::<Vec<_>>(),
        ["mem0", "session-history"]
    );
    assert_eq!(
        host.tool_definitions()
            .definitions()
            .iter()
            .map(|definition| definition.tool.name().as_str())
            .collect::<Vec<_>>(),
        [
            "mem0.search",
            "mem0.add",
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
        [Some("session-history")]
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
    let host = PluginHost::builder(Storage::new())
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
    host.shutdown(&turn()).await;

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
            message: Some("hello".to_owned()),
            store: Some(StoreAccess::ReadOnly),
            history: true,
            databases: false,
        })
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
