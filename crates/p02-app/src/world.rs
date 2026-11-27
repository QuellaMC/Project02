//! The world a character lives in as a client reads it, from the home's
//! files of it whether she runs or not: everything a person sees of it;
//! and the person's hand in it, a thing left in a place with a note, and a
//! thing removed, whoever it is from. Each is their own act, which asks
//! nobody, made under a lease of the world's files, and each that changed
//! the world says so on the stream. Nothing tells her: she finds what was
//! left when she is next told what is around her there.

use std::sync::Arc;

use p02_characters::{Discovery, discover};
use p02_contracts::{FileStoreBackend, LeasedFiles};
use p02_core::Timestamp;
use p02_shared::{Identifier, error_chain, error_sentence, sentence};
use p02_wire::{
    Event, LeaveThingBody, LeaveThingOutcome, LeaveThingRefusal, RemoveThingOutcome,
    RemoveThingRefusal, WorldCharacter, WorldDeed, WorldEntry, WorldHand, WorldKind, WorldNamed,
    WorldOutcome, WorldPlace, WorldRefusal, WorldThing, WorldView,
};
use p02_world::{
    Deed, Entry, Hand, Kind, LeaveError, LivingWorld, Named, RemoveError, Thing, View,
    WORLD_PLUGIN, WorldDefinition,
};

use crate::daemon::{Daemon, World, blocking};
use crate::outcome::Changed;
use crate::phone::lease;
use crate::reconcile::runs;

/// Why her world was not reached, in a sentence: the daemon knows no such
/// character, she has none, or its files failed.
enum Unreached {
    UnknownCharacter(String),
    NoWorld(String),
    Failed(String),
}

/// The world a character lives in, as the daemon reaches it whether she
/// runs or not: her id, the world her package brings, and its files in the
/// home, which her calls to its tools lease too.
struct HerWorld {
    id: Identifier,
    world: WorldDefinition,
    files: Arc<dyn FileStoreBackend>,
}

impl Daemon {
    /// The world `character` lives in as it stands, read from the home's
    /// files of it on the blocking pool under their lease, she at its first
    /// place while she has none there yet.
    pub async fn world_of(&self, character: &str) -> WorldOutcome {
        let world = Arc::clone(self.world());
        let character = character.to_owned();

        blocking(move || -> Result<WorldOutcome, Unreached> {
            let discovery = discover(world.home.root());
            let her = HerWorld::of(&world, &discovery, &character)?;
            let view = her.with(|living, files, now| {
                living
                    .view(files, &her.id, now)
                    .map_err(|error| Unreached::Failed(unreached(&error)))
            })?;

            Ok(WorldOutcome::Ok(shown(her.world.id(), view, &discovery)))
        })
        .await
        .unwrap_or_else(WorldOutcome::from)
    }

    /// Leaves `thing` in a place of the world `character` lives in, from
    /// the person: new to her until she is next told what is there.
    pub async fn leave_thing(&self, character: &str, thing: LeaveThingBody) -> LeaveThingOutcome {
        self.change_world(character, move |her| {
            her.with(|living, files, now| {
                match living.leave(
                    files,
                    &thing.place,
                    &thing.name,
                    &thing.kind,
                    thing.note.as_deref(),
                    now,
                ) {
                    Ok(left) => Ok(LeaveThingOutcome::Ok {
                        thing: drawn(&left),
                    }),
                    Err(refusal) => not_left(&refusal),
                }
            })
        })
        .await
    }

