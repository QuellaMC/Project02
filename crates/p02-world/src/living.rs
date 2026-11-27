//! A world as it lives in the home, among the files its caller hands in
//! under their lease: `world.json`, its name, its places and where each
//! character living there is and since when; `places/<place id>.json`, the
//! things in a place; and `journal.jsonl`, what happened there, a line each.
//! It is made from the world a package brings the first time it is read,
//! and from then on stands by itself. Documents are replaced whole, the
//! journal is only appended to, and every read is forgiving: what cannot be
//! used is passed over and said, and the rest of the world works.
//!
//! Its words are hers. Beside a name the person did not write, the world
//! keeps their words for it once they are made, and which language the
//! person's setting said they were made in; beside a thing the person left
//! in other words than hers, what they wrote.

use std::collections::BTreeMap;
use std::iter;

use p02_contracts::{LeasedFiles, StoreError};
use p02_core::{LanguageTag, SpeakerName, Timestamp, VisibleText};
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

/// The longest note the person leaves with a thing, in characters.
const MOST_NOTE: usize = 280;

/// How many of the journal's newest lines a person sees.
const NEWEST_LINES: usize = 200;

const UNREAD_WORLD: &str =
    "the world's own file does not read, and the world was made again from her package's";

/// A place in a world: its id, its name, the icon and the tint it is drawn
/// with, and the person's words for its name, once they are made.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Place {
    id: Identifier,
    name: String,
    icon: String,
    tint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    translation: Option<String>,
}

/// A thing in a place: its own id, which the world gave it, its name, the
/// icon and the tint it is drawn with, whom it is from and when it came; a
/// thing the person left also has their note, when they wrote one, what
/// they wrote of each that was put into her language, and the characters
/// who have seen it; any other has the person's words for its name, once
/// they are made.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Thing {
    id: String,
    name: String,
    icon: String,
    tint: String,
    from: Hand,
    came: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    seen: Vec<Identifier>,
    #[serde(default, skip_serializing_if = "Written::is_empty")]
    written: Written,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    translation: Option<String>,
}

/// What the person wrote of a thing they left, where her world has it in
/// other words, hers: its name, and their note.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Written {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// A thing the person leaves her, as her world will keep it: its name, its
/// kind and their note, when they wrote one, in her language once they are
/// put into it, with what the person wrote beside each that was.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Leaving {
    name: SpeakerName,
    kind: Kind,
    note: Option<String>,
    written: Written,
}

/// A hand that changes a world: the world itself, the person, or a
/// character, by id. A thing is from one, and a line of the journal says
/// whose deed it was.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Hand {
    World,
    Person,
    Character(Identifier),
}

/// Where a character living in a world is, and since when.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Whereabouts {
    pub place: Identifier,
    pub since: Timestamp,
}

/// What a line of the journal says happened.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Deed {
    Went,
    Made,
    Used,
    Left,
    Removed,
}

/// A line of a world's journal: when, whose deed it was, what happened,
/// the place and the thing it was about, and, when it keeps the person's
/// words for a name, the language they are in, as their setting said it
/// when they were made, none for Automatic.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub when: Timestamp,
    pub who: Hand,
    pub what: Deed,
    pub place: Named,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thing: Option<Named>,
    #[serde(
        default,
        rename = "translatedInto",
        skip_serializing_if = "Option::is_none"
    )]
    pub translated_into: Option<LanguageTag>,
}

/// A place or a thing as a line of the journal names it: by its id, and by
/// the name it had then, with the person's form of that name beside it
/// when it had one: what the person wrote of a thing they left, or the
/// person's words kept for a name they did not write.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Named {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub written: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translation: Option<String>,
}

/// A world as its files keep it, and what of them did not read, a sentence
/// each: its name, and the person's words for it, once they are made; its
/// places; where each character living there is; and the language the
/// person's words kept with it are in, as their setting said it when they
/// were made, none for Automatic.
#[derive(Debug)]
pub struct LivingWorld {
    name: String,
    translation: Option<String>,
    places: Vec<Place>,
    characters: BTreeMap<Identifier, Whereabouts>,
    translated_into: Option<LanguageTag>,
    passed_over: Vec<String>,
}

/// `world.json` as it is written.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Document<'a> {
    name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    translation: Option<&'a str>,
    places: &'a [Place],
    characters: &'a BTreeMap<Identifier, Whereabouts>,
    #[serde(skip_serializing_if = "Option::is_none")]
    translated_into: Option<&'a LanguageTag>,
}

/// Where a character is, as she is told of it: her place, what is in it in
/// the order it came, each thing as it stood before she was told, so that
/// what was new to her says so, and the world's other places, in its
/// order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Here {
    pub place: Place,
    pub things: Vec<Thing>,
    pub others: Vec<Place>,
}

