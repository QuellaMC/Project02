//! The world the tests build: a turn's envelope, Mira, and the pieces of a
//! streamed answer.

use p02_characters::{Persona, discover};
use p02_contracts::{
    ChatCompletionTool, ChatMessage, ChatToolFunction, ConversationTurn, DecisionContext,
    InputEnvelope, PluginToolDefinition, PluginToolDefinitions, ProvidedTool, ToolInputContract,
};
use p02_core::{
    CharacterProfile, EventId, EventIdentity, SessionId, SpeakerName, Timestamp, TraceId, UserLine,
};
use p02_shared::Identifier;
use serde_json::{Value, json};

pub(crate) fn id(text: &str) -> Identifier {
    Identifier::new(text).unwrap()
}

/// The persona of the character every home has.
pub(crate) fn mira() -> Persona {
    let home = tempfile::tempdir().unwrap();

    discover(home.path())
        .characters
        .into_iter()
        .find(|character| character.profile.id.as_str() == "mira")
        .unwrap()
        .persona
}

pub(crate) fn event() -> EventIdentity {
    EventIdentity::new(
        EventId::new("evt_turn").unwrap(),
        TraceId::new("trace_turn").unwrap(),
        Timestamp::new("2026-06-15T09:30:00.000Z").unwrap(),
    )
    .unwrap()
}

pub(crate) fn context() -> DecisionContext {
    DecisionContext::new(
        SessionId::parse("conv_mira.1").unwrap(),
        CharacterProfile {
            id: id("mira"),
            display_name: SpeakerName::new("Mira").unwrap(),
        },
    )
}

/// A tool `name` of `plugin`, taking anything an object holds.
pub(crate) fn plugin_tool(plugin: &str, name: &str) -> PluginToolDefinition {
    PluginToolDefinition {
        plugin_id: id(plugin),
        tool: ProvidedTool::new(
            id(name),
            "A tool.",
            ToolInputContract::new(json!({"type": "object"})).unwrap(),
        )
        .unwrap(),
    }
}

pub(crate) fn envelope(line: &str) -> InputEnvelope {
    InputEnvelope::new(
        event(),
        UserLine::new(line).unwrap().into(),
        context(),
        PluginToolDefinitions::default(),
    )
}

/// Messages and tools as a round of the loop would render them.
pub(crate) fn wire(tools: &[&str]) -> (Vec<ChatMessage>, Vec<ChatCompletionTool>) {
    let messages = vec![
        ChatMessage::System {
            content: "You are Mira.".to_owned(),
        },
        ChatMessage::User {
            content: "Hello?".to_owned(),
        },
    ];
    let tools = tools
        .iter()
        .map(|name| {
            ChatCompletionTool::new(ChatToolFunction {
                name: (*name).to_owned(),
                description: "A tool.".to_owned(),
                parameters: json!({"type": "object"}).as_object().cloned().unwrap(),
                strict: false,
            })
        })
        .collect();

    (messages, tools)
}

/// An earlier turn: the person's line and Mira's reply.
pub(crate) fn turn(index: u64, line: &str, reply: &str) -> ConversationTurn {
    serde_json::from_value(json!({
        "eventId": format!("evt_{index}"),
        "traceId": format!("trace_{index}"),
        "createdAt": "2026-06-14T00:00:00.000Z",
        "userMessage": {
            "id": format!("conv_mira.1:message-{}", index * 2 - 1),
            "role": "user",
            "speakerId": "local-user",
            "speakerName": "You",
            "text": line,
        },
        "toolRounds": [],
        "finalReplies": [{
            "id": format!("conv_mira.1:message-{}", index * 2),
            "role": "character",
            "speakerId": "mira",
            "speakerName": "Mira",
            "text": reply,
        }],
    }))
    .unwrap()
}

/// A chunk carrying content.
pub(crate) fn content(text: &str) -> String {
    json!({"choices": [{"index": 0, "delta": {"content": text}, "finish_reason": null}]})
        .to_string()
}

/// A chunk carrying a piece of the call at `index`, its id and name on the
/// first.
pub(crate) fn call_piece(index: u64, first: Option<(&str, &str)>, arguments: &str) -> String {
    let mut call = json!({"index": index, "function": {"arguments": arguments}});

    if let Some((call_id, name)) = first {
        call["id"] = json!(call_id);
        call["type"] = json!("function");
        call["function"]["name"] = json!(name);
    }

    json!({"choices": [{"index": 0, "delta": {"tool_calls": [call]}, "finish_reason": null}]})
        .to_string()
}

pub(crate) fn finish(reason: &str) -> String {
    json!({"choices": [{"index": 0, "delta": {}, "finish_reason": reason}]}).to_string()
}

pub(crate) fn usage(usage: &Value) -> String {
    json!({"choices": [], "usage": usage}).to_string()
}

pub(crate) const DONE: &str = "[DONE]";

/// `data` as one event.
pub(crate) fn event_text(data: &str) -> String {
    format!("data: {data}\n\n")
}
