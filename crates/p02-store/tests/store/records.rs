//! Session logs written by hand, apart from the encoder: what a valid log
//! holds, spelled out, reads back and re-encodes to the same bytes, and a
//! record that breaks a rule is refused as damage, whoever wrote it.

use p02_store::{LogRecord, StorageError};

use crate::support::{World, lines_of, session};

const TEA_RECEIVED: &str = r#"{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z","kind":"runtime_event_received","payloadSummary":{"rawInput":" Tea? ","normalizedCurrentUserMessage":"Tea?"}}"#;
const TEA_NORMALIZED: &str = r#"{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z","kind":"runtime_event_normalized"}"#;
const TEA_ASKED: &str = r#"{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z","kind":"visible_message_committed","visibleMessageIds":["conv_a.1:message-1"],"visibleMessage":{"id":"conv_a.1:message-1","role":"user","speakerId":"local-user","speakerName":"Sam","text":"Tea?"},"source":"web","clientMessageId":"tea"}"#;
const TEA_ROUND_1: &str = r#"{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z","kind":"role_model_round","round":1,"roleModelIOSnapshot":{"inputEnvelope":{"event":{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z"},"userMessage":"Tea?","decisionContext":{"sessionId":"conv_a.1","characterSnapshot":{"id":"mira","displayName":"Mira"},"historyWindow":{"turnEventIds":[]},"runtimeNotes":[],"pluginContextItems":[],"curatedContextSections":[]},"pluginToolDefinitions":[],"toolRounds":[],"outputContract":{"version":"mvp-006.tool_calls.v1"}},"rawOutputText":"{\"toolCalls\":[{\"name\":\"character_state.patch\",\"input\":{\"mood\":\"warm\"}}],\"text\":\"Checking.\"}","characterRef":{"version":"1.1.0","personaFingerprint":"sha256:6b965dfe599ffa2f70010c2ccb993b9305b8bc98f0badd2f9cb582c853836931"},"promptSize":{"frames":[{"kind":"system_protocol","count":1,"chars":100}],"toolChars":0}},"parsedRoleModelDecisionSnapshot":{"result":{"status":"accepted","decision":{"version":"mvp-006.tool_calls.v1","toolCalls":[{"name":"character_state.patch","input":{"mood":"warm"}}],"text":"Checking."}}}}"#;
const TEA_CALLED: &str = r#"{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z","kind":"tool_call_started","round":1,"toolCallId":"evt_1.trace_1.round-1.1.character_state.patch","toolName":"character_state.patch","toolPluginId":"character-state","toolInput":{"mood":"warm"}}"#;
const TEA_ANSWERED: &str = r#"{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z","kind":"tool_call_finished","round":1,"toolCallId":"evt_1.trace_1.round-1.1.character_state.patch","toolName":"character_state.patch","toolPluginId":"character-state","dispatchedToHost":true,"toolResult":{"status":"accepted","output":{"mood":"warm"}},"runtimePluginEvidence":[{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z","pluginId":"character-state","evidenceKind":"tool_invocation","status":"accepted","summary":"Mood set.","redactionLabels":[]}]}"#;
const TEA_ROUND_2: &str = r#"{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z","kind":"role_model_round","round":2,"roleModelIOSnapshot":{"inputEnvelope":{"event":{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z"},"userMessage":"Tea?","decisionContext":{"sessionId":"conv_a.1","characterSnapshot":{"id":"mira","displayName":"Mira"},"historyWindow":{"turnEventIds":[]},"runtimeNotes":[],"pluginContextItems":[],"curatedContextSections":[]},"pluginToolDefinitions":[],"toolRounds":[],"outputContract":{"version":"mvp-006.tool_calls.v1"}},"rawOutputText":"{\"toolCalls\":[{\"name\":\"visible_reply\",\"input\":{\"text\":\"Tea, always.\"}}]}","characterRef":{"version":"1.1.0","personaFingerprint":"sha256:6b965dfe599ffa2f70010c2ccb993b9305b8bc98f0badd2f9cb582c853836931"},"promptSize":{"frames":[{"kind":"system_protocol","count":1,"chars":100}],"toolChars":0}},"parsedRoleModelDecisionSnapshot":{"result":{"status":"accepted","decision":{"version":"mvp-006.tool_calls.v1","toolCalls":[{"name":"visible_reply","input":{"text":"Tea, always."}}]}}}}"#;
const TEA_REPLIED: &str = r#"{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z","kind":"visible_message_committed","visibleMessageIds":["conv_a.1:message-2"],"visibleMessage":{"id":"conv_a.1:message-2","role":"character","speakerId":"mira","speakerName":"Mira","text":"Tea, always."},"round":2}"#;
const TEA_COMPLETED: &str = r#"{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z","kind":"runtime_turn_completed","status":"completed","visibleMessageIds":["conv_a.1:message-1","conv_a.1:message-2"],"toolCallIds":["evt_1.trace_1.round-1.1.character_state.patch"],"round":2,"commitValidation":{"result":{"status":"accepted","acceptedVisibleReplyText":"Tea, always."}},"runtimePluginTurnEvidence":{"health":[{"pluginId":"mem0","status":"ok","checkedAt":"2026-10-21T09:00:00.000Z","summary":"Ready.","redactionLabels":[]}]}}"#;
const TEA_AFTER: &str = r#"{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z","kind":"after_turn_committed","status":"completed_with_failures","runtimePluginEvidence":[{"eventId":"evt_1","traceId":"trace_1","createdAt":"2026-10-21T09:00:00.000Z","pluginId":"mem0","evidenceKind":"after_turn_committed","status":"degraded","summary":"Not queued.","redactionLabels":[]}]}"#;
const SPLIT_RECEIVED: &str = r#"{"eventId":"evt_2","traceId":"trace_2","createdAt":"2026-10-21T09:01:00.000Z","kind":"runtime_event_received","payloadSummary":{"rawInput":"one\ntwo"}}"#;
const SPLIT_REFUSED: &str = r#"{"eventId":"evt_2","traceId":"trace_2","createdAt":"2026-10-21T09:01:00.000Z","kind":"runtime_turn_rejected","reason":"input_validation_rejected","message":"A message must be a single line."}"#;
const FAILED_RECEIVED: &str = r#"{"eventId":"evt_3","traceId":"trace_3","createdAt":"2026-10-21T09:02:00.000Z","kind":"runtime_event_received","payloadSummary":{"rawInput":"Still there?","normalizedCurrentUserMessage":"Still there?"}}"#;
const FAILED_ASKED: &str = r#"{"eventId":"evt_3","traceId":"trace_3","createdAt":"2026-10-21T09:02:00.000Z","kind":"visible_message_committed","visibleMessageIds":["conv_a.1:message-4"],"visibleMessage":{"id":"conv_a.1:message-4","role":"user","speakerId":"local-user","speakerName":"Sam","text":"Still there?"}}"#;
const FAILED_ROUND: &str = r#"{"eventId":"evt_3","traceId":"trace_3","createdAt":"2026-10-21T09:02:00.000Z","kind":"role_model_round","round":1,"roleModelIOSnapshot":{"inputEnvelope":{"event":{"eventId":"evt_3","traceId":"trace_3","createdAt":"2026-10-21T09:02:00.000Z"},"userMessage":"Still there?","decisionContext":{"sessionId":"conv_a.1","characterSnapshot":{"id":"mira","displayName":"Mira"},"historyWindow":{"turnEventIds":["evt_1"]},"runtimeNotes":[],"pluginContextItems":[],"curatedContextSections":[]},"pluginToolDefinitions":[],"toolRounds":[],"outputContract":{"version":"mvp-006.tool_calls.v1"}},"characterRef":{"version":"1.1.0","personaFingerprint":"sha256:6b965dfe599ffa2f70010c2ccb993b9305b8bc98f0badd2f9cb582c853836931"},"promptSize":{"frames":[{"kind":"system_protocol","count":1,"chars":100}],"toolChars":0}},"parsedRoleModelDecisionSnapshot":{"result":{"status":"rejected","rejection":{"reason":"provider_error","details":"The provider answered 503."}}}}"#;
const FAILED_REJECTED: &str = r#"{"eventId":"evt_3","traceId":"trace_3","createdAt":"2026-10-21T09:02:00.000Z","kind":"runtime_turn_rejected","reason":"provider_error","message":"The provider answered 503.","visibleMessageIds":["conv_a.1:message-4"],"round":1}"#;
const END_RECEIVED: &str = r#"{"eventId":"evt_4","traceId":"trace_4","createdAt":"2026-10-21T09:03:00.000Z","kind":"runtime_event_received","payloadSummary":{"rawInput":"/exit","normalizedCurrentUserMessage":"/exit"}}"#;
const END_COMPLETED: &str = r#"{"eventId":"evt_4","traceId":"trace_4","createdAt":"2026-10-21T09:03:00.000Z","kind":"runtime_turn_completed","status":"completed"}"#;
const CONTINUED: &str = r#"{"eventId":"evt_5","traceId":"trace_5","createdAt":"2026-10-21T09:05:00.000Z","kind":"session_continued","sessionContinuation":{"sessionId":"conv_a.2","continuedFrom":{"sessionId":"conv_a.1","lastEventId":"evt_4"},"summary":"They talked about tea.","summarizedTurnCount":1,"carriedTurns":[],"summarizer":{"status":"fallback","reason":"The provider has no model to ask."}}}"#;

