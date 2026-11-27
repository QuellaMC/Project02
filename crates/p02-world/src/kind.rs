//! The kinds of thing, one list: each with the name a person reads it by,
//! and the icon and the tint a thing of it is kept with, names of the
//! page's own set.

/// The page's plainest icon and tint, which it draws whatever it does not
/// know with: a place she finds, and a thing of no kind of its own.
pub(crate) const PLAIN_ICON: &str = "grid";
pub(crate) const PLAIN_TINT: &str = "gray";

/// What kind of thing a thing is: she says it of what she makes, and the
/// person of what they leave her.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Kind {
    name: &'static str,
    display_name: &'static str,
    icon: &'static str,
    tint: &'static str,
}

impl Kind {
    /// Every kind, `other` last.
    pub const ALL: [Self; 8] = [
        Self::new("gift", "Gift", "gift", "pink"),
        Self::new("food", "Food", "fork", "orange"),
        Self::new("drink", "Drink", "cup", "brown"),
        Self::new("flower", "Flower", "flower", "mint"),
        Self::new("book", "Book", "book", "indigo"),
        Self::new("clothing", "Clothing", "shirt", "blue"),
        Self::new("letter", "Letter", "envelope", "teal"),
        Self::OTHER,
    ];

    /// The kind of a thing she gives none.
    pub const OTHER: Self = Self::new("other", "Other", PLAIN_ICON, PLAIN_TINT);

    const fn new(
        name: &'static str,
        display_name: &'static str,
        icon: &'static str,
        tint: &'static str,
    ) -> Self {
        Self {
            name,
            display_name,
            icon,
            tint,
        }
    }

    /// The kind called `name`, none when no kind is.
    #[must_use]
    pub fn named(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.name == name)
    }

    #[must_use]
    pub fn name(self) -> &'static str {
        self.name
    }

    /// The name a person reads it by.
    #[must_use]
    pub fn display_name(self) -> &'static str {
        self.display_name
    }

    #[must_use]
    pub fn icon(self) -> &'static str {
        self.icon
    }

    #[must_use]
    pub fn tint(self) -> &'static str {
        self.tint
    }
}
