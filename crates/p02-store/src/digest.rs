use std::fmt::Write as _;

use sha2::{Digest as _, Sha256};

/// The SHA-256 digest of `bytes`, in lowercase hexadecimal.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .fold(String::with_capacity(64), |mut text, byte| {
            // Writing to a String cannot fail.
            let _ = write!(text, "{byte:02x}");
            text
        })
}
