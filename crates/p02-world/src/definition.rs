//! What a character's package says of the world she comes from: the value
//! of her descriptor's `world`.

use p02_core::SpeakerName;
use p02_shared::Identifier;
use serde_json::{Map, Value};

/// The most places a world a package brings has, and the most things each
/// of its places holds.
const MOST_PLACES: usize = 32;
const MOST_THINGS: usize = 32;

/// The world a character's package says she comes from: its id, which
/// names its folder in the home, its name, and its places in order, the
/// first where a character who comes to live there is at first.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorldDefinition {
    id: Identifier,
    pub(crate) name: SpeakerName,
    pub(crate) places: Vec<PlaceDefinition>,
}

/// A place of a world a package brings: its id, its name, the icon and the
/// tint it is drawn with when the package names them, and the things in it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PlaceDefinition {
    pub(crate) id: Identifier,
    pub(crate) name: SpeakerName,
    pub(crate) icon: Option<String>,
    pub(crate) tint: Option<String>,
    pub(crate) things: Vec<ThingDefinition>,
}

/// A thing in a place of a world a package brings: its name, and the icon
/// and the tint it is drawn with when the package names them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ThingDefinition {
    pub(crate) name: SpeakerName,
    pub(crate) icon: Option<String>,
    pub(crate) tint: Option<String>,
}

/// The first rule a package's world breaks, in the order they are checked,
/// naming its place in the world.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum WorldDefinitionError {
    #[error("world must be an object")]
    NotAnObject,
    #[error(
        "world.id must be an identifier in lowercase: a letter, then letters, numbers, dots, \
         underscores or hyphens, 128 at most"
    )]
    InvalidId,
    #[error("world.name must be one line of 1 to 128 characters with no blank space at either end")]
    InvalidName,
    #[error("world.places must be an array of 1 to {MOST_PLACES} places")]
    InvalidPlaces,
    #[error("world.places[{0}] must be an object")]
    PlaceNotAnObject(usize),
    #[error("world.places[{0}].id must be an identifier in lowercase")]
    InvalidPlaceId(usize),
    #[error("world.places[{place}].id \"{id}\" is an earlier place's id too")]
    PlaceIdTaken { place: usize, id: Identifier },
    #[error(
        "world.places[{0}].name must be one line of 1 to 128 characters with no blank space at \
         either end"
    )]
    InvalidPlaceName(usize),
    #[error("world.places[{place}].{key} must be a name that is not blank")]
    InvalidPlaceLook { place: usize, key: &'static str },
    #[error("world.places[{0}].things must be an array of {MOST_THINGS} things at most")]
    InvalidThings(usize),
    #[error("world.places[{place}].things[{thing}] must be an object")]
    ThingNotAnObject { place: usize, thing: usize },
    #[error(
        "world.places[{place}].things[{thing}].name must be one line of 1 to 128 characters with \
         no blank space at either end"
    )]
    InvalidThingName { place: usize, thing: usize },
    #[error("world.places[{place}].things[{thing}].{key} must be a name that is not blank")]
    InvalidThingLook {
        place: usize,
        thing: usize,
        key: &'static str,
    },
}

impl WorldDefinitionError {
    /// The rule broken, in plain words, for a person who chose the file
    /// rather than wrote it.
    #[must_use]
    pub fn plainly(&self) -> &'static str {
        match self {
            Self::NotAnObject => {
                "This file gives the character's world in a way the app cannot read."
            }
            Self::InvalidId => {
                "This file does not give the character's world an id the app can use."
            }
            Self::InvalidName => "This file does not give the character's world a one-line name.",
            Self::InvalidPlaces => {
                "The character's world in this file does not have from 1 to 32 places."
            }
            Self::PlaceNotAnObject(_) => {
                "This file gives a place of the character's world in a way the app cannot read."
            }
            Self::InvalidPlaceId(_) => {
                "This file does not give a place of the character's world an id the app can use."
            }
            Self::PlaceIdTaken { .. } => {
                "This file gives two places of the character's world the same id."
            }
            Self::InvalidPlaceName(_) => {
                "This file does not give a place of the character's world a one-line name."
            }
            Self::InvalidPlaceLook { .. } => {
                "This file gives a place of the character's world a blank icon or tint."
            }
            Self::InvalidThings(_) => {
                "This file gives a place of the character's world more than 32 things, or lists \
                 them in a way the app cannot read."
            }
            Self::ThingNotAnObject { .. } => {
                "This file gives a thing in the character's world in a way the app cannot read."
            }
            Self::InvalidThingName { .. } => {
                "This file does not give a thing in the character's world a one-line name."
            }
            Self::InvalidThingLook { .. } => {
                "This file gives a thing in the character's world a blank icon or tint."
            }
        }
    }
}

