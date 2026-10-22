//! What a person reads of an error. Every error of the workspace displays
//! itself as a lowercase fragment, its cause kept beneath it; where a
//! person is told, the fragments become one sentence.

use std::error::Error;

/// `fragment` as a sentence: its first letter a capital, and a period
/// after it unless it ends a sentence already.
#[must_use]
pub fn sentence(fragment: &str) -> String {
    let mut characters = fragment.chars();
    let mut sentence: String = characters
        .next()
        .map(|first| first.to_uppercase().chain(characters).collect())
        .unwrap_or_default();

    if !sentence.ends_with(['.', '!', '?']) {
        sentence.push('.');
    }

    sentence
}

/// `error` and each cause beneath it as one sentence: what broke, then
/// why.
#[must_use]
pub fn error_sentence(error: &dyn Error) -> String {
    let mut words = error.to_string();
    let mut cause = error.source();

    while let Some(error) = cause {
        words.push_str(": ");
        words.push_str(&error.to_string());
        cause = error.source();
    }

    sentence(&words)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, thiserror::Error)]
    #[error("could not write the record")]
    struct Unwritten(#[source] std::io::Error);

    #[test]
    fn an_error_and_its_causes_read_as_one_sentence() {
        let refused = Unwritten(std::io::Error::other("the disk is full"));

        assert_eq!(
            error_sentence(&refused),
            "Could not write the record: the disk is full."
        );
        assert_eq!(sentence("ends already?"), "Ends already?");
        assert_eq!(sentence(""), ".");
    }
}
