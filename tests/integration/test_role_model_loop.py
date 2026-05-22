import json
import sys
import unittest
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from commit_effects.visible_reply import (  # noqa: E402
    build_user_visible_message,
    build_visible_conversation_output,
)
from role_model.loop import (  # noqa: E402
    RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES,
    RoleModelValidationError,
    VisibleConversationRecentMessagesSource,
    build_decision_context,
    render_role_model_input,
    run_role_model_turn,
)


def fixed_clock():
    return datetime(2026, 5, 14, 11, 31, 0, tzinfo=UTC)


def prior_assistant_clock():
    return datetime(2026, 5, 14, 11, 22, 0, tzinfo=UTC)


class SequenceIdGenerator:
    def __init__(self):
        self.calls = []

    def __call__(self, kind):
        self.calls.append(kind)
        return f"{kind}-generated-{len(self.calls)}"


class UserMessageType(str):
    pass


class RecordingRawEventLog:
    def __init__(self):
        self.entries = []

    def append(self, entry):
        self.entries.append(entry)


def assert_context_build_failure_log(test_case, raw_log, *, message_fragment):
    test_case.assertEqual(len(raw_log.entries), 1)
    entry = raw_log.entries[0]
    test_case.assertEqual(entry["kind"], "role_model_turn_failed")
    test_case.assertEqual(entry["trace_id"], "trace-1")
    test_case.assertEqual(entry["event_id"], "event-1")
    test_case.assertEqual(entry["data"]["event"]["event_id"], "event-1")
    test_case.assertNotIn("model_input", entry["data"])
    test_case.assertEqual(entry["data"]["failure"]["stage"], "context_build")
    test_case.assertEqual(entry["data"]["failure"]["code"], "malformed_context")
    test_case.assertIn(message_fragment, entry["data"]["failure"]["message"])


class FakeRoleModelAdapter:
    def __init__(self, raw_text):
        self.raw_text = raw_text
        self.inputs = []

    def generate(self, model_input):
        self.inputs.append(model_input)
        return {
            "model_id": "fake-role-model",
            "created_at": "2026-05-14T11:31:00+00:00",
            "raw_text": self.raw_text,
        }


class FailingRoleModelAdapter:
    def __init__(self):
        self.inputs = []

    def generate(self, model_input):
        self.inputs.append(model_input)
        raise RuntimeError("adapter failed")


class BadShapeRoleModelAdapter:
    def __init__(self):
        self.inputs = []

    def generate(self, model_input):
        self.inputs.append(model_input)
        return {
            "model_id": "fake-role-model",
            "created_at": "2026-05-14T11:31:00+00:00",
        }


class MutatingRoleModelAdapter:
    def __init__(self):
        self.inputs = []

    def generate(self, model_input):
        self.inputs.append(model_input)
        model_input["event"]["text"] = "mutated by adapter"
        return {
            "model_id": "fake-role-model",
            "created_at": "2026-05-14T11:31:00+00:00",
            "raw_text": json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "reply after mutation"},
                }
            ),
        }


def normalized_user_message():
    return {
        "event_id": "event-1",
        "trace_id": "trace-1",
        "type": "USER_MESSAGE",
        "created_at": "2026-05-14T11:30:00+00:00",
        "schema_version": "0.1",
        "payload": {"text": "hello"},
    }


def normalized_user_message_with_conversation():
    event = normalized_user_message()
    event["payload"]["conversation_id"] = "conversation-1"
    return event


def normalized_user_message_with_tracked_type():
    event = normalized_user_message()
    event["type"] = UserMessageType("USER_MESSAGE")
    return event


def prior_visible_source_event(
    *,
    event_id,
    trace_id,
    created_at,
    text,
):
    event = normalized_user_message_with_conversation()
    event["event_id"] = event_id
    event["trace_id"] = trace_id
    event["created_at"] = created_at
    event["payload"]["text"] = text
    return event


