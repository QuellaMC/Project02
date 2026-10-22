//! Telegram's Bot API as the connector calls it: the eight methods it
//! uses and the lengths of text it takes, each answer read leniently out
//! of Telegram's envelope, and whatever Telegram or the network does
//! handed back as an outcome, never an error.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use p02_shared::{BaseUrl, error_sentence, http_client};
use serde::de::{DeserializeOwned, IgnoredAny};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::lenient;

/// How long a poll waits for updates before Telegram answers it empty.
const POLL_WAIT: Duration = Duration::from_secs(50);

/// How long past its own wait a call may go unanswered before it ends: a
/// poll Telegram never answers still ends, and so does every other call.
const ANSWER_BOUND: Duration = Duration::from_secs(10);

/// Telegram's longest message, in the UTF-16 units it counts.
pub(crate) const MAX_MESSAGE: usize = 4096;

/// Telegram's longest answer to a press, in the same units.
const MAX_TOAST: usize = 200;

/// A text's length as Telegram counts it.
pub(crate) fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// The text within `limit` with `ending` whole: a text past it is cut,
/// never inside a character, with an ellipsis, to make room.
pub(crate) fn within(limit: usize, text: &str, ending: &str) -> String {
    let room = limit - utf16_len(ending);

    if utf16_len(text) <= room {
        return format!("{text}{ending}");
    }

    let mut cut = String::new();
    let mut length = 0;

    for character in text.chars() {
        length += character.len_utf16();

        if length > room - 1 {
            break;
        }

        cut.push(character);
    }

    format!("{cut}…{ending}")
}

/// A bot's token. It rides in the URL of every call the bot makes and in
/// nothing a person reads, so its `Debug` never shows it.
#[derive(Clone, PartialEq, Eq, Hash)]
pub(crate) struct BotToken(Arc<str>);

impl BotToken {
    pub(crate) fn new(token: &str) -> Self {
        Self(token.into())
    }
}

impl fmt::Debug for BotToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("BotToken").finish_non_exhaustive()
    }
}

/// Where the Bot API is, and the one client every bot's calls ride.
#[derive(Clone, Debug)]
pub(crate) struct Telegram {
    client: reqwest::Client,
    base: BaseUrl,
}

impl Telegram {
    /// # Errors
    ///
    /// [`reqwest::Error`] when no HTTP client can be built here.
    pub(crate) fn new(base: BaseUrl) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: http_client().build()?,
            base,
        })
    }
}

/// One bot's calls to Telegram.
#[derive(Clone, Debug)]
pub(crate) struct BotApi {
    telegram: Telegram,
    token: BotToken,
}

/// Why a call has no result: Telegram's own refusal, its code with its
/// description and the pause it asks for, or no answer in its envelope,
/// said in a sentence.
#[derive(Clone, Debug)]
pub(crate) enum Failure {
    Refused {
        code: i64,
        description: String,
        retry_after: Option<Duration>,
    },
    Unanswered(String),
}

impl Failure {
    pub(crate) fn description(&self) -> &str {
        match self {
            Self::Refused { description, .. } => description,
            Self::Unanswered(why) => why,
        }
    }

    /// Telegram's code, when it answered.
    pub(crate) fn code(&self) -> Option<i64> {
        match self {
            Self::Refused { code, .. } => Some(*code),
            Self::Unanswered(_) => None,
        }
    }

    /// Telegram answers a token it does not know 401, and one it cannot
    /// even read 404.
    pub(crate) fn token_refused(&self) -> bool {
        matches!(self.code(), Some(401 | 404))
    }

    /// The pause Telegram asks for before the next call.
    pub(crate) fn retry_after(&self) -> Option<Duration> {
        match self {
            Self::Refused { retry_after, .. } => *retry_after,
            Self::Unanswered(_) => None,
        }
    }
}

/// An account as Telegram names it.
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct User {
    pub(crate) id: i64,
    pub(crate) first_name: String,
    #[serde(default, deserialize_with = "lenient")]
    pub(crate) last_name: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub(crate) username: Option<String>,
}

