//! The hooks that follow what happened, and a plugin rebuilt or ended
//! while the host serves.

use std::sync::Arc;
use std::time::Duration;

use p02_contracts::{
    BeforeRoleModelCallOutput, CommittedTurn, ContextItem, ContextItemKind, Evidence, EvidenceKind,
    EvidenceNote, EvidenceStatus, FactoryInput, HookReport, HookStatus, PluginError, PolicyOutcome,
    RuntimePlugin,
};
use p02_core::Timestamp;
use p02_plugins::{BeforeCallOutcome, PhaseStatus, PluginHost, ReloadError};
use serde_json::{Map, Value, json};

use crate::storage::Storage;
use crate::support::{
    Enable, Failing, Hanging, Panicking, Scripted, Spec, Stalling, host_of, id, note, tool, turn,
};

fn committed() -> CommittedTurn {
    CommittedTurn::new(Timestamp::new("2026-10-18T00:00:01.000Z").unwrap())
}

/// The host's half of plugins.after-turn-hooks; the turn's half, the
/// follow-up record in the log, waits for the runtime.
#[tokio::test(start_paused = true)]
async fn after_turn_failures_are_collected_and_reported_never_thrown() {
    let after = |id| Spec {
        declared: json!(["after_turn_committed", "on_session_end"]),
        timeout_ms: 50,
        ..Spec::new(id)
    };
    let reporting = Arc::new(Scripted {
        report: Some(HookReport {
            status: HookStatus::Failed,
            evidence: Vec::new(),
        }),
        ..Scripted::default()
    });
    let clean = Arc::new(Scripted {
        report: Some(HookReport {
            status: HookStatus::Completed,
            evidence: vec![note(EvidenceKind::AfterTurnCommitted, "Indexed the turn.")],
        }),
        ..Scripted::default()
    });
    let host = host_of(vec![
        (after("failing"), Arc::new(Failing)),
        (after("hanging"), Arc::new(Hanging::default())),
        (after("panicking"), Arc::new(Panicking)),
        (after("reporting"), Arc::clone(&reporting) as _),
        (after("clean"), Arc::clone(&clean) as _),
    ]);
    let report = host.after_turn_committed(&turn(), &committed()).await;
    let records: Vec<_> = report
        .evidence
        .iter()
        .map(|record| {
            (
                record.plugin_id().as_str(),
                record.status(),
                record.summary(),
                record.policy_outcome(),
            )
        })
        .collect();

    assert_eq!(report.status, PhaseStatus::CompletedWithFailures);
    assert_eq!(
        records,
        [
            (
                "failing",
                EvidenceStatus::Failed,
                "afterTurnCommitted plugin hook failed: backend unreachable",
                Some(PolicyOutcome::AfterCommitFailed)
            ),
            (
                "hanging",
                EvidenceStatus::Failed,
                "afterTurnCommitted plugin hook failed: Plugin \"hanging\" afterTurnCommitted \
                 timed out after 50ms.",
                Some(PolicyOutcome::Timeout)
            ),
            (
                "panicking",
                EvidenceStatus::Failed,
                "afterTurnCommitted plugin hook failed: Plugin hook panicked: index out of bounds",
                Some(PolicyOutcome::AfterCommitFailed)
            ),
            (
                "reporting",
                EvidenceStatus::Failed,
                "afterTurnCommitted plugin hook reported failure.",
                Some(PolicyOutcome::AfterCommitFailed)
            ),
            ("clean", EvidenceStatus::Accepted, "Indexed the turn.", None),
        ]
    );

    let ended = host.session_end(&turn()).await;
    let reported = ended
        .evidence
        .iter()
        .find(|record| record.plugin_id().as_str() == "reporting")
        .unwrap();

    assert_eq!(ended.status, PhaseStatus::CompletedWithFailures);
    assert_eq!(reported.kind(), EvidenceKind::SessionEnd);
    assert_eq!(
        reported.summary(),
        "onSessionEnd plugin hook reported failure."
    );
    assert_eq!(reported.policy_outcome(), None);
    assert_eq!(clean.calls(), 2);
}

