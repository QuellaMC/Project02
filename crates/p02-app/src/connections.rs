//! What of the person's her phone is linked to, as the home has it now:
//! the accounts whose key its settings hold, and the person's AI services
//! an app that asks a model signs in with, those connected: the ChatGPT
//! plan while the home is signed in, and the OpenAI API while the home's
//! settings hold its key. Through them the daemon answers an app's
//! question with the very adapter a character thinks with on that
//! service, on the home's sign-in or its key, at the stand-in the binary
//! names, asking nothing once her stop came.

use std::sync::Arc;

use async_trait::async_trait;
use p02_config::{Resolution, connection};
use p02_contracts::{TextCompletion, TextCompletionRequest};
use p02_phone::{Account, AccountKind, SignedIn};
use p02_plugins::{Connections, PHONE_PLUGIN, Unanswered, keyed_accounts};
use p02_role_model::ServiceSettings;
use p02_shared::Identifier;
use p02_wire::{
    AppConnection, AppSignInRefusal, AppSignedIn, Namespace, PlanAccount, RoleModelProvider,
};
use tokio_util::sync::CancellationToken;

use crate::character::{built, openai, plan};
use crate::daemon::{WeakDaemon, World, blocking};

/// What of the person's her phone is linked to now: the accounts whose key
/// the home's settings hold, the account the home is signed in to a
/// ChatGPT plan as, and the OpenAI API's key, which no client is told.
pub(crate) struct Linked {
    keyed: Vec<&'static Account>,
    plan: Option<PlanAccount>,
    openai_key: Option<String>,
}

/// The person's connections as one character's apps ask a model through
/// them: through the daemon, while it lasts, and only until her stop.
#[derive(Debug)]
pub(crate) struct PersonConnections {
    world: Arc<World>,
    daemon: WeakDaemon,
    stop: CancellationToken,
}

impl Linked {
    /// What the home links her phone to as it stands, read from its
    /// settings, none of them while they cannot be read, and from its
    /// sign-in. It waits on the disk.
    pub(crate) fn now(world: &World) -> Self {
        let home = Resolution::home(&world.home, &world.sections).ok();

        Self {
            keyed: home
                .as_ref()
                .map(|home| {
                    keyed_accounts(|field| {
                        home.section_value(Namespace::Plugins, PHONE_PLUGIN, field)
                    })
                })
                .unwrap_or_default(),
            plan: world.chatgpt.account(),
            openai_key: home.and_then(|home| home.settings().host().openai_api_key.clone()),
        }
    }

    /// Whether the person gave her phone the key of `account`, by the rule
    /// her phone takes a key by.
    pub(crate) fn has_key(&self, account: &'static Account) -> bool {
        self.keyed.contains(&account)
    }

    /// The connections an app whose account is `account` signs in with
    /// that are connected now, in the AI Model page's order.
    pub(crate) fn connections(&self, account: &Account) -> Vec<AppConnection> {
        signs_in_with(account)
            .iter()
            .filter(|service| self.connects(**service))
            .filter_map(|service| connection(*service, self.plan()))
            .collect()
    }

    /// How an app whose account is `account` is signed in, as `signed_in`
    /// keeps it, as a client is told it: the connection, one the app signs
    /// in with, and the model it asks, the one chosen, else the one its
    /// connection starts with. None for a connection it does not sign in
    /// with.
    pub(crate) fn signed_in(&self, account: &Account, signed_in: &SignedIn) -> Option<AppSignedIn> {
        let service = service_of(account, signed_in.connection.as_str())?;
        let model = match &signed_in.model {
            Some(model) => model.clone(),
            None => connection(service, self.plan())?.default_model,
        };

        Some(AppSignedIn {
            connection: service,
            model,
        })
    }

