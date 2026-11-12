//! OpenAI's sign-in for a ChatGPT plan, as OpenAI's Codex app signs in: a
//! code under Codex's public client, which the person approves on OpenAI's
//! page, traded for tokens once they do, and the tokens' refresh. Every
//! address, field and status is the reference sign-in's. What fails is said
//! in a sentence fit to show the person, and none carries a token: a secret
//! of the exchange is taken out of whatever OpenAI said.

use std::fmt;
use std::sync::OnceLock;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD_INDIFFERENT;
use p02_core::Timestamp;
use p02_shared::{BaseUrl, http_client};
use p02_store::ChatgptTokens;
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde_json::{Map, Value, json};

/// Codex's public OAuth client.
const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

/// Where OpenAI's sign-in is, unless a test harness names another.
const OPENAI_AUTH: &str = "https://auth.openai.com";

/// How long a code lasts when OpenAI does not say.
const CODE_LIFETIME_MS: i64 = 15 * 60 * 1000;

/// How often to ask whether the code was approved when OpenAI does not say.
const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// A token is refreshed this long before it runs out.
const REFRESH_MARGIN_MS: i64 = 60 * 60 * 1000;

/// The claim of OpenAI's ID token that carries the ChatGPT account.
const AUTH_CLAIM: &str = "https://api.openai.com/auth";

/// How long one request of the sign-in waits for OpenAI's answer.
const ANSWER_WAIT: Duration = Duration::from_secs(30);

const UNREACHED: &str = "OpenAI's sign-in could not be reached. Try again in a moment.";
const INCOMPLETE: &str = "OpenAI's sign-in answer was incomplete.";
const EXPIRED: &str = "The code expired before it was approved. Start again.";

/// OpenAI's sign-in: where it is, and the client its requests go by.
#[derive(Debug)]
pub(crate) struct Auth {
    base: BaseUrl,
    /// Made at the first request, not with the sign-in: a client reads the
    /// system's certificates.
    http: OnceLock<reqwest::Client>,
}

/// A code for the person to approve on OpenAI's page.
#[derive(Clone)]
pub(crate) struct DeviceCode {
    /// What OpenAI knows the wait by. With the code it claims the tokens,
    /// so it is never shown.
    device_auth_id: String,
    pub(crate) user_code: String,
    /// How often to ask whether the person approved it.
    interval: Duration,
    /// When it stops working, in milliseconds since the Unix epoch.
    pub(crate) expires_at: i64,
}

impl fmt::Debug for DeviceCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeviceCode")
            .field("user_code", &self.user_code)
            .field("interval", &self.interval)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

/// Why a refresh gave no tokens.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RefreshFailed {
    /// OpenAI refused the refresh token, which is then good for nothing.
    Refused,
    /// No answer, or none of use: the sentence saying so. The refresh
    /// token may still be good, and the next use tries it again.
    Unanswered(String),
}

/// Who an ID token says its tokens are for.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Identity {
    pub(crate) account_id: Option<String>,
    pub(crate) email: Option<String>,
    pub(crate) plan: Option<String>,
}

/// What OpenAI answered: its status, and its body when that is a JSON
/// object.
struct Answered {
    status: u16,
    body: Option<Map<String, Value>>,
}

impl Answered {
    /// The body of an answer that succeeded.
    fn accepted(&self) -> Option<&Map<String, Value>> {
        self.body
            .as_ref()
            .filter(|_| (200..300).contains(&self.status))
    }
}

impl Auth {
    /// OpenAI's sign-in, or the stand-in a test harness names in its place.
    pub(crate) fn new(stand_in: Option<BaseUrl>) -> Self {
        Self {
            base: stand_in.unwrap_or_else(|| {
                BaseUrl::parse(OPENAI_AUTH).expect("OpenAI's sign-in is at a base URL")
            }),
            http: OnceLock::new(),
        }
    }

    /// Where the person types the code.
    pub(crate) fn device_page(&self) -> String {
        self.base.endpoint("codex/device").to_string()
    }

    /// Asks OpenAI for a code the person can approve, at `now`.
    pub(crate) async fn device_code(&self, now: i64) -> Result<DeviceCode, String> {
        let answered = self
            .post_json(
                "api/accounts/deviceauth/usercode",
                &json!({"client_id": CLIENT_ID}),
            )
            .await?;

        if answered.status == 404 {
            return Err(
                "OpenAI's device sign-in is not available right now. Try again later, or \
                        connect with an API key instead."
                    .to_owned(),
            );
        }

        let Some(body) = answered.accepted() else {
            return Err(format!(
                "OpenAI did not start the sign-in (status {}). Try again in a moment.",
                answered.status
            ));
        };
        let user_code = text(body.get("user_code")).or_else(|| text(body.get("usercode")));
        let (Some(user_code), Some(device_auth_id)) = (user_code, text(body.get("device_auth_id")))
        else {
            return Err(INCOMPLETE.to_owned());
        };

        Ok(DeviceCode {
            device_auth_id,
            user_code,
            interval: seconds(body.get("interval"))
                .and_then(|seconds| Duration::try_from_secs_f64(seconds).ok())
                .unwrap_or(POLL_INTERVAL),
            expires_at: text(body.get("expires_at"))
                .and_then(|moment| moment.parse::<jiff::Timestamp>().ok())
                .map_or(now.saturating_add(CODE_LIFETIME_MS), |moment| {
                    moment.as_millisecond()
                }),
        })
    }