/// The first segment: a turn with a tool round and the plugins' work after
/// it, a line refused as no line, a turn whose provider failed, and the
/// session's end.
const FIRST_SEGMENT: [&str; 18] = [
    TEA_RECEIVED,
    TEA_NORMALIZED,
    TEA_ASKED,
    TEA_ROUND_1,
    TEA_CALLED,
    TEA_ANSWERED,
    TEA_ROUND_2,
    TEA_REPLIED,
    TEA_COMPLETED,
    TEA_AFTER,
    SPLIT_RECEIVED,
    SPLIT_REFUSED,
    FAILED_RECEIVED,
    FAILED_ASKED,
    FAILED_ROUND,
    FAILED_REJECTED,
    END_RECEIVED,
    END_COMPLETED,
];

#[test]
fn a_log_written_by_hand_reads_back_and_re_encodes_to_its_own_bytes() {
    let world = World::new();
    let conversation = world.conversation_named("conv_a");
    let second = world.data.continue_session(&session("conv_a.1")).unwrap();

    for (segment, lines) in [(1, FIRST_SEGMENT.as_slice()), (2, &[CONTINUED])] {
        let log = world.log_of(&conversation, segment);
        let path = world.path_of(log.session_id());

        std::fs::write(&path, lines.join("\n") + "\n").unwrap();

        let replay = log.read().unwrap();
        let encoded: Vec<String> = replay.records().iter().map(LogRecord::to_line).collect();

        assert_eq!(encoded, lines_of(&path));
    }

    assert_eq!(second.session_id(), &session("conv_a.2"));
}

