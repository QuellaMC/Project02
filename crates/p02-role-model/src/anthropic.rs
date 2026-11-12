//! The Anthropic adapter: Anthropic's Messages protocol at the Claude API,
//! on the person's key, every request streamed and read back into the
//! model's answer: its calls and its text.

mod stream;

use std::fmt;
use std::time::Duration;

use async_trait::async_trait;
use p02_contracts::{
    ChatCompletionTool, ChatMessage, Invocation, ModelOutput, ProviderAnswer, ProviderName,
    RoleModelAdapter, TextCompletion, TextCompletionRequest, ToolCallId, WrittenCall,
    scrub_reasoning_blocks,
};
use p02_shared::BaseUrl;
use reqwest::Url;
use reqwest::header::{HeaderName, HeaderValue};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::draft::ReplyDrafts;
use crate::prompt::{
    CallIds, ToolNameMapping, json_text, provider_name, provider_names, runtime_name,
};
use crate::transport::{
    self, Access, BuildAdapterError, Client, FailureCode, Fault, MAX_OUTPUT_TOKENS, Silence, said,
};
use stream::{MessageFold, Stopped, Told};

/// What a failure's words call the service.
const CLAUDE: &str = "Claude";
const CLAUDE_API: &str = "https://api.anthropic.com/v1";

/// The version of the protocol every request is made in.
const VERSION: &str = "2026-10-21";

/// The beta a request names when it asks for Anthropic's own fallback.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

const X_API_KEY: HeaderName = HeaderName::from_static("x-api-key");
const ANTHROPIC_VERSION: HeaderName = HeaderName::from_static("anthropic-version");
const ANTHROPIC_BETA: HeaderName = HeaderName::from_static("anthropic-beta");

/// Why a message stops whole; `refusal` is a decline, and any other cut it
/// short.
const ANSWERED: [&str; 3] = ["end_turn", "tool_use", "stop_sequence"];

/// A character's settings for the Claude API.
#[derive(Clone)]
pub struct AnthropicSettings {
    pub api_key: Option<String>,
    pub model: String,
    /// Whether a request asks for Anthropic's own fallback for a decline,
    /// which each model the setting offers takes.
    pub fallback: bool,
    /// Where the Claude API is, as a test harness names it; its own address
    /// when unset.
    pub base_url: Option<BaseUrl>,
}

impl fmt::Debug for AnthropicSettings {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AnthropicSettings")
            .field("api_key", &self.api_key.as_ref().map(|_| "[redacted]"))
            .field("model", &self.model)
            .field("fallback", &self.fallback)
            .field("base_url", &self.base_url)
            .finish()
    }
}

/// The Claude API for one character.
#[derive(Debug)]
pub(crate) struct AnthropicAdapter {
    endpoint: Url,
    model: String,
    fallback: bool,
    access: Access,
    http: Client,
    silence: Duration,
}

impl AnthropicAdapter {
    /// The Claude API as `settings` choose it, bounding its silence at
    /// `silence`: on the person's key, in the protocol's version, naming the
    /// fallback's beta when it asks for the fallback.
    pub(crate) fn new(
        settings: &AnthropicSettings,
        silence: Duration,
    ) -> Result<Self, BuildAdapterError> {
        let key = settings
            .api_key
            .as_deref()
            .filter(|key| !key.is_empty())
            .ok_or(BuildAdapterError::MissingKey(CLAUDE))?;
        let base = settings.base_url.clone().unwrap_or_else(|| {
            BaseUrl::parse(CLAUDE_API).expect("the Claude API's address is a base URL")
        });
        let access = Access::open()
            .credential(X_API_KEY, key, key)
            .ok_or(BuildAdapterError::Credential(CLAUDE))?
            .header(ANTHROPIC_VERSION, HeaderValue::from_static(VERSION));

        Ok(Self {
            endpoint: base.endpoint("messages"),
            model: settings.model.clone(),
            fallback: settings.fallback,
            access: if settings.fallback {
                access.header(ANTHROPIC_BETA, HeaderValue::from_static(FALLBACK_BETA))
            } else {
                access
            },
            http: Client::default(),
            silence,
        })
    }

