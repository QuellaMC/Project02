//! The home's sign-in to a ChatGPT plan: a code the person approves on
//! OpenAI's page, waited for at the pace OpenAI asks, and the tokens it
//! ends in, kept in the home and kept fresh until the person signs out or
//! OpenAI refuses to renew them. The daemon makes every request itself, at
//! OpenAI's sign-in or at the stand-in the binary names under its test
//! switch. This part alone writes the home's sign-in, each write under the
//! lock of what it holds, so the file and what the daemon holds change
//! together. Health says the sign-in as it stands, and goes to every
//! surface whenever that changes; the characters who think with the plan
//! are brought up to date with it then.

mod auth;

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use async_trait::async_trait;
use p02_role_model::{PlanAccess, PlanSignIn};
use p02_shared::{BaseUrl, error_chain, sentence};
use p02_store::{ChatgptTokens, Home, StorageError};
use p02_wire::{ChatgptOutcome, ChatgptSignIn, PlanAccount};
use tokio::task::AbortHandle;

use crate::daemon::{Daemon, WeakDaemon, blocking};
use auth::{Auth, DeviceCode, RefreshFailed, needs_refresh, now};

const UNREADABLE: &str = "Your ChatGPT sign-in could not be read, so this home is signed out. \
                          Sign in again.";
const SIGNED_OUT: &str = "Sign in to your ChatGPT plan first.";
const ENDED: &str = "OpenAI no longer accepts your ChatGPT sign-in, so this home is signed out. \
                     Sign in again.";

/// The home's sign-in, as the daemon holds it.
#[derive(Debug)]
pub(crate) struct Chatgpt {
    home: Home,
    auth: Arc<Auth>,
    state: Mutex<State>,
    /// Held across a refresh, so two uses at once refresh once: the second
    /// finds the first one's tokens fresh.
    refreshing: tokio::sync::Mutex<()>,
}

#[derive(Debug, Default)]
struct State {
    /// As the home's file keeps them.
    tokens: Option<ChatgptTokens>,
    waiting: Option<Waiting>,
    /// Why the last sign-in failed, or why the one the home kept could not
    /// be read, until the next start or sign-out.
    failure: Option<String>,
    /// How many waits began, so a wait's end counts only while it is the
    /// one waiting.
    begun: u64,
}

/// A code waiting for the person's approval, and the task that asks.
#[derive(Debug)]
struct Waiting {
    number: u64,
    code: DeviceCode,
    task: AbortHandle,
}

/// Why the home has no tokens to hand out: the sentence saying so, and
/// whether OpenAI ended the sign-in just now, which every surface is told.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct NoTokens {
    sentence: String,
    ended: bool,
}

impl NoTokens {
    fn because(sentence: impl Into<String>) -> Self {
        Self {
            sentence: sentence.into(),
            ended: false,
        }
    }
}

impl Chatgpt {
    /// The sign-in `home` keeps, made at OpenAI's sign-in, or at `stand_in`
    /// when a test harness names one. It waits on the disk.
    pub(crate) fn open(home: Home, stand_in: Option<BaseUrl>) -> Self {
        let (tokens, failure) = kept(&home);

        Self {
            home,
            auth: Arc::new(Auth::new(stand_in)),
            state: Mutex::new(State {
                tokens,
                failure,
                ..State::default()
            }),
            refreshing: tokio::sync::Mutex::default(),
        }
    }

    /// The sign-in as a client is told it: a code waiting, else the
    /// account kept, else signed out.
    pub(crate) fn view(&self) -> ChatgptSignIn {
        let state = self.state();

        match &state.waiting {
            Some(waiting) => self.waiting(&waiting.code),
            None => told(state.tokens.as_ref(), state.failure.clone()),
        }
    }

    /// `code` waiting, as a client is told it.
    fn waiting(&self, code: &DeviceCode) -> ChatgptSignIn {
        ChatgptSignIn::Waiting {
            code: code.user_code.clone(),
            url: self.auth.device_page(),
            expires_at: code.expires_at,
        }
    }

    /// Whom the home is signed in as, while it holds tokens, a wait on or
    /// not.
    pub(crate) fn account(&self) -> Option<PlanAccount> {
        self.state().tokens.as_ref().map(|tokens| PlanAccount {
            email: tokens.email.clone(),
            plan: tokens.plan.clone(),
        })
    }

