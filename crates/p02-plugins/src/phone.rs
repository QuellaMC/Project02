//! The phone package: her phone in her hands. Before each model call she
//! is told the apps on it, and her tools let her open an app, to see its
//! screen and what she can do in it, act in one, ask the person to sign an
//! app in with a connection of theirs, and, unless her settings say
//! otherwise, ask the person to install an app of the App Store. Her phone
//! is the apps it comes with, the App Store among them, and those
//! installed on it, which this plugin's store keeps with what each app
//! keeps, read and written under the lease of the hook that calls it. Her
//! opening the App Store reads its catalog anew, before the lease, and an
//! action that reaches the internet or asks a model has each of its
//! requests made, and each of its questions asked through the connection
//! its app is signed in with, between its runs, with no lease held, the
//! person's key sent with a request for an account of theirs.

mod catalog;
mod connections;
mod install;
mod internet;
mod sign_in;

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use p02_contracts::{
    BeforeRoleModelCallOutput, ContextItem, ContextItemKind, EvidenceKind, EvidenceNote,
    EvidenceStatus, FactoryInput, FileStore, HookContext, LeasedFiles, LeasedStore, PluginError,
    ProvidedTool, RuntimePlugin, StoreError, ToolCall, ToolCallOutcome, ToolPreparation,
};
use p02_core::SpeakerName;
use p02_phone::{
    Account, AccountKind, Acted, Acting, Action, Ask, Catalog, Exchange, Fetch, Fetched, Listed,
    Now, OnPhone, Opened, Phone, PhoneError, Question, STORE, SignedIn, View,
};
use p02_shared::{Identifier, error_chain, sentence};
use serde::Deserialize;
use serde_json::{Map, Value, json};

pub use self::catalog::AppCatalog;
pub use self::connections::{Connections, Unanswered};
pub use self::install::{Installable, NotInstallable, installable};
pub use self::internet::AppInternet;
use self::internet::{Key, REQUESTS};
use crate::host::Factory;
use crate::package::{FilesError, admitted, leased, rejected, tool};

/// The phone's plugin id, which names its store in her data.
pub const PHONE_PLUGIN: &str = "phone";

const OPEN: &str = "phone.open";
const USE: &str = "phone.use";

/// The field of her settings that offers her the tool to ask to install
/// an app.
const ASK_TO_INSTALL: &str = "askToInstall";

const STORE_UNAVAILABLE: &str = "store_unavailable";

const OPEN_DESCRIPTION: &str = "Open an app on your phone to see its screen, its views, and the \
     actions you can take in it, each with the input it takes.";
const USE_DESCRIPTION: &str = "Take one of an app's actions on your phone, with the input it \
     takes. You get back what it answered and the screen it shows after.";
const APP: &str = "The app's id, in quotes beside its name among your apps.";

/// The list's factory of the phone, which a host builds itself, handing it
/// the App Store's catalog, the internet her apps reach and the person's
/// connections they ask a model through: built anywhere else, it is
/// refused.
pub(crate) fn create(_input: &FactoryInput<'_>) -> Result<Arc<dyn RuntimePlugin>, PluginError> {
    Err(PluginError::new(format!(
        "{PHONE_PLUGIN} is built by the plugin host, which hands it the App Store's catalog, the \
         internet her apps reach and the person's connections they ask a model through"
    )))
}

/// How a host builds the phone: the phone every character has, with the
/// apps installed on hers, reading the App Store's catalog through
/// `catalog`, making her apps' requests through `internet` with the keys
/// the home's settings give, asking their questions through the person's
/// `connections`, and offering her the tool to ask to sign an app in, and
/// the tool to ask to install an app while her settings do.
pub(crate) fn factory(
    catalog: Arc<AppCatalog>,
    internet: Arc<AppInternet>,
    connections: Arc<dyn Connections>,
) -> Box<Factory> {
    Box::new(move |input: &FactoryInput<'_>| {
        let phone = Phone::bundled().map_err(|error| PluginError::new(error_chain(error)))?;
        let keys = keys(|field| input.config().value(field));
        let mut tools = vec![
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
            sign_in::tool_of()?,
        ];

        if input.config().value(ASK_TO_INSTALL) == Some(&Value::Bool(true)) {
            tools.push(install::tool_of()?);
        }

        Ok(Arc::new(PhonePlugin {
            phone,
            catalog: Arc::clone(&catalog),
            internet: Arc::clone(&internet),
            connections: Arc::clone(&connections),
            keys,
            tools,
        }) as Arc<dyn RuntimePlugin>)
    })
}

