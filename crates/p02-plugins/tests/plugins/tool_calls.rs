//! `handleToolCall`: the batch rule, deadlines, routing and the input
//! contract, the output boundary and the confirmation gate.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use p02_contracts::{
    ConversationToolCall, Evidence, EvidenceKind, EvidenceNote, EvidenceStatus, FileStore,
    HookContext, PluginError, PolicyOutcome, ProvidedTool, RuntimePlugin, StoreAccess, StoreError,
    ToolCall, ToolCallId, ToolCallOutcome, ToolCallResult, ToolInputContract,
};
use p02_plugins::{
    ConfirmationDecision, ConfirmationRequest, Confirmer, PluginHost, ProposedToolCall,
    ToolCallReport, Turn,
};
use serde_json::{Map, Value, json};
use tokio::time::Instant;

use crate::storage::Storage;
use crate::support::{
    Enable, GivingUp, Scripted, Seen, Settings, SlowTools, Spec, Stalling, Verbose, call, host_of,
    id, note, run_round, tool, turn,
};

async fn one(host: &PluginHost, call: ProposedToolCall, turn: &Turn) -> ToolCallReport {
    run_round(host, vec![call], turn).await.remove(0)
}

fn reason(report: &ToolCallReport) -> Option<&str> {
    match &report.result {
        ToolCallResult::Accepted { .. } => None,
        ToolCallResult::Rejected { reason, .. } => Some(reason),
    }
}

fn message(report: &ToolCallReport) -> &str {
    match &report.result {
        ToolCallResult::Accepted { .. } => panic!("the call was accepted: {report:?}"),
        ToolCallResult::Rejected { message, .. } => message,
    }
}

#[tokio::test(start_paused = true)]
async fn a_round_runs_shared_calls_together_and_exclusive_ones_alone_in_order() {
    let slow = Arc::new(SlowTools::new());
    let host = host_of(vec![(Spec::tools("toy"), Arc::clone(&slow) as _)]);
    let started = Instant::now();
    let reports = run_round(
        &host,
        vec![
            call("r1", "toy.read", json!({})),
            call("r2", "toy.read", json!({})),
            call("w3", "toy.write", json!({})),
            call("w4", "toy.write", json!({})),
            call("r5", "toy.read", json!({})),
        ],
        &turn(),
    )
    .await;
    let log = slow.log();
    let at = |entry: &str| log.iter().position(|line| line == entry).unwrap();

    // The reads overlap, each write runs alone, and nothing overtakes.
    assert_eq!(started.elapsed(), Duration::from_millis(400));
    assert!(at("start r2") < at("end r1"));
    assert!(at("end r1") < at("start w3") && at("end r2") < at("start w3"));
    assert!(at("end w3") < at("start w4") && at("end w4") < at("start r5"));
    assert_eq!(
        reports
            .iter()
            .map(|report| match &report.result {
                ToolCallResult::Accepted { output } => output["call"].clone(),
                ToolCallResult::Rejected { reason, .. } => panic!("refused: {reason}"),
            })
            .collect::<Vec<_>>(),
        [
            json!("r1"),
            json!("r2"),
            json!("w3"),
            json!("w4"),
            json!("r5")
        ]
    );
}

/// plugins.hook-last-word: a tool handler the host cancels at its deadline is heard for what it gives up with: its own failure is the refusal, not the timeout, and at the deadline, not after the second the host would wait
#[tokio::test(start_paused = true)]
async fn a_tool_handler_cancelled_at_its_deadline_is_refused_with_its_own_word() {
    let storage = Storage::new();
    let host = PluginHost::builder(Arc::clone(&storage) as _)
        .enable(
            &Spec {
                timeout_ms: 50,
                ..Spec::tools("notes")
            },
            GivingUp::new(vec![tool("notes.save")]),
        )
        .activate()
        .unwrap();
    let started = Instant::now();
    let report = one(&host, call("c1", "notes.save", json!({})), &turn()).await;

    assert_eq!(started.elapsed(), Duration::from_millis(50));
    assert_eq!(reason(&report), Some("handler_failed"));
    assert_eq!(message(&report), GivingUp::WORD);
}

