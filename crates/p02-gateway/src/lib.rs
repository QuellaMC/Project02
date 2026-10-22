#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

#[cfg(test)]
mod contract;
mod discovery;
mod events;
mod http;
mod page;
mod server;

pub use discovery::{Claim, ClaimOutcome};
pub use events::Ready;
pub use http::{
    AnswerBody, ErrorBody, GatewayMessage, OpenConversationBody, PairingRequestBody,
    PairingSubjectBody, ParseShortError, ParseTextError, Refusal, Short, Text,
};
pub use page::Page;
pub use server::{BindServerError, Server};
