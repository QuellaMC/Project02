use std::fmt;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A Project02 identifier: an ASCII letter, then up to 127 ASCII letters,
/// digits, `.`, `_` or `-`. Characters, plugins and tools are named by one.
#[derive(
    Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema, TS,
)]
#[serde(try_from = "String")]
pub struct Identifier(String);

/// Why a text is not an [`Identifier`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error(
    "not an identifier: an ASCII letter, then up to 127 ASCII letters, digits, '.', '_' or '-'"
)]
pub struct ParseIdentifierError;

impl Identifier {
    /// The longest an identifier can be, in characters and in bytes alike.
    pub const MAX_LEN: usize = 128;

    /// # Errors
    ///
    /// [`ParseIdentifierError`] when `value` is not in the pattern.
    pub fn new(value: &str) -> Result<Self, ParseIdentifierError> {
        let mut bytes = value.bytes();
        let in_pattern = value.len() <= Self::MAX_LEN
            && bytes.next().is_some_and(|byte| byte.is_ascii_alphabetic())
            && bytes.all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte));

        if in_pattern {
            Ok(Self(value.to_owned()))
        } else {
            Err(ParseIdentifierError)
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// What two identifiers share when a case-insensitive volume, the
    /// default on macOS and Windows, would give them one directory. ASCII
    /// lowercase is the whole fold because the pattern is ASCII: widening the
    /// pattern means widening this.
    #[must_use]
    pub fn collision_key(&self) -> String {
        self.0.to_ascii_lowercase()
    }

    /// The identifier's words, capitalized: `zero-two` reads `Zero Two`.
    #[must_use]
    pub fn display_name(&self) -> String {
        self.0
            .split(['.', '_', '-'])
            .filter(|word| !word.is_empty())
            .map(|word| word[..1].to_ascii_uppercase() + &word[1..])
            .collect::<Vec<_>>()
            .join(" ")
    }
}

impl TryFrom<String> for Identifier {
    type Error = ParseIdentifierError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(&value)
    }
}

impl fmt::Display for Identifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn an_identifier_is_accepted_only_in_its_pattern_whether_built_or_read() {
        let longest = format!("a{}", "b".repeat(Identifier::MAX_LEN - 1));
        let too_long = format!("{longest}c");

        for (text, accepted) in [
            ("a", true),
            ("Zero-Two", true),
            ("mira_2.0", true),
            (longest.as_str(), true),
            ("", false),
            ("2b", false),
            ("-mira", false),
            ("zero two", false),
            ("caf\u{e9}", false),
            ("a/b", false),
            (too_long.as_str(), false),
        ] {
            assert_eq!(Identifier::new(text).is_ok(), accepted, "{text}");
            assert_eq!(
                serde_json::from_value::<Identifier>(json!(text)).is_ok(),
                accepted,
                "{text}"
            );
        }
    }

    #[test]
    fn identifiers_that_differ_only_in_case_collide() {
        let key = |text| Identifier::new(text).unwrap().collision_key();

        assert_eq!(key("Mira"), key("mira"));
        assert_ne!(key("mira"), key("mira2"));
    }

    #[test]
    fn a_display_name_capitalizes_each_word() {
        let name = |text| Identifier::new(text).unwrap().display_name();

        assert_eq!(name("zero-two"), "Zero Two");
        assert_eq!(name("mira.v2__beta"), "Mira V2 Beta");
    }
}
