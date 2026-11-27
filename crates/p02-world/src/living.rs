//! A world as it lives in the home, among the files its caller hands in
//! under their lease: `world.json`, its name, its places and where each
//! character living there is and since when; `places/<place id>.json`, the
//! things in a place; and `journal.jsonl`, what happened there, a line each.
//! It is made from the world a package brings the first time it is read,
//! and from then on stands by itself. Documents are replaced whole, the
//! journal is only appended to, and every read is forgiving: what cannot be
//! used is passed over and said, and the rest of the world works.

use std::collections::BTreeMap;

use p02_contracts::{LeasedFiles, StoreError};
use p02_core::{SpeakerName, Timestamp};
use p02_shared::Identifier;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::definition::{PlaceDefinition, WorldDefinition};
use crate::kind::{Kind, PLAIN_ICON, PLAIN_TINT};

const WORLD: &str = "world.json";
const JOURNAL: &str = "journal.jsonl";

/// The most places a world holds, and the most things a place holds: what
/// keeps each document within the store's limits.
const MOST_PLACES: usize = 64;
const MOST_THINGS: usize = 64;

const UNREAD_WORLD: &str =
    "the world's own file does not read, and the world was made again from her package's";

/// A place in a world: its id, its name, and the icon and the tint it is
/// drawn with.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Place {
    id: Identifier,
    name: String,
    icon: String,
    tint: String,
}

/// A thing in a place: its own id, which the world gave it, its name, the
/// icon and the tint it is drawn with, whom it is from and when it came.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Thing {
    id: String,
    name: String,
    icon: String,
    tint: String,
    from: Origin,
    came: Timestamp,
}

/// Whom a thing is from: the world itself, or a character, by id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Origin {
    World,
    Character(Identifier),
}

/// Where a character living in a world is, and since when.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Whereabouts {
    place: Identifier,
    since: Timestamp,
}

/// A world as its files keep it, and what of them did not read, a sentence
/// each.
#[derive(Debug)]
pub struct LivingWorld {
    name: String,
    places: Vec<Place>,
    characters: BTreeMap<Identifier, Whereabouts>,
    passed_over: Vec<String>,
}

/// Where a character is: her place, what is in it, and the world's other
/// places, in its order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Here {
    pub place: Place,
    pub things: Vec<Thing>,
    pub others: Vec<Place>,
}

/// A thing she made, and the place it is in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Made {
    pub place: Place,
    pub thing: Thing,
}

/// A thing she used, and the place it is in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Used {
    pub place: Place,
    pub thing: Thing,
}

/// What does not happen in her world, said to her, or the world's files
/// failing.
#[derive(Debug, thiserror::Error)]
pub enum WorldError {
    #[error("a name is one line of 1 to 128 characters")]
    Name,
    #[error("your world has room for no more places: it holds {MOST_PLACES}")]
    NoRoomForPlace,
    #[error("{place} has room for no more things: it holds {MOST_THINGS}")]
    NoRoomForThing { place: String },
    /// Nothing where she is goes by the name she gave, `here` being what
    /// does, by name.
    #[error("there is no \"{thing}\" here")]
    NotHere { thing: String, here: Vec<String> },
    #[error(transparent)]
    Store(#[from] StoreError),
}

impl Place {
    #[must_use]
    pub fn id(&self) -> &Identifier {
        &self.id
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    fn of(definition: &PlaceDefinition) -> Self {
        Self {
            id: definition.id.clone(),
            name: definition.name.as_str().to_owned(),
            icon: definition
                .icon
                .clone()
                .unwrap_or_else(|| PLAIN_ICON.to_owned()),
            tint: definition
                .tint
                .clone()
                .unwrap_or_else(|| PLAIN_TINT.to_owned()),
        }
    }

    /// The document that keeps the things in it.
    fn file(&self) -> String {
        things_file(&self.id)
    }
}

impl Thing {
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    fn new(name: &str, icon: &str, tint: &str, from: Origin, came: &Timestamp) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name: name.to_owned(),
            icon: icon.to_owned(),
            tint: tint.to_owned(),
            from,
            came: came.clone(),
        }
    }
}

