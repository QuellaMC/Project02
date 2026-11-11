//! Session logs written by hand, apart from the encoder: what a valid log
//! holds, spelled out, reads back and re-encodes to the same bytes; a
//! record is taken as it was written, and one that fits no turn is skipped
//! and named.

use p02_contracts::DecisionResult;
use p02_core::ClientStamp;
use p02_store::{LogRecord, RecordBody};

use crate::support::{World, conversation_named, lines_of, session};

const TEA_RECEIVED: &str = r#"{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z","kind":"runtime_event_received","payloadSummary":{"rawInput":" Tea? ","normalizedCurrentUserMessage":"Tea?"}}"#;
const TEA_ASKED: &str = r#"{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z","kind":"visible_message_committed","visibleMessageIds":["conv_a.1:message-1"],"visibleMessage":{"id":"conv_a.1:message-1","role":"user","speakerId":"local-user","speakerName":"Sam","text":"Tea?"},"source":"web","clientMessageId":"tea"}"#;
const TEA_ROUND_1: &str = r#"{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z","kind":"role_model_round","round":1,"output":{"toolCalls":[{"name":"character_state.patch","input":{"mood":"warm"}}],"text":"Checking."},"finishReason":"tool_calls","usage":{"promptTokens":1200,"completionTokens":14},"parsedRoleModelDecisionSnapshot":{"result":{"status":"accepted","decision":{"toolCalls":[{"name":"character_state.patch","input":{"mood":"warm"}}],"text":"Checking."}}}}"#;
/// Round 1 as a record kept a round before rounds were lean: with its
/// prompt, its raw output and the decision contract's version.
const TEA_ROUND_1_KEPT_BEFORE: &str = r#"{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z","kind":"role_model_round","round":1,"roleModelIOSnapshot":{"inputEnvelope":{"event":{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z"},"userMessage":"Tea?","decisionContext":{"sessionId":"conv_a.1","characterSnapshot":{"id":"mira","displayName":"Mira"},"historyWindow":{"turnEventIds":[]},"runtimeNotes":[],"pluginContextItems":[],"curatedContextSections":[]},"pluginToolDefinitions":[],"toolRounds":[],"outputContract":{"version":"mvp-006.tool_calls.v1"}},"rawOutputText":"{\"toolCalls\":[{\"name\":\"character_state.patch\",\"input\":{\"mood\":\"warm\"}}],\"text\":\"Checking.\"}","characterRef":{"version":"1.1.0","personaFingerprint":"sha256:6b965dfe599ffa2f70010c2ccb993b9305b8bc98f0badd2f9cb582c853836931"},"promptSize":{"frames":[{"kind":"system_protocol","count":1,"chars":100}],"toolChars":0}},"parsedRoleModelDecisionSnapshot":{"result":{"status":"accepted","decision":{"version":"mvp-006.tool_calls.v1","toolCalls":[{"name":"character_state.patch","input":{"mood":"warm"}}],"text":"Checking."}}}}"#;
const TEA_CALLED: &str = r#"{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z","kind":"tool_call_started","round":1,"toolCallId":"evt_1.trace_1.round-1.1.character_state.patch","toolName":"character_state.patch","toolPluginId":"character-state","toolInput":{"mood":"warm"}}"#;
const TEA_ANSWERED: &str = r#"{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z","kind":"tool_call_finished","round":1,"toolCallId":"evt_1.trace_1.round-1.1.character_state.patch","toolName":"character_state.patch","toolPluginId":"character-state","toolResult":{"status":"accepted","output":{"mood":"warm"}},"runtimePluginEvidence":[{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z","pluginId":"character-state","evidenceKind":"tool_invocation","status":"accepted","summary":"Mood set.","redactionLabels":[]}]}"#;
const TEA_ROUND_2: &str = r#"{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z","kind":"role_model_round","round":2,"output":{"toolCalls":[],"text":"Tea, always."},"finishReason":"stop","usage":{"promptTokens":1260,"completionTokens":4},"parsedRoleModelDecisionSnapshot":{"result":{"status":"accepted","decision":{"toolCalls":[{"name":"visible_reply","input":{"text":"Tea, always."}}]}}}}"#;
const TEA_REPLIED: &str = r#"{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z","kind":"visible_message_committed","visibleMessageIds":["conv_a.1:message-2"],"visibleMessage":{"id":"conv_a.1:message-2","role":"character","speakerId":"mira","speakerName":"Mira","text":"Tea, always."},"round":2}"#;
const TEA_COMPLETED: &str = r#"{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z","kind":"runtime_turn_completed","status":"completed","visibleMessageIds":["conv_a.1:message-1","conv_a.1:message-2"],"toolCallIds":["evt_1.trace_1.round-1.1.character_state.patch"],"round":2,"commitValidation":{"result":{"status":"accepted","acceptedVisibleReplyText":"Tea, always."}}}"#;
const TEA_AFTER: &str = r#"{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z","kind":"after_turn_committed","status":"completed_with_failures","runtimePluginEvidence":[{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z","pluginId":"mem0","evidenceKind":"after_turn_committed","status":"degraded","summary":"Not queued.","redactionLabels":[]}]}"#;
const BLANK_RECEIVED: &str = r#"{"eventId":"evt_2","traceId":"trace_2","createdAt":"2026-10-21T09:01:00.000Z","kind":"runtime_event_received","payloadSummary":{"rawInput":" \t\n "}}"#;
const BLANK_REFUSED: &str = r#"{"eventId":"evt_2","traceId":"trace_2","createdAt":"2026-10-21T09:01:00.000Z","kind":"runtime_turn_rejected","reason":"input_validation_rejected","message":"Provide a non-empty message."}"#;
const FAILED_RECEIVED: &str = r#"{"eventId":"evt_3","traceId":"trace_3","createdAt":"2026-10-21T09:02:00.000Z","kind":"runtime_event_received","payloadSummary":{"rawInput":"Still there?","normalizedCurrentUserMessage":"Still there?"}}"#;
const FAILED_ASKED: &str = r#"{"eventId":"evt_3","traceId":"trace_3","createdAt":"2026-10-21T09:02:00.000Z","kind":"visible_message_committed","visibleMessageIds":["conv_a.1:message-4"],"visibleMessage":{"id":"conv_a.1:message-4","role":"user","speakerId":"local-user","speakerName":"Sam","text":"Still there?"}}"#;
const FAILED_ROUND: &str = r#"{"eventId":"evt_3","traceId":"trace_3","createdAt":"2026-10-21T09:02:00.000Z","kind":"role_model_round","round":1,"failure":{"code":"http_error","message":"The provider answered 503.","status":503},"parsedRoleModelDecisionSnapshot":{"result":{"status":"rejected","rejection":{"reason":"provider_error","details":"The provider answered 503."}}}}"#;
const FAILED_REJECTED: &str = r#"{"eventId":"evt_3","traceId":"trace_3","createdAt":"2026-10-21T09:02:00.000Z","kind":"runtime_turn_rejected","reason":"provider_error","message":"The provider answered 503.","visibleMessageIds":["conv_a.1:message-4"],"round":1}"#;
const MOMENT_RECEIVED: &str = r#"{"eventId":"evt_4","traceId":"trace_4","createdAt":"2026-10-21T09:03:00.000Z","kind":"runtime_event_received","occasion":"moment"}"#;
const MOMENT_THOUGHT: &str = r#"{"eventId":"evt_4","traceId":"trace_4","createdAt":"2026-10-21T09:03:00.000Z","kind":"role_model_round","round":1,"output":{"toolCalls":[],"text":"I wonder if Sam found the keys."},"finishReason":"stop","parsedRoleModelDecisionSnapshot":{"result":{"status":"accepted","decision":{"toolCalls":[],"text":"I wonder if Sam found the keys."}}}}"#;
const MOMENT_COMPLETED: &str = r#"{"eventId":"evt_4","traceId":"trace_4","createdAt":"2026-10-21T09:03:00.000Z","kind":"runtime_turn_completed","status":"completed","round":1,"commitValidation":{"result":{"status":"accepted"}}}"#;
/// The continuation of the first segment, carrying its first turn as the
/// model replays it, in the shape every earlier build wrote.
const CONTINUED: &str = r#"{"eventId":"evt_5","traceId":"trace_5","createdAt":"2026-10-21T09:05:00.000Z","kind":"session_continued","sessionContinuation":{"sessionId":"conv_a.2","continuedFrom":{"sessionId":"conv_a.1","lastEventId":"evt_4"},"summary":"They talked about tea.","summarizedTurnCount":1,"carriedTurns":[{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z","userMessage":{"id":"conv_a.1:message-1","role":"user","speakerId":"local-user","speakerName":"Sam","text":"Tea?"},"toolRounds":[{"round":1,"text":"Checking.","interimReplies":[],"toolCalls":[{"toolCallId":"evt_1.trace_1.round-1.1.character_state.patch","pluginId":"character-state","toolName":"character_state.patch","input":{"mood":"warm"},"result":{"status":"accepted","output":{"mood":"warm"}}}]}],"finalReplies":[{"id":"conv_a.1:message-2","role":"character","speakerId":"mira","speakerName":"Mira","text":"Tea, always."}]}],"summarizer":{"status":"fallback","reason":"The provider has no model to ask."}}}"#;

