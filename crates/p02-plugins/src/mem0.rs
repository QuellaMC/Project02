//! The mem0 package: long-term memory, recalled before each turn and
//! captured after it, kept by a Mem0 platform account, a self-hosted Mem0
//! server, or the embedded engine on this device. Memories belong to the
//! person and the character, never to a session. A backend that fails
//! costs the turn its memory, never the turn, and every failure is told in
//! words that carry no credential.

mod backend;
mod captures;
mod embedded;
mod rest;
mod settings;
mod tools;

use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use p02_contracts::{
    BeforeRoleModelCallOutput, CommittedTurn, ContextItem, ContextItemKind, EvidenceKind,
    EvidenceNote, EvidenceStatus, FactoryInput, HealthReport, HealthStatus, HookContext,
    HookReport, HookStatus, PluginError, ProvidedTool, RedactionLabel, RuntimePlugin, SourceKind,
    SourceReference, ToolCall, ToolCallOutcome, TurnText,
};
use p02_core::VisibleMessageRole;
use p02_memory::{Message, ObservedOn, Role, Scope, Turn};
use p02_shared::Identifier;
use serde_json::{Value, json};

use self::backend::{
    BackendError, Failure, Found, Operation, RECALL_LIMIT, Readiness, Write, Written,
};
use self::captures::{Captures, Outcomes, Queued};
use self::settings::Setup;
use crate::text::excerpt;

/// How much of a memory's text the model reads, and an added memory keeps.
const MEMORY_CHARS: usize = 600;

/// How much of a memory's id a search result repeats.
const ID_CHARS: usize = 120;

/// How much of a summary the records keep: the warning that leads one
/// must survive the cut.
const SUMMARY_CHARS: usize = 160;

static MEMORY_LABEL: LazyLock<RedactionLabel> =
    LazyLock::new(|| RedactionLabel::new("memory").expect("memory is a redaction label"));

/// The package's factory. Settings that leave the plugin without a
/// backend make a plugin whose every hook says what to set.
///
/// # Errors
///
/// [`PluginError`] when a tool of the package is refused, which no build
/// of the daemon ships.
pub fn create(input: &FactoryInput<'_>) -> Result<Arc<dyn RuntimePlugin>, PluginError> {
    Ok(Arc::new(Mem0Plugin {
        tools: tools::provided()?,
        setup: settings::configured(input.config()).map(Arc::new),
        captures: Captures::default(),
    }))
}

#[derive(Debug)]
struct Mem0Plugin {
    tools: Vec<ProvidedTool>,
    /// Where memories are kept, or what the settings must set first.
    setup: Result<Arc<Setup>, String>,
    captures: Captures,
}

/// Why health found no backend to vouch for.
enum Unready {
    Misconfigured(String),
    Failed(BackendError),
}

#[async_trait]
impl RuntimePlugin for Mem0Plugin {
    fn provided_tools(&self) -> &[ProvidedTool] {
        &self.tools
    }

    async fn before_role_model_call(
        &self,
        context: &HookContext,
    ) -> Result<BeforeRoleModelCallOutput, PluginError> {
        let setup = self.setup()?;
        let found = setup
            .backend
            .search(
                &setup.scope(context),
                turn_text(context)?.current_user_message.as_str(),
                context.plugin_database(),
            )
            .await
            .map_err(|error| failed(&error))?;
        let items: Vec<ContextItem> = found.iter().take(RECALL_LIMIT).map(recalled).collect();

        Ok(BeforeRoleModelCallOutput {
            evidence: vec![note(
                EvidenceKind::BeforeRoleModelCall,
                EvidenceStatus::Accepted,
                &format!("Provided {} memory item(s).", items.len()),
            )],
            context_items: items,
            curated_sections: Vec::new(),
        })
    }

