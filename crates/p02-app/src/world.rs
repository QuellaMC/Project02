//! The world a character lives in as a client reads it, from the home's
//! files of it whether she runs or not: everything a person sees of it;
//! and the person's hand in it, a thing left in a place with a note, and a
//! thing removed, whoever it is from. Each is their own act, which asks
//! nobody, made under a lease of the world's files, and each that changed
//! the world says so on the stream. Nothing tells her: she finds what was
//! left when she is next told what is around her there.
//!
//! While her translator stands between her and the person, by the rule
//! that says so for their messages, her world is in her language and the
//! person reads it in theirs: what they leave is put into hers before it is
//! left, and a read gives each name they did not write with their words for
//! it, made in one request when first needed and kept with her world. No
//! model is asked while the world's files are leased.

use std::collections::BTreeMap;
use std::sync::Arc;

use p02_characters::{Discovery, discover};
use p02_config::{CharacterSettings, HostSettings};
use p02_contracts::{FileStoreBackend, LeasedFiles, RoleModelAdapter};
use p02_core::{LanguageTag, Timestamp};
use p02_shared::{Identifier, error_chain, error_sentence, sentence};
use p02_wire::{
    Event, LeaveThingBody, LeaveThingOutcome, LeaveThingRefusal, RemoveThingOutcome,
    RemoveThingRefusal, WorldCharacter, WorldDeed, WorldEntry, WorldHand, WorldKind, WorldNamed,
    WorldOutcome, WorldPlace, WorldRefusal, WorldThing, WorldView, WorldWords,
};
use p02_world::{
    Deed, Entry, Hand, Kind, LeaveError, Leaving, LivingWorld, Named, RemoveError, Thing, View,
    WORLD_PLUGIN, WorldDefinition,
};

use crate::character::{plan_sign_in, translator};
use crate::daemon::{Daemon, World, blocking};
use crate::history;
use crate::outcome::Changed;
use crate::phone::lease;
use crate::reconcile::{runs, settings_now};
use crate::translator::Between;

/// Why her world was not reached, in a sentence: the daemon knows no such
/// character, she has none, or its files failed.
enum Unreached {
    UnknownCharacter(String),
    NoWorld(String),
    Failed(String),
}

/// The world a character lives in, as the daemon reaches it whether she
/// runs or not: her id, the world her package brings, its files in the
/// home, which her calls to its tools lease too, the language the person
/// chose to read, none for Automatic, and her translator, while one stands
/// between her and the person.
struct HerWorld {
    id: Identifier,
    world: WorldDefinition,
    files: Arc<dyn FileStoreBackend>,
    theirs: Option<LanguageTag>,
    translator: Option<WorldTranslator>,
}

/// Her translator as her world has it: who it is between, and her
/// settings, which say the model it asks.
struct WorldTranslator {
    between: Between,
    host: HostSettings,
}

impl Daemon {
    /// The world `character` lives in as it stands, read from the home's
    /// files of it on the blocking pool under their lease, she at its first
    /// place while she has none there yet; while her translator stands
    /// between her and the person, with their words for its names, those
    /// missing made first.
    pub async fn world_of(&self, character: &str) -> WorldOutcome {
        let (her, discovery) = match self.her_world(character).await {
            Ok(found) => found,
            Err(unreached) => return WorldOutcome::from(unreached),
        };
        let read = Arc::clone(&her);
        let view = match blocking(move || read.view()).await {
            Ok(view) => view,
            Err(unreached) => return WorldOutcome::from(unreached),
        };
        let view = match &her.translator {
            Some(translator) if !view.untranslated().is_empty() => {
                self.translated(&her, translator, view).await
            }
            _ => view,
        };

        WorldOutcome::Ok(shown(&her, view, &discovery))
    }