#[tokio::test(start_paused = true)]
async fn a_report_its_own_record_says_failed_fails_its_phase() {
    let report = host_of(vec![(
        Spec {
            declared: json!(["after_turn_committed"]),
            ..Spec::new("contradicting")
        },
        Arc::new(Scripted {
            report: Some(HookReport {
                status: HookStatus::Completed,
                evidence: vec![EvidenceNote::new(
                    EvidenceKind::AfterTurnCommitted,
                    EvidenceStatus::Failed,
                    "The index was out of reach.",
                )],
            }),
            ..Scripted::default()
        }),
    )])
    .after_turn_committed(&turn(), &committed())
    .await;

    assert_eq!(report.status, PhaseStatus::CompletedWithFailures);
    assert_eq!(
        report
            .evidence
            .iter()
            .map(Evidence::summary)
            .collect::<Vec<_>>(),
        ["The index was out of reach."],
        "the plugin's own record says why, so the host adds none"
    );
}

/// Answers its turns with the line its config gives it, and offers a tool
/// when the line asks for one.
fn speaking(input: &FactoryInput<'_>) -> Result<Arc<dyn RuntimePlugin>, PluginError> {
    let Some(line) = input.config().value("line").and_then(Value::as_str) else {
        return Err(PluginError::new("no line is configured"));
    };

    Ok(Arc::new(Scripted {
        tools: if line == "tooled" {
            vec![tool("speaker.say")]
        } else {
            Vec::new()
        },
        before: BeforeRoleModelCallOutput {
            context_items: vec![ContextItem::new(
                id("line"),
                ContextItemKind::Resource,
                line,
            )],
            ..BeforeRoleModelCallOutput::default()
        },
        ..Scripted::default()
    }))
}

fn line(text: &str) -> Map<String, Value> {
    Map::from_iter([("line".to_owned(), json!(text))])
}

#[tokio::test(start_paused = true)]
async fn a_reload_serves_later_hooks_with_the_rebuilt_plugin_unless_the_rebuild_fails() {
    let spec = Spec {
        declared: json!([
            "tool_provider",
            "handle_tool_call",
            "before_role_model_call"
        ]),
        config_fields: json!([{
            "name": "line",
            "description": "What the speaker says.",
            "required": false,
            "secret": false,
            "valueType": "string",
            "redactionLabels": [],
        }]),
        ..Spec::new("speaker")
    };
    let host = PluginHost::builder(Storage::new())
        .plugin(spec.manifest(), line("first"), speaking)
        .activate()
        .unwrap();
    let spoken = async |host: &PluginHost| match host.before_role_model_call(&turn()).await {
        BeforeCallOutcome::Prepared(prepared) => prepared.context_items[0].item().text().to_owned(),
        BeforeCallOutcome::Rejected(rejection) => panic!("rejected: {rejection:?}"),
    };

    assert_eq!(spoken(&host).await, "first");
    host.reload(&id("speaker"), &line("second")).unwrap();
    assert_eq!(spoken(&host).await, "second");

    let unbuilt = host.reload(&id("speaker"), &Map::new()).unwrap_err();
    let retooled = host.reload(&id("speaker"), &line("tooled")).unwrap_err();
    let absent = host.reload(&id("ghost"), &line("third")).unwrap_err();

    assert!(matches!(unbuilt, ReloadError::Build { .. }), "{unbuilt:?}");
    assert_eq!(
        retooled.to_string(),
        "plugin \"speaker\" was rebuilt with other tools than the model is offered, so it \
         serves on as it was"
    );
    assert!(matches!(absent, ReloadError::NotEnabled(_)), "{absent:?}");
    assert_eq!(spoken(&host).await, "second", "the old instance serves on");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reload_and_a_shutdown_never_wait_on_a_blocking_job() {
    let (stalling, gate, job_ended) = Stalling::new(Vec::new());
    let host = PluginHost::builder(Storage::new())
        .enable(
            &Spec {
                declared: json!(["after_turn_committed", "on_shutdown"]),
                timeout_ms: 50,
                access: json!({"character_file_store": "write"}),
                ..Spec::new("indexer")
            },
            stalling,
        )
        .activate()
        .unwrap();
    let report = host.after_turn_committed(&turn(), &committed()).await;

    assert_eq!(
        report.evidence[0].policy_outcome(),
        Some(PolicyOutcome::Timeout)
    );

    let started = std::time::Instant::now();

    host.reload(&id("indexer"), &Map::new()).unwrap();

    let ended = tokio::time::timeout(Duration::from_secs(5), host.shutdown(&turn()))
        .await
        .expect("shutdown does not wait on the job");
    let mut job_ended = job_ended;

    assert_eq!(ended.status, PhaseStatus::Completed);
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "{:?}",
        started.elapsed()
    );
    assert!(job_ended.try_recv().is_err(), "the job still runs");

    gate.open();
    tokio::time::timeout(Duration::from_secs(10), job_ended)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
}
