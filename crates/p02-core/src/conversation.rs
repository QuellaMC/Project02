use p02_shared::Identifier;
use serde::{Deserialize, Serialize};

use crate::event::Timestamp;
use crate::id::ConversationId;
use crate::message::{CharacterProfile, LOCAL_USER, SpeakerName, VisibleMessageRole};

/// Someone a conversation is between, under the name they had when it
/// began: a later rename never renames the thread.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub kind: VisibleMessageRole,
    pub id: Identifier,
    pub display_name: SpeakerName,
}

impl Participant {
    /// The person, who is the speaker `local-user` in every conversation.
    #[must_use]
    pub fn local_user(display_name: SpeakerName) -> Self {
        Self {
            kind: VisibleMessageRole::User,
            id: LOCAL_USER.clone(),
            display_name,
        }
    }

    #[must_use]
    pub fn character(profile: CharacterProfile) -> Self {
        Self {
            kind: VisibleMessageRole::Character,
            id: profile.id,
            display_name: profile.display_name,
        }
    }

    /// Whether this is the person, whoever else a conversation is between.
    #[must_use]
    pub fn is_local_user(&self) -> bool {
        self.kind == VisibleMessageRole::User && self.id == *LOCAL_USER
    }

    fn key(&self) -> (VisibleMessageRole, &Identifier) {
        (self.kind, &self.id)
    }
}

/// One thread between a set of participants. A direct message is the
/// two-participant case; a group, or characters among themselves, is the
/// same shape with another set. Which sets a runtime can drive is the
/// driver's rule, never this model's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "UncheckedConversation")]
pub struct Conversation {
    id: ConversationId,
    participants: Vec<Participant>,
    created_at: Timestamp,
}

