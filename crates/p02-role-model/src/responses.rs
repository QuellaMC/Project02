//! The Responses adapter: OpenAI's Responses protocol, streamed and read
//! back into the model's answer: its calls and its text. The protocol is
//! the adapter's; a service of it says where it is, how a request proves
//! who sends it, what of the protocol it takes, and its name in what the
//! person reads. Two speak it: the OpenAI API, on the person's key, and a
//! ChatGPT plan, on the home's sign-in.

mod plan;
mod stream;

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use p02_contracts::{
    ChatCompletionTool, ChatMessage, Invocation, ModelOutput, ProviderAnswer, ProviderName,
    RoleModelAdapter, TextCompletion, TextCompletionRequest, TokenUsage, ToolCallId, WrittenCall,
    scrub_reasoning_blocks,
};
use p02_shared::BaseUrl;
use reqwest::{Response, Url};
use serde::Serialize;
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::draft::{Fragment, ReplyDrafts};
use crate::prompt::{
    CallIds, ToolNameMapping, json_text, provider_name, provider_names, runtime_name,
};
use crate::transport::{
    self, Access, Answer, BuildAdapterError, Client, Failure, FailureCode, Fault,
    MAX_OUTPUT_TOKENS, Silence, said,
};
pub use plan::{ChatgptSettings, PlanAccess, PlanSignIn};
use stream::{Ended, Ending, EventFold};

const OPENAI_API: &str = "https://api.openai.com/v1";

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
    endpoint: Url,
    dialect: Dialect,
}

/// How a service proves who sends a request, and what of the protocol it
/// takes.
#[derive(Debug)]
enum Dialect {
    /// The OpenAI API: the protocol as OpenAI documents it, on the person's
    /// key, the same on every request.
    Api(Access),
    /// A ChatGPT plan: the protocol as OpenAI's Codex app speaks it, on the
    /// home's sign-in, fresh for every request.
    Plan(Arc<dyn PlanSignIn>),
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
            endpoint: base.endpoint("responses"),
            dialect: Dialect::Api(Access::bearer(name, key)?),
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

/// A request as it went: what proved who sent it, which no failure of it
/// repeats, and its answer once it began, or why there was none.
struct Sent {
    access: Access,
    answered: Result<Response, Fault>,
}

impl ResponsesAdapter {
    /// The OpenAI API as `settings` choose it, bounding the provider's
    /// silence at `silence`.
    pub(crate) fn openai(
        settings: &OpenaiSettings,
        silence: Duration,
    ) -> Result<Self, BuildAdapterError> {
        Ok(Self::of(
            ResponsesService::openai(settings)?,
            &settings.model,
            silence,
        ))
    }

    /// The ChatGPT plan as `settings` choose it, bounding the provider's
    /// silence at `silence`.
    pub(crate) fn chatgpt(
        settings: &ChatgptSettings,
        silence: Duration,
    ) -> Result<Self, BuildAdapterError> {
        Ok(Self::of(
            ResponsesService::chatgpt(settings)?,
            &settings.model,
            silence,
        ))
    }

    fn of(service: ResponsesService, model: &str, silence: Duration) -> Self {
        Self {
            service,
            model: model.to_owned(),
            http: Client::default(),
            silence,
        }
    }

    /// Sends `request` as its service takes it, and waits for the answer to
    /// begin: on the OpenAI API's key, or on a plan's sign-in.
    async fn send(&self, request: &Request, silence: &mut Silence) -> Sent {
        let http = match self.http.get() {
            Ok(http) => http,
            Err(failure) => {
                return Sent {
                    access: Access::open(),
                    answered: Err(failure.into()),
                };
            }
        };

        match &self.service.dialect {
            Dialect::Api(access) => Sent {
                access: access.clone(),
                answered: transport::send(
                    http,
                    &self.service.endpoint,
                    access,
                    &request.bytes,
                    silence,
                )
                .await
                .map_err(Fault::from)
                .and_then(Answer::accepted),
            },
            Dialect::Plan(sign_in) => {
                plan::send(
                    http,
                    &self.service.endpoint,
                    sign_in.as_ref(),
                    request,
                    silence,
                )
                .await
            }
        }
    }