def role_model_result_for_event(event, *, reply_text):
    return {
        "trace_id": event["trace_id"],
        "event_id": event["event_id"],
        "event_type": "USER_MESSAGE",
        "model_called": True,
        "status": "decision_ready_for_commit",
        "decision": {
            "schema_version": "0.1",
            "trace_id": event["trace_id"],
            "event_id": event["event_id"],
            "action": "visible_reply",
            "visible_reply": {"text": reply_text},
        },
    }


def recent_message(message_id, *, created_at, text="previous reply"):
    return {
        "schema_version": "0.1",
        "message_id": message_id,
        "trace_id": f"trace-{message_id}",
        "source_event_id": f"event-{message_id}",
        "conversation_id": "conversation-1",
        "role": "assistant",
        "created_at": created_at,
        "text": text,
    }


class FakeRecentMessagesSource:
    def __init__(self, messages):
        self.messages = messages
        self.requests = []

    def read_recent_visible_messages(self, request):
        self.requests.append(request)
        return self.messages


def current_state_snapshot():
    return {
        "schema_version": "0.1",
        "character_id": "character-1",
        "living_state": {
            "current_activity": "writing notes",
            "mood": "focused",
            "toward_user": "warm",
        },
        "updated_at": "2026-05-14T11:29:00+00:00",
        "source_event_ids": ["event-state-1"],
    }


def living_state_brief():
    return {
        "character_id": "character-1",
        "current_activity": "writing notes",
        "mood": "focused",
        "toward_user": "warm",
        "updated_at": "2026-05-14T11:29:00+00:00",
        "source_event_ids": ["event-state-1"],
    }


class FakeCurrentStateSource:
    def __init__(self, snapshot):
        self.snapshot = snapshot
        self.requests = []

    def read_current_state(self, request):
        self.requests.append(request)
        return self.snapshot


class FakeVisibleConversationRecordSource:
    def __init__(self, records):
        self.records = records
        self.requests = []

    def read_visible_conversation_records(self, request):
        self.requests.append(request)
        return self.records


def user_visible_record(message_id, *, created_at, text="previous user message"):
    return {
        "schema_version": "0.1",
        "message_id": message_id,
        "trace_id": f"trace-{message_id}",
        "source_event_id": f"event-{message_id}",
        "kind": "user_visible_message",
        "role": "user",
        "conversation_id": "conversation-1",
        "created_at": created_at,
        "text": text,
        "source": {"runtime_event_type": "USER_MESSAGE"},
    }


def assistant_visible_record(output_id, *, created_at, text="previous assistant reply"):
    return {
        "schema_version": "0.1",
        "output_id": output_id,
        "trace_id": f"trace-{output_id}",
        "source_event_id": f"event-{output_id}",
        "kind": "assistant_visible_reply",
        "conversation_id": "conversation-1",
        "created_at": created_at,
        "text": text,
        "source": {
            "decision_action": "visible_reply",
            "role_model_status": "decision_ready_for_commit",
        },
    }


