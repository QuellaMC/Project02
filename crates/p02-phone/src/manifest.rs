//! An app's manifest, which its script exports as `manifest`: what the app
//! is called, its version, how its icon is drawn and whether it wakes her,
//! the views it shows and the actions she can take in it.

use std::collections::BTreeSet;

use p02_contracts::ToolInputContract;
use p02_shared::Identifier;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::PackageError;

/// The format of a manifest the phone reads.
const FORMAT: &str = "project02.app.v1";

/// What the script's own exports are named, which no action is.
const RESERVED: [&str; 3] = ["manifest", "screen", "rang"];

/// An app's manifest, every rule of it checked.
#[derive(Clone, Debug)]
pub(crate) struct Manifest {
    pub(crate) id: Identifier,
    pub(crate) name: String,
    pub(crate) summary: String,
    pub(crate) version: String,
    pub(crate) icon: String,
    pub(crate) tint: String,
    pub(crate) wakes: bool,
    pub(crate) views: Vec<View>,
    pub(crate) opens_on: Identifier,
    pub(crate) actions: Vec<Action>,
}

/// A screen of an app she can open: a tab, in the Clock.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
    version: String,
    icon: String,
    tint: String,
    wakes: bool,
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
    /// The manifest `manifest`, the plain data a script exported, holds.
    pub(crate) fn read(manifest: Value) -> Result<Self, PackageError> {
        let authored: Authored =
            serde_json::from_value(manifest).map_err(PackageError::NotAManifest)?;

        if authored.format != FORMAT {
            return Err(PackageError::Format);
        }

        if !is_lowercase(&authored.id) {
            return Err(PackageError::IdCase);
        }

        not_blank("name", &authored.name)?;
        one_line("summary", &authored.summary)?;

        if numbers(&authored.version).is_none() {
            return Err(PackageError::Version);
        }

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
            version: authored.version,
            icon: authored.icon,
            tint: authored.tint,
            wakes: authored.wakes,
            views,
            opens_on,
            actions,
        })
    }
}

/// The three numbers of `version`, as `1.0.0` writes them with dots, each
/// written as the number it is; none for anything else. They order
/// versions as they are read: `1.10.0` is after `1.9.0`.
pub(crate) fn numbers(version: &str) -> Option<[u32; 3]> {
    let mut read = [0; 3];
    let mut written = version.split('.');

    for number in &mut read {
        let text = written.next()?;

        *number = text.parse().ok()?;

        if number.to_string() != text {
            return None;
        }
    }

    written.next().is_none().then_some(read)
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
    if is_blank(text) {
        Err(PackageError::Blank(field.to_owned()))
    } else {
        Ok(())
    }
}

/// Refuses `text`, what `field` of the manifest holds, unless it is one
/// line that is not blank.
fn one_line(field: &str, text: &str) -> Result<(), PackageError> {
    if is_one_line(text) {
        Ok(())
    } else {
        Err(PackageError::NotOneLine(field.to_owned()))
    }
}

pub(crate) fn is_blank(text: &str) -> bool {
    text.trim().is_empty()
}

/// Whether `text` is one line that is not blank.
pub(crate) fn is_one_line(text: &str) -> bool {
    !is_blank(text) && !text.contains(['\n', '\r'])
}

/// Whether `id` is in lowercase: an id names an app's files, and a volume
/// that folds case, the default on macOS and Windows, would give two ids
/// one file.
pub(crate) fn is_lowercase(id: &Identifier) -> bool {
    id.as_str() == id.collision_key()
}

/// `name` as an action is named: lowercase letters, digits and `_`,
/// beginning with a letter, and none of the script's own exports.
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