/// The first segment: a turn with a tool round and the plugins' work after
/// it, a blank text refused as no line, a turn whose provider failed, and a
/// moment of Mira's own that ended in a thought.
const FIRST_SEGMENT: [&str; 18] = [
    TEA_RECEIVED,
    TEA_ASKED,
    TEA_ROUND_1,
    TEA_CALLED,
    TEA_ANSWERED,
    TEA_ROUND_2,
    TEA_REPLIED,
    TEA_COMPLETED,
    TEA_AFTER,
    BLANK_RECEIVED,
    BLANK_REFUSED,
    FAILED_RECEIVED,
    FAILED_ASKED,
    FAILED_ROUND,
    FAILED_REJECTED,
    MOMENT_RECEIVED,
    MOMENT_THOUGHT,
    MOMENT_COMPLETED,
];

#[test]
fn a_log_written_by_hand_reads_back_and_re_encodes_to_its_own_bytes() {
    let world = World::new();
    let conversation = conversation_named("conv_a");

    world.first_segment(&conversation).unwrap().release();

    let second = world.next_segment(&conversation, 1).unwrap();

    assert_eq!(second.session_id(), &session("conv_a.2"));
    second.release();

    for (segment, lines) in [(1, FIRST_SEGMENT.as_slice()), (2, &[CONTINUED])] {
        let log = world.log_of(&conversation, segment);
        let path = world.path_of(log.session_id());

        std::fs::write(&path, lines.join("\n") + "\n").unwrap();

        let replay = log.read().unwrap();
        let encoded: Vec<String> = replay.records().iter().map(LogRecord::to_line).collect();

        assert_eq!(encoded, lines_of(&path));
        assert!(replay.skipped_lines().is_empty());
    }
}

