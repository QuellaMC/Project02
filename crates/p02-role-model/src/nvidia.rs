//! The NVIDIA provider: OpenAI's chat completion wire at NVIDIA's cloud, or
//! at the server the base URL setting names, streamed and read back into
//! the model's answer: its calls and its text.

mod stream;

use std::fmt;
use std::time::Duration;

use async_trait::async_trait;
use p02_contracts::{
    ChatCompletionTool, ChatFunctionCall, ChatMessage, ChatToolCall, ChatToolFunction, Invocation,
    ModelOutput, ProviderAnswer, ProviderName, RoleModelAdapter, TextCompletion,
    TextCompletionRequest, WrittenCall, scrub_reasoning_blocks,
};
use p02_shared::BaseUrl;
use reqwest::Url;
use serde::Serialize;
use serde_json::{Value, json};

use crate::draft::ReplyDrafts;
use crate::prompt::{ToolNameMapping, json_text, provider_name, provider_names, runtime_name};
use crate::transport::{
    self, Access, BuildAdapterError, Client, Failure, FailureCode, Fault, Silence, said,
};
use stream::{Completion, Flow, StreamFold};

/// What the person and a failure's words call the service.
const NVIDIA: &str = "NVIDIA";
const CLOUD: &str = "https://integrate.api.nvidia.com/v1";
const DEFAULT_MODEL: &str = "nvidia/nemotron-3-nano-30b-a3b";
const MAX_TOKENS: u32 = 16_384;
const REASONING_BUDGET: u32 = 16_384;

/// Reasons a chat completion ends whole; any other cut the output short.
const TERMINAL_FINISH_REASONS: [&str; 2] = ["stop", "tool_calls"];

/// A character's settings for the NVIDIA provider.
#[derive(Clone, Default)]
pub struct NvidiaSettings {
    pub api_key: Option<String>,
    /// The model to ask; NVIDIA's Nemotron 3 Nano when unset.
    pub model: Option<String>,
    /// A server of one's own that speaks the same wire; NVIDIA's cloud
    /// when unset.
    pub base_url: Option<BaseUrl>,
}

impl fmt::Debug for NvidiaSettings {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NvidiaSettings")
            .field("api_key", &self.api_key.as_ref().map(|_| "[redacted]"))
            .field("model", &self.model)
            .field("base_url", &self.base_url)
            .finish()
    }
}

/// The NVIDIA provider for one character.
#[derive(Debug)]
pub(crate) struct NvidiaAdapter {
    endpoint: Url,
    model: String,
    access: Access,
    http: Client,
    silence: Duration,
}

impl NvidiaAdapter {
    /// An adapter that bounds the provider's silence at `silence`.
    pub(crate) fn new(
        settings: &NvidiaSettings,
        silence: Duration,
    ) -> Result<Self, BuildAdapterError> {
        let base = settings.base_url.clone().unwrap_or_else(|| {
            BaseUrl::parse(CLOUD).expect("NVIDIA's cloud address is a base URL")
        });
        // NVIDIA's cloud answers nothing without a key; a server of the
        // person's own may ask for none.
        let access = match settings.api_key.as_deref().filter(|key| !key.is_empty()) {
            Some(key) => Access::bearer(NVIDIA, key)?,
            None if settings.base_url.is_some() => Access::open(),
            None => return Err(BuildAdapterError::MissingKey(NVIDIA)),
        };

        Ok(Self {
            endpoint: base.endpoint("chat/completions"),
            model: settings
                .model
                .clone()
                .unwrap_or_else(|| DEFAULT_MODEL.to_owned()),
            access,
            http: Client::default(),
            silence,
        })
    }

    /// Sends a round and reads its answer to the end.
    async fn exchange(
        &self,
        request: &TurnRequest,
        drafts: &mut ReplyDrafts<'_>,
    ) -> Result<ProviderAnswer, Fault> {
        let http = self.http.get()?;
        let mut silence = Silence::start(self.silence);
        let mut response = transport::send(
            http,
            &self.endpoint,
            &self.access,
            &request.bytes,
            &mut silence,
        )
        .await?
        .accepted()?;
        let status = response.status().as_u16();
        let refused = |code, message| Fault {
            code,
            message,
            status: Some(status),
        };
        let mut fold = StreamFold::default();

        while let Some(chunk) = transport::next_chunk(&mut response, &mut silence).await? {
            let flow = fold
                .push(&chunk, &mut |fragment| drafts.hear(fragment))
                .map_err(|error| refused(error.code, error.message))?;

            if flow == Flow::Done {
                break;
            }
        }

        answer(fold.finish(), &request.mappings).map_err(|(code, message)| refused(code, message))
    }

