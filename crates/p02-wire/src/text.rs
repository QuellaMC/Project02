//! The strings a body carries, each held to its bound as it is read.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The longest line, in characters, so a line in any script is held to the
/// same length: well above any line a person types, and well below the
/// body cap.
const TEXT_LIMIT: usize = 16 * 1024;
/// The bound of an id, and of the name a person goes by.
const NAME_LIMIT: usize = 128;
/// The longest username Telegram gives a bot.
const USERNAME_LIMIT: usize = 32;

/// A string of 1 to 128 characters, as an id is on the wire, and the name
/// an account goes by.
#[derive(Debug, Serialize, JsonSchema, TS)]
pub struct Short(String);

/// Why a text is not a [`Short`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("an id or a name is 1 to 128 characters")]
pub struct ParseShortError;

impl Short {
    /// # Errors
    ///
    /// [`ParseShortError`] when `text` is empty or longer than 128
    /// characters.
    pub fn new(text: &str) -> Result<Self, ParseShortError> {
        if (1..=NAME_LIMIT).contains(&text.chars().count()) {
            Ok(Self(text.to_owned()))
        } else {
            Err(ParseShortError)
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<Short> for String {
    fn from(short: Short) -> Self {
        short.0
    }
}

impl<'de> Deserialize<'de> for Short {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(&String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// A line's text, as long as a line may be.
#[derive(Debug, Serialize, JsonSchema, TS)]
pub struct Text(String);

/// Why a text is not a [`Text`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("a line is at most {} characters", TEXT_LIMIT)]
pub struct ParseTextError;

impl Text {
    /// # Errors
    ///
    /// [`ParseTextError`] when `text` is longer than a line may be.
    pub fn new(text: &str) -> Result<Self, ParseTextError> {
        if text.chars().count() > TEXT_LIMIT {
            Err(ParseTextError)
        } else {
            Ok(Self(text.to_owned()))
        }
    }
}

impl From<Text> for String {
    fn from(text: Text) -> Self {
        text.0
    }
}

impl<'de> Deserialize<'de> for Text {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(&String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// The name a bot goes by on its connector's service, without the `@`: 1
/// to 32 ASCII letters, digits or underscores, as Telegram spells one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
pub struct BotUsername(String);

/// Why a text is not a [`BotUsername`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("a bot's username is 1 to 32 ASCII letters, digits or underscores")]
pub struct ParseBotUsernameError;

impl BotUsername {
    /// # Errors
    ///
    /// [`ParseBotUsernameError`] when `text` is not in the pattern.
    pub fn new(text: &str) -> Result<Self, ParseBotUsernameError> {
        let in_pattern = (1..=USERNAME_LIMIT).contains(&text.len())
            && text
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');

        if in_pattern {
            Ok(Self(text.to_owned()))
        } else {
            Err(ParseBotUsernameError)
        }
    }
}

impl<'de> Deserialize<'de> for BotUsername {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(&String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}
