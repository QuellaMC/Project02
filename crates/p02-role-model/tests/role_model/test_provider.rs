//! The test provider, reached through the test switch alone.

use std::num::{NonZeroU32, NonZeroU64};
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use p02_contracts::{ConversationToolCall, PluginToolDefinitions};
use p02_core::{MessageId, SessionId, SpeakerName, UserLine, VisibleMessage, VisibleMessageRole};
use p02_role_model::{
    DraftEvent, ModelRound, NvidiaSettings, Person, Reply, RoutedToolCall, TestProvider, TurnInput,
    TurnOutcome, TurnSink, UnknownTestProviderError, run_turn, select_adapter,
};

use crate::stub::Stub;
use crate::support::{context, event, id, mira, turn};

/// A turn that keeps the replies it commits and the drafts it hears.
#[derive(Debug, Default)]
struct Said {
    replies: Mutex<Vec<String>>,
    drafts: Mutex<Vec<String>>,
}

#[async_trait]
impl TurnSink for Said {
    type Error = &'static str;

    async fn record_round(&self, _round: &ModelRound) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn commit_reply(&self, reply: Reply<'_>) -> Result<VisibleMessage, Self::Error> {
        self.replies.lock().unwrap().push(reply.text.to_string());

        Ok(VisibleMessage {
            id: MessageId::new(SessionId::parse("conv_mira.1").unwrap(), NonZeroU64::MIN),
            role: VisibleMessageRole::Character,
            speaker_id: id("mira"),
            speaker_name: SpeakerName::new("Mira").unwrap(),
            text: reply.text.clone(),
        })
    }

    async fn run_tool_calls(
        &self,
        _round: NonZeroU32,
        _calls: Vec<RoutedToolCall>,
    ) -> Result<Vec<ConversationToolCall>, Self::Error> {
        Err("the test provider calls no tool")
    }

    fn draft(&self, event: DraftEvent) {
        if let DraftEvent::Delta { draft, text } = event {
            self.drafts.lock().unwrap().push(format!("{draft} {text}"));
        }
    }
}

#[tokio::test]
async fn the_test_switch_answers_in_the_fixed_voice_whatever_the_settings_choose() {
    let model = Stub::start().await;
    let settings = NvidiaSettings {
        api_key: Some("nvapi-unused".to_owned()),
        base_url: Some(model.base_url()),
        ..NvidiaSettings::default()
    };
    let adapter = select_adapter(Some(TestProvider::Deterministic), Some(&settings), None)
        .unwrap()
        .unwrap();
    let persona = mira();
    let history = [turn(1, "First line.", "I'm here. Tell me what you need.")];
    let said = Said::default();

    for replayed in [&history[..0], &history[..]] {
        let outcome = run_turn(
            adapter.as_ref(),
            &said,
            TurnInput {
                event: event(),
                user_message: UserLine::new("Hello?").unwrap().into(),
                context: context(),
                plugin_tools: PluginToolDefinitions::default(),
                history: replayed,
                persona: &persona,
                person: Person::Unnamed,
            },
        )
        .await;

        assert!(matches!(outcome, Ok(TurnOutcome::Replied { .. })));
    }

    assert_eq!(
        *said.replies.lock().unwrap(),
        [
            "I'm here. Tell me what you need.",
            "I remember you said \"First line.\" Stay with me for a minute.",
        ]
    );
    assert_eq!(
        said.drafts.lock().unwrap()[..7],
        [
            "1.0 I'm ",
            "1.0 here. ",
            "1.0 Tell ",
            "1.0 me ",
            "1.0 what ",
            "1.0 you ",
            "1.0 need.",
        ]
    );
    assert_eq!(model.requests().len(), 0);
}

#[tokio::test]
async fn without_the_switch_a_character_speaks_through_the_provider_its_settings_chose() {
    let settings = NvidiaSettings {
        api_key: Some("nvapi-key".to_owned()),
        ..NvidiaSettings::default()
    };

    assert!(select_adapter(None, None, None).unwrap().is_none());
    assert!(
        select_adapter(None, Some(&settings), Some(Duration::from_secs(2)))
            .unwrap()
            .is_some()
    );
    assert_eq!("deterministic".parse(), Ok(TestProvider::Deterministic));
    assert_eq!(
        "local".parse::<TestProvider>(),
        Err(UnknownTestProviderError)
    );
}
