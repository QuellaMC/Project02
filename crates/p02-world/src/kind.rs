//! The kinds of thing she makes, one list: each stands for the icon and the
//! tint a thing of it is kept with, names of the page's own set.

/// The page's plainest icon and tint, which it draws whatever it does not
/// know with: a place she finds, and a thing of no kind of its own.
pub(crate) const PLAIN_ICON: &str = "grid";
pub(crate) const PLAIN_TINT: &str = "gray";

/// What kind of thing she makes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Kind {
    name: &'static str,
    pub(crate) icon: &'static str,
    pub(crate) tint: &'static str,
}

impl Kind {
    /// Every kind, `other` last.
    pub const ALL: [Self; 8] = [
        Self::new("gift", "gift", "pink"),
        Self::new("food", "fork", "orange"),
        Self::new("drink", "cup", "brown"),
        Self::new("flower", "flower", "mint"),
        Self::new("book", "book", "indigo"),
        Self::new("clothing", "shirt", "blue"),
        Self::new("letter", "envelope", "teal"),
        Self::OTHER,
    ];

    /// The kind of a thing she gives none.
    pub const OTHER: Self = Self::new("other", PLAIN_ICON, PLAIN_TINT);

    const fn new(name: &'static str, icon: &'static str, tint: &'static str) -> Self {
        Self { name, icon, tint }
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
}