/// plugins.hook-timeout: a tool handler that overruns its timeout and says nothing within the second after is refused `handler_timeout`, recorded by its policy, and its late write to its store is blocked
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tool_handler_past_its_timeout_is_refused_and_its_late_write_blocked() {
    for (policy, status) in [
        ("reject_tool_call", EvidenceStatus::Failed),
        ("degrade", EvidenceStatus::Degraded),
    ] {
        let (stalling, gate, late_write) = Stalling::new(vec![tool("notes.save")]);
        let storage = Storage::new();
        let host = PluginHost::builder(Arc::clone(&storage) as _)
            .enable(
                &Spec {
                    timeout_ms: 50,
                    tool: policy,
                    access: json!({"model_input": "write", "character_file_store": "write"}),
                    ..Spec::tools("notes")
                },
                stalling,
            )
            .activate()
            .unwrap();
        let report = one(&host, call("c1", "notes.save", json!({})), &turn()).await;

        assert_eq!(reason(&report), Some("handler_timeout"));
        assert_eq!(
            message(&report),
            "Plugin \"notes\" handleToolCall timed out after 50ms."
        );
        assert_eq!(report.evidence[0].status(), status, "{policy}");
        assert_eq!(
            report.evidence[0].policy_outcome(),
            Some(PolicyOutcome::Timeout)
        );

        gate.open();

        let written = tokio::time::timeout(Duration::from_secs(10), late_write)
            .await
            .unwrap()
            .unwrap();

        assert!(
            matches!(
                written,
                Err(StoreError::Cancelled | StoreError::WritesRevoked)
            ),
            "{written:?}"
        );
        assert_eq!(storage.files("notes").get("late.json"), None);
    }
}

#[tokio::test(start_paused = true)]
async fn a_call_the_host_cannot_route_or_whose_input_breaks_its_contract_is_refused() {
    let finding = || {
        Arc::new(Scripted {
            tools: vec![
                ProvidedTool::new(
                    id("notes.find"),
                    "Find a note.",
                    ToolInputContract::new(json!({
                        "type": "object",
                        "properties": {"query": {"type": "string"}},
                        "required": ["query"],
                        "additionalProperties": false,
                    }))
                    .unwrap(),
                )
                .unwrap(),
            ],
            tool_outcome: Some(ToolCallOutcome::Accepted {
                output: json!("found"),
                evidence: Vec::new(),
            }),
            ..Scripted::default()
        })
    };
    let strict = finding();
    let lenient = finding();
    let host = host_of(vec![(Spec::tools("notes"), Arc::clone(&strict) as _)]);
    let unknown = one(&host, call("c1", "ghost.read", json!({})), &turn()).await;
    let invalid = one(&host, call("c2", "notes.find", json!({})), &turn()).await;
    let lenient_host = host_of(vec![(
        Spec {
            tool: "degrade",
            ..Spec::tools("notes")
        },
        Arc::clone(&lenient) as _,
    )]);
    let degraded = one(
        &lenient_host,
        call("c3", "notes.find", json!({"q": 1})),
        &turn(),
    )
    .await;

    assert_eq!(reason(&unknown), Some("tool_not_declared"));
    assert_eq!(
        message(&unknown),
        "Tool \"ghost.read\" is not declared for this turn."
    );
    assert_eq!(unknown.evidence, []);
    assert_eq!(reason(&invalid), Some("invalid_input"));
    assert_eq!(
        message(&invalid),
        "notes.find input missing required field \"query\"."
    );
    assert_eq!(invalid.evidence[0].status(), EvidenceStatus::Rejected);
    assert_eq!(
        invalid.evidence[0].policy_outcome(),
        Some(PolicyOutcome::HandlerRejected)
    );
    assert_eq!(degraded.evidence[0].status(), EvidenceStatus::Degraded);
    assert_eq!(
        degraded.evidence[0].policy_outcome(),
        Some(PolicyOutcome::OptionalDegraded)
    );
    assert_eq!(strict.calls() + lenient.calls(), 0, "no handler ran");
}

