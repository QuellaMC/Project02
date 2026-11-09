//! The character-memory package: two small notebooks the character keeps
//! herself, notes to herself and what she knows about the person, shown in
//! full in her trusted frame and changed by her through one tool, a batch
//! at a time and every operation of it or none. What she reads is taken
//! once per session, so a change shows from her next session and the frame
//! stays the same bytes meanwhile.

use std::num::NonZeroU32;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use async_trait::async_trait;
use p02_contracts::{
    BeforeRoleModelCallOutput, CuratedSection, EvidenceKind, EvidenceNote, EvidenceStatus,
    FactoryInput, FileStore, HookContext, LeasedStore, PluginError, ProvidedTool, RuntimePlugin,
    StoreError, ToolCall, ToolCallOutcome, contains_forbidden_control_character,
};
use p02_core::SessionId;
use p02_shared::Identifier;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::package::{FilesError, leased, rejected, tool};

const TOOL: &str = "memory.update";
const STORE: &str = "memory.json";

/// The version of `memory.json` this build writes and reads.
const STORE_VERSION: u64 = 1;

/// How many operations one batch holds.
const OPERATIONS: u64 = 8;

/// The line between two entries as the frame shows a target, which counts
/// against its capacity.
const SEPARATOR: &str = "\n§\n";

const DESCRIPTION: &str = "Update your notes — what you carry from one conversation to the next \
     (you see them at the start of every conversation as 'What you carry between \
     conversations'). Save stable facts worth keeping: what they like and correct you on, facts \
     about their world, conventions, how they work. Skip passing task details and anything easily \
     found again. add appends an entry; replace and remove pick exactly one existing entry by a \
     unique old_text substring. New notes appear from your next conversation on; a full notebook \
     rejects the batch, so tighten or drop stale entries first.";

/// The package's factory: it reads no config.
pub(crate) fn create(_input: &FactoryInput<'_>) -> Result<Arc<dyn RuntimePlugin>, PluginError> {
    let longest = Target::ALL
        .map(Target::capacity)
        .into_iter()
        .fold(0, usize::max);
    let text = json!({
        "type": "string",
        "minLength": 1,
        "maxLength": longest,
        "description": "Full entry text to store.",
    });
    let target = json!({
        "type": "string",
        "enum": Target::ALL.map(Target::name),
        "description": "notes holds what you want to remember; user_profile holds what you know \
                        about them.",
    });
    let old_text = json!({
        "type": "string",
        "minLength": 1,
        "maxLength": longest,
        "description": "Substring selecting exactly one existing entry; ambiguity rejects the \
                        batch.",
    });

    // The tool runs alone, so a round's batches land in the order the model
    // made them.
    Ok(Arc::new(CharacterMemoryPlugin {
        tools: vec![tool(
            TOOL,
            DESCRIPTION,
            json!({
                "type": "object",
                "properties": {
                    "operations": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": OPERATIONS,
                        "description": "Atomic batch: every operation commits or none do.",
                        "items": {
                            "oneOf": [
                                {
                                    "type": "object",
                                    "properties": {
                                        "action": {"type": "string", "enum": ["add"]},
                                        "target": target,
                                        "text": text,
                                    },
                                    "required": ["action", "target", "text"],
                                    "additionalProperties": false,
                                },
                                {
                                    "type": "object",
                                    "properties": {
                                        "action": {"type": "string", "enum": ["replace"]},
                                        "target": target,
                                        "text": text,
                                        "old_text": old_text,
                                    },
                                    "required": ["action", "target", "text", "old_text"],
                                    "additionalProperties": false,
                                },
                                {
                                    "type": "object",
                                    "properties": {
                                        "action": {"type": "string", "enum": ["remove"]},
                                        "target": target,
                                        "old_text": old_text,
                                    },
                                    "required": ["action", "target", "old_text"],
                                    "additionalProperties": false,
                                },
                            ],
                        },
                    },
                },
                "required": ["operations"],
                "additionalProperties": false,
            }),
        )?],
        snapshot: Mutex::default(),
    }))
}

#[derive(Debug)]
struct CharacterMemoryPlugin {
    tools: Vec<ProvidedTool>,
    /// What the frame shows for the session it was taken in.
    snapshot: Mutex<Option<(SessionId, Vec<CuratedSection>)>>,
}

/// One of the two notebooks.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Target {
    Notes,
    UserProfile,
}

/// The two notebooks, as `memory.json` keeps them; a field this build does
/// not know is kept as it was.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Memory {
    version: u64,
    notes: Vec<String>,
    user_profile: Vec<String>,
    #[serde(flatten)]
    unknown: Map<String, Value>,
}