    /// Sends a round and reads its answer to the end: the model's, or the
    /// round's failure said as its service's, without what proved who sent
    /// it.
    async fn exchange(
        &self,
        request: &RoundRequest,
        drafts: &mut ReplyDrafts<'_>,
    ) -> ProviderAnswer {
        let mut silence = Silence::start(self.silence);
        let Sent { access, answered } = self.send(&request.request, &mut silence).await;
        let answer = match answered {
            Ok(response) => {
                let status = response.status().as_u16();

                streamed(response, &mut silence, &mut |fragment| {
                    drafts.hear(fragment);
                })
                .await
                .and_then(|ended| {
                    answer(ended, &request.mappings).map_err(|(code, message)| Fault {
                        code,
                        message,
                        status: Some(status),
                    })
                })
            }
            Err(fault) => Err(fault),
        };

        answer.unwrap_or_else(|fault| fault.answer(self.service.name, &access))
    }

    /// A plain completion's text, or why there is none, said as its
    /// service's.
    async fn completion(&self, request: &TextCompletionRequest) -> Result<String, String> {
        let mut silence = Silence::start(self.silence);
        let completion = Request::completion(&self.model, request, &self.service.dialect);
        let Sent { access, answered } = self.send(&completion, &mut silence).await;
        let output = match answered {
            Ok(response) => self.output(response, &mut silence).await,
            Err(fault) => Err(fault.message),
        };

        output
            .and_then(|output| {
                Some(scrub_reasoning_blocks(&text_of(&output)).trim().to_owned())
                    .filter(|text| !text.is_empty())
                    .ok_or_else(|| "completion returned no text.".to_owned())
            })
            .map_err(|reason| said(self.service.name, &access, &reason))
    }

    /// The output of a plain completion's answer: read whole from the
    /// OpenAI API, and streamed from a plan's service, which streams every
    /// answer.
    async fn output(
        &self,
        response: Response,
        silence: &mut Silence,
    ) -> Result<Vec<Value>, String> {
        let Ended {
            ending,
            response,
            done,
        } = match self.service.dialect {
            Dialect::Api(_) => {
                let body = transport::read_all(response, silence)
                    .await
                    .map_err(Failure::message)?;
                let response = serde_json::from_slice(&body).unwrap_or(Value::Null);

                Ended {
                    ending: whole_ending(&response).map_err(|(_, message)| message)?,
                    response,
                    done: Vec::new(),
                }
            }
            Dialect::Plan(_) => streamed(response, silence, &mut |_| {})
                .await
                .map_err(|fault| fault.message)?,
        };

        output_of(ending, &response, done).map_err(|(_, message)| message)
    }
}

#[async_trait]
impl RoleModelAdapter for ResponsesAdapter {
    async fn invoke(&self, invocation: &Invocation<'_>) -> ProviderAnswer {
        let request = RoundRequest::new(
            &self.model,
            invocation.messages(),
            invocation.tools(),
            &self.service.dialect,
        );
        let mut drafts = ReplyDrafts::new(*invocation, &request.mappings);
        let answer = self.exchange(&request, &mut drafts).await;

        if let ProviderAnswer::Answered { .. } = answer {
            drafts.finish();
        }

        answer
    }