/// An update of a kind this connector does not read, or cannot, carries
/// its id alone, so the poll after it still asks past it.
#[derive(Debug, Deserialize)]
pub(crate) struct Update {
    #[serde(rename = "update_id")]
    pub(crate) id: i64,
    #[serde(default, deserialize_with = "lenient")]
    pub(crate) message: Option<Message>,
    #[serde(default, deserialize_with = "lenient")]
    pub(crate) callback_query: Option<CallbackQuery>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Message {
    #[serde(rename = "message_id")]
    pub(crate) id: i64,
    pub(crate) chat: Chat,
    #[serde(default, deserialize_with = "lenient")]
    pub(crate) from: Option<User>,
    #[serde(default, deserialize_with = "lenient")]
    pub(crate) text: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Chat {
    pub(crate) id: i64,
    /// `private`, `group`, `supergroup` or `channel`.
    #[serde(rename = "type")]
    pub(crate) kind: String,
}

/// A press of a button on one of the bot's messages.
#[derive(Debug, Deserialize)]
pub(crate) struct CallbackQuery {
    pub(crate) id: String,
    pub(crate) from: User,
    #[serde(default, deserialize_with = "lenient")]
    pub(crate) data: Option<String>,
}

/// Buttons under a message, row by row.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct Keyboard {
    inline_keyboard: Vec<Vec<Button>>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct Button {
    text: String,
    callback_data: String,
}

impl Keyboard {
    pub(crate) fn row(buttons: Vec<Button>) -> Self {
        Self {
            inline_keyboard: vec![buttons],
        }
    }
}

impl Button {
    pub(crate) fn new(text: &str, callback_data: String) -> Self {
        Self {
            text: text.to_owned(),
            callback_data,
        }
    }
}

#[derive(Serialize)]
struct Nothing {}

#[derive(Serialize)]
struct GetUpdates {
    offset: i64,
    timeout: u64,
    allowed_updates: [&'static str; 2],
}

#[derive(Serialize)]
struct SendMessage<'a> {
    chat_id: i64,
    text: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reply_markup: Option<&'a Keyboard>,
}

/// An edit leaves no buttons on the message.
#[derive(Serialize)]
struct EditMessageText<'a> {
    chat_id: i64,
    message_id: i64,
    text: &'a str,
}

#[derive(Serialize)]
struct DeleteMessage {
    chat_id: i64,
    message_id: i64,
}

#[derive(Serialize)]
struct AnswerCallbackQuery<'a> {
    callback_query_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<&'a str>,
}

#[derive(Serialize)]
struct SendChatAction {
    chat_id: i64,
    action: &'static str,
}

/// Telegram's envelope around every answer.
#[derive(Deserialize)]
struct Envelope {
    ok: bool,
    result: Option<Value>,
    error_code: Option<i64>,
    description: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    parameters: Option<Parameters>,
}

#[derive(Deserialize)]
struct Parameters {
    retry_after: Option<u64>,
}

impl BotApi {
    pub(crate) fn new(telegram: Telegram, token: BotToken) -> Self {
        Self { telegram, token }
    }

    pub(crate) async fn get_me(&self) -> Result<User, Failure> {
        self.call("getMe", &Nothing {}, Duration::ZERO).await
    }

    /// Waits for messages and button presses after `offset`, which also
    /// tells Telegram every update before it was handed on.
    pub(crate) async fn get_updates(&self, offset: i64) -> Result<Vec<Update>, Failure> {
        let batch: Vec<Value> = self
            .call(
                "getUpdates",
                &GetUpdates {
                    offset,
                    timeout: POLL_WAIT.as_secs(),
                    allowed_updates: ["message", "callback_query"],
                },
                POLL_WAIT,
            )
            .await?;

        Ok(batch
            .into_iter()
            .filter_map(|update| serde_json::from_value(update).ok())
            .collect())
    }

    pub(crate) async fn send_message(
        &self,
        chat: i64,
        text: &str,
        keyboard: Option<&Keyboard>,
    ) -> Result<Message, Failure> {
        self.call(
            "sendMessage",
            &SendMessage {
                chat_id: chat,
                text,
                reply_markup: keyboard,
            },
            Duration::ZERO,
        )
        .await
    }

    pub(crate) async fn edit_message_text(
        &self,
        chat: i64,
        message_id: i64,
        text: &str,
    ) -> Result<(), Failure> {
        self.call::<IgnoredAny>(
            "editMessageText",
            &EditMessageText {
                chat_id: chat,
                message_id,
                text,
            },
            Duration::ZERO,
        )
        .await
        .map(drop)
    }