    /// The tokens, fresh: within an hour of running out they are refreshed
    /// first, and the new ones kept before they are handed out, since
    /// OpenAI refuses the refresh token they replace. Two uses at once
    /// refresh once. Why there are none, when the home is not signed in or
    /// the refresh failed.
    pub(crate) async fn fresh(self: &Arc<Self>) -> Result<ChatgptTokens, NoTokens> {
        let _refreshing = self.refreshing.lock().await;
        let current = self.held()?;

        if !needs_refresh(&current, now()) {
            return Ok(current);
        }

        self.refresh(current).await
    }

    /// The tokens once the plan's service refused `refused`, the access
    /// token of some: refreshed whatever their age, unless another use
    /// replaced that one already, as [`Chatgpt::fresh`] answers otherwise.
    pub(crate) async fn refreshed(
        self: &Arc<Self>,
        refused: &str,
    ) -> Result<ChatgptTokens, NoTokens> {
        let _refreshing = self.refreshing.lock().await;
        let current = self.held()?;

        if current.access_token != refused && !needs_refresh(&current, now()) {
            return Ok(current);
        }

        self.refresh(current).await
    }

    /// Its wait is asked no more: the daemon stops.
    pub(crate) fn stop(&self) {
        self.call_off();
    }

    /// The tokens the home holds now.
    fn held(&self) -> Result<ChatgptTokens, NoTokens> {
        self.state()
            .tokens
            .clone()
            .ok_or_else(|| NoTokens::because(SIGNED_OUT))
    }

    /// `current` traded for new tokens, which are kept before they are
    /// handed out; a refresh OpenAI refuses ends the sign-in, and any other
    /// failure of it leaves the tokens as they were. Its caller holds the
    /// refreshing lock.
    async fn refresh(self: &Arc<Self>, current: ChatgptTokens) -> Result<ChatgptTokens, NoTokens> {
        let refreshed = self.auth.refresh(&current, now()).await;
        let chatgpt = Arc::clone(self);

        match refreshed {
            Ok(refreshed) => blocking(move || chatgpt.keep_refreshed(&current, refreshed)).await,
            Err(RefreshFailed::Refused) => blocking(move || chatgpt.ended(&current)).await,
            Err(RefreshFailed::Unanswered(sentence)) => Err(NoTokens::because(sentence)),
        }
    }

    /// Keeps `refreshed` in place of `current`, unless a sign-in or a
    /// sign-out since the refresh began had the last word. It waits on the
    /// disk.
    fn keep_refreshed(
        &self,
        current: &ChatgptTokens,
        refreshed: ChatgptTokens,
    ) -> Result<ChatgptTokens, NoTokens> {
        let mut state = self.state();

        match &state.tokens {
            Some(kept) if kept == current => {}
            Some(kept) => return Ok(kept.clone()),
            None => return Err(NoTokens::because(SIGNED_OUT)),
        }

        self.home
            .keep_chatgpt_sign_in(&refreshed)
            .map_err(|error| NoTokens::because(unsaved(&error)))?;
        state.tokens = Some(refreshed.clone());
        Ok(refreshed)
    }

    /// Ends the sign-in whose refresh OpenAI refused, `current`'s, unless a
    /// sign-in or a sign-out since the refresh began had the last word: the
    /// home is signed out, saying why, and its tokens leave it. It waits on
    /// the disk.
    fn ended(&self, current: &ChatgptTokens) -> Result<ChatgptTokens, NoTokens> {
        let mut state = self.state();

        match &state.tokens {
            Some(kept) if kept == current => {}
            Some(kept) => return Ok(kept.clone()),
            None => return Err(NoTokens::because(SIGNED_OUT)),
        }

        // Tokens a failed removal leaves behind are refused again at their
        // first use after a restart, and the next sign-in replaces them.
        let _ = self.home.forget_chatgpt_sign_in();

        state.tokens = None;
        state.failure = Some(ENDED.to_owned());
        Err(NoTokens {
            sentence: ENDED.to_owned(),
            ended: true,
        })
    }

