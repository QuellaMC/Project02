import sys
import unittest
from copy import deepcopy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from character.state.context import (  # noqa: E402
    RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES,
    build_character_decision_context,
)
from character.state.current import (  # noqa: E402
    build_interrupted_incident_brief,
    validate_interrupted_incident_brief_for_event,
)
from role_model import loop as role_loop  # noqa: E402
from role_model.loop import RoleModelValidationError  # noqa: E402
from runtime.contracts import ContractValidationError  # noqa: E402


def normalized_user_message():
    return {
        "event_id": "event-1",
        "trace_id": "trace-1",
        "type": "USER_MESSAGE",
        "created_at": "2026-05-14T11:30:00+00:00",
        "schema_version": "0.1",
        "payload": {
            "text": "hello",
            "user_id": "user-1",
            "conversation_id": "conversation-1",
        },
    }


def recent_message():
    return {
        "schema_version": "0.1",
        "message_id": "message-1",
        "trace_id": "trace-message-1",
        "source_event_id": "event-message-1",
        "conversation_id": "conversation-1",
        "role": "assistant",
        "created_at": "2026-05-14T11:20:00+00:00",
        "text": "previous reply",
    }


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


def active_incident_snapshot():
    return {
        "schema_version": "0.1",
        "incident_id": "incident-1",
        "type": "eat",
        "status": "active",
        "title": "Eating lunch",
        "remaining_seconds": 600,
        "interrupt_policy": "interruptible",
        "resume_policy": "resume",
        "source_event_ids": ["event-incident-started"],
    }


def interrupted_incident_snapshot():
    snapshot = active_incident_snapshot()
    snapshot["status"] = "interrupted"
    snapshot["interrupted_at"] = "2026-05-14T11:30:00+00:00"
    snapshot["source_event_ids"] = ["event-incident-started", "event-1"]
    return snapshot


class RecordingRecentMessagesSource:
    def __init__(self, messages):
        self.messages = messages
        self.requests = []

    def read_recent_visible_messages(self, request):
        self.requests.append(deepcopy(request))
        return self.messages


class RecordingCurrentStateSource:
    def __init__(self, snapshot):
        self.snapshot = snapshot
        self.requests = []

    def read_current_state(self, request):
        self.requests.append(deepcopy(request))
        return self.snapshot


class RecordingActiveIncidentSource:
    def __init__(self, snapshot):
        self.snapshot = snapshot
        self.requests = []

    def read_active_incident(self, request):
        self.requests.append(deepcopy(request))
        return self.snapshot


class RecordingInterruptedIncidentSource:
    def __init__(self, snapshot):
        self.snapshot = snapshot
        self.requests = []

    def read_interrupted_incident(self, request):
        self.requests.append(deepcopy(request))
        return self.snapshot


class MutatingRecentMessagesSource:
    def __init__(self):
        self.requests = []

    def read_recent_visible_messages(self, request):
        request["before_event_id"] = "mutated-by-source"
        self.requests.append(request)
        return [recent_message()]