/// Everything a person sees of a world: its name, its places in their
/// order, each with what is in it in the order it came, where each
/// character living there is and since when, and the newest lines of its
/// journal, newest first; with the person's words kept for the names they
/// did not write while those are in the language they read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct View {
    pub name: String,
    /// The person's words for its name.
    pub translation: Option<String>,
    pub places: Vec<(Place, Vec<Thing>)>,
    pub characters: BTreeMap<Identifier, Whereabouts>,
    pub journal: Vec<Entry>,
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

/// Why a thing the person leaves is not left, said to them, or the world's
/// files failing.
#[derive(Debug, thiserror::Error)]
pub enum LeaveError {
    #[error("there is no place \"{place}\" in {world}")]
    NoPlace { place: String, world: String },
    #[error("a name is one line of 1 to 128 characters")]
    Name,
    #[error("there is no kind of thing \"{kind}\"")]
    NoKind { kind: String },
    #[error("a note is not blank, and is {MOST_NOTE} characters at most")]
    Note,
    #[error("{place} has room for no more things: it holds {MOST_THINGS}")]
    NoRoom { place: String },
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// Why a thing the person removes is not removed, said to them, or the
/// world's files failing.
#[derive(Debug, thiserror::Error)]
pub enum RemoveError {
    #[error("there is no thing \"{thing}\" in {world}")]
    NoThing { thing: String, world: String },
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

    #[must_use]
    pub fn icon(&self) -> &str {
        &self.icon
    }

    #[must_use]
    pub fn tint(&self) -> &str {
        &self.tint
    }

    /// The person's words for its name, once they are made.
    #[must_use]
    pub fn translation(&self) -> Option<&str> {
        self.translation.as_deref()
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
            translation: None,
        }
    }

    /// The document that keeps the things in it.
    fn file(&self) -> String {
        things_file(&self.id)
    }
}

impl Thing {
    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    #[must_use]
    pub fn icon(&self) -> &str {
        &self.icon
    }

    #[must_use]
    pub fn tint(&self) -> &str {
        &self.tint
    }

    /// Whom it is from.
    #[must_use]
    pub fn from(&self) -> &Hand {
        &self.from
    }

    /// When it came.
    #[must_use]
    pub fn came(&self) -> &Timestamp {
        &self.came
    }

    /// The note the person left with it, when they wrote one.
    #[must_use]
    pub fn note(&self) -> Option<&str> {
        self.note.as_deref()
    }

    /// The characters who have been told of it where it is, for a thing the
    /// person left.
    #[must_use]
    pub fn seen(&self) -> &[Identifier] {
        &self.seen
    }

    /// What the person wrote of it, where her world has it in her words.
    #[must_use]
    pub fn written(&self) -> &Written {
        &self.written
    }

    /// The person's words for its name, once they are made: for a thing
    /// the person did not leave.
    #[must_use]
    pub fn translation(&self) -> Option<&str> {
        self.translation.as_deref()
    }

    /// Whether it is new to `character`: the person left it, and she has
    /// not been told of it where it is. What the world itself brought and
    /// what she made never are.
    #[must_use]
    pub fn is_new_to(&self, character: &Identifier) -> bool {
        self.from == Hand::Person && !self.seen.contains(character)
    }

    fn new(name: &str, icon: &str, tint: &str, from: Hand, came: &Timestamp) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name: name.to_owned(),
            icon: icon.to_owned(),
            tint: tint.to_owned(),
            from,
            came: came.clone(),
            note: None,
            seen: Vec::new(),
            written: Written::default(),
            translation: None,
        }
    }
}

impl Written {
    fn is_empty(&self) -> bool {
        self.name.is_none() && self.note.is_none()
    }
}

impl Leaving {
    /// What the person leaves as they wrote it: a name, one line of 1 to
    /// 128 characters; one of the kinds, by its name; and their note when
    /// they wrote one, kept with its line endings `\n` and its ends trimmed,
    /// not blank and 280 characters at most.
    ///
    /// # Errors
    ///
    /// [`LeaveError::Name`], [`LeaveError::NoKind`] or [`LeaveError::Note`],
    /// for the first of these rules broken.
    pub fn new(name: &str, kind: &str, note: Option<&str>) -> Result<Self, LeaveError> {
        let name = trimmed_name(name).ok_or(LeaveError::Name)?;
        let kind = Kind::named(kind).ok_or_else(|| LeaveError::NoKind {
            kind: kind.to_owned(),
        })?;
        let note = note.map(written).transpose()?;

        Ok(Self {
            name,
            kind,
            note,
            written: Written::default(),
        })
    }

    /// Its words, which are put into her language: its name, then its note
    /// when it has one.
    #[must_use]
    pub fn words(&self) -> Vec<&str> {
        iter::once(self.name.as_str())
            .chain(self.note.as_deref())
            .collect()
    }