/// The field of the home's settings that holds the person's key for
/// `account`.
fn key_field(account: &Account) -> String {
    format!("{}ApiKey", account.id())
}

/// The person's key for each account of a key the phone's settings, which
/// `value_of` reads by field name, hold one for: its text, trimmed, when a
/// header can carry it.
fn keys<'v>(value_of: impl Fn(&str) -> Option<&'v Value>) -> Vec<(&'static Account, Key)> {
    Account::all()
        .iter()
        .filter(|account| matches!(account.kind(), AccountKind::Key { .. }))
        .filter_map(|account| {
            let text = value_of(&key_field(account))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())?;

            Some((account, Key::new(text)?))
        })
        .collect()
}

/// The accounts whose key the person gave her phone, among the phone's
/// settings `value_of` reads by field name, as her phone takes a key: what
/// a client is told of an account says what her phone then does.
#[must_use]
pub fn keyed_accounts<'v>(value_of: impl Fn(&str) -> Option<&'v Value>) -> Vec<&'static Account> {
    keys(value_of)
        .into_iter()
        .map(|(account, _)| account)
        .collect()
}

#[derive(Debug)]
struct PhonePlugin {
    phone: &'static Phone,
    catalog: Arc<AppCatalog>,
    internet: Arc<AppInternet>,
    connections: Arc<dyn Connections>,
    /// The person's key for each account they gave one for.
    keys: Vec<(&'static Account, Key)>,
    tools: Vec<ProvidedTool>,
}

/// What her phone answered a call: what she reads, and why what she has in
/// front could not be kept, when it could not. The call stands either way.
struct Answered {
    output: Value,
    unkept: Option<String>,
}

/// Where a call stands after a run on her phone: answered, or an action
/// asking for one more thing before it runs again.
enum Step {
    Answered(Answered),
    Asks(Asked),
}

/// What an action asks for, with what answering it takes: a request; or a
/// question, with the name of its app and how that app is signed in on her
/// phone, none while it is not.
enum Asked {
    Fetch(Fetch),
    Question {
        question: Question,
        app: String,
        signed_in: Option<SignedIn>,
    },
}

/// A call of one of the tools, its input as the tool's contract admits it.
#[derive(Clone)]
enum Request {
    Open(Opening),
    Use(Using),
}

#[derive(Clone, Deserialize)]
struct Opening {
    app: String,
    view: Option<String>,
}

#[derive(Clone, Deserialize)]
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

    /// Names her apps, as her phone lists them without running any, each
    /// that the person said may not wake her saying so; what of the lists
    /// her phone keeps does not read is passed over and said in the note's
    /// record.
    async fn before_role_model_call(
        &self,
        context: &HookContext,
    ) -> Result<BeforeRoleModelCallOutput, PluginError> {
        let phone = self.phone;
        let person = context.turn()?.person.clone();
        let on_phone = leased(store(context)?, move |files| Ok(phone.apps(files)?)).await?;
        let note = Identifier::new("apps")
            .map_err(|error| PluginError::with_source("the note of her apps needs an id", error))?;
        let apps: Vec<String> = on_phone
            .apps
            .iter()
            .map(|app| noted(app, &on_phone, person.as_ref()))
            .collect();
        let evidence = match on_phone.passed_over.as_slice() {
            [] => EvidenceNote::new(
                EvidenceKind::BeforeRoleModelCall,
                EvidenceStatus::Accepted,
                "Named the apps on her phone.",
            ),
            passed_over => EvidenceNote::new(
                EvidenceKind::BeforeRoleModelCall,
                EvidenceStatus::Degraded,
                passed_over
                    .iter()
                    .fold("Named the apps on her phone.".to_owned(), |said, why| {
                        format!("{said} {}", sentence(why))
                    }),
            ),
        };

        Ok(BeforeRoleModelCallOutput {
            context_items: vec![ContextItem::new(
                note,
                ContextItemKind::RuntimeNote,
                format!(
                    "On your phone: {}. Open an app with {OPEN} to see its screen and what you \
                     can do in it, then act in it with {USE}.",
                    apps.join("; ")
                ),
            )],
            curated_sections: Vec::new(),
            evidence: vec![evidence],
        })
    }

