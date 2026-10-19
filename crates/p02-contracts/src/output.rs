use std::num::NonZeroU32;

use p02_core::{Timestamp, VisibleMessage};
use p02_shared::{BoundJsonError, Credentials, Identifier, JsonLimits, bound_json};
use serde::{Deserialize, Serialize};

use crate::evidence::EvidenceNote;
use crate::label::RedactionLabel;
use crate::vocabulary::{ContextItemKind, HealthStatus, SourceKind, ValidationFailureReason};

/// Where something a plugin returns came from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceReference {
    kind: SourceKind,
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    uri: Option<String>,
}

/// Why source references cannot be kept.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SourceReferenceError {
    #[error(
        "a record holds at most {} source references",
        SourceReference::MAX_PER_RECORD
    )]
    TooMany,
    #[error("a source reference's {field} must not be blank")]
    Blank { field: &'static str },
}

impl SourceReference {
    /// How many one record may carry.
    pub const MAX_PER_RECORD: usize = 32;

    /// A reference by kind and the source's own id, which need not be an
    /// identifier: a database key, a UUID or a path all are.
    #[must_use]
    pub fn new(kind: SourceKind, id: impl Into<String>) -> Self {
        Self {
            kind,
            id: id.into(),
            title: None,
            uri: None,
        }
    }

    #[must_use]
    pub fn with_title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    #[must_use]
    pub fn with_uri(mut self, uri: impl Into<String>) -> Self {
        self.uri = Some(uri.into());
        self
    }

    #[must_use]
    pub fn kind(&self) -> SourceKind {
        self.kind
    }

    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    #[must_use]
    pub fn title(&self) -> Option<&str> {
        self.title.as_deref()
    }

    #[must_use]
    pub fn uri(&self) -> Option<&str> {
        self.uri.as_deref()
    }

    pub(crate) fn check_all(references: &[Self]) -> Result<(), SourceReferenceError> {
        if references.len() > Self::MAX_PER_RECORD {
            return Err(SourceReferenceError::TooMany);
        }

        for reference in references {
            for (field, text) in [
                ("id", Some(reference.id.as_str())),
                ("title", reference.title.as_deref()),
                ("uri", reference.uri.as_deref()),
            ] {
                if text.is_some_and(|text| text.trim().is_empty()) {
                    return Err(SourceReferenceError::Blank { field });
                }
            }
        }

        Ok(())
    }
}

/// Model input a plugin contributes before a model call. The host decides
/// where it renders by its kind; only its text reaches the model, and the
/// rest is evidence.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextItem {
    id: Identifier,
    kind: ContextItemKind,
    text: String,
    source_references: Vec<SourceReference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    confidence: Option<f64>,
    redaction_labels: Vec<RedactionLabel>,
}

impl ContextItem {
    #[must_use]
    pub fn new(id: Identifier, kind: ContextItemKind, text: impl Into<String>) -> Self {
        Self {
            id,
            kind,
            text: text.into(),
            source_references: Vec::new(),
            confidence: None,
            redaction_labels: Vec::new(),
        }
    }

    #[must_use]
    pub fn with_source(mut self, reference: SourceReference) -> Self {
        self.source_references.push(reference);
        self
    }

    /// How sure the plugin is, from 0 to 1.
    #[must_use]
    pub fn with_confidence(mut self, confidence: f64) -> Self {
        self.confidence = Some(confidence);
        self
    }

    #[must_use]
    pub fn with_redaction_label(mut self, label: RedactionLabel) -> Self {
        self.redaction_labels.push(label);
        self
    }

    #[must_use]
    pub fn id(&self) -> &Identifier {
        &self.id
    }

    #[must_use]
    pub fn kind(&self) -> ContextItemKind {
        self.kind
    }

    #[must_use]
    pub fn text(&self) -> &str {
        &self.text
    }

    #[must_use]
    pub fn source_references(&self) -> &[SourceReference] {
        &self.source_references
    }

    #[must_use]
    pub fn confidence(&self) -> Option<f64> {
        self.confidence
    }