impl WorldDefinition {
    /// Reads `value`, a descriptor's `world`. What it holds that a world
    /// does not know is not read.
    ///
    /// # Errors
    ///
    /// [`WorldDefinitionError`] naming the first rule `value` breaks.
    pub fn from_value(value: &Value) -> Result<Self, WorldDefinitionError> {
        let world = value.as_object().ok_or(WorldDefinitionError::NotAnObject)?;
        let id = lowercase_id(world.get("id")).ok_or(WorldDefinitionError::InvalidId)?;
        let name = one_line(world.get("name")).ok_or(WorldDefinitionError::InvalidName)?;
        let entries = world
            .get("places")
            .and_then(Value::as_array)
            .filter(|places| (1..=MOST_PLACES).contains(&places.len()))
            .ok_or(WorldDefinitionError::InvalidPlaces)?;
        let mut places: Vec<PlaceDefinition> = Vec::with_capacity(entries.len());

        for (index, entry) in entries.iter().enumerate() {
            let place = PlaceDefinition::read(index, entry, &places)?;

            places.push(place);
        }

        Ok(Self { id, name, places })
    }

    /// Its id, which names its folder in the home.
    #[must_use]
    pub fn id(&self) -> &Identifier {
        &self.id
    }
}

impl PlaceDefinition {
    /// The place `entry` gives, the world's place `index`, after `earlier`.
    fn read(index: usize, entry: &Value, earlier: &[Self]) -> Result<Self, WorldDefinitionError> {
        let place = entry
            .as_object()
            .ok_or(WorldDefinitionError::PlaceNotAnObject(index))?;
        let id =
            lowercase_id(place.get("id")).ok_or(WorldDefinitionError::InvalidPlaceId(index))?;

        if earlier.iter().any(|other| other.id == id) {
            return Err(WorldDefinitionError::PlaceIdTaken { place: index, id });
        }

        let name =
            one_line(place.get("name")).ok_or(WorldDefinitionError::InvalidPlaceName(index))?;
        let looked = |key| {
            look(place, key)
                .map_err(|key| WorldDefinitionError::InvalidPlaceLook { place: index, key })
        };
        let (icon, tint) = (looked("icon")?, looked("tint")?);
        let things = match place.get("things") {
            None => Vec::new(),
            Some(things) => things
                .as_array()
                .filter(|things| things.len() <= MOST_THINGS)
                .ok_or(WorldDefinitionError::InvalidThings(index))?
                .iter()
                .enumerate()
                .map(|(thing, entry)| ThingDefinition::read(index, thing, entry))
                .collect::<Result<_, _>>()?,
        };

        Ok(Self {
            id,
            name,
            icon,
            tint,
            things,
        })
    }
}

impl ThingDefinition {
    /// The thing `entry` gives, thing `thing` of place `place`.
    fn read(place: usize, thing: usize, entry: &Value) -> Result<Self, WorldDefinitionError> {
        let entry = entry
            .as_object()
            .ok_or(WorldDefinitionError::ThingNotAnObject { place, thing })?;
        let name = one_line(entry.get("name"))
            .ok_or(WorldDefinitionError::InvalidThingName { place, thing })?;
        let looked = |key| {
            look(entry, key).map_err(|key| WorldDefinitionError::InvalidThingLook {
                place,
                thing,
                key,
            })
        };

        Ok(Self {
            name,
            icon: looked("icon")?,
            tint: looked("tint")?,
        })
    }
}

/// An identifier with no capital letter, since it names a folder or a file.
fn lowercase_id(value: Option<&Value>) -> Option<Identifier> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.bytes().any(|byte| byte.is_ascii_uppercase()))
        .and_then(|text| Identifier::new(text).ok())
}

fn one_line(value: Option<&Value>) -> Option<SpeakerName> {
    value
        .and_then(Value::as_str)
        .and_then(|text| SpeakerName::new(text).ok())
}