    /// Waits for `code`'s approval on a task of its own, in place of any
    /// wait before, and answers the wait as a client is told it. The task
    /// tells every surface of the code, then asks; what came of it goes to
    /// the daemon, while the daemon lasts.
    fn begin(&self, daemon: WeakDaemon, code: DeviceCode) -> ChatgptSignIn {
        let mut state = self.state();

        if let Some(earlier) = state.waiting.take() {
            earlier.task.abort();
        }

        state.begun += 1;

        let number = state.begun;
        let auth = Arc::clone(&self.auth);
        let asked = code.clone();
        // Spawned with the state held, so the wait is in place before it
        // can end; and it tells of the code itself, so no surface hears of
        // the code after it hears how its wait ended.
        let task = tokio::spawn(async move {
            if let Some(told) = daemon.upgrade() {
                told.announced().await;
            }

            let approved = auth.approval(&asked).await;

            if let Some(ended) = daemon.upgrade() {
                blocking(move || ended.wait_ended(number, approved)).await;
            }
        })
        .abort_handle();
        let waiting = self.waiting(&code);

        state.waiting = Some(Waiting { number, code, task });
        state.failure = None;
        waiting
    }

    /// Ends wait `number` as `approved` says, unless it no longer waits:
    /// its tokens kept, or why it failed. True when it waited. It waits on
    /// the disk.
    fn end(&self, number: u64, approved: Result<ChatgptTokens, String>) -> bool {
        let mut state = self.state();

        if state
            .waiting
            .as_ref()
            .is_none_or(|waiting| waiting.number != number)
        {
            return false;
        }

        state.waiting = None;
        state.failure = match approved {
            Ok(tokens) => match self.home.keep_chatgpt_sign_in(&tokens) {
                Ok(()) => {
                    state.tokens = Some(tokens);
                    None
                }
                Err(error) => Some(unsaved(&error)),
            },
            Err(message) => Some(message),
        };
        true
    }

    /// Why a start found no code to wait on, kept to tell.
    fn failed(&self, message: String) {
        self.state().failure = Some(message);
    }

    /// Ends the wait, if one is on; true when one was.
    fn call_off(&self) -> bool {
        let waiting = self.state().waiting.take();

        waiting.is_some_and(|waiting| {
            waiting.task.abort();
            true
        })
    }

