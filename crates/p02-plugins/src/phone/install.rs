//! Installing an app of the App Store on her phone, by her ask or the
//! person's own hand, which take one path: the catalog is read anew, her
//! phone read under a lease, and the app's file fetched and judged, so that
//! what is installed is the text that was judged and nothing is fetched
//! again. `phone.install` is her ask: preparing it changes nothing, the
//! person is shown what would be installed, and their yes installs it.

use async_trait::async_trait;
use p02_contracts::{
    Confirmation, EvidenceKind, EvidenceNote, EvidenceStatus, HookContext, PluginError,
    PreparedEffect, ProvidedTool, StoreError, ToolCall, ToolCallOutcome, ToolPreparation,
};
use p02_phone::{Catalog, CatalogApp, CatalogError, Listed, OnPhone, Phone, PhoneError, Source};
use p02_shared::sentence;
use p02_wire::StoreAppStatus;
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

/// An app of the App Store that can be installed on her phone: as the
/// catalog lists it, the text of its one file, judged against that listing,
/// and the older version of it on her phone, which installing it updates.
#[derive(Debug)]
pub struct Installable {
    pub app: CatalogApp,
    pub text: String,
    pub replaces: Option<String>,
}

/// Why an app of the App Store cannot be installed on her phone, found
/// before anything is written and before anyone is asked.
#[derive(Debug)]
pub enum NotInstallable {
    /// The phone comes with an app of that id, by its name.
    ComesWithPhone(String),
    /// The App Store lists no app of that id: the catalog it read.
    NotInStore(Catalog),
    /// Her phone holds the app in the version the App Store lists or a
    /// newer one: as her phone lists it, boxed, since a listing is many
    /// times the size of the others.
    AlreadyInstalled(Box<Listed>),
    /// The catalog could not be read, or the app's file is not what it
    /// lists.
    Catalog(CatalogError),
}

#[derive(Deserialize)]
struct Installing {
    app: String,
}

/// Whether the App Store's app `id` can be installed on `phone`: the one
/// path her ask and the person's own hand both take. The catalog is read
/// anew through `catalog`, `on_phone` reads her phone under a lease of its
/// store once the catalog lists the app, which is installed only where her
/// phone holds no version of it as new, and its file is then fetched and
/// judged: no request is made under a lease, and nothing is written.
///
/// # Errors
///
/// [`PluginError`] when her phone could not be read, or the judging could
/// not run.
pub async fn installable(
    phone: &'static Phone,
    catalog: &AppCatalog,
    id: &str,
    on_phone: impl FnOnce() -> Result<OnPhone, StoreError> + Send + 'static,
) -> Result<Result<Installable, NotInstallable>, PluginError> {
    if let Some(own) = phone.comes_with(id) {
        return Ok(Err(NotInstallable::ComesWithPhone(own.name().to_owned())));
    }

    let listing = match catalog.catalog().await {
        Ok(listing) => listing,
        Err(unread) => return Ok(Err(NotInstallable::Catalog(unread))),
    };
    let Some(app) = listing.app(id).cloned() else {
        return Ok(Err(NotInstallable::NotInStore(listing)));
    };
    let on_phone = blocking(on_phone).await??;
    let replaces = match (app.status(&on_phone.apps), on_phone.app(id)) {
        (StoreAppStatus::Installed, Some(held)) => {
            return Ok(Err(NotInstallable::AlreadyInstalled(Box::new(
                held.clone(),
            ))));
        }
        (_, held) => held.map(|held| held.version.clone()),
    };

    let text = match catalog.app(&app).await {
        Ok(text) => text,
        Err(unfetched) => return Ok(Err(NotInstallable::Catalog(unfetched))),
    };
    let judged = {
        let (app, text) = (app.clone(), text.clone());

        blocking(move || phone.judge(&app, &text).map(drop)).await?
    };

    Ok(match judged {
        Ok(()) => Ok(Installable {
            app,
            text,
            replaces,
        }),
        Err(refusal) => Err(NotInstallable::Catalog(refusal)),
    })
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
    let store = store(context)?;
    let installable = installable(phone, catalog, &id, move || {
        store.with_lease(|files| phone.apps(files))
    })
    .await?;

    Ok(match installable {
        Ok(Installable {
            app,
            text,
            replaces,
        }) => ToolPreparation::Prepared {
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
        },
        Err(refusal) => refused(&id, &refusal),
    })
}

/// What the person is shown: the app, with what it asks of her phone that
/// the card says, whether it wakes her, whether it reaches the internet and
/// the name of the person's account it uses there, when it uses one; where
/// it comes from; and the version it replaces on her phone, when there is
/// one.
fn preview(app: &CatalogApp, replaces: Option<String>) -> Map<String, Value> {
    let asks = app.asks();
    let mut listed = json!({
        "id": app.id(),
        "name": app.name(),
        "summary": app.summary(),
        "icon": app.icon(),
        "tint": app.tint(),
        "version": app.version(),
        "wakes": asks.wakes(),
        "reachesInternet": !asks.reaches().is_empty(),
    });

    if let Some(account) = asks.account() {
        listed["account"] = Value::from(account.name());
    }

    let mut preview = Map::from_iter([
        ("kind".to_owned(), Value::from(PREVIEW_KIND)),
        ("app".to_owned(), listed),
        ("source".to_owned(), json!(Source::Catalog)),
    ]);

    if let Some(version) = replaces {
        preview.insert("replaces".to_owned(), Value::from(version));
    }

    preview
}

/// Her ask for the app `id` refused, said to her in a sentence and then,
/// where it helps her next step, what there is instead; how a file is not
/// the app listed goes to the record.
fn refused(id: &str, refusal: &NotInstallable) -> ToolPreparation {
    let (reason, message, record) = match refusal {
        NotInstallable::ComesWithPhone(name) => (
            COMES_WITH_PHONE,
            format!("{name} comes with your phone: there is nothing to install."),
            None,
        ),
        NotInstallable::NotInStore(listing) => (
            NOT_IN_STORE,
            format!(
                "There is no app \"{id}\" in the App Store. {}",
                listed(
                    "Its apps",
                    listing.apps().iter().map(|app| named(app.name(), app.id()))
                )
            ),
            None,
        ),
        NotInstallable::AlreadyInstalled(held) => (
            ALREADY_INSTALLED,
            format!("{} {} is on your phone already.", held.name, held.version),
            None,
        ),
        NotInstallable::Catalog(error @ CatalogError::NotTheApp { why, .. }) => (
            NOT_AS_LISTED,
            sentence(&error.to_string()),
            Some(sentence(why)),
        ),
        NotInstallable::Catalog(error) => (STORE_UNAVAILABLE, sentence(&error.to_string()), None),
    };
    let summary = match record {
        Some(how) => format!("{message} {how}"),
        None => message.clone(),
    };

    unasked(reason, message, &summary)
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
                installed => Ok(installed.map(drop).map_err(|refusal| refusal.to_string())),
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