    /// Leaves `thing` in a place of the world `character` lives in, from
    /// the person, in her language: new to her until she is next told what
    /// is there.
    pub async fn leave_thing(&self, character: &str, thing: LeaveThingBody) -> LeaveThingOutcome {
        let her = match self.her_world(character).await {
            Ok((her, _)) => her,
            Err(unreached) => return LeaveThingOutcome::from(unreached),
        };
        let leaving = match Leaving::new(&thing.name, &thing.kind, thing.note.as_deref()) {
            Ok(leaving) => leaving,
            Err(refusal) => return not_left(&refusal),
        };
        let leaving = match &her.translator {
            Some(translator) => match self.in_her_language(translator, leaving).await {
                Ok(leaving) => leaving,
                Err(reason) => return not_translated(&reason),
            },
            None => leaving,
        };
        let place = thing.place;

        self.change_world(her, move |her| {
            her.with(
                |living, files, now| match living.leave(files, &place, leaving, now) {
                    Ok(left) => Ok(LeaveThingOutcome::Ok {
                        thing: Box::new(drawn(&left, false)),
                    }),
                    Err(LeaveError::Store(error)) => Err(Unreached::Failed(unreached(&error))),
                    Err(refusal) => Ok(not_left(&refusal)),
                },
            )
        })
        .await
    }

    /// Removes the thing of id `thing` from the world `character` lives
    /// in, wherever it is and whoever it is from.
    pub async fn remove_thing(&self, character: &str, thing: &str) -> RemoveThingOutcome {
        let her = match self.her_world(character).await {
            Ok((her, _)) => her,
            Err(unreached) => return RemoveThingOutcome::from(unreached),
        };
        let thing = thing.to_owned();

        self.change_world(her, move |her| {
            her.with(
                |living, files, now| match living.remove(files, &thing, now) {
                    Ok(()) => Ok(RemoveThingOutcome::Ok),
                    Err(RemoveError::Store(error)) => Err(Unreached::Failed(unreached(&error))),
                    Err(refusal @ RemoveError::NoThing { .. }) => Ok(RemoveThingOutcome::Refused {
                        reason: RemoveThingRefusal::UnknownThing,
                        message: sentence(&refusal.to_string()),
                    }),
                },
            )
        })
        .await
    }

    /// The world `character` lives in, as the daemon reaches it now, and
    /// the characters the home has, read on the blocking pool.
    async fn her_world(&self, character: &str) -> Result<(Arc<HerWorld>, Discovery), Unreached> {
        let world = Arc::clone(self.world());
        let character = character.to_owned();

        blocking(move || {
            let discovery = discover(world.home.root());
            let her = HerWorld::of(&world, &discovery, &character)?;

            Ok((Arc::new(her), discovery))
        })
        .await
    }

    /// What `work` makes of `her` world on the blocking pool; when it
    /// changed the world, the stream says so, in the same piece of work,
    /// which a caller that stops waiting does not cut in two.
    async fn change_world<T: Changed + From<Unreached> + Send + 'static>(
        &self,
        her: Arc<HerWorld>,
        work: impl FnOnce(&HerWorld) -> Result<T, Unreached> + Send + 'static,
    ) -> T {
        let world = Arc::clone(self.world());

        blocking(move || {
            let outcome = work(&her).unwrap_or_else(T::from);

            if outcome.changed() {
                world.events.emit(Event::WorldChanged {
                    world: her.world.id().clone(),
                });
            }

            outcome
        })
        .await
    }

    /// `leaving` in her language, put into it by `translator` in one
    /// request; or why it could not be, in a sentence.
    async fn in_her_language(
        &self,
        translator: &WorldTranslator,
        leaving: Leaving,
    ) -> Result<Leaving, String> {
        let model = translator.model(self)?;
        let hers = translator
            .between
            .words_for_her(model.as_ref(), &leaving.words())
            .await?;

        leaving
            .in_her_language(hers)
            .map_err(|broken| broken.to_string())
    }

    /// `view` with the person's words for its names that have none yet,
    /// made by `translator` in one request with no lease held and kept with
    /// `her` world, which is then read again; `view` as it is when they
    /// cannot be, which her maintenance note says, the next read trying
    /// again.
    async fn translated(
        &self,
        her: &Arc<HerWorld>,
        translator: &WorldTranslator,
        view: View,
    ) -> View {
        let names: Vec<String> = view.untranslated().into_iter().map(str::to_owned).collect();
        let made = match self.words_for_person(her, translator, &names).await {
            Ok(words) => {
                let translations: BTreeMap<String, String> = names.into_iter().zip(words).collect();
                let kept = Arc::clone(her);

                blocking(move || kept.keep(&translations))
                    .await
                    .map_err(Unreached::said)
            }
            Err(reason) => Err(reason),
        };

        made.unwrap_or_else(|reason| {
            self.note_maintenance(&her.id, translator.between.world_untranslated(&reason));
            view
        })
    }

    /// `names` of `her` world put into the person's language by
    /// `translator`, which reads their newest message as they wrote it
    /// while they read the language it shows; or why they could not be, in
    /// a sentence.
    async fn words_for_person(
        &self,
        her: &HerWorld,
        translator: &WorldTranslator,
        names: &[String],
    ) -> Result<Vec<String>, String> {
        let model = translator.model(self)?;
        let newest = if her.theirs.is_none() {
            let (home, id) = (self.world().home.clone(), her.id.clone());

            blocking(move || history::person_wrote(&home, &id)).await
        } else {
            None
        };
        let names: Vec<&str> = names.iter().map(String::as_str).collect();

        translator
            .between
            .words_for_person(model.as_ref(), &names, newest.as_ref())
            .await
    }
}