    /// Answers a call of her phone: a run of it under a lease of her
    /// phone's store, and, while an action asks for a request or a
    /// question, what it asks done with no lease held, every request of the
    /// call within one budget and each question within its own time, and
    /// the action run again at the same moment with what came of it.
    async fn handle_tool_call(
        &self,
        call: &ToolCall,
        context: &HookContext,
    ) -> Result<ToolCallOutcome, PluginError> {
        let request = Request::of(call)?;
        let read = match &request {
            Request::Open(Opening { app, .. }) if app == STORE => {
                match self.catalog.catalog().await {
                    Ok(catalog) => Some(catalog),
                    Err(unread) => {
                        let message = sentence(&unread.to_string());

                        return Ok(rejected(STORE_UNAVAILABLE, message.clone(), &message));
                    }
                }
            }
            _ => None,
        };
        let person = context.turn()?.person.clone();
        let (phone, summary, now) = (self.phone, request.summary(), Now::system());
        let mut requests = REQUESTS;
        let mut exchanges = Vec::new();
        let answered = loop {
            let (request, read, made, now) = (
                request.clone(),
                read.clone(),
                exchanges.clone(),
                now.clone(),
            );
            let ran = leased(store(context)?, move |files| {
                match request.answer(phone, files, read.as_ref(), &made, &now) {
                    Ok(step) => Ok(Ok(step)),
                    Err(PhoneError::Store(error)) => Err(FilesError::Store(error)),
                    Err(refusal) => Ok(Err(refused(phone, files, request.app(), &refusal))),
                }
            })
            .await?;

            match ran {
                Ok(Step::Answered(answered)) => break Ok(answered),
                Ok(Step::Asks(asked)) => {
                    exchanges.push(
                        self.exchange(asked, &mut requests, person.as_ref(), context)
                            .await,
                    );
                }
                Err(refused) => break Err(refused),
            }
        };

        Ok(match answered {
            Ok(Answered { output, unkept }) => ToolCallOutcome::Accepted {
                output,
                evidence: vec![match unkept {
                    None => EvidenceNote::new(
                        EvidenceKind::ToolInvocation,
                        EvidenceStatus::Accepted,
                        summary,
                    ),
                    Some(why) => EvidenceNote::new(
                        EvidenceKind::ToolInvocation,
                        EvidenceStatus::Degraded,
                        format!(
                            "{summary} What she has in front could not be kept: {}",
                            sentence(&why)
                        ),
                    ),
                }],
            },
            Err(refused) => refused,
        })
    }

    async fn prepare_tool_call(
        &self,
        call: &ToolCall,
        context: &HookContext,
    ) -> Result<ToolPreparation, PluginError> {
        match call.tool_name().as_str() {
            install::INSTALL => install::prepare(self.phone, &self.catalog, call, context).await,
            sign_in::SIGN_IN => {
                sign_in::prepare(self.phone, self.connections.as_ref(), call, context).await
            }
            other => Err(PluginError::new(format!(
                "the phone prepares no tool \"{other}\""
            ))),
        }
    }
}

