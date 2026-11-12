//! The home's sign-in to a ChatGPT plan: a code the person approves on
//! OpenAI's page, waited for at the pace OpenAI asks, and the tokens it
//! ends in, kept in the home and kept fresh until the person signs out.
//! The daemon makes every request itself, at OpenAI's sign-in or at the
//! stand-in the binary names under its test switch. This part alone writes
//! the home's sign-in, each write under the lock of what it holds, so the
//! file and what the daemon holds change together. Health says the sign-in
//! as it stands, and goes to every surface whenever that changes.

mod auth;

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use p02_shared::{BaseUrl, error_chain, sentence};
use p02_store::{ChatgptTokens, Home, StorageError};
use p02_wire::{ChatgptOutcome, ChatgptSignIn};
use tokio::task::AbortHandle;

use crate::daemon::{Daemon, WeakDaemon, blocking};
use auth::{Auth, DeviceCode, needs_refresh, now};

const UNREADABLE: &str = "Your ChatGPT sign-in could not be read, so this home is signed out. \
                          Sign in again.";
const SIGNED_OUT: &str = "Sign in to your ChatGPT plan first.";

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

    /// The tokens, fresh: within an hour of running out they are refreshed
    /// first, and the new ones kept before they are handed out, since
    /// OpenAI refuses the refresh token they replace. Two uses at once
    /// refresh once. The sentence saying why there are none, when the home
    /// is not signed in or a refresh failed.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "nothing thinks with the plan yet: its service, which asks for the tokens \
                      before each request, is their one reader"
        )
    )]
    pub(crate) async fn fresh(self: &Arc<Self>) -> Result<ChatgptTokens, String> {
        let _refreshing = self.refreshing.lock().await;
        let current = self.state().tokens.clone().ok_or(SIGNED_OUT)?;

        if !needs_refresh(&current, now()) {
            return Ok(current);
        }

        let refreshed = self.auth.refresh(&current, now()).await?;
        let chatgpt = Arc::clone(self);

        blocking(move || chatgpt.keep_refreshed(&current, refreshed)).await
    }

    /// Its wait is asked no more: the daemon stops.
    pub(crate) fn stop(&self) {
        self.call_off();
    }

    /// Keeps `refreshed` in place of `current`, unless a sign-in or a
    /// sign-out since the refresh began had the last word. It waits on the
    /// disk.
    fn keep_refreshed(
        &self,
        current: &ChatgptTokens,
        refreshed: ChatgptTokens,
    ) -> Result<ChatgptTokens, String> {
        let mut state = self.state();

        match &state.tokens {
            Some(kept) if kept == current => {}
            Some(kept) => return Ok(kept.clone()),
            None => return Err(SIGNED_OUT.to_owned()),
        }

        self.home
            .keep_chatgpt_sign_in(&refreshed)
            .map_err(|error| unsaved(&error))?;
        state.tokens = Some(refreshed.clone());
        Ok(refreshed)
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
    /// and any wait ends. Every surface hears it; a sign-in whose file
    /// could not be removed stands, and the answer says why.
    pub async fn sign_out_of_chatgpt(&self) -> ChatgptOutcome {
        let daemon = self.clone();

        blocking(move || {
            let chatgpt = &daemon.world().chatgpt;

            match chatgpt.sign_out() {
                Ok(()) => {
                    daemon.announce_health();
                    ChatgptOutcome::Ok {
                        sign_in: chatgpt.view(),
                    }
                }
                Err(message) => ChatgptOutcome::Failed { message },
            }
        })
        .await
    }

    /// Ends wait `number` as `approved` says, and tells every surface when
    /// it was still the one waiting. It waits on the disk.
    fn wait_ended(&self, number: u64, approved: Result<ChatgptTokens, String>) {
        if self.world().chatgpt.end(number, approved) {
            self.announce_health();
        }
    }

    /// Health as it now stands, sent to every surface from the blocking
    /// pool.
    async fn announced(&self) {
        let daemon = self.clone();

        blocking(move || daemon.announce_health()).await;
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
    use axum::Router;
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
    /// sent and answers every one with `answer`.
    async fn token_endpoint(answer: Value) -> (BaseUrl, Arc<Mutex<Vec<String>>>) {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let kept = Arc::clone(&sent);
        let app = Router::new().route(
            "/oauth/token",
            post(move |form: String| {
                kept.lock().unwrap().push(form);

                let answer = answer.to_string();

                async move { ([(CONTENT_TYPE, "application/json")], answer) }
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
        let (base, sent) =
            token_endpoint(json!({"access_token": access, "refresh_token": "refresh-2"})).await;

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
}