impl LivingWorld {
    /// The world `definition` makes, as `files` keep it: made from the
    /// definition at `now` the first time it is read, and from then on as
    /// they keep it, whatever the definition says. A world whose own file
    /// does not read is made again, and each of its places keeps the
    /// things it keeps.
    ///
    /// # Errors
    ///
    /// The store's, when it fails.
    pub fn read(
        files: &mut dyn LeasedFiles,
        definition: &WorldDefinition,
        now: &Timestamp,
    ) -> Result<Self, StoreError> {
        let mut passed_over = Vec::new();

        if let Some(document) = files.read_json(WORLD)? {
            match Self::kept(&document) {
                Some(world) => return Ok(world),
                None => passed_over.push(UNREAD_WORLD.to_owned()),
            }
        }

        let mut world = Self::made(files, definition, now)?;

        world.passed_over = passed_over;
        Ok(world)
    }

    /// What of its files did not read and was passed over, a sentence each.
    #[must_use]
    pub fn passed_over(&self) -> &[String] {
        &self.passed_over
    }

    /// Where `character` is, and what is there.
    ///
    /// # Errors
    ///
    /// The store's, when it fails.
    pub fn here(
        &mut self,
        files: &mut dyn LeasedFiles,
        character: &Identifier,
        now: &Timestamp,
    ) -> Result<Here, StoreError> {
        let place = self.place_of(files, character, now)?;

        self.at(files, place)
    }

    /// `character` goes to `place` at `now`: a place of the world's, named
    /// by its id or its name in any case, or else somewhere new of that
    /// name, which the world then holds. Going where she is changes
    /// nothing.
    ///
    /// # Errors
    ///
    /// [`WorldError::Name`] for a new place's name that is not one line of
    /// 1 to 128 characters, [`WorldError::NoRoomForPlace`] once the world
    /// holds the most it can, or the store's.
    pub fn go(
        &mut self,
        files: &mut dyn LeasedFiles,
        character: &Identifier,
        place: &str,
        now: &Timestamp,
    ) -> Result<Here, WorldError> {
        let named = place.trim();
        let found = self
            .places
            .iter()
            .find(|place| same(place.id.as_str(), named) || same(&place.name, named))
            .cloned();
        let place = match found {
            Some(place) => place,
            None => self.found(named)?,
        };

        if self
            .characters
            .get(character)
            .is_none_or(|whereabouts| whereabouts.place != place.id)
        {
            self.characters.insert(
                character.clone(),
                Whereabouts {
                    place: place.id.clone(),
                    since: now.clone(),
                },
            );
            self.write(files)?;
            happened(files, now, character, "went", &place, None)?;
        }

        Ok(self.at(files, place)?)
    }

    /// `character` makes a thing called `name`, of `kind`, where she is, at
    /// `now`. It stays there.
    ///
    /// # Errors
    ///
    /// [`WorldError::Name`] for a name that is not one line of 1 to 128
    /// characters, [`WorldError::NoRoomForThing`] once her place holds the
    /// most it can, or the store's.
    pub fn make(
        &mut self,
        files: &mut dyn LeasedFiles,
        character: &Identifier,
        name: &str,
        kind: Kind,
        now: &Timestamp,
    ) -> Result<Made, WorldError> {
        let name = SpeakerName::new(name.trim()).map_err(|_| WorldError::Name)?;
        let place = self.place_of(files, character, now)?;
        let mut things = self.things_in(files, &place)?;

        if things.len() >= MOST_THINGS {
            return Err(WorldError::NoRoomForThing { place: place.name });
        }

        let thing = Thing::new(
            name.as_str(),
            kind.icon,
            kind.tint,
            Origin::Character(character.clone()),
            now,
        );

        things.push(thing.clone());
        files.write_json(&place.file(), &json!({"things": things}))?;
        happened(files, now, character, "made", &place, Some(&thing))?;
        Ok(Made { place, thing })
    }