impl PhonePlugin {
    /// What came of `asked`: a request made within `requests`, what is
    /// left of the time the call's requests share, which it takes its own
    /// from, as [`Self::fetched`] makes it; or a question asked through the
    /// person's connections until the call is cancelled, as
    /// [`connections::answered`] asks it. A sentence the app is told names
    /// `person` as her notes do.
    async fn exchange(
        &self,
        asked: Asked,
        requests: &mut Duration,
        person: Option<&SpeakerName>,
        context: &HookContext,
    ) -> Exchange {
        match asked {
            Asked::Fetch(fetch) => {
                let began = Instant::now();
                let fetched = self.fetched(&fetch, began + *requests, person).await;

                *requests = requests.saturating_sub(began.elapsed());
                Exchange::Fetch { fetch, fetched }
            }
            Asked::Question {
                question,
                app,
                signed_in,
            } => Exchange::Question {
                answer: connections::answered(
                    self.connections.as_ref(),
                    &question,
                    &app,
                    signed_in.as_ref(),
                    person,
                    context.cancellation(),
                )
                .await,
                question,
            },
        }
    }

    /// What came of `fetch`, made by `until`: with the person's key when it
    /// is for an account of theirs, and not made when they gave none for it,
    /// which is said naming `person` as her notes do.
    async fn fetched(
        &self,
        fetch: &Fetch,
        until: Instant,
        person: Option<&SpeakerName>,
    ) -> Result<Fetched, String> {
        let key = match fetch.account() {
            None => None,
            Some(account) => match self.keys.iter().find(|(keyed, _)| *keyed == account) {
                Some((_, key)) => Some(key),
                None => {
                    return Err(format!(
                        "This needs {} {} account, and its key is not in Settings yet.",
                        whose(person),
                        account.name()
                    ));
                }
            },
        };

        self.internet.fetch(fetch, key, until).await
    }
}

