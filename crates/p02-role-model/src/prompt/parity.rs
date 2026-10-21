//! The prompts the TypeScript daemon wrote, recorded in the crate's
//! fixtures, which the Rust renderer is held to byte for byte: the README
//! says how they were recorded and how to record them again.

use std::num::NonZeroUsize;

use p02_contracts::{
    ConversationTurn, DecisionContext, HistoryWindow, InputEnvelope, PluginContextItem,
    PluginCuratedSection, PluginToolDefinition, PluginToolDefinitions, RuntimeNote,
    TextCompletionRequest, ToolRound,
};
use p02_core::{CharacterProfile, EventIdentity, SessionId, SpeakerName, UserLine};
use serde::Deserialize;
use serde_json::Value;

use super::tests::mira;
use super::text::{Person, Recollection, summarizer_instructions, unusable_reply_note};
use super::{CalendarDay, render, today_note};
use crate::nvidia::{TurnRequest, completion_request};

const MODEL: &str = "nvidia/fixture-model";

const TURNS: [&str; 4] = [
    include_str!("../../tests/fixtures/prompts/first-turn.json"),
    include_str!("../../tests/fixtures/prompts/continued-session.json"),
    include_str!("../../tests/fixtures/prompts/rounds-of-this-turn.json"),
    include_str!("../../tests/fixtures/prompts/only-the-reply.json"),
];

const TEXTS: &str = include_str!("../../tests/fixtures/prompts/texts.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Turn {
    name: String,
    input: Input,
    rendered: Rendered,
    request_body: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    event: EventIdentity,
    session_id: SessionId,
    character: CharacterProfile,
    user_message: String,
    user_display_name: Option<SpeakerName>,
    context_summary: Option<String>,
    runtime_notes: Vec<RuntimeNote>,
    plugin_context_items: Vec<PluginContextItem>,
    curated_sections: Vec<PluginCuratedSection>,
    plugin_tools: Vec<PluginToolDefinition>,
    history: Vec<ConversationTurn>,
    tool_rounds: Vec<ToolRound>,
    unusable_reply_note: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rendered {
    messages: Value,
    tools: Value,
    prompt_size: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Texts {
    completions: Vec<Completion>,
    today_notes: Vec<TodayNote>,
    unusable_notes: Vec<UnusableNote>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Completion {
    summarizer: Summarizer,
    instructions: String,
    input: String,
    request_body: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Summarizer {
    user_display_name: Option<SpeakerName>,
    character_name: SpeakerName,
    max_output_chars: NonZeroUsize,
    has_previous_summary: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TodayNote {
    created_at: String,
    note: RuntimeNote,
}

#[derive(Deserialize)]
struct UnusableNote {
    details: String,
    note: String,
}

fn person(name: Option<&SpeakerName>) -> Person<'_> {
    name.map_or(Person::Unnamed, Person::Named)
}

#[test]
fn every_recorded_prompt_renders_to_the_bytes_the_typescript_daemon_sent() {
    let persona = mira();

    for fixture in TURNS {
        let Turn {
            name,
            input,
            rendered,
            request_body,
        } = serde_json::from_str(fixture).unwrap();
        let mut context = DecisionContext::new(input.session_id, input.character)
            .with_history_window(HistoryWindow::of(&input.history))
            .with_runtime_notes(input.runtime_notes)
            .with_plugin_context(input.plugin_context_items, input.curated_sections);

        if let Some(summary) = input.context_summary {
            context = context.with_summary(summary).unwrap();
        }

        let mut envelope = InputEnvelope::new(
            input.event,
            UserLine::new(&input.user_message).unwrap().into(),
            context,
            PluginToolDefinitions::new(input.plugin_tools).unwrap(),
        );

        envelope.tool_rounds = input.tool_rounds;

        let prompt = render(
            &envelope,
            &input.history,
            &persona,
            person(input.user_display_name.as_ref()),
            input.unusable_reply_note.as_deref(),
        );
        let request = TurnRequest::new(MODEL, prompt.messages(), prompt.tools());

        assert_eq!(
            serde_json::to_value(prompt.messages()).unwrap(),
            rendered.messages,
            "{name}"
        );
        assert_eq!(
            serde_json::to_value(prompt.tools()).unwrap(),
            rendered.tools,
            "{name}"
        );
        assert_eq!(
            serde_json::to_value(prompt.size()).unwrap(),
            rendered.prompt_size,
            "{name}"
        );
        assert_eq!(
            String::from_utf8_lossy(request.bytes()),
            request_body,
            "{name}"
        );
    }
}

#[test]
fn the_runtime_s_own_sentences_are_the_ones_the_typescript_daemon_wrote() {
    let texts: Texts = serde_json::from_str(TEXTS).unwrap();

    for completion in texts.completions {
        let summarizer = completion.summarizer;
        let instructions = summarizer_instructions(
            person(summarizer.user_display_name.as_ref()),
            &summarizer.character_name,
            summarizer.max_output_chars,
            if summarizer.has_previous_summary {
                Recollection::Rewrite
            } else {
                Recollection::First
            },
        );
        let request = TextCompletionRequest {
            instructions: instructions.clone(),
            input: completion.input,
            max_output_chars: summarizer.max_output_chars,
        };

        assert_eq!(instructions, completion.instructions);
        assert_eq!(
            String::from_utf8(completion_request(MODEL, &request)).unwrap(),
            completion.request_body
        );
    }

    for today in texts.today_notes {
        let day = |at: std::ops::Range<usize>| today.created_at[at].parse().unwrap();
        let day = CalendarDay::new(
            day(0..4),
            day(5..7).try_into().unwrap(),
            day(8..10).try_into().unwrap(),
        )
        .unwrap();

        assert_eq!(today_note(day), today.note, "{}", today.created_at);
    }

    for unusable in texts.unusable_notes {
        assert_eq!(unusable_reply_note(&unusable.details), unusable.note);
    }
}