    /// `character` uses the thing called `thing` in any case, where she is,
    /// at `now`. It changes nothing of the thing: the journal remembers it.
    ///
    /// # Errors
    ///
    /// [`WorldError::NotHere`] when nothing there goes by that name, or the
    /// store's.
    pub fn use_thing(
        &mut self,
        files: &mut dyn LeasedFiles,
        character: &Identifier,
        thing: &str,
        now: &Timestamp,
    ) -> Result<Used, WorldError> {
        let place = self.place_of(files, character, now)?;
        let things = self.things_in(files, &place)?;
        let named = thing.trim();
        let Some(thing) = things
            .iter()
            .find(|thing| same(&thing.name, named))
            .cloned()
        else {
            return Err(WorldError::NotHere {
                thing: named.to_owned(),
                here: things.into_iter().map(|thing| thing.name).collect(),
            });
        };

        happened(files, now, character, "used", &place, Some(&thing))?;
        Ok(Used { place, thing })
    }

    /// The world `document` keeps, read forgivingly: a place, or where a
    /// character is, that does not read is passed over and said. None when
    /// the document does not read, or no place of it does.
    fn kept(document: &Value) -> Option<Self> {
        #[derive(Deserialize)]
        struct Kept {
            name: String,
            places: Vec<Value>,
            #[serde(default)]
            characters: Map<String, Value>,
        }

        let kept = Kept::deserialize(document).ok()?;
        let mut passed_over = Vec::new();
        let mut places: Vec<Place> = Vec::with_capacity(kept.places.len());

        for entry in &kept.places {
            match Place::deserialize(entry) {
                Ok(place) if places.iter().all(|other| other.id != place.id) => places.push(place),
                Ok(place) => passed_over.push(format!(
                    "a second place \"{}\" in the world was passed over",
                    place.id
                )),
                Err(error) => passed_over.push(format!(
                    "a place in the world does not read, and was passed over: {error}"
                )),
            }
        }

        if places.is_empty() {
            return None;
        }

        let mut characters = BTreeMap::new();

        for (id, entry) in &kept.characters {
            let read = Identifier::new(id)
                .ok()
                .zip(Whereabouts::deserialize(entry).ok())
                .filter(|(_, whereabouts)| {
                    places.iter().any(|place| place.id == whereabouts.place)
                });

            match read {
                Some((id, whereabouts)) => {
                    characters.insert(id, whereabouts);
                }
                None => passed_over.push(format!(
                    "where \"{id}\" is in the world does not read, and was passed over"
                )),
            }
        }

        Some(Self {
            name: kept.name,
            places,
            characters,
            passed_over,
        })
    }

    /// The world `definition` makes at `now`, written into `files`: its
    /// places in order, each with its things as things from the world
    /// itself, but a place whose things are kept already, which keeps them.
    fn made(
        files: &mut dyn LeasedFiles,
        definition: &WorldDefinition,
        now: &Timestamp,
    ) -> Result<Self, StoreError> {
        for place in &definition.places {
            let file = things_file(&place.id);

            if files.read_json(&file)?.is_none() {
                let things: Vec<Thing> = place
                    .things
                    .iter()
                    .map(|thing| {
                        Thing::new(
                            thing.name.as_str(),
                            thing.icon.as_deref().unwrap_or(PLAIN_ICON),
                            thing.tint.as_deref().unwrap_or(PLAIN_TINT),
                            Origin::World,
                            now,
                        )
                    })
                    .collect();

                files.write_json(&file, &json!({"things": things}))?;
            }
        }

        let world = Self {
            name: definition.name.as_str().to_owned(),
            places: definition.places.iter().map(Place::of).collect(),
            characters: BTreeMap::new(),
            passed_over: Vec::new(),
        };

        world.write(files)?;
        Ok(world)
    }

    /// Replaces the world's own file with what it now is.
    fn write(&self, files: &mut dyn LeasedFiles) -> Result<(), StoreError> {
        files.write_json(
            WORLD,
            &json!({"name": self.name, "places": self.places, "characters": self.characters}),
        )
    }

    /// Where `character` is: at the world's first place, from `now` on,
    /// while she has no place there yet.
    fn place_of(
        &mut self,
        files: &mut dyn LeasedFiles,
        character: &Identifier,
        now: &Timestamp,
    ) -> Result<Place, StoreError> {
        let kept = self.characters.get(character).and_then(|whereabouts| {
            self.places
                .iter()
                .find(|place| place.id == whereabouts.place)
        });

        if let Some(place) = kept {
            return Ok(place.clone());
        }

        let first = self.places[0].clone();

        self.characters.insert(
            character.clone(),
            Whereabouts {
                place: first.id.clone(),
                since: now.clone(),
            },
        );
        self.write(files)?;
        Ok(first)
    }

