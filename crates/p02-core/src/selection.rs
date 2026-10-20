use p02_shared::Identifier;

/// Why no character was selected.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SelectCharacterError {
    #[error("no enabled character")]
    NoneEnabled,
    #[error("several characters are enabled: {}", listed(.0))]
    SeveralEnabled(Vec<Identifier>),
}

/// Which character a person talks to when they did not say: the only one
/// of the `enabled` characters, given in roster order. A character the
/// person names is theirs whatever this would say, and whoever starts her
/// judges the name.
///
/// # Errors
///
/// [`SelectCharacterError::NoneEnabled`] when `enabled` is empty, and
/// [`SelectCharacterError::SeveralEnabled`], naming them in order, when it
/// holds more than one.
pub fn select_character(
    enabled: impl IntoIterator<Item = Identifier>,
) -> Result<Identifier, SelectCharacterError> {
    let enabled: Vec<Identifier> = enabled.into_iter().collect();

    match <[Identifier; 1]>::try_from(enabled) {
        Ok([sole]) => Ok(sole),
        Err(enabled) if enabled.is_empty() => Err(SelectCharacterError::NoneEnabled),
        Err(enabled) => Err(SelectCharacterError::SeveralEnabled(enabled)),
    }
}

fn listed(ids: &[Identifier]) -> String {
    ids.iter()
        .map(Identifier::as_str)
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(texts: &[&str]) -> Vec<Identifier> {
        texts
            .iter()
            .map(|text| Identifier::new(text).unwrap())
            .collect()
    }

    #[test]
    fn the_sole_enabled_character_is_selected_and_none_or_several_are_refused() {
        assert_eq!(
            select_character(ids(&["mira"])),
            Ok(ids(&["mira"])[0].clone())
        );
        assert_eq!(
            select_character(ids(&[])),
            Err(SelectCharacterError::NoneEnabled)
        );

        let several = select_character(ids(&["mira", "zeta"])).unwrap_err();

        assert_eq!(
            several,
            SelectCharacterError::SeveralEnabled(ids(&["mira", "zeta"]))
        );
        assert_eq!(
            several.to_string(),
            "several characters are enabled: mira, zeta"
        );
    }
}