#[tokio::test(start_paused = true)]
async fn a_plugin_answer_is_recorded_as_what_it_says_or_fails_the_call() {
    let answering = |policy: &'static str, outcome: ToolCallOutcome| {
        host_of(vec![(
            Spec {
                tool: policy,
                ..Spec::tools("notes")
            },
            Arc::new(Scripted {
                tools: vec![tool("notes.find")],
                tool_outcome: Some(outcome),
                ..Scripted::default()
            }),
        )])
    };
    let rejected = |reason: &str, message: &str, evidence| ToolCallOutcome::Rejected {
        reason: reason.to_owned(),
        message: message.to_owned(),
        evidence,
    };
    let explained = vec![EvidenceNote::new(
        EvidenceKind::ToolInvocation,
        EvidenceStatus::Rejected,
        "Nothing matched.",
    )];
    let failing_note = vec![EvidenceNote::new(
        EvidenceKind::ToolInvocation,
        EvidenceStatus::Failed,
        "The backend is down.",
    )];
    let ask = |outcome, policy| async move {
        one(
            &answering(policy, outcome),
            call("c1", "notes.find", json!({})),
            &turn(),
        )
        .await
    };

    let unexplained = ask(
        rejected("not_found", "No such note.", Vec::new()),
        "degrade",
    )
    .await;
    let kept = ask(rejected("not_found", "No such note.", explained), "degrade").await;
    let blank = ask(
        rejected(" ", "No such note.", Vec::new()),
        "reject_tool_call",
    )
    .await;
    let contradicted = ask(
        ToolCallOutcome::Accepted {
            output: json!([]),
            evidence: failing_note,
        },
        "reject_tool_call",
    )
    .await;
    let oversized = ask(
        ToolCallOutcome::Accepted {
            output: json!("x".repeat(16 * 1_024 + 1)),
            evidence: Vec::new(),
        },
        "reject_tool_call",
    )
    .await;

    assert_eq!(reason(&unexplained), Some("not_found"));
    assert_eq!(
        unexplained
            .evidence
            .iter()
            .map(|record| (record.status(), record.policy_outcome(), record.summary()))
            .collect::<Vec<_>>(),
        [(
            EvidenceStatus::Degraded,
            Some(PolicyOutcome::OptionalDegraded),
            "No such note."
        )]
    );
    assert_eq!(
        kept.evidence
            .iter()
            .map(Evidence::summary)
            .collect::<Vec<_>>(),
        ["Nothing matched."]
    );
    assert_eq!(reason(&blank), Some("handler_failed"));
    assert_eq!(
        message(&blank),
        "Plugin rejected tool result reason and message must be non-empty."
    );
    assert_eq!(
        reason(&contradicted),
        Some("blocking_tool_invocation_evidence")
    );
    assert_eq!(contradicted.evidence[0].summary(), "The backend is down.");
    assert_eq!(reason(&oversized), Some("handler_failed"));
    assert_eq!(
        message(&oversized),
        "Plugin tool output exceeds the JSON string byte limit"
    );
}

#[tokio::test(start_paused = true)]
async fn a_verbose_failure_is_cut_to_what_a_record_keeps_and_still_replays() {
    let host = host_of(vec![(
        Spec::tools("chatty"),
        Arc::new(Verbose {
            tools: vec![tool("chatty.run")],
        }) as _,
    )]);
    let report = one(&host, call("c1", "chatty.run", json!({})), &turn()).await;
    let text = message(&report).to_owned();

    assert_eq!(reason(&report), Some("handler_failed"));
    assert_eq!(text.chars().count(), 4_096);
    assert!(text.ends_with("..."));
    assert_eq!(report.evidence[0].summary(), text);
    assert!(
        ConversationToolCall::new(
            ToolCallId::new("c1").unwrap(),
            id("chatty"),
            id("chatty.run"),
            Map::new(),
            report.result,
        )
        .is_ok()
    );
}

/// plugins.output-redaction: tool output values under credential-shaped keys, nested and in lists, are redacted before the model or the log sees them
#[tokio::test(start_paused = true)]
async fn credential_named_output_values_are_redacted_at_the_boundary() {
    let host = host_of(vec![(
        Spec::tools("vault"),
        Arc::new(Scripted {
            tools: vec![tool("vault.read")],
            tool_outcome: Some(ToolCallOutcome::Accepted {
                output: json!({
                    "api_key": "super-secret",
                    "nested": {"password": {"hint": "open-sesame"}, "safe": "kept"},
                    "list": [{"access_token": "secret-token", "label": "kept"}],
                    "prompt_tokens": 12,
                }),
                evidence: vec![note(EvidenceKind::ToolInvocation, "Read the vault.")],
            }),
            ..Scripted::default()
        }),
    )]);
    let report = one(&host, call("c1", "vault.read", json!({})), &turn()).await;
    let seen = serde_json::to_string(&(&report.result, &report.evidence)).unwrap();

    assert_eq!(
        report.result,
        ToolCallResult::Accepted {
            output: json!({
                "api_key": "[redacted]",
                "nested": {"password": "[redacted]", "safe": "kept"},
                "list": [{"access_token": "[redacted]", "label": "kept"}],
                "prompt_tokens": 12,
            })
        }
    );

    for secret in ["super-secret", "open-sesame", "secret-token"] {
        assert!(!seen.contains(secret), "{secret} reached {seen}");
    }
}