    /// `place` with what is in it and the world's other places.
    fn at(&mut self, files: &dyn LeasedFiles, place: Place) -> Result<Here, StoreError> {
        let things = self.things_in(files, &place)?;
        let others = self
            .places
            .iter()
            .filter(|other| other.id != place.id)
            .cloned()
            .collect();

        Ok(Here {
            place,
            things,
            others,
        })
    }

    /// What is in `place`, read forgivingly: a thing that does not read is
    /// passed over and said.
    fn things_in(
        &mut self,
        files: &dyn LeasedFiles,
        place: &Place,
    ) -> Result<Vec<Thing>, StoreError> {
        let Some(document) = files.read_json(&place.file())? else {
            return Ok(Vec::new());
        };
        let Some(entries) = document.get("things").and_then(Value::as_array) else {
            self.passed_over.push(format!(
                "what is in {} does not read, and was passed over",
                place.name
            ));
            return Ok(Vec::new());
        };

        Ok(entries
            .iter()
            .filter_map(|entry| match Thing::deserialize(entry) {
                Ok(thing) => Some(thing),
                Err(error) => {
                    self.passed_over.push(format!(
                        "a thing in {} does not read, and was passed over: {error}",
                        place.name
                    ));
                    None
                }
            })
            .collect())
    }

    /// A place of the world's new to it, called `name` as she wrote it, with
    /// an id the world makes and the plainest look.
    fn found(&mut self, name: &str) -> Result<Place, WorldError> {
        let name = SpeakerName::new(name).map_err(|_| WorldError::Name)?;

        if self.places.len() >= MOST_PLACES {
            return Err(WorldError::NoRoomForPlace);
        }

        let place = Place {
            id: self.new_place_id(name.as_str()),
            name: name.as_str().to_owned(),
            icon: PLAIN_ICON.to_owned(),
            tint: PLAIN_TINT.to_owned(),
        };

        self.places.push(place.clone());
        Ok(place)
    }

    /// The id of a new place called `name`: its letters and digits in
    /// lowercase, a hyphen for each run of anything else, after `place`
    /// when no letter comes first, and a number after it while another
    /// place has it.
    fn new_place_id(&self, name: &str) -> Identifier {
        let mut words = String::new();

        for character in name.chars() {
            if character.is_ascii_alphanumeric() {
                words.push(character.to_ascii_lowercase());
            } else if !words.is_empty() && !words.ends_with('-') {
                words.push('-');
            }
        }

        words.truncate(64);

        let words = words.trim_end_matches('-');
        let base = match words.chars().next() {
            Some(first) if first.is_ascii_lowercase() => words.to_owned(),
            Some(_) => format!("place-{words}"),
            None => "place".to_owned(),
        };
        let taken = |id: &str| self.places.iter().any(|place| place.id.as_str() == id);
        let id = (1..=MOST_PLACES)
            .map(|number| match number {
                1 => base.clone(),
                _ => format!("{base}-{number}"),
            })
            .find(|id| !taken(id))
            .expect("a world with room for a place has fewer places than it holds");

        Identifier::new(&id).expect("lowercase letters, digits and hyphens after a letter")
    }
}

/// The document that keeps the things in the place of id `place`.
fn things_file(place: &Identifier) -> String {
    format!("places/{place}.json")
}

/// Whether `text` and `other` are one name in any case.
fn same(text: &str, other: &str) -> bool {
    text.to_lowercase() == other.to_lowercase()
}

