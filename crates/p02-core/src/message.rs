use std::collections::BTreeMap;
use std::fmt;
use std::sync::LazyLock;

use p02_shared::Identifier;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::event::Timestamp;
use crate::id::MessageId;

/// The speaker id of the person in every conversation of a home.
pub(crate) static LOCAL_USER: LazyLock<Identifier> =
    LazyLock::new(|| Identifier::new("local-user").expect("local-user is an identifier"));

/// What ends a line, in a terminal or a browser alike.
const LINE_BREAKS: [char; 4] = ['\r', '\n', '\u{2028}', '\u{2029}'];

/// Text as a person sees it: line endings are `\n`, neither end is blank
/// space, and something is left.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, TS)]
#[serde(try_from = "String")]
pub struct VisibleText(String);

/// Why a text is not [`VisibleText`] once normalized: nothing is left.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("visible text must not be blank")]
pub struct BlankTextError;

/// Why a text is not [`VisibleText`] as it stands.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ParseVisibleTextError {
    #[error(transparent)]
    Blank(#[from] BlankTextError),
    #[error(
        "visible text must already be normalized: '\\n' line endings and no space at either end"
    )]
    Unnormalized,
}

impl VisibleText {
    /// What a speaker wrote, normalized: `\r\n` and `\r` become `\n` and
    /// the ends are trimmed.
    ///
    /// # Errors
    ///
    /// [`BlankTextError`] when nothing is left.
    pub fn normalize(raw: &str) -> Result<Self, BlankTextError> {
        let unified = raw.replace("\r\n", "\n").replace('\r', "\n");
        let trimmed = unified.trim();

        if trimmed.is_empty() {
            Err(BlankTextError)
        } else {
            Ok(Self(trimmed.to_owned()))
        }
    }