    /// Removes the thing of id `thing` from the world `character` lives
    /// in, wherever it is and whoever it is from.
    pub async fn remove_thing(&self, character: &str, thing: &str) -> RemoveThingOutcome {
        let thing = thing.to_owned();

        self.change_world(character, move |her| {
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

    /// What `work` makes of the world `character` lives in on the blocking
    /// pool; when it changed the world, the stream says so, in the same
    /// piece of work, which a caller that stops waiting does not cut in two.
    async fn change_world<T: Changed + From<Unreached> + Send + 'static>(
        &self,
        character: &str,
        work: impl FnOnce(&HerWorld) -> Result<T, Unreached> + Send + 'static,
    ) -> T {
        let world = Arc::clone(self.world());
        let character = character.to_owned();

        blocking(move || {
            let her = match HerWorld::of(&world, &discover(world.home.root()), &character) {
                Ok(her) => her,
                Err(unreached) => return T::from(unreached),
            };
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
}

impl HerWorld {
    /// The world the character `character` of `discovery` lives in, in the
    /// home of `world`: her package must bring one, and her settings run
    /// it; settings that cannot be read do not take it from her, since her
    /// start says what is wrong with them.
    fn of(world: &World, discovery: &Discovery, character: &str) -> Result<Self, Unreached> {
        let definition = discovery
            .find(character)
            .map_err(|error| Unreached::UnknownCharacter(error_sentence(&error)))?;
        let hers = definition
            .world
            .as_ref()
            .filter(|_| runs(world, definition, WORLD_PLUGIN))
            .ok_or_else(|| {
                Unreached::NoWorld(format!("{} has no world.", definition.profile.display_name))
            })?;

        Ok(Self {
            id: definition.profile.id.clone(),
            world: hers.clone(),
            files: world.home.world_files(hers.id()),
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

/// The world of id `id` as `view` holds it, for a person to see: each
/// character there that `discovery` holds, by her display name, and the
/// kinds a thing can be left as.
fn shown(id: &Identifier, view: View, discovery: &Discovery) -> WorldView {
    WorldView {
        id: id.clone(),
        name: view.name,
        places: view
            .places
            .into_iter()
            .map(|(place, things)| WorldPlace {
                id: place.id().clone(),
                name: place.name().to_owned(),
                icon: place.icon().to_owned(),
                tint: place.tint().to_owned(),
                things: things.iter().map(drawn).collect(),
            })
            .collect(),
        characters: view
            .characters
            .into_iter()
            .filter_map(|(her, whereabouts)| {
                let definition = discovery
                    .characters
                    .iter()
                    .find(|definition| definition.profile.id == her)?;

                Some(WorldCharacter {
                    display_name: definition.profile.display_name.clone(),
                    id: her,
                    place: whereabouts.place,
                    since: whereabouts.since,
                })
            })
            .collect(),
        journal: view.journal.into_iter().map(entry).collect(),
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
fn not_left(refusal: &LeaveError) -> Result<LeaveThingOutcome, Unreached> {
    let reason = match refusal {
        LeaveError::NoPlace { .. } => LeaveThingRefusal::UnknownPlace,
        LeaveError::Name => LeaveThingRefusal::InvalidName,
        LeaveError::NoKind { .. } => LeaveThingRefusal::UnknownKind,
        LeaveError::Note => LeaveThingRefusal::InvalidNote,
        LeaveError::NoRoom { .. } => LeaveThingRefusal::NoRoom,
        LeaveError::Store(error) => return Err(Unreached::Failed(unreached(error))),
    };

    Ok(LeaveThingOutcome::Refused {
        reason,
        message: sentence(&refusal.to_string()),
    })
}

/// `thing` as a person sees it.
fn drawn(thing: &Thing) -> WorldThing {
    WorldThing {
        id: thing.id().to_owned(),
        name: thing.name().to_owned(),
        icon: thing.icon().to_owned(),
        tint: thing.tint().to_owned(),
        from: hand(thing.from()),
        came: thing.came().clone(),
        note: thing.note().map(str::to_owned),
        seen: thing.seen().to_vec(),
    }
}

fn hand(hand: &Hand) -> WorldHand {
    match hand {
        Hand::World => WorldHand::World,
        Hand::Person => WorldHand::Person,
        Hand::Character(id) => WorldHand::Character { id: id.clone() },
    }
}

/// A line of the journal as a person sees it.
fn entry(entry: Entry) -> WorldEntry {
    let named = |Named { id, name }| WorldNamed { id, name };

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
        place: named(entry.place),
        thing: entry.thing.map(named),
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
