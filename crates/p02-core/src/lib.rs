#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod conversation;
mod event;
mod id;
mod message;
mod selection;
mod session;

pub use conversation::{Conversation, ParseConversationError, Participant};
pub use event::{
    EventId, EventIdentity, ParseEventIdentityError, ParseIdError, ParseTimestampError, Timestamp,
    TraceId,
};
pub use id::{
    ConversationId, MessageId, ParseConversationIdError, ParseMessageIdError, ParseSessionIdError,
    SessionId,
};
pub use message::{
    BlankTextError, CharacterProfile, ClientStamp, ParseClientStampError, ParseSpeakerNameError,
    ParseVisibleTextError, SpeakerName, UserLine, VisibleMessage, VisibleMessageRole, VisibleText,
};
pub use selection::{SelectCharacterError, select_character};
pub use session::{AppendMessageError, Session};
