import sys
import unittest
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from commit_effects.visible_reply import CommitValidationError, commit_visible_reply  # noqa: E402


def fixed_clock():
    return datetime(2026, 5, 15, 12, 0, 0, tzinfo=UTC)


class SequenceIdGenerator:
    def __init__(self):
        self.calls = []

    def __call__(self, kind):
        self.calls.append(kind)
        return f"{kind}-generated-{len(self.calls)}"


class RecordingAppendLog:
    def __init__(self):
        self.entries = []

    def append(self, entry):
        self.entries.append(entry)


class FailingAppendLog:
    def append(self, entry):
        raise RuntimeError("append failed")


def normalized_user_message():
    return {
        "event_id": "event-1",
        "trace_id": "trace-1",
        "type": "USER_MESSAGE",
        "created_at": "2026-05-15T11:59:00+00:00",
        "schema_version": "0.1",
        "payload": {"text": "hello", "conversation_id": "conversation-1"},
    }


def role_model_result(reply_text="hello back"):
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
            "visible_reply": {"text": reply_text},
        },
    }


class VisibleReplyCommitIntegrationTests(unittest.TestCase):
    def test_valid_decision_appends_visible_output_and_commit_log(self):
        visible_log = RecordingAppendLog()
        raw_log = RecordingAppendLog()
        ids = SequenceIdGenerator()

        result = commit_visible_reply(
            normalized_user_message(),
            role_model_result(),
            visible_conversation_log=visible_log,
            raw_event_log=raw_log,
            id_generator=ids,
            clock=fixed_clock,
        )

        self.assertEqual(ids.calls, ["output", "log"])
        self.assertEqual(len(visible_log.entries), 1)
        self.assertEqual(len(raw_log.entries), 1)
        self.assertEqual(
            result,
            {
                "trace_id": "trace-1",
                "event_id": "event-1",
                "event_type": "USER_MESSAGE",
                "status": "visible_reply_committed",
                "output": visible_log.entries[0],
            },
        )
        self.assertEqual(visible_log.entries[0]["output_id"], "output-generated-1")
        self.assertEqual(visible_log.entries[0]["kind"], "assistant_visible_reply")
        self.assertEqual(visible_log.entries[0]["text"], "hello back")
        self.assertEqual(visible_log.entries[0]["conversation_id"], "conversation-1")
        self.assertEqual(raw_log.entries[0]["log_id"], "log-generated-2")
        self.assertEqual(raw_log.entries[0]["kind"], "visible_reply_committed")
        self.assertEqual(raw_log.entries[0]["data"]["output"], visible_log.entries[0])

    def test_invalid_decision_appends_rejection_log_without_visible_output(self):
        visible_log = RecordingAppendLog()
        raw_log = RecordingAppendLog()
        ids = SequenceIdGenerator()
        invalid_result = role_model_result()
        invalid_result["decision"]["action"] = "state_patch"

        result = commit_visible_reply(
            normalized_user_message(),
            invalid_result,
            visible_conversation_log=visible_log,
            raw_event_log=raw_log,
            id_generator=ids,
            clock=fixed_clock,
        )

        self.assertEqual(ids.calls, ["log"])
        self.assertEqual(visible_log.entries, [])
        self.assertEqual(len(raw_log.entries), 1)
        self.assertEqual(raw_log.entries[0]["kind"], "visible_reply_rejected")
        self.assertEqual(raw_log.entries[0]["data"]["failure"]["stage"], "commit_validation")
        self.assertEqual(raw_log.entries[0]["data"]["failure"]["code"], "unsupported_action")
        self.assertEqual(
            result,
            {
                "trace_id": "trace-1",
                "event_id": "event-1",
                "event_type": "USER_MESSAGE",
                "status": "visible_reply_rejected",
                "failure": raw_log.entries[0]["data"]["failure"],
            },
        )

    def test_raw_log_append_failure_does_not_append_visible_output(self):
        visible_log = RecordingAppendLog()

        with self.assertRaisesRegex(RuntimeError, "append failed"):
            commit_visible_reply(
                normalized_user_message(),
                role_model_result(),
                visible_conversation_log=visible_log,
                raw_event_log=FailingAppendLog(),
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
            )

        self.assertEqual(visible_log.entries, [])

    def test_visible_output_append_failure_keeps_committed_raw_log_for_reconciliation(self):
        raw_log = RecordingAppendLog()

        with self.assertRaisesRegex(RuntimeError, "append failed"):
            commit_visible_reply(
                normalized_user_message(),
                role_model_result(),
                visible_conversation_log=FailingAppendLog(),
                raw_event_log=raw_log,
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
            )

        self.assertEqual(len(raw_log.entries), 1)
        self.assertEqual(raw_log.entries[0]["kind"], "visible_reply_committed")
        self.assertEqual(raw_log.entries[0]["data"]["output"]["text"], "hello back")

    def test_malformed_source_identity_raises_without_rejection_log(self):
        visible_log = RecordingAppendLog()
        raw_log = RecordingAppendLog()
        event = normalized_user_message()
        del event["trace_id"]

        with self.assertRaisesRegex(CommitValidationError, "trace_id"):
            commit_visible_reply(
                event,
                role_model_result(),
                visible_conversation_log=visible_log,
                raw_event_log=raw_log,
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
            )

        self.assertEqual(visible_log.entries, [])
        self.assertEqual(raw_log.entries, [])


if __name__ == "__main__":
    unittest.main()