/// Why participants do not make a [`Conversation`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ParseConversationError {
    #[error("a conversation needs at least two participants")]
    TooFewParticipants,
    #[error("a conversation lists participant \"{id}\" twice")]
    RepeatedParticipant {
        kind: VisibleMessageRole,
        id: Identifier,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UncheckedConversation {
    id: ConversationId,
    participants: Vec<Participant>,
    created_at: Timestamp,
}

impl Conversation {
    /// A thread between `participants`, which it keeps in one order
    /// whatever order they come in: by kind, characters first, then by id.
    ///
    /// # Errors
    ///
    /// [`ParseConversationError`] when there are fewer than two
    /// participants, or one kind and id is listed twice.
    pub fn new(
        id: ConversationId,
        mut participants: Vec<Participant>,
        created_at: Timestamp,
    ) -> Result<Self, ParseConversationError> {
        participants.sort_by(|left, right| left.key().cmp(&right.key()));

        if participants.len() < 2 {
            return Err(ParseConversationError::TooFewParticipants);
        }

        if let Some([repeated, _]) = participants
            .array_windows()
            .find(|[left, right]| left.key() == right.key())
        {
            return Err(ParseConversationError::RepeatedParticipant {
                kind: repeated.kind,
                id: repeated.id.clone(),
            });
        }

        Ok(Self {
            id,
            participants,
            created_at,
        })
    }

    #[must_use]
    pub fn id(&self) -> &ConversationId {
        &self.id
    }

    #[must_use]
    pub fn participants(&self) -> &[Participant] {
        &self.participants
    }

    #[must_use]
    pub fn created_at(&self) -> &Timestamp {
        &self.created_at
    }

    /// Whether this is the thread between exactly `participants`, told
    /// apart by kind and id alone: their names are what each was called
    /// when it began.
    #[must_use]
    pub fn is_between(&self, participants: &[Participant]) -> bool {
        let mut keys: Vec<_> = participants.iter().map(Participant::key).collect();

        keys.sort();
        self.participants.iter().map(Participant::key).eq(keys)
    }
}

impl TryFrom<UncheckedConversation> for Conversation {
    type Error = ParseConversationError;

    fn try_from(unchecked: UncheckedConversation) -> Result<Self, Self::Error> {
        Self::new(unchecked.id, unchecked.participants, unchecked.created_at)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn name(text: &str) -> SpeakerName {
        SpeakerName::new(text).unwrap()
    }

    fn character(id: &str, display_name: &str) -> Participant {
        Participant::character(CharacterProfile {
            id: Identifier::new(id).unwrap(),
            display_name: name(display_name),
        })
    }

    fn conversation(
        participants: Vec<Participant>,
    ) -> Result<Conversation, ParseConversationError> {
        Conversation::new(
            ConversationId::new("conv_a").unwrap(),
            participants,
            Timestamp::new("2026-08-20T00:00:00.000Z").unwrap(),
        )
    }

    fn ids(conversation: &Conversation) -> Vec<&str> {
        conversation
            .participants()
            .iter()
            .map(|participant| participant.id.as_str())
            .collect()
    }

    #[test]
    fn a_conversation_keeps_its_participants_in_one_order_whatever_order_they_came_in() {
        let user = Participant::local_user(name("You"));
        let mira = character("mira", "Mira");
        let kai = character("kai", "Kai");

        let direct = conversation(vec![user.clone(), mira.clone()]).unwrap();

        assert_eq!(ids(&direct), ["mira", "local-user"]);
        assert_eq!(
            conversation(vec![mira.clone(), user.clone()]).unwrap(),
            direct
        );
        assert_eq!(
            ids(&conversation(vec![user, mira.clone(), kai.clone()]).unwrap()),
            ["kai", "mira", "local-user"]
        );
        assert_eq!(
            ids(&conversation(vec![mira, kai]).unwrap()),
            ["kai", "mira"]
        );
    }

    #[test]
    fn a_conversation_needs_two_participants_each_listed_once() {
        let mira = character("mira", "Mira");

        assert_eq!(
            conversation(vec![mira.clone()]),
            Err(ParseConversationError::TooFewParticipants)
        );
        assert_eq!(
            conversation(vec![mira.clone(), character("mira", "Other Mira")]),
            Err(ParseConversationError::RepeatedParticipant {
                kind: VisibleMessageRole::Character,
                id: Identifier::new("mira").unwrap(),
            })
        );

        let namesake = Participant {
            kind: VisibleMessageRole::User,
            ..mira.clone()
        };

        assert!(conversation(vec![mira, namesake]).is_ok());
    }

    #[test]
    fn a_conversation_reads_back_as_it_was_written() {
        let record = json!({
            "id": "conv_a",
            "participants": [
                {"kind": "character", "id": "mira", "displayName": "Mira"},
                {"kind": "user", "id": "local-user", "displayName": "You"},
            ],
            "createdAt": "2026-08-20T00:00:00.000Z",
        });
        let parsed: Conversation = serde_json::from_value(record.clone()).unwrap();

        assert_eq!(serde_json::to_value(&parsed).unwrap(), record);

        let mut alone = record;
        alone["participants"] = json!([{"kind": "user", "id": "local-user", "displayName": "You"}]);

        assert!(serde_json::from_value::<Conversation>(alone).is_err());
    }

    #[test]
    fn a_conversation_is_between_the_same_kinds_and_ids_whatever_their_names_or_order() {
        let user = Participant::local_user(name("You"));
        let mira = character("mira", "Mira");
        let thread = conversation(vec![user.clone(), mira.clone()]).unwrap();

        assert!(thread.is_between(&[
            character("mira", "Renamed"),
            Participant::local_user(name("Sam"))
        ]));
        assert!(!thread.is_between(&[user.clone(), character("kai", "Kai")]));
        assert!(!thread.is_between(&[user.clone(), mira.clone(), character("kai", "Kai")]));
        assert!(!thread.is_between(&[
            user,
            Participant {
                kind: VisibleMessageRole::User,
                ..mira
            }
        ]));
    }
}
