#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod event;
mod id;
mod message;

pub use event::{
    EventId, EventIdentity, ParseEventIdentityError, ParseIdError, ParseTimestampError, Timestamp,
    TraceId,
};
pub use id::{MessageId, ParseMessageIdError, ParseSessionIdError, SessionId};
pub use message::{
    CharacterProfile, ParseSpeakerNameError, ParseVisibleTextError, SpeakerName, VisibleMessage,
    VisibleMessageRole, VisibleText,
};