/// The icon or the tint `key` names in `object`: none when it names none,
/// else a name that is not blank, judged no further, or the refusal naming
/// `key`.
fn look(object: &Map<String, Value>, key: &'static str) -> Result<Option<String>, &'static str> {
    object
        .get(key)
        .map(|value| {
            value
                .as_str()
                .filter(|name| !name.trim().is_empty())
                .map(str::to_owned)
                .ok_or(key)
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn world() -> Value {
        json!({
            "id": "the-port",
            "name": "The Port",
            "places": [
                {"id": "flat", "name": "The Flat", "icon": "bed", "tint": "indigo", "things": [
                    {"name": "Teapot", "icon": "cup", "tint": "brown"},
                    {"name": "Bike"},
                ]},
                {"id": "studio", "name": "The Studio"},
            ],
        })
    }

    fn with(pointer: &str, replacement: Value) -> Value {
        let mut value = world();

        *value.pointer_mut(pointer).unwrap() = replacement;
        value
    }

    #[test]
    fn a_world_reads_as_written_and_what_it_does_not_know_unread() {
        let mut written = world();

        written["$schema"] = json!(42);
        written["places"][1]["door"] = json!("blue");

        let read = WorldDefinition::from_value(&written).unwrap();
        let [flat, studio] = read.places.as_slice() else {
            panic!("two places");
        };

        assert_eq!(read.id().as_str(), "the-port");
        assert_eq!(read.name.as_str(), "The Port");
        assert_eq!(
            (
                flat.id.as_str(),
                flat.name.as_str(),
                flat.icon.as_deref(),
                flat.tint.as_deref()
            ),
            ("flat", "The Flat", Some("bed"), Some("indigo"))
        );
        assert_eq!(
            flat.things
                .iter()
                .map(|thing| (
                    thing.name.as_str(),
                    thing.icon.as_deref(),
                    thing.tint.as_deref()
                ))
                .collect::<Vec<_>>(),
            [("Teapot", Some("cup"), Some("brown")), ("Bike", None, None)]
        );
        assert_eq!(
            (
                studio.id.as_str(),
                studio.icon.as_ref(),
                studio.things.len()
            ),
            ("studio", None, 0)
        );
    }

    #[test]
    fn a_world_is_refused_by_the_first_rule_it_breaks_naming_its_place() {
        let place = |index: usize| json!({"id": format!("place{index}"), "name": "A Place"});
        let thing = json!({"name": "A Thing"});
        let cases = [
            (json!(["the-port"]), "world must be an object"),
            (
                with("/id", json!("The-Port")),
                "world.id must be an identifier in lowercase",
            ),
            (with("/id", json!("9port")), "world.id"),
            (with("/name", json!("The\nPort")), "world.name"),
            (
                with("/places", json!([])),
                "world.places must be an array of 1 to 32",
            ),
            (
                with("/places", Value::Array((0..33).map(place).collect())),
                "world.places must be an array of 1 to 32",
            ),
            (
                with("/places/1", json!("studio")),
                "world.places[1] must be an object",
            ),
            (with("/places/1/id", json!("Studio")), "world.places[1].id"),
            (
                with("/places/1", json!({"id": "flat", "name": ""})),
                "world.places[1].id \"flat\" is an earlier place's id too",
            ),
            (with("/places/1/name", json!("  ")), "world.places[1].name"),
            (
                with("/places/0/icon", json!(" ")),
                "world.places[0].icon must be a name that is not blank",
            ),
            (with("/places/0/tint", json!(7)), "world.places[0].tint"),
            (
                with("/places/0/things", Value::Array(vec![thing; 33])),
                "world.places[0].things must be an array of 32 things at most",
            ),
            (
                with("/places/0/things", json!({})),
                "world.places[0].things",
            ),
            (
                with("/places/0/things/1", json!("Bike")),
                "world.places[0].things[1] must be an object",
            ),
            (
                with("/places/0/things/1/name", json!("")),
                "world.places[0].things[1].name",
            ),
            (
                with("/places/0/things/0/tint", json!("")),
                "world.places[0].things[0].tint must be a name that is not blank",
            ),
        ];

        for (value, fragment) in cases {
            let refusal = WorldDefinition::from_value(&value).unwrap_err();

            assert!(
                refusal.to_string().contains(fragment),
                "{refusal} lacks {fragment}"
            );
        }
    }
}