    async fn complete_text(&self, request: &TextCompletionRequest) -> TextCompletion {
        match self.completion(request).await {
            Ok(text) => TextCompletion::Completed {
                text,
                provider: ProviderName::Openai,
                model: Some(self.model.clone()),
            },
            Err(reason) => TextCompletion::Failed { reason },
        }
    }
}

/// A streamed answer read to the event that ends it, each piece of a
/// function call's arguments told to `heard`: how it ended, or why it did
/// not, under the status that answered.
async fn streamed(
    response: Response,
    silence: &mut Silence,
    heard: &mut impl FnMut(Fragment<'_>),
) -> Result<Ended, Fault> {
    let mut fold = EventFold::default();

    transport::streamed(response, silence, |chunk| fold.push(chunk, heard)).await
}

/// A request as it goes on the wire: its body exactly, and the session it
/// opens with a plan's service, which its headers name too.
#[derive(Debug)]
struct Request {
    bytes: Vec<u8>,
    session: Option<String>,
}

/// A round as sent: the request, and the mapping back from the names its
/// tools go by.
#[derive(Debug)]
struct RoundRequest {
    mappings: Vec<ToolNameMapping>,
    request: Request,
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
    #[serde(flatten)]
    framing: &'a Framing,
}

/// A plain completion's body: its instructions and its input, no tools,
/// streamed only for a service that streams every answer.
#[derive(Serialize)]
struct CompletionBody<'a> {
    model: &'a str,
    input: Vec<Item<'a>>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    stream: bool,
    store: bool,
    #[serde(flatten)]
    framing: &'a Framing,
}

/// What a body says beside its input, as its service takes it.
#[derive(Serialize)]
#[serde(untagged)]
enum Framing {
    /// The OpenAI API's: a bound on the output.
    Api { max_output_tokens: u32 },
    /// A plan's, as OpenAI's Codex app sends it: instructions left empty,
    /// the system's lines going as a developer's; a little reasoning, its
    /// content handed back since the service keeps nothing; and the session
    /// the request opens, as its prompt's cache key.
    Plan {
        instructions: &'static str,
        reasoning: Reasoning,
        include: [&'static str; 1],
        prompt_cache_key: String,
    },
}

#[derive(Serialize)]
struct Reasoning {
    effort: &'static str,
}

impl Framing {
    /// A new request's, as `dialect` takes it: a plan's opens a session of
    /// its own, as OpenAI's Codex app opens one for each request.
    fn new(dialect: &Dialect) -> Self {
        match dialect {
            Dialect::Api(_) => Self::Api {
                max_output_tokens: MAX_OUTPUT_TOKENS,
            },
            Dialect::Plan(_) => Self::Plan {
                instructions: "",
                reasoning: Reasoning { effort: "low" },
                include: ["reasoning.encrypted_content"],
                prompt_cache_key: Uuid::new_v4().to_string(),
            },
        }
    }

    /// The session the request opens, for a plan's service.
    fn session(&self) -> Option<String> {
        match self {
            Self::Api { .. } => None,
            Self::Plan {
                prompt_cache_key, ..
            } => Some(prompt_cache_key.clone()),
        }
    }
}

/// One item of a request's input.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Item<'a> {
    Message {
        role: &'static str,
        content: Content<'a>,
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

/// A message's text, as its service takes it.
#[derive(Serialize)]
#[serde(untagged)]
enum Content<'a> {
    /// Plain: the OpenAI API's.
    Text(&'a str),
    /// One part of its kind: a plan's.
    Parts([Part<'a>; 1]),
}

#[derive(Serialize)]
struct Part<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    text: &'a str,
}

/// Whose a message's text is.
#[derive(Clone, Copy)]
enum Role {
    System,
    Developer,
    User,
    Assistant,
}

impl Dialect {
    /// `role`'s message holding `text`, as the service takes one: a plan
    /// takes the system's lines as the developer's, and each text as one
    /// part, the model's own as its output and every other as input.
    fn message<'a>(&self, role: Role, text: &'a str) -> Item<'a> {
        match self {
            Self::Api(_) => Item::Message {
                role: match role {
                    Role::System => "system",
                    Role::Developer => "developer",
                    Role::User => "user",
                    Role::Assistant => "assistant",
                },
                content: Content::Text(text),
            },
            Self::Plan(_) => Item::Message {
                role: match role {
                    Role::System | Role::Developer => "developer",
                    Role::User => "user",
                    Role::Assistant => "assistant",
                },
                content: Content::Parts([Part {
                    kind: match role {
                        Role::Assistant => "output_text",
                        Role::System | Role::Developer | Role::User => "input_text",
                    },
                    text,
                }]),
            },
        }
    }
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
    fn new(
        model: &str,
        messages: &[ChatMessage],
        tools: &[ChatCompletionTool],
        dialect: &Dialect,
    ) -> Self {
        let mappings = provider_names(tools);
        let framing = Framing::new(dialect);
        let bytes = json_text(&RoundBody {
            model,
            input: items(messages, &mappings, dialect),
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
            framing: &framing,
        })
        .into_bytes();

        Self {
            mappings,
            request: Request {
                bytes,
                session: framing.session(),
            },
        }
    }
}

impl Request {
    /// A plain completion as `dialect` takes it: its instructions and its
    /// input, no tools.
    fn completion(model: &str, request: &TextCompletionRequest, dialect: &Dialect) -> Self {
        let framing = Framing::new(dialect);
        let messages = [
            ChatMessage::System {
                content: request.instructions.clone(),
            },
            ChatMessage::User {
                content: request.input.clone(),
            },
        ];
        let bytes = json_text(&CompletionBody {
            model,
            input: items(&messages, &[], dialect),
            stream: matches!(dialect, Dialect::Plan(_)),
            store: false,
            framing: &framing,
        })
        .into_bytes();

        Self {
            bytes,
            session: framing.session(),
        }
    }
}

/// The messages as the protocol's input, as `dialect` takes it: each line
/// under its role, her calls as function calls under the names the tools
/// go by, and each call's result as its output, tied to its call by the id
/// the request shows for it.
fn items<'a>(
    messages: &'a [ChatMessage],
    mappings: &[ToolNameMapping],
    dialect: &Dialect,
) -> Vec<Item<'a>> {
    let mut ids = CallIds::default();
    let mut items = Vec::new();

