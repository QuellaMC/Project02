use std::fmt;

/// Whose memories: one person and one character. Recall and
/// deduplication span every session the two of them had.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Scope {
    user: String,
    agent: String,
}

impl Scope {
    #[must_use]
    pub fn new(user: impl Into<String>, agent: impl Into<String>) -> Self {
        Self {
            user: user.into(),
            agent: agent.into(),
        }
    }

    #[must_use]
    pub fn user(&self) -> &str {
        &self.user
    }

    #[must_use]
    pub fn agent(&self) -> &str {
        &self.agent
    }
}

/// Who said a message of a captured turn, as the extraction model reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
}

impl Role {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }

    pub(crate) fn parse(text: &str) -> Option<Self> {
        [Self::User, Self::Assistant]
            .into_iter()
            .find(|role| role.as_str() == text)
    }
}

/// One message of a captured turn: its role, and its text as the
/// extraction model is to read it, its speaker's name first.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    pub role: Role,
    pub content: String,
}

/// The day a conversation happened, `YYYY-MM-DD`, against which the
/// extraction model resolves "yesterday" and "next week".
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservedOn(String);

/// Why a text is not an [`ObservedOn`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("an observation date is written YYYY-MM-DD")]
pub struct ParseObservedOnError;

impl ObservedOn {
    /// # Errors
    ///
    /// [`ParseObservedOnError`] when `text` is not shaped `YYYY-MM-DD`.
    pub fn parse(text: &str) -> Result<Self, ParseObservedOnError> {
        let shaped = text.len() == 10
            && text.bytes().enumerate().all(|(at, byte)| match at {
                4 | 7 => byte == b'-',
                _ => byte.is_ascii_digit(),
            });

        if shaped {
            Ok(Self(text.to_owned()))
        } else {
            Err(ParseObservedOnError)
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A turn handed to the engine to extract memories from: the session it
/// belongs to, its messages, the events it came from, and its day.
#[derive(Clone, Debug)]
pub struct Turn {
    pub session: String,
    pub messages: Vec<Message>,
    pub sources: Vec<String>,
    pub observed_on: ObservedOn,
}

/// A memory's id, which no other memory of any store ever has.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct MemoryId(pub(crate) String);

impl MemoryId {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for MemoryId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// A memory the engine stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Memory {
    pub id: MemoryId,
    pub text: String,
}

/// A memory a search found, and its cosine similarity to the query.
#[derive(Clone, Debug, PartialEq)]
pub struct Hit {
    pub memory: Memory,
    pub score: f64,
}
