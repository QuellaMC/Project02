//! The phone package: her phone in her hands. Before each model call she
//! is told the apps on it, and two tools let her open an app, to see its
//! screen and what she can do in it, and act in one. Her phone is the one
//! every character has, and keeps each app's one file in this plugin's
//! store, under the lease of the hook that calls it.

use std::sync::Arc;

use async_trait::async_trait;
use p02_contracts::{
    BeforeRoleModelCallOutput, ContextItem, ContextItemKind, EvidenceKind, EvidenceNote,
    EvidenceStatus, FactoryInput, FileStore, HookContext, LeasedStore, PluginError, ProvidedTool,
    RuntimePlugin, ToolCall, ToolCallOutcome,
};
use p02_phone::{Acted, Action, App, Now, Opened, Phone, PhoneError, View};
use p02_shared::{Identifier, error_chain, sentence};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::package::{FilesError, leased, rejected, tool};

/// The phone's plugin id, which names its store in her data.
pub const PHONE_PLUGIN: &str = "phone";

const OPEN: &str = "phone.open";
const USE: &str = "phone.use";

const OPEN_DESCRIPTION: &str = "Open an app on your phone to see its screen, its views, and the \
     actions you can take in it, each with the input it takes.";
const USE_DESCRIPTION: &str = "Take one of an app's actions on your phone, with the input it \
     takes. You get back what it answered and the screen it shows after.";
const APP: &str = "The app's id, in quotes beside its name among your apps.";

/// The package's factory: it reads no config, and hands her the phone
/// every character has.
pub(crate) fn create(_input: &FactoryInput<'_>) -> Result<Arc<dyn RuntimePlugin>, PluginError> {
    let phone = Phone::bundled().map_err(|error| PluginError::new(error_chain(error)))?;
    let apps: Vec<String> = phone
        .apps()
        .iter()
        .map(|app| format!("{} — {}", named(app), app.summary()))
        .collect();

    Ok(Arc::new(PhonePlugin {
        phone,
        tools: vec![
            tool(
                OPEN,
                OPEN_DESCRIPTION,
                json!({
                    "type": "object",
                    "properties": {
                        "app": {"type": "string", "description": APP},
                        "view": {
                            "type": "string",
                            "description": "One of the app's views to open it on; without \
                                            one, it opens where it always does.",
                        },
                    },
                    "required": ["app"],
                    "additionalProperties": false,
                }),
            )?,
            tool(
                USE,
                USE_DESCRIPTION,
                json!({
                    "type": "object",
                    "properties": {
                        "app": {"type": "string", "description": APP},
                        "action": {
                            "type": "string",
                            "description": "The action's name, as opening the app shows it.",
                        },
                        "input": {
                            "type": "object",
                            "description": "What the action takes, as opening the app shows \
                                            its input; left out, it is given nothing.",
                        },
                    },
                    "required": ["app", "action"],
                    "additionalProperties": false,
                }),
            )?,
        ],
        note: format!(
            "On your phone: {}. Open an app with {OPEN} to see its screen and what you can do \
             in it, then act in it with {USE}.",
            apps.join("; ")
        ),
    }))
}

#[derive(Debug)]
struct PhonePlugin {
    phone: &'static Phone,
    tools: Vec<ProvidedTool>,
    /// What she is told of her apps before every model call.
    note: String,
}

/// A call of one of the tools, its input as the tool's contract admits it.
enum Request {
    Open(Opening),
    Use(Using),
}

#[derive(Deserialize)]
struct Opening {
    app: String,
    view: Option<String>,
}

#[derive(Deserialize)]
struct Using {
    app: String,
    action: String,
    #[serde(default)]
    input: Map<String, Value>,
}

#[async_trait]
impl RuntimePlugin for PhonePlugin {
    fn provided_tools(&self) -> &[ProvidedTool] {
        &self.tools
    }

    async fn before_role_model_call(
        &self,
        _context: &HookContext,
    ) -> Result<BeforeRoleModelCallOutput, PluginError> {
        let apps = Identifier::new("apps")
            .map_err(|error| PluginError::with_source("the note of her apps needs an id", error))?;

        Ok(BeforeRoleModelCallOutput {
            context_items: vec![ContextItem::new(
                apps,
                ContextItemKind::RuntimeNote,
                self.note.clone(),
            )],
            curated_sections: Vec::new(),
            evidence: vec![EvidenceNote::new(
                EvidenceKind::BeforeRoleModelCall,
                EvidenceStatus::Accepted,
                "Named the apps on her phone.",
            )],
        })
    }

    async fn handle_tool_call(
        &self,
        call: &ToolCall,
        context: &HookContext,
    ) -> Result<ToolCallOutcome, PluginError> {
        let request = Request::of(call)?;
        let (phone, app, summary) = (self.phone, request.app().to_owned(), request.summary());
        let answered = leased(store(context)?, move |files| {
            match request.answer(phone, files) {
                Err(PhoneError::Store(error)) => Err(FilesError::Store(error)),
                answered => Ok(answered),
            }
        })
        .await?;

        Ok(match answered {
            Ok(output) => ToolCallOutcome::Accepted {
                output,
                evidence: vec![EvidenceNote::new(
                    EvidenceKind::ToolInvocation,
                    EvidenceStatus::Accepted,
                    summary,
                )],
            },
            Err(refusal) => refused(phone, &app, &refusal),
        })
    }
}

