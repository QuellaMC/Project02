use std::fmt;
use std::num::NonZeroU64;

use serde::{Deserialize, Serialize};

/// A session: one character's part in one conversation. An ASCII letter or
/// digit, then up to 63 ASCII letters, digits, `.`, `_` or `-`.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct SessionId(String);

/// Why a text is not a [`SessionId`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error(
    "not a session id: an ASCII letter or digit, then up to 63 ASCII letters, digits, '.', \
     '_' or '-'"
)]
pub struct ParseSessionIdError;

impl SessionId {
    const MAX_LEN: usize = 64;

    /// # Errors
    ///
    /// [`ParseSessionIdError`] when `value` is not in the pattern.
    pub fn new(value: &str) -> Result<Self, ParseSessionIdError> {
        let mut bytes = value.bytes();
        let in_pattern = value.len() <= Self::MAX_LEN
            && bytes
                .next()
                .is_some_and(|byte| byte.is_ascii_alphanumeric())
            && bytes.all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte));

        if in_pattern {
            Ok(Self(value.to_owned()))
        } else {
            Err(ParseSessionIdError)
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for SessionId {
    type Error = ParseSessionIdError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(&value)
    }
}

impl fmt::Display for SessionId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// A message's place in its session: `<session id>:message-<n>`, numbered
/// from 1. Numbers climb but may skip, so a message's number is its order,
/// not a count.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct MessageId {
    session_id: SessionId,
    number: NonZeroU64,
}

/// Why a text is not a [`MessageId`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error(
    "not a message id: a session id, then ':message-' and a number from 1 without leading zeros"
)]
pub struct ParseMessageIdError;

impl MessageId {
    const INFIX: &str = ":message-";

    #[must_use]
    pub fn new(session_id: SessionId, number: NonZeroU64) -> Self {
        Self { session_id, number }
    }

    /// # Errors
    ///
    /// [`ParseMessageIdError`] when `value` is not a session id and a
    /// message number joined by `:message-`.
    pub fn parse(value: &str) -> Result<Self, ParseMessageIdError> {
        let (session, digits) = value.rsplit_once(Self::INFIX).ok_or(ParseMessageIdError)?;

        if digits.starts_with('0') || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(ParseMessageIdError);
        }

        let number = digits.parse().map_err(|_| ParseMessageIdError)?;
        let session_id = SessionId::new(session).map_err(|_| ParseMessageIdError)?;

        Ok(Self { session_id, number })
    }

    #[must_use]
    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    #[must_use]
    pub fn number(&self) -> NonZeroU64 {
        self.number
    }
}

impl TryFrom<String> for MessageId {
    type Error = ParseMessageIdError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl From<MessageId> for String {
    fn from(id: MessageId) -> Self {
        id.to_string()
    }
}

impl fmt::Display for MessageId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}{}{}",
            self.session_id,
            Self::INFIX,
            self.number
        )
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_session_id_is_accepted_only_in_its_pattern() {
        let longest = format!("c{}", "1".repeat(63));
        let too_long = format!("{longest}2");

        for (text, accepted) in [
            ("conversation-7.1", true),
            ("7Mira_x", true),
            (longest.as_str(), true),
            ("", false),
            (".hidden", false),
            ("a/b", false),
            ("a:b", false),
            (too_long.as_str(), false),
        ] {
            assert_eq!(SessionId::new(text).is_ok(), accepted, "{text}");
        }
    }

    #[test]
    fn a_message_id_names_its_session_and_its_number() {
        let id = MessageId::parse("chat-1.2:message-14").unwrap();

        assert_eq!(id.session_id().as_str(), "chat-1.2");
        assert_eq!(id.number().get(), 14);
        assert_eq!(
            serde_json::to_value(&id).unwrap(),
            json!("chat-1.2:message-14")
        );
        assert_eq!(
            MessageId::new(SessionId::new("s").unwrap(), NonZeroU64::MIN).to_string(),
            "s:message-1"
        );

        for text in [
            "chat:message-0",
            "chat:message-07",
            "chat:message-",
            "chat:message-1x",
            "chat-message-1",
            ":message-1",
            "a b:message-1",
            "chat:message-99999999999999999999",
        ] {
            assert_eq!(MessageId::parse(text), Err(ParseMessageIdError), "{text}");
        }
    }
}
