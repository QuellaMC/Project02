//! The Responses adapter: OpenAI's Responses protocol, which the OpenAI API
//! speaks, streamed and read back into the model's answer: its calls and
//! its text. The protocol is the adapter's; a service of it says where it
//! is, how a request proves who sends it, and its name in what the person
//! reads.

mod stream;

use std::fmt;
use std::time::Duration;

use async_trait::async_trait;
use p02_contracts::{
    ChatCompletionTool, ChatMessage, Invocation, ModelOutput, ProviderAnswer, ProviderName,
    RoleModelAdapter, TextCompletion, TextCompletionRequest, TokenUsage, ToolCallId, WrittenCall,
    scrub_reasoning_blocks,
};
use p02_shared::BaseUrl;
use reqwest::Url;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::draft::ReplyDrafts;
use crate::prompt::{ToolNameMapping, json_text, provider_name, provider_names, runtime_name};
use crate::transport::{
    self, Access, Answer, BuildAdapterError, Client, Failure, FailureCode, Fault, Silence, said,
};
use stream::EventFold;

const OPENAI_API: &str = "https://api.openai.com/v1";

/// How many tokens a response may take, its reasoning among them: as much
/// room as NVIDIA's models get to think, and then to reply.
const MAX_OUTPUT_TOKENS: u32 = 32_768;

/// A character's settings for the OpenAI API.
#[derive(Clone)]
pub struct OpenaiSettings {
    pub api_key: Option<String>,
    pub model: String,
    /// Where the OpenAI API is, as a test harness names it; its own address
    /// when unset.
    pub base_url: Option<BaseUrl>,
}

impl fmt::Debug for OpenaiSettings {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenaiSettings")
            .field("api_key", &self.api_key.as_ref().map(|_| "[redacted]"))
            .field("model", &self.model)
            .field("base_url", &self.base_url)
            .finish()
    }
}

/// A service that speaks the Responses protocol.
#[derive(Debug)]
struct ResponsesService {
    /// What the person and a failure's words call it.
    name: &'static str,
    provider: ProviderName,
    endpoint: Url,
    access: Access,
}

impl ResponsesService {
    /// The OpenAI API, on the person's key, at its own address unless a
    /// test harness names another.
    fn openai(settings: &OpenaiSettings) -> Result<Self, BuildAdapterError> {
        let name = "OpenAI";
        let key = settings
            .api_key
            .as_deref()
            .filter(|key| !key.is_empty())
            .ok_or(BuildAdapterError::MissingKey(name))?;
        let base = settings.base_url.clone().unwrap_or_else(|| {
            BaseUrl::parse(OPENAI_API).expect("the OpenAI API's address is a base URL")
        });

        Ok(Self {
            name,
            provider: ProviderName::Openai,
            endpoint: base.endpoint("responses"),
            access: Access::bearer(name, key)?,
        })
    }
}

/// The adapter of one character's service.
#[derive(Debug)]
pub(crate) struct ResponsesAdapter {
    service: ResponsesService,
    model: String,
    http: Client,
    silence: Duration,
}

impl ResponsesAdapter {
    /// The OpenAI API as `settings` choose it, bounding the provider's
    /// silence at `silence`.
    pub(crate) fn openai(
        settings: &OpenaiSettings,
        silence: Duration,
    ) -> Result<Self, BuildAdapterError> {
        Ok(Self {
            service: ResponsesService::openai(settings)?,
            model: settings.model.clone(),
            http: Client::default(),
            silence,
        })
    }

    /// Sends `body` and waits for the service's answer to begin.
    async fn send(&self, body: &[u8], silence: &mut Silence) -> Result<Answer, Failure> {
        transport::send(
            self.http.get()?,
            &self.service.endpoint,
            &self.service.access,
            body,
            silence,
        )
        .await
    }

    /// Sends a round and reads its answer to the end.
    async fn exchange(
        &self,
        request: &RoundRequest,
        drafts: &mut ReplyDrafts<'_>,
    ) -> Result<ProviderAnswer, Fault> {
        let mut silence = Silence::start(self.silence);
        let mut response = match self.send(&request.bytes, &mut silence).await? {
            Answer::Accepted(response) => response,
            Answer::Refused { status, message } => {
                return Err(Fault {
                    code: FailureCode::HttpError,
                    message,
                    status: Some(status),
                });
            }
        };
        let status = response.status().as_u16();
        let refused = |code, message| Fault {
            code,
            message,
            status: Some(status),
        };
        let mut fold = EventFold::default();

        while let Some(chunk) = transport::next_chunk(&mut response, &mut silence).await? {
            let ended = fold
                .push(&chunk, &mut |fragment| drafts.hear(fragment))
                .map_err(|error| refused(error.code, error.message))?;

            if let Some(ended) = ended {
                return answer(&ended, &request.mappings)
                    .map_err(|(code, message)| refused(code, message));
            }
        }

        Err(refused(
            FailureCode::MalformedResponse,
            "response ended before it finished.".to_owned(),
        ))
    }

