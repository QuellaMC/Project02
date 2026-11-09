//! The character-state package: how the character is right now, five
//! aspects of her own inner state, shown to her before each turn and
//! changed by her alone through one tool. Each accepted patch is a line of
//! her log, `events.jsonl`, the one truth of the state; `checkpoint.json`
//! holds what the log folds to, so a read folds nothing. The checkpoint is
//! a cache: one the log has outgrown, none, or one that does not read is
//! folded anew from the log, and a line of the log that is no patch is
//! passed over and said.

use std::sync::Arc;

use async_trait::async_trait;
use p02_contracts::{
    BeforeRoleModelCallOutput, ContextItem, ContextItemKind, EvidenceKind, EvidenceNote,
    EvidenceStatus, FactoryInput, FileStore, HookContext, LeasedStore, PluginError, ProvidedTool,
    RuntimePlugin, ToolCall, ToolCallOutcome,
};
use p02_shared::Identifier;
use serde_json::{Map, Value, json};

use crate::package::{FilesError, leased, tool};

const TOOL: &str = "character_state.patch";
const EVENTS: &str = "events.jsonl";
const CHECKPOINT: &str = "checkpoint.json";

/// The version of `checkpoint.json` this build writes. One of a newer
/// version fails closed and is left as it is, since its build may write a
/// log this one cannot fold.
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

/// Where folding the log ends: the state, and how many of its lines were
/// no patch.
#[derive(Clone, Copy, Debug)]
struct Folded {
    state: State,
    passed_over: usize,
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
        let folded = leased(store(context)?, |files| {
            let (folded, checkpointed) = current(files)?;

            if !checkpointed {
                write_checkpoint(files, folded.state)?;
            }

            Ok(folded)
        })
        .await?;
        let note = Identifier::new("current")
            .map_err(|error| PluginError::with_source("the state note needs an id", error))?;
        let evidence = match folded.passed_over {
            0 => EvidenceNote::new(
                EvidenceKind::BeforeRoleModelCall,
                EvidenceStatus::Accepted,
                "Provided current Character State context.",
            ),
            lines => EvidenceNote::new(
                EvidenceKind::BeforeRoleModelCall,
                EvidenceStatus::Degraded,
                format!(
                    "Provided current Character State context, passing over {lines} line(s) of \
                     {EVENTS} that are no patch."
                ),
            ),
        };

        Ok(BeforeRoleModelCallOutput {
            context_items: vec![ContextItem::new(
                note,
                ContextItemKind::RuntimeNote,
                folded.state.note(),
            )],
            curated_sections: Vec::new(),
            evidence: vec![evidence],
        })
    }

    async fn handle_tool_call(
        &self,
        call: &ToolCall,
        context: &HookContext,
    ) -> Result<ToolCallOutcome, PluginError> {
        let patch = Patch::from_input(call.input()).map_err(PluginError::new)?;
        let (event, call_id) = (
            context.turn().event.event_id().to_string(),
            call.call_id().to_string(),
        );
        let (before, after) = leased(store(context)?, move |files| {
            let (folded, _) = current(files)?;
            let after = folded.state.patched(patch);

            files.append_jsonl(EVENTS, &line(&event, &call_id, patch, folded.state, after))?;
            write_checkpoint(files, after)?;
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

/// What the log folds to now: the checkpoint's, while it reads and nothing
/// was written after it, or else the log folded anew; and whether the
/// checkpoint said it.
fn current(files: &LeasedStore<'_>) -> Result<(Folded, bool), FilesError> {
    if let Some(state) = checkpointed(files)? {
        return Ok((
            Folded {
                state,
                passed_over: 0,
            },
            true,
        ));
    }

    Ok((fold(&files.read_jsonl(EVENTS)?), false))
}

/// The state the checkpoint holds, while it reads and was written at the
/// store's revision; it is refused only when a newer build wrote it.
fn checkpointed(files: &LeasedStore<'_>) -> Result<Option<State>, FilesError> {
    let Ok(Some(checkpoint)) = files.read_json(CHECKPOINT) else {
        return Ok(None);
    };

    if checkpoint
        .get("version")
        .and_then(Value::as_u64)
        .is_some_and(|version| version > CHECKPOINT_VERSION)
    {
        return Err(FilesError::Damaged(format!(
            "Character State {CHECKPOINT} is of a version this build does not read, so it is \
             left as it is."
        )));
    }

    let written_at = checkpoint.get("storeRevision").and_then(Value::as_u64);

    Ok(if written_at == Some(files.revision()?) {
        checkpoint.get("state").and_then(State::from_value)
    } else {
        None
    })
}

/// The log folded line by line, each patch onto the state before it in the
/// order the lines were written; a line that is no patch is passed over,
/// and counted.
fn fold(lines: &[Value]) -> Folded {
    let mut folded = Folded {
        state: State::initial(),
        passed_over: 0,
    };

    for line in lines {
        match patch_of(line) {
            Some(patch) => folded.state = folded.state.patched(patch),
            None => folded.passed_over += 1,
        }
    }

    folded
}

/// The patch a line of the log records.
fn patch_of(line: &Value) -> Option<Patch> {
    Patch::from_input(line.get("input")?.as_object()?).ok()
}

/// A patch's line: the call it came from, the patch as the call gave it,
/// and the state it found and left.
fn line(event: &str, call: &str, patch: Patch, before: State, after: State) -> Value {
    json!({
        "eventId": event,
        "callId": call,
        "input": patch.to_value(),
        "before": before.to_value(),
        "after": after.to_value(),
    })
}

/// Writes the checkpoint of `state`, naming the store's revision once it
/// lands, which any later write moves on.
fn write_checkpoint(files: &mut LeasedStore<'_>, state: State) -> Result<(), FilesError> {
    let revision = files.revision()? + 1;

    files.write_json(
        CHECKPOINT,
        &json!({
            "version": CHECKPOINT_VERSION,
            "storeRevision": revision,
            "state": state.to_value(),
        }),
    )?;
    Ok(())
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

    /// A state as the checkpoint keeps it: every aspect at a value it takes.
    fn from_value(value: &Value) -> Option<Self> {
        let fields = value.as_object()?;
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