    /// Sends `body` and reads the message it streams back to its stop, what
    /// it tells of its calls told to `heard`, with the status that answered;
    /// or why there is none.
    async fn ask(
        &self,
        body: &[u8],
        heard: &mut impl FnMut(Told<'_>),
    ) -> Result<(Stopped, u16), Fault> {
        let http = self.http.get()?;
        let mut silence = Silence::start(self.silence);
        let response = transport::send(http, &self.endpoint, &self.access, body, &mut silence)
            .await?
            .accepted()?;
        let status = response.status().as_u16();
        let mut fold = MessageFold::default();
        let stopped =
            transport::streamed(response, &mut silence, |chunk| fold.push(chunk, heard)).await?;

        Ok((stopped, status))
    }

    /// Sends a round and reads its answer to the end.
    async fn exchange(
        &self,
        request: &RoundRequest,
        drafts: &mut ReplyDrafts<'_>,
    ) -> Result<ProviderAnswer, Fault> {
        let (stopped, status) = self
            .ask(&request.bytes, &mut |told| match told {
                Told::Piece(fragment) => drafts.hear(fragment),
                Told::LetGo => drafts.let_go(),
            })
            .await?;

        answer(stopped, &request.mappings).map_err(|(code, message)| Fault {
            code,
            message,
            status: Some(status),
        })
    }

    /// A plain completion's text, or why there is none.
    async fn completion(&self, request: &TextCompletionRequest) -> Result<String, String> {
        let body = completion_request(&self.model, self.fallback, request);
        let (stopped, _) = self
            .ask(&body, &mut |_| {})
            .await
            .map_err(|fault| fault.message)?;

        stop_reason(&stopped).map_err(|(_, message)| message)?;

        Some(scrub_reasoning_blocks(&stopped.text).trim().to_owned())
            .filter(|text| !text.is_empty())
            .ok_or_else(|| "completion returned no text.".to_owned())
    }
}

#[async_trait]
impl RoleModelAdapter for AnthropicAdapter {
    async fn invoke(&self, invocation: &Invocation<'_>) -> ProviderAnswer {
        let request = RoundRequest::new(
            &self.model,
            self.fallback,
            invocation.messages(),
            invocation.tools(),
        );
        let mut drafts = ReplyDrafts::new(*invocation, &request.mappings);

        match self.exchange(&request, &mut drafts).await {
            Ok(answer) => {
                drafts.finish();
                answer
            }
            Err(fault) => fault.answer(CLAUDE, &self.access),
        }
    }

    async fn complete_text(&self, request: &TextCompletionRequest) -> TextCompletion {
        match self.completion(request).await {
            Ok(text) => TextCompletion::Completed {
                text,
                provider: ProviderName::Anthropic,
                model: Some(self.model.clone()),
            },
            Err(reason) => TextCompletion::Failed {
                reason: said(CLAUDE, &self.access, &reason),
            },
        }
    }
}

/// A round as sent: the body exactly as it goes on the wire, and the
/// mapping back from the names its tools go by.
#[derive(Debug)]
struct RoundRequest {
    mappings: Vec<ToolNameMapping>,
    bytes: Vec<u8>,
}

/// A request's body: the model, the room its answer gets, the system
/// prompt, the conversation and the tools, streamed, and Anthropic's own
/// fallback where the model takes it. No sampling, thinking, effort or
/// forced tool choice is asked for: a current model refuses each or reads
/// it otherwise, and its own defaults suit a conversation. Nothing of the
/// model's thinking is sent back: a round replays her earlier calls as the
/// runtime keeps them, and the model thinks afresh.
#[derive(Serialize)]
struct Body<'a> {
    model: &'a str,
    max_tokens: u32,
    system: String,
    messages: Vec<Turn<'a>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tools: Vec<Tool<'a>>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    fallbacks: Option<&'static str>,
}