    /// The sign-in the person chose for the app `app`, whose account is
    /// `account`: with `service`, connected now, asking `model`, one it
    /// offers, or the one it starts with when none is named; or why not.
    pub(crate) fn chosen(
        &self,
        app: &str,
        account: &Account,
        service: RoleModelProvider,
        model: Option<String>,
    ) -> Result<SignedIn, (AppSignInRefusal, String)> {
        let Some(offered) = self
            .connections(account)
            .into_iter()
            .find(|connected| connected.id == service)
        else {
            return Err((
                AppSignInRefusal::NotConnected,
                match connection(service, None) {
                    Some(unconnected) if signs_in_with(account).contains(&service) => format!(
                        "Your {} is not connected. Connect it under AI Model first.",
                        unconnected.name
                    ),
                    _ => format!("{app} does not sign in with {service}."),
                },
            ));
        };

        if let Some(model) = &model
            && !offered.models.iter().any(|offers| offers.id == *model)
        {
            return Err((
                AppSignInRefusal::UnknownModel,
                format!("Your {} offers no model \"{model}\".", offered.name),
            ));
        }

        Ok(SignedIn {
            connection: Identifier::new(service.as_str()).expect("a service's id is an identifier"),
            model,
        })
    }

    /// The service the connection `named` is, one an app whose account is
    /// `account` signs in with, asking `model`, or the one it starts with
    /// when none is named, as a character's would be built on it; or, when
    /// it is not connected now, its name.
    fn service(
        &self,
        world: &World,
        daemon: &WeakDaemon,
        account: &Account,
        named: &str,
        model: Option<&str>,
    ) -> Result<ServiceSettings, Unanswered> {
        let unconnected = || Unanswered::NotConnected(named.to_owned());
        let service = service_of(account, named).ok_or_else(unconnected)?;
        let offered = connection(service, self.plan()).ok_or_else(unconnected)?;
        let model = model.map_or(offered.default_model, str::to_owned);

        match service {
            RoleModelProvider::Chatgpt if self.connects(service) => {
                Ok(plan(world, daemon, true, model))
            }
            RoleModelProvider::Openai if self.connects(service) => {
                Ok(openai(world, self.openai_key.clone(), model))
            }
            _ => Err(Unanswered::NotConnected(offered.name)),
        }
    }

    /// Whether `service` is connected now.
    fn connects(&self, service: RoleModelProvider) -> bool {
        match service {
            RoleModelProvider::Chatgpt => self.plan.is_some(),
            RoleModelProvider::Openai => self.openai_key.is_some(),
            RoleModelProvider::Nvidia => false,
        }
    }

    /// The plan the home is signed in to, as OpenAI named it.
    fn plan(&self) -> Option<&str> {
        self.plan
            .as_ref()
            .and_then(|account| account.plan.as_deref())
    }
}

impl PersonConnections {
    pub(crate) fn new(world: Arc<World>, daemon: WeakDaemon, stop: CancellationToken) -> Self {
        Self {
            world,
            daemon,
            stop,
        }
    }

    /// What a model answered `request` through `connection`, as
    /// [`Connections::ask`] says, whatever her stop.
    async fn answered(
        &self,
        account: &'static Account,
        connection: &str,
        model: Option<&str>,
        request: &TextCompletionRequest,
    ) -> Result<String, Unanswered> {
        let (world, daemon) = (Arc::clone(&self.world), self.daemon.clone());
        let (named, model) = (connection.to_owned(), model.map(str::to_owned));
        let service = blocking(move || {
            Linked::now(&world).service(&world, &daemon, account, &named, model.as_deref())
        })
        .await?;
        let adapter = built(&self.world, Some(&service)).map_err(Unanswered::Failed)?;

        match adapter.complete_text(request).await {
            TextCompletion::Completed { text, .. } => Ok(text),
            TextCompletion::Failed { reason } => Err(Unanswered::Failed(reason)),
            TextCompletion::Unsupported => Err(Unanswered::Failed(format!(
                "{} cannot answer a question.",
                account.name()
            ))),
        }
    }
}