    /// It in her language, `hers` her words for [`Leaving::words`] in their
    /// order: each that is not what the person wrote takes its place, and
    /// what they wrote is kept beside it.
    ///
    /// # Errors
    ///
    /// [`LeaveError::Name`] or [`LeaveError::Note`] when her words for its
    /// name or its note break the rule of a name or a note.
    pub fn in_her_language(self, hers: Vec<String>) -> Result<Self, LeaveError> {
        let mut hers = hers.into_iter();
        let name = match hers.next() {
            Some(name) => trimmed_name(&name).ok_or(LeaveError::Name)?,
            None => self.name.clone(),
        };
        let note = match (&self.note, hers.next()) {
            (Some(_), Some(note)) => Some(written(&note)?),
            (note, _) => note.clone(),
        };

        Ok(Self {
            written: Written {
                name: (name != self.name).then(|| self.name.as_str().to_owned()),
                note: self
                    .note
                    .clone()
                    .filter(|wrote| note.as_ref() != Some(wrote)),
            },
            name,
            kind: self.kind,
            note,
        })
    }
}

impl View {
    /// The names the person did not write that no words of theirs are kept
    /// for: the world's, its places' and its things' from the world itself
    /// or a character's hand, each once, in the view's order.
    #[must_use]
    pub fn untranslated(&self) -> Vec<&str> {
        let named = self.places.iter().flat_map(|(place, things)| {
            iter::once((&place.name, &place.translation)).chain(
                things
                    .iter()
                    .filter(|thing| thing.from != Hand::Person)
                    .map(|thing| (&thing.name, &thing.translation)),
            )
        });
        let mut untranslated: Vec<&str> = Vec::new();

        for (name, translation) in iter::once((&self.name, &self.translation)).chain(named) {
            if translation.is_none() && !untranslated.contains(&name.as_str()) {
                untranslated.push(name);
            }
        }

        untranslated
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

    /// Where `character` is and what is there, as she is told of it: what
    /// was new to her there she has seen from now on.
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

        self.told(files, character, place)
    }

