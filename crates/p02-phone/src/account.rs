//! The person's accounts her phone knows: its own short list, each of one
//! of two kinds. A key's is at one host, so a key the person gives for it
//! only ever goes there. A connection's is one of the person's AI services,
//! which asks for an app, so the app never holds what signs it in. An app
//! names the one it uses; it never says where its key goes.

/// An account of the person's that an app may use.
#[derive(Debug, PartialEq, Eq)]
pub struct Account {
    id: &'static str,
    name: &'static str,
    kind: AccountKind,
}

/// The two kinds of account an app may use.
#[derive(Debug, PartialEq, Eq)]
pub enum AccountKind {
    /// A key the person gives for the service at `host`, sent there and
    /// nowhere else, and `key_from`, one sentence on where they get one.
    Key {
        host: &'static str,
        key_from: &'static str,
    },
    /// A connection of the person's AI services, through which an app asks
    /// a model, once they allow it; it needs no host of the app's.
    Connection,
}

/// Every account the phone knows. A new service is a new line here.
static ACCOUNTS: [Account; 2] = [
    Account {
        id: "tavily",
        name: "Tavily",
        kind: AccountKind::Key {
            host: "api.tavily.com",
            key_from: "Get a free key at tavily.com.",
        },
    },
    Account {
        id: "chatgpt",
        name: "ChatGPT",
        kind: AccountKind::Connection,
    },
];

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

    /// Which of the two kinds it is: a key's, at its one host, or a
    /// connection's.
    #[must_use]
    pub fn kind(&self) -> &AccountKind {
        &self.kind
    }
}
