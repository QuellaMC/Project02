//! The world package: the world she lives in, which her package brings and
//! the home keeps. Its store is that world's files in the home, which her
//! host hands it in the place of a store of her own. Before each model call
//! she is told where she is, what is there and where else she can go, and
//! her tools let her go somewhere, make something where she is and use
//! something there, each read and written under the lease of the hook that
//! calls it.

use std::sync::Arc;

use async_trait::async_trait;
use p02_contracts::{
    BeforeRoleModelCallOutput, ContextItem, ContextItemKind, EvidenceKind, EvidenceNote,
    EvidenceStatus, FactoryInput, FileStore, HookContext, LeasedStore, PluginError, ProvidedTool,
    RuntimePlugin, ToolCall, ToolCallOutcome,
};
use p02_core::Timestamp;
use p02_shared::{Identifier, error_chain, sentence};
use p02_world::{Here, Kind, LivingWorld, Place, Thing, WORLD_PLUGIN, WorldDefinition, WorldError};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::host::Factory;
use crate::package::{admitted, leased, rejected, tool};

const GO: &str = "world.go";
const MAKE: &str = "world.make";
const USE: &str = "world.use";

const GO_DESCRIPTION: &str =
    "Go somewhere in your world: a place by its id, or a name for somewhere new.";
const MAKE_DESCRIPTION: &str = "Make something where you are. It stays there.";
const USE_DESCRIPTION: &str = "Use something that is where you are.";
const NAMED: &str = "What it is called.";

/// What she reads when her world's files fail.
const UNAVAILABLE: &str = "Your world could not be reached just now.";

/// The list's factory of the world, which a host builds itself, handing it
/// the world her package brings and that world's files: built anywhere
/// else, it is refused.
pub(crate) fn create(_input: &FactoryInput<'_>) -> Result<Arc<dyn RuntimePlugin>, PluginError> {
    Err(PluginError::new(format!(
        "{WORLD_PLUGIN} is built by the plugin host, which hands it the world her package brings \
         and that world's files"
    )))
}

/// How a host builds the world her package brings, `world`.
pub(crate) fn factory(world: WorldDefinition) -> Box<Factory> {
    Box::new(move |_input: &FactoryInput<'_>| {
        let kinds: Vec<&str> = Kind::ALL.iter().map(|kind| kind.name()).collect();

        Ok(Arc::new(WorldPlugin {
            world: world.clone(),
            tools: vec![
                tool(
                    GO,
                    GO_DESCRIPTION,
                    json!({
                        "type": "object",
                        "properties": {
                            "place": {
                                "type": "string",
                                "description": "The place's id, or a name for somewhere new.",
                            },
                        },
                        "required": ["place"],
                        "additionalProperties": false,
                    }),
                )?,
                tool(
                    MAKE,
                    MAKE_DESCRIPTION,
                    json!({
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": NAMED},
                            "kind": {
                                "type": "string",
                                "description": "What kind of thing it is; other when you give \
                                                none.",
                                "enum": kinds,
                            },
                        },
                        "required": ["name"],
                        "additionalProperties": false,
                    }),
                )?,
                tool(
                    USE,
                    USE_DESCRIPTION,
                    json!({
                        "type": "object",
                        "properties": {"thing": {"type": "string", "description": NAMED}},
                        "required": ["thing"],
                        "additionalProperties": false,
                    }),
                )?,
            ],
        }) as Arc<dyn RuntimePlugin>)
    })
}

#[derive(Debug)]
struct WorldPlugin {
    /// The world her package brings, which the home's is made from the
    /// first time it is read.
    world: WorldDefinition,
    tools: Vec<ProvidedTool>,
}

/// A call of one of her tools, its input as the tool's contract admits it.
enum Request {
    Go(Going),
    Make(Making),
    Use(Using),
}

#[derive(Deserialize)]
struct Going {
    place: String,
}

#[derive(Deserialize)]
struct Making {
    name: String,
    kind: Option<String>,
}