/// Answers every question the same way a minute after it was asked, long
/// past every plugin's budget, and keeps what it was asked.
#[derive(Debug)]
struct Asking {
    decision: ConfirmationDecision,
    asked: Mutex<Vec<ConfirmationRequest>>,
}

impl Asking {
    fn answering(decision: ConfirmationDecision) -> Arc<Self> {
        Arc::new(Self {
            decision,
            asked: Mutex::new(Vec::new()),
        })
    }
}

#[async_trait]
impl Confirmer for Asking {
    async fn confirm(&self, request: ConfirmationRequest) -> ConfirmationDecision {
        self.asked.lock().unwrap().push(request);
        tokio::time::sleep(Duration::from_secs(60)).await;
        self.decision
    }
}

/// A host of `settings`, granted its store in `storage`, that asks the
/// person through `asking` when there is someone to ask.
fn settings_host(
    storage: &Arc<Storage>,
    settings: &Arc<Settings>,
    asking: Option<&Arc<Asking>>,
) -> PluginHost {
    let builder = PluginHost::builder(Arc::clone(storage) as _).enable(
        &Spec {
            access: json!({
                "model_input": "write",
                "character_file_store": "write",
                "plugin_database": "write",
            }),
            ..Spec::tools("settings")
        },
        Arc::clone(settings) as _,
    );
    let builder = match asking {
        Some(asking) => builder.confirmer(Arc::clone(asking) as _),
        None => builder,
    };

    builder.activate().unwrap()
}

/// plugins.tool-confirmation-gate: any plugin's confirmable tool is approval-gated the same way: its call is prepared with the store read-only and no database and the person is shown what it would do, a denial is `plugin_config_approval_denied` and applies nothing, an approval applies the prepared effect with `user_approved` evidence, and with nobody to ask it is never offered or prepared, a call of it refused `tool_not_declared` as any tool the turn never offered
#[tokio::test(start_paused = true)]
async fn a_confirmable_tool_applies_its_prepared_effect_only_on_the_persons_yes() {
    let storage = Storage::new();
    let settings = Arc::new(Settings::noting(vec![note(
        EvidenceKind::ToolInvocation,
        "Prepared the settings.",
    )]));
    let hosted = |asking| settings_host(&storage, &settings, asking);
    let update = || {
        call(
            "c1",
            "settings.update",
            json!({"tone": "warm", "api_key": "k-1"}),
        )
    };
    let saved = || storage.files("settings").get("settings.json");
    let denying = Asking::answering(ConfirmationDecision::Denied);
    let denied = one(&hosted(Some(&denying)), update(), &turn()).await;

    assert_eq!(reason(&denied), Some("plugin_config_approval_denied"));
    assert_eq!(saved(), None, "a denial applies nothing");
    assert!(
        denied
            .evidence
            .iter()
            .all(|record| record.policy_outcome() != Some(PolicyOutcome::UserApproved))
    );

    let asked = denying.asked.lock().unwrap().remove(0);

    assert_eq!(
        (asked.plugin_id.as_str(), asked.tool_name.as_str()),
        ("settings", "settings.update")
    );
    assert_eq!(
        Value::Object(asked.preview),
        json!({"before": null, "after": {"tone": "warm", "api_key": "[redacted]"}})
    );

    let approving = Asking::answering(ConfirmationDecision::Approved);
    let approved = one(&hosted(Some(&approving)), update(), &turn()).await;

    assert_eq!(
        approved.result,
        ToolCallResult::Accepted {
            output: json!({"status": "applied"})
        }
    );
    assert_eq!(
        saved(),
        Some(json!({"tone": "warm", "api_key": "k-1"})),
        "the effect runs on a budget of its own, though the person answered past the preparation's"
    );
    assert_eq!(
        approved
            .evidence
            .iter()
            .map(|record| (record.kind(), record.policy_outcome(), record.summary()))
            .collect::<Vec<_>>(),
        [
            (EvidenceKind::ToolInvocation, None, "Prepared the settings."),
            (
                EvidenceKind::Policy,
                Some(PolicyOutcome::UserApproved),
                "User approved plugin \"settings\" tool \"settings.update\"."
            ),
            (EvidenceKind::ToolInvocation, None, "Saved the settings."),
        ]
    );

    let unasked = hosted(None);
    let refused = one(&unasked, update(), &turn()).await;
    let unable_to_write = Seen {
        store: Some(StoreAccess::ReadOnly),
        ..Seen::default()
    };

    assert!(unasked.tool_definitions().get("settings.update").is_none());
    assert_eq!(reason(&refused), Some("tool_not_declared"));
    assert_eq!(refused.evidence, [], "no plugin answered it");
    assert_eq!(
        settings.prepared_with.lock().unwrap().as_slice(),
        [unable_to_write.clone(), unable_to_write],
        "each call the person was asked about was prepared unable to write, with no database, \
         and the one nobody could be asked about was never prepared"
    );
}