    for message in messages {
        match message {
            ChatMessage::System { content } => items.push(dialect.message(Role::System, content)),
            ChatMessage::Developer { content } => {
                items.push(dialect.message(Role::Developer, content));
            }
            ChatMessage::User { content } => items.push(dialect.message(Role::User, content)),
            ChatMessage::Assistant {
                content,
                tool_calls,
            } => {
                if let Some(content) = content.as_deref().filter(|content| !content.is_empty()) {
                    items.push(dialect.message(Role::Assistant, content));
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

/// How a response read whole ended, by its status.
fn whole_ending(response: &Value) -> Result<Ending, (FailureCode, String)> {
    match response.get("status").and_then(Value::as_str) {
        Some("completed") => Ok(Ending::Completed),
        Some("incomplete") => Ok(Ending::Incomplete),
        Some("failed") => Ok(Ending::Failed),
        _ => Err((
            FailureCode::MalformedResponse,
            "response must end completed, incomplete or failed.".to_owned(),
        )),
    }
}

/// The output of a response that ended as `ending`, or why it has none to
/// use: one cut short says why, and one that failed says the service's
/// words. A response that carries no output of its own, as a plan's
/// service may end one, holds the items it streamed, as each was `done`.
fn output_of(
    ending: Ending,
    response: &Value,
    done: Vec<Value>,
) -> Result<Vec<Value>, (FailureCode, String)> {
    match ending {
        Ending::Completed => match response.get("output") {
            Some(Value::Array(output)) if !output.is_empty() => Ok(output.clone()),
            None | Some(Value::Array(_)) => Ok(done),
            Some(_) => Err((
                FailureCode::MalformedResponse,
                "response output must be an array.".to_owned(),
            )),
        },
        Ending::Incomplete => Err((
            FailureCode::ProviderError,
            format!(
                "response ended incomplete: {}.",
                response
                    .pointer("/incomplete_details/reason")
                    .and_then(Value::as_str)
                    .unwrap_or("no reason given")
            ),
        )),
        Ending::Failed => Err((
            FailureCode::ProviderError,
            response
                .as_object()
                .and_then(transport::provider_error)
                .unwrap_or_else(|| "response failed.".to_owned()),
        )),
    }
}

/// A response at its end as the model's answer, once it completed: its
/// function calls under the runtime's names, each call's arguments as JSON
/// when they parse and as their text when they do not, so a bad call is
/// refused where every other is; its text with leaked reasoning taken out;
/// and the tokens it took.
fn answer(
    ended: Ended,
    mappings: &[ToolNameMapping],
) -> Result<ProviderAnswer, (FailureCode, String)> {
    let usage = usage(&ended.response);
    let output = output_of(ended.ending, &ended.response, ended.done)?;
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
    let text = Some(scrub_reasoning_blocks(&text_of(&output))).filter(|text| !text.is_empty());

    Ok(ProviderAnswer::Answered {
        output: ModelOutput { tool_calls, text },
        finish_reason: Some("completed".to_owned()),
        usage,
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
