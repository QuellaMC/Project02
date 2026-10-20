use std::fmt;

use serde::{Deserialize, Serialize};

/// A privacy label a record carries, such as `memory`: metadata for whoever
/// reads the record later. No rule of the runtime branches on its value.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct RedactionLabel(String);

/// Why a text is not a [`RedactionLabel`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("a redaction label must not be blank")]
pub struct ParseRedactionLabelError;

impl RedactionLabel {
    /// # Errors
    ///
    /// [`ParseRedactionLabelError`] when `value` is blank.
    pub fn new(value: &str) -> Result<Self, ParseRedactionLabelError> {
        if value.trim().is_empty() {
            Err(ParseRedactionLabelError)
        } else {
            Ok(Self(value.to_owned()))
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for RedactionLabel {
    type Error = ParseRedactionLabelError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(&value)
    }
}

impl fmt::Display for RedactionLabel {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// The labels of `first` and then of `second`, each once, in that order:
/// a record carries its turn's labels and its plugin's together.
#[must_use]
pub fn merged_labels(first: &[RedactionLabel], second: &[RedactionLabel]) -> Vec<RedactionLabel> {
    let mut merged = Vec::new();

    for label in first.iter().chain(second) {
        if !merged.contains(label) {
            merged.push(label.clone());
        }
    }

    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merged_labels_keep_the_first_order_and_appear_once() {
        let label = |text| RedactionLabel::new(text).unwrap();

        assert_eq!(
            merged_labels(
                &[label("private"), label("memory"), label("private")],
                &[label("memory"), label("secret")]
            ),
            [label("private"), label("memory"), label("secret")]
        );
        assert_eq!(RedactionLabel::new(" "), Err(ParseRedactionLabelError));
    }
}
