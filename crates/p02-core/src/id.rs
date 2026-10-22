use std::fmt;
use std::num::NonZeroU64;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

/// A conversation: an ASCII letter or digit, then up to 55 ASCII letters,
/// digits, `_` or `-`. It holds no `.`, which is what parts it from the
/// segment number in the id of each of its sessions, and its length leaves
/// that id room for the segment within the 64 characters a tool admits.
#[derive(
    Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema, TS,
)]
#[serde(try_from = "String")]
pub struct ConversationId(String);

/// Why a text is not a [`ConversationId`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error(
    "not a conversation id: an ASCII letter or digit, then up to 55 ASCII letters, digits, '_' \
     or '-'"
)]
pub struct ParseConversationIdError;

impl ConversationId {
    const MAX_LEN: usize = 56;

    /// A new conversation's id, `conv_` and a random UUID: the one way an
    /// id is minted.
    #[must_use]
    pub fn mint() -> Self {
        Self(format!("conv_{}", Uuid::new_v4()))
    }

    /// # Errors
    ///
    /// [`ParseConversationIdError`] when `value` is not in the pattern.
    pub fn new(value: &str) -> Result<Self, ParseConversationIdError> {
        let mut bytes = value.bytes();
        let in_pattern = value.len() <= Self::MAX_LEN
            && bytes
                .next()
                .is_some_and(|byte| byte.is_ascii_alphanumeric())
            && bytes.all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte));

        if in_pattern {
            Ok(Self(value.to_owned()))
        } else {
            Err(ParseConversationIdError)
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for ConversationId {
    type Error = ParseConversationIdError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(&value)
    }
}

impl fmt::Display for ConversationId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// A session: one character's part in one segment of a conversation,
/// `<conversation id>.<segment>`. A conversation's first segment is 1, and
/// a session continued when its context fills is the next. Sessions order
/// by conversation, then by segment number.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct SessionId {
    conversation_id: ConversationId,
    segment: NonZeroU64,
}

/// Why a text is not a [`SessionId`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error(
    "not a session id: a conversation id, then '.' and a segment number from 1 without leading \
     zeros"
)]
pub struct ParseSessionIdError;

impl SessionId {
    #[must_use]
    pub fn new(conversation_id: ConversationId, segment: NonZeroU64) -> Self {
        Self {
            conversation_id,
            segment,
        }
    }

    /// # Errors
    ///
    /// [`ParseSessionIdError`] when `value` is not a conversation id and a
    /// segment number joined by `.`.
    pub fn parse(value: &str) -> Result<Self, ParseSessionIdError> {
        let (conversation, digits) = value.split_once('.').ok_or(ParseSessionIdError)?;
        let segment = counting_number(digits).ok_or(ParseSessionIdError)?;
        let conversation_id = ConversationId::new(conversation).map_err(|_| ParseSessionIdError)?;

        Ok(Self::new(conversation_id, segment))
    }

    #[must_use]
    pub fn conversation_id(&self) -> &ConversationId {
        &self.conversation_id
    }

    #[must_use]
    pub fn segment(&self) -> NonZeroU64 {
        self.segment
    }
}

impl TryFrom<String> for SessionId {
    type Error = ParseSessionIdError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl From<SessionId> for String {
    fn from(id: SessionId) -> Self {
        id.to_string()
    }
}

impl fmt::Display for SessionId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}.{}", self.conversation_id, self.segment)
    }
}

/// A message's place in its session: `<session id>:message-<n>`, numbered
/// from 1. Numbers climb but may skip, so a message's number is its order,
/// not a count.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, TS)]
#[serde(try_from = "String", into = "String")]
#[ts(as = "String")]
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
        let number = counting_number(digits).ok_or(ParseMessageIdError)?;
        let session_id = SessionId::parse(session).map_err(|_| ParseMessageIdError)?;

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

/// A number from 1, written without leading zeros.
fn counting_number(digits: &str) -> Option<NonZeroU64> {
    if digits.starts_with('0') || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }

    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn session(text: &str) -> SessionId {
        SessionId::parse(text).unwrap()
    }

    #[test]
    fn a_conversation_id_is_accepted_only_in_its_pattern() {
        let longest = format!("c{}", "1".repeat(55));
        let too_long = format!("{longest}2");

        for (text, accepted) in [
            ("conv_6f1c2b9e-77d0-4c43-9b8e-2f0f5d5a1e10", true),
            ("7_x-Y", true),
            (longest.as_str(), true),
            ("", false),
            ("_conv", false),
            ("conv.1", false),
            ("conv 1", false),
            ("conv:1", false),
            (too_long.as_str(), false),
        ] {
            assert_eq!(ConversationId::new(text).is_ok(), accepted, "{text}");
        }
    }

    #[test]
    fn a_minted_conversation_id_is_a_new_id_in_its_pattern() {
        let minted = ConversationId::mint();

        assert_eq!(ConversationId::new(minted.as_str()), Ok(minted.clone()));
        assert!(minted.as_str().starts_with("conv_"), "{minted}");
        assert_ne!(minted, ConversationId::mint());
    }

    #[test]
    fn a_session_id_names_its_conversation_and_its_segment() {
        let id = session("conv_a.12");

        assert_eq!(id.conversation_id().as_str(), "conv_a");
        assert_eq!(id.segment().get(), 12);
        assert_eq!(serde_json::to_value(&id).unwrap(), json!("conv_a.12"));
        assert_eq!(
            SessionId::new(ConversationId::new("chat").unwrap(), NonZeroU64::MIN).to_string(),
            "chat.1"
        );

        for text in [
            "conv_a",
            "conv_a.",
            "conv_a.0",
            "conv_a.01",
            "conv_a.1.2",
            "conv.a.1",
            ".1",
            "conv a.1",
            "conv_a.99999999999999999999",
        ] {
            assert_eq!(SessionId::parse(text), Err(ParseSessionIdError), "{text}");
            assert!(
                serde_json::from_value::<SessionId>(json!(text)).is_err(),
                "{text}"
            );
        }
    }

    #[test]
    fn sessions_order_by_conversation_then_by_segment_number() {
        let mut sessions = vec![session("b.1"), session("a.10"), session("a.9")];

        sessions.sort();

        assert_eq!(sessions, [session("a.9"), session("a.10"), session("b.1")]);
    }

    #[test]
    fn a_message_id_names_its_session_and_its_number() {
        let id = MessageId::parse("chat-1.2:message-14").unwrap();

        assert_eq!(id.session_id(), &session("chat-1.2"));
        assert_eq!(id.number().get(), 14);
        assert_eq!(
            serde_json::to_value(&id).unwrap(),
            json!("chat-1.2:message-14")
        );
        assert_eq!(
            MessageId::new(session("s.1"), NonZeroU64::MIN).to_string(),
            "s.1:message-1"
        );

        for text in [
            "chat.1:message-0",
            "chat.1:message-07",
            "chat.1:message-",
            "chat.1:message-1x",
            "chat.1-message-1",
            "chat:message-1",
            ":message-1",
            "a b.1:message-1",
            "chat.1:message-99999999999999999999",
        ] {
            assert_eq!(MessageId::parse(text), Err(ParseMessageIdError), "{text}");
        }
    }
}