    /// Queues the turn and returns: extraction happens behind the turn.
    async fn after_turn_committed(
        &self,
        committed: &CommittedTurn,
        context: &HookContext,
    ) -> Result<HookReport, PluginError> {
        let report = |status, summary: &str, source| HookReport {
            status: HookStatus::Completed,
            evidence: vec![
                note(EvidenceKind::AfterTurnCommitted, status, summary).with_source(source),
            ],
        };
        let setup = match &self.setup {
            Ok(setup) => Arc::clone(setup),
            Err(message) => {
                return Ok(report(
                    EvidenceStatus::Degraded,
                    message,
                    this_turn(context),
                ));
            }
        };
        let identity = context.turn();
        let observed_on = ObservedOn::parse(
            committed
                .committed_at()
                .as_str()
                .get(..10)
                .unwrap_or_default(),
        )
        .map_err(|error| {
            PluginError::with_source("a committed turn's time starts with its day", error)
        })?;
        let turn = Turn {
            session: identity.session_id.to_string(),
            messages: captured(committed),
            sources: vec![identity.event.event_id().to_string()],
            observed_on,
        };

        if let Err(error) = setup.backend.open(context.plugin_database()).await {
            let why = error.to_string();

            self.captures.lose(&why);
            return Ok(report(EvidenceStatus::Degraded, &why, this_turn(context)));
        }

        let scope = setup.scope(context);
        let job =
            Box::pin(async move { setup.backend.write(&scope, Write::Turn(turn), None).await });
        let queue = SourceReference::new(SourceKind::ExternalContract, "mem0.capture_queue")
            .with_title("Queued memory capture");

        Ok(match self.captures.queue(job) {
            Queued::Accepted { earlier_losses: 0 } => report(
                EvidenceStatus::Accepted,
                "Queued turn for memory extraction.",
                queue,
            ),
            Queued::Accepted { earlier_losses } => report(
                EvidenceStatus::Accepted,
                &format!(
                    "Queued turn for memory extraction. {earlier_losses} earlier capture(s) did \
                     not complete."
                ),
                queue,
            ),
            Queued::Refused => report(
                EvidenceStatus::Degraded,
                "Memory extraction is behind; this turn was not queued for capture.",
                this_turn(context),
            ),
        })
    }

    async fn handle_tool_call(
        &self,
        call: &ToolCall,
        context: &HookContext,
    ) -> Result<ToolCallOutcome, PluginError> {
        let setup = self.setup()?;
        let scope = setup.scope(context);

        match call.tool_name().as_str() {
            tools::SEARCH => {
                let found = setup
                    .backend
                    .search(
                        &scope,
                        text_input(call, "query")?,
                        context.plugin_database(),
                    )
                    .await
                    .map_err(|error| failed(&error))?;

                Ok(searched(&found, context))
            }
            tools::ADD => {
                let write = Write::Fact {
                    text: excerpt(text_input(call, "text")?, MEMORY_CHARS).into_owned(),
                    sources: vec![context.turn().event.event_id().to_string()],
                };
                let written = tokio::select! {
                    biased;
                    written = setup.backend.write(&scope, write, context.plugin_database()) => {
                        written
                    }
                    () = context.cancellation().cancelled() => {
                        Err(BackendError::new(Operation::Add, Failure::Abandoned))
                    }
                }
                .map_err(|error| failed(&error))?;

                added(written, context)
            }
            other => Err(PluginError::new(format!(
                "Memory provider does not handle \"{other}\"."
            ))),
        }
    }

    async fn health(&self, context: &HookContext) -> Result<HealthReport, PluginError> {
        let checked = match &self.setup {
            Ok(setup) => setup
                .backend
                .ping(context.plugin_database())
                .await
                .map_err(Unready::Failed),
            Err(message) => Err(Unready::Misconfigured(message.clone())),
        };

        Ok(health_report(&self.captures.outcomes(), checked))
    }

    /// Drains the queued captures until the host cancels the hook at its
    /// deadline, then abandons the rest. Nothing runs after this, and the
    /// next launch counts from nothing, so a capture lost to now is
    /// recorded here alone.
    async fn on_shutdown(&self, context: &HookContext) -> Result<HookReport, PluginError> {
        let outcomes = self.captures.drain(context.cancellation()).await;
        let (status, summary) = match &outcomes.loss {
            Some(loss) => (
                EvidenceStatus::Degraded,
                format!("Closed memory provider. {loss}"),
            ),
            None => (
                EvidenceStatus::Accepted,
                "Closed memory provider.".to_owned(),
            ),
        };

        Ok(HookReport {
            status: HookStatus::Completed,
            evidence: vec![note(EvidenceKind::Shutdown, status, &summary)],
        })
    }
}