class CharacterContextBuilderTests(unittest.TestCase):
    def test_builds_minimal_user_message_context_without_sources(self):
        context = build_character_decision_context(normalized_user_message())

        self.assertEqual(
            context,
            {
                "schema_version": "0.1",
                "trace_id": "trace-1",
                "event_id": "event-1",
                "character_snapshot": {"recent_visible_messages": []},
            },
        )
        self.assertNotIn("call_type", context)
        self.assertNotIn("event", context)
        self.assertNotIn("allowed_actions", context)

    def test_builds_combined_context_and_preserves_copy_safety(self):
        messages = [recent_message()]
        state_snapshot = current_state_snapshot()
        incident_snapshot = active_incident_snapshot()

        context = build_character_decision_context(
            normalized_user_message(),
            recent_visible_messages_source=RecordingRecentMessagesSource(messages),
            current_state_source=RecordingCurrentStateSource(state_snapshot),
            active_incident_source=RecordingActiveIncidentSource(incident_snapshot),
        )

        self.assertEqual(
            context["character_snapshot"]["recent_visible_messages"],
            [recent_message()],
        )
        self.assertEqual(
            context["character_snapshot"]["living_state_brief"]["mood"],
            "focused",
        )
        self.assertEqual(
            context["character_snapshot"]["active_incident"]["title"],
            "Eating lunch",
        )
        self.assertIs(
            context["character_snapshot"]["user_message_interrupted_active_incident"],
            True,
        )
        self.assertNotIn("allowed_actions", context)

        messages[0]["text"] = "mutated after context"
        state_snapshot["living_state"]["mood"] = "mutated after context"
        incident_snapshot["title"] = "mutated after context"

        self.assertEqual(
            context["character_snapshot"]["recent_visible_messages"][0]["text"],
            "previous reply",
        )
        self.assertEqual(
            context["character_snapshot"]["living_state_brief"]["mood"],
            "focused",
        )
        self.assertEqual(
            context["character_snapshot"]["active_incident"]["title"],
            "Eating lunch",
        )

    def test_active_incident_flag_is_derived_from_single_existing_read(self):
        source = RecordingActiveIncidentSource(active_incident_snapshot())

        context = build_character_decision_context(
            normalized_user_message(),
            active_incident_source=source,
        )

        self.assertEqual(len(source.requests), 1)
        self.assertEqual(source.requests[0]["event_id"], "event-1")
        self.assertEqual(
            context["character_snapshot"]["active_incident"]["title"],
            "Eating lunch",
        )
        self.assertIs(
            context["character_snapshot"]["user_message_interrupted_active_incident"],
            True,
        )

    def test_omits_interruption_flag_without_active_incident(self):
        no_active_source = RecordingActiveIncidentSource(None)

        context_without_source = build_character_decision_context(normalized_user_message())
        context_without_active_incident = build_character_decision_context(
            normalized_user_message(),
            active_incident_source=no_active_source,
        )

        self.assertNotIn(
            "user_message_interrupted_active_incident",
            context_without_source["character_snapshot"],
        )
        self.assertNotIn(
            "user_message_interrupted_active_incident",
            context_without_active_incident["character_snapshot"],
        )
        self.assertEqual(len(no_active_source.requests), 1)

    def test_interrupted_incident_context_uses_interrupted_read_when_no_active_incident_exists(
        self,
    ):
        active_source = RecordingActiveIncidentSource(None)
        interrupted_source = RecordingInterruptedIncidentSource(interrupted_incident_snapshot())

        context = build_character_decision_context(
            normalized_user_message(),
            active_incident_source=active_source,
            interrupted_incident_source=interrupted_source,
        )

        self.assertEqual(len(active_source.requests), 1)
        self.assertEqual(len(interrupted_source.requests), 1)
        self.assertEqual(
            context["character_snapshot"]["interrupted_incident"],
            build_interrupted_incident_brief(interrupted_incident_snapshot()),
        )
        self.assertNotIn("active_incident", context["character_snapshot"])
        self.assertNotIn(
            "user_message_interrupted_active_incident",
            context["character_snapshot"],
        )

    def test_stale_interrupted_incident_read_is_ignored_when_no_active_incident_exists(self):
        stale_interrupted = interrupted_incident_snapshot()
        stale_interrupted["source_event_ids"] = ["event-incident-started", "event-old"]
        interrupted_source = RecordingInterruptedIncidentSource(stale_interrupted)

        context = build_character_decision_context(
            normalized_user_message(),
            interrupted_incident_source=interrupted_source,
        )

        self.assertEqual(len(interrupted_source.requests), 1)
        self.assertNotIn("active_incident", context["character_snapshot"])
        self.assertNotIn("interrupted_incident", context["character_snapshot"])
        self.assertNotIn(
            "user_message_interrupted_active_incident",
            context["character_snapshot"],
        )

    def test_context_prefers_active_incident_without_reading_stale_interrupted_incident(self):
        active_source = RecordingActiveIncidentSource(active_incident_snapshot())
        stale_interrupted = interrupted_incident_snapshot()
        stale_interrupted["source_event_ids"] = ["event-incident-started", "event-old"]
        interrupted_source = RecordingInterruptedIncidentSource(stale_interrupted)

        context = build_character_decision_context(
            normalized_user_message(),
            active_incident_source=active_source,
            interrupted_incident_source=interrupted_source,
        )

        self.assertEqual(len(active_source.requests), 1)
        self.assertEqual(interrupted_source.requests, [])
        self.assertIn("active_incident", context["character_snapshot"])
        self.assertNotIn("interrupted_incident", context["character_snapshot"])
        self.assertIs(
            context["character_snapshot"]["user_message_interrupted_active_incident"],
            True,
        )

    def test_interrupted_incident_brief_allows_current_event_source_id(self):
        brief = build_interrupted_incident_brief(interrupted_incident_snapshot())

        validated = validate_interrupted_incident_brief_for_event(
            brief,
            event_id="event-1",
        )

        self.assertEqual(validated["source_event_ids"], ["event-incident-started", "event-1"])

    def test_interrupted_incident_brief_rejects_missing_current_event_source_id(self):
        brief = build_interrupted_incident_brief(interrupted_incident_snapshot())
        brief["source_event_ids"] = ["event-incident-started", "event-old"]

        with self.assertRaisesRegex(ContractValidationError, "current event_id"):
            validate_interrupted_incident_brief_for_event(
                brief,
                event_id="event-1",
            )

    def test_rejects_malformed_interrupted_incident_source_payload(self):
        malformed_snapshot = interrupted_incident_snapshot()
        malformed_snapshot["status"] = "active"

        with self.assertRaisesRegex(ContractValidationError, "status"):
            build_character_decision_context(
                normalized_user_message(),
                interrupted_incident_source=RecordingInterruptedIncidentSource(malformed_snapshot),
            )

    def test_sources_receive_copy_safe_requests(self):
        event = normalized_user_message()
        source = MutatingRecentMessagesSource()

        build_character_decision_context(event, recent_visible_messages_source=source)

        self.assertEqual(event["event_id"], "event-1")
        self.assertEqual(source.requests[0]["before_event_id"], "mutated-by-source")
        self.assertEqual(
            source.requests[0]["max_candidate_messages"],
            RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES,
        )

    def test_role_model_compatibility_wrapper_delegates_to_character_context_builder(self):
        calls = []
        expected_context = {
            "schema_version": "0.1",
            "trace_id": "trace-1",
            "event_id": "event-1",
            "character_snapshot": {"recent_visible_messages": []},
        }
        original_builder = role_loop.build_character_decision_context

        def fake_builder(event, **kwargs):
            calls.append((event, kwargs))
            return expected_context

        try:
            role_loop.build_character_decision_context = fake_builder
            context = role_loop.build_decision_context(
                normalized_user_message(),
            )
        finally:
            role_loop.build_character_decision_context = original_builder

        self.assertIs(context, expected_context)
        self.assertEqual(calls[0][0]["event_id"], "event-1")
        self.assertNotIn("allow_incident_start", calls[0][1])

    def test_role_model_compatibility_wrapper_converts_context_errors(self):
        original_builder = role_loop.build_character_decision_context

        def fake_builder(_event, **_kwargs):
            raise ContractValidationError("from Character State Engine")

        try:
            role_loop.build_character_decision_context = fake_builder
            with self.assertRaisesRegex(RoleModelValidationError, "Character State Engine"):
                role_loop.build_decision_context(normalized_user_message())
        finally:
            role_loop.build_character_decision_context = original_builder


if __name__ == "__main__":
    unittest.main()
