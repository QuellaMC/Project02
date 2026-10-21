//! The session-history package: the character recalls its own past
//! conversations. It keeps an index of the character's session history in
//! its own database, catches it up after every committed turn and before
//! every query, and offers the model a full-text search with a view around
//! each hit and a read that scrolls a session by message.

mod index;
mod output;
mod tools;

use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use p02_contracts::{
    BeforeRoleModelCallOutput, CommittedTurn, ContextItem, ContextItemKind, EvidenceKind,
    EvidenceNote, EvidenceStatus, FactoryInput, HookContext, HookReport, HookStatus,
    PluginDatabase, PluginError, ProvidedTool, RuntimePlugin, SessionHistory, ToolCall,
    ToolCallOutcome,
};
use p02_core::SessionId;
use p02_shared::Identifier;
use serde_json::Value;

use self::index::{IndexError, Scope, SessionIndex};

const GUIDANCE: &str = "When they bring up an earlier conversation, or the answer may sit \
     further back than you can see (including earlier in this one), look it up with \
     sessions.search before asking them to repeat themselves; read more of a past conversation \
     with sessions.read.";

const SEARCH_SESSION_LIMIT: u32 = 3;
const READ_WINDOW: u32 = 8;

/// The package's factory: it reads no config.
///
/// # Errors
///
/// [`PluginError`] when a tool of the package is refused, which no build
/// of the daemon ships.
pub fn create(_input: &FactoryInput<'_>) -> Result<Arc<dyn RuntimePlugin>, PluginError> {
    Ok(Arc::new(SessionHistoryPlugin {
        tools: tools::provided()?,
        index: Arc::default(),
    }))
}

#[derive(Debug)]
struct SessionHistoryPlugin {
    tools: Vec<ProvidedTool>,
    /// Opened by the first hook that needs it, and kept beyond it: the
    /// connection is the plugin's.
    index: Arc<Mutex<Option<SessionIndex>>>,
}

/// What the plugin's hooks reach, as its manifest requests, and whose
/// history it is.
#[derive(Clone, Debug)]
struct Reach {
    character: Identifier,
    history: SessionHistory,
    databases: PluginDatabase,
}

enum Request {
    Search {
        query: String,
        session: Option<String>,
        limit: u32,
    },
    Read {
        session: String,
        anchor: Option<String>,
        window: u32,
    },
}

struct Answer {
    output: Value,
    summary: String,
}

#[async_trait]
impl RuntimePlugin for SessionHistoryPlugin {
    fn provided_tools(&self) -> &[ProvidedTool] {
        &self.tools
    }

    async fn before_role_model_call(
        &self,
        _context: &HookContext,
    ) -> Result<BeforeRoleModelCallOutput, PluginError> {
        let guidance = Identifier::new("session-history.guidance")
            .map_err(|error| PluginError::with_source("the guidance needs an id", error))?;

        Ok(BeforeRoleModelCallOutput {
            context_items: vec![ContextItem::new(
                guidance,
                ContextItemKind::RuntimeNote,
                GUIDANCE,
            )],
            curated_sections: Vec::new(),
            evidence: vec![EvidenceNote::new(
                EvidenceKind::BeforeRoleModelCall,
                EvidenceStatus::Accepted,
                "Provided session-history recall guidance.",
            )],
        })
    }

