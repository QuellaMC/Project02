#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod continuation;
mod conversation;
mod turn;

pub use conversation::{Character, Conversation, Delivery, Rotation, Submission};
pub use turn::{CompletedTurn, Progress, RejectedTurn, RunTurnError};