    /// A plain completion's text, or why there is none.
    async fn completion(&self, request: &TextCompletionRequest) -> Result<String, String> {
        let http = self.http.get().map_err(Failure::message)?;
        let mut silence = Silence::start(self.silence);
        let body = completion_request(&self.model, request);
        let response = transport::send(http, &self.endpoint, &self.access, &body, &mut silence)
            .await
            .map_err(Failure::message)?
            .accepted()
            .map_err(|fault| fault.message)?;
        let body = transport::read_all(response, &mut silence)
            .await
            .map_err(Failure::message)?;

        completion_text(&serde_json::from_slice(&body).unwrap_or(Value::Null))
    }
}

#[async_trait]
impl RoleModelAdapter for NvidiaAdapter {
    async fn invoke(&self, invocation: &Invocation<'_>) -> ProviderAnswer {
        let request = TurnRequest::new(&self.model, invocation.messages(), invocation.tools());
        let mut drafts = ReplyDrafts::new(*invocation, &request.mappings);

        match self.exchange(&request, &mut drafts).await {
            Ok(answer) => {
                drafts.finish();
                answer
            }
            Err(fault) => fault.answer(NVIDIA, &self.access),
        }
    }

    async fn complete_text(&self, request: &TextCompletionRequest) -> TextCompletion {
        match self.completion(request).await {
            Ok(text) => TextCompletion::Completed {
                text,
                provider: ProviderName::Nvidia,
                model: Some(self.model.clone()),
            },
            Err(reason) => TextCompletion::Failed {
                reason: said(NVIDIA, &self.access, &reason),
            },
        }
    }
}

/// A round as sent: the body exactly as it goes on the wire, the tools in it
/// under the names the provider takes, and the mapping back.
#[derive(Debug)]
pub(crate) struct TurnRequest {
    mappings: Vec<ToolNameMapping>,
    bytes: Vec<u8>,
}

#[derive(Serialize)]
struct TurnBody<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    #[serde(flatten)]
    offered: Offered<'a>,
    stream: bool,
    stream_options: StreamOptions,
    temperature: u8,
    top_p: u8,
    max_tokens: u32,
    #[serde(flatten)]
    reasoning: Reasoning,
}

/// The tools, always offered: `visible_reply` is among them whatever the
/// plugins provide.
#[derive(Serialize)]
struct Offered<'a> {
    tools: &'a [ChatCompletionTool],
    tool_choice: &'static str,
    parallel_tool_calls: bool,
}

#[derive(Serialize)]
struct StreamOptions {
    include_usage: bool,
}

#[derive(Serialize)]
struct Reasoning {
    reasoning_budget: u32,
    chat_template_kwargs: TemplateOptions,
}

#[derive(Serialize)]
struct TemplateOptions {
    enable_thinking: bool,
}

const THINKING: Reasoning = Reasoning {
    reasoning_budget: REASONING_BUDGET,
    chat_template_kwargs: TemplateOptions {
        enable_thinking: true,
    },
};

impl TurnRequest {
    pub(crate) fn new(model: &str, messages: &[ChatMessage], tools: &[ChatCompletionTool]) -> Self {
        let mappings = provider_names(tools);
        let messages: Vec<ChatMessage> = messages
            .iter()
            .map(|message| provider_message(message, &mappings))
            .collect();
        let tools: Vec<ChatCompletionTool> = tools
            .iter()
            .map(|tool| {
                ChatCompletionTool::new(ChatToolFunction {
                    name: provider_name(&tool.function().name, &mappings),
                    ..tool.function().clone()
                })
            })
            .collect();
        let bytes = json_text(&TurnBody {
            model,
            messages: &messages,
            offered: Offered {
                tools: &tools,
                tool_choice: "auto",
                parallel_tool_calls: true,
            },
            stream: true,
            stream_options: StreamOptions {
                include_usage: true,
            },
            temperature: 1,
            top_p: 1,
            max_tokens: MAX_TOKENS,
            reasoning: THINKING,
        })
        .into_bytes();

        Self { mappings, bytes }
    }
}

