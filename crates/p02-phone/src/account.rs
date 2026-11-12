//! The person's accounts her phone knows: its own short list, each at one
//! host, so a key the person gives for an account only ever goes there. An
//! app names the one it uses; it never says where its key goes.

/// An account of the person's at a service an app may use, with the key
/// the person gives for it.
#[derive(Debug, PartialEq, Eq)]
pub struct Account {
    id: &'static str,
    name: &'static str,
    host: &'static str,
}

/// Every account the phone knows. A new service is a new line here.
static ACCOUNTS: [Account; 1] = [Account {
    id: "tavily",
    name: "Tavily",
    host: "api.tavily.com",
}];

impl Account {
    /// Every account the phone knows, in its order.
    #[must_use]
    pub fn all() -> &'static [Self] {
        &ACCOUNTS
    }

    /// The account the phone knows as `id`.
    #[must_use]
    pub fn of(id: &str) -> Option<&'static Self> {
        ACCOUNTS.iter().find(|account| account.id == id)
    }

    /// What an app's manifest names it by: `tavily`.
    #[must_use]
    pub fn id(&self) -> &'static str {
        self.id
    }

    /// What the person knows it by: `Tavily`.
    #[must_use]
    pub fn name(&self) -> &'static str {
        self.name
    }

    /// The one host its key goes to.
    #[must_use]
    pub fn host(&self) -> &'static str {
        self.host
    }
}
