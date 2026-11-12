//! A ChatGPT plan as a service of the Responses protocol, at the address
//! OpenAI's Codex app sends to, or at the stand-in a test harness names.
//! Each request goes as that app makes it: on the home's sign-in, with the
//! access token fresh for it, the ChatGPT account, the app's originator and
//! a session of the request's own. A 401 is asked once more on the sign-in
//! refreshed; a second is the sign-in turned down. Its failures are said in
//! the plan's words where they are not the service's own: the sign-in that
//! gave nothing to send with, the sign-in turned down, and too many
//! requests at once, which is the service busy.

use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use p02_shared::BaseUrl;
use reqwest::Url;
use reqwest::header::{ACCEPT, AUTHORIZATION, HeaderName, HeaderValue};

use super::{Dialect, Request, ResponsesService, Sent};
use crate::transport::{self, Access, Answer, BuildAdapterError, FailureCode, Fault, Silence};

/// Where a ChatGPT plan's service is, unless a test harness names another.
const CHATGPT_API: &str = "https://chatgpt.com/backend-api/codex";

/// What the person and a failure's words call it.
const CHATGPT: &str = "ChatGPT";

/// The originator OpenAI's Codex app names itself by.
const CODEX_ORIGINATOR: &str = "codex-tui";

const CHATGPT_ACCOUNT_ID: HeaderName = HeaderName::from_static("chatgpt-account-id");
const ORIGINATOR: HeaderName = HeaderName::from_static("originator");
const SESSION_ID: HeaderName = HeaderName::from_static("session-id");

/// What a second 401 is said to be, after the service's name.
const TURNED_DOWN: &str = "turned down your sign-in. Sign in to your ChatGPT plan again.";

/// What too many requests at once are said to be, after the service's name.
const BUSY: &str = "is busy. Try again in a moment.";

/// The home's sign-in to a ChatGPT plan, as the plan's service asks it for
/// what each request carries.
#[async_trait]
pub trait PlanSignIn: Send + Sync + fmt::Debug {
    /// What a request carries, fresh: refreshed first when it runs out
    /// soon. Otherwise the sentence saying why there is nothing to carry.
    async fn fresh(&self) -> Result<PlanAccess, String>;

    /// What a request carries once the service refused `refused`:
    /// refreshed whatever its age, unless another use replaced it already.
    /// Otherwise the sentence saying why there is nothing to carry.
    async fn refreshed(&self, refused: &PlanAccess) -> Result<PlanAccess, String>;
}

/// What a request on a ChatGPT plan carries: the access token, and the
/// ChatGPT account it is made on. Both are secrets: its `Debug` shows
/// neither, and no failure repeats them.
#[derive(Clone, PartialEq, Eq)]
pub struct PlanAccess {
    pub access_token: String,
    pub account_id: String,
}

impl fmt::Debug for PlanAccess {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PlanAccess([redacted])")
    }
}

/// A character's settings for the ChatGPT plan the home signed in to.
#[derive(Clone, Debug)]
pub struct ChatgptSettings {
    /// The home's sign-in, while it holds one; without it the plan answers
    /// nothing.
    pub sign_in: Option<Arc<dyn PlanSignIn>>,
    pub model: String,
    /// Where the plan's service is, as a test harness names it; its own
    /// address when unset.
    pub base_url: Option<BaseUrl>,
}

impl ResponsesService {
    /// The ChatGPT plan, on the home's sign-in, at its own address unless a
    /// test harness names another.
    pub(super) fn chatgpt(settings: &ChatgptSettings) -> Result<Self, BuildAdapterError> {
        let sign_in = settings
            .sign_in
            .clone()
            .ok_or(BuildAdapterError::NotSignedIn("ChatGPT plan"))?;
        let base = settings.base_url.clone().unwrap_or_else(|| {
            BaseUrl::parse(CHATGPT_API).expect("the ChatGPT plan's address is a base URL")
        });

        Ok(Self {
            name: CHATGPT,
            endpoint: base.endpoint("responses"),
            dialect: Dialect::Plan(sign_in),
        })
    }
}

/// Sends `request` to the plan's service at `endpoint` on `sign_in`, and
/// waits for the answer to begin: with what the sign-in hands out fresh,
/// and once more, after a 401, with what it hands out refreshed. The
/// service's silence is bounded from each request on, the sign-in's own
/// wait being none of it.
pub(super) async fn send(
    http: &reqwest::Client,
    endpoint: &Url,
    sign_in: &dyn PlanSignIn,
    request: &Request,
    silence: &mut Silence,
) -> Sent {
    let mut tokens = match sign_in.fresh().await {
        Ok(tokens) => tokens,
        Err(sentence) => return unsent(&sentence),
    };
    let mut refreshed = false;

    loop {
        let Some(access) = access(&tokens, request.session.as_deref()) else {
            return unsent("Your ChatGPT sign-in cannot be sent. Sign in again.");
        };

        silence.touch();

        let answer = transport::send(http, endpoint, &access, &request.bytes, silence).await;

        match answer {
            Ok(Answer::Refused { status: 401, .. }) if !refreshed => {
                tokens = match sign_in.refreshed(&tokens).await {
                    Ok(tokens) => tokens,
                    Err(sentence) => return unsent(&sentence),
                };
                refreshed = true;
            }
            answer => {
                return Sent {
                    access,
                    answered: answered(answer),
                };
            }
        }
    }
}

/// What a request carries on `tokens`, in `session`, as OpenAI's Codex app
/// sends it; none when a token holds what a header cannot carry.
fn access(tokens: &PlanAccess, session: Option<&str>) -> Option<Access> {
    let access = Access::open()
        .credential(
            AUTHORIZATION,
            &format!("Bearer {}", tokens.access_token),
            &tokens.access_token,
        )?
        .credential(CHATGPT_ACCOUNT_ID, &tokens.account_id, &tokens.account_id)?
        .header(ORIGINATOR, HeaderValue::from_static(CODEX_ORIGINATOR))
        .header(ACCEPT, HeaderValue::from_static("text/event-stream"));

    Some(match session {
        Some(session) => access.header(SESSION_ID, HeaderValue::from_str(session).ok()?),
        None => access,
    })
}

/// A request the sign-in gave nothing to send with, saying why.
fn unsent(sentence: &str) -> Sent {
    Sent {
        access: Access::open(),
        answered: Err(Fault {
            code: FailureCode::ProviderError,
            message: format!("could not be asked: {sentence}"),
            status: None,
        }),
    }
}

/// How the plan's service answered: a refusal in the plan's words where
/// they are not the service's own. A 401 here came after the sign-in was
/// refreshed, so it turned the sign-in down; a 429 that is not the plan's
/// usage used up was tried again already, and is the service busy.
fn answered(answer: Result<Answer, transport::Failure>) -> Result<reqwest::Response, Fault> {
    match answer? {
        Answer::Accepted(response) => Ok(response),
        Answer::Refused {
            status,
            message,
            limit_reached,
        } => Err(Fault {
            code: FailureCode::HttpError,
            message: match status {
                401 => TURNED_DOWN.to_owned(),
                429 if !limit_reached => BUSY.to_owned(),
                _ => message,
            },
            status: Some(status),
        }),
    }
}