    /// Text a record already holds, which must be normalized as it stands.
    ///
    /// # Errors
    ///
    /// [`ParseVisibleTextError`] when `text` is blank or normalizing it
    /// would change it.
    pub fn parse(text: &str) -> Result<Self, ParseVisibleTextError> {
        let normalized = Self::normalize(text)?;

        if normalized.0 == text {
            Ok(normalized)
        } else {
            Err(ParseVisibleTextError::Unnormalized)
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for VisibleText {
    type Error = ParseVisibleTextError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl fmt::Display for VisibleText {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// What a person says in one turn, as visible text: their line in the
/// dialogue, which may span several lines of text.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct UserLine(VisibleText);

impl UserLine {
    /// What a person sent, normalized as [`VisibleText::normalize`] does.
    ///
    /// # Errors
    ///
    /// [`BlankTextError`] when nothing is left.
    pub fn new(raw: &str) -> Result<Self, BlankTextError> {
        VisibleText::normalize(raw).map(Self)
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl From<UserLine> for VisibleText {
    fn from(line: UserLine) -> Self {
        line.0
    }
}

impl fmt::Display for UserLine {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// The name a speaker goes by on a message: one line of at most 128
/// characters, without blank space at either end. It is set before a
/// colon in chat, which is why a line break is refused.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, TS)]
#[serde(try_from = "String")]
pub struct SpeakerName(String);

/// Why a text is not a [`SpeakerName`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("a speaker name must be one line of 1 to 128 characters with no blank space at either end")]
pub struct ParseSpeakerNameError;

impl SpeakerName {
    /// The longest name, in characters: a client that names someone, such
    /// as an account asking to pair, cuts the name to it.
    pub const MAX_CHARS: usize = 128;

    /// # Errors
    ///
    /// [`ParseSpeakerNameError`] when `value` is empty, longer than 128
    /// characters, has blank space at either end, or breaks a line.
    pub fn new(value: &str) -> Result<Self, ParseSpeakerNameError> {
        let valid = !value.is_empty()
            && value.chars().count() <= Self::MAX_CHARS
            && value.trim() == value
            && !value.contains(LINE_BREAKS);

        if valid {
            Ok(Self(value.to_owned()))
        } else {
            Err(ParseSpeakerNameError)
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for SpeakerName {
    type Error = ParseSpeakerNameError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(&value)
    }
}

impl fmt::Display for SpeakerName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// What a client stamps on a line it carries: the surface it came from, or
/// the id it submitted the line under, which a repeat of the line reuses. An
/// ASCII letter or digit, then up to 63 ASCII letters, digits, `:`, `.`, `_`
/// or `-`.
#[derive(
    Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema, TS,
)]
#[serde(try_from = "String")]
pub struct ClientStamp(String);

/// Why a text is not a [`ClientStamp`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error(
    "not a client stamp: an ASCII letter or digit, then up to 63 ASCII letters, digits, ':', \
     '.', '_' or '-'"
)]
pub struct ParseClientStampError;

impl ClientStamp {
    const MAX_LEN: usize = 64;

    /// # Errors
    ///
    /// [`ParseClientStampError`] when `value` is not in the pattern.
    pub fn new(value: &str) -> Result<Self, ParseClientStampError> {
        let mut bytes = value.bytes();
        let in_pattern = value.len() <= Self::MAX_LEN
            && bytes
                .next()
                .is_some_and(|byte| byte.is_ascii_alphanumeric())
            && bytes.all(|byte| byte.is_ascii_alphanumeric() || b":._-".contains(&byte));

        if in_pattern {
            Ok(Self(value.to_owned()))
        } else {
            Err(ParseClientStampError)
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for ClientStamp {
    type Error = ParseClientStampError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(&value)
    }
}

impl fmt::Display for ClientStamp {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// The id of the app's own chat, where the page's lines come in.
const MESSAGES: &str = "messages";

/// The app a line of the person's came in, told by the stamp of the surface
/// it came from: the part of the stamp before its first `:`, as `telegram`
/// of `telegram:<bot>`; or the app's own chat, `messages`, for a stamp
/// without one, as the page's `web`, and for a line an earlier build kept
/// without its stamps.
#[must_use]
pub fn app_of(source: Option<&ClientStamp>) -> &str {
    source
        .and_then(|stamp| stamp.0.split_once(':'))
        .map_or(MESSAGES, |(app, _)| app)
}

/// The apps a line of the person's comes in, each by the name she and the
/// person read it by: the app's own chat, Messages, and each app the daemon
/// names. An app nothing names goes by its id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppNames(BTreeMap<String, String>);

impl AppNames {
    /// Messages, and each of `named`, an app's id with its name.
    #[must_use]
    pub fn new<'a>(named: impl IntoIterator<Item = (&'a str, &'a str)>) -> Self {
        Self(
            std::iter::once((MESSAGES, "Messages"))
                .chain(named)
                .map(|(app, name)| (app.to_owned(), name.to_owned()))
                .collect(),
        )
    }

    /// The name the app `app` goes by.
    #[must_use]
    pub fn name<'a>(&'a self, app: &'a str) -> &'a str {
        self.0.get(app).map_or(app, String::as_str)
    }
}

/// Which side of a conversation someone speaks for: a character, or the
/// person. A visible message carries its speaker's, and the two order as
/// they are spelled, characters first.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema, TS,
)]
#[serde(rename_all = "lowercase")]
pub enum VisibleMessageRole {
    Character,
    User,
}

/// A message a person or a character said, as it was shown, and when it
/// was sent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibleMessage {
    pub id: MessageId,
    pub role: VisibleMessageRole,
    pub speaker_id: Identifier,
    /// The name the speaker had when the message was committed; a later
    /// rename never rewrites it.
    pub speaker_name: SpeakerName,
    pub text: VisibleText,
    /// The person's line was sent when the daemon queued it, however long
    /// it waited for her; a reply of hers, when it was committed.
    pub sent_at: Timestamp,
}

/// A character: her id, and the name she goes by.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterProfile {
    pub id: Identifier,
    pub display_name: SpeakerName,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn visible_text_is_normalized_once_and_a_record_must_already_be() {
        assert_eq!(
            VisibleText::normalize("  one\r\ntwo\rthree \n").map(|text| text.0),
            Ok("one\ntwo\nthree".to_owned())
        );
        assert_eq!(VisibleText::normalize(" \r\n\t"), Err(BlankTextError));
        assert!(VisibleText::parse("one\ntwo").is_ok());
        assert_eq!(
            VisibleText::parse("one\r\ntwo"),
            Err(ParseVisibleTextError::Unnormalized)
        );
        assert_eq!(
            VisibleText::parse(" padded"),
            Err(ParseVisibleTextError::Unnormalized)
        );
    }

    #[test]
    fn a_client_stamp_is_one_token_of_at_most_64_characters() {
        let longest = format!("w{}", "1".repeat(63));
        let too_long = format!("{longest}2");

        for (text, accepted) in [
            ("web", true),
            ("telegram:42.7_x-y", true),
            ("7", true),
            (longest.as_str(), true),
            ("", false),
            (":web", false),
            ("two words", false),
            ("caf\u{e9}", false),
            ("web/1", false),
            (too_long.as_str(), false),
        ] {
            assert_eq!(ClientStamp::new(text).is_ok(), accepted, "{text}");
        }
    }

    /// A stamp's app is what comes before its first `:`, the app's own
    /// chat when nothing does, and goes by the name it is given, or by its
    /// id when it is given none.
    #[test]
    fn a_line_s_app_is_told_by_its_stamp_and_named() {
        let names = AppNames::new([("telegram", "Telegram")]);

        for (source, app, name) in [
            (Some("web"), "messages", "Messages"),
            (Some("telegram:mira_bot"), "telegram", "Telegram"),
            (Some("matrix:mira:home"), "matrix", "matrix"),
            (None, "messages", "Messages"),
        ] {
            let stamp = source.map(|text| ClientStamp::new(text).unwrap());

            assert_eq!(app_of(stamp.as_ref()), app, "{source:?}");
            assert_eq!(names.name(app), name, "{source:?}");
        }
    }

    #[test]
    fn a_speaker_name_is_one_trimmed_line_of_at_most_128_characters() {
        let longest = "\u{30bc}".repeat(128);
        let too_long = format!("{longest}x");

        for (text, accepted) in [
            ("Zero Two", true),
            (longest.as_str(), true),
            ("", false),
            (" Mira", false),
            ("Mira ", false),
            ("Mi\nra", false),
            ("Mi\u{2028}ra", false),
            (too_long.as_str(), false),
        ] {
            assert_eq!(SpeakerName::new(text).is_ok(), accepted, "{text:?}");
        }
    }

    #[test]
    fn a_visible_message_reads_back_as_it_was_written() {
        let message = json!({
            "id": "chat-1.1:message-2",
            "role": "character",
            "speakerId": "mira",
            "speakerName": "Mira",
            "text": "Hello.\nAgain.",
            "sentAt": "2026-06-15T00:00:00.000Z",
        });
        let parsed: VisibleMessage = serde_json::from_value(message.clone()).unwrap();

        assert_eq!(parsed.role, VisibleMessageRole::Character);
        assert_eq!(serde_json::to_value(&parsed).unwrap(), message);

        let mut unnormalized = message;
        unnormalized["text"] = json!("Hello. ");

        assert!(serde_json::from_value::<VisibleMessage>(unnormalized).is_err());
    }
}
