import json
import sys
import unittest
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from role_model.loop import (  # noqa: E402
    RoleModelValidationError,
    build_decision_context,
    render_role_model_input,
    run_role_model_turn,
)


def fixed_clock():
    return datetime(2026, 5, 14, 11, 31, 0, tzinfo=UTC)


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
        model_input["decision_context"]["event"]["text"] = "mutated by adapter"
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

        expected_input = render_role_model_input(build_decision_context(normalized_user_message()))
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
        self.assertEqual(raw_log.entries, [])

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
        self.assertEqual(raw_log.entries, [])

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
            adapter.inputs[0]["decision_context"]["event"]["text"],
            "mutated by adapter",
        )
        self.assertEqual(
            raw_log.entries[0]["data"]["model_input"]["decision_context"]["event"]["text"],
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

        expected_input = render_role_model_input(build_decision_context(normalized_user_message()))
        self.assertEqual(adapter.inputs, [expected_input])
        self.assertEqual(ids.calls, ["log"])
        self.assertEqual(len(raw_log.entries), 1)
        self.assertEqual(raw_log.entries[0]["kind"], "role_model_turn_failed")
        self.assertEqual(raw_log.entries[0]["data"]["failure"]["stage"], "adapter_call")
        self.assertEqual(raw_log.entries[0]["data"]["failure"]["code"], "adapter_exception")
        self.assertNotIn("model_output", raw_log.entries[0]["data"])


if __name__ == "__main__":
    unittest.main()