impl WorldTranslator {
    /// The model it asks, as her settings have it now, through `daemon`; or
    /// what it needs for one.
    fn model(&self, daemon: &Daemon) -> Result<Arc<dyn RoleModelAdapter>, String> {
        let world = daemon.world();

        translator(
            world,
            &daemon.downgrade(),
            &self.host,
            plan_sign_in(world, &self.host).as_ref(),
        )
    }
}

impl Unreached {
    /// The sentence that says why.
    fn said(self) -> String {
        match self {
            Self::UnknownCharacter(message) | Self::NoWorld(message) | Self::Failed(message) => {
                message
            }
        }
    }
}

impl HerWorld {
    /// The world the character `character` of `discovery` lives in, in the
    /// home of `world`: her package must bring one, and her settings run
    /// it; settings that cannot be read do not take it from her, since her
    /// start says what is wrong with them. Her translator stands between
    /// her and the person while her settings say so, by the rule that says
    /// so for their messages.
    fn of(world: &World, discovery: &Discovery, character: &str) -> Result<Self, Unreached> {
        let definition = discovery
            .find(character)
            .map_err(|error| Unreached::UnknownCharacter(error_sentence(&error)))?;
        let settings = settings_now(world, definition);
        let hers = definition
            .world
            .as_ref()
            .filter(|_| runs(settings.as_ref(), WORLD_PLUGIN))
            .ok_or_else(|| {
                Unreached::NoWorld(format!("{} has no world.", definition.profile.display_name))
            })?;
        let host = settings.as_ref().map(CharacterSettings::host);

        Ok(Self {
            id: definition.profile.id.clone(),
            world: hers.clone(),
            files: world.home.world_files(hers.id()),
            theirs: host.and_then(|host| host.user_language.clone()),
            translator: host.and_then(|host| {
                Some(WorldTranslator {
                    between: Between::of(host, definition.profile.display_name.clone())?,
                    host: host.clone(),
                })
            }),
        })
    }

    /// Everything a person sees of her world now, she at its first place
    /// while she has none there yet.
    fn view(&self) -> Result<View, Unreached> {
        self.with(|living, files, now| {
            living
                .view(files, &self.id, self.theirs.as_ref(), now)
                .map_err(|error| Unreached::Failed(unreached(&error)))
        })
    }

    /// Keeps `translations`, the person's words for names of her world, by
    /// the name each is for, and reads her world again.
    fn keep(&self, translations: &BTreeMap<String, String>) -> Result<View, Unreached> {
        self.with(|living, files, now| {
            living
                .keep_translations(files, translations, self.theirs.as_ref())
                .and_then(|()| living.view(files, &self.id, self.theirs.as_ref(), now))
                .map_err(|error| Unreached::Failed(unreached(&error)))
        })
    }

    /// What `work` makes of her world now, read as its files keep it under
    /// their lease, on the calling thread, which waits on the disk.
    fn with<T>(
        &self,
        work: impl FnOnce(&mut LivingWorld, &mut dyn LeasedFiles, &Timestamp) -> Result<T, Unreached>,
    ) -> Result<T, Unreached> {
        let failed = |error: &dyn std::error::Error| Unreached::Failed(unreached(error));
        let now = Timestamp::now();
        let mut files = lease(self.files.as_ref()).map_err(|error| failed(&error))?;
        let mut living =
            LivingWorld::read(files.as_mut(), &self.world, &now).map_err(|error| failed(&error))?;

        work(&mut living, files.as_mut(), &now)
    }
}

