//! `app.json`: what an app is called and how its icon is drawn, the views
//! it shows and the actions she can take in it.

use std::collections::BTreeSet;

use p02_contracts::ToolInputContract;
use p02_shared::Identifier;
use serde::Deserialize;
use serde_json::Value;

use crate::error::PackageError;

/// The format of `app.json` the phone reads.
const FORMAT: &str = "project02.app.v1";

/// What the script's own functions are named, which no action is.
const RESERVED: [&str; 2] = ["screen", "rang"];

/// An app's manifest, every rule of it checked.
#[derive(Clone, Debug)]
pub(crate) struct Manifest {
    pub(crate) id: Identifier,
    pub(crate) name: String,
    pub(crate) summary: String,
    pub(crate) icon: String,
    pub(crate) tint: String,
    pub(crate) views: Vec<View>,
    pub(crate) opens_on: Identifier,
    pub(crate) actions: Vec<Action>,
}

/// A screen of an app she can open: a tab, in the Clock.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct View {
    id: Identifier,
    title: String,
    icon: String,
}

/// Something she can do in an app: the script's function of that name,
/// called on input its contract admits.
#[derive(Clone, Debug)]
pub struct Action {
    name: Identifier,
    description: String,
    did: String,
    view: Identifier,
    input: ToolInputContract,
}

/// The manifest as its author writes it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Authored {
    format: String,
    id: Identifier,
    name: String,
    summary: String,
    icon: String,
    tint: String,
    views: Vec<AuthoredView>,
    opens_on: String,
    actions: Vec<AuthoredAction>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthoredView {
    id: Identifier,
    title: String,
    icon: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthoredAction {
    name: String,
    description: String,
    did: String,
    view: String,
    input: Value,
}

impl View {
    #[must_use]
    pub fn id(&self) -> &Identifier {
        &self.id
    }

    #[must_use]
    pub fn title(&self) -> &str {
        &self.title
    }

    /// A name of the page's own icons, which falls back for one it does
    /// not know.
    #[must_use]
    pub fn icon(&self) -> &str {
        &self.icon
    }
}

impl Action {
    #[must_use]
    pub fn name(&self) -> &Identifier {
        &self.name
    }

    #[must_use]
    pub fn description(&self) -> &str {
        &self.description
    }

    /// What her window says she did, a few words in the past tense: `Set
    /// an alarm`.
    #[must_use]
    pub fn did(&self) -> &str {
        &self.did
    }

    /// The view the phone shows after the action.
    #[must_use]
    pub fn view(&self) -> &Identifier {
        &self.view
    }

    #[must_use]
    pub fn input(&self) -> &ToolInputContract {
        &self.input
    }
}

impl Manifest {
    /// The manifest `text` holds.
    pub(crate) fn read(text: &str) -> Result<Self, PackageError> {
        let authored: Authored = serde_json::from_str(text).map_err(PackageError::NotAManifest)?;

        if authored.format != FORMAT {
            return Err(PackageError::Format);
        }

        not_blank("name", &authored.name)?;
        one_line("summary", &authored.summary)?;
        not_blank("icon", &authored.icon)?;
        not_blank("tint", &authored.tint)?;

        let views = views(authored.views)?;
        let opens_on = view_named(&views, &authored.opens_on)
            .ok_or(PackageError::OpensOn(authored.opens_on))?;
        let actions = actions(authored.actions, &views)?;

        Ok(Self {
            id: authored.id,
            name: authored.name,
            summary: authored.summary,
            icon: authored.icon,
            tint: authored.tint,
            views,
            opens_on,
            actions,
        })
    }
}

fn views(authored: Vec<AuthoredView>) -> Result<Vec<View>, PackageError> {
    if authored.is_empty() {
        return Err(PackageError::NoViews);
    }

    let mut seen = BTreeSet::new();

    authored
        .into_iter()
        .map(|view| {
            if !seen.insert(view.id.clone()) {
                return Err(PackageError::DuplicateView(view.id));
            }

            not_blank(&format!("view \"{}\" icon", view.id), &view.icon)?;
            Ok(View {
                id: view.id,
                title: view.title,
                icon: view.icon,
            })
        })
        .collect()
}

fn actions(authored: Vec<AuthoredAction>, views: &[View]) -> Result<Vec<Action>, PackageError> {
    let mut seen = BTreeSet::new();

    authored
        .into_iter()
        .map(|action| {
            let name = action_name(&action.name)
                .ok_or_else(|| PackageError::ActionName(action.name.clone()))?;

            if !seen.insert(name.clone()) {
                return Err(PackageError::DuplicateAction(action.name));
            }

            one_line(&format!("action \"{}\" did", action.name), &action.did)?;

            let view = view_named(views, &action.view).ok_or_else(|| PackageError::ActionView {
                action: action.name.clone(),
                view: action.view,
            })?;
            let input = ToolInputContract::new(action.input).map_err(|problem| {
                PackageError::ActionInput {
                    action: action.name,
                    problem,
                }
            })?;

            Ok(Action {
                name,
                description: action.description,
                did: action.did,
                view,
                input,
            })
        })
        .collect()
}

/// Refuses `text`, what `field` of the manifest holds, when it is blank.
fn not_blank(field: &str, text: &str) -> Result<(), PackageError> {
    if text.trim().is_empty() {
        Err(PackageError::Blank(field.to_owned()))
    } else {
        Ok(())
    }
}

/// Refuses `text`, what `field` of the manifest holds, unless it is one
/// line that is not blank.
fn one_line(field: &str, text: &str) -> Result<(), PackageError> {
    if text.trim().is_empty() || text.contains(['\n', '\r']) {
        Err(PackageError::NotOneLine(field.to_owned()))
    } else {
        Ok(())
    }
}

/// `name` as an action is named: lowercase letters, digits and `_`,
/// beginning with a letter, and none of the script's own functions.
fn action_name(name: &str) -> Option<Identifier> {
    let mut bytes = name.bytes();
    let spelled = bytes.next().is_some_and(|byte| byte.is_ascii_lowercase())
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_');

    if spelled && !RESERVED.contains(&name) {
        Identifier::new(name).ok()
    } else {
        None
    }
}

fn view_named(views: &[View], id: &str) -> Option<Identifier> {
    views
        .iter()
        .find(|view| view.id.as_str() == id)
        .map(|view| view.id.clone())
}