#[derive(Deserialize)]
struct Using {
    thing: String,
}

/// What a call of hers came to: what she reads, its record, and what of
/// her world's files was passed over.
struct Answered {
    output: Value,
    summary: String,
    passed_over: Vec<String>,
}

#[async_trait]
impl RuntimePlugin for WorldPlugin {
    fn provided_tools(&self) -> &[ProvidedTool] {
        &self.tools
    }

    /// Says where she is, what is there, where else she can go and how she
    /// goes, makes and uses; telling her is what puts her at the world's
    /// first place while she has none there yet.
    async fn before_role_model_call(
        &self,
        context: &HookContext,
    ) -> Result<BeforeRoleModelCallOutput, PluginError> {
        let (world, her, now) = (
            self.world.clone(),
            context.turn()?.character.id.clone(),
            Timestamp::now(),
        );
        let (here, passed_over) = leased(store(context)?, move |files| {
            let mut living = LivingWorld::read(files, &world, &now)?;
            let here = living.here(files, &her, &now)?;

            Ok((here, living.passed_over().to_vec()))
        })
        .await?;
        let note = Identifier::new("here").map_err(|error| {
            PluginError::with_source("the note of where she is needs an id", error)
        })?;

        Ok(BeforeRoleModelCallOutput {
            context_items: vec![ContextItem::new(
                note,
                ContextItemKind::RuntimeNote,
                noted(&here),
            )],
            curated_sections: Vec::new(),
            evidence: vec![evidence(
                EvidenceKind::BeforeRoleModelCall,
                "Told her where she is in her world.".to_owned(),
                &passed_over,
            )],
        })
    }

    /// Answers a call of hers under a lease of her world's files: what she
    /// did there, or, refused, why not, in a sentence she reads.
    async fn handle_tool_call(
        &self,
        call: &ToolCall,
        context: &HookContext,
    ) -> Result<ToolCallOutcome, PluginError> {
        let request = Request::of(call)?;
        let (world, her, now) = (
            self.world.clone(),
            context.turn()?.character.id.clone(),
            Timestamp::now(),
        );
        let ran = leased(store(context)?, move |files| {
            Ok(request.run(files, &world, &her, &now))
        })
        .await;

        Ok(match ran {
            Ok(Ok(Answered {
                output,
                summary,
                passed_over,
            })) => ToolCallOutcome::Accepted {
                output,
                evidence: vec![evidence(
                    EvidenceKind::ToolInvocation,
                    summary,
                    &passed_over,
                )],
            },
            Ok(Err(refusal)) => refused(&refusal),
            Err(failure) => unavailable(&failure),
        })
    }
}

impl Request {
    fn of(call: &ToolCall) -> Result<Self, PluginError> {
        match call.tool_name().as_str() {
            GO => admitted(call).map(Self::Go),
            MAKE => admitted(call).map(Self::Make),
            USE => admitted(call).map(Self::Use),
            other => Err(PluginError::new(format!(
                "the world answers no tool \"{other}\""
            ))),
        }
    }

    /// What the call comes to in the world `world` makes, as `files` keep
    /// it, for `her`, at `now`.
    fn run(
        self,
        files: &mut LeasedStore<'_>,
        world: &WorldDefinition,
        her: &Identifier,
        now: &Timestamp,
    ) -> Result<Answered, WorldError> {
        let mut living = LivingWorld::read(files, world, now)?;
        let (output, summary) = match self {
            Self::Go(Going { place }) => {
                let here = living.go(files, her, &place, now)?;

                (
                    json!({
                        "place": named(&here.place),
                        "here": here
                            .things
                            .iter()
                            .map(|thing| json!({"name": thing.name()}))
                            .collect::<Vec<_>>(),
                    }),
                    format!("Went to \"{}\" in her world.", here.place.id()),
                )
            }
            Self::Make(Making { name, kind }) => {
                let kind = kind.as_deref().and_then(Kind::named).unwrap_or(Kind::OTHER);
                let made = living.make(files, her, &name, kind, now)?;

                (
                    json!({
                        "made": {"name": made.thing.name(), "kind": kind.name()},
                        "place": named(&made.place),
                    }),
                    format!(
                        "Made \"{}\" in \"{}\" in her world.",
                        made.thing.name(),
                        made.place.id()
                    ),
                )
            }
            Self::Use(Using { thing }) => {
                let used = living.use_thing(files, her, &thing, now)?;

                (
                    json!({"used": {"name": used.thing.name()}}),
                    format!(
                        "Used \"{}\" in \"{}\" in her world.",
                        used.thing.name(),
                        used.place.id()
                    ),
                )
            }
        };

        Ok(Answered {
            output,
            summary,
            passed_over: living.passed_over().to_vec(),
        })
    }
}