/// Appends to the journal that `character` did `what` at `place`, at `now`,
/// to `thing` when it was done to one, each by its id and its name now.
fn happened(
    files: &mut dyn LeasedFiles,
    now: &Timestamp,
    character: &Identifier,
    what: &str,
    place: &Place,
    thing: Option<&Thing>,
) -> Result<(), StoreError> {
    let mut line = json!({
        "when": now,
        "who": {"character": character},
        "what": what,
        "place": {"id": place.id, "name": place.name},
    });

    if let Some(thing) = thing {
        line["thing"] = json!({"id": thing.id, "name": thing.name});
    }

    files.append_jsonl(JOURNAL, &line)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A world's files, in memory: each document a value, each log its
    /// lines.
    #[derive(Debug, Default)]
    struct Files {
        documents: BTreeMap<String, Value>,
        logs: BTreeMap<String, Vec<Value>>,
    }

    impl LeasedFiles for Files {
        fn read_json(&self, path: &str) -> Result<Option<Value>, StoreError> {
            Ok(self.documents.get(path).cloned())
        }

        fn read_jsonl(&self, path: &str) -> Result<Vec<Value>, StoreError> {
            Ok(self.logs.get(path).cloned().unwrap_or_default())
        }

        fn count_jsonl(&self, path: &str) -> Result<u64, StoreError> {
            Ok(self.logs.get(path).map_or(0, |lines| lines.len() as u64))
        }

        fn read_text(&self, _: &str) -> Result<Option<String>, StoreError> {
            unreachable!("a world keeps no text file")
        }

        fn write_json(&mut self, path: &str, value: &Value) -> Result<(), StoreError> {
            self.documents.insert(path.to_owned(), value.clone());
            Ok(())
        }

        fn append_jsonl(&mut self, path: &str, value: &Value) -> Result<(), StoreError> {
            self.logs
                .entry(path.to_owned())
                .or_default()
                .push(value.clone());
            Ok(())
        }

        fn write_text(&mut self, _: &str, _: &str) -> Result<(), StoreError> {
            unreachable!("a world keeps no text file")
        }

        fn remove(&mut self, _: &str) -> Result<(), StoreError> {
            unreachable!("nothing of a world is removed")
        }
    }

    fn port() -> WorldDefinition {
        WorldDefinition::from_value(&json!({
            "id": "the-port",
            "name": "The Port",
            "places": [
                {"id": "flat", "name": "The Flat", "icon": "bed", "tint": "indigo", "things": [
                    {"name": "Teapot", "icon": "cup", "tint": "brown"},
                    {"name": "Bike"},
                ]},
                {"id": "studio", "name": "The Studio", "things": [{"name": "Proofs"}]},
            ],
        }))
        .unwrap()
    }

    fn mira() -> Identifier {
        Identifier::new("mira").unwrap()
    }

    fn at(moment: &str) -> Timestamp {
        Timestamp::new(moment).unwrap()
    }

    fn morning() -> Timestamp {
        at("2026-11-26T09:00:00.000Z")
    }

    /// The names of what is where she is.
    fn names(here: &Here) -> Vec<&str> {
        here.things.iter().map(Thing::name).collect()
    }

    fn journal(files: &Files) -> Vec<(String, String, Option<String>)> {
        files.logs[JOURNAL]
            .iter()
            .map(|line| {
                (
                    line["what"].as_str().unwrap().to_owned(),
                    line["place"]["id"].as_str().unwrap().to_owned(),
                    line["thing"]["name"].as_str().map(str::to_owned),
                )
            })
            .collect()
    }

    #[test]
    fn a_world_is_made_once_from_its_definition_and_then_stands_by_itself() {
        let mut files = Files::default();
        let mut world = LivingWorld::read(&mut files, &port(), &morning()).unwrap();
        let here = world.here(&mut files, &mira(), &morning()).unwrap();

        assert_eq!(
            files.documents[WORLD],
            json!({
                "name": "The Port",
                "places": [
                    {"id": "flat", "name": "The Flat", "icon": "bed", "tint": "indigo"},
                    {"id": "studio", "name": "The Studio", "icon": "grid", "tint": "gray"},
                ],
                "characters": {"mira": {"place": "flat", "since": "2026-11-26T09:00:00.000Z"}},
            })
        );
        assert_eq!(names(&here), ["Teapot", "Bike"]);
        assert_eq!(
            files.documents["places/flat.json"]["things"][1],
            json!({
                "id": here.things[1].id,
                "name": "Bike",
                "icon": "grid",
                "tint": "gray",
                "from": "world",
                "came": "2026-11-26T09:00:00.000Z",
            })
        );
        assert_eq!(
            here.others.iter().map(Place::name).collect::<Vec<_>>(),
            ["The Studio"]
        );
        assert_ne!(here.things[0].id, here.things[1].id);

        let later = WorldDefinition::from_value(&json!({
            "id": "the-port",
            "name": "The New Port",
            "places": [{"id": "harbour", "name": "The Harbour"}],
        }))
        .unwrap();
        let kept = files.documents.clone();
        let mut again =
            LivingWorld::read(&mut files, &later, &at("2026-11-27T09:00:00.000Z")).unwrap();

        assert_eq!(again.here(&mut files, &mira(), &morning()).unwrap(), here);
        assert_eq!(files.documents, kept);
        assert_eq!(again.passed_over(), [] as [String; 0]);
    }

    #[test]
    fn she_goes_and_uses_by_id_or_name_in_any_case_and_a_name_the_world_lacks_is_somewhere_new() {
        let mut files = Files::default();
        let mut world = LivingWorld::read(&mut files, &port(), &morning()).unwrap();
        let went = |world: &mut LivingWorld, files: &mut Files, place: &str| {
            world.go(files, &mira(), place, &morning()).unwrap().place
        };

        assert_eq!(
            went(&mut world, &mut files, "STUDIO").id().as_str(),
            "studio"
        );
        assert_eq!(
            went(&mut world, &mut files, "the flat").id().as_str(),
            "flat"
        );
        assert_eq!(
            went(&mut world, &mut files, "the flat").id().as_str(),
            "flat"
        );

        let harbour = went(&mut world, &mut files, "  The Harbour, by the sea ");

        assert_eq!(
            serde_json::to_value(&harbour).unwrap(),
            json!({"id": "the-harbour-by-the-sea", "name": "The Harbour, by the sea", "icon": "grid", "tint": "gray"})
        );
        assert_eq!(
            went(&mut world, &mut files, "the harbour, BY THE SEA"),
            harbour
        );
        assert_eq!(
            went(&mut world, &mut files, "Harbour!").id().as_str(),
            "harbour"
        );
        assert_eq!(
            went(&mut world, &mut files, "4th Street").id().as_str(),
            "place-4th-street"
        );
        assert_eq!(went(&mut world, &mut files, "海辺").id().as_str(), "place");
        assert_eq!(went(&mut world, &mut files, "海").id().as_str(), "place-2");
        assert_eq!(went(&mut world, &mut files, "flat").id().as_str(), "flat");
        assert_eq!(
            world
                .use_thing(&mut files, &mira(), "TEAPOT", &morning())
                .unwrap()
                .thing
                .name(),
            "Teapot"
        );
        assert_eq!(
            journal(&files),
            [
                ("went", "studio", None),
                ("went", "flat", None),
                ("went", "the-harbour-by-the-sea", None),
                ("went", "harbour", None),
                ("went", "place-4th-street", None),
                ("went", "place", None),
                ("went", "place-2", None),
                ("went", "flat", None),
                ("used", "flat", Some("Teapot")),
            ]
            .map(|(what, place, thing)| (
                what.to_owned(),
                place.to_owned(),
                thing.map(str::to_owned)
            ))
        );
        assert_eq!(
            LivingWorld::read(&mut files, &port(), &morning())
                .unwrap()
                .places
                .len(),
            7
        );
    }

    #[test]
    fn she_makes_a_thing_of_a_kind_where_she_is_and_what_is_not_there_she_cannot_use() {
        let mut files = Files::default();
        let mut world = LivingWorld::read(&mut files, &port(), &morning()).unwrap();
        let gift = Kind::named("gift").unwrap();
        let made = world
            .make(&mut files, &mira(), " Paper crane ", gift, &morning())
            .unwrap();

        assert_eq!(
            (made.place.id().as_str(), made.thing.name()),
            ("flat", "Paper crane")
        );
        assert_eq!(
            files.documents["places/flat.json"]["things"][2],
            json!({
                "id": made.thing.id,
                "name": "Paper crane",
                "icon": "gift",
                "tint": "pink",
                "from": {"character": "mira"},
                "came": "2026-11-26T09:00:00.000Z",
            })
        );

        let Err(WorldError::NotHere { thing, here }) =
            world.use_thing(&mut files, &mira(), "Spoon", &morning())
        else {
            panic!("there is no spoon");
        };

        assert_eq!(
            (thing.as_str(), here),
            (
                "Spoon",
                vec![
                    "Teapot".to_owned(),
                    "Bike".to_owned(),
                    "Paper crane".to_owned()
                ]
            )
        );
        assert_eq!(
            world
                .use_thing(&mut files, &mira(), "paper CRANE", &morning())
                .unwrap()
                .thing,
            made.thing
        );
        assert_eq!(
            files.logs[JOURNAL],
            [
                json!({
                    "when": "2026-11-26T09:00:00.000Z",
                    "who": {"character": "mira"},
                    "what": "made",
                    "place": {"id": "flat", "name": "The Flat"},
                    "thing": {"id": made.thing.id, "name": "Paper crane"},
                }),
                json!({
                    "when": "2026-11-26T09:00:00.000Z",
                    "who": {"character": "mira"},
                    "what": "used",
                    "place": {"id": "flat", "name": "The Flat"},
                    "thing": {"id": made.thing.id, "name": "Paper crane"},
                }),
            ]
        );
    }

    #[test]
    fn a_world_holds_64_places_and_a_place_64_things_and_a_name_is_one_line_of_128_at_most() {
        let mut files = Files::default();
        let mut world = LivingWorld::read(&mut files, &port(), &morning()).unwrap();
        let other = Kind::OTHER;

        for name in ["", "   ", "Two\nlines", &"x".repeat(129)] {
            assert!(matches!(
                world.go(&mut files, &mira(), name, &morning()),
                Err(WorldError::Name)
            ));
            assert!(matches!(
                world.make(&mut files, &mira(), name, other, &morning()),
                Err(WorldError::Name)
            ));
        }

        for place in 2..64 {
            world
                .go(&mut files, &mira(), &format!("Place {place}"), &morning())
                .unwrap();
        }

        assert!(matches!(
            world.go(&mut files, &mira(), "One more", &morning()),
            Err(WorldError::NoRoomForPlace)
        ));
        world.go(&mut files, &mira(), "flat", &morning()).unwrap();

        for thing in 2..64 {
            world
                .make(&mut files, &mira(), &"y".repeat(128), other, &morning())
                .unwrap_or_else(|error| panic!("{thing}: {error}"));
        }

        let Err(full) = world.make(&mut files, &mira(), "One more", other, &morning()) else {
            panic!("the flat is full");
        };

        assert_eq!(
            full.to_string(),
            "The Flat has room for no more things: it holds 64"
        );
    }

    #[test]
    fn what_does_not_read_is_passed_over_and_said_and_the_rest_of_the_world_works() {
        let mut files = Files::default();
        let mut world = LivingWorld::read(&mut files, &port(), &morning()).unwrap();
        let made = world
            .make(&mut files, &mira(), "Toast", Kind::OTHER, &morning())
            .unwrap();

        world.go(&mut files, &mira(), "studio", &morning()).unwrap();
        files.documents.get_mut("places/flat.json").unwrap()["things"][0] = json!({"name": 3});
        files.documents.get_mut(WORLD).unwrap()["characters"]["mira"]["place"] = json!("gone");
        files.documents.get_mut(WORLD).unwrap()["places"]
            .as_array_mut()
            .unwrap()
            .push(
                json!({"id": "studio", "name": "Another Studio", "icon": "grid", "tint": "gray"}),
            );

        let mut world = LivingWorld::read(&mut files, &port(), &morning()).unwrap();
        let here = world.here(&mut files, &mira(), &morning()).unwrap();

        assert_eq!(names(&here), ["Bike", "Toast"]);
        assert_eq!(
            world.passed_over(),
            [
                "a second place \"studio\" in the world was passed over",
                "where \"mira\" is in the world does not read, and was passed over",
                "a thing in The Flat does not read, and was passed over: invalid type: integer `3`, \
                 expected a string",
            ]
        );

        files
            .documents
            .insert(WORLD.to_owned(), json!({"places": "none"}));

        let mut remade = LivingWorld::read(&mut files, &port(), &morning()).unwrap();

        assert_eq!(remade.passed_over(), [UNREAD_WORLD]);
        assert_eq!(
            remade
                .here(&mut files, &mira(), &morning())
                .unwrap()
                .things
                .last()
                .map(Thing::name),
            Some(made.thing.name())
        );
    }
}
