import json
import sys
import unittest
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from runtime.kernel import RuntimeKernel, RuntimeValidationError  # noqa: E402
from runtime.user_turn import run_user_message_turn  # noqa: E402


def fixed_clock():
    return datetime(2026, 5, 14, 11, 30, 0, tzinfo=UTC)


class SequenceIdGenerator:
    def __init__(self):
        self.calls = []

    def __call__(self, kind):
        self.calls.append(kind)
        return f"{kind}-generated-{len(self.calls)}"


class RecordingRawEventLog:
    def __init__(self):
        self.entries = []

    def append(self, entry):
        self.entries.append(deepcopy(entry))


class RecordingAdapter:
    def __init__(self, raw_text=None):
        self.calls = []
        self.raw_text = raw_text or json.dumps(
            {
                "schema_version": "0.1",
                "action": "visible_reply",
                "visible_reply": {"text": "hello back"},
            }
        )

    def generate(self, model_input):
        self.calls.append(deepcopy(model_input))
        return {
            "model_id": "fake-role-model",
            "created_at": "2026-05-14T11:30:00+00:00",
            "raw_text": self.raw_text,
        }


class InMemoryVisibleConversation:
    def __init__(self, records=None):
        self.records = deepcopy(records or [])
        self.read_requests = []

    def append(self, output):
        self.records.append(deepcopy(output))

    def read_visible_conversation_records(self, request):
        self.read_requests.append(deepcopy(request))
        records = [
            record
            for record in self.records
            if record.get("conversation_id") == request["conversation_id"]
        ]
        return deepcopy(records[-request["max_candidate_records"] :])


def prior_user_record():
    return {
        "schema_version": "0.1",
        "message_id": "message-prior",
        "trace_id": "trace-prior",
        "source_event_id": "event-prior",
        "kind": "user_visible_message",
        "role": "user",
        "conversation_id": "c-1",
        "created_at": "2026-05-14T11:00:00+00:00",
        "text": "prior hello",
        "source": {"runtime_event_type": "USER_MESSAGE"},
    }


class UserMessageTurnIntegrationTests(unittest.TestCase):
    def test_runs_one_user_turn_with_shared_route_and_committed_visible_records(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        adapter = RecordingAdapter()

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "schema_version": "0.1",
                "payload": {
                    "text": "hello now",
                    "user_id": "u-1",
                    "conversation_id": "c-1",
                },
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], "user_turn_committed")
        self.assertEqual(result["trace_id"], "trace-current")
        self.assertEqual(result["event_id"], "event-current")
        self.assertEqual(
            result["kernel_route"],
            {
                "trace_id": "trace-current",
                "event_id": "event-current",
                "event_type": "USER_MESSAGE",
                "model_needed": True,
                "next_step": "user_turn",
            },
        )
        self.assertEqual(
            [entry["kind"] for entry in raw_log.entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "visible_reply_committed",
            ],
        )
        self.assertEqual(
            [record["kind"] for record in visible_conversation.records],
            [
                "user_visible_message",
                "user_visible_message",
                "assistant_visible_reply",
            ],
        )
        self.assertEqual(visible_conversation.records[1]["text"], "hello now")
        self.assertEqual(visible_conversation.records[2]["text"], "hello back")
        self.assertEqual(
            result["visible_record_ids"],
            {
                "user_message_id": visible_conversation.records[1]["message_id"],
                "assistant_output_id": visible_conversation.records[2]["output_id"],
            },
        )

        recent_messages = adapter.calls[0]["decision_context"]["character_snapshot"][
            "recent_visible_messages"
        ]
        self.assertEqual(
            recent_messages,
            [
                {
                    "schema_version": "0.1",
                    "message_id": "message-prior",
                    "trace_id": "trace-prior",
                    "source_event_id": "event-prior",
                    "conversation_id": "c-1",
                    "role": "user",
                    "created_at": "2026-05-14T11:00:00+00:00",
                    "text": "prior hello",
                }
            ],
        )
        self.assertEqual(len(adapter.calls), 1)
        self.assertEqual(len(visible_conversation.read_requests), 1)

        result["user_visible_message_result"]["message"]["text"] = "mutated"
        result["visible_reply_result"]["output"]["text"] = "mutated"
        self.assertEqual(visible_conversation.records[1]["text"], "hello now")
        self.assertEqual(visible_conversation.records[2]["text"], "hello back")

    def test_kernel_handle_event_and_user_turn_share_intake_route(self):
        kernel_log = RecordingRawEventLog()
        turn_log = RecordingRawEventLog()

        kernel_route = RuntimeKernel(
            kernel_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        ).handle_event(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "payload": {"text": "hello", "conversation_id": "c-1"},
            }
        )
        turn_result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "payload": {"text": "hello", "conversation_id": "c-1"},
            },
            adapter=RecordingAdapter(),
            raw_event_log=turn_log,
            visible_conversation=InMemoryVisibleConversation(),
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(turn_result["kernel_route"], kernel_route)
        self.assertEqual(kernel_log.entries[0]["kind"], "runtime_event_received")
        self.assertEqual(turn_log.entries[0]["kind"], "runtime_event_received")

    def test_malformed_input_stops_before_raw_log_or_visible_appends(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = InMemoryVisibleConversation()

        with self.assertRaises(RuntimeValidationError):
            run_user_message_turn(
                {"type": "TIMER", "payload": {"text": "hello"}},
                adapter=RecordingAdapter(),
                raw_event_log=raw_log,
                visible_conversation=visible_conversation,
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
            )

        self.assertEqual(raw_log.entries, [])
        self.assertEqual(visible_conversation.records, [])

    def test_malformed_model_output_logs_failure_without_assistant_reply(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])

        with self.assertRaisesRegex(ValueError, "raw_text"):
            run_user_message_turn(
                {
                    "event_id": "event-current",
                    "trace_id": "trace-current",
                    "type": "USER_MESSAGE",
                    "created_at": "2026-05-14T11:30:00+00:00",
                    "payload": {"text": "hello now", "conversation_id": "c-1"},
                },
                adapter=RecordingAdapter(raw_text="not json"),
                raw_event_log=raw_log,
                visible_conversation=visible_conversation,
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
            )

        self.assertEqual(
            [entry["kind"] for entry in raw_log.entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_failed",
            ],
        )
        self.assertEqual(
            [record["kind"] for record in visible_conversation.records],
            ["user_visible_message", "user_visible_message"],
        )


if __name__ == "__main__":
    unittest.main()
