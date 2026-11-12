//! `phone.ai.ask`: an action asking a model a question through the
//! connection of the person's its app names as its account. The phone asks
//! nothing itself: a question is an ask of the action's host, which its
//! caller asks through that connection, so the app never holds what signs
//! it in.

use serde::{Deserialize, Serialize};

use crate::account::{Account, AccountKind};
use crate::asks::Asks;
use crate::exchange::TEXT_BYTES;
use crate::manifest::is_blank;

pub(crate) const ASK: &str = "phone.ai.ask takes {instructions, input}: input, the question, as \
                              text that is not blank, and, if it has them, instructions on how \
                              to answer, as text, each of 64 KiB at most";
pub(crate) const UNASKED: &str = "phone.ai.ask asks nothing here: only an action asks a model";

/// A question an action asks a model: what the script gave, as the phone
/// took it, and the connection of the person's it is asked through, its
/// app's account.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Question {
    instructions: Option<String>,
    input: String,
    account: &'static Account,
}

/// What a question was answered: the model's words, as text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Answer {
    pub text: String,
}

/// The question a script gives `ask`, as it gives it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Posed {
    instructions: Option<String>,
    input: String,
}

impl Question {
    /// The question `posed` is, once it keeps the rules of what `ask`
    /// takes and its app, which `asks` so, names a connection of the
    /// person's as its account; otherwise the words of what it breaks.
    pub(crate) fn of(posed: Posed, asks: &Asks) -> Result<Self, String> {
        let Posed {
            instructions,
            input,
        } = posed;
        let fits = |text: &str| text.len() <= TEXT_BYTES;

        if is_blank(&input) || !fits(&input) || !instructions.as_deref().is_none_or(fits) {
            return Err(ASK.to_owned());
        }

        let account = asks
            .account()
            .filter(|account| *account.kind() == AccountKind::Connection)
            .ok_or_else(unconnected)?;

        Ok(Self {
            instructions,
            input,
            account,
        })
    }

    /// How to answer, when the script said.
    #[must_use]
    pub fn instructions(&self) -> Option<&str> {
        self.instructions.as_deref()
    }

    /// The question.
    #[must_use]
    pub fn input(&self) -> &str {
        &self.input
    }

    /// The connection of the person's it is asked through: its app's
    /// account, of the kind [`AccountKind::Connection`].
    #[must_use]
    pub fn account(&self) -> &'static Account {
        self.account
    }
}

/// Why an app whose manifest names no connection asks nothing: what its
/// manifest must name.
fn unconnected() -> String {
    let connections: Vec<&str> = Account::all()
        .iter()
        .filter(|account| *account.kind() == AccountKind::Connection)
        .map(Account::id)
        .collect();

    format!(
        "phone.ai.ask asks nothing for this app: an app asks a model only through a connection \
         of the person's that its manifest names as its account, {}",
        connections.join(" or ")
    )
}
