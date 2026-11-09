use std::num::NonZeroU64;

use p02_shared::Identifier;

use crate::id::{MessageId, SessionId};
use crate::message::{
    LOCAL_USER, SpeakerName, UserLine, VisibleMessage, VisibleMessageRole, VisibleText,
};

/// One character's session: the messages of one segment of a conversation,
/// in the order they were committed. Each is numbered after the one before
/// it and said by the session's character or by the person, under the name
/// its speaker had then. Every message joins through [`Session::append`],
/// whether it is said now or read back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Session {
    id: SessionId,
    character: Identifier,
    messages: Vec<VisibleMessage>,
}

/// Why a message cannot join a [`Session`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum AppendMessageError {
    #[error("message \"{0}\" belongs to another session")]
    OtherSession(MessageId),
    #[error("message \"{id}\" does not climb after message {after}")]
    OutOfOrder { id: MessageId, after: NonZeroU64 },
    #[error("message \"{0}\" is not under its speaker's id in this session")]
    WrongSpeaker(MessageId),
}

impl Session {
    /// A session with no messages yet, whose character is `character`.
    #[must_use]
    pub fn new(id: SessionId, character: Identifier) -> Self {
        Self {
            id,
            character,
            messages: Vec::new(),
        }
    }

    #[must_use]
    pub fn id(&self) -> &SessionId {
        &self.id
    }

    #[must_use]
    pub fn messages(&self) -> &[VisibleMessage] {
        &self.messages
    }

    /// The person's line, said under `name`, as the session's next message.
    #[must_use]
    pub fn user_message(&self, line: UserLine, name: SpeakerName) -> VisibleMessage {
        VisibleMessage {
            id: self.next_id(),
            role: VisibleMessageRole::User,
            speaker_id: LOCAL_USER.clone(),
            speaker_name: name,
            text: line.into(),
        }
    }

    /// The character's reply, said under `name`, as the session's next
    /// message.
    #[must_use]
    pub fn character_message(&self, text: VisibleText, name: SpeakerName) -> VisibleMessage {
        VisibleMessage {
            id: self.next_id(),
            role: VisibleMessageRole::Character,
            speaker_id: self.character.clone(),
            speaker_name: name,
            text,
        }
    }

    /// Adds `message` after the last. Numbers climb but may skip: a message
    /// whose write failed spent its number, and the next never reuses it.
    ///
    /// # Errors
    ///
    /// [`AppendMessageError`] when `message` belongs to another session,
    /// does not climb after the last message, or is not under the id its
    /// role has in this session. The session is left as it was.
    pub fn append(
        &mut self,
        message: VisibleMessage,
    ) -> Result<&VisibleMessage, AppendMessageError> {
        if message.id.session_id() != &self.id {
            return Err(AppendMessageError::OtherSession(message.id));
        }

        if let Some(last) = self.messages.last()
            && message.id.number() <= last.id.number()
        {
            return Err(AppendMessageError::OutOfOrder {
                after: last.id.number(),
                id: message.id,
            });
        }

        let speaker = match message.role {
            VisibleMessageRole::Character => &self.character,
            VisibleMessageRole::User => &*LOCAL_USER,
        };

        if &message.speaker_id != speaker {
            return Err(AppendMessageError::WrongSpeaker(message.id));
        }

        Ok(self.messages.push_mut(message))
    }

    /// The largest number has no successor; the repeat given in its place
    /// is refused by [`Session::append`].
    fn next_id(&self) -> MessageId {
        let number = self
            .messages
            .last()
            .map_or(NonZeroU64::MIN, |last| last.id.number().saturating_add(1));

        MessageId::new(self.id.clone(), number)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> Session {
        Session::new(
            SessionId::parse("conv_a.1").unwrap(),
            Identifier::new("mira").unwrap(),
        )
    }

    fn name(text: &str) -> SpeakerName {
        SpeakerName::new(text).unwrap()
    }

    /// Sam's line `text`, as the session's next message.
    fn said(session: &Session, text: &str) -> VisibleMessage {
        session.user_message(UserLine::new(text).unwrap(), name("Sam"))
    }

    /// Mira's reply `text`, as the session's next message.
    fn replied(session: &Session, text: &str) -> VisibleMessage {
        session.character_message(VisibleText::normalize(text).unwrap(), name("Mira"))
    }

    fn numbered(mut message: VisibleMessage, number: u64) -> VisibleMessage {
        message.id = MessageId::new(
            message.id.session_id().clone(),
            NonZeroU64::new(number).unwrap(),
        );
        message
    }

    #[test]
    fn messages_are_numbered_one_after_another_whoever_speaks() {
        let mut session = session();

        session.append(said(&session, "do the thing")).unwrap();
        session
            .append(replied(&session, "Looking into it."))
            .unwrap();
        session
            .append(replied(&session, "Done:\n- the thing"))
            .unwrap();

        let committed: Vec<(String, VisibleMessageRole, &str, &str, &str)> = session
            .messages()
            .iter()
            .map(|message| {
                (
                    message.id.to_string(),
                    message.role,
                    message.speaker_id.as_str(),
                    message.speaker_name.as_str(),
                    message.text.as_str(),
                )
            })
            .collect();

        assert_eq!(
            committed,
            [
                (
                    "conv_a.1:message-1".to_owned(),
                    VisibleMessageRole::User,
                    "local-user",
                    "Sam",
                    "do the thing"
                ),
                (
                    "conv_a.1:message-2".to_owned(),
                    VisibleMessageRole::Character,
                    "mira",
                    "Mira",
                    "Looking into it."
                ),
                (
                    "conv_a.1:message-3".to_owned(),
                    VisibleMessageRole::Character,
                    "mira",
                    "Mira",
                    "Done:\n- the thing"
                ),
            ]
        );
    }

    #[test]
    fn a_session_read_back_with_a_gap_numbers_its_next_message_after_the_last() {
        let mut session = session();
        let first = said(&session, "first");
        let after_gap = numbered(replied(&session, "third"), 3);

        session.append(first).unwrap();
        session.append(after_gap).unwrap();

        assert_eq!(
            said(&session, "fourth").id.to_string(),
            "conv_a.1:message-4"
        );
    }

    #[test]
    fn a_message_joins_only_in_its_session_climbing_under_its_speaker() {
        let mut session = session();
        let first = said(&session, "first");

        session.append(first.clone()).unwrap();

        let elsewhere = VisibleMessage {
            id: MessageId::parse("conv_b.1:message-2").unwrap(),
            ..first.clone()
        };
        let impostor = VisibleMessage {
            speaker_id: Identifier::new("mira").unwrap(),
            ..said(&session, "hello")
        };
        let user_named_as_character = VisibleMessage {
            role: VisibleMessageRole::User,
            ..replied(&session, "hello")
        };

        assert_eq!(
            session.append(elsewhere.clone()),
            Err(AppendMessageError::OtherSession(elsewhere.id))
        );
        assert_eq!(
            session.append(first.clone()),
            Err(AppendMessageError::OutOfOrder {
                id: first.id,
                after: NonZeroU64::MIN,
            })
        );

        for refused in [impostor, user_named_as_character] {
            assert_eq!(
                session.append(refused.clone()),
                Err(AppendMessageError::WrongSpeaker(refused.id))
            );
        }

        assert_eq!(session.messages().len(), 1);
    }
}