/// `her` world as `view` holds it, for a person to see: each character
/// there that `discovery` holds, by her display name, the kinds a thing can
/// be left as, and each name and note with the person's form of it, their
/// words for it only while her translator stands between them.
fn shown(her: &HerWorld, view: View, discovery: &Discovery) -> WorldView {
    let translated = her.translator.is_some();
    let places: Vec<WorldPlace> = view
        .places
        .into_iter()
        .map(|(place, things)| WorldPlace {
            id: place.id().clone(),
            name: words(
                place.name(),
                None,
                place.translation().filter(|_| translated),
            ),
            icon: place.icon().to_owned(),
            tint: place.tint().to_owned(),
            things: things
                .iter()
                .map(|thing| drawn(thing, translated))
                .collect(),
        })
        .collect();
    let journal = view
        .journal
        .into_iter()
        .map(|line| entry(line, &places, translated))
        .collect();

    WorldView {
        id: her.world.id().clone(),
        name: words(
            &view.name,
            None,
            view.translation.as_deref().filter(|_| translated),
        ),
        places,
        characters: view
            .characters
            .into_iter()
            .filter_map(|(id, whereabouts)| {
                let definition = discovery
                    .characters
                    .iter()
                    .find(|definition| definition.profile.id == id)?;

                Some(WorldCharacter {
                    display_name: definition.profile.display_name.clone(),
                    id,
                    place: whereabouts.place,
                    since: whereabouts.since,
                })
            })
            .collect(),
        journal,
        kinds: Kind::ALL
            .iter()
            .map(|kind| WorldKind {
                id: Identifier::new(kind.name()).expect("a kind's name is an identifier"),
                name: kind.display_name().to_owned(),
                icon: kind.icon().to_owned(),
                tint: kind.tint().to_owned(),
            })
            .collect(),
    }
}

/// A thing her world did not take from the person, in the sentence they
/// read; her world's files failing is no refusal.
fn not_left(refusal: &LeaveError) -> LeaveThingOutcome {
    let reason = match refusal {
        LeaveError::NoPlace { .. } => LeaveThingRefusal::UnknownPlace,
        LeaveError::Name => LeaveThingRefusal::InvalidName,
        LeaveError::NoKind { .. } => LeaveThingRefusal::UnknownKind,
        LeaveError::Note => LeaveThingRefusal::InvalidNote,
        LeaveError::NoRoom { .. } => LeaveThingRefusal::NoRoom,
        LeaveError::Store(error) => {
            return LeaveThingOutcome::Failed {
                message: unreached(error),
            };
        }
    };

    LeaveThingOutcome::Refused {
        reason,
        message: sentence(&refusal.to_string()),
    }
}

/// A thing not left, since its words could not be put into her language,
/// for `reason`: as the person's line that could not be is refused.
fn not_translated(reason: &str) -> LeaveThingOutcome {
    LeaveThingOutcome::Refused {
        reason: LeaveThingRefusal::NotTranslated,
        message: sentence(&format!(
            "It was not left, because it could not be put into her language: {reason}"
        )),
    }
}

/// `thing` as a person sees it: its name and its note with what they wrote
/// of each, and the person's words for its name while `translated`.
fn drawn(thing: &Thing, translated: bool) -> WorldThing {
    WorldThing {
        id: thing.id().to_owned(),
        name: words(
            thing.name(),
            thing.written().name.as_deref(),
            thing.translation().filter(|_| translated),
        ),
        icon: thing.icon().to_owned(),
        tint: thing.tint().to_owned(),
        from: hand(thing.from()),
        came: thing.came().clone(),
        note: thing
            .note()
            .map(|note| words(note, thing.written().note.as_deref(), None)),
        seen: thing.seen().to_vec(),
    }
}

/// A name or a note as the person reads it: `text`, as her world has it,
/// with what they wrote of it, or their words for it unless those are
/// `text` again.
fn words(text: &str, written: Option<&str>, translation: Option<&str>) -> WorldWords {
    WorldWords {
        text: text.to_owned(),
        written: written.map(str::to_owned),
        translation: translation
            .filter(|translation| *translation != text)
            .map(str::to_owned),
    }
}