    #[must_use]
    pub fn redaction_labels(&self) -> &[RedactionLabel] {
        &self.redaction_labels
    }
}

/// A context item as the host keeps it, under the plugin that gave it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "UncheckedContextItem")]
pub struct PluginContextItem {
    plugin_id: Identifier,
    #[serde(flatten)]
    item: ContextItem,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UncheckedContextItem {
    plugin_id: Identifier,
    #[serde(flatten)]
    item: ContextItem,
}

/// Why a context item was refused.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum ContextItemError {
    #[error("a plugin context item is past the JSON limits")]
    TooLarge(#[source] BoundJsonError),
    #[error("a plugin context item's text must not be blank")]
    BlankText,
    #[error("a plugin context item's sources are refused")]
    Sources(#[source] SourceReferenceError),
    #[error("a plugin context item's confidence must be a finite number from 0 to 1")]
    Confidence,
}

impl ContextItemError {
    #[must_use]
    pub fn reason(&self) -> ValidationFailureReason {
        ValidationFailureReason::MalformedContextItem
    }
}

impl PluginContextItem {
    /// Attributes an item to its plugin once it keeps to the item rules and
    /// the JSON limits as a whole.
    ///
    /// # Errors
    ///
    /// [`ContextItemError`] for the first rule the item breaks.
    pub fn new(plugin_id: Identifier, item: ContextItem) -> Result<Self, ContextItemError> {
        let record = Self { plugin_id, item };

        within_limits(&record, "Plugin context item").map_err(ContextItemError::TooLarge)?;

        if record.item.text.trim().is_empty() {
            return Err(ContextItemError::BlankText);
        }

        SourceReference::check_all(&record.item.source_references)
            .map_err(ContextItemError::Sources)?;

        if record
            .item
            .confidence
            .is_some_and(|confidence| !(0.0..=1.0).contains(&confidence))
        {
            return Err(ContextItemError::Confidence);
        }

        Ok(record)
    }

    #[must_use]
    pub fn plugin_id(&self) -> &Identifier {
        &self.plugin_id
    }

    #[must_use]
    pub fn item(&self) -> &ContextItem {
        &self.item
    }
}

impl TryFrom<UncheckedContextItem> for PluginContextItem {
    type Error = ContextItemError;

    fn try_from(unchecked: UncheckedContextItem) -> Result<Self, Self::Error> {
        Self::new(unchecked.plugin_id, unchecked.item)
    }
}

/// The record's serialized form held to the default JSON limits, which
/// bound every public string a plugin hands the host and their sum.
pub(crate) fn within_limits<T: Serialize>(record: &T, name: &str) -> Result<(), BoundJsonError> {
    let value = serde_json::to_value(record).expect("a record of plain data always serializes");

    bound_json(value, name, JsonLimits::default(), Credentials::Keep).map(drop)
}

/// A section of the trusted curated frame, between the persona and the
/// runtime notes. Plugins never write prompt text; the host renders the
/// sections it validated.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CuratedSection {
    id: Identifier,
    title: String,
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cap_chars: Option<NonZeroU32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    used_chars: Option<NonZeroU32>,
}

impl CuratedSection {
    pub const TITLE_CHAR_LIMIT: usize = 64;
    pub const TEXT_CHAR_LIMIT: usize = 4096;

    #[must_use]
    pub fn new(id: Identifier, title: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            id,
            title: title.into(),
            text: text.into(),
            cap_chars: None,
            used_chars: None,
        }
    }

    /// How full the plugin's own store is, for display; the plugin keeps
    /// its cap, not the host.
    #[must_use]
    pub fn with_usage(mut self, used_chars: NonZeroU32, cap_chars: NonZeroU32) -> Self {
        self.used_chars = Some(used_chars);
        self.cap_chars = Some(cap_chars);
        self
    }

    #[must_use]
    pub fn id(&self) -> &Identifier {
        &self.id
    }

    #[must_use]
    pub fn title(&self) -> &str {
        &self.title
    }

    #[must_use]
    pub fn text(&self) -> &str {
        &self.text
    }