#[tokio::test(start_paused = true)]
async fn a_call_refused_in_its_preparation_asks_nobody_and_the_model_reads_why() {
    let storage = Storage::new();
    let asking = Asking::answering(ConfirmationDecision::Approved);
    let noting = |notes| settings_host(&storage, &Arc::new(Settings::noting(notes)), Some(&asking));
    let unknown = one(
        &noting(Vec::new()),
        call("c1", "settings.update", json!({"tone": "grumpy"})),
        &turn(),
    )
    .await;
    let damaged = one(
        &noting(vec![EvidenceNote::new(
            EvidenceKind::ToolInvocation,
            EvidenceStatus::Failed,
            "The saved settings are damaged.",
        )]),
        call("c2", "settings.update", json!({"tone": "warm"})),
        &turn(),
    )
    .await;

    assert_eq!(
        unknown.result,
        ToolCallResult::Rejected {
            reason: "unknown_tone".to_owned(),
            message: "No tone is called \"grumpy\".".to_owned(),
        }
    );
    assert_eq!(
        damaged.result,
        ToolCallResult::Rejected {
            reason: "blocking_tool_invocation_evidence".to_owned(),
            message: "Plugin \"settings\" tool \"settings.update\" prepared call included \
                      blocking tool invocation evidence."
                .to_owned(),
        }
    );
    assert_eq!(
        damaged.evidence[0].summary(),
        "The saved settings are damaged."
    );
    assert!(asking.asked.lock().unwrap().is_empty(), "nobody was asked");
}

/// Saves a note under the store's lease, and keeps the store afterwards.
#[derive(Debug)]
struct NoteTaker {
    tools: Vec<ProvidedTool>,
    kept: Mutex<Option<FileStore>>,
}

#[async_trait]
impl RuntimePlugin for NoteTaker {
    fn provided_tools(&self) -> &[ProvidedTool] {
        &self.tools
    }

    async fn handle_tool_call(
        &self,
        call: &ToolCall,
        context: &HookContext,
    ) -> Result<ToolCallOutcome, PluginError> {
        let store = context
            .character_file_store()
            .cloned()
            .ok_or_else(|| PluginError::new("the store was not granted"))?;
        let text = call.input().get("text").cloned().unwrap_or(Value::Null);
        let leased = store.clone();

        tokio::task::spawn_blocking(move || {
            leased.with_lease(|leased| leased.write_json("notes.json", &json!([text])))
        })
        .await
        .map_err(|error| PluginError::with_source("the store job failed", error))??;
        *self.kept.lock().unwrap() = Some(store);

        Ok(ToolCallOutcome::Accepted {
            output: json!("saved"),
            evidence: Vec::new(),
        })
    }
}

#[tokio::test]
async fn a_store_kept_past_its_call_writes_nothing_more() {
    let taker = Arc::new(NoteTaker {
        tools: vec![tool("notes.save")],
        kept: Mutex::new(None),
    });
    let host = host_of(vec![(
        Spec {
            access: json!({"model_input": "write", "character_file_store": "write"}),
            ..Spec::tools("notes")
        },
        Arc::clone(&taker) as _,
    )]);
    let report = one(
        &host,
        call("c1", "notes.save", json!({"text": "likes tea"})),
        &turn(),
    )
    .await;
    let kept = taker.kept.lock().unwrap().clone().unwrap();

    assert_eq!(reason(&report), None, "{report:?}");
    assert!(matches!(
        kept.with_lease(|leased| leased.write_json("notes.json", &json!(["overwritten"]))),
        Err(StoreError::WritesRevoked)
    ));
    assert_eq!(
        kept.with_lease(|leased| leased.read_json("notes.json"))
            .unwrap(),
        Some(json!(["likes tea"]))
    );
}
