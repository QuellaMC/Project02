//! The character-state package: how the character is right now, five
//! aspects of her own inner state, shown to her before each turn and
//! changed by her alone through one tool. Each accepted patch is a line of
//! her log, `events.jsonl`, the one truth of the state; `checkpoint.json`
//! holds what the log folds to, so a read folds nothing, and a checkpoint
//! the log has outgrown, or none, is folded anew from the log.

use std::collections::BTreeSet;
use std::sync::Arc;

use async_trait::async_trait;
use p02_contracts::{
    BeforeRoleModelCallOutput, ContextItem, ContextItemKind, EvidenceKind, EvidenceNote,
    EvidenceStatus, FactoryInput, FileStore, HookContext, LeasedStore, PluginError, ProvidedTool,
    RuntimePlugin, ToolCall, ToolCallOutcome,
};
use p02_shared::Identifier;
use serde_json::{Map, Value, json};

use crate::package::{FilesError, leased, rejected, tool};

const TOOL: &str = "character_state.patch";
const EVENTS: &str = "events.jsonl";
const CHECKPOINT: &str = "checkpoint.json";

/// The version of `checkpoint.json` this build writes and reads. One of
/// another version fails closed and is left as it is, since a newer build
/// may still read it.
const CHECKPOINT_VERSION: u64 = 1;

const DESCRIPTION: &str = "Adjust how you are right now — your own mood, energy, attention, \
     activity, or social orientation (yours, never theirs). Call it when the conversation \
     genuinely shifts something in you.";

/// One aspect of the state: its field in a patch and in the files, the
/// word the note gives it, what the model is told of it, the values it
/// takes, and its value before any patch.
struct Aspect {
    field: &'static str,
    word: &'static str,
    description: &'static str,
    values: &'static [&'static str],
    initial: &'static str,
}

/// The aspects, in the order the note names them.
const ASPECTS: [Aspect; 5] = [
    Aspect {
        field: "mood",
        word: "mood",
        description: "Your own mood right now (yours, never theirs).",
        values: &["steady", "curious", "concerned", "playful", "tired"],
        initial: "steady",
    },
    Aspect {
        field: "energy",
        word: "energy",
        description: "Your own energy right now (yours, never theirs).",
        values: &["low", "medium", "high"],
        initial: "medium",
    },
    Aspect {
        field: "attention",
        word: "attention",
        description: "Where your attention is right now.",
        values: &["present", "focused", "distracted"],
        initial: "present",
    },
    Aspect {
        field: "currentActivity",
        word: "activity",
        description: "What you are doing right now.",
        values: &["idle", "chatting", "reflecting"],
        initial: "idle",
    },
    Aspect {
        field: "socialOrientation",
        word: "social",
        description: "How open to company you feel right now.",
        values: &["open", "supportive", "reserved"],
        initial: "open",
    },
];

/// The package's factory: it reads no config.
pub(crate) fn create(_input: &FactoryInput<'_>) -> Result<Arc<dyn RuntimePlugin>, PluginError> {
    let properties: Map<String, Value> = ASPECTS
        .iter()
        .map(|aspect| {
            (
                aspect.field.to_owned(),
                json!({"type": "string", "description": aspect.description, "enum": aspect.values}),
            )
        })
        .collect();

    // Each aspect's values are the contract's, so the host refuses any
    // other before the plugin sees it; the tool runs alone, so a round's
    // patches land in the order the model made them.
    Ok(Arc::new(CharacterStatePlugin {
        tools: vec![tool(
            TOOL,
            DESCRIPTION,
            json!({
                "type": "object",
                "properties": properties,
                "required": [],
                "additionalProperties": false,
            }),
        )?],
    }))
}

#[derive(Debug)]
struct CharacterStatePlugin {
    tools: Vec<ProvidedTool>,
}

/// One value of each aspect, in the order of [`ASPECTS`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct State([&'static str; 5]);

/// What a patch sets: a value for some of the aspects.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Patch([Option<&'static str>; 5]);

/// Where folding the log ends: the state, and how many patches it folds.
#[derive(Clone, Copy, Debug)]
struct Folded {
    state: State,
    events: u64,
}

/// The call a patch came from, which names its line in the log once
/// however often a crash wrote it there.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Identity {
    event: String,
    call: String,
}

#[async_trait]
impl RuntimePlugin for CharacterStatePlugin {
    fn provided_tools(&self) -> &[ProvidedTool] {
        &self.tools
    }