    #[must_use]
    pub fn cap_chars(&self) -> Option<NonZeroU32> {
        self.cap_chars
    }

    #[must_use]
    pub fn used_chars(&self) -> Option<NonZeroU32> {
        self.used_chars
    }
}

/// A curated section as the host keeps it: under its plugin, with its
/// line endings made `\n`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "UncheckedCuratedSection")]
pub struct PluginCuratedSection {
    plugin_id: Identifier,
    #[serde(flatten)]
    section: CuratedSection,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UncheckedCuratedSection {
    plugin_id: Identifier,
    #[serde(flatten)]
    section: CuratedSection,
}

/// Why a curated section was refused. Its limits are never met by
/// truncating: a section over them fails its plugin.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CuratedSectionError {
    #[error("a curated context section is past the JSON limits")]
    TooLarge(#[source] BoundJsonError),
    #[error("a curated context section's {field} must not be blank")]
    Blank { field: &'static str },
    #[error(
        "a curated context section title must be a single line of at most {} characters",
        CuratedSection::TITLE_CHAR_LIMIT
    )]
    Title,
    #[error("a curated context section's text must not contain control characters")]
    ControlCharacter,
    #[error(
        "a curated context section's text exceeds the {}-character limit",
        CuratedSection::TEXT_CHAR_LIMIT
    )]
    TextTooLong,
}

impl CuratedSectionError {
    #[must_use]
    pub fn reason(&self) -> ValidationFailureReason {
        ValidationFailureReason::MalformedCuratedContextSection
    }
}

impl PluginCuratedSection {
    /// Attributes a section to its plugin once it keeps to the frame's
    /// rules, making `\r\n` and `\r` in its text `\n`.
    ///
    /// # Errors
    ///
    /// [`CuratedSectionError`] for the first rule the section breaks.
    pub fn new(
        plugin_id: Identifier,
        section: CuratedSection,
    ) -> Result<Self, CuratedSectionError> {
        let mut record = Self { plugin_id, section };

        within_limits(&record, "Plugin curated context section")
            .map_err(CuratedSectionError::TooLarge)?;

        let section = &mut record.section;

        for (field, text) in [("title", &section.title), ("text", &section.text)] {
            if text.trim().is_empty() {
                return Err(CuratedSectionError::Blank { field });
            }
        }

        if section.title.chars().count() > CuratedSection::TITLE_CHAR_LIMIT
            || section.title.contains('\n')
            || contains_forbidden_control_character(&section.title)
        {
            return Err(CuratedSectionError::Title);
        }

        section.text = section.text.replace("\r\n", "\n").replace('\r', "\n");

        if contains_forbidden_control_character(&section.text) {
            return Err(CuratedSectionError::ControlCharacter);
        }

        if section.text.chars().count() > CuratedSection::TEXT_CHAR_LIMIT {
            return Err(CuratedSectionError::TextTooLong);
        }

        Ok(record)
    }

    #[must_use]
    pub fn plugin_id(&self) -> &Identifier {
        &self.plugin_id
    }

    #[must_use]
    pub fn section(&self) -> &CuratedSection {
        &self.section
    }
}

impl TryFrom<UncheckedCuratedSection> for PluginCuratedSection {
    type Error = CuratedSectionError;

    fn try_from(unchecked: UncheckedCuratedSection) -> Result<Self, Self::Error> {
        Self::new(unchecked.plugin_id, unchecked.section)
    }
}

/// Whether `text` holds a character the curated frame refuses: a C0 or C1
/// control other than `\n`, DEL, or a Unicode line or paragraph separator.
/// Each would break the frame's single-line titles or its newline-only
/// text, so a plugin refuses them where it stores text rather than keep
/// what can never be shown.
#[must_use]
pub fn contains_forbidden_control_character(text: &str) -> bool {
    text.chars().any(|character| {
        (character.is_control() && character != '\n')
            || character == '\u{2028}'
            || character == '\u{2029}'
    })
}