    /// Asks at `code`'s pace until the person approves it, and answers
    /// their tokens; or why the wait ended, the code's expiry among them.
    pub(crate) async fn approval(&self, code: &DeviceCode) -> Result<ChatgptTokens, String> {
        while now() < code.expires_at {
            tokio::time::sleep(code.interval).await;

            if let Some(tokens) = self.check(code, now()).await? {
                return Ok(tokens);
            }
        }

        Err(EXPIRED.to_owned())
    }

    /// Asks once whether the person approved `code`: none while they have
    /// not, and their tokens once they have, at `now`.
    async fn check(&self, code: &DeviceCode, now: i64) -> Result<Option<ChatgptTokens>, String> {
        let answered = self
            .post_json(
                "api/accounts/deviceauth/token",
                &json!({"device_auth_id": code.device_auth_id, "user_code": code.user_code}),
            )
            .await?;

        // OpenAI answers 403 or 404 until the code is approved.
        if matches!(answered.status, 403 | 404) {
            return Ok(None);
        }

        let Some(body) = answered.accepted() else {
            return Err(
                refusal(answered.body.as_ref(), &[&code.device_auth_id]).unwrap_or_else(|| {
                    format!(
                        "The sign-in did not complete (status {}). Start again.",
                        answered.status
                    )
                }),
            );
        };
        let (Some(authorization_code), Some(code_verifier)) = (
            text(body.get("authorization_code")),
            text(body.get("code_verifier")),
        ) else {
            return Err(INCOMPLETE.to_owned());
        };
        let callback = self.base.endpoint("deviceauth/callback").to_string();
        let answered = self
            .post_form(
                "oauth/token",
                &[
                    ("grant_type", "authorization_code"),
                    ("client_id", CLIENT_ID),
                    ("code", &authorization_code),
                    ("redirect_uri", &callback),
                    ("code_verifier", &code_verifier),
                ],
            )
            .await?;

        tokens(
            &answered,
            None,
            now,
            &[&code.device_auth_id, &authorization_code, &code_verifier],
        )
        .map(Some)
    }

    /// Trades `current`'s refresh token for new tokens at `now`, keeping
    /// what OpenAI leaves out of its answer. OpenAI replaces the refresh
    /// token and refuses the old one from then on, with a 401, as it
    /// refuses one that ran out or was revoked; any other answer that gives
    /// no tokens leaves the refresh token as it was.
    pub(crate) async fn refresh(
        &self,
        current: &ChatgptTokens,
        now: i64,
    ) -> Result<ChatgptTokens, RefreshFailed> {
        let answered = self
            .post_form(
                "oauth/token",
                &[
                    ("client_id", CLIENT_ID),
                    ("grant_type", "refresh_token"),
                    ("refresh_token", &current.refresh_token),
                    ("scope", "openid profile email"),
                ],
            )
            .await
            .map_err(RefreshFailed::Unanswered)?;

        match answered.status {
            401 => Err(RefreshFailed::Refused),
            200..300 => tokens(
                &answered,
                Some(current),
                now,
                &[&current.refresh_token, &current.access_token],
            )
            .map_err(RefreshFailed::Unanswered),
            status => Err(RefreshFailed::Unanswered(format!(
                "OpenAI could not renew your ChatGPT sign-in just now (status {status}). Try \
                 again in a moment."
            ))),
        }
    }

    async fn post_json(&self, path: &str, body: &Value) -> Result<Answered, String> {
        self.post(path, "application/json", body.to_string()).await
    }

    async fn post_form(&self, path: &str, fields: &[(&str, &str)]) -> Result<Answered, String> {
        let body = form_urlencoded::Serializer::new(String::new())
            .extend_pairs(fields)
            .finish();

        self.post(path, "application/x-www-form-urlencoded", body)
            .await
    }

    /// What OpenAI answered `body` at `path`; a request with no answer is
    /// said naming no address.
    async fn post(&self, path: &str, kind: &str, body: String) -> Result<Answered, String> {
        let response = self
            .http()?
            .post(self.base.endpoint(path))
            .header(CONTENT_TYPE, kind)
            .header(ACCEPT, "application/json")
            .timeout(ANSWER_WAIT)
            .body(body)
            .send()
            .await
            .map_err(|_| UNREACHED.to_owned())?;
        let status = response.status().as_u16();
        let content = response.bytes().await.map_err(|_| UNREACHED.to_owned())?;

        Ok(Answered {
            status,
            body: match serde_json::from_slice(&content) {
                Ok(Value::Object(body)) => Some(body),
                _ => None,
            },
        })
    }

