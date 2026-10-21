use std::num::NonZeroU64;

use p02_shared::Identifier;

use crate::id::{MessageId, SessionId};
use crate::message::{
    CharacterProfile, LOCAL_USER, SpeakerName, UserLine, VisibleMessage, VisibleMessageRole,
    VisibleText,
};

/// One character's session: the messages of one segment of a conversation,
/// in the order they were committed. Each is numbered after the one before
/// it and said by the session's character or by the person, under the
/// names the session began with; a renamed character or person keeps their
/// old name here. Every message joins through [`Session::append`], whether
/// it is said now or read back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Session {
    id: SessionId,
    character: CharacterProfile,
    user_name: SpeakerName,
    messages: Vec<VisibleMessage>,
}

/// Why a message cannot join a [`Session`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum AppendMessageError {
    #[error("message \"{0}\" belongs to another session")]
    OtherSession(MessageId),
    #[error("message \"{id}\" does not climb after message {after}")]
    OutOfOrder { id: MessageId, after: NonZeroU64 },
    #[error("message \"{0}\" is not under its speaker's id and name in this session")]
    WrongSpeaker(MessageId),
}

impl Session {
    /// A session with no messages yet, whose character is `character` and
    /// whose person goes by `user_name`.
    #[must_use]
    pub fn new(id: SessionId, character: CharacterProfile, user_name: SpeakerName) -> Self {
        Self {
            id,
            character,
            user_name,
            messages: Vec::new(),
        }
    }

    #[must_use]
    pub fn id(&self) -> &SessionId {
        &self.id
    }

    #[must_use]
    pub fn character(&self) -> &CharacterProfile {
        &self.character
    }

    /// The name the person goes by in this session.
    #[must_use]
    pub fn user_name(&self) -> &SpeakerName {
        &self.user_name
    }

    #[must_use]
    pub fn messages(&self) -> &[VisibleMessage] {
        &self.messages
    }

    /// The person's line as the session's next message.
    #[must_use]
    pub fn user_message(&self, line: UserLine) -> VisibleMessage {
        VisibleMessage {
            id: self.next_id(),
            role: VisibleMessageRole::User,
            speaker_id: LOCAL_USER.clone(),
            speaker_name: self.user_name.clone(),
            text: line.into(),
        }
    }

    /// The character's reply as the session's next message.
    #[must_use]
    pub fn character_message(&self, text: VisibleText) -> VisibleMessage {
        VisibleMessage {
            id: self.next_id(),
            role: VisibleMessageRole::Character,
            speaker_id: self.character.id.clone(),
            speaker_name: self.character.display_name.clone(),
            text,
        }
    }

    /// Adds `message` after the last. Numbers climb but may skip: a message
    /// whose write failed spent its number, and the next never reuses it.
    ///
    /// # Errors
    ///
    /// [`AppendMessageError`] when `message` belongs to another session,
    /// does not climb after the last message, or is not under the id and
    /// name its role has in this session. The session is left as it was.
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

        let (speaker_id, speaker_name) = self.speaker(message.role);

        if &message.speaker_id != speaker_id || &message.speaker_name != speaker_name {
            return Err(AppendMessageError::WrongSpeaker(message.id));
        }

        Ok(self.messages.push_mut(message))
    }

    fn speaker(&self, role: VisibleMessageRole) -> (&Identifier, &SpeakerName) {
        match role {
            VisibleMessageRole::Character => (&self.character.id, &self.character.display_name),
            VisibleMessageRole::User => (&LOCAL_USER, &self.user_name),
        }
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

    fn mira() -> CharacterProfile {
        CharacterProfile {
            id: Identifier::new("mira").unwrap(),
            display_name: SpeakerName::new("Mira").unwrap(),
        }
    }

    fn session() -> Session {
        Session::new(
            SessionId::parse("conv_a.1").unwrap(),
            mira(),
            SpeakerName::new("Sam").unwrap(),
        )
    }

    fn line(text: &str) -> UserLine {
        UserLine::new(text).unwrap()
    }

    fn reply(text: &str) -> VisibleText {
        VisibleText::normalize(text).unwrap()
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

        session
            .append(session.user_message(line("do the thing")))
            .unwrap();
        session
            .append(session.character_message(reply("Looking into it.")))
            .unwrap();
        session
            .append(session.character_message(reply("Done:\n- the thing")))
            .unwrap();

        let said: Vec<(String, VisibleMessageRole, &str, &str, &str)> = session
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
            said,
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
        let first = session.user_message(line("first"));
        let after_gap = numbered(session.character_message(reply("third")), 3);

        session.append(first).unwrap();
        session.append(after_gap).unwrap();

        assert_eq!(
            session.user_message(line("fourth")).id.to_string(),
            "conv_a.1:message-4"
        );
    }

    #[test]
    fn a_message_joins_only_in_its_session_climbing_under_its_speaker() {
        let mut session = session();
        let first = session.user_message(line("first"));

        session.append(first.clone()).unwrap();

        let elsewhere = VisibleMessage {
            id: MessageId::parse("conv_b.1:message-2").unwrap(),
            ..first.clone()
        };
        let renamed = VisibleMessage {
            speaker_name: SpeakerName::new("Mira Two").unwrap(),
            ..session.character_message(reply("hello"))
        };
        let impostor = VisibleMessage {
            speaker_id: Identifier::new("mira").unwrap(),
            ..session.user_message(line("hello"))
        };
        let user_named_as_character = VisibleMessage {
            role: VisibleMessageRole::User,
            ..session.character_message(reply("hello"))
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

        for refused in [renamed, impostor, user_named_as_character] {
            assert_eq!(
                session.append(refused.clone()),
                Err(AppendMessageError::WrongSpeaker(refused.id))
            );
        }

        assert_eq!(session.messages().len(), 1);
    }
}