/// What `beforeRoleModelCall` contributes to the coming model call.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BeforeRoleModelCallOutput {
    pub context_items: Vec<ContextItem>,
    pub curated_sections: Vec<CuratedSection>,
    pub evidence: Vec<EvidenceNote>,
}

/// How a lifecycle hook's work ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HookStatus {
    Completed,
    /// The work did not finish; the host records it and nothing is undone.
    Failed,
}

/// What `afterTurnCommitted`, `onSessionEnd` and `onShutdown` report.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HookReport {
    pub status: HookStatus,
    pub evidence: Vec<EvidenceNote>,
}

/// What a plugin's health check says; the host stamps who and when.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HealthReport {
    pub status: HealthStatus,
    pub summary: String,
}

/// A health check as the host keeps it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "UncheckedHealthSnapshot")]
pub struct HealthSnapshot {
    plugin_id: Identifier,
    status: HealthStatus,
    checked_at: Timestamp,
    summary: String,
    redaction_labels: Vec<RedactionLabel>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UncheckedHealthSnapshot {
    plugin_id: Identifier,
    status: HealthStatus,
    checked_at: Timestamp,
    summary: String,
    redaction_labels: Vec<RedactionLabel>,
}

/// Why a health report cannot be kept.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum HealthSnapshotError {
    #[error("a plugin health snapshot is past the JSON limits")]
    TooLarge(#[source] BoundJsonError),
    #[error("a plugin health summary must not be blank")]
    BlankSummary,
}

impl HealthSnapshot {
    /// # Errors
    ///
    /// [`HealthSnapshotError`] when the summary is blank or the record is
    /// past the JSON limits.
    pub fn new(
        plugin_id: Identifier,
        checked_at: Timestamp,
        report: HealthReport,
        redaction_labels: Vec<RedactionLabel>,
    ) -> Result<Self, HealthSnapshotError> {
        let snapshot = Self {
            plugin_id,
            status: report.status,
            checked_at,
            summary: report.summary,
            redaction_labels,
        };

        within_limits(&snapshot, "Plugin health snapshot")
            .map_err(HealthSnapshotError::TooLarge)?;

        if snapshot.summary.trim().is_empty() {
            return Err(HealthSnapshotError::BlankSummary);
        }

        Ok(snapshot)
    }

    #[must_use]
    pub fn plugin_id(&self) -> &Identifier {
        &self.plugin_id
    }

    #[must_use]
    pub fn status(&self) -> HealthStatus {
        self.status
    }

    #[must_use]
    pub fn checked_at(&self) -> &Timestamp {
        &self.checked_at
    }

    #[must_use]
    pub fn summary(&self) -> &str {
        &self.summary
    }

    #[must_use]
    pub fn redaction_labels(&self) -> &[RedactionLabel] {
        &self.redaction_labels
    }
}

impl TryFrom<UncheckedHealthSnapshot> for HealthSnapshot {
    type Error = HealthSnapshotError;

    fn try_from(unchecked: UncheckedHealthSnapshot) -> Result<Self, Self::Error> {
        Self::new(
            unchecked.plugin_id,
            unchecked.checked_at,
            HealthReport {
                status: unchecked.status,
                summary: unchecked.summary,
            },
            unchecked.redaction_labels,
        )
    }
}

/// A turn that is already durable, for `afterTurnCommitted`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommittedTurn {
    committed_at: Timestamp,
    messages: Option<Vec<VisibleMessage>>,
}

impl CommittedTurn {
    /// A turn whose messages the plugin may not read: it lacks
    /// `turn_context: read`.
    #[must_use]
    pub fn new(committed_at: Timestamp) -> Self {
        Self {
            committed_at,
            messages: None,
        }
    }

    /// The visible messages the turn committed, for a plugin that may read
    /// them.
    #[must_use]
    pub fn with_messages(mut self, messages: Vec<VisibleMessage>) -> Self {
        self.messages = Some(messages);
        self
    }

    #[must_use]
    pub fn committed_at(&self) -> &Timestamp {
        &self.committed_at
    }