impl Request {
    fn of(call: &ToolCall) -> Result<Self, PluginError> {
        match call.tool_name().as_str() {
            OPEN => admitted(call).map(Self::Open),
            USE => admitted(call).map(Self::Use),
            other => Err(PluginError::new(format!(
                "the phone answers no tool \"{other}\" at once"
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

    /// What a run of the call on her phone comes to at `now`: her phone's
    /// answer, as she reads it, with why what she has in front could not be
    /// kept, when it could not; or, for an action, the one more thing it
    /// asks for after `exchanges`, a question with how its app is signed in
    /// on her phone. An open of the App Store keeps `read`, the catalog
    /// read for it, first.
    fn answer(
        &self,
        phone: &Phone,
        files: &mut LeasedStore<'_>,
        read: Option<&Catalog>,
        exchanges: &[Exchange],
        now: &Now,
    ) -> Result<Step, PhoneError> {
        let unkept = |unkept: Option<StoreError>| unkept.as_ref().map(|error| error_chain(error));

        match self {
            Self::Open(Opening { app, view }) => {
                if let Some(catalog) = read {
                    phone.keep_catalog(files, catalog)?;
                }

                phone.open(files, app, view.as_deref(), now).map(|opened| {
                    Step::Answered(Answered {
                        output: shown(&opened),
                        unkept: unkept(opened.unkept),
                    })
                })
            }
            Self::Use(Using { app, action, input }) => Ok(
                match phone.act(files, app, action, input, exchanges, now)? {
                    Acting::Acted(mut acted) => {
                        let unkept = unkept(acted.unkept.take());

                        Step::Answered(Answered {
                            output: used(acted),
                            unkept,
                        })
                    }
                    Acting::Asks(Ask::Fetch(fetch)) => Step::Asks(Asked::Fetch(fetch)),
                    Acting::Asks(Ask::Question(question)) => {
                        let on_phone = phone.apps(files)?;
                        let listed = on_phone.app(app);

                        Step::Asks(Asked::Question {
                            question,
                            app: listed.map_or_else(|| app.clone(), |listed| listed.name.clone()),
                            signed_in: listed
                                .and_then(|listed| on_phone.signed_in(listed))
                                .cloned(),
                        })
                    }
                },
            ),
        }
    }
}

fn store(context: &HookContext) -> Result<FileStore, PluginError> {
    context.character_file_store().cloned().ok_or_else(|| {
        PluginError::new("Phone needs the character file store its manifest requests")
    })
}

/// An app as she is told of it: by its name, and its id.
fn named(name: &str, id: &Identifier) -> String {
    format!("{name} (\"{id}\")")
}

/// The person as a sentence to her names them: by the name they go by,
/// as her notes do, or as them.
fn whom(person: Option<&SpeakerName>) -> &str {
    person.map_or("them", SpeakerName::as_str)
}

/// What is the person's, as a sentence to her says it: `Sam's`, or
/// `their`.
fn whose(person: Option<&SpeakerName>) -> String {
    person.map_or_else(
        || "their".to_owned(),
        |person| format!("{}'s", person.as_str()),
    )
}

/// `app`, on her phone as `on_phone` has it, as her note names it: by its
/// name and id, beside them that `person` said it may not wake her when
/// they did, since she would otherwise set a ring in it and trust it, and
/// the line she knows it by.
fn noted(app: &Listed, on_phone: &OnPhone, person: Option<&SpeakerName>) -> String {
    let id = &app.id;
    let named = if app.asks.wakes() && !on_phone.may_wake(app) {
        format!(
            "{} (\"{id}\", which {} said may not wake you)",
            app.name,
            person.map_or("they", SpeakerName::as_str)
        )
    } else {
        named(&app.name, id)
    };

    format!("{named} — {}", app.summary)
}

/// What she reads of an app she opened: which it is, the view it shows,
/// every view it has, every action with what it takes, and the screen.
fn shown(opened: &Opened) -> Value {
    let app = &opened.app;

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

/// A call her phone, as `files` keep it, refused, said in its own sentence
/// and then, where it helps her next step, what there is instead: her
/// apps, or the app's views or actions.
fn refused(
    phone: &Phone,
    files: &dyn LeasedFiles,
    app: &str,
    refusal: &PhoneError,
) -> ToolCallOutcome {
    let found = || phone.app(files, app).ok();
    let (reason, instead) = match refusal {
        PhoneError::NoApp(_) => (
            "app_not_found",
            phone.apps(files).ok().map(|on_phone| {
                listed(
                    "Your apps",
                    on_phone.apps.iter().map(|app| named(&app.name, &app.id)),
                )
            }),
        ),
        PhoneError::NoView { .. } => (
            "view_not_found",
            found().map(|app| listed("Its views", app.views().iter().map(View::id))),
        ),
        PhoneError::NoAction { .. } => (
            "action_not_found",
            found().map(|app| listed("Its actions", app.actions().iter().map(Action::name))),
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
    use p02_contracts::ConfigScope;

    use super::*;

    /// Her phone sends a key only from the field of its account, so each
    /// account of a key the phone knows has one, set for the whole home,
    /// never shown back, and never the model's to change.
    #[test]
    fn each_account_of_a_key_the_phone_knows_has_its_key_among_the_homes_secrets() {
        let (manifest, ..) = crate::list::plugins()
            .unwrap()
            .iter()
            .find(|(manifest, ..)| manifest.id().as_str() == PHONE_PLUGIN)
            .unwrap();

        for account in Account::all()
            .iter()
            .filter(|account| matches!(account.kind(), AccountKind::Key { .. }))
        {
            let field = manifest.config().field(&key_field(account)).unwrap();

            assert!(field.secret(), "{}", account.id());
            assert_eq!(
                field.scope(),
                Some(ConfigScope::GlobalOnly),
                "{}",
                account.id()
            );
            assert!(!field.agent_mutable(), "{}", account.id());
            assert_eq!(
                (field.label(), field.placeholder()),
                (Some("API Key"), Some("Paste key"))
            );
        }
    }

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
            unkept: None,
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