    /// Lets the tokens go, and any wait with them; the sentence saying why
    /// they could not be, when their file stays. It waits on the disk.
    fn sign_out(&self) -> Result<(), String> {
        let mut state = self.state();

        self.home
            .forget_chatgpt_sign_in()
            .map_err(|error| sentence(&error_chain(&error)))?;

        if let Some(waiting) = state.waiting.take() {
            waiting.task.abort();
        }

        state.tokens = None;
        state.failure = None;
        Ok(())
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Daemon {
    /// Asks OpenAI for a code the person approves on its page, and waits
    /// for the approval in place of any wait before, at the pace OpenAI
    /// asks, on a task of its own: answered with the code, where the person
    /// types it and when it stops working; or why OpenAI gave none, any
    /// wait before going on. Every surface hears the sign-in as it then
    /// stands, and again when the wait ends, signed in or failed.
    pub async fn start_chatgpt_sign_in(&self) -> ChatgptOutcome {
        let chatgpt = &self.world().chatgpt;

        match chatgpt.auth.device_code(now()).await {
            Ok(code) => ChatgptOutcome::Ok {
                sign_in: chatgpt.begin(self.downgrade(), code),
            },
            Err(message) => {
                chatgpt.failed(message.clone());
                self.announced().await;
                ChatgptOutcome::Failed { message }
            }
        }
    }

    /// Calls off the wait for the person's approval: no sign-in comes of
    /// it, and the home keeps what it held. Answered with the sign-in as it
    /// then stands; every surface hears it when a wait was on.
    pub async fn cancel_chatgpt_sign_in(&self) -> ChatgptOutcome {
        let chatgpt = &self.world().chatgpt;

        if chatgpt.call_off() {
            self.announced().await;
        }

        ChatgptOutcome::Ok {
            sign_in: chatgpt.view(),
        }
    }

    /// Signs the home out of its ChatGPT plan: its tokens leave the home,
    /// and any wait ends. Every surface hears it, and the characters who
    /// think with the plan then need a model; a sign-in whose file could
    /// not be removed stands, and the answer says why.
    pub async fn sign_out_of_chatgpt(&self) -> ChatgptOutcome {
        let daemon = self.clone();

        blocking(move || {
            let chatgpt = &daemon.world().chatgpt;

            match chatgpt.sign_out() {
                Ok(()) => {
                    daemon.sign_in_changed();
                    ChatgptOutcome::Ok {
                        sign_in: chatgpt.view(),
                    }
                }
                Err(message) => ChatgptOutcome::Failed { message },
            }
        })
        .await
    }

    /// Ends wait `number` as `approved` says, and when it was still the one
    /// waiting, tells every surface and brings the characters who think
    /// with the plan up to date. It waits on the disk.
    fn wait_ended(&self, number: u64, approved: Result<ChatgptTokens, String>) {
        if self.world().chatgpt.end(number, approved) {
            self.sign_in_changed();
        }
    }

    /// What a request on the plan carries: the home's tokens fresh, or,
    /// once its service refused `refused`, an access token, refreshed. When
    /// OpenAI ended the sign-in instead, every surface hears it, and the
    /// characters who think with the plan then need a model.
    async fn plan_access(&self, refused: Option<&str>) -> Result<PlanAccess, String> {
        let chatgpt = &self.world().chatgpt;
        let tokens = match refused {
            None => chatgpt.fresh().await,
            Some(refused) => chatgpt.refreshed(refused).await,
        };

        match tokens {
            Ok(tokens) => Ok(PlanAccess {
                access_token: tokens.access_token,
                account_id: tokens.account_id,
            }),
            Err(NoTokens { sentence, ended }) => {
                if ended {
                    let daemon = self.clone();

                    blocking(move || daemon.sign_in_changed()).await;
                }

                Err(sentence)
            }
        }
    }

    /// The home's sign-in changed: health as it now stands goes to every
    /// surface, and a reconcile pass brings each running character up to
    /// date with it, built again when she thinks with the plan. It waits on
    /// the disk.
    fn sign_in_changed(&self) {
        self.announce_health();
        tokio::spawn(self.reconcile());
    }

    /// Health as it now stands, sent to every surface from the blocking
    /// pool.
    async fn announced(&self) {
        let daemon = self.clone();

        blocking(move || daemon.announce_health()).await;
    }
}

/// The home's sign-in as a character's ChatGPT plan reaches it, through
/// the daemon, while it lasts.
#[derive(Debug)]
pub(crate) struct PlanTokens(WeakDaemon);

impl PlanTokens {
    pub(crate) fn new(daemon: WeakDaemon) -> Self {
        Self(daemon)
    }

    fn daemon(&self) -> Result<Daemon, String> {
        self.0
            .upgrade()
            .ok_or_else(|| "The daemon is stopped.".to_owned())
    }
}

#[async_trait]
impl PlanSignIn for PlanTokens {
    async fn fresh(&self) -> Result<PlanAccess, String> {
        self.daemon()?.plan_access(None).await
    }

    async fn refreshed(&self, refused: &PlanAccess) -> Result<PlanAccess, String> {
        self.daemon()?
            .plan_access(Some(&refused.access_token))
            .await
    }
}

/// The home's sign-in as its file keeps it, as `inspect` reports it with
/// no daemon serving the home: the account OpenAI named and its plan, or
/// signed out, saying why when the file could not be read. No token is
/// any part of it. It waits on the disk.
#[must_use]
pub fn kept_sign_in(home: &Home) -> ChatgptSignIn {
    let (tokens, failure) = kept(home);

    told(tokens.as_ref(), failure)
}

/// What `home` keeps of its sign-in: its tokens, or why it holds none it
/// can use.
fn kept(home: &Home) -> (Option<ChatgptTokens>, Option<String>) {
    match home.chatgpt_sign_in() {
        Ok(tokens) => (tokens, None),
        Err(_) => (None, Some(UNREADABLE.to_owned())),
    }
}

/// A sign-in no code waits for, as a client is told it.
fn told(tokens: Option<&ChatgptTokens>, failure: Option<String>) -> ChatgptSignIn {
    match tokens {
        Some(tokens) => ChatgptSignIn::SignedIn {
            email: tokens.email.clone(),
            plan: tokens.plan.clone(),
        },
        None => ChatgptSignIn::SignedOut { message: failure },
    }
}

/// Why tokens OpenAI gave could not be kept.
fn unsaved(error: &StorageError) -> String {
    sentence(&format!(
        "your ChatGPT sign-in could not be saved: {}",
        error_chain(error)
    ))
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use axum::Router;
    use axum::http::StatusCode;
    use axum::http::header::CONTENT_TYPE;
    use axum::routing::post;
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use p02_shared::{DanglingLinks, canonical_path};
    use serde_json::{Value, json};
    use tokio::net::TcpListener;

    use super::*;
    use auth::{Identity, expiry, identity};

    /// A JWT with this payload; nothing checks its signature.
    fn jwt(payload: &Value) -> String {
        let encode = |value: &Value| URL_SAFE_NO_PAD.encode(value.to_string());

        format!(
            "{}.{}.signature",
            encode(&json!({"alg": "none"})),
            encode(payload)
        )
    }

    #[test]
    fn an_id_token_names_the_account_its_email_and_its_plan_and_a_token_when_it_runs_out() {
        let id_token = jwt(&json!({
            "email": "sam@example.com",
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "acct-sam",
                "chatgpt_plan_type": "Plus",
            },
        }));

        assert_eq!(
            identity(&id_token),
            Identity {
                account_id: Some("acct-sam".to_owned()),
                email: Some("sam@example.com".to_owned()),
                plan: Some("plus".to_owned()),
            }
        );
        assert_eq!(
            identity(&jwt(&json!({"email": "sam@example.com"}))),
            Identity {
                email: Some("sam@example.com".to_owned()),
                ..Identity::default()
            }
        );
        assert_eq!(identity("not a jwt"), Identity::default());
        assert_eq!(
            expiry(&jwt(&json!({"exp": 2_000_000_000}))),
            Some(2_000_000_000_000)
        );
        assert_eq!(expiry("opaque"), None);
    }

    #[test]
    fn a_token_is_refreshed_within_an_hour_of_running_out() {
        let now = 1_000_000;
        let lasting = |minutes: i64| ChatgptTokens {
            access_token: String::new(),
            refresh_token: String::new(),
            id_token: String::new(),
            account_id: String::new(),
            email: None,
            plan: None,
            expires_at: now + minutes * 60 * 1000,
        };

        assert!(needs_refresh(&lasting(-1), now));
        assert!(needs_refresh(&lasting(30), now));
        assert!(!needs_refresh(&lasting(120), now));
    }

    /// OpenAI's token endpoint on loopback, which keeps each form it is
    /// sent and answers them with `answers`, a status and a body each, in
    /// order.
    async fn token_endpoint(answers: Vec<(u16, Value)>) -> (BaseUrl, Arc<Mutex<Vec<String>>>) {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let kept = Arc::clone(&sent);
        let answers = Arc::new(Mutex::new(VecDeque::from(answers)));
        let app = Router::new().route(
            "/oauth/token",
            post(move |form: String| {
                kept.lock().unwrap().push(form);

                let (status, answer) = answers.lock().unwrap().pop_front().unwrap();

                async move {
                    (
                        StatusCode::from_u16(status).unwrap(),
                        [(CONTENT_TYPE, "application/json")],
                        answer.to_string(),
                    )
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = BaseUrl::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();

        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (base, sent)
    }

    /// A refresh trades the refresh token once, keeps what OpenAI left out
    /// of its answer, and is in the home before either use has it.
    #[tokio::test]
    async fn a_refresh_is_kept_before_it_is_used_and_two_uses_at_once_refresh_once() {
        let directory = tempfile::tempdir().unwrap();
        let home = Home::new(canonical_path(directory.path(), DanglingLinks::Keep).unwrap());
        // Long run out, and fresh for years once refreshed, whatever the
        // clock reads.
        let stale = ChatgptTokens {
            access_token: "access-1".to_owned(),
            refresh_token: "refresh-1".to_owned(),
            id_token: "id-1".to_owned(),
            account_id: "acct-sam".to_owned(),
            email: Some("sam@example.com".to_owned()),
            plan: Some("plus".to_owned()),
            expires_at: 0,
        };
        let access = jwt(&json!({"exp": 2_000_000_000}));
        let (base, sent) = token_endpoint(vec![(
            200,
            json!({"access_token": access, "refresh_token": "refresh-2"}),
        )])
        .await;

        home.keep_chatgpt_sign_in(&stale).unwrap();

        let chatgpt = Arc::new(Chatgpt::open(home.clone(), Some(base)));
        let (first, second) = tokio::join!(chatgpt.fresh(), chatgpt.fresh());
        let fresh = first.unwrap();

        assert_eq!(
            fresh,
            ChatgptTokens {
                access_token: access,
                refresh_token: "refresh-2".to_owned(),
                expires_at: 2_000_000_000_000,
                ..stale
            }
        );
        assert_eq!(second.unwrap(), fresh);
        assert_eq!(home.chatgpt_sign_in().unwrap(), Some(fresh));
        assert_eq!(
            *sent.lock().unwrap(),
            [
                "client_id=app_EMoamEEZ73f0CkXaXp7hrann&grant_type=refresh_token&\
                 refresh_token=refresh-1&scope=openid+profile+email"
            ]
        );
    }

    /// Once the plan's service refused a token, a use refreshes it whatever
    /// its age, unless another use replaced that token already. A refresh
    /// that meets a server's error ends nothing, and one OpenAI refuses
    /// ends the sign-in: the home is signed out, saying why, and its tokens
    /// leave it.
    #[tokio::test]
    async fn a_refused_token_is_refreshed_once_and_a_refused_refresh_ends_the_sign_in() {
        let directory = tempfile::tempdir().unwrap();
        let home = Home::new(canonical_path(directory.path(), DanglingLinks::Keep).unwrap());
        // Fresh for years, whatever the clock reads.
        let kept = ChatgptTokens {
            access_token: "access-1".to_owned(),
            refresh_token: "refresh-1".to_owned(),
            id_token: String::new(),
            account_id: "acct-sam".to_owned(),
            email: Some("sam@example.com".to_owned()),
            plan: Some("plus".to_owned()),
            expires_at: 2_000_000_000_000,
        };
        let access = jwt(&json!({"exp": 2_000_000_000}));
        let (base, sent) = token_endpoint(vec![
            (
                200,
                json!({"access_token": access, "refresh_token": "refresh-2"}),
            ),
            (500, json!({})),
            (401, json!({"error": {"message": "refresh_token_reused"}})),
        ])
        .await;

        home.keep_chatgpt_sign_in(&kept).unwrap();

        let chatgpt = Arc::new(Chatgpt::open(home.clone(), Some(base)));

        assert_eq!(chatgpt.refreshed("access-0").await, Ok(kept.clone()));

        let refreshed = chatgpt.refreshed("access-1").await.unwrap();

        assert_eq!(
            (
                refreshed.access_token.as_str(),
                refreshed.refresh_token.as_str()
            ),
            (access.as_str(), "refresh-2")
        );
        assert_eq!(
            chatgpt.refreshed(&access).await,
            Err(NoTokens::because(
                "OpenAI could not renew your ChatGPT sign-in just now (status 500). Try again \
                 in a moment."
            ))
        );
        assert_eq!(home.chatgpt_sign_in().unwrap(), Some(refreshed));
        assert_eq!(
            chatgpt.refreshed(&access).await,
            Err(NoTokens {
                sentence: ENDED.to_owned(),
                ended: true,
            })
        );
        assert_eq!(home.chatgpt_sign_in().unwrap(), None);
        assert_eq!(
            (chatgpt.view(), chatgpt.account()),
            (
                ChatgptSignIn::SignedOut {
                    message: Some(ENDED.to_owned())
                },
                None
            )
        );
        // Nothing was traded for the token another use replaced.
        assert_eq!(
            sent.lock()
                .unwrap()
                .iter()
                .filter_map(|form| {
                    form_urlencoded::parse(form.as_bytes())
                        .find(|(field, _)| field == "refresh_token")
                        .map(|(_, token)| token.into_owned())
                })
                .collect::<Vec<_>>(),
            ["refresh-1", "refresh-2", "refresh-2"]
        );
    }
}