    pub(crate) async fn delete_message(&self, chat: i64, message_id: i64) -> Result<(), Failure> {
        self.call::<IgnoredAny>(
            "deleteMessage",
            &DeleteMessage {
                chat_id: chat,
                message_id,
            },
            Duration::ZERO,
        )
        .await
        .map(drop)
    }

    /// Answers a press, with a toast when there is one, cut to what
    /// Telegram takes, since a toast may relay the daemon's own sentence.
    pub(crate) async fn answer_callback_query(
        &self,
        id: &str,
        text: Option<&str>,
    ) -> Result<(), Failure> {
        let text = text.map(|text| within(MAX_TOAST, text, ""));

        self.call::<IgnoredAny>(
            "answerCallbackQuery",
            &AnswerCallbackQuery {
                callback_query_id: id,
                text: text.as_deref(),
            },
            Duration::ZERO,
        )
        .await
        .map(drop)
    }

    /// Shows the bot as typing in the chat.
    pub(crate) async fn send_typing(&self, chat: i64) -> Result<(), Failure> {
        self.call::<IgnoredAny>(
            "sendChatAction",
            &SendChatAction {
                chat_id: chat,
                action: "typing",
            },
            Duration::ZERO,
        )
        .await
        .map(drop)
    }

    /// Telegram sends a bot's updates to a webhook or to its polls, never
    /// both.
    pub(crate) async fn delete_webhook(&self) -> Result<(), Failure> {
        self.call::<IgnoredAny>("deleteWebhook", &Nothing {}, Duration::ZERO)
            .await
            .map(drop)
    }

    async fn call<T: DeserializeOwned>(
        &self,
        method: &str,
        body: &impl Serialize,
        wait: Duration,
    ) -> Result<T, Failure> {
        let url = self
            .telegram
            .base
            .endpoint(&format!("bot{}/{method}", &*self.token.0));
        let response = self
            .telegram
            .client
            .post(url)
            .json(body)
            .timeout(wait + ANSWER_BOUND)
            .send()
            .await
            .map_err(unreached)?;
        let status = response.status().as_u16();
        let body = response.bytes().await.map_err(unreached)?;

        answer(method, status, &body)
    }
}

/// The sentence a call that got no answer is said in. The token rides in
/// the URL, which `reqwest` names in its errors unless told not to.
fn unreached(error: reqwest::Error) -> Failure {
    Failure::Unanswered(format!(
        "Telegram could not be reached: {}",
        error_sentence(&error.without_url())
    ))
}

/// The result of `method` that Telegram's envelope holds, or why it holds
/// none.
fn answer<T: DeserializeOwned>(method: &str, status: u16, body: &[u8]) -> Result<T, Failure> {
    let not_envelope = || {
        Failure::Unanswered(format!(
            "Telegram answered {status} with something other than its JSON envelope."
        ))
    };
    let envelope: Envelope = serde_json::from_slice(body).map_err(|_| not_envelope())?;

    if envelope.ok {
        return envelope
            .result
            .and_then(|result| serde_json::from_value(result).ok())
            .ok_or_else(|| {
                Failure::Unanswered(format!(
                    "Telegram's answer to {method} is not the shape it documents."
                ))
            });
    }

    match (envelope.error_code, envelope.description) {
        (Some(code), Some(description)) => Err(Failure::Refused {
            code,
            description,
            retry_after: envelope
                .parameters
                .and_then(|parameters| parameters.retry_after)
                .map(Duration::from_secs),
        }),
        _ => Err(not_envelope()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// connectors.telegram-token-redaction: Reports never carry a bot token: a call that never reaches Telegram is said without the URL its token rides in.
    #[tokio::test]
    async fn a_call_that_never_reaches_telegram_is_said_without_its_token() {
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = BaseUrl::parse(&format!("http://{}", closed.local_addr().unwrap())).unwrap();
        let token = "123456:secret-of-the-bot";

        drop(closed);

        let named = http_client()
            .build()
            .unwrap()
            .post(base.endpoint(&format!("bot{token}/getMe")))
            .send()
            .await
            .unwrap_err();
        let api = BotApi::new(Telegram::new(base).unwrap(), BotToken::new(token));
        let failure = api.get_me().await.unwrap_err();

        // What the client says of itself names the URL, and so the token.
        assert!(named.to_string().contains(token), "{named}");
        assert!(
            failure
                .description()
                .starts_with("Telegram could not be reached: "),
            "{failure:?}"
        );
        assert!(!failure.description().contains(token), "{failure:?}");
    }
}