#[derive(Deserialize)]
struct Batch {
    operations: Vec<Operation>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum Operation {
    Add {
        target: Target,
        text: String,
    },
    Replace {
        target: Target,
        old_text: String,
        text: String,
    },
    Remove {
        target: Target,
        old_text: String,
    },
}

/// What one operation came to.
#[derive(Serialize)]
struct Change {
    action: &'static str,
    target: Target,
    status: Status,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Applied,
    /// The text was there already, so the notebook stays as it was.
    Duplicate,
}

/// Why a batch changed nothing, as the model is told.
struct Refusal {
    reason: &'static str,
    message: String,
}

#[async_trait]
impl RuntimePlugin for CharacterMemoryPlugin {
    fn provided_tools(&self) -> &[ProvidedTool] {
        &self.tools
    }

    async fn before_role_model_call(
        &self,
        context: &HookContext,
    ) -> Result<BeforeRoleModelCallOutput, PluginError> {
        let session = &context.turn()?.session_id;
        let kept = self
            .snapshot()
            .as_ref()
            .filter(|(taken, _)| taken == session)
            .map(|(_, sections)| sections.clone());
        let sections = if let Some(sections) = kept {
            sections
        } else {
            let memory = leased(store(context)?, |files| read(files)).await?;
            let sections = memory.sections()?;

            *self.snapshot() = Some((session.clone(), sections.clone()));
            sections
        };
        let summary = if sections.is_empty() {
            "Curated memory is empty."
        } else {
            "Provided the curated memory snapshot."
        };

        Ok(BeforeRoleModelCallOutput {
            context_items: Vec::new(),
            curated_sections: sections,
            evidence: vec![EvidenceNote::new(
                EvidenceKind::BeforeRoleModelCall,
                EvidenceStatus::Accepted,
                summary,
            )],
        })
    }

    async fn handle_tool_call(
        &self,
        call: &ToolCall,
        context: &HookContext,
    ) -> Result<ToolCallOutcome, PluginError> {
        let Batch { operations } = serde_json::from_value(Value::Object(call.input().clone()))
            .map_err(|error| {
                PluginError::with_source("memory.update input is not the batch it admits", error)
            })?;

        leased(store(context)?, move |files| {
            let memory = read(files)?;
            let (memory, changes) = match memory.planned(operations) {
                Ok(planned) => planned,
                Err(Refusal { reason, message }) => {
                    return Ok(rejected(reason, message.clone(), &message));
                }
            };
            let document = serde_json::to_value(&memory)
                .map_err(|error| StoreError::Store(Box::new(error)))?;

            files.write_json(STORE, &document)?;

            let applied = changes
                .iter()
                .filter(|change| change.status == Status::Applied)
                .count();

            Ok(ToolCallOutcome::Accepted {
                output: json!({
                    "status": "accepted",
                    "appliedChanges": changes,
                    "usage": {
                        "notes": memory.usage(Target::Notes),
                        "user_profile": memory.usage(Target::UserProfile),
                    },
                    "visibleNextSession": true,
                }),
                evidence: vec![EvidenceNote::new(
                    EvidenceKind::ToolInvocation,
                    EvidenceStatus::Accepted,
                    format!("Applied {applied} memory change(s)."),
                )],
            })
        })
        .await
    }
}

impl CharacterMemoryPlugin {
    fn snapshot(&self) -> MutexGuard<'_, Option<(SessionId, Vec<CuratedSection>)>> {
        self.snapshot.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn store(context: &HookContext) -> Result<FileStore, PluginError> {
    context.character_file_store().cloned().ok_or_else(|| {
        PluginError::new("Character memory needs the character file store its manifest requests")
    })
}

/// The notebooks as `memory.json` holds them, empty before it exists. A
/// document the plugin never writes fails closed and is left as it is.
fn read(files: &LeasedStore<'_>) -> Result<Memory, FilesError> {
    let Some(document) = files.read_json(STORE)? else {
        return Ok(Memory {
            version: STORE_VERSION,
            ..Memory::default()
        });
    };
    let damaged = || FilesError::Damaged(format!("Character memory {STORE} is damaged."));
    let memory: Memory = serde_json::from_value(document).map_err(|_| damaged())?;

    if memory.version == STORE_VERSION
        && Target::ALL
            .iter()
            .flat_map(|target| memory.entries(*target))
            .all(|entry| entry_text(entry) == Some(entry.as_str()))
    {
        Ok(memory)
    } else {
        Err(damaged())
    }
}

/// `text` as an entry keeps it: trimmed, and neither blank nor holding a
/// character the trusted frame refuses, so what is kept can always be shown.
fn entry_text(text: &str) -> Option<&str> {
    let text = text.trim();

    (!text.is_empty() && !contains_forbidden_control_character(text)).then_some(text)
}

impl Target {
    const ALL: [Self; 2] = [Self::Notes, Self::UserProfile];

    fn name(self) -> &'static str {
        match self {
            Self::Notes => "notes",
            Self::UserProfile => "user_profile",
        }
    }

    /// How many characters the target holds, its entries joined as the
    /// frame shows them.
    fn capacity(self) -> usize {
        match self {
            Self::Notes => 2_200,
            Self::UserProfile => 1_375,
        }
    }

