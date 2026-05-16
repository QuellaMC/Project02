import sys
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

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
        self.entries.append(entry)


class RecordingVisibleConversation:
    def __init__(self):
        self.records = []

    def append(self, output):
        self.records.append(output)

    def read_visible_conversation_records(self, request):
        return []


class UserTurnStopTests(unittest.TestCase):
    def test_stops_before_model_when_user_visible_message_commit_rejects(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = RecordingVisibleConversation()
        adapter = Mock()
        rejected_result = {
            "trace_id": "trace-1",
            "event_id": "event-1",
            "event_type": "USER_MESSAGE",
            "status": "user_visible_message_rejected",
            "failure": {
                "stage": "user_visible_message_validation",
                "code": "malformed_commit_input",
                "message": "projection rejected",
            },
        }

        with (
            patch(
                "runtime.user_turn.commit_user_visible_message",
                return_value=rejected_result,
            ) as commit_user,
            patch("runtime.user_turn.run_role_model_turn") as role_model_turn,
        ):
            result = run_user_message_turn(
                {
                    "event_id": "event-1",
                    "trace_id": "trace-1",
                    "type": "USER_MESSAGE",
                    "created_at": "2026-05-14T11:30:00+00:00",
                    "payload": {"text": "hello", "conversation_id": "c-1"},
                },
                adapter=adapter,
                raw_event_log=raw_log,
                visible_conversation=visible_conversation,
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
            )

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(result["stopped_at"], "user_visible_message_commit")
        self.assertEqual(result["failure"]["message"], "projection rejected")
        self.assertEqual(result["user_visible_message_result"], rejected_result)
        self.assertNotIn("role_model_result", result)
        self.assertNotIn("visible_reply_result", result)
        self.assertEqual(result["kernel_route"]["next_step"], "user_turn")
        commit_user.assert_called_once()
        role_model_turn.assert_not_called()
        adapter.generate.assert_not_called()

    def test_stops_after_model_when_visible_reply_commit_rejects(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = RecordingVisibleConversation()
        adapter = Mock()
        user_commit_result = {
            "trace_id": "trace-1",
            "event_id": "event-1",
            "event_type": "USER_MESSAGE",
            "status": "user_visible_message_committed",
            "message": {"message_id": "message-1"},
        }
        role_model_result = {
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
        }
        visible_reply_result = {
            "trace_id": "trace-1",
            "event_id": "event-1",
            "event_type": "USER_MESSAGE",
            "status": "visible_reply_rejected",
            "failure": {
                "stage": "commit_validation",
                "code": "malformed_commit_input",
                "message": "reply rejected",
            },
        }

        with (
            patch(
                "runtime.user_turn.commit_user_visible_message",
                return_value=user_commit_result,
            ),
            patch(
                "runtime.user_turn.run_role_model_turn",
                return_value=role_model_result,
            ) as role_model_turn,
            patch(
                "runtime.user_turn.commit_visible_reply",
                return_value=visible_reply_result,
            ) as commit_reply,
        ):
            result = run_user_message_turn(
                {
                    "event_id": "event-1",
                    "trace_id": "trace-1",
                    "type": "USER_MESSAGE",
                    "created_at": "2026-05-14T11:30:00+00:00",
                    "payload": {"text": "hello", "conversation_id": "c-1"},
                },
                adapter=adapter,
                raw_event_log=raw_log,
                visible_conversation=visible_conversation,
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
            )

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(result["stopped_at"], "visible_reply_commit")
        self.assertEqual(result["failure"]["message"], "reply rejected")
        self.assertEqual(result["user_visible_message_result"], user_commit_result)
        self.assertEqual(result["role_model_result"], role_model_result)
        self.assertEqual(result["visible_reply_result"], visible_reply_result)
        role_model_turn.assert_called_once()
        commit_reply.assert_called_once()


if __name__ == "__main__":
    unittest.main()
