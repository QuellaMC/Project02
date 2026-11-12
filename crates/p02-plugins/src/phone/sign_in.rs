//! Her ask to sign an app on her phone in with a connection of the
//! person's: `phone.sign_in`. Preparing it changes nothing: the person is
//! shown the app and the connection it would sign in with, the first of
//! theirs connected now in the AI Model page's order, and their yes signs
//! it in with that one, asking the model it starts with. An app her phone
//! lacks, one that signs in to nothing, one signed in already, and one with
//! none of the person's connections connected are refused unasked.

use async_trait::async_trait;
use p02_contracts::{
    Confirmation, EvidenceKind, EvidenceNote, EvidenceStatus, HookContext, PluginError,
    PreparedEffect, ProvidedTool, ToolCall, ToolCallOutcome, ToolPreparation,
};
use p02_phone::{Listed, OnPhone, Phone, PhoneError, SignedIn};
use p02_shared::{Identifier, sentence};
use p02_wire::AppConnection;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::connections::Connections;
use super::{APP, USE, listed, named, store, whose};
use crate::package::{FilesError, admitted, blocking, leased, tool, unasked};

pub(super) const SIGN_IN: &str = "phone.sign_in";

/// What her model reads of the tool, and what the person's card falls back
/// on where a surface has no words of its own for it.
const DESCRIPTION: &str = "Sign in to an app on your phone with one of the person's AI \
                           connections.";

/// What a client shown the person the preparation reads it as.
const PREVIEW_KIND: &str = "phone_app_sign_in";

const APP_NOT_FOUND: &str = "app_not_found";
const SIGNS_IN_TO_NOTHING: &str = "signs_in_to_nothing";
const ALREADY_SIGNED_IN: &str = "already_signed_in";
const NOT_CONNECTED: &str = "not_connected";

#[derive(Deserialize)]
struct SigningIn {
    app: String,
}

/// The tool, which runs alone, and acts only on the person's yes.
pub(super) fn tool_of() -> Result<ProvidedTool, PluginError> {
    Ok(tool(
        SIGN_IN,
        DESCRIPTION,
        json!({
            "type": "object",
            "properties": {"app": {"type": "string", "description": APP}},
            "required": ["app"],
            "additionalProperties": false,
        }),
    )?
    .with_confirmation(Confirmation::Required))
}

/// Prepares the sign-in `call` asks for on `phone`, with the first of the
/// person's `connections` connected now, or refuses it unasked.
pub(super) async fn prepare(
    phone: &'static Phone,
    connections: &dyn Connections,
    call: &ToolCall,
    context: &HookContext,
) -> Result<ToolPreparation, PluginError> {
    let SigningIn { app: id } = admitted(call)?;
    let person = context.turn()?.person.clone();
    let store = store(context)?;
    let on_phone = blocking(move || store.with_lease(|files| phone.apps(files))).await??;
    let (app, account) = match on_phone.signing_in(&id) {
        Ok(found) => found,
        Err(refusal) => return Ok(refused(&on_phone, &refusal)),
    };

    if on_phone.signed_in(app).is_some() {
        let message = format!("{} is signed in already.", app.name);

        return Ok(unasked(ALREADY_SIGNED_IN, message.clone(), &message));
    }

    let Some(connection) = connections.connected(account).await.into_iter().next() else {
        let message = format!(
            "This needs {} ChatGPT plan or OpenAI API key, connected under AI Model in Settings.",
            whose(person.as_ref())
        );

        return Ok(unasked(NOT_CONNECTED, message.clone(), &message));
    };

    Ok(ToolPreparation::Prepared {
        preview: preview(app, &connection),
        evidence: vec![EvidenceNote::new(
            EvidenceKind::ToolInvocation,
            EvidenceStatus::Accepted,
            format!(
                "Prepared signing \"{}\" in with \"{}\" for approval.",
                app.id, connection.id
            ),
        )],
        effect: Box::new(SignIn {
            phone,
            app: app.id.clone(),
            name: app.name.clone(),
            connection,
        }),
    })
}

/// What the person is shown: the app, and the connection of theirs it
/// would sign in with.
fn preview(app: &Listed, connection: &AppConnection) -> Map<String, Value> {
    Map::from_iter([
        ("kind".to_owned(), Value::from(PREVIEW_KIND)),
        (
            "app".to_owned(),
            json!({"id": app.id, "name": app.name, "icon": app.icon, "tint": app.tint}),
        ),
        (
            "connection".to_owned(),
            json!({"id": connection.id, "name": connection.name}),
        ),
    ])
}

/// Her ask refused before anyone was asked, said to her in her phone's
/// sentence and, for an app not on it, with her apps.
fn refused(on_phone: &OnPhone, refusal: &PhoneError) -> ToolPreparation {
    let (reason, message) = match refusal {
        PhoneError::NoApp(_) => (
            APP_NOT_FOUND,
            format!(
                "{} {}",
                sentence(&refusal.to_string()),
                listed(
                    "Your apps",
                    on_phone.apps.iter().map(|app| named(&app.name, &app.id))
                )
            ),
        ),
        _ => (SIGNS_IN_TO_NOTHING, sentence(&refusal.to_string())),
    };

    unasked(reason, message.clone(), &message)
}

/// A sign-in the person approved: the app, by its id and name, and the
/// connection it signs in with.
#[derive(Debug)]
struct SignIn {
    phone: &'static Phone,
    app: Identifier,
    name: String,
    connection: AppConnection,
}

#[async_trait]
impl PreparedEffect for SignIn {
    async fn apply(self: Box<Self>, context: &HookContext) -> Result<ToolCallOutcome, PluginError> {
        let Self {
            phone,
            app,
            name,
            connection,
        } = *self;
        let person = context.turn()?.person.clone();
        let signed_in = SignedIn {
            connection: Identifier::new(connection.id.as_str())
                .expect("a service's id is an identifier"),
            model: None,
        };
        let id = app.clone();

        leased(store(context)?, move |files| {
            match phone.sign_in(files, id.as_str(), Some(signed_in)) {
                Err(PhoneError::Store(error)) => Err(FilesError::Store(error)),
                signed => Ok(signed.map_err(|refusal| sentence(&refusal.to_string()))),
            }
        })
        .await?
        .map_err(PluginError::new)?;

        Ok(ToolCallOutcome::Accepted {
            output: json!({
                "status": "signed_in",
                "app": app,
                "name": name,
                "connection": connection.name,
                "message": format!(
                    "{name} is signed in with {} {} now: use it with {USE}.",
                    whose(person.as_ref()),
                    connection.name
                ),
            }),
            evidence: vec![EvidenceNote::new(
                EvidenceKind::ToolInvocation,
                EvidenceStatus::Accepted,
                format!(
                    "Signed \"{app}\" in with \"{}\" on her phone.",
                    connection.id
                ),
            )],
        })
    }
}