    fn section(self) -> (&'static str, &'static str) {
        match self {
            Self::Notes => ("notes", "Notes to yourself"),
            Self::UserProfile => ("user-profile", "What you know about them"),
        }
    }
}

impl Memory {
    fn entries(&self, target: Target) -> &[String] {
        match target {
            Target::Notes => &self.notes,
            Target::UserProfile => &self.user_profile,
        }
    }

    fn entries_mut(&mut self, target: Target) -> &mut Vec<String> {
        match target {
            Target::Notes => &mut self.notes,
            Target::UserProfile => &mut self.user_profile,
        }
    }

    /// A target as the frame shows it.
    fn rendered(&self, target: Target) -> String {
        self.entries(target).join(SEPARATOR)
    }

    fn usage(&self, target: Target) -> Value {
        json!({
            "usedChars": self.rendered(target).chars().count(),
            "capChars": target.capacity(),
            "entryCount": self.entries(target).len(),
        })
    }

    /// A section of the trusted frame for each target that holds an entry.
    fn sections(&self) -> Result<Vec<CuratedSection>, PluginError> {
        let count = |chars: usize| {
            u32::try_from(chars)
                .ok()
                .and_then(NonZeroU32::new)
                .ok_or_else(|| PluginError::new("a curated section counts what it holds"))
        };

        Target::ALL
            .into_iter()
            .filter(|target| !self.entries(*target).is_empty())
            .map(|target| {
                let (id, title) = target.section();
                let text = self.rendered(target);
                let id = Identifier::new(id).map_err(|error| {
                    PluginError::with_source("a curated section needs an id", error)
                })?;
                let used = count(text.chars().count())?;

                Ok(
                    CuratedSection::new(id, title, text)
                        .with_usage(used, count(target.capacity())?),
                )
            })
            .collect()
    }

    /// The notebooks once every operation is made in order, and what each
    /// came to; or why the batch changes nothing.
    fn planned(mut self, operations: Vec<Operation>) -> Result<(Self, Vec<Change>), Refusal> {
        let mut changes = Vec::with_capacity(operations.len());

        for operation in operations {
            changes.push(match operation {
                Operation::Add { target, text } => {
                    let text = entry(target, &text)?;
                    let entries = self.entries_mut(target);
                    let status = if entries.iter().any(|kept| kept == text) {
                        Status::Duplicate
                    } else {
                        entries.push(text.to_owned());
                        Status::Applied
                    };

                    Change {
                        action: "add",
                        target,
                        status,
                    }
                }
                Operation::Replace {
                    target,
                    old_text,
                    text,
                } => {
                    let entries = self.entries_mut(target);
                    let at = selected(entries, target, &old_text)?;
                    let text = entry(target, &text)?;
                    // Replacing an entry with another's text collapses the two,
                    // so every entry stays one an old_text can select.
                    let status = if entries
                        .iter()
                        .enumerate()
                        .any(|(other, kept)| other != at && kept == text)
                    {
                        entries.remove(at);
                        Status::Duplicate
                    } else {
                        text.clone_into(&mut entries[at]);
                        Status::Applied
                    };

                    Change {
                        action: "replace",
                        target,
                        status,
                    }
                }
                Operation::Remove { target, old_text } => {
                    let entries = self.entries_mut(target);
                    let at = selected(entries, target, &old_text)?;

                    entries.remove(at);
                    Change {
                        action: "remove",
                        target,
                        status: Status::Applied,
                    }
                }
            });
        }

        for target in Target::ALL {
            let used = self.rendered(target).chars().count();
            let capacity = target.capacity();

            if used > capacity {
                return Err(Refusal {
                    reason: "memory_capacity_exceeded",
                    message: format!(
                        "{} would hold {used}/{capacity} chars; compress or remove entries first.",
                        target.name()
                    ),
                });
            }
        }

        Ok((self, changes))
    }
}

/// `text` as an entry of `target` keeps it, or the refusal of the batch.
fn entry(target: Target, text: &str) -> Result<&str, Refusal> {
    entry_text(text).ok_or_else(|| Refusal {
        reason: "memory_entry_invalid",
        message: format!(
            "{} entry text must be non-empty and free of control characters.",
            target.name()
        ),
    })
}

/// The one entry of `target` holding `old_text`, or the refusal of the
/// batch, which counts the entries it matched and repeats none.
fn selected(entries: &[String], target: Target, old_text: &str) -> Result<usize, Refusal> {
    let matched: Vec<usize> = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| entry.contains(old_text))
        .map(|(at, _)| at)
        .collect();

    match matched.as_slice() {
        [at] => Ok(*at),
        [] => Err(Refusal {
            reason: "memory_old_text_not_found",
            message: format!("No {} entry contains the given old_text.", target.name()),
        }),
        several => Err(Refusal {
            reason: "memory_old_text_ambiguous",
            message: format!(
                "old_text selects {} {} entries; use a longer unique substring.",
                several.len(),
                target.name()
            ),
        }),
    }
}
