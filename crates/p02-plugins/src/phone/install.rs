//! `phone.install`: she asks the person to install an app of the App Store
//! on her phone. Preparing the call changes nothing: the catalog is read
//! anew, her phone read under a lease, and the app's file fetched and
//! judged; the person is shown what would be installed, and on their yes
//! the text that was judged is installed, not fetched again.

use async_trait::async_trait;
use p02_contracts::{
    Confirmation, EvidenceKind, EvidenceNote, EvidenceStatus, HookContext, PluginError,
    PreparedEffect, ProvidedTool, ToolCall, ToolCallOutcome, ToolPreparation,
};
use p02_phone::{CatalogApp, CatalogError, Phone, PhoneError, Source};
use p02_shared::sentence;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::catalog::AppCatalog;
use super::{OPEN, STORE_UNAVAILABLE, listed, named, store};
use crate::package::{FilesError, admitted, blocking, leased, tool, unasked};

pub(super) const INSTALL: &str = "phone.install";

const DESCRIPTION: &str = "Ask to install an app of the App Store on your phone, by its id there. \
     The person is asked first; on their yes the app is on your phone, to open and use at once. \
     Open the App Store to see what there is.";

/// What a client shown the person the preparation reads it as.
const PREVIEW_KIND: &str = "phone_app_install";

const COMES_WITH_PHONE: &str = "comes_with_phone";
const NOT_IN_STORE: &str = "not_in_store";
const ALREADY_INSTALLED: &str = "already_installed";
const NOT_AS_LISTED: &str = "app_not_as_listed";

#[derive(Deserialize)]
struct Installing {
    app: String,
}

/// The tool, which runs alone, and acts only on the person's yes.
pub(super) fn tool_of() -> Result<ProvidedTool, PluginError> {
    Ok(tool(
        INSTALL,
        DESCRIPTION,
        json!({
            "type": "object",
            "properties": {
                "app": {"type": "string", "description": "The app's id in the App Store."},
            },
            "required": ["app"],
            "additionalProperties": false,
        }),
    )?
    .with_confirmation(Confirmation::Required))
}

/// Prepares the install `call` asks for on `phone`, reading the App Store
/// through `catalog`, or refuses it unasked.
pub(super) async fn prepare(
    phone: &'static Phone,
    catalog: &AppCatalog,
    call: &ToolCall,
    context: &HookContext,
) -> Result<ToolPreparation, PluginError> {
    let Installing { app: id } = admitted(call)?;

    if let Some(own) = phone.comes_with(&id) {
        let message = format!(
            "{} comes with your phone: there is nothing to install.",
            own.name()
        );

        return Ok(unasked(COMES_WITH_PHONE, message.clone(), &message));
    }

    let listing = match catalog.catalog().await {
        Ok(listing) => listing,
        Err(unread) => return Ok(refused(&unread)),
    };
    let Some(app) = listing.app(&id).cloned() else {
        let message = format!(
            "There is no app \"{id}\" in the App Store. {}",
            listed(
                "Its apps",
                listing.apps().iter().map(|app| named(app.name(), app.id()))
            )
        );

        return Ok(unasked(NOT_IN_STORE, message.clone(), &message));
    };
    let wanted = app.id().clone();
    let replaces = leased(store(context)?, move |files| {
        Ok(phone
            .apps(files)?
            .apps
            .into_iter()
            .find(|on_phone| on_phone.id == wanted)
            .map(|on_phone| on_phone.version))
    })
    .await?;

    if replaces.as_deref() == Some(app.version()) {
        let message = format!("{} {} is on your phone already.", app.name(), app.version());

        return Ok(unasked(ALREADY_INSTALLED, message.clone(), &message));
    }

    let text = match catalog.app(&app).await {
        Ok(text) => text,
        Err(unfetched) => return Ok(refused(&unfetched)),
    };
    let judged = {
        let (app, text) = (app.clone(), text.clone());

        blocking(move || phone.judge(&app, &text).map(drop)).await?
    };

    if let Err(refusal) = judged {
        return Ok(refused(&refusal));
    }

    Ok(ToolPreparation::Prepared {
        preview: preview(&app, replaces),
        evidence: vec![EvidenceNote::new(
            EvidenceKind::ToolInvocation,
            EvidenceStatus::Accepted,
            format!(
                "Prepared the install of \"{}\" {} from the App Store for approval.",
                app.id(),
                app.version()
            ),
        )],
        effect: Box::new(Install { phone, app, text }),
    })
}

/// What the person is shown: the app, where it comes from, and the version
/// it replaces on her phone, when there is one.
fn preview(app: &CatalogApp, replaces: Option<String>) -> Map<String, Value> {
    let mut preview = Map::from_iter([
        ("kind".to_owned(), Value::from(PREVIEW_KIND)),
        (
            "app".to_owned(),
            json!({
                "id": app.id(),
                "name": app.name(),
                "summary": app.summary(),
                "icon": app.icon(),
                "tint": app.tint(),
                "version": app.version(),
                "wakes": app.wakes(),
            }),
        ),
        ("source".to_owned(), json!(Source::Catalog)),
    ]);

    if let Some(version) = replaces {
        preview.insert("replaces".to_owned(), Value::from(version));
    }

    preview
}

/// An install the catalog, or the app's file, refused, in its sentence; how
/// a file is not the app listed goes to the record.
fn refused(refusal: &CatalogError) -> ToolPreparation {
    let message = sentence(&refusal.to_string());

    match refusal {
        CatalogError::NotTheApp { why, .. } => unasked(
            NOT_AS_LISTED,
            message.clone(),
            &format!("{message} {}", sentence(why)),
        ),
        _ => unasked(STORE_UNAVAILABLE, message.clone(), &message),
    }
}

/// An install the person approved: the text judged, as the catalog lists
/// it.
#[derive(Debug)]
struct Install {
    phone: &'static Phone,
    app: CatalogApp,
    text: String,
}

#[async_trait]
impl PreparedEffect for Install {
    async fn apply(self: Box<Self>, context: &HookContext) -> Result<ToolCallOutcome, PluginError> {
        let Self { phone, app, text } = *self;

        // The text was judged, so her phone refuses it no more than it did.
        leased(store(context)?, move |files| {
            match phone.install(files, &text, Source::Catalog) {
                Err(PhoneError::Store(error)) => Err(FilesError::Store(error)),
                installed => Ok(installed.map_err(|refusal| refusal.to_string())),
            }
        })
        .await?
        .map_err(PluginError::new)?;

        Ok(ToolCallOutcome::Accepted {
            output: json!({
                "status": "installed",
                "app": app.id(),
                "name": app.name(),
                "version": app.version(),
                "message": format!(
                    "{} is on your phone now: you can open it with {OPEN}.",
                    app.name()
                ),
            }),
            evidence: vec![EvidenceNote::new(
                EvidenceKind::ToolInvocation,
                EvidenceStatus::Accepted,
                format!(
                    "Installed \"{}\" {} from the App Store on her phone.",
                    app.id(),
                    app.version()
                ),
            )],
        })
    }
}