    /// The client its requests go by, made at the first; one that cannot be
    /// made reaches nothing.
    fn http(&self) -> Result<&reqwest::Client, String> {
        if let Some(http) = self.http.get() {
            return Ok(http);
        }

        let made = http_client().build().map_err(|_| UNREACHED.to_owned())?;

        Ok(self.http.get_or_init(|| made))
    }
}

/// Whether `tokens` run out within the hour after `now`, so a use refreshes
/// them first.
pub(crate) fn needs_refresh(tokens: &ChatgptTokens, now: i64) -> bool {
    tokens.expires_at.saturating_sub(now) < REFRESH_MARGIN_MS
}

/// The moment it is, in milliseconds since the Unix epoch.
pub(crate) fn now() -> i64 {
    Timestamp::now().unix_millis()
}

/// The tokens a token answer gives at `now`, what it leaves out kept from
/// `previous`; or why it gives none, each of `secrets` taken out of what
/// OpenAI said.
fn tokens(
    answered: &Answered,
    previous: Option<&ChatgptTokens>,
    now: i64,
    secrets: &[&str],
) -> Result<ChatgptTokens, String> {
    let Some(body) = answered.accepted() else {
        return Err(refusal(answered.body.as_ref(), secrets).unwrap_or_else(|| {
            format!(
                "OpenAI did not accept the sign-in (status {}). Sign in again.",
                answered.status
            )
        }));
    };
    let access_token = text(body.get("access_token"));
    let refresh_token =
        text(body.get("refresh_token")).or_else(|| previous.map(|kept| kept.refresh_token.clone()));
    let id_token = text(body.get("id_token"))
        .or_else(|| previous.map(|kept| kept.id_token.clone()))
        .unwrap_or_default();
    let (Some(access_token), Some(refresh_token)) = (access_token, refresh_token) else {
        return Err("OpenAI's sign-in answer had no tokens.".to_owned());
    };
    let identity = identity(&id_token);
    let Some(account_id) = identity
        .account_id
        .or_else(|| previous.map(|kept| kept.account_id.clone()))
    else {
        return Err(
            "This OpenAI account has no ChatGPT plan attached. Sign in with the \
                    account you use for ChatGPT."
                .to_owned(),
        );
    };
    let expires_at = expiry(&access_token)
        .or_else(|| {
            seconds(body.get("expires_in"))
                .and_then(|seconds| Duration::try_from_secs_f64(seconds).ok())
                .and_then(|lasts| i64::try_from(lasts.as_millis()).ok())
                .map(|lasts| now.saturating_add(lasts))
        })
        .unwrap_or(now.saturating_add(CODE_LIFETIME_MS));

    Ok(ChatgptTokens {
        access_token,
        refresh_token,
        id_token,
        account_id,
        email: identity
            .email
            .or_else(|| previous.and_then(|kept| kept.email.clone())),
        plan: identity
            .plan
            .or_else(|| previous.and_then(|kept| kept.plan.clone())),
        expires_at,
    })
}

/// The account, its email and its plan that an OpenAI ID token names.
pub(crate) fn identity(id_token: &str) -> Identity {
    let Some(payload) = payload(id_token) else {
        return Identity::default();
    };
    let auth = payload.get(AUTH_CLAIM).and_then(Value::as_object);

    Identity {
        account_id: auth.and_then(|auth| text(auth.get("chatgpt_account_id"))),
        email: text(payload.get("email")),
        plan: auth
            .and_then(|auth| text(auth.get("chatgpt_plan_type")))
            .map(|plan| plan.to_lowercase()),
    }
}

/// When a JWT says it expires, in milliseconds since the Unix epoch.
pub(crate) fn expiry(token: &str) -> Option<i64> {
    payload(token)?.get("exp")?.as_i64()?.checked_mul(1000)
}

/// A JWT's payload, its signature unchecked: the token came straight from
/// OpenAI, which checks it on every request in any case.
fn payload(token: &str) -> Option<Map<String, Value>> {
    let part = token.split('.').nth(1).filter(|part| !part.is_empty())?;

    match serde_json::from_slice(&URL_SAFE_NO_PAD_INDIFFERENT.decode(part).ok()?).ok()? {
        Value::Object(payload) => Some(payload),
        _ => None,
    }
}

/// The error a body names, as OpenAI words it, each of `secrets` taken
/// out.
fn refusal(body: Option<&Map<String, Value>>, secrets: &[&str]) -> Option<String> {
    let body = body?;
    let named = match body.get("error") {
        Some(Value::Object(error)) => text(error.get("message")),
        error => text(body.get("error_description")).or_else(|| text(error)),
    }?;

    Some(
        secrets
            .iter()
            .filter(|secret| !secret.is_empty())
            .fold(named, |named, secret| named.replace(secret, "[redacted]")),
    )
}

/// A string with something in it, trimmed.
fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// A number of seconds above 0, given as a number or in text.
fn seconds(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
    .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
}
