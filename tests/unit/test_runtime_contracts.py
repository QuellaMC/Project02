import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from runtime.contracts import (  # noqa: E402
    CANCEL_INCIDENT_ACTION,
    DECISION_READY_FOR_COMMIT_STATUS,
    START_INCIDENT_ACTION,
    USER_MESSAGE,
    VISIBLE_REPLY_ACTION,
    ContractValidationError,
    normalize_cancel_incident_life_action,
    normalize_living_state_patch,
    normalize_role_model_turn_result,
    normalize_start_incident_life_action,
    normalize_visible_reply_decision,
    normalize_visible_reply_decision_with_optional_life_action,
    normalize_visible_reply_decision_with_optional_living_state_patch,
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


def role_model_result(decision=None):
    return {
        "trace_id": "trace-1",
        "event_id": "event-1",
        "event_type": USER_MESSAGE,
        "model_called": True,
        "status": DECISION_READY_FOR_COMMIT_STATUS,
        "decision": decision
        or {
            "schema_version": "0.1",
            "trace_id": "trace-1",
            "event_id": "event-1",
            "action": VISIBLE_REPLY_ACTION,
            "visible_reply": {"text": "hello back"},
        },
    }


class RuntimeContractTests(unittest.TestCase):
    def test_validates_normalized_user_message_event(self):
        event = validate_normalized_user_message_event(normalized_user_message())

        self.assertEqual(event["created_at"], "2026-05-15T11:59:00+00:00")
        self.assertEqual(event["payload"]["conversation_id"], "conversation-1")

    def test_rejects_non_iso8601_user_message_created_at(self):
        event = normalized_user_message()
        event["created_at"] = "2026-05-15"

        with self.assertRaisesRegex(ContractValidationError, "created_at") as context:
            validate_normalized_user_message_event(event)

        self.assertEqual(context.exception.code, "invalid_contract")

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

    def test_normalizes_living_state_patch(self):
        patch = normalize_living_state_patch(
            {
                "living_state": {
                    "current_activity": " writing notes ",
                    "mood": " focused ",
                }
            }
        )

        self.assertEqual(
            patch,
            {
                "living_state": {
                    "current_activity": "writing notes",
                    "mood": "focused",
                }
            },
        )

    def test_living_state_patch_rejects_empty_and_future_fields(self):
        cases = [
            ({"living_state": {}}, "at least one"),
            ({"living_state": {"current_activity": "   "}}, "current_activity"),
            ({"living_state": {"body_state": "awake"}}, "body_state"),
            ({"living_state": {"updated_at": "2026-05-17T00:00:00+00:00"}}, "updated_at"),
            ({"body_state": {"fatigue": "low"}}, "body_state"),
        ]

        for patch, error_pattern in cases:
            with self.subTest(error_pattern=error_pattern):
                with self.assertRaisesRegex(ContractValidationError, error_pattern):
                    normalize_living_state_patch(patch)

    def test_living_state_patch_rejects_whitespace_only_values(self):
        cases = [
            ({"living_state": {"mood": " "}}, "mood"),
            ({"living_state": {"current_activity": "\n"}}, "current_activity"),
        ]

        for patch, error_pattern in cases:
            with self.subTest(error_pattern=error_pattern):
                with self.assertRaisesRegex(ContractValidationError, error_pattern):
                    normalize_living_state_patch(patch)

    def test_normalizes_visible_reply_with_optional_living_state_patch(self):
        decision = normalize_visible_reply_decision_with_optional_living_state_patch(
            {
                "schema_version": "0.1",
                "trace_id": "trace-1",
                "event_id": "event-1",
                "action": "visible_reply",
                "visible_reply": {"text": " hello back "},
                "state_patch": {
                    "living_state": {
                        "current_activity": " answering Mike ",
                        "toward_user": " attentive ",
                    }
                },
            },
            trace_id="trace-1",
            event_id="event-1",
            require_attached_ids=True,
            allow_state_patch=True,
        )

        self.assertEqual(decision["visible_reply"]["text"], "hello back")
        self.assertEqual(
            decision["state_patch"],
            {
                "living_state": {
                    "current_activity": "answering Mike",
                    "toward_user": "attentive",
                }
            },
        )

    def test_rejects_optional_state_patch_when_not_allowed(self):
        with self.assertRaisesRegex(ContractValidationError, "state_patch"):
            normalize_visible_reply_decision_with_optional_living_state_patch(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello"},
                    "state_patch": {"living_state": {"mood": "focused"}},
                },
                trace_id="trace-1",
                event_id="event-1",
                require_attached_ids=False,
                allow_state_patch=False,
            )

    def test_normalizes_visible_reply_with_optional_start_incident_life_action(self):
        decision = normalize_visible_reply_decision_with_optional_life_action(
            {
                "schema_version": "0.1",
                "trace_id": "trace-1",
                "event_id": "event-1",
                "action": "visible_reply",
                "visible_reply": {"text": " hello back "},
                "life_action": {
                    "type": "start_incident",
                    "incident": {
                        "type": "think",
                        "title": " Thinking through the plan ",
                        "remaining_seconds": 300,
                        "interrupt_policy": "interruptible",
                        "resume_policy": "ask_model",
                    },
                },
            },
            trace_id="trace-1",
            event_id="event-1",
            require_attached_ids=True,
            allow_life_action=True,
        )

        self.assertEqual(decision["visible_reply"]["text"], "hello back")
        self.assertEqual(
            decision["life_action"],
            {
                "type": "start_incident",
                "incident": {
                    "type": "think",
                    "title": "Thinking through the plan",
                    "remaining_seconds": 300,
                    "interrupt_policy": "interruptible",
                    "resume_policy": "ask_model",
                },
            },
        )

    def test_normalizes_visible_reply_with_optional_cancel_incident_life_action(self):
        decision = normalize_visible_reply_decision_with_optional_life_action(
            {
                "schema_version": "0.1",
                "trace_id": "trace-1",
                "event_id": "event-1",
                "action": "visible_reply",
                "visible_reply": {"text": " hello back "},
                "life_action": {
                    "type": "cancel_incident",
                    "incident_id": " incident-1 ",
                    "reason": " User needs me now. ",
                },
            },
            trace_id="trace-1",
            event_id="event-1",
            require_attached_ids=True,
            allow_life_action=True,
            allowed_life_action_type=CANCEL_INCIDENT_ACTION,
        )

        self.assertEqual(decision["visible_reply"]["text"], "hello back")
        self.assertEqual(
            decision["life_action"],
            {
                "type": "cancel_incident",
                "incident_id": "incident-1",
                "reason": "User needs me now.",
            },
        )

    def test_life_action_subtype_must_match_opt_in(self):
        with self.assertRaisesRegex(ContractValidationError, "start_incident"):
            normalize_visible_reply_decision_with_optional_life_action(
                {
                    "schema_version": "0.1",
                    "trace_id": "trace-1",
                    "event_id": "event-1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                    "life_action": {
                        "type": "cancel_incident",
                        "incident_id": "incident-1",
                        "reason": "stop",
                    },
                },
                trace_id="trace-1",
                event_id="event-1",
                require_attached_ids=True,
                allow_life_action=True,
                allowed_life_action_type=START_INCIDENT_ACTION,
            )

        with self.assertRaisesRegex(ContractValidationError, "cancel_incident"):
            normalize_visible_reply_decision_with_optional_life_action(
                {
                    "schema_version": "0.1",
                    "trace_id": "trace-1",
                    "event_id": "event-1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                    "life_action": {
                        "type": "start_incident",
                        "incident": {
                            "type": "think",
                            "title": "Think",
                            "interrupt_policy": "interruptible",
                            "resume_policy": "ask_model",
                        },
                    },
                },
                trace_id="trace-1",
                event_id="event-1",
                require_attached_ids=True,
                allow_life_action=True,
                allowed_life_action_type=CANCEL_INCIDENT_ACTION,
            )

    def test_rejects_life_action_when_not_allowed(self):
        with self.assertRaisesRegex(ContractValidationError, "life_action"):
            normalize_visible_reply_decision_with_optional_life_action(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello"},
                    "life_action": {
                        "type": "start_incident",
                        "incident": {
                            "type": "think",
                            "title": "Think",
                            "interrupt_policy": "interruptible",
                            "resume_policy": "ask_model",
                        },
                    },
                },
                trace_id="trace-1",
                event_id="event-1",
                require_attached_ids=False,
                allow_life_action=False,
            )

    def test_start_incident_life_action_rejects_future_and_committed_fields(self):
        cases = [
            ({"type": "resume_incident", "incident": {}}, "start_incident"),
            (
                {
                    "type": "start_incident",
                    "incident": {
                        "type": "dance",
                        "title": "Dance",
                        "interrupt_policy": "interruptible",
                        "resume_policy": "resume",
                    },
                },
                "type",
            ),
            (
                {
                    "type": "start_incident",
                    "incident": {
                        "type": "think",
                        "title": " ",
                        "interrupt_policy": "interruptible",
                        "resume_policy": "resume",
                    },
                },
                "title",
            ),
            (
                {
                    "type": "start_incident",
                    "incident": {
                        "type": "think",
                        "title": "Think",
                        "remaining_seconds": -1,
                        "interrupt_policy": "interruptible",
                        "resume_policy": "resume",
                    },
                },
                "remaining_seconds",
            ),
            (
                {
                    "type": "start_incident",
                    "incident": {
                        "type": "think",
                        "title": "Think",
                        "interrupt_policy": "force",
                        "resume_policy": "resume",
                    },
                },
                "interrupt_policy",
            ),
            (
                {
                    "type": "start_incident",
                    "incident": {
                        "type": "think",
                        "title": "Think",
                        "interrupt_policy": "interruptible",
                        "resume_policy": "ignore",
                    },
                },
                "resume_policy",
            ),
            (
                {
                    "type": "start_incident",
                    "incident": {
                        "type": "think",
                        "title": "Think",
                        "incident_id": "model-authored",
                        "interrupt_policy": "interruptible",
                        "resume_policy": "resume",
                    },
                },
                "incident_id",
            ),
            (
                {
                    "type": "start_incident",
                    "incident": {
                        "type": "think",
                        "title": "Think",
                        "status": "active",
                        "interrupt_policy": "interruptible",
                        "resume_policy": "resume",
                    },
                },
                "status",
            ),
        ]

        for life_action, error_pattern in cases:
            with self.subTest(error_pattern=error_pattern):
                with self.assertRaisesRegex(ContractValidationError, error_pattern):
                    normalize_start_incident_life_action(life_action)

    def test_cancel_incident_life_action_rejects_malformed_payloads(self):
        cases = [
            ({"type": "start_incident", "incident_id": "incident-1", "reason": "stop"}, "type"),
            ({"type": "cancel_incident", "incident_id": " ", "reason": "stop"}, "incident_id"),
            ({"type": "cancel_incident", "incident_id": "incident-1", "reason": " "}, "reason"),
            (
                {
                    "type": "cancel_incident",
                    "incident_id": "incident-1",
                    "reason": "stop",
                    "status": "cancelled",
                },
                "status",
            ),
            ({"type": "cancel_incident", "incident_id": "incident-1"}, "reason"),
            ({"type": "cancel_incident", "reason": "stop"}, "incident_id"),
        ]

        for life_action, error_pattern in cases:
            with self.subTest(error_pattern=error_pattern):
                with self.assertRaisesRegex(ContractValidationError, error_pattern):
                    normalize_cancel_incident_life_action(life_action)

    def test_rejects_life_action_and_state_patch_composition(self):
        with self.assertRaisesRegex(ContractValidationError, "state_patch and life_action"):
            normalize_visible_reply_decision_with_optional_living_state_patch(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello"},
                },
                trace_id="trace-1",
                event_id="event-1",
                require_attached_ids=False,
                allow_state_patch=True,
                allow_life_action=True,
            )

    def test_normalizes_role_model_turn_result_with_supplied_decision_normalizer(self):
        result = normalize_role_model_turn_result(
            role_model_result(),
            source_event=normalized_user_message(),
            decision_normalizer=lambda decision: normalize_visible_reply_decision(
                decision,
                trace_id="trace-1",
                event_id="event-1",
                require_attached_ids=True,
            ),
        )

        self.assertEqual(result["status"], DECISION_READY_FOR_COMMIT_STATUS)
        self.assertEqual(result["decision"]["visible_reply"]["text"], "hello back")

    def test_role_model_turn_result_rejects_unsupported_status_with_specific_code(self):
        result = role_model_result()
        result["status"] = "already_committed"

        with self.assertRaisesRegex(
            ContractValidationError,
            "decision_ready_for_commit",
        ) as context:
            normalize_role_model_turn_result(
                result,
                source_event=normalized_user_message(),
                decision_normalizer=lambda decision: normalize_visible_reply_decision(
                    decision,
                    trace_id="trace-1",
                    event_id="event-1",
                    require_attached_ids=True,
                ),
            )

        self.assertEqual(context.exception.code, "unsupported_result_status")


if __name__ == "__main__":
    unittest.main()
