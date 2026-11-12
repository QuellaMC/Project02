//! The home's sign-in to a ChatGPT plan as a client meets it: what health
//! says of it, and what came of starting one, calling off its wait or
//! signing out. No token is any part of it.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The home's sign-in to a ChatGPT plan as it stands.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(optional_fields)]
pub enum ChatgptSignIn {
    /// Not signed in: with why the last sign-in failed, or why the one the
    /// home kept could not be read, until the next start or sign-out.
    SignedOut {
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    /// A code waits for the person to approve it on OpenAI's page.
    Waiting {
        /// The code the person types there.
        code: String,
        /// Where they type it.
        url: String,
        /// When the code stops working, in milliseconds since the Unix
        /// epoch.
        expires_at: i64,
    },
    /// Signed in, to the account OpenAI named, on its plan, such as `plus`.
    SignedIn {
        #[serde(skip_serializing_if = "Option::is_none")]
        email: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        plan: Option<String>,
    },
}

/// What came of starting a sign-in, calling off its wait or signing out:
/// the sign-in as it then stands, or the sentence saying why it failed.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ChatgptOutcome {
    Ok { sign_in: ChatgptSignIn },
    Failed { message: String },
}