/// A record is read as it was written: a field this build does not know
/// is ignored, so a round recorded before rounds were lean reads, a round
/// keeps the verdict it recorded, and no record is held to the order or
/// the agreement of the records before it.
#[test]
fn a_record_is_taken_as_written_whatever_the_records_before_it_say() {
    let world = World::new();
    let conversation = conversation_named("conv_a");
    let log = world.log_of(&conversation, 1);
    let lines = [
        TEA_RECEIVED.to_owned(),
        // A round before the line, kept as rounds once were, its verdict
        // other than its output reads as.
        replace(
            TEA_ROUND_1_KEPT_BEFORE,
            r#""text":"Checking."}}}}"#,
            r#""text":"Something else."}}}}"#,
        ),
        replace(
            TEA_ASKED,
            r#""source":"web""#,
            r#""source":"web","mood":"warm""#,
        ),
        // A reply its round never said, and an ending naming other messages.
        replace(TEA_REPLIED, "Tea, always.", "Coffee."),
        replace(TEA_COMPLETED, r#""conv_a.1:message-1","#, ""),
        BLANK_RECEIVED.to_owned(),
        // The line submitted as "tea" committed a second time.
        second(TEA_ASKED).replace("message-1", "message-3"),
    ];

    world.first_segment(&conversation).unwrap().release();
    std::fs::write(world.path_of(log.session_id()), lines.join("\n") + "\n").unwrap();

    let replay = log.read().unwrap();
    let RecordBody::ModelRound(round) = replay.records()[1].body() else {
        panic!("{:?}", replay.records()[1]);
    };
    let DecisionResult::Accepted { decision } = round.result() else {
        panic!("{round:?}");
    };

    assert!(replay.skipped_lines().is_empty());
    assert_eq!(replay.records().len(), lines.len());
    assert_eq!(decision.text(), Some("Something else."));
    assert_eq!(replay.records()[2].to_line(), TEA_ASKED);
    assert_eq!(
        replay.user_lines()[&ClientStamp::new("tea").unwrap()].to_string(),
        "conv_a.1:message-1"
    );
}

/// A record whose turn never started, a continuation after the session
/// began, and a message whose number does not climb fit no turn: each is
/// skipped and named, and the session reads without it.
#[test]
fn a_record_that_fits_no_turn_is_skipped_and_named_and_the_session_reads() {
    let world = World::new();
    let conversation = conversation_named("conv_a");
    let log = world.log_of(&conversation, 1);
    let lines = [
        TEA_ASKED.to_owned(),
        BLANK_RECEIVED.to_owned(),
        BLANK_REFUSED.to_owned(),
        CONTINUED.to_owned(),
        TEA_RECEIVED.to_owned(),
        TEA_ASKED.to_owned(),
        second(TEA_ASKED),
    ];

    world.first_segment(&conversation).unwrap().release();
    std::fs::write(world.path_of(log.session_id()), lines.join("\n") + "\n").unwrap();

    let replay = log.read().unwrap();

    assert_eq!(replay.skipped_lines().numbers(), [1, 4, 7]);
    assert_eq!(
        replay
            .records()
            .iter()
            .map(LogRecord::to_line)
            .collect::<Vec<_>>(),
        [BLANK_RECEIVED, BLANK_REFUSED, TEA_RECEIVED, TEA_ASKED]
    );
    assert_eq!(replay.session().messages().len(), 1);
    assert_eq!(replay.skipped_lines().to_string(), "lines 1, 4, 7");
}

/// `line` with the first `from` in it made `to`; `from` must be there.
fn replace(line: &str, from: &str, to: &str) -> String {
    assert!(line.contains(from), "{from}");
    line.replacen(from, to, 1)
}

/// A record of the first turn, made the second turn's: its event and trace,
/// a minute later.
fn second(line: &str) -> String {
    line.replace("evt_1", "evt_2")
        .replace("trace_1", "trace_2")
        .replace("09:00:00", "09:01:00")
}
