import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from runtime.contracts import (  # noqa: E402
    ContractValidationError,
    normalize_visible_reply_decision,
    validate_normalized_user_message_event,
)


def normalized_user_message():
    return {
        "event_id": "event-1",
        "trace_id": "trace-1",
        "type": "USER_MESSAGE",
        "created_at": "2026-05-15T11:59:00+00:00",
        "schema_version": "0.1",
        "payload": {"text": "hello", "conversation_id": "conversation-1"},
    }


class RuntimeContractTests(unittest.TestCase):
    def test_validates_normalized_user_message_event(self):
        event = validate_normalized_user_message_event(normalized_user_message())

        self.assertEqual(event["created_at"], "2026-05-15T11:59:00+00:00")
        self.assertEqual(event["payload"]["conversation_id"], "conversation-1")

    def test_rejects_non_iso8601_user_message_created_at(self):
        event = normalized_user_message()
        event["created_at"] = "2026-05-15"

        with self.assertRaisesRegex(ContractValidationError, "created_at"):
            validate_normalized_user_message_event(event)

    def test_normalizes_visible_reply_decision_with_attached_identity(self):
        decision = normalize_visible_reply_decision(
            {
                "schema_version": "0.1",
                "trace_id": "trace-1",
                "event_id": "event-1",
                "action": "visible_reply",
                "visible_reply": {"text": " hello back "},
            },
            trace_id="trace-1",
            event_id="event-1",
            require_attached_ids=True,
        )

        self.assertEqual(decision["visible_reply"]["text"], "hello back")

    def test_attached_decision_identity_mismatch_uses_identity_error_code(self):
        with self.assertRaises(ContractValidationError) as context:
            normalize_visible_reply_decision(
                {
                    "schema_version": "0.1",
                    "trace_id": "trace-2",
                    "event_id": "event-1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello"},
                },
                trace_id="trace-1",
                event_id="event-1",
                require_attached_ids=True,
            )

        self.assertEqual(context.exception.code, "identity_mismatch")


if __name__ == "__main__":
    unittest.main()
