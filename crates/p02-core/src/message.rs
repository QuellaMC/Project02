use std::fmt;

use p02_shared::Identifier;
use serde::{Deserialize, Serialize};

use crate::id::MessageId;

/// Text as a person sees it: line endings are `\n`, neither end is blank
/// space, and something is left.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct VisibleText(String);

/// Why a text is not [`VisibleText`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ParseVisibleTextError {
    #[error("visible text must not be blank")]
    Blank,
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
    /// [`ParseVisibleTextError::Blank`] when nothing is left.
    pub fn normalize(raw: &str) -> Result<Self, ParseVisibleTextError> {
        let unified = raw.replace("\r\n", "\n").replace('\r', "\n");
        let trimmed = unified.trim();

        if trimmed.is_empty() {
            Err(ParseVisibleTextError::Blank)
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

/// The name a speaker goes by on a message: one line of at most 128
/// characters, without blank space at either end. It is set before a
/// colon in chat, which is why a line break is refused.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct SpeakerName(String);

/// Why a text is not a [`SpeakerName`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("a speaker name must be one line of 1 to 128 characters with no blank space at either end")]
pub struct ParseSpeakerNameError;

impl SpeakerName {
    const MAX_CHARS: usize = 128;

    /// # Errors
    ///
    /// [`ParseSpeakerNameError`] when `value` is empty, longer than 128
    /// characters, has blank space at either end, or breaks a line.
    pub fn new(value: &str) -> Result<Self, ParseSpeakerNameError> {
        let valid = !value.is_empty()
            && value.chars().count() <= Self::MAX_CHARS
            && value.trim() == value
            && !value.contains(['\r', '\n', '\u{2028}', '\u{2029}']);

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

/// Who said a visible message.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VisibleMessageRole {
    User,
    Character,
}

/// A message a person or a character said, as it was shown.
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
}

/// A character as a conversation knows it.
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
        assert_eq!(
            VisibleText::normalize(" \r\n\t"),
            Err(ParseVisibleTextError::Blank)
        );
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
        });
        let parsed: VisibleMessage = serde_json::from_value(message.clone()).unwrap();

        assert_eq!(parsed.role, VisibleMessageRole::Character);
        assert_eq!(serde_json::to_value(&parsed).unwrap(), message);

        let mut unnormalized = message;
        unnormalized["text"] = json!("Hello. ");

        assert!(serde_json::from_value::<VisibleMessage>(unnormalized).is_err());
    }
}
