//! The home's sign-in to a ChatGPT plan, `chatgpt-sign-in.json`: the tokens
//! OpenAI gave for it, written whole and owner-only by the daemon serving
//! the home, one write at a time, and read forgivingly.

use std::fmt;
use std::io;
use std::path::PathBuf;

use p02_shared::{read_file, remove_file, write_file_atomically};
use serde::{Deserialize, Serialize};

use crate::error::StorageError;
use crate::home::Home;
use crate::layout::CHATGPT_SIGN_IN_FILE;

/// The tokens of a sign-in to a ChatGPT plan and whose they are: what a
/// request on the plan carries, and what keeps it fresh. Its `Debug` shows
/// none of the tokens.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatgptTokens {
    pub access_token: String,
    /// Traded once for new tokens: OpenAI replaces it each time and
    /// refuses the old one.
    pub refresh_token: String,
    #[serde(default)]
    pub id_token: String,
    /// The ChatGPT account the requests are made on.
    pub account_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// The plan, such as `free`, `plus` or `pro`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// When the access token stops working, in milliseconds since the Unix
    /// epoch.
    pub expires_at: i64,
}

impl fmt::Debug for ChatgptTokens {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ChatgptTokens")
            .field("email", &self.email)
            .field("plan", &self.plan)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

impl Home {
    /// The home's sign-in to a ChatGPT plan as its file keeps it; none when
    /// there is no file.
    ///
    /// # Errors
    ///
    /// [`StorageError::Read`] when the file cannot be read, and
    /// [`StorageError::MalformedSignIn`] when it holds no sign-in: either
    /// way the home has none it can use, and the person signs in again.
    pub fn chatgpt_sign_in(&self) -> Result<Option<ChatgptTokens>, StorageError> {
        let path = self.chatgpt_sign_in_path();
        let content = match read_file(&path) {
            Ok(content) => content,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(source) => return Err(StorageError::Read { path, source }),
        };

        // What the file holds is never repeated, not even in a refusal.
        serde_json::from_slice(&content)
            .map(Some)
            .map_err(|_| StorageError::MalformedSignIn { path })
    }

    /// Keeps `tokens` as the home's sign-in, in place of the one before,
    /// whole and owner-only. Only the daemon serving the home writes it, one
    /// write at a time. A folder not yet a home is made one first, as
    /// anything kept there makes it.
    ///
    /// # Errors
    ///
    /// [`StorageError`] when the home is refused or the write fails, which
    /// leaves the sign-in as it was.
    #[expect(
        clippy::missing_panics_doc,
        reason = "tokens of plain fields always serialize"
    )]
    pub fn keep_chatgpt_sign_in(&self, tokens: &ChatgptTokens) -> Result<(), StorageError> {
        self.ensure()?;

        let path = self.chatgpt_sign_in_path();
        let mut content =
            serde_json::to_vec_pretty(tokens).expect("tokens of plain fields always serialize");

        content.push(b'\n');
        write_file_atomically(&path, &content).map_err(StorageError::write(&path))
    }

    /// Lets the home's sign-in go: its file is removed, and none there is
    /// no failure.
    ///
    /// # Errors
    ///
    /// [`StorageError::Write`] when the file is there and cannot be
    /// removed.
    pub fn forget_chatgpt_sign_in(&self) -> Result<(), StorageError> {
        let path = self.chatgpt_sign_in_path();

        remove_file(&path).map_err(StorageError::write(&path))
    }

    fn chatgpt_sign_in_path(&self) -> PathBuf {
        self.root().join(CHATGPT_SIGN_IN_FILE)
    }
}