#[test]
fn a_record_that_breaks_a_rule_is_refused_as_damage_on_its_own_line() {
    let world = World::new();
    let conversation = world.conversation_named("conv_a");
    let log = world.log_of(&conversation, 1);
    let path = world.path_of(log.session_id());

    for (rule, says, lines) in broken_logs() {
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();

        match log.read().map(|replay| replay.records().len()) {
            Err(
                error @ (StorageError::MalformedRecord { line, .. }
                | StorageError::BrokenLog { line, .. }),
            ) => {
                assert_eq!(line, lines.len(), "{rule}");
                assert_eq!(error.code(), "malformed_record", "{rule}");
                assert!(
                    chain_of(&error).contains(says),
                    "{rule}: {}",
                    chain_of(&error)
                );
            }
            other => panic!("{rule}: {other:?}"),
        }
    }

    let continued = world.log_of(&conversation, 2);

    world.data.continue_session(&session("conv_a.1")).unwrap();
    std::fs::write(
        world.path_of(continued.session_id()),
        [
            CONTINUED,
            &replace(
                &replace(
                    &replace(TEA_RECEIVED, "evt_1", "evt_5"),
                    "trace_1",
                    "trace_5",
                ),
                "09:00:00",
                "09:06:00",
            ),
        ]
        .join("\n")
            + "\n",
    )
    .unwrap();
    assert!(
        matches!(
            continued.read(),
            Err(StorageError::BrokenLog { line: 2, ref source, .. })
                if source.to_string().contains("under the continuation's identity")
        ),
        "a turn under the continuation's identity"
    );

    std::fs::write(&path, b"{\"eventId\":\"\xff\"}\n").unwrap();
    assert!(
        matches!(
            log.read(),
            Err(StorageError::MalformedRecord { line: 1, .. })
        ),
        "a line that is not UTF-8"
    );
}