    /// The committed messages: absent, never empty, for a plugin without
    /// `turn_context: read`.
    #[must_use]
    pub fn messages(&self) -> Option<&[VisibleMessage]> {
        self.messages.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use p02_core::{EventId, EventIdentity, TraceId};
    use serde_json::json;

    use super::*;
    use crate::evidence::{Evidence, EvidenceError};
    use crate::vocabulary::{EvidenceKind, EvidenceStatus};

    const STRING_BYTES: usize = 16 * 1024;

    fn id(text: &str) -> Identifier {
        Identifier::new(text).unwrap()
    }

    fn identity() -> EventIdentity {
        EventIdentity::new(
            EventId::new("evt_1").unwrap(),
            TraceId::new("trace_1").unwrap(),
            Timestamp::new("2026-07-11T00:00:00.000Z").unwrap(),
        )
        .unwrap()
    }

    fn item(text: &str) -> ContextItem {
        ContextItem::new(id("bounded-context"), ContextItemKind::Memory, text)
    }

    fn keep(item: ContextItem) -> Result<PluginContextItem, ContextItemError> {
        PluginContextItem::new(id("memory.fixture"), item)
    }

    fn evidence(note: EvidenceNote) -> Result<Evidence, EvidenceError> {
        Evidence::new(identity(), id("memory.fixture"), note, Vec::new())
    }

    fn note() -> EvidenceNote {
        EvidenceNote::new(
            EvidenceKind::ToolInvocation,
            EvidenceStatus::Accepted,
            "Memory search completed.",
        )
    }

    fn health(summary: String) -> Result<HealthSnapshot, HealthSnapshotError> {
        HealthSnapshot::new(
            id("memory.fixture"),
            Timestamp::new("2026-07-11T00:00:00.000Z").unwrap(),
            HealthReport {
                status: HealthStatus::Ok,
                summary,
            },
            Vec::new(),
        )
    }

    fn string_limit(path: &str) -> BoundJsonError {
        BoundJsonError::StringBytes {
            path: path.to_owned(),
        }
    }

    #[test]
    fn every_string_a_plugin_hands_the_host_is_held_to_the_json_limits() {
        let exact = "x".repeat(STRING_BYTES);
        let over = format!("{exact}x");
        let titled = |title: &str| {
            item("safe")
                .with_source(SourceReference::new(SourceKind::Memory, "1").with_title(title))
        };
        let kanji = "\u{754c}".repeat(STRING_BYTES / 3);

        assert!(keep(titled(&exact)).is_ok());
        assert!(keep(item(&kanji)).is_ok());
        assert_eq!(
            keep(titled(&over)),
            Err(ContextItemError::TooLarge(string_limit(
                "Plugin context item.sourceReferences[0].title"
            )))
        );
        assert_eq!(
            keep(item(&format!("{kanji}\u{754c}"))),
            Err(ContextItemError::TooLarge(string_limit(
                "Plugin context item.text"
            )))
        );
        assert!(
            evidence(note().with_source(SourceReference::new(SourceKind::Memory, &exact))).is_ok()
        );
        assert_eq!(
            evidence(note().with_source(SourceReference::new(SourceKind::Memory, &over))),
            Err(EvidenceError::TooLarge(string_limit(
                "Plugin evidence snapshot.sourceReferences[0].id"
            )))
        );
        assert!(health(exact).is_ok());
        assert_eq!(
            health(over),
            Err(HealthSnapshotError::TooLarge(string_limit(
                "Plugin health snapshot.summary"
            )))
        );

        let crowded = (0..32).fold(item("safe"), |item, index| {
            item.with_source(SourceReference::new(
                SourceKind::Memory,
                format!("{index}-{}", "x".repeat(2_200)),
            ))
        });

        assert_eq!(
            keep(crowded),
            Err(ContextItemError::TooLarge(
                BoundJsonError::TotalStringBytes {
                    path: "Plugin context item".to_owned()
                }
            ))
        );
    }

    #[test]
    fn source_references_are_at_most_32_and_never_blank() {
        let references = |count| {
            (0..count)
                .map(|index| {
                    SourceReference::new(SourceKind::Resource, format!("resources/{index}.json"))
                })
                .collect::<Vec<_>>()
        };
        let with = |references: Vec<SourceReference>| {
            references
                .into_iter()
                .fold(item("safe"), ContextItem::with_source)
        };

        assert!(keep(with(references(32))).is_ok());
        assert_eq!(
            keep(with(references(33))),
            Err(ContextItemError::Sources(SourceReferenceError::TooMany))
        );
        assert_eq!(
            evidence(note().with_source(SourceReference::new(SourceKind::Memory, "  "))),
            Err(EvidenceError::Sources(SourceReferenceError::Blank {
                field: "id"
            }))
        );
        assert_eq!(
            keep(
                item("safe")
                    .with_source(SourceReference::new(SourceKind::Memory, "1").with_uri(""))
            ),
            Err(ContextItemError::Sources(SourceReferenceError::Blank {
                field: "uri"
            }))
        );
    }

    #[test]
    fn a_context_item_has_text_and_a_confidence_from_0_to_1() {
        assert_eq!(keep(item(" \n")), Err(ContextItemError::BlankText));

        for (confidence, accepted) in [(0.0, true), (1.0, true), (1.5, false), (f64::NAN, false)] {
            assert_eq!(
                keep(item("safe").with_confidence(confidence)).is_ok(),
                accepted,
                "{confidence}"
            );
        }

        let kept = keep(
            item("You promised to call on Friday.")
                .with_source(SourceReference::new(SourceKind::Memory, "1234567890"))
                .with_confidence(0.5),
        )
        .unwrap();
        let record = serde_json::to_value(&kept).unwrap();

        assert_eq!(
            record,
            json!({
                "pluginId": "memory.fixture",
                "id": "bounded-context",
                "kind": "memory",
                "text": "You promised to call on Friday.",
                "sourceReferences": [{"kind": "memory", "id": "1234567890"}],
                "confidence": 0.5,
                "redactionLabels": [],
            })
        );
        assert_eq!(
            serde_json::from_value::<PluginContextItem>(record).unwrap(),
            kept
        );
    }

    #[test]
    fn a_curated_section_is_a_one_line_title_over_newline_text_within_its_limits() {
        let section = |title: &str, text: &str| {
            PluginCuratedSection::new(
                id("memory.fixture"),
                CuratedSection::new(id("notes"), title, text),
            )
        };

        assert_eq!(
            section("Character notes", "line one\r\nline two\rline three")
                .unwrap()
                .section()
                .text(),
            "line one\nline two\nline three"
        );
        assert!(section(&"x".repeat(64), &"y".repeat(4096)).is_ok());
        assert!(section(&"\u{1f496}".repeat(64), &"\u{1f496}".repeat(4096)).is_ok());

        for (title, text, refusal) in [
            ("multi\nline", "x", CuratedSectionError::Title),
            (&"x".repeat(65), "x", CuratedSectionError::Title),
            (
                "Title with \u{2028} separator",
                "x",
                CuratedSectionError::Title,
            ),
            (
                "Notes",
                "null byte \u{0} stays out",
                CuratedSectionError::ControlCharacter,
            ),
            (
                "Notes",
                "next line \u{85} stays out",
                CuratedSectionError::ControlCharacter,
            ),
            (
                "Notes",
                "line separator \u{2028} stays out",
                CuratedSectionError::ControlCharacter,
            ),
            (
                "Notes",
                "paragraph separator \u{2029} stays out",
                CuratedSectionError::ControlCharacter,
            ),
            ("Notes", &"x".repeat(4097), CuratedSectionError::TextTooLong),
            (" ", "x", CuratedSectionError::Blank { field: "title" }),
        ] {
            assert_eq!(section(title, text), Err(refusal), "{title:?} {text:?}");
        }

        assert!(
            serde_json::from_value::<PluginCuratedSection>(json!({
                "pluginId": "memory.fixture",
                "id": "notes",
                "title": "Notes",
                "text": "x",
                "capChars": 0,
            }))
            .is_err()
        );
    }
}