class RoleModelLoopIntegrationTests(unittest.TestCase):
    def test_normalized_event_calls_fake_adapter_and_appends_success_log(self):
        raw_log = RecordingRawEventLog()
        ids = SequenceIdGenerator()
        adapter = FakeRoleModelAdapter(
            json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                }
            )
        )

        result = run_role_model_turn(
            normalized_user_message(),
            adapter=adapter,
            raw_event_log=raw_log,
            id_generator=ids,
            clock=fixed_clock,
        )

        event = normalized_user_message()
        expected_input = render_role_model_input(event, build_decision_context(event))
        self.assertEqual(adapter.inputs, [expected_input])
        self.assertEqual(
            result,
            {
                "trace_id": "trace-1",
                "event_id": "event-1",
                "event_type": "USER_MESSAGE",
                "model_called": True,
                "status": "decision_ready_for_commit",
                "decision": {
                    "schema_version": "0.1",
                    "trace_id": "trace-1",
                    "event_id": "event-1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                },
            },
        )
        self.assertEqual(ids.calls, ["log"])
        self.assertEqual(len(raw_log.entries), 1)
        self.assertEqual(raw_log.entries[0]["log_id"], "log-generated-1")
        self.assertEqual(raw_log.entries[0]["kind"], "role_model_turn_completed")
        self.assertEqual(raw_log.entries[0]["created_at"], "2026-05-14T11:31:00+00:00")
        self.assertEqual(raw_log.entries[0]["data"]["model_input"], expected_input)
        self.assertEqual(raw_log.entries[0]["data"]["decision"], result["decision"])

    def test_recent_messages_flow_to_adapter_and_success_log(self):
        raw_log = RecordingRawEventLog()
        source = FakeRecentMessagesSource(
            [
                recent_message("message-2", created_at="2026-05-14T11:22:00+00:00"),
                recent_message("message-1", created_at="2026-05-14T11:21:00+00:00", text="earlier"),
            ]
        )
        adapter = FakeRoleModelAdapter(
            json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                }
            )
        )

        run_role_model_turn(
            normalized_user_message_with_conversation(),
            adapter=adapter,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            recent_visible_messages_source=source,
        )

        recent_messages = adapter.inputs[0]["decision_context"]["character_snapshot"][
            "recent_visible_messages"
        ]
        self.assertEqual(
            [message["message_id"] for message in recent_messages], ["message-1", "message-2"]
        )
        self.assertEqual(
            raw_log.entries[0]["data"]["model_input"]["decision_context"]["character_snapshot"][
                "recent_visible_messages"
            ],
            recent_messages,
        )

    def test_current_state_flows_to_adapter_and_success_log(self):
        raw_log = RecordingRawEventLog()
        recent_source = FakeRecentMessagesSource(
            [
                recent_message("message-1", created_at="2026-05-14T11:21:00+00:00"),
            ]
        )
        current_state_source = FakeCurrentStateSource(current_state_snapshot())
        adapter = FakeRoleModelAdapter(
            json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                }
            )
        )

        run_role_model_turn(
            normalized_user_message_with_conversation(),
            adapter=adapter,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            recent_visible_messages_source=recent_source,
            current_state_source=current_state_source,
        )

        self.assertEqual(
            current_state_source.requests,
            [
                {
                    "schema_version": "0.1",
                    "trace_id": "trace-1",
                    "event_id": "event-1",
                    "event_type": "USER_MESSAGE",
                    "conversation_id": "conversation-1",
                }
            ],
        )
        self.assertNotIn("character_id", current_state_source.requests[0])
        character_snapshot = adapter.inputs[0]["decision_context"]["character_snapshot"]
        self.assertEqual(
            [message["message_id"] for message in character_snapshot["recent_visible_messages"]],
            ["message-1"],
        )
        self.assertEqual(character_snapshot["living_state_brief"], living_state_brief())
        self.assertEqual(
            raw_log.entries[0]["data"]["model_input"]["decision_context"]["character_snapshot"][
                "living_state_brief"
            ],
            living_state_brief(),
        )

    def test_state_patch_opt_in_flows_to_adapter_result_and_success_log(self):
        raw_log = RecordingRawEventLog()
        current_state_source = FakeCurrentStateSource(current_state_snapshot())
        adapter = FakeRoleModelAdapter(
            json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                    "state_patch": {
                        "living_state": {
                            "current_activity": "answering the user",
                            "mood": "attentive",
                        }
                    },
                }
            )
        )

        result = run_role_model_turn(
            normalized_user_message_with_conversation(),
            adapter=adapter,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            current_state_source=current_state_source,
            allow_state_patch=True,
        )

        self.assertEqual(
            adapter.inputs[0]["allowed_actions"],
            ["visible_reply", "state_patch"],
        )
        self.assertEqual(
            result["decision"]["state_patch"],
            {
                "living_state": {
                    "current_activity": "answering the user",
                    "mood": "attentive",
                }
            },
        )
        self.assertEqual(
            raw_log.entries[0]["data"]["decision"]["state_patch"],
            result["decision"]["state_patch"],
        )

    def test_commit_effects_visible_records_flow_to_context_and_success_log(self):
        raw_log = RecordingRawEventLog()
        user_event = prior_visible_source_event(
            event_id="event-user-1",
            trace_id="trace-user-1",
            created_at="2026-05-14T11:21:00+00:00",
            text="earlier user message",
        )
        assistant_event = prior_visible_source_event(
            event_id="event-assistant-1",
            trace_id="trace-assistant-1",
            created_at="2026-05-14T11:21:30+00:00",
            text="earlier assistant prompt",
        )
        record_source = FakeVisibleConversationRecordSource(
            [
                build_visible_conversation_output(
                    assistant_event,
                    role_model_result_for_event(
                        assistant_event,
                        reply_text="previous assistant reply",
                    ),
                    id_generator=SequenceIdGenerator(),
                    clock=prior_assistant_clock,
                ),
                build_user_visible_message(
                    user_event,
                    id_generator=SequenceIdGenerator(),
                ),
            ]
        )
        recent_source = VisibleConversationRecentMessagesSource(record_source)
        adapter = FakeRoleModelAdapter(
            json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                }
            )
        )

        run_role_model_turn(
            normalized_user_message_with_conversation(),
            adapter=adapter,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            recent_visible_messages_source=recent_source,
        )

        recent_messages = adapter.inputs[0]["decision_context"]["character_snapshot"][
            "recent_visible_messages"
        ]
        self.assertEqual(
            recent_messages,
            [
                {
                    "schema_version": "0.1",
                    "message_id": "message-generated-1",
                    "trace_id": "trace-user-1",
                    "source_event_id": "event-user-1",
                    "conversation_id": "conversation-1",
                    "role": "user",
                    "created_at": "2026-05-14T11:21:00+00:00",
                    "text": "earlier user message",
                },
                {
                    "schema_version": "0.1",
                    "message_id": "output-generated-1",
                    "trace_id": "trace-assistant-1",
                    "source_event_id": "event-assistant-1",
                    "conversation_id": "conversation-1",
                    "role": "assistant",
                    "created_at": "2026-05-14T11:22:00+00:00",
                    "text": "previous assistant reply",
                },
            ],
        )
        self.assertEqual(
            raw_log.entries[0]["data"]["model_input"]["decision_context"]["character_snapshot"][
                "recent_visible_messages"
            ],
            recent_messages,
        )

    def test_visible_conversation_records_flow_to_context_and_success_log(self):
        raw_log = RecordingRawEventLog()
        record_source = FakeVisibleConversationRecordSource(
            [
                assistant_visible_record("output-2", created_at="2026-05-14T11:22:00+00:00"),
                user_visible_record(
                    "message-1",
                    created_at="2026-05-14T11:21:00+00:00",
                    text="earlier user message",
                ),
            ]
        )
        recent_source = VisibleConversationRecentMessagesSource(record_source)
        adapter = FakeRoleModelAdapter(
            json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                }
            )
        )

        run_role_model_turn(
            normalized_user_message_with_conversation(),
            adapter=adapter,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            recent_visible_messages_source=recent_source,
        )

        recent_messages = adapter.inputs[0]["decision_context"]["character_snapshot"][
            "recent_visible_messages"
        ]
        self.assertEqual(
            record_source.requests,
            [
                {
                    "schema_version": "0.1",
                    "conversation_id": "conversation-1",
                    "before_event_id": "event-1",
                    "before_created_at": "2026-05-14T11:30:00+00:00",
                    "max_candidate_records": RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES,
                }
            ],
        )
        self.assertEqual(
            recent_messages,
            [
                {
                    "schema_version": "0.1",
                    "message_id": "message-1",
                    "trace_id": "trace-message-1",
                    "source_event_id": "event-message-1",
                    "conversation_id": "conversation-1",
                    "role": "user",
                    "created_at": "2026-05-14T11:21:00+00:00",
                    "text": "earlier user message",
                },
                {
                    "schema_version": "0.1",
                    "message_id": "output-2",
                    "trace_id": "trace-output-2",
                    "source_event_id": "event-output-2",
                    "conversation_id": "conversation-1",
                    "role": "assistant",
                    "created_at": "2026-05-14T11:22:00+00:00",
                    "text": "previous assistant reply",
                },
            ],
        )
        self.assertEqual(
            raw_log.entries[0]["data"]["model_input"]["decision_context"]["character_snapshot"][
                "recent_visible_messages"
            ],
            recent_messages,
        )

    def test_malformed_recent_messages_fail_before_adapter_invocation(self):
        raw_log = RecordingRawEventLog()
        adapter = BadShapeRoleModelAdapter()
        source = FakeRecentMessagesSource(
            [
                {
                    **recent_message("message-1", created_at="2026-05-14T11:21:00+00:00"),
                    "role": "system",
                }
            ]
        )

        with self.assertRaisesRegex(RoleModelValidationError, "role"):
            run_role_model_turn(
                normalized_user_message_with_conversation(),
                adapter=adapter,
                raw_event_log=raw_log,
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
                recent_visible_messages_source=source,
            )

        self.assertEqual(adapter.inputs, [])
        assert_context_build_failure_log(self, raw_log, message_fragment="role")

    def test_malformed_current_state_fails_before_adapter_invocation(self):
        cases = [
            ({**current_state_snapshot(), "source_event_ids": [123]}, "source_event_ids"),
            ({**current_state_snapshot(), "source_event_ids": ["event-1"]}, "current event_id"),
        ]

        for snapshot, error_pattern in cases:
            with self.subTest(error_pattern=error_pattern):
                raw_log = RecordingRawEventLog()
                adapter = BadShapeRoleModelAdapter()
                current_state_source = FakeCurrentStateSource(snapshot)

                with self.assertRaisesRegex(RoleModelValidationError, error_pattern):
                    run_role_model_turn(
                        normalized_user_message_with_conversation(),
                        adapter=adapter,
                        raw_event_log=raw_log,
                        id_generator=SequenceIdGenerator(),
                        clock=fixed_clock,
                        current_state_source=current_state_source,
                    )

                self.assertEqual(adapter.inputs, [])
                assert_context_build_failure_log(
                    self,
                    raw_log,
                    message_fragment=error_pattern,
                )

    def test_future_recent_messages_fail_before_adapter_invocation(self):
        raw_log = RecordingRawEventLog()
        adapter = BadShapeRoleModelAdapter()
        source = FakeRecentMessagesSource(
            [recent_message("message-1", created_at="2026-05-14T11:30:00+00:00")]
        )

        with self.assertRaisesRegex(RoleModelValidationError, "before event.created_at"):
            run_role_model_turn(
                normalized_user_message_with_conversation(),
                adapter=adapter,
                raw_event_log=raw_log,
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
                recent_visible_messages_source=source,
            )

        self.assertEqual(adapter.inputs, [])
        assert_context_build_failure_log(
            self,
            raw_log,
            message_fragment="before event.created_at",
        )

    def test_duplicate_recent_message_identities_fail_before_adapter_invocation(self):
        raw_log = RecordingRawEventLog()
        adapter = BadShapeRoleModelAdapter()
        source = FakeRecentMessagesSource(
            [
                recent_message("message-1", created_at="2026-05-14T11:21:00+00:00"),
                recent_message("message-1", created_at="2026-05-14T11:22:00+00:00"),
            ]
        )

        with self.assertRaisesRegex(RoleModelValidationError, "message_id"):
            run_role_model_turn(
                normalized_user_message_with_conversation(),
                adapter=adapter,
                raw_event_log=raw_log,
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
                recent_visible_messages_source=source,
            )

        self.assertEqual(adapter.inputs, [])
        assert_context_build_failure_log(self, raw_log, message_fragment="message_id")

    def test_result_event_type_is_derived_from_normalized_event(self):
        raw_log = RecordingRawEventLog()
        event = normalized_user_message_with_tracked_type()
        adapter = FakeRoleModelAdapter(
            json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                }
            )
        )

        result = run_role_model_turn(
            event,
            adapter=adapter,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertIs(result["event_type"], event["type"])

    def test_mutating_returned_decision_does_not_change_raw_log(self):
        raw_log = RecordingRawEventLog()
        adapter = FakeRoleModelAdapter(
            json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                }
            )
        )

        result = run_role_model_turn(
            normalized_user_message(),
            adapter=adapter,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        result["decision"]["visible_reply"]["text"] = "mutated after return"

        self.assertEqual(
            raw_log.entries[0]["data"]["decision"]["visible_reply"]["text"],
            "hello back",
        )

    def test_adapter_mutation_does_not_change_logged_model_input_snapshot(self):
        raw_log = RecordingRawEventLog()
        adapter = MutatingRoleModelAdapter()

        run_role_model_turn(
            normalized_user_message(),
            adapter=adapter,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(
            adapter.inputs[0]["event"]["text"],
            "mutated by adapter",
        )
        self.assertEqual(
            raw_log.entries[0]["data"]["model_input"]["event"]["text"],
            "hello",
        )

    def test_malformed_adapter_output_appends_failure_log_only(self):
        raw_log = RecordingRawEventLog()
        ids = SequenceIdGenerator()
        adapter = FakeRoleModelAdapter(
            json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": ""},
                }
            )
        )

        with self.assertRaises(RoleModelValidationError):
            run_role_model_turn(
                normalized_user_message(),
                adapter=adapter,
                raw_event_log=raw_log,
                id_generator=ids,
                clock=fixed_clock,
            )

        self.assertEqual(ids.calls, ["log"])
        self.assertEqual(len(raw_log.entries), 1)
        self.assertEqual(raw_log.entries[0]["kind"], "role_model_turn_failed")
        self.assertEqual(raw_log.entries[0]["data"]["failure"]["stage"], "parse_output")
        self.assertEqual(raw_log.entries[0]["data"]["failure"]["code"], "malformed_model_output")
        self.assertIn("model_output", raw_log.entries[0]["data"])

    def test_bad_adapter_output_shape_still_appends_failure_log(self):
        raw_log = RecordingRawEventLog()

        with self.assertRaisesRegex(RoleModelValidationError, "raw_text"):
            run_role_model_turn(
                normalized_user_message(),
                adapter=BadShapeRoleModelAdapter(),
                raw_event_log=raw_log,
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
            )

        self.assertEqual(len(raw_log.entries), 1)
        self.assertEqual(raw_log.entries[0]["kind"], "role_model_turn_failed")
        self.assertEqual(raw_log.entries[0]["data"]["failure"]["stage"], "parse_output")
        self.assertEqual(
            raw_log.entries[0]["data"]["raw_model_output_snapshot"],
            {
                "model_id": "fake-role-model",
                "created_at": "2026-05-14T11:31:00+00:00",
            },
        )
        self.assertNotIn("model_output", raw_log.entries[0]["data"])

    def test_adapter_exception_appends_failure_log_only(self):
        raw_log = RecordingRawEventLog()
        ids = SequenceIdGenerator()
        adapter = FailingRoleModelAdapter()

        with self.assertRaisesRegex(RuntimeError, "adapter failed"):
            run_role_model_turn(
                normalized_user_message(),
                adapter=adapter,
                raw_event_log=raw_log,
                id_generator=ids,
                clock=fixed_clock,
            )

        event = normalized_user_message()
        expected_input = render_role_model_input(event, build_decision_context(event))
        self.assertEqual(adapter.inputs, [expected_input])
        self.assertEqual(ids.calls, ["log"])
        self.assertEqual(len(raw_log.entries), 1)
        self.assertEqual(raw_log.entries[0]["kind"], "role_model_turn_failed")
        self.assertEqual(raw_log.entries[0]["data"]["failure"]["stage"], "adapter_call")
        self.assertEqual(raw_log.entries[0]["data"]["failure"]["code"], "adapter_exception")
        self.assertNotIn("model_output", raw_log.entries[0]["data"])


if __name__ == "__main__":
    unittest.main()