impl Request {
    fn of(call: &ToolCall) -> Result<Self, PluginError> {
        let input = Value::Object(call.input().clone());
        let unread = |error: serde_json::Error| {
            PluginError::with_source(
                format!("{} input is not what its contract admits", call.tool_name()),
                error,
            )
        };

        match call.tool_name().as_str() {
            OPEN => serde_json::from_value(input)
                .map(Self::Open)
                .map_err(unread),
            USE => serde_json::from_value(input).map(Self::Use).map_err(unread),
            other => Err(PluginError::new(format!(
                "the phone provides no tool \"{other}\""
            ))),
        }
    }

    fn app(&self) -> &str {
        match self {
            Self::Open(opening) => &opening.app,
            Self::Use(using) => &using.app,
        }
    }

    /// The record of the call, once her phone answered it.
    fn summary(&self) -> String {
        match self {
            Self::Open(Opening { app, .. }) => format!("Opened \"{app}\" on her phone."),
            Self::Use(Using { app, action, .. }) => {
                format!("Took \"{action}\" in \"{app}\" on her phone.")
            }
        }
    }

    /// What her phone answers the call now, as she reads it.
    fn answer(&self, phone: &Phone, files: &mut LeasedStore<'_>) -> Result<Value, PhoneError> {
        let now = Now::system();

        match self {
            Self::Open(Opening { app, view }) => phone
                .open(files, app, view.as_deref(), &now)
                .map(|opened| shown(&opened)),
            Self::Use(Using { app, action, input }) => {
                phone.act(files, app, action, input, &now).map(used)
            }
        }
    }
}

fn store(context: &HookContext) -> Result<FileStore, PluginError> {
    context.character_file_store().cloned().ok_or_else(|| {
        PluginError::new("Phone needs the character file store its manifest requests")
    })
}

/// An app as she is told of it: by its name, and the id she opens it by.
fn named(app: &App) -> String {
    format!("{} (\"{}\")", app.name(), app.id())
}

/// What she reads of an app she opened: which it is, the view it shows,
/// every view it has, every action with what it takes, and the screen.
fn shown(opened: &Opened<'_>) -> Value {
    let app = opened.app;

    json!({
        "app": app.id(),
        "name": app.name(),
        "view": opened.view,
        "views": app
            .views()
            .iter()
            .map(|view| json!({"id": view.id(), "title": view.title()}))
            .collect::<Vec<_>>(),
        "actions": app
            .actions()
            .iter()
            .map(|action| {
                json!({
                    "name": action.name(),
                    "description": action.description(),
                    "input": action.input().schema(),
                })
            })
            .collect::<Vec<_>>(),
        "screen": opened.screen,
    })
}

/// What she reads of an action she took: its answer, the view her phone
/// shows after it, and that view's screen, or, since the action stands
/// either way, the sentence saying it could not be shown in its place.
fn used(acted: Acted) -> Value {
    let screen = match acted.screen {
        Ok(screen) => json!(screen),
        Err(failure) => json!(sentence(&format!(
            "the screen could not be shown: {failure}"
        ))),
    };

    json!({"answer": acted.answer, "view": acted.view, "screen": screen})
}

/// A call her phone refused, said in its own sentence and then, where it
/// helps her next step, what there is instead: her apps, or the app's
/// views or actions.
fn refused(phone: &Phone, app: &str, refusal: &PhoneError) -> ToolCallOutcome {
    let found = phone.app(app).ok();
    let (reason, instead) = match refusal {
        PhoneError::NoApp(_) => (
            "app_not_found",
            Some(listed("Your apps", phone.apps().iter().map(named))),
        ),
        PhoneError::NoView { .. } => (
            "view_not_found",
            found.map(|app| listed("Its views", app.views().iter().map(View::id))),
        ),
        PhoneError::NoAction { .. } => (
            "action_not_found",
            found.map(|app| listed("Its actions", app.actions().iter().map(Action::name))),
        ),
        PhoneError::Input { .. } => ("invalid_input", None),
        PhoneError::Refused { .. } => ("app_refused", None),
        _ => ("app_failed", None),
    };
    let message = std::iter::once(sentence(&refusal.to_string()))
        .chain(instead)
        .collect::<Vec<_>>()
        .join(" ");

    rejected(reason, message.clone(), &message)
}

/// What there is of `what`, by name: `Its views: world, alarms.`
fn listed(what: &str, names: impl Iterator<Item = impl ToString>) -> String {
    let names: Vec<String> = names.map(|name| name.to_string()).collect();

    if names.is_empty() {
        format!("{what}: none.")
    } else {
        format!("{what}: {}.", names.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// No client can make the Clock's screen fail, so the action that
    /// stands without its screen is pinned here: she reads its answer, and
    /// the sentence where the screen would be.
    #[test]
    fn an_action_stands_when_its_screen_cannot_be_shown() {
        let acted = Acted {
            answer: json!({"id": "a1", "time": "7:00 AM"}),
            view: Identifier::new("alarms").unwrap(),
            screen: Err(PhoneError::TookTooLong {
                app: "Clock".to_owned(),
            }),
        };

        assert_eq!(
            used(acted),
            json!({
                "answer": {"id": "a1", "time": "7:00 AM"},
                "view": "alarms",
                "screen": "The screen could not be shown: Clock took too long and was stopped.",
            })
        );
    }
}