    /// A plain completion's text, or why there is none.
    async fn completion(&self, request: &TextCompletionRequest) -> Result<String, String> {
        let mut silence = Silence::start(self.silence);
        let response = match self
            .send(&completion_request(&self.model, request), &mut silence)
            .await
            .map_err(Failure::message)?
        {
            Answer::Accepted(response) => response,
            Answer::Refused { message, .. } => return Err(message),
        };
        let body = transport::read_all(response, &mut silence)
            .await
            .map_err(Failure::message)?;
        let response = serde_json::from_slice(&body).unwrap_or(Value::Null);
        let output = output_of(&response).map_err(|(_, message)| message)?;

        Some(scrub_reasoning_blocks(&text_of(output)).trim().to_owned())
            .filter(|text| !text.is_empty())
            .ok_or_else(|| "completion returned no text.".to_owned())
    }
}

#[async_trait]
impl RoleModelAdapter for ResponsesAdapter {
    async fn invoke(&self, invocation: &Invocation<'_>) -> ProviderAnswer {
        let request = RoundRequest::new(&self.model, invocation.messages(), invocation.tools());
        let mut drafts = ReplyDrafts::new(*invocation, &request.mappings);

        match self.exchange(&request, &mut drafts).await {
            Ok(answer) => {
                drafts.finish();
                answer
            }
            Err(fault) => fault.answer(self.service.name, &self.service.access),
        }
    }

    async fn complete_text(&self, request: &TextCompletionRequest) -> TextCompletion {
        match self.completion(request).await {
            Ok(text) => TextCompletion::Completed {
                text,
                provider: self.service.provider,
                model: Some(self.model.clone()),
            },
            Err(reason) => TextCompletion::Failed {
                reason: said(self.service.name, &self.service.access, &reason),
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

/// A round's body. Nothing is stored, and no reasoning is passed back: a
/// round replays her earlier calls as the runtime keeps them, which is not
/// the output the reasoning followed.
#[derive(Serialize)]
struct RoundBody<'a> {
    model: &'a str,
    input: Vec<Item<'a>>,
    tools: Vec<FunctionTool<'a>>,
    tool_choice: &'static str,
    stream: bool,
    store: bool,
    max_output_tokens: u32,
}

/// One item of a request's input.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Item<'a> {
    Message {
        role: &'static str,
        content: &'a str,
    },
    FunctionCall {
        call_id: ToolCallId,
        name: String,
        arguments: &'a str,
    },
    FunctionCallOutput {
        call_id: ToolCallId,
        output: &'a str,
    },
}

/// A tool as the protocol offers one. Never strict: the protocol's strict
/// mode takes only a schema whose every property is required, and the
/// runtime holds a call to the tool's own contract whatever the model
/// writes.
#[derive(Serialize)]
struct FunctionTool<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    name: String,
    description: &'a str,
    parameters: &'a Map<String, Value>,
    strict: bool,
}

impl RoundRequest {
    fn new(model: &str, messages: &[ChatMessage], tools: &[ChatCompletionTool]) -> Self {
        let mappings = provider_names(tools);
        let bytes = json_text(&RoundBody {
            model,
            input: items(messages, &mappings),
            tools: tools
                .iter()
                .map(|tool| FunctionTool {
                    kind: "function",
                    name: provider_name(&tool.function().name, &mappings),
                    description: &tool.function().description,
                    parameters: &tool.function().parameters,
                    strict: false,
                })
                .collect(),
            tool_choice: "auto",
            stream: true,
            store: false,
            max_output_tokens: MAX_OUTPUT_TOKENS,
        })
        .into_bytes();

        Self { mappings, bytes }
    }
}

/// The messages as the protocol's input: each line under its role, her
/// calls as function calls under the names the tools go by, and each
/// call's result as its output, tied to its call by the id the request
/// shows for it.
fn items<'a>(messages: &'a [ChatMessage], mappings: &[ToolNameMapping]) -> Vec<Item<'a>> {
    let mut ids = CallIds::default();
    let mut items = Vec::new();

    for message in messages {
        match message {
            ChatMessage::System { content } => items.push(Item::Message {
                role: "system",
                content,
            }),
            ChatMessage::Developer { content } => items.push(Item::Message {
                role: "developer",
                content,
            }),
            ChatMessage::User { content } => items.push(Item::Message {
                role: "user",
                content,
            }),
            ChatMessage::Assistant {
                content,
                tool_calls,
            } => {
                if let Some(content) = content.as_deref().filter(|content| !content.is_empty()) {
                    items.push(Item::Message {
                        role: "assistant",
                        content,
                    });
                }

                items.extend(tool_calls.iter().map(|call| Item::FunctionCall {
                    call_id: ids.shown(call.id()),
                    name: provider_name(&call.function().name, mappings),
                    arguments: &call.function().arguments,
                }));
            }
            ChatMessage::Tool {
                content,
                tool_call_id,
            } => items.push(Item::FunctionCallOutput {
                call_id: ids.shown(tool_call_id),
                output: content,
            }),
        }
    }

    items
}

/// The ids a request shows the service for the runtime's calls: `call_<n>`,
/// numbered in the order the request first names each. The runtime's own
/// are longer than the protocol takes.
#[derive(Debug, Default)]
struct CallIds(Vec<ToolCallId>);