/// Each a log whose last line breaks one rule a record keeps, alone or
/// given the records before it: the rule, what its refusal says, the log.
fn broken_logs() -> Vec<(&'static str, &'static str, Vec<String>)> {
    let start = [TEA_RECEIVED, TEA_NORMALIZED];
    let asked = [TEA_RECEIVED, TEA_NORMALIZED, TEA_ASKED];
    let called = [
        TEA_RECEIVED,
        TEA_NORMALIZED,
        TEA_ASKED,
        TEA_ROUND_1,
        TEA_CALLED,
    ];

    vec![
        ("no record", "missing field `traceId`", vec![r#"{"eventId": "evt_torn"}"#.to_owned()]),
        ("not JSON", "not JSON", vec![TEA_RECEIVED[..40].to_owned()]),
        ("an array", "not a JSON object", vec!["[]".to_owned()]),
        ("an unknown kind", "unknown variant `runtime_event_lost`", vec![replace(TEA_RECEIVED, "runtime_event_received", "runtime_event_lost")]),
        ("a field of another kind", "unknown field `round`", vec![replace(TEA_RECEIVED, "}}", r#"},"round":1}"#)]),
        ("a lone surrogate", "not JSON", vec![replace(TEA_RECEIVED, r#"" Tea? ""#, r#""\ud83d""#)]),
        ("a number past a double", "number out of range", vec![replace(TEA_RECEIVED, "}}", r#"},"round":1e400}"#)]),
        ("equal event and trace ids", "apart from its trace id", vec![replace(TEA_RECEIVED, "trace_1", "evt_1")]),
        ("a time that is no moment", "not a canonical UTC timestamp", vec![replace(TEA_RECEIVED, "09:00:00.000Z", "24:00:00.000Z")]),
        ("a turn that never started", "no runtime_event_received", vec![TEA_NORMALIZED.to_owned()]),
        ("a turn started twice", "starts a second time", vec![TEA_RECEIVED.to_owned(), TEA_RECEIVED.to_owned()]),
        ("one event at two times", "disagree on when it was created", strings(&start).into_iter().chain([replace(TEA_ASKED, "09:00:00.000Z", "09:00:00.001Z")]).collect()),
        ("a record after the turn ended", "after the record that ended it", strings(&[SPLIT_RECEIVED, SPLIT_REFUSED, SPLIT_REFUSED])),
        ("two turns at once", "not the open turn", strings(&[TEA_RECEIVED, SPLIT_RECEIVED, TEA_ASKED])),
        ("a round before the line", "after the turn committed the person's line", strings(&start).into_iter().chain([TEA_ROUND_1.to_owned()]).collect()),
        ("a reply before the line", "exactly one message of the person's", strings(&start).into_iter().chain([TEA_REPLIED.to_owned()]).collect()),
        ("a second line", "exactly one message of the person's", strings(&[TEA_RECEIVED, TEA_ASKED, &TEA_ASKED.replace("message-1", "message-2")])),
        ("a line other than the model was given", "the line its event was taken as", strings(&start).into_iter().chain([replace(TEA_ASKED, "Tea?", "Coffee?")]).collect()),
        ("a message under another name", "not under its speaker's id and name", strings(&start).into_iter().chain([replace(TEA_ASKED, r#""speakerName":"Sam""#, r#""speakerName":"Samuel""#)]).collect()),
        ("a message number that does not climb", "does not climb", strings(&[TEA_RECEIVED, TEA_ASKED, &second(TEA_RECEIVED), &second(TEA_ASKED)])),
        ("a line committed from an event refused as one", "the line its event was taken as", strings(&[SPLIT_RECEIVED, &second(TEA_ASKED)])),
        ("a round before its round's calls", "before taking up all it gave", strings(&asked).into_iter().chain([TEA_ROUND_1.to_owned(), TEA_ROUND_2.to_owned()]).collect()),
        ("a round while a call is unfinished", "before taking up all it gave", strings(&called).into_iter().chain([TEA_ROUND_2.to_owned()]).collect()),
        ("a round out of sequence", "out of sequence", strings(&asked).into_iter().chain([replace(TEA_ROUND_1, r#""round":1"#, r#""round":2"#)]).collect()),
        ("a decision the output does not read as", "does not read as", strings(&asked).into_iter().chain([replace(TEA_ROUND_1, r#""text":"Checking."}}}}"#, r#""text":"Something else."}}}}"#)]).collect()),
        ("a round shown another session", "another session", strings(&asked).into_iter().chain([replace(TEA_ROUND_1, r#""sessionId":"conv_a.1""#, r#""sessionId":"conv_b.1""#)]).collect()),
        ("a round shown another character", "another character", strings(&asked).into_iter().chain([replace(TEA_ROUND_1, r#""displayName":"Mira""#, r#""displayName":"Zeta""#)]).collect()),
        ("a call of a round never run", "which the turn never ran", strings(&asked).into_iter().chain([TEA_CALLED.to_owned()]).collect()),
        ("a call of a refused round", "not the next call an accepted round", strings(&[FAILED_RECEIVED, FAILED_ASKED, FAILED_ROUND, &replace(&replace(&replace(TEA_CALLED, "evt_1", "evt_3"), "trace_1", "trace_3"), "09:00:00", "09:02:00")])),
        ("a call its round never asked", "not the next call an accepted round", strings(&asked).into_iter().chain([TEA_ROUND_1.to_owned(), replace(TEA_CALLED, r#"{"mood":"warm"}"#, r#"{"mood":"cold"}"#)]).collect()),
        ("an undeclared call answered", "never an answer", strings(&called).into_iter().chain([replace(TEA_ANSWERED, r#""dispatchedToHost":true"#, r#""dispatchedToHost":false"#)]).collect()),
        ("a call that finished before it started", "never started", strings(&[TEA_RECEIVED, TEA_ASKED, TEA_ROUND_1, TEA_ANSWERED])),
        ("a call that finished as another", "as another call", strings(&called).into_iter().chain([replace(TEA_ANSWERED, r#""toolName":"character_state.patch","toolPluginId":"character-state","dispatched"#, r#""toolName":"character_state.reset","toolPluginId":"character-state","dispatched"#)]).collect()),
        ("a round that kept a credential it wrote", "every credential-named value redacted", strings(&asked).into_iter().chain([replace(&replace(TEA_ROUND_1, r#"{\"mood\":\"warm\"}"#, r#"{\"api_key\":\"sk-live\"}"#), r#"{"mood":"warm"}"#, r#"{"api_key":"[redacted]"}"#)]).collect()),
        ("a call that kept a credential", "credentials redacted", strings(&asked).into_iter().chain([replace(&replace(TEA_ROUND_1, r#"{\"mood\":\"warm\"}"#, r#"{\"api_key\":\"[redacted]\"}"#), r#"{"mood":"warm"}"#, r#"{"api_key":"[redacted]"}"#), replace(TEA_CALLED, r#"{"mood":"warm"}"#, r#"{"api_key":"sk-live"}"#)]).collect()),
        ("evidence of another event", "evidence of another event", strings(&called).into_iter().chain([replace(TEA_ANSWERED, r#""createdAt":"2026-10-21T09:00:00.000Z","pluginId""#, r#""createdAt":"2026-10-21T09:00:01.000Z","pluginId""#)]).collect()),
        ("a reply its round never said", "not the next reply", strings(&[TEA_RECEIVED, TEA_ASKED, TEA_ROUND_1, TEA_CALLED, TEA_ANSWERED, TEA_ROUND_2, &replace(TEA_REPLIED, "Tea, always.", "Coffee.")])),
        ("a reply of a refused round", "not said by an accepted round", strings(&[FAILED_RECEIVED, FAILED_ASKED, FAILED_ROUND, &replace(&replace(&replace(&replace(TEA_REPLIED, "evt_1", "evt_3"), "trace_1", "trace_3"), "09:00:00", "09:02:00"), r#""round":2"#, r#""round":1"#)])),
        ("a turn completed with a call unfinished", "unfinished", strings(&called).into_iter().chain([replace(replace(TEA_COMPLETED, r#","round":2,"commitValidation":{"result":{"status":"accepted","acceptedVisibleReplyText":"Tea, always."}}"#, r#","round":1,"commitValidation":{"result":{"status":"accepted"}}"#).as_str(), r#"["conv_a.1:message-1","conv_a.1:message-2"]"#, r#"["conv_a.1:message-1"]"#)]).collect()),
        ("a terminal naming other messages", "other messages", strings(&FIRST_SEGMENT[..8]).into_iter().chain([replace(TEA_COMPLETED, r#""conv_a.1:message-1","#, "")]).collect()),
        ("a terminal judging an earlier round", "not the round the turn ended on", strings(&FIRST_SEGMENT[..8]).into_iter().chain([replace(TEA_COMPLETED, r#""round":2"#, r#""round":1"#)]).collect()),
        ("a terminal anchoring a reply never said", "anchors the last reply", strings(&FIRST_SEGMENT[..8]).into_iter().chain([replace(TEA_COMPLETED, r#""acceptedVisibleReplyText":"Tea, always.""#, r#""acceptedVisibleReplyText":"Coffee.""#)]).collect()),
        ("a turn completed short of its replies", "goes on past round 2 before taking up all it gave", strings(&FIRST_SEGMENT[..7]).into_iter().chain([replace(TEA_COMPLETED, r#"["conv_a.1:message-1","conv_a.1:message-2"]"#, r#"["conv_a.1:message-1"]"#)]).collect()),
        ("a completed turn that judges nothing", "judges the round it ended on", strings(&FIRST_SEGMENT[..8]).into_iter().chain([replace(TEA_COMPLETED, r#","round":2,"commitValidation":{"result":{"status":"accepted","acceptedVisibleReplyText":"Tea, always."}}"#, "")]).collect()),
        ("a model refusal that judges no round", "names the round it judged", strings(&FIRST_SEGMENT[12..15]).into_iter().chain([replace(FAILED_REJECTED, r#","round":1"#, "")]).collect()),
        ("a refusal other than its round's", "repeats the refusal", strings(&FIRST_SEGMENT[12..15]).into_iter().chain([replace(FAILED_REJECTED, r#""message":"The provider answered 503.""#, r#""message":"The provider answered 502.""#)]).collect()),
        ("a line refused once it was committed", "only before it goes further", strings(&asked).into_iter().chain([replace(&replace(&replace(&replace(SPLIT_REFUSED, "evt_2", "evt_1"), "trace_2", "trace_1"), "09:01:00", "09:00:00"), r#"line."}"#, r#"line.","visibleMessageIds":["conv_a.1:message-1"]}"#)]).collect()),
        ("a plugin's refusal after a round", "only before it goes further", strings(&asked).into_iter().chain([TEA_ROUND_1.to_owned(), replace(&replace(&replace(&replace(&replace(SPLIT_REFUSED, "evt_2", "evt_1"), "trace_2", "trace_1"), "09:01:00", "09:00:00"), "input_validation_rejected", "plugin_before_role_model_call_rejected"), r#"line."}"#, r#"line.","visibleMessageIds":["conv_a.1:message-1"]}"#)]).collect()),
        ("after_turn_committed before the turn completed", "follows the record that completed", strings(&asked).into_iter().chain([TEA_AFTER.to_owned()]).collect()),
        ("a continuation not first", "before any other", strings(&[END_RECEIVED, END_COMPLETED, CONTINUED])),
        ("a continuation of another session", "not its own", vec![CONTINUED.to_owned()]),
    ]
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

fn strings(lines: &[&str]) -> Vec<String> {
    lines.iter().map(|line| (*line).to_owned()).collect()
}

/// An error and its causes, as a report spells them.
fn chain_of(error: &dyn std::error::Error) -> String {
    let mut chain = error.to_string();
    let mut source = error.source();

    while let Some(cause) = source {
        chain.push_str(": ");
        chain.push_str(&cause.to_string());
        source = cause.source();
    }

    chain
}