    async fn before_role_model_call(
        &self,
        context: &HookContext,
    ) -> Result<BeforeRoleModelCallOutput, PluginError> {
        let state = leased(store(context)?, |files| {
            let (folded, checkpointed) = current(files)?;

            if !checkpointed {
                write_checkpoint(files, folded)?;
            }

            Ok(folded.state)
        })
        .await?;
        let note = Identifier::new("character-state.current")
            .map_err(|error| PluginError::with_source("the state note needs an id", error))?;

        Ok(BeforeRoleModelCallOutput {
            context_items: vec![ContextItem::new(
                note,
                ContextItemKind::RuntimeNote,
                state.note(),
            )],
            curated_sections: Vec::new(),
            evidence: vec![EvidenceNote::new(
                EvidenceKind::BeforeRoleModelCall,
                EvidenceStatus::Accepted,
                "Provided current Character State context.",
            )],
        })
    }

    async fn handle_tool_call(
        &self,
        call: &ToolCall,
        context: &HookContext,
    ) -> Result<ToolCallOutcome, PluginError> {
        let patch = match Patch::from_input(call.input()) {
            Ok(patch) => patch,
            Err(message) => return Ok(rejected("invalid_state_value", message.clone(), &message)),
        };
        let identity = Identity {
            event: context.turn().event.event_id().to_string(),
            call: call.call_id().to_string(),
        };
        let (before, after) = leased(store(context)?, move |files| {
            let (folded, _) = current(files)?;
            let after = folded.state.patched(patch);

            files.append_jsonl(EVENTS, &line(&identity, patch, folded.state, after))?;
            write_checkpoint(
                files,
                Folded {
                    state: after,
                    events: folded.events + 1,
                },
            )?;
            Ok((folded.state, after))
        })
        .await?;
        let changes = before.changes(after);
        let summary = if changes.is_empty() {
            "Recorded a Character State patch that changed nothing.".to_owned()
        } else {
            format!("Applied {} Character State change(s).", changes.len())
        };

        Ok(ToolCallOutcome::Accepted {
            output: json!({
                "status": "accepted",
                "current": after.to_value(),
                "appliedChanges": changes,
            }),
            evidence: vec![EvidenceNote::new(
                EvidenceKind::ToolInvocation,
                EvidenceStatus::Accepted,
                summary,
            )],
        })
    }
}

fn store(context: &HookContext) -> Result<FileStore, PluginError> {
    context.character_file_store().cloned().ok_or_else(|| {
        PluginError::new("Character State needs the character file store its manifest requests")
    })
}

/// What the log folds to now: the checkpoint's, while nothing was written
/// after it, or else the log folded anew; and whether the checkpoint said
/// it.
fn current(files: &LeasedStore<'_>) -> Result<(Folded, bool), FilesError> {
    let revision = files.revision()?;

    if let Some(document) = files.read_json(CHECKPOINT)? {
        let (folded, written_at) = checkpoint(&document)?;

        if written_at == revision {
            return Ok((folded, true));
        }
    }

    Ok((fold(&files.read_jsonl(EVENTS)?)?, false))
}

/// The log folded line by line, each patch onto the state before it in the
/// order the lines were written; a patch whose call an earlier line already
/// named counts once, where it first stands.
fn fold(lines: &[Value]) -> Result<Folded, FilesError> {
    let mut seen = BTreeSet::new();
    let mut folded = Folded {
        state: State::initial(),
        events: 0,
    };

    for (at, line) in lines.iter().enumerate() {
        let (identity, patch) = event(line).ok_or_else(|| {
            FilesError::Damaged(format!(
                "Character State {EVENTS} line {} is not a patch it wrote.",
                at + 1
            ))
        })?;

        if seen.insert(identity) {
            folded.state = folded.state.patched(patch);
            folded.events += 1;
        }
    }

    Ok(folded)
}

/// A patch's line: the call it came from, the patch as the call gave it,
/// and the state it found and left.
fn line(identity: &Identity, patch: Patch, before: State, after: State) -> Value {
    json!({
        "eventId": identity.event,
        "callId": identity.call,
        "input": patch.to_value(),
        "before": before.to_value(),
        "after": after.to_value(),
    })
}