    async fn handle_tool_call(
        &self,
        call: &ToolCall,
        context: &HookContext,
    ) -> Result<ToolCallOutcome, PluginError> {
        let reach = Reach::of(context)?;
        let request = Request::of(call)?;
        let unseen: Vec<String> = context
            .turn_text()
            .map(|text| {
                text.recent_visible_message_ids
                    .iter()
                    .map(ToString::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let index = Arc::clone(&self.index);
        let answered = tokio::task::spawn_blocking(move || reach.answer(&index, request, &unseen))
            .await
            .map_err(|error| PluginError::with_source("the session index job failed", error))?;

        Ok(match answered {
            Ok(answer) => ToolCallOutcome::Accepted {
                output: answer.output,
                evidence: vec![EvidenceNote::new(
                    EvidenceKind::ToolInvocation,
                    EvidenceStatus::Accepted,
                    answer.summary,
                )],
            },
            Err(error) => refusal(error),
        })
    }

    async fn after_turn_committed(
        &self,
        _turn: &CommittedTurn,
        context: &HookContext,
    ) -> Result<HookReport, PluginError> {
        let reach = Reach::of(context)?;
        let report = |status, summary| HookReport {
            status: HookStatus::Completed,
            evidence: vec![EvidenceNote::new(
                EvidenceKind::AfterTurnCommitted,
                status,
                summary,
            )],
        };

        let session = context.turn().session_id.clone();
        let index = Arc::clone(&self.index);
        let caught_up = tokio::task::spawn_blocking(move || {
            reach.indexed(&index, |index, history| {
                index.catch_up(history, Some(&session)).map(drop)
            })
        })
        .await
        .map_err(|error| PluginError::with_source("the session index job failed", error))?;

        // The catch-up only saves the next search the work: a failure here
        // is the next search's to report.
        Ok(match caught_up {
            Ok(()) => report(
                EvidenceStatus::Accepted,
                "Caught the session index up to the committed turn.",
            ),
            Err(_) => report(
                EvidenceStatus::Degraded,
                "Session index catch-up failed; the next search retries.",
            ),
        })
    }

    /// The index closes when the plugin is dropped, once the last hook
    /// still using it lets go, so ending asks nothing of it.
    async fn on_shutdown(&self, _context: &HookContext) -> Result<HookReport, PluginError> {
        Ok(HookReport {
            status: HookStatus::Completed,
            evidence: Vec::new(),
        })
    }
}

impl Reach {
    fn of(context: &HookContext) -> Result<Self, PluginError> {
        match (context.session_history(), context.plugin_database()) {
            (Some(history), Some(databases)) => Ok(Self {
                character: context.turn().character.id.clone(),
                history: history.clone(),
                databases: databases.clone(),
            }),
            _ => Err(PluginError::new(
                "session history needs the session history and the database its manifest \
                 requests",
            )),
        }
    }

    /// Runs `work` on the plugin's index, opening it first if no hook has.
    fn indexed<T>(
        &self,
        index: &Mutex<Option<SessionIndex>>,
        work: impl FnOnce(&mut SessionIndex, &SessionHistory) -> Result<T, IndexError>,
    ) -> Result<T, IndexError> {
        let mut kept = index.lock().unwrap_or_else(PoisonError::into_inner);
        let mut opened = match kept.take() {
            Some(opened) => opened,
            None => SessionIndex::open(&self.databases, &self.character)?,
        };
        let done = work(&mut opened, &self.history);

        *kept = Some(opened);
        done
    }

    fn answer(
        &self,
        index: &Mutex<Option<SessionIndex>>,
        request: Request,
        unseen: &[String],
    ) -> Result<Answer, IndexError> {
        match request {
            Request::Search {
                query,
                session,
                limit,
            } => {
                let session = session.map(session_id).transpose()?;

                self.indexed(index, |index, history| {
                    let listing = index.catch_up(history, session.as_ref())?;

                    if let Some(session) = &session
                        && !listing
                            .sessions
                            .iter()
                            .any(|listed| &listed.session_id == session)
                    {
                        return Err(IndexError::SessionNotFound(session.to_string()));
                    }

                    let hits = index.search(
                        &query,
                        &Scope {
                            session: session.as_ref(),
                            unseen,
                            limit,
                        },
                    )?;
                    let damaged = listing.damaged_entry_count + index.damaged_records()?;

                    Ok(Answer {
                        summary: format!(
                            "Returned {} of {} matching session(s).",
                            hits.views.len(),
                            hits.sessions_with_hits
                        ),
                        output: output::search(&hits, damaged, &query),
                    })
                })
            }
            Request::Read {
                session,
                anchor,
                window,
            } => {
                let session = session_id(session)?;

                self.indexed(index, |index, history| {
                    let listing = index.catch_up(history, Some(&session))?;

                    if !listing
                        .sessions
                        .iter()
                        .any(|listed| listed.session_id == session)
                    {
                        return Err(IndexError::SessionNotFound(session.to_string()));
                    }

                    let window = index.read(&session, anchor.as_deref(), i64::from(window))?;
                    let damaged = listing.damaged_entry_count + index.damaged_records()?;

                    Ok(Answer {
                        summary: format!(
                            "Returned {} message(s) from one session.",
                            window.messages.len()
                        ),
                        output: output::read(&session.to_string(), &window, damaged),
                    })
                })
            }
        }
    }
}

impl Request {
    /// The call's input, which the host already held to the tool's
    /// contract.
    fn of(call: &ToolCall) -> Result<Self, PluginError> {
        let input = call.input();
        let text = |field: &str| input.get(field).and_then(Value::as_str).map(str::to_owned);
        // A number the contract admitted is a whole one within the tool's
        // bounds, which JSON writes as 5 or as 5.0 alike.
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "the contract admits only whole numbers from 1 to 15"
        )]
        let number = |field: &str, default: u32| {
            input
                .get(field)
                .and_then(Value::as_f64)
                .map_or(default, |value| value as u32)
        };

        match call.tool_name().as_str() {
            tools::SEARCH => Ok(Self::Search {
                query: text("query").unwrap_or_default(),
                session: text("sessionId"),
                limit: number("sessionLimit", SEARCH_SESSION_LIMIT),
            }),
            tools::READ => Ok(Self::Read {
                session: text("sessionId").unwrap_or_default(),
                anchor: text("anchorMessageId"),
                window: number("window", READ_WINDOW),
            }),
            other => Err(PluginError::new(format!(
                "session history provides no tool \"{other}\""
            ))),
        }
    }
}

/// A session the model named, which is in no history unless it is a
/// session id.
fn session_id(text: String) -> Result<SessionId, IndexError> {
    SessionId::parse(&text).map_err(|_| IndexError::SessionNotFound(text))
}

/// What the model is told when the index answers nothing. A storage
/// failure is told as a fixed sentence: its causes name files on disk.
fn refusal(error: IndexError) -> ToolCallOutcome {
    let (reason, message) = match error {
        IndexError::SessionNotFound(session) => (
            "session_not_found",
            format!("Session \"{session}\" is not in this character's history."),
        ),
        IndexError::MessageNotFound { session, message } => (
            "message_not_found",
            format!("Message \"{message}\" is not in session \"{session}\"."),
        ),
        IndexError::Open(_) | IndexError::Database(_) | IndexError::History(_) => (
            "session_history_read_failed",
            "Session history storage reported a read failure.".to_owned(),
        ),
    };

    rejected(reason, message, "Rejected a session-history request.")
}

fn rejected(reason: &str, message: String, summary: &str) -> ToolCallOutcome {
    ToolCallOutcome::Rejected {
        reason: reason.to_owned(),
        message,
        evidence: vec![EvidenceNote::new(
            EvidenceKind::ToolInvocation,
            EvidenceStatus::Rejected,
            summary,
        )],
    }
}