impl CallIds {
    fn shown(&mut self, id: &ToolCallId) -> ToolCallId {
        let at = self
            .0
            .iter()
            .position(|named| named == id)
            .unwrap_or_else(|| {
                self.0.push(id.clone());
                self.0.len() - 1
            });

        ToolCallId::new(&format!("call_{}", at + 1)).expect("a numbered call id is not empty")
    }
}

/// A plain completion's body, exactly as it goes on the wire: its
/// instructions and its input, no tools, not streamed.
fn completion_request(model: &str, request: &TextCompletionRequest) -> Vec<u8> {
    #[derive(Serialize)]
    struct CompletionBody<'a> {
        model: &'a str,
        input: Vec<Item<'a>>,
        store: bool,
        max_output_tokens: u32,
    }

    let messages = [
        ChatMessage::System {
            content: request.instructions.clone(),
        },
        ChatMessage::User {
            content: request.input.clone(),
        },
    ];

    json_text(&CompletionBody {
        model,
        input: items(&messages, &[]),
        store: false,
        max_output_tokens: MAX_OUTPUT_TOKENS,
    })
    .into_bytes()
}

/// The output of a response that completed, or why it did not: one cut
/// short says why, and one that failed says the service's words.
fn output_of(response: &Value) -> Result<&[Value], (FailureCode, String)> {
    match response.get("status").and_then(Value::as_str) {
        Some("completed") => response
            .get("output")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .ok_or_else(|| {
                (
                    FailureCode::MalformedResponse,
                    "response output must be an array.".to_owned(),
                )
            }),
        Some("incomplete") => Err((
            FailureCode::ProviderError,
            format!(
                "response ended incomplete: {}.",
                response
                    .pointer("/incomplete_details/reason")
                    .and_then(Value::as_str)
                    .unwrap_or("no reason given")
            ),
        )),
        Some("failed") => Err((
            FailureCode::ProviderError,
            response
                .as_object()
                .and_then(transport::provider_error)
                .unwrap_or_else(|| "response failed.".to_owned()),
        )),
        _ => Err((
            FailureCode::MalformedResponse,
            "response must end completed, incomplete or failed.".to_owned(),
        )),
    }
}

/// A finished response as the model's answer, once it completed: its
/// function calls under the runtime's names, each call's arguments as JSON
/// when they parse and as their text when they do not, so a bad call is
/// refused where every other is; its text with leaked reasoning taken out;
/// and the tokens it took.
fn answer(
    response: &Value,
    mappings: &[ToolNameMapping],
) -> Result<ProviderAnswer, (FailureCode, String)> {
    let output = output_of(response)?;
    let tool_calls = output
        .iter()
        .enumerate()
        .filter(|(_, item)| item.get("type").and_then(Value::as_str) == Some("function_call"))
        .map(|(index, item)| {
            let name = item.get("name").and_then(Value::as_str).ok_or_else(|| {
                (
                    FailureCode::MalformedResponse,
                    format!("response output[{index}].name must be a string."),
                )
            })?;
            let arguments = item.get("arguments").and_then(Value::as_str).unwrap_or("");

            Ok(WrittenCall {
                name: runtime_name(name, mappings),
                input: serde_json::from_str(arguments)
                    .unwrap_or_else(|_| Value::String(arguments.to_owned())),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let text = Some(scrub_reasoning_blocks(&text_of(output))).filter(|text| !text.is_empty());

    Ok(ProviderAnswer::Answered {
        output: ModelOutput { tool_calls, text },
        finish_reason: Some("completed".to_owned()),
        usage: usage(response),
    })
}

/// What the output's messages say: their text, and any refusal, in order.
fn text_of(output: &[Value]) -> String {
    output
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("message"))
        .filter_map(|item| item.get("content").and_then(Value::as_array))
        .flatten()
        .filter_map(|part| match part.get("type").and_then(Value::as_str) {
            Some("output_text") => part.get("text").and_then(Value::as_str),
            Some("refusal") => part.get("refusal").and_then(Value::as_str),
            _ => None,
        })
        .collect()
}

/// The token counts of a response's usage, when it has both.
fn usage(response: &Value) -> Option<TokenUsage> {
    Some(TokenUsage {
        prompt_tokens: response.pointer("/usage/input_tokens")?.as_u64()?,
        completion_tokens: response.pointer("/usage/output_tokens")?.as_u64()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_openai_api_is_at_its_own_address_unless_a_harness_names_another() {
        let at = |base_url: Option<&str>| {
            ResponsesService::openai(&OpenaiSettings {
                api_key: Some("sk-key".to_owned()),
                model: "gpt-6-luna".to_owned(),
                base_url: base_url.map(|base| BaseUrl::parse(base).unwrap()),
            })
            .unwrap()
            .endpoint
            .to_string()
        };

        assert_eq!(at(None), "https://api.openai.com/v1/responses");
        assert_eq!(
            at(Some("http://127.0.0.1:9/openai/v1")),
            "http://127.0.0.1:9/openai/v1/responses"
        );
    }
}