fn store(context: &HookContext) -> Result<FileStore, PluginError> {
    context.character_file_store().cloned().ok_or_else(|| {
        PluginError::new("World needs the world's files, which its manifest requests as its store")
    })
}

/// A place as she reads of it: its id and its name.
fn named(place: &Place) -> Value {
    json!({"id": place.id(), "name": place.name()})
}

/// What she knows of where she is: the place, what is there, the other
/// places, each by its name and its id, and how she goes, makes and uses.
fn noted(here: &Here) -> String {
    let mut note = vec![format!("You are in {}.", here.place.name())];

    if !here.things.is_empty() {
        let things: Vec<&str> = here.things.iter().map(Thing::name).collect();

        note.push(format!("Here: {}.", things.join("; ")));
    }

    let others: Vec<String> = here
        .others
        .iter()
        .map(|place| format!("{} (\"{}\")", place.name(), place.id()))
        .collect();

    note.push(match either(&others) {
        None => "You can go somewhere else from here.".to_owned(),
        Some(places) => format!("From here you can go to {places}, or somewhere else."),
    });
    note.push(format!(
        "To go, {GO}; to make something where you are, {MAKE}; to use something that is here, \
         {USE}."
    ));
    note.join(" ")
}

/// `options` as a choice of them is said: `A`, `A or B`, `A, B or C`; none
/// when there are none.
fn either(options: &[String]) -> Option<String> {
    let (last, rest) = options.split_last()?;

    Some(if rest.is_empty() {
        last.clone()
    } else {
        format!("{} or {last}", rest.join(", "))
    })
}

/// The record of a hook that stood, and what of her world's files it passed
/// over, which makes it degraded.
fn evidence(kind: EvidenceKind, summary: String, passed_over: &[String]) -> EvidenceNote {
    if passed_over.is_empty() {
        EvidenceNote::new(kind, EvidenceStatus::Accepted, summary)
    } else {
        EvidenceNote::new(
            kind,
            EvidenceStatus::Degraded,
            passed_over
                .iter()
                .fold(summary, |said, why| format!("{said} {}", sentence(why))),
        )
    }
}

/// A call her world refused, in the sentence she reads, with what is where
/// she is when what she named is not.
fn refused(refusal: &WorldError) -> ToolCallOutcome {
    let reason = match refusal {
        WorldError::Name => "invalid_name",
        WorldError::NoRoomForPlace | WorldError::NoRoomForThing { .. } => "no_room",
        WorldError::NotHere { .. } => "thing_not_found",
        WorldError::Store(error) => return unavailable(error),
    };
    let said = sentence(&refusal.to_string());
    let message = match refusal {
        WorldError::NotHere { here, .. } if here.is_empty() => format!("{said} Nothing is here."),
        WorldError::NotHere { here, .. } => format!("{said} Here: {}.", here.join("; ")),
        _ => said,
    };

    rejected(reason, message.clone(), &message)
}

/// A call her world's files failed, said to her plainly, and why in its
/// record.
fn unavailable(failure: &dyn std::error::Error) -> ToolCallOutcome {
    rejected(
        "world_unavailable",
        UNAVAILABLE.to_owned(),
        &format!(
            "Her world's files failed: {}",
            sentence(&error_chain(failure))
        ),
    )
}
