import sys
import unittest
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from commit_effects.visible_reply import (  # noqa: E402
    CommitValidationError,
    build_visible_conversation_output,
    build_visible_reply_committed_log_entry,
    build_visible_reply_rejected_log_entry,
)


def fixed_clock():
    return datetime(2026, 5, 15, 12, 0, 0, tzinfo=UTC)


class SequenceIdGenerator:
    def __init__(self):
        self.calls = []

    def __call__(self, kind):
        self.calls.append(kind)
        return f"{kind}-generated-{len(self.calls)}"


def normalized_user_message():
    return {
        "event_id": "event-1",
        "trace_id": "trace-1",
        "type": "USER_MESSAGE",
        "created_at": "2026-05-15T11:59:00+00:00",
        "schema_version": "0.1",
        "payload": {
            "text": "hello",
            "user_id": "user-1",
            "conversation_id": "conversation-1",
        },
    }


def role_model_result():
    return {
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
            "visible_reply": {"text": " hello back "},
        },
    }


class VisibleConversationOutputTests(unittest.TestCase):
    def test_builds_visible_output_from_visible_reply_decision(self):
        ids = SequenceIdGenerator()

        output = build_visible_conversation_output(
            normalized_user_message(),
            role_model_result(),
            id_generator=ids,
            clock=fixed_clock,
        )

        self.assertEqual(ids.calls, ["output"])
        self.assertEqual(
            output,
            {
                "output_id": "output-generated-1",
                "trace_id": "trace-1",
                "source_event_id": "event-1",
                "kind": "assistant_visible_reply",
                "created_at": "2026-05-15T12:00:00+00:00",
                "schema_version": "0.1",
                "text": "hello back",
                "user_id": "user-1",
                "conversation_id": "conversation-1",
                "source": {
                    "decision_action": "visible_reply",
                    "role_model_status": "decision_ready_for_commit",
                },
            },
        )

    def test_omits_absent_optional_conversation_fields(self):
        event = normalized_user_message()
        del event["payload"]["user_id"]
        del event["payload"]["conversation_id"]

        output = build_visible_conversation_output(
            event,
            role_model_result(),
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertNotIn("user_id", output)
        self.assertNotIn("conversation_id", output)

    def test_rejects_invalid_commit_inputs(self):
        cases = []

        unsupported_event = normalized_user_message()
        unsupported_event["type"] = "TIMER"
        cases.append((unsupported_event, role_model_result(), "USER_MESSAGE"))

        unsupported_schema = normalized_user_message()
        unsupported_schema["schema_version"] = "0.2"
        cases.append((unsupported_schema, role_model_result(), "schema_version"))

        malformed_created_at = normalized_user_message()
        malformed_created_at["created_at"] = "2026-05-15"
        cases.append((malformed_created_at, role_model_result(), "created_at"))

        unsupported_status = role_model_result()
        unsupported_status["status"] = "already_committed"
        cases.append((normalized_user_message(), unsupported_status, "decision_ready_for_commit"))

        unsupported_action = role_model_result()
        unsupported_action["decision"]["action"] = "state_patch"
        cases.append((normalized_user_message(), unsupported_action, "visible_reply"))

        empty_reply = role_model_result()
        empty_reply["decision"]["visible_reply"]["text"] = "   "
        cases.append((normalized_user_message(), empty_reply, "visible_reply.text"))

        mismatched_result = role_model_result()
        mismatched_result["event_id"] = "event-2"
        cases.append((normalized_user_message(), mismatched_result, "event_id"))

        mismatched_decision = role_model_result()
        mismatched_decision["decision"]["trace_id"] = "trace-2"
        cases.append((normalized_user_message(), mismatched_decision, "trace_id"))

        for source_event, result, error_pattern in cases:
            with self.subTest(error_pattern=error_pattern):
                with self.assertRaisesRegex(CommitValidationError, error_pattern):
                    build_visible_conversation_output(
                        source_event,
                        result,
                        id_generator=SequenceIdGenerator(),
                        clock=fixed_clock,
                    )


class VisibleReplyLogEntryTests(unittest.TestCase):
    def test_committed_log_entry_deep_copies_snapshots(self):
        event = normalized_user_message()
        result = role_model_result()
        output = build_visible_conversation_output(
            event,
            result,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        entry = build_visible_reply_committed_log_entry(
            event,
            result,
            output,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        event["payload"]["text"] = "mutated event"
        result["decision"]["visible_reply"]["text"] = "mutated decision"
        output["text"] = "mutated output"

        self.assertEqual(entry["kind"], "visible_reply_committed")
        self.assertEqual(entry["data"]["source_event"]["payload"]["text"], "hello")
        self.assertEqual(
            entry["data"]["role_model_result"]["decision"]["visible_reply"]["text"],
            "hello back",
        )
        self.assertEqual(entry["data"]["output"]["text"], "hello back")

    def test_rejected_log_entry_deep_copies_snapshots(self):
        event = normalized_user_message()
        result = role_model_result()
        failure = {
            "stage": "commit_validation",
            "code": "unsupported_action",
            "message": "action must be 'visible_reply'.",
        }

        entry = build_visible_reply_rejected_log_entry(
            event,
            role_model_result_snapshot=result,
            failure=failure,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        result["decision"]["action"] = "mutated"
        failure["message"] = "mutated"

        self.assertEqual(entry["kind"], "visible_reply_rejected")
        self.assertEqual(
            entry["data"]["role_model_result_snapshot"]["decision"]["action"], "visible_reply"
        )
        self.assertEqual(entry["data"]["decision_snapshot"]["action"], "visible_reply")
        self.assertEqual(entry["data"]["failure"]["message"], "action must be 'visible_reply'.")

    def test_rejected_log_entry_rejects_invalid_failure_code(self):
        with self.assertRaisesRegex(CommitValidationError, "failure.code"):
            build_visible_reply_rejected_log_entry(
                normalized_user_message(),
                role_model_result_snapshot=role_model_result(),
                failure={
                    "stage": "commit_validation",
                    "code": "adapter_exception",
                    "message": "wrong boundary",
                },
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
            )


if __name__ == "__main__":
    unittest.main()