    /// `character` goes to `place` at `now`: a place of the world's, named
    /// by its id or its name in any case, or else somewhere new of that
    /// name, which the world then holds. Going where she is moves nothing.
    /// She is told what is where she is then, as [`LivingWorld::here`]
    /// tells her.
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
            self.happened(
                files,
                now,
                Hand::Character(character.clone()),
                Deed::Went,
                &place,
                None,
            )?;
        }

        Ok(self.told(files, character, place)?)
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
        let name = trimmed_name(name).ok_or(WorldError::Name)?;
        let place = self.place_of(files, character, now)?;
        let mut things = self.things_in(files, &place)?;

        if things.len() >= MOST_THINGS {
            return Err(WorldError::NoRoomForThing { place: place.name });
        }

        let thing = Thing::new(
            name.as_str(),
            kind.icon(),
            kind.tint(),
            Hand::Character(character.clone()),
            now,
        );

        things.push(thing.clone());
        files.write_json(&place.file(), &json!({"things": things}))?;
        self.happened(
            files,
            now,
            Hand::Character(character.clone()),
            Deed::Made,
            &place,
            Some(&thing),
        )?;
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

        self.happened(
            files,
            now,
            Hand::Character(character.clone()),
            Deed::Used,
            &place,
            Some(&thing),
        )?;
        Ok(Used { place, thing })
    }

    /// The person leaves `leaving` in the place of id `place`, at `now`. It
    /// is new to each character until she is told of it there.
    ///
    /// # Errors
    ///
    /// [`LeaveError::NoPlace`] for a place the world does not hold,
    /// [`LeaveError::NoRoom`] for one that holds the most it can, or the
    /// store's.
    pub fn leave(
        &mut self,
        files: &mut dyn LeasedFiles,
        place: &str,
        leaving: Leaving,
        now: &Timestamp,
    ) -> Result<Thing, LeaveError> {
        let Some(place) = self
            .places
            .iter()
            .find(|held| held.id.as_str() == place)
            .cloned()
        else {
            return Err(LeaveError::NoPlace {
                place: place.to_owned(),
                world: self.name.clone(),
            });
        };
        let mut things = self.things_in(files, &place)?;

        if things.len() >= MOST_THINGS {
            return Err(LeaveError::NoRoom { place: place.name });
        }

        let Leaving {
            name,
            kind,
            note,
            written,
        } = leaving;
        let thing = Thing {
            note,
            written,
            ..Thing::new(name.as_str(), kind.icon(), kind.tint(), Hand::Person, now)
        };

        things.push(thing.clone());
        files.write_json(&place.file(), &json!({"things": things}))?;
        self.happened(files, now, Hand::Person, Deed::Left, &place, Some(&thing))?;
        Ok(thing)
    }

    /// The person removes the thing of id `thing`, wherever it is and
    /// whoever it is from, at `now`.
    ///
    /// # Errors
    ///
    /// [`RemoveError::NoThing`] when no place of the world holds it, or the
    /// store's.
    pub fn remove(
        &mut self,
        files: &mut dyn LeasedFiles,
        thing: &str,
        now: &Timestamp,
    ) -> Result<(), RemoveError> {
        for place in self.places.clone() {
            let mut things = self.things_in(files, &place)?;
            let Some(found) = things.iter().position(|held| held.id == thing) else {
                continue;
            };
            let removed = things.remove(found);

            files.write_json(&place.file(), &json!({"things": things}))?;
            self.happened(
                files,
                now,
                Hand::Person,
                Deed::Removed,
                &place,
                Some(&removed),
            )?;
            return Ok(());
        }

        Err(RemoveError::NoThing {
            thing: thing.to_owned(),
            world: self.name.clone(),
        })
    }

    /// Everything a person sees of the world, read for `character`, who is
    /// at its first place from `now` on while she has none there yet, with
    /// the person's words kept for its names, and for the names its journal
    /// keeps, while they are in `theirs`, the language the person chose,
    /// none for Automatic.
    ///
    /// # Errors
    ///
    /// The store's, when it fails.
    pub fn view(
        &mut self,
        files: &mut dyn LeasedFiles,
        character: &Identifier,
        theirs: Option<&LanguageTag>,
        now: &Timestamp,
    ) -> Result<View, StoreError> {
        self.place_of(files, character, now)?;

        let theirs_kept = current(self.translated_into.as_ref(), theirs);
        let mut places = Vec::with_capacity(self.places.len());

        for mut place in self.places.clone() {
            let mut things = self.things_in(files, &place)?;

            if !theirs_kept {
                place.translation = None;

                for thing in &mut things {
                    thing.translation = None;
                }
            }

            places.push((place, things));
        }

        let mut journal = self.journal(files)?;

        for entry in &mut journal {
            if !current(entry.translated_into.as_ref(), theirs) {
                entry.place.translation = None;

                if let Some(thing) = &mut entry.thing {
                    thing.translation = None;
                }
            }
        }

        Ok(View {
            name: self.name.clone(),
            translation: self.translation.clone().filter(|_| theirs_kept),
            places,
            characters: self.characters.clone(),
            journal,
        })
    }

    /// Keeps `translations`, the person's words for names of the world's
    /// they did not write, by the name each is for: with the world, and with
    /// each place and each thing from the world itself or a character's hand
    /// that goes by that name; and that they are in `theirs`, the language
    /// the person chose, none for Automatic. Words kept in another language
    /// than `theirs` that `translations` do not give again are let go.
    ///
    /// # Errors
    ///
    /// The store's, when it fails.
    pub fn keep_translations(
        &mut self,
        files: &mut dyn LeasedFiles,
        translations: &BTreeMap<String, String>,
        theirs: Option<&LanguageTag>,
    ) -> Result<(), StoreError> {
        let current = current(self.translated_into.as_ref(), theirs);
        // The person's words for `name` from now on, where `held` were theirs
        // until now.
        let theirs_for = |name: &str, held: &Option<String>| {
            translations
                .get(name)
                .cloned()
                .or_else(|| held.clone().filter(|_| current))
        };

        for index in 0..self.places.len() {
            let place = self.places[index].clone();
            let things = self.things_in(files, &place)?;
            let translated: Vec<Thing> = things
                .iter()
                .cloned()
                .map(|mut thing| {
                    if thing.from != Hand::Person {
                        thing.translation = theirs_for(&thing.name, &thing.translation);
                    }

                    thing
                })
                .collect();

            if translated != things {
                files.write_json(&place.file(), &json!({"things": translated}))?;
            }

            self.places[index].translation = theirs_for(&place.name, &place.translation);
        }

        self.translation = theirs_for(&self.name, &self.translation);
        self.translated_into = theirs.cloned();
        self.write(files)
    }

    /// The world `document` keeps, read forgivingly: a place, or where a
    /// character is, that does not read is passed over and said. None when
    /// the document does not read, or no place of it does.
    fn kept(document: &Value) -> Option<Self> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Kept {
            name: String,
            #[serde(default)]
            translation: Option<String>,
            places: Vec<Value>,
            #[serde(default)]
            characters: Map<String, Value>,
            #[serde(default)]
            translated_into: Option<LanguageTag>,
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
            translation: kept.translation,
            places,
            characters,
            translated_into: kept.translated_into,
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
                            Hand::World,
                            now,
                        )
                    })
                    .collect();

                files.write_json(&file, &json!({"things": things}))?;
            }
        }

        let world = Self {
            name: definition.name.as_str().to_owned(),
            translation: None,
            places: definition.places.iter().map(Place::of).collect(),
            characters: BTreeMap::new(),
            translated_into: None,
            passed_over: Vec::new(),
        };

        world.write(files)?;
        Ok(world)
    }

    /// Replaces the world's own file with what it now is.
    fn write(&self, files: &mut dyn LeasedFiles) -> Result<(), StoreError> {
        files.write_json(
            WORLD,
            &json!(Document {
                name: &self.name,
                translation: self.translation.as_deref(),
                places: &self.places,
                characters: &self.characters,
                translated_into: self.translated_into.as_ref(),
            }),
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

    /// `place`, where `character` is, with what is in it and the world's
    /// other places, as she is told of it: each thing as it stood before,
    /// and what was new to her there seen by her from now on.
    fn told(
        &mut self,
        files: &mut dyn LeasedFiles,
        character: &Identifier,
        place: Place,
    ) -> Result<Here, StoreError> {
        let things = self.things_in(files, &place)?;

        if things.iter().any(|thing| thing.is_new_to(character)) {
            let seen: Vec<Thing> = things
                .iter()
                .cloned()
                .map(|mut thing| {
                    if thing.is_new_to(character) {
                        thing.seen.push(character.clone());
                    }

                    thing
                })
                .collect();

            files.write_json(&place.file(), &json!({"things": seen}))?;
        }

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

    /// Appends to the journal that `who` did `what` at `place`, at `now`, to
    /// `thing` when it was done to one, each by its id and its name now,
    /// with the person's form of that name beside it when it has one, and
    /// the language the person's words it keeps are in.
    fn happened(
        &self,
        files: &mut dyn LeasedFiles,
        now: &Timestamp,
        who: Hand,
        what: Deed,
        place: &Place,
        thing: Option<&Thing>,
    ) -> Result<(), StoreError> {
        let place = Named {
            id: place.id.to_string(),
            name: place.name.clone(),
            written: None,
            translation: place.translation.clone(),
        };
        let thing = thing.map(|thing| Named {
            id: thing.id.clone(),
            name: thing.name.clone(),
            written: thing.written.name.clone(),
            translation: thing.translation.clone(),
        });
        let translated = iter::once(&place)
            .chain(&thing)
            .any(|named| named.translation.is_some());
        let entry = Entry {
            when: now.clone(),
            who,
            what,
            place,
            thing,
            translated_into: self.translated_into.clone().filter(|_| translated),
        };

        files.append_jsonl(JOURNAL, &json!(entry))
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

    /// The journal's newest lines, as many as a person sees, newest first:
    /// a line that does not read is passed over and said.
    fn journal(&mut self, files: &dyn LeasedFiles) -> Result<Vec<Entry>, StoreError> {
        let lines = files.read_jsonl(JOURNAL)?;

        Ok(lines
            .iter()
            .rev()
            .take(NEWEST_LINES)
            .filter_map(|line| match Entry::deserialize(line) {
                Ok(entry) => Some(entry),
                Err(error) => {
                    self.passed_over.push(format!(
                        "a line of the journal does not read, and was passed over: {error}"
                    ));
                    None
                }
            })
            .collect())
    }

    /// A place of the world's new to it, called `name` as she wrote it, with
    /// an id the world makes and the plainest look.
    fn found(&mut self, name: &str) -> Result<Place, WorldError> {
        let name = trimmed_name(name).ok_or(WorldError::Name)?;

        if self.places.len() >= MOST_PLACES {
            return Err(WorldError::NoRoomForPlace);
        }

        let place = Place {
            id: self.new_place_id(name.as_str()),
            name: name.as_str().to_owned(),
            icon: PLAIN_ICON.to_owned(),
            tint: PLAIN_TINT.to_owned(),
            translation: None,
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

/// `text` as a name, its ends trimmed: none unless one line of 1 to 128
/// characters is left.
fn trimmed_name(text: &str) -> Option<SpeakerName> {
    SpeakerName::new(text.trim()).ok()
}

/// Whether words kept for the person while their setting said `kept`, the
/// language they chose, none for Automatic, are theirs while it says
/// `theirs`: on Automatic, whatever was kept is.
fn current(kept: Option<&LanguageTag>, theirs: Option<&LanguageTag>) -> bool {
    theirs.is_none_or(|theirs| {
        kept.is_some_and(|kept| kept.as_str().eq_ignore_ascii_case(theirs.as_str()))
    })
}

/// A note as it is kept, its line endings `\n` and its ends trimmed;
/// refused when nothing is left or it is longer than a note may be.
fn written(note: &str) -> Result<String, LeaveError> {
    VisibleText::normalize(note)
        .ok()
        .map(|note| note.as_str().to_owned())
        .filter(|note| note.chars().count() <= MOST_NOTE)
        .ok_or(LeaveError::Note)
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

    /// What the person leaves, as they wrote it.
    fn leaving(name: &str, kind: &str, note: Option<&str>) -> Leaving {
        Leaving::new(name, kind, note).unwrap()
    }

    fn tag(tag: &str) -> LanguageTag {
        LanguageTag::parse(tag).unwrap()
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
            assert!(matches!(
                Leaving::new(name, "gift", None),
                Err(LeaveError::Name)
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
        let Err(left) = world.leave(
            &mut files,
            "flat",
            leaving("One more", "gift", None),
            &morning(),
        ) else {
            panic!("the flat is full for the person too");
        };

        assert_eq!(
            [full.to_string(), left.to_string()],
            ["The Flat has room for no more things: it holds 64"; 2]
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

    #[test]
    fn a_thing_the_person_leaves_is_new_to_each_character_until_she_is_told_of_it_where_it_is() {
        let mut files = Files::default();
        let mut world = LivingWorld::read(&mut files, &port(), &morning()).unwrap();
        let juno = Identifier::new("juno").unwrap();
        let crane = world
            .make(&mut files, &mira(), "Paper crane", Kind::OTHER, &morning())
            .unwrap()
            .thing;
        let honey = world
            .leave(
                &mut files,
                "flat",
                leaving("Honey", "food", Some("For your toast.")),
                &morning(),
            )
            .unwrap();

        world
            .leave(
                &mut files,
                "studio",
                leaving("Scarf", "clothing", None),
                &morning(),
            )
            .unwrap();

        // What she is told of says what was new to her then.
        let new = |here: Here, her: &Identifier| -> Vec<String> {
            here.things
                .iter()
                .filter(|thing| thing.is_new_to(her))
                .map(|thing| thing.name().to_owned())
                .collect()
        };
        let none: [&str; 0] = [];

        assert_eq!(
            new(
                world.here(&mut files, &mira(), &morning()).unwrap(),
                &mira()
            ),
            ["Honey"]
        );
        assert_eq!(
            new(
                world.here(&mut files, &mira(), &morning()).unwrap(),
                &mira()
            ),
            none
        );
        assert_eq!(
            new(world.here(&mut files, &juno, &morning()).unwrap(), &juno),
            ["Honey"]
        );
        assert_eq!(
            new(
                world.go(&mut files, &mira(), "studio", &morning()).unwrap(),
                &mira()
            ),
            ["Scarf"]
        );
        assert_eq!(
            new(
                world.go(&mut files, &mira(), "studio", &morning()).unwrap(),
                &mira()
            ),
            none
        );
        assert!(!crane.is_new_to(&mira()) && !crane.is_new_to(&juno));
        assert_eq!(
            files.documents["places/flat.json"]["things"][3],
            json!({
                "id": honey.id(),
                "name": "Honey",
                "icon": "fork",
                "tint": "orange",
                "from": "person",
                "came": "2026-11-26T09:00:00.000Z",
                "note": "For your toast.",
                "seen": ["mira", "juno"],
            })
        );
        assert_eq!(
            files.documents["places/studio.json"]["things"][1]["seen"],
            json!(["mira"])
        );
    }

    #[test]
    fn what_the_person_leaves_is_of_a_kind_with_a_note_of_1_to_280_characters() {
        let mut files = Files::default();
        let mut world = LivingWorld::read(&mut files, &port(), &morning()).unwrap();
        let (longest, longer) = ("n".repeat(280), "n".repeat(281));
        let mut left = |kind: &str, note: Option<&str>| {
            Leaving::new("A gift", kind, note)
                .and_then(|leaving| world.leave(&mut files, "flat", leaving, &morning()))
        };

        for (kind, note, refusal) in [
            ("vase", None, "there is no kind of thing \"vase\""),
            (
                "gift",
                Some(" \r\n "),
                "a note is not blank, and is 280 characters at most",
            ),
            (
                "gift",
                Some(longer.as_str()),
                "a note is not blank, and is 280 characters at most",
            ),
        ] {
            assert_eq!(left(kind, note).unwrap_err().to_string(), refusal);
        }

        let letter = left("letter", Some("  Dear Mira,\r\nEnjoy.\n")).unwrap();
        let other = left("other", Some(longest.as_str())).unwrap();

        assert_eq!(
            (letter.icon(), letter.tint(), letter.from(), letter.note()),
            (
                "envelope",
                "teal",
                &Hand::Person,
                Some("Dear Mira,\nEnjoy.")
            )
        );
        assert_eq!(
            (other.icon(), other.note()),
            ("grid", Some(longest.as_str()))
        );
    }

    #[test]
    fn what_the_person_leaves_is_kept_in_her_words_with_theirs_beside_each_that_is_not_theirs() {
        let mut files = Files::default();
        let mut world = LivingWorld::read(&mut files, &port(), &morning()).unwrap();
        let honey = leaving("A jar of honey", "food", Some("For your toast."));
        let mut left = |hers: [&str; 2]| {
            honey
                .clone()
                .in_her_language(hers.map(str::to_owned).to_vec())
                .and_then(|leaving| world.leave(&mut files, "flat", leaving, &morning()))
        };
        let translated = left([" ハチミツの瓶 ", "トーストに\r\nどうぞ。"]).unwrap();
        let named = left(["ハチミツ", "For your toast."]).unwrap();

        for (hers, refusal) in [
            (["ハチミツの\n瓶", "どうぞ。"], "a name is one line"),
            (
                ["ハチミツ", &"ど".repeat(281)],
                "a note is not blank, and is 280 characters at most",
            ),
        ] {
            let refused = left(hers).unwrap_err().to_string();

            assert!(refused.starts_with(refusal), "{refused}");
        }

        assert_eq!(
            (translated.name(), translated.note(), translated.written()),
            (
                "ハチミツの瓶",
                Some("トーストに\nどうぞ。"),
                &Written {
                    name: Some("A jar of honey".to_owned()),
                    note: Some("For your toast.".to_owned()),
                }
            )
        );
        assert_eq!(
            files.documents["places/flat.json"]["things"][2]["written"],
            json!({"name": "A jar of honey", "note": "For your toast."})
        );
        assert_eq!(
            files.logs[JOURNAL][0]["thing"],
            json!({"id": translated.id(), "name": "ハチミツの瓶", "written": "A jar of honey"}),
            "its line keeps what the person wrote beside her words"
        );
        assert_eq!(
            (named.note(), named.written().note.as_deref()),
            (Some("For your toast."), None)
        );
        assert_eq!(
            files.documents["places/flat.json"]["things"]
                .as_array()
                .map(Vec::len),
            Some(4),
            "what her words broke the rules of was not left"
        );
    }

    #[test]
    fn the_persons_words_for_names_are_made_again_in_another_language_they_choose_and_stand_on_automatic()
     {
        // The names of the world's that no words of the person's are kept
        // for, while they read `theirs`.
        fn untranslated(
            world: &mut LivingWorld,
            files: &mut Files,
            theirs: Option<&LanguageTag>,
        ) -> Vec<String> {
            let view = world.view(files, &mira(), theirs, &morning()).unwrap();

            view.untranslated().into_iter().map(str::to_owned).collect()
        }

        fn keep(
            world: &mut LivingWorld,
            files: &mut Files,
            words: &[(&str, &str)],
            theirs: Option<&LanguageTag>,
        ) {
            let words = words
                .iter()
                .map(|(name, theirs)| ((*name).to_owned(), (*theirs).to_owned()))
                .collect();

            world.keep_translations(files, &words, theirs).unwrap();
        }

        let mut files = Files::default();
        let mut world = LivingWorld::read(&mut files, &port(), &morning()).unwrap();
        let (german, french) = (tag("de"), tag("fr"));
        let every = [
            "The Port",
            "The Flat",
            "Teapot",
            "Bike",
            "The Studio",
            "Proofs",
        ];

        world
            .leave(
                &mut files,
                "flat",
                leaving("Honig", "food", None),
                &morning(),
            )
            .unwrap();
        assert_eq!(
            untranslated(&mut world, &mut files, Some(&german)),
            every,
            "the person's own words are never made"
        );

        keep(
            &mut world,
            &mut files,
            &[
                ("The Port", "Der Hafen"),
                ("The Flat", "Die Wohnung"),
                ("Teapot", "Teekanne"),
                ("Bike", "Fahrrad"),
                ("The Studio", "Das Studio"),
                ("Proofs", "Probedrucke"),
            ],
            Some(&german),
        );

        let kept = world
            .view(&mut files, &mira(), Some(&tag("DE")), &morning())
            .unwrap();
        let (flat, things) = &kept.places[0];

        assert_eq!(
            (
                kept.translation.as_deref(),
                flat.translation(),
                things[0].translation()
            ),
            (Some("Der Hafen"), Some("Die Wohnung"), Some("Teekanne"))
        );
        assert_eq!(files.documents[WORLD]["translatedInto"], json!("de"));
        assert_eq!(
            untranslated(&mut world, &mut files, None),
            [] as [&str; 0],
            "on Automatic, the words kept stand"
        );

        assert_eq!(untranslated(&mut world, &mut files, Some(&french)), every);

        keep(
            &mut world,
            &mut files,
            &[("The Port", "Le Port")],
            Some(&french),
        );
        assert_eq!(
            untranslated(&mut world, &mut files, Some(&french)),
            every[1..],
            "the German words not made again in French are let go"
        );

        keep(&mut world, &mut files, &[("Bike", "Vélo")], None);
        assert_eq!(
            untranslated(&mut world, &mut files, None),
            ["The Flat", "Teapot", "The Studio", "Proofs"]
        );
        assert_eq!(
            untranslated(&mut world, &mut files, Some(&french)),
            every,
            "words made on Automatic are made again once a language is chosen"
        );
    }

    #[test]
    fn a_journal_line_keeps_the_persons_words_its_names_had_while_they_read_that_language() {
        // The place each line of the journal names, newest first, with the
        // person's words for it, while they read `theirs`.
        fn places(
            world: &mut LivingWorld,
            files: &mut Files,
            theirs: Option<&LanguageTag>,
        ) -> Vec<(String, Option<String>)> {
            let view = world.view(files, &mira(), theirs, &morning()).unwrap();

            view.journal
                .into_iter()
                .map(|line| (line.place.name, line.place.translation))
                .collect()
        }

        let mut files = Files::default();
        let mut world = LivingWorld::read(&mut files, &port(), &morning()).unwrap();
        let german = tag("de");
        let words = BTreeMap::from(
            [("The Flat", "Die Wohnung"), ("Teapot", "Teekanne")]
                .map(|(name, theirs)| (name.to_owned(), theirs.to_owned())),
        );

        world
            .keep_translations(&mut files, &words, Some(&german))
            .unwrap();

        let teapot = world
            .use_thing(&mut files, &mira(), "Teapot", &morning())
            .unwrap()
            .thing;

        world.go(&mut files, &mira(), "studio", &morning()).unwrap();
        assert_eq!(
            files.logs[JOURNAL],
            [
                json!({
                    "when": "2026-11-26T09:00:00.000Z",
                    "who": {"character": "mira"},
                    "what": "used",
                    "place": {"id": "flat", "name": "The Flat", "translation": "Die Wohnung"},
                    "thing": {"id": teapot.id(), "name": "Teapot", "translation": "Teekanne"},
                    "translatedInto": "de",
                }),
                json!({
                    "when": "2026-11-26T09:00:00.000Z",
                    "who": {"character": "mira"},
                    "what": "went",
                    "place": {"id": "studio", "name": "The Studio"},
                }),
            ]
        );

        let flat = ("The Flat".to_owned(), Some("Die Wohnung".to_owned()));
        let studio = ("The Studio".to_owned(), None);

        assert_eq!(
            places(&mut world, &mut files, Some(&german)),
            [studio.clone(), flat.clone()]
        );
        assert_eq!(places(&mut world, &mut files, None), [studio.clone(), flat]);
        assert_eq!(
            places(&mut world, &mut files, Some(&tag("fr"))),
            [studio, ("The Flat".to_owned(), None)]
        );
    }

    #[test]
    fn the_view_holds_its_places_in_order_who_is_where_and_the_newest_journal_lines_first() {
        let mut files = Files::default();
        let mut world = LivingWorld::read(&mut files, &port(), &morning()).unwrap();
        let noon = at("2026-11-26T12:00:00.000Z");
        // Each place by its id, with what is in it.
        let places = |view: &View| -> Vec<String> {
            view.places
                .iter()
                .map(|(place, things)| {
                    let things: Vec<&str> = things.iter().map(Thing::name).collect();

                    format!("{}: {}", place.id(), things.join("; "))
                })
                .collect()
        };
        let fresh = world.view(&mut files, &mira(), None, &morning()).unwrap();
        let teapot = fresh.places[0].1[0].id().to_owned();

        assert_eq!(fresh.name, "The Port");
        assert_eq!(places(&fresh), ["flat: Teapot; Bike", "studio: Proofs"]);
        assert_eq!(fresh.journal, []);

        world
            .make(&mut files, &mira(), "Toast", Kind::OTHER, &noon)
            .unwrap();
        world
            .leave(&mut files, "studio", leaving("Honey", "food", None), &noon)
            .unwrap();
        world.remove(&mut files, &teapot, &noon).unwrap();

        let view = world.view(&mut files, &mira(), None, &noon).unwrap();

        assert_eq!(
            places(&view),
            ["flat: Bike; Toast", "studio: Proofs; Honey"]
        );
        assert_eq!(
            view.characters,
            BTreeMap::from([(
                mira(),
                Whereabouts {
                    place: Identifier::new("flat").unwrap(),
                    since: morning(),
                }
            )])
        );
        assert_eq!(
            view.journal
                .iter()
                .map(|entry| (
                    entry.who.clone(),
                    entry.what,
                    entry.thing.as_ref().map(|thing| thing.name.as_str())
                ))
                .collect::<Vec<_>>(),
            [
                (Hand::Person, Deed::Removed, Some("Teapot")),
                (Hand::Person, Deed::Left, Some("Honey")),
                (Hand::Character(mira()), Deed::Made, Some("Toast")),
            ]
        );

        let journal = files.logs.get_mut(JOURNAL).unwrap();

        for place in 0..199 {
            journal.push(json!({
                "when": noon,
                "who": {"character": "mira"},
                "what": "went",
                "place": {"id": format!("place-{place}"), "name": format!("Place {place}")},
            }));
        }

        journal.push(Value::Null);

        let mut world = LivingWorld::read(&mut files, &port(), &noon).unwrap();
        let journal = world
            .view(&mut files, &mira(), None, &noon)
            .unwrap()
            .journal;

        assert_eq!(
            (
                journal.len(),
                journal[0].place.name.as_str(),
                journal[198].place.name.as_str()
            ),
            (199, "Place 198", "Place 0")
        );
        assert_eq!(
            world.passed_over(),
            [
                "a line of the journal does not read, and was passed over: invalid type: null, \
              expected struct Entry"
            ]
        );
    }
}