/// One message of the conversation, under its role.
#[derive(Serialize)]
#[serde(tag = "role", rename_all = "snake_case")]
enum Turn<'a> {
    User { content: Content<'a> },
    Assistant { content: Vec<Block<'a>> },
    System { content: &'a str },
}

/// What a message of the person's holds: a line, or the results of her
/// calls.
#[derive(Serialize)]
#[serde(untagged)]
enum Content<'a> {
    Text(&'a str),
    Results(Vec<Block<'a>>),
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Block<'a> {
    Text {
        text: &'a str,
    },
    ToolUse {
        id: ToolCallId,
        name: String,
        input: Map<String, Value>,
    },
    ToolResult {
        tool_use_id: ToolCallId,
        content: &'a str,
    },
}

/// A tool as the protocol offers one, its arguments streamed as the model
/// writes them, so her reply can be drafted as it is written. The service
/// then checks them no more, and the runtime judges every call in any case.
#[derive(Serialize)]
struct Tool<'a> {
    name: String,
    description: &'a str,
    input_schema: &'a Map<String, Value>,
    eager_input_streaming: bool,
}

impl RoundRequest {
    fn new(
        model: &str,
        fallback: bool,
        messages: &[ChatMessage],
        tools: &[ChatCompletionTool],
    ) -> Self {
        let mappings = provider_names(tools);
        let (system, messages) = conversation(messages, &mappings);
        let bytes = json_text(&Body {
            model,
            max_tokens: MAX_OUTPUT_TOKENS,
            system,
            messages,
            tools: tools
                .iter()
                .map(|tool| Tool {
                    name: provider_name(&tool.function().name, &mappings),
                    description: &tool.function().description,
                    input_schema: &tool.function().parameters,
                    eager_input_streaming: true,
                })
                .collect(),
            stream: true,
            fallbacks: fallback.then_some("default"),
        })
        .into_bytes();

        Self { mappings, bytes }
    }
}

/// A plain completion's body, exactly as it goes on the wire: its
/// instructions as the system prompt and its input as the person's line,
/// no tools, streamed as every request is.
fn completion_request(model: &str, fallback: bool, request: &TextCompletionRequest) -> Vec<u8> {
    let messages = [
        ChatMessage::System {
            content: request.instructions.clone(),
        },
        ChatMessage::User {
            content: request.input.clone(),
        },
    ];
    let (system, messages) = conversation(&messages, &[]);

    json_text(&Body {
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        messages,
        tools: Vec::new(),
        stream: true,
        fallbacks: fallback.then_some("default"),
    })
    .into_bytes()
}

/// The messages as the protocol takes them: the lines before the first of
/// the person's or hers as the system prompt, and each later line under its
/// role, a system or developer line as the protocol's own system message;
/// her calls as tool uses under the names the tools go by, each with the
/// arguments the runtime ran it on, and each round's results as one message
/// of the person's, each tied to its call by the id the request shows for
/// it.
fn conversation<'a>(
    messages: &'a [ChatMessage],
    mappings: &[ToolNameMapping],
) -> (String, Vec<Turn<'a>>) {
    let mut system = Vec::new();
    let mut turns = Vec::new();
    let mut ids = CallIds::default();

    for message in messages {
        match message {
            ChatMessage::System { content } | ChatMessage::Developer { content } => {
                if turns.is_empty() {
                    system.push(content.as_str());
                } else {
                    turns.push(Turn::System { content });
                }
            }
            ChatMessage::User { content } => turns.push(Turn::User {
                content: Content::Text(content),
            }),
            ChatMessage::Assistant {
                content,
                tool_calls,
            } => {
                let blocks: Vec<Block<'a>> = content
                    .as_deref()
                    .filter(|content| !content.is_empty())
                    .map(|text| Block::Text { text })
                    .into_iter()
                    .chain(tool_calls.iter().map(|call| Block::ToolUse {
                        id: ids.shown(call.id()),
                        name: provider_name(&call.function().name, mappings),
                        input: serde_json::from_str(&call.function().arguments).unwrap_or_default(),
                    }))
                    .collect();

                if !blocks.is_empty() {
                    turns.push(Turn::Assistant { content: blocks });
                }
            }
            ChatMessage::Tool {
                content,
                tool_call_id,
            } => {
                let result = Block::ToolResult {
                    tool_use_id: ids.shown(tool_call_id),
                    content,
                };

                match turns.last_mut() {
                    Some(Turn::User {
                        content: Content::Results(results),
                    }) => results.push(result),
                    _ => turns.push(Turn::User {
                        content: Content::Results(vec![result]),
                    }),
                }
            }
        }
    }

    (system.join("\n\n"), turns)
}

/// How the message stopped, once it stopped whole; or why it is no answer:
/// a decline, said with the category the service names, a message cut
/// short, or one that never said why it stopped.
fn stop_reason(stopped: &Stopped) -> Result<String, (FailureCode, String)> {
    match stopped.stop_reason.as_deref() {
        Some(reason) if ANSWERED.contains(&reason) => Ok(reason.to_owned()),
        Some("refusal") => Err((
            FailureCode::ProviderError,
            match &stopped.category {
                Some(category) => format!("declined to answer ({category})."),
                None => "declined to answer.".to_owned(),
            },
        )),
        Some(reason) => Err((
            FailureCode::ProviderError,
            format!("response was cut short: {reason}."),
        )),
        None => Err((
            FailureCode::MalformedResponse,
            "response stop_reason is required.".to_owned(),
        )),
    }
}

/// The message at its stop as the model's answer, once it stopped whole:
/// its calls under the runtime's names, each call's arguments as JSON when
/// they parse and as their text when they do not, so a bad call is refused
/// where every other is; its text with leaked reasoning taken out; and the
/// tokens it took.
fn answer(
    stopped: Stopped,
    mappings: &[ToolNameMapping],
) -> Result<ProviderAnswer, (FailureCode, String)> {
    let finish_reason = stop_reason(&stopped)?;
    let tool_calls = stopped
        .calls
        .into_iter()
        .map(|call| {
            let name = call.name.ok_or_else(|| {
                (
                    FailureCode::MalformedResponse,
                    "response tool_use block must carry its name.".to_owned(),
                )
            })?;

            Ok(WrittenCall {
                name: runtime_name(&name, mappings),
                input: serde_json::from_str(&call.arguments)
                    .unwrap_or(Value::String(call.arguments)),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let text = Some(scrub_reasoning_blocks(&stopped.text)).filter(|text| !text.is_empty());

    Ok(ProviderAnswer::Answered {
        output: ModelOutput { tool_calls, text },
        finish_reason: Some(finish_reason),
        usage: stopped.usage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::transport::PROVIDER_SILENCE;

    #[test]
    fn the_claude_api_is_at_its_own_address_unless_a_harness_names_another() {
        let at = |base_url: Option<&str>| {
            AnthropicAdapter::new(
                &AnthropicSettings {
                    api_key: Some("sk-ant-key".to_owned()),
                    model: "claude-opus-5-5".to_owned(),
                    fallback: true,
                    base_url: base_url.map(|base| BaseUrl::parse(base).unwrap()),
                },
                PROVIDER_SILENCE,
            )
            .unwrap()
            .endpoint
            .to_string()
        };

        assert_eq!(at(None), "https://api.anthropic.com/v1/messages");
        assert_eq!(
            at(Some("http://127.0.0.1:9/anthropic/v1")),
            "http://127.0.0.1:9/anthropic/v1/messages"
        );
    }
}