/// The call and the patch of a line, when it is one the plugin writes:
/// every key, and a state left that is the state found with the patch.
fn event(line: &Value) -> Option<(Identity, Patch)> {
    let fields = line.as_object().filter(|fields| fields.len() == 5)?;
    let text = |key: &str| {
        fields
            .get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    let identity = Identity {
        event: text("eventId")?,
        call: text("callId")?,
    };
    let patch = Patch::from_input(fields.get("input")?.as_object()?).ok()?;
    let before = State::from_value(fields.get("before")?)?;
    let after = State::from_value(fields.get("after")?)?;

    (before.patched(patch) == after).then_some((identity, patch))
}

/// Writes the checkpoint of `folded`, naming the store's revision once it
/// lands, which any later write moves on.
fn write_checkpoint(files: &mut LeasedStore<'_>, folded: Folded) -> Result<(), FilesError> {
    let revision = files.revision()? + 1;

    // The state sits under `current.current`, where the conformance suite
    // reads it in the files of either daemon.
    files.write_json(
        CHECKPOINT,
        &json!({
            "version": CHECKPOINT_VERSION,
            "eventCount": folded.events,
            "storeRevision": revision,
            "current": {"current": folded.state.to_value()},
        }),
    )?;
    Ok(())
}

/// What a checkpoint holds, and the store's revision it was written at.
fn checkpoint(document: &Value) -> Result<(Folded, u64), FilesError> {
    let damaged = || FilesError::Damaged(format!("Character State {CHECKPOINT} is damaged."));
    let fields = document.as_object().ok_or_else(damaged)?;

    match fields.get("version").and_then(Value::as_u64) {
        Some(CHECKPOINT_VERSION) => {}
        _ => {
            return Err(FilesError::Damaged(format!(
                "Character State {CHECKPOINT} is of a version this build does not read, so it \
                 is left as it is."
            )));
        }
    }

    let number = |key: &str| fields.get(key).and_then(Value::as_u64);
    let state = fields
        .get("current")
        .and_then(Value::as_object)
        .filter(|current| current.len() == 1)
        .and_then(|current| current.get("current"))
        .and_then(State::from_value);

    match (
        fields.len(),
        number("eventCount"),
        number("storeRevision"),
        state,
    ) {
        (4, Some(events), Some(revision), Some(state)) => Ok((Folded { state, events }, revision)),
        _ => Err(damaged()),
    }
}

impl Aspect {
    /// `value`, when it is one this aspect takes.
    fn value(&self, value: &Value) -> Option<&'static str> {
        let text = value.as_str()?;

        self.values
            .iter()
            .copied()
            .find(|candidate| *candidate == text)
    }
}

impl State {
    fn initial() -> Self {
        Self(ASPECTS.map(|aspect| aspect.initial))
    }

    fn patched(self, patch: Patch) -> Self {
        let mut values = self.0;

        for (value, set) in values.iter_mut().zip(patch.0) {
            if let Some(set) = set {
                *value = set;
            }
        }

        Self(values)
    }

    fn note(self) -> String {
        let aspects: Vec<String> = ASPECTS
            .iter()
            .zip(self.0)
            .map(|(aspect, value)| format!("{}={value}", aspect.word))
            .collect();

        format!(
            "How you are right now (your own inner state, not theirs): {}",
            aspects.join("; ")
        )
    }

    /// What each aspect `after` holds otherwise than this state.
    fn changes(self, after: Self) -> Vec<Value> {
        ASPECTS
            .iter()
            .zip(self.0.into_iter().zip(after.0))
            .filter(|(_, (before, after))| before != after)
            .map(|(aspect, (before, after))| {
                json!({"field": aspect.field, "before": before, "after": after})
            })
            .collect()
    }

    fn to_value(self) -> Value {
        Value::Object(
            ASPECTS
                .iter()
                .zip(self.0)
                .map(|(aspect, value)| (aspect.field.to_owned(), Value::from(value)))
                .collect(),
        )
    }

    /// A state as the files keep it: each aspect once, at a value it takes.
    fn from_value(value: &Value) -> Option<Self> {
        let fields = value
            .as_object()
            .filter(|fields| fields.len() == ASPECTS.len())?;
        let mut state = Self::initial();

        for (value, aspect) in state.0.iter_mut().zip(&ASPECTS) {
            *value = aspect.value(fields.get(aspect.field)?)?;
        }

        Some(state)
    }
}

impl Patch {
    /// The patch `input` spells, each field an aspect's at a value it
    /// takes; else the sentence the model is told.
    fn from_input(input: &Map<String, Value>) -> Result<Self, String> {
        let mut patch = Self::default();

        for (field, value) in input {
            let at = ASPECTS
                .iter()
                .position(|aspect| aspect.field == field)
                .ok_or_else(|| format!("{TOOL} field \"{field}\" is not one of your state."))?;

            patch.0[at] = Some(ASPECTS[at].value(value).ok_or_else(|| {
                format!("{TOOL} field \"{field}\" has unsupported value {value}.")
            })?);
        }

        Ok(patch)
    }

    fn to_value(self) -> Value {
        Value::Object(
            ASPECTS
                .iter()
                .zip(self.0)
                .filter_map(|(aspect, value)| Some((aspect.field.to_owned(), Value::from(value?))))
                .collect(),
        )
    }
}