impl Mem0Plugin {
    fn setup(&self) -> Result<&Setup, PluginError> {
        self.setup
            .as_deref()
            .map_err(|message| PluginError::new(message.clone()))
    }
}

impl Setup {
    /// The person's and the turn's character's memories.
    fn scope(&self, context: &HookContext) -> Scope {
        Scope::new(&self.user, context.turn().character.id.as_str())
    }
}

/// Health from the backend's readiness and what the captures came to. A
/// lost capture leads every summary, so the cut never takes the warning.
fn health_report(outcomes: &Outcomes, checked: Result<Readiness, Unready>) -> HealthReport {
    let losses = outcomes
        .loss
        .as_deref()
        .map(|loss| format!("{loss} "))
        .unwrap_or_default();
    let (status, summary) = match checked {
        Ok(readiness) => {
            let running = if outcomes.pending == 0 {
                String::new()
            } else {
                format!(" {} capture(s) still running.", outcomes.pending)
            };

            if outcomes.incomplete > 0 {
                (
                    HealthStatus::Degraded,
                    format!("{losses}{}{running}", readiness.summary),
                )
            } else {
                let status = if readiness.verified {
                    HealthStatus::Ok
                } else {
                    HealthStatus::Degraded
                };
                let last = outcomes
                    .last
                    .as_deref()
                    .map(|last| format!(" {last}"))
                    .unwrap_or_default();

                (status, format!("{}{last}{running}", readiness.summary))
            }
        }
        Err(Unready::Failed(error)) => (
            if error.is_unavailable() {
                HealthStatus::Unavailable
            } else {
                HealthStatus::Degraded
            },
            format!("{losses}{error}"),
        ),
        Err(Unready::Misconfigured(message)) => {
            (HealthStatus::Unavailable, format!("{losses}{message}"))
        }
    };

    HealthReport {
        status,
        summary: excerpt(summary.trim(), SUMMARY_CHARS).into_owned(),
    }
}

/// A recalled memory, for the model's recalled-memory block.
fn recalled(found: &Found) -> ContextItem {
    let item = ContextItem::new(
        item_id(&found.id),
        ContextItemKind::Memory,
        excerpt(&found.text, MEMORY_CHARS),
    )
    .with_source(memory_source(&found.id))
    .with_redaction_label(MEMORY_LABEL.clone());

    match found.score {
        Some(score) => item.with_confidence(score.clamp(0.0, 1.0)),
        None => item,
    }
}

fn searched(found: &[Found], context: &HookContext) -> ToolCallOutcome {
    let found = &found[..found.len().min(RECALL_LIMIT)];
    let items: Vec<Value> = found
        .iter()
        .map(|found| {
            let mut item = json!({
                "id": excerpt(&found.id, ID_CHARS),
                "text": excerpt(&found.text, MEMORY_CHARS),
                "sourceReferences": [memory_source(&found.id)],
            });

            if let Some(score) = found.score {
                item["confidence"] = Value::from(score.clamp(0.0, 1.0));
            }

            item
        })
        .collect();
    let sources = if found.is_empty() {
        vec![
            SourceReference::new(
                SourceKind::Runtime,
                format!(
                    "{}:{}.no_results",
                    context.turn().event.event_id(),
                    tools::SEARCH
                ),
            )
            .with_title("Memory search completed with no results"),
        ]
    } else {
        found.iter().map(|found| memory_source(&found.id)).collect()
    };
    let summary = format!("Returned {} memory search result(s).", items.len());

    ToolCallOutcome::Accepted {
        output: json!({"items": items}),
        evidence: vec![sourced(
            note(
                EvidenceKind::ToolInvocation,
                EvidenceStatus::Accepted,
                &summary,
            ),
            sources,
        )],
    }
}