/// `message` with the tools its calls name under the provider's names.
fn provider_message(message: &ChatMessage, mappings: &[ToolNameMapping]) -> ChatMessage {
    match message {
        ChatMessage::Assistant {
            content,
            tool_calls,
        } => ChatMessage::Assistant {
            content: content.clone(),
            tool_calls: tool_calls
                .iter()
                .map(|call| {
                    ChatToolCall::new(
                        call.id().clone(),
                        ChatFunctionCall {
                            name: provider_name(&call.function().name, mappings),
                            arguments: call.function().arguments.clone(),
                        },
                    )
                })
                .collect(),
        },
        other => other.clone(),
    }
}

/// A plain completion's body, exactly as it goes on the wire: no tools,
/// thinking off, at most one token for every two characters asked for.
pub(crate) fn completion_request(model: &str, request: &TextCompletionRequest) -> Vec<u8> {
    let body = json!({
        "model": model,
        "messages": [
            ChatMessage::System { content: request.instructions.clone() },
            ChatMessage::User { content: request.input.clone() },
        ],
        "stream": false,
        "temperature": 0.3,
        "top_p": 1,
        "max_tokens": request.max_output_chars.get().div_ceil(2),
        "chat_template_kwargs": {"enable_thinking": false},
    });

    json_text(&body).into_bytes()
}

/// The text of a completion that ended whole: a recollection cut off at
/// the output limit would lose its newest part, which matters most.
fn completion_text(body: &Value) -> Result<String, String> {
    let no_text = || "completion returned no text.".to_owned();
    let choice = body
        .get("choices")
        .and_then(|choices| choices.get(0))
        .filter(|choice| choice.is_object())
        .ok_or_else(no_text)?;
    let message = choice
        .get("message")
        .filter(|message| message.is_object())
        .ok_or_else(no_text)?;

    match choice.get("finish_reason") {
        Some(Value::String(reason)) if TERMINAL_FINISH_REASONS.contains(&reason.as_str()) => {}
        other => {
            let reason = match other {
                Some(Value::String(reason)) => reason.clone(),
                Some(other) => other.to_string(),
                None => "null".to_owned(),
            };

            return Err(format!(
                "completion ended with finish_reason \"{reason}\" instead of finishing."
            ));
        }
    }

    message
        .get("content")
        .and_then(Value::as_str)
        .map(|content| scrub_reasoning_blocks(content).trim().to_owned())
        .filter(|text| !text.is_empty())
        .ok_or_else(no_text)
}

/// The streamed message as the model's answer, once it ended whole: its
/// calls under the runtime's names, each call's arguments as JSON when they
/// parse and as their text when they do not, so a bad call is refused where
/// every other is, and its content with leaked reasoning taken out.
fn answer(
    completion: Completion,
    mappings: &[ToolNameMapping],
) -> Result<ProviderAnswer, (FailureCode, String)> {
    let finish_reason = match completion.finish_reason {
        None => {
            return Err((
                FailureCode::MalformedResponse,
                "response choice.finish_reason is required.".to_owned(),
            ));
        }
        Some(reason) if TERMINAL_FINISH_REASONS.contains(&reason.as_str()) => reason,
        Some(reason) => {
            return Err((
                FailureCode::ProviderError,
                format!("response finish_reason \"{reason}\" is not terminal."),
            ));
        }
    };
    let tool_calls = completion
        .calls
        .into_iter()
        .enumerate()
        .map(|(index, call)| {
            let name = call.name.ok_or_else(|| {
                (
                    FailureCode::MalformedResponse,
                    format!("response message.tool_calls[{index}].function.name must be a string."),
                )
            })?;

            Ok(WrittenCall {
                name: runtime_name(&name, mappings),
                input: serde_json::from_str(&call.arguments)
                    .unwrap_or(Value::String(call.arguments)),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let text = completion
        .content
        .map(|content| scrub_reasoning_blocks(&content))
        .filter(|text| !text.is_empty());

    Ok(ProviderAnswer::Answered {
        output: ModelOutput { tool_calls, text },
        finish_reason: Some(finish_reason),
        usage: completion.usage,
    })
}