fn hand(hand: &Hand) -> WorldHand {
    match hand {
        Hand::World => WorldHand::World,
        Hand::Person => WorldHand::Person,
        Hand::Character(id) => WorldHand::Character { id: id.clone() },
    }
}

/// A line of the journal as a person sees it: by the names it was written
/// with, each with the person's form it kept of that name, their words for
/// it only while `translated`; or, where it kept none, the person's form of
/// the place or the thing of its id among `places` while it goes by that
/// name.
fn entry(entry: Entry, places: &[WorldPlace], translated: bool) -> WorldEntry {
    let place = places
        .iter()
        .find(|place| place.id.as_str() == entry.place.id)
        .map(|place| &place.name);
    let thing = entry.thing.as_ref().and_then(|thing| {
        places
            .iter()
            .flat_map(|place| &place.things)
            .find(|held| held.id == thing.id)
            .map(|held| &held.name)
    });

    WorldEntry {
        when: entry.when,
        who: hand(&entry.who),
        what: match entry.what {
            Deed::Went => WorldDeed::Went,
            Deed::Made => WorldDeed::Made,
            Deed::Used => WorldDeed::Used,
            Deed::Left => WorldDeed::Left,
            Deed::Removed => WorldDeed::Removed,
        },
        place: named(entry.place, place, translated),
        thing: entry
            .thing
            .map(|named_thing| named(named_thing, thing, translated)),
    }
}

/// `named` as a line of the journal gives it: by the name it had then, with
/// the person's form it kept of that name, their words for it only while
/// `translated`; or, where it kept none, that of `now`, its words in the
/// world now, while they are of that name.
fn named(named: Named, now: Option<&WorldWords>, translated: bool) -> WorldNamed {
    let translation = named.translation.filter(|_| translated);
    let (written, translation) = if named.written.is_some() || translation.is_some() {
        (named.written, translation)
    } else {
        now.filter(|now| now.text == named.name)
            .map(|now| (now.written.clone(), now.translation.clone()))
            .unwrap_or_default()
    };

    WorldNamed {
        id: named.id,
        name: words(&named.name, written.as_deref(), translation.as_deref()),
    }
}

/// Why her world could not be reached, in a sentence: `error` and its
/// causes.
fn unreached(error: &dyn std::error::Error) -> String {
    sentence(&format!(
        "her world could not be reached: {}",
        error_chain(error)
    ))
}

impl Changed for LeaveThingOutcome {
    fn changed(&self) -> bool {
        matches!(self, Self::Ok { .. })
    }
}

impl Changed for RemoveThingOutcome {
    fn changed(&self) -> bool {
        matches!(self, Self::Ok)
    }
}

impl From<Unreached> for WorldOutcome {
    fn from(unreached: Unreached) -> Self {
        match unreached {
            Unreached::UnknownCharacter(message) => Self::Refused {
                reason: WorldRefusal::UnknownCharacter,
                message,
            },
            Unreached::NoWorld(message) => Self::Refused {
                reason: WorldRefusal::NoWorld,
                message,
            },
            Unreached::Failed(message) => Self::Failed { message },
        }
    }
}

impl From<Unreached> for LeaveThingOutcome {
    fn from(unreached: Unreached) -> Self {
        match unreached {
            Unreached::UnknownCharacter(message) => Self::Refused {
                reason: LeaveThingRefusal::UnknownCharacter,
                message,
            },
            Unreached::NoWorld(message) => Self::Refused {
                reason: LeaveThingRefusal::NoWorld,
                message,
            },
            Unreached::Failed(message) => Self::Failed { message },
        }
    }
}

impl From<Unreached> for RemoveThingOutcome {
    fn from(unreached: Unreached) -> Self {
        match unreached {
            Unreached::UnknownCharacter(message) => Self::Refused {
                reason: RemoveThingRefusal::UnknownCharacter,
                message,
            },
            Unreached::NoWorld(message) => Self::Refused {
                reason: RemoveThingRefusal::NoWorld,
                message,
            },
            Unreached::Failed(message) => Self::Failed { message },
        }
    }
}