#[async_trait]
impl Connections for PersonConnections {
    async fn connected(&self, account: &'static Account) -> Vec<AppConnection> {
        let world = Arc::clone(&self.world);

        blocking(move || Linked::now(&world).connections(account)).await
    }

    async fn ask(
        &self,
        account: &'static Account,
        connection: &str,
        model: Option<&str>,
        request: &TextCompletionRequest,
    ) -> Result<String, Unanswered> {
        tokio::select! {
            biased;
            () = self.stop.cancelled() => Err(Unanswered::Stopped),
            answered = self.answered(account, connection, model, request) => answered,
        }
    }
}

/// The person's AI services an app whose account is `account` signs in
/// with, in the AI Model page's order: OpenAI's two, the ChatGPT plan and
/// the OpenAI API, for a connection's; none for a key's.
fn signs_in_with(account: &Account) -> &'static [RoleModelProvider] {
    match account.kind() {
        AccountKind::Connection => &[RoleModelProvider::Chatgpt, RoleModelProvider::Openai],
        AccountKind::Key { .. } => &[],
    }
}

/// The service the connection `named` is, when an app whose account is
/// `account` signs in with it.
fn service_of(account: &Account, named: &str) -> Option<RoleModelProvider> {
    RoleModelProvider::parse(named).filter(|service| signs_in_with(account).contains(service))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The home linked to a plan of `plan` while it names one, and to the
    /// OpenAI API while `key` says so.
    fn linked(plan: Option<&str>, key: bool) -> Linked {
        Linked {
            keyed: Vec::new(),
            plan: plan.map(|plan| PlanAccount {
                email: None,
                plan: Some(plan.to_owned()),
            }),
            openai_key: key.then(|| "sk-key".to_owned()),
        }
    }

    /// An app asks a model through the person's services of OpenAI's that
    /// are connected, the plan before the API: each with the models it
    /// offers, a free plan fewer, and starting with the best a plan offers
    /// and the API's least costly, which a sign-in with no model chosen
    /// asks; a sign-in with a service it does not sign in with is none.
    #[test]
    fn each_connection_an_app_signs_in_with_offers_its_models_and_starts_with_its_own() {
        let chatgpt = Account::of("chatgpt").unwrap();
        let offered = |linked: &Linked| {
            linked
                .connections(chatgpt)
                .into_iter()
                .map(|connection| {
                    (
                        connection.id,
                        connection.models.len(),
                        connection.default_model,
                    )
                })
                .collect::<Vec<_>>()
        };
        let signed = |connection: &str, model: Option<&str>| SignedIn {
            connection: Identifier::new(connection).unwrap(),
            model: model.map(str::to_owned),
        };
        let both = linked(Some("plus"), true);

        assert_eq!(offered(&linked(None, false)), []);
        assert_eq!(
            offered(&linked(Some("free"), false)),
            [(RoleModelProvider::Chatgpt, 4, "gpt-6.1-terra".to_owned())]
        );
        assert_eq!(
            offered(&both),
            [
                (RoleModelProvider::Chatgpt, 7, "gpt-6.1-sol".to_owned()),
                (RoleModelProvider::Openai, 4, "gpt-6-luna".to_owned()),
            ]
        );
        assert_eq!(
            [
                both.signed_in(chatgpt, &signed("openai", None)),
                both.signed_in(chatgpt, &signed("chatgpt", Some("gpt-6-luna"))),
                both.signed_in(chatgpt, &signed("nvidia", None)),
            ],
            [
                Some(AppSignedIn {
                    connection: RoleModelProvider::Openai,
                    model: "gpt-6-luna".to_owned(),
                }),
                Some(AppSignedIn {
                    connection: RoleModelProvider::Chatgpt,
                    model: "gpt-6-luna".to_owned(),
                }),
                None,
            ]
        );
    }
}