/// An add that stored something, or that the platform queued; an add that
/// stored nothing failed.
fn added(written: Written, context: &HookContext) -> Result<ToolCallOutcome, PluginError> {
    let (output, summary, kept) = match written {
        Written::Stored(stored) => {
            let Some(first) = stored.first() else {
                return Err(failed(&BackendError::new(
                    Operation::Add,
                    Failure::NothingStored,
                )));
            };
            let kept: Vec<SourceReference> = stored
                .iter()
                .take(SourceReference::MAX_PER_RECORD)
                .map(|id| memory_source(id))
                .collect();

            (
                json!({"id": first, "sourceReferences": kept}),
                "Added one memory item.",
                kept,
            )
        }
        Written::Queued(receipt) => {
            let kept = vec![
                SourceReference::new(SourceKind::ExternalContract, receipt)
                    .with_title("Queued mem0 memory write"),
            ];

            (
                json!({"queued": true, "sourceReferences": kept}),
                "Queued one memory item for the backend to store.",
                kept,
            )
        }
    };

    Ok(ToolCallOutcome::Accepted {
        output,
        evidence: vec![sourced(
            note(
                EvidenceKind::ToolInvocation,
                EvidenceStatus::Accepted,
                summary,
            ),
            std::iter::once(this_turn(context)).chain(kept).collect(),
        )],
    })
}

/// The turn as the backend is to read it: the person's line and the
/// character's last reply as the turn committed them, each under the name
/// the session recorded for its speaker, since role labels name nobody in
/// roleplay.
fn captured(committed: &CommittedTurn) -> Vec<Message> {
    let messages = committed.messages().unwrap_or_default();
    let line = messages
        .iter()
        .find(|message| message.role == VisibleMessageRole::User)
        .map(|message| (Role::User, message));
    let reply = messages
        .iter()
        .rev()
        .find(|message| message.role == VisibleMessageRole::Character)
        .map(|message| (Role::Assistant, message));

    line.into_iter()
        .chain(reply)
        .map(|(role, message)| Message {
            role,
            content: format!("{}: {}", message.speaker_name, message.text),
        })
        .collect()
}

/// A context item's id for a memory: the memory's own, in the letters an
/// identifier allows, after `memory.`.
fn item_id(memory: &str) -> Identifier {
    let mut id: String = std::iter::once("memory.")
        .flat_map(str::chars)
        .chain(memory.chars().map(|character| {
            if character.is_ascii_alphanumeric() || "._-".contains(character) {
                character
            } else {
                '_'
            }
        }))
        .collect();

    id.truncate(Identifier::MAX_LEN);
    Identifier::new(&id)
        .expect("ASCII letters, digits, '.', '_' and '-' after a letter make an identifier")
}

fn memory_source(id: &str) -> SourceReference {
    SourceReference::new(SourceKind::Memory, id).with_title("Mem0 memory")
}

fn this_turn(context: &HookContext) -> SourceReference {
    SourceReference::new(
        SourceKind::Conversation,
        context.turn().event.event_id().as_str(),
    )
    .with_title("Current conversation turn")
}

/// A record of the plugin's, its summary cut as every memory record's is.
fn note(kind: EvidenceKind, status: EvidenceStatus, summary: &str) -> EvidenceNote {
    EvidenceNote::new(kind, status, excerpt(summary, SUMMARY_CHARS))
}

/// `note` with the sources a record has room for, the leading ones kept.
fn sourced(note: EvidenceNote, sources: Vec<SourceReference>) -> EvidenceNote {
    sources
        .into_iter()
        .take(SourceReference::MAX_PER_RECORD)
        .fold(note, EvidenceNote::with_source)
}

fn turn_text(context: &HookContext) -> Result<&TurnText, PluginError> {
    context
        .turn_text()
        .ok_or_else(|| PluginError::new("mem0 needs the turn's text, which its manifest requests"))
}

fn text_input<'a>(call: &'a ToolCall, field: &str) -> Result<&'a str, PluginError> {
    call.input()
        .get(field)
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| {
            PluginError::new(format!(
                "Memory tool input \"{field}\" must be a non-empty string."
            ))
        })
}

fn failed(error: &BackendError) -> PluginError {
    PluginError::new(error.to_string())
}
