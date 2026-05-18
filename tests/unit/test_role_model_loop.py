import json
import sys
import unittest
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from role_model.loop import (  # noqa: E402
    RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES,
    RECENT_VISIBLE_MESSAGES_MAX_MESSAGES,
    RECENT_VISIBLE_MESSAGES_MAX_TEXT_TOKENS,
    ROLE_MODEL_INSTRUCTIONS,
    STATE_PATCH_ROLE_MODEL_INSTRUCTIONS,
    RoleModelValidationError,
    VisibleConversationRecentMessagesSource,
    approximate_text_tokens,
    build_decision_context,
    build_role_model_turn_completed_log_entry,
    build_role_model_turn_failed_log_entry,
    parse_character_decision,
    render_role_model_input,
)


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


def role_model_input():
    return render_role_model_input(build_decision_context(normalized_user_message()))


def adapter_output(raw_text):
    return {
        "model_id": "fake-role-model",
        "created_at": "2026-05-14T11:31:00+00:00",
        "raw_text": raw_text,
    }


def fixed_clock():
    return datetime(2026, 5, 14, 11, 32, 0, tzinfo=UTC)


class SequenceIdGenerator:
    def __init__(self):
        self.calls = []

    def __call__(self, kind):
        self.calls.append(kind)
        return f"{kind}-generated-{len(self.calls)}"


class UserMessageType(str):
    pass


def recent_message(
    message_id,
    *,
    role="assistant",
    created_at="2026-05-14T11:20:00+00:00",
    text="previous reply",
    conversation_id="conversation-1",
    source_event_id=None,
):
    return {
        "schema_version": "0.1",
        "message_id": message_id,
        "trace_id": f"trace-{message_id}",
        "source_event_id": source_event_id or f"event-{message_id}",
        "conversation_id": conversation_id,
        "role": role,
        "created_at": created_at,
        "text": text,
    }


class RecordingRecentMessagesSource:
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


def active_incident_snapshot():
    return {
        "schema_version": "0.1",
        "incident_id": "incident-1",
        "type": "eat",
        "status": "active",
        "title": "Eating lunch",
        "started_at": "2026-05-14T11:00:00+00:00",
        "expected_end_at": "2026-05-14T11:40:00+00:00",
        "remaining_seconds": 600,
        "interrupt_policy": "interruptible",
        "resume_policy": "resume",
        "source_event_ids": ["event-incident-started"],
    }


def active_incident_brief():
    return {
        "incident_id": "incident-1",
        "type": "eat",
        "title": "Eating lunch",
        "started_at": "2026-05-14T11:00:00+00:00",
        "expected_end_at": "2026-05-14T11:40:00+00:00",
        "remaining_seconds": 600,
        "interrupt_policy": "interruptible",
        "resume_policy": "resume",
        "source_event_ids": ["event-incident-started"],
    }


class RecordingCurrentStateSource:
    def __init__(self, snapshot):
        self.snapshot = snapshot
        self.requests = []

    def read_current_state(self, request):
        self.requests.append(request)
        return self.snapshot


class MutatingCurrentStateSource:
    def __init__(self, snapshot):
        self.snapshot = snapshot
        self.requests = []

    def read_current_state(self, request):
        self.requests.append(request)
        request["event_id"] = "mutated-by-source"
        self.snapshot["living_state"]["mood"] = "mutated-by-source"
        self.snapshot["source_event_ids"].append("mutated-by-source")
        return self.snapshot


class RecordingActiveIncidentSource:
    def __init__(self, snapshot):
        self.snapshot = snapshot
        self.requests = []

    def read_active_incident(self, request):
        self.requests.append(request)
        return self.snapshot


class MutatingActiveIncidentSource:
    def __init__(self, snapshot):
        self.snapshot = snapshot
        self.requests = []

    def read_active_incident(self, request):
        self.requests.append(request)
        request["event_id"] = "mutated-by-source"
        self.snapshot["title"] = "mutated-by-source"
        self.snapshot["source_event_ids"].append("mutated-by-source")
        return self.snapshot


def recent_request():
    return {
        "schema_version": "0.1",
        "conversation_id": "conversation-1",
        "before_event_id": "event-1",
        "before_created_at": "2026-05-14T11:30:00+00:00",
        "max_candidate_messages": RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES,
    }


def user_visible_record(
    message_id,
    *,
    conversation_id="conversation-1",
    created_at="2026-05-14T11:20:00+00:00",
    text="previous user message",
):
    return {
        "schema_version": "0.1",
        "message_id": message_id,
        "trace_id": f"trace-{message_id}",
        "source_event_id": f"event-{message_id}",
        "kind": "user_visible_message",
        "role": "user",
        "conversation_id": conversation_id,
        "created_at": created_at,
        "text": text,
        "user_id": "user-1",
        "source": {"runtime_event_type": "USER_MESSAGE"},
    }


def assistant_visible_record(
    output_id,
    *,
    conversation_id="conversation-1",
    created_at="2026-05-14T11:21:00+00:00",
    text="previous assistant reply",
):
    return {
        "schema_version": "0.1",
        "output_id": output_id,
        "trace_id": f"trace-{output_id}",
        "source_event_id": f"event-{output_id}",
        "kind": "assistant_visible_reply",
        "conversation_id": conversation_id,
        "created_at": created_at,
        "text": text,
        "user_id": "user-1",
        "source": {
            "decision_action": "visible_reply",
            "role_model_status": "decision_ready_for_commit",
        },
    }


class RecordingVisibleConversationRecordSource:
    def __init__(self, records):
        self.records = records
        self.requests = []

    def read_visible_conversation_records(self, request):
        self.requests.append(request)
        return self.records


class MutatingVisibleConversationRecordSource:
    def __init__(self, records):
        self.records = records

    def read_visible_conversation_records(self, request):
        request["conversation_id"] = "mutated-by-source"
        return self.records


class DecisionContextTests(unittest.TestCase):
    def test_builds_minimal_decision_context_from_normalized_user_message(self):
        context = build_decision_context(normalized_user_message())

        self.assertEqual(
            context,
            {
                "schema_version": "0.1",
                "trace_id": "trace-1",
                "event_id": "event-1",
                "call_type": "user_message_visible_reply",
                "event": {
                    "type": "USER_MESSAGE",
                    "text": "hello",
                    "created_at": "2026-05-14T11:30:00+00:00",
                    "user_id": "user-1",
                    "conversation_id": "conversation-1",
                },
                "character_snapshot": {"recent_visible_messages": []},
                "allowed_actions": ["visible_reply"],
            },
        )

    def test_preserves_empty_optional_payload_strings_from_normalized_event(self):
        event = normalized_user_message()
        event["payload"]["user_id"] = ""
        event["payload"]["conversation_id"] = ""

        context = build_decision_context(event)

        self.assertEqual(context["event"]["user_id"], "")
        self.assertEqual(context["event"]["conversation_id"], "")

    def test_derives_context_event_type_from_normalized_event(self):
        event = normalized_user_message()
        event["type"] = UserMessageType("USER_MESSAGE")

        context = build_decision_context(event)

        self.assertIs(context["event"]["type"], event["type"])

    def test_without_conversation_id_does_not_call_recent_message_source(self):
        event = normalized_user_message()
        event["payload"].pop("conversation_id")
        source = RecordingRecentMessagesSource([recent_message("message-1")])

        context = build_decision_context(event, recent_visible_messages_source=source)

        self.assertEqual(source.requests, [])
        self.assertEqual(context["character_snapshot"]["recent_visible_messages"], [])

    def test_reads_recent_messages_with_expected_request(self):
        source = RecordingRecentMessagesSource([recent_message("message-1")])

        context = build_decision_context(
            normalized_user_message(),
            recent_visible_messages_source=source,
        )

        self.assertEqual(
            source.requests,
            [
                {
                    "schema_version": "0.1",
                    "conversation_id": "conversation-1",
                    "before_event_id": "event-1",
                    "before_created_at": "2026-05-14T11:30:00+00:00",
                    "max_candidate_messages": RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES,
                }
            ],
        )
        self.assertEqual(
            context["character_snapshot"]["recent_visible_messages"][0]["message_id"], "message-1"
        )

    def test_reads_current_state_with_expected_request_and_living_state_brief(self):
        source = RecordingCurrentStateSource(current_state_snapshot())

        context = build_decision_context(
            normalized_user_message(),
            current_state_source=source,
        )

        self.assertEqual(
            source.requests,
            [
                {
                    "schema_version": "0.1",
                    "trace_id": "trace-1",
                    "event_id": "event-1",
                    "event_type": "USER_MESSAGE",
                    "user_id": "user-1",
                    "conversation_id": "conversation-1",
                }
            ],
        )
        self.assertNotIn("character_id", source.requests[0])
        self.assertEqual(
            context["character_snapshot"]["living_state_brief"],
            living_state_brief(),
        )
        self.assertEqual(context["allowed_actions"], ["visible_reply"])

    def test_state_patch_opt_in_requires_and_advertises_current_state(self):
        source = RecordingCurrentStateSource(current_state_snapshot())

        context = build_decision_context(
            normalized_user_message(),
            current_state_source=source,
            allow_state_patch=True,
        )

        self.assertEqual(context["allowed_actions"], ["visible_reply", "state_patch"])
        self.assertEqual(
            context["character_snapshot"]["living_state_brief"],
            living_state_brief(),
        )

    def test_state_patch_opt_in_requires_current_state_source(self):
        with self.assertRaisesRegex(RoleModelValidationError, "current_state_source"):
            build_decision_context(normalized_user_message(), allow_state_patch=True)

    def test_current_state_source_is_called_without_conversation_id(self):
        event = normalized_user_message()
        event["payload"].pop("conversation_id")
        source = RecordingCurrentStateSource(current_state_snapshot())

        context = build_decision_context(event, current_state_source=source)

        self.assertEqual(
            source.requests,
            [
                {
                    "schema_version": "0.1",
                    "trace_id": "trace-1",
                    "event_id": "event-1",
                    "event_type": "USER_MESSAGE",
                    "user_id": "user-1",
                }
            ],
        )
        self.assertEqual(context["character_snapshot"]["recent_visible_messages"], [])
        self.assertEqual(
            context["character_snapshot"]["living_state_brief"],
            living_state_brief(),
        )

    def test_rejects_malformed_current_state_source_response(self):
        cases = [
            ({**current_state_snapshot(), "schema_version": "0.2"}, "schema_version"),
            ({**current_state_snapshot(), "character_id": ""}, "character_id"),
            (
                {
                    **current_state_snapshot(),
                    "living_state": {
                        "current_activity": "writing notes",
                        "mood": "",
                        "toward_user": "warm",
                    },
                },
                "mood",
            ),
            ({**current_state_snapshot(), "updated_at": "not-a-timestamp"}, "updated_at"),
            ({**current_state_snapshot(), "source_event_ids": [123]}, "source_event_ids"),
            ({**current_state_snapshot(), "source_event_ids": ["event-1"]}, "current event_id"),
            ({**current_state_snapshot(), "future_field": "nope"}, "future_field"),
            ("not a mapping", "CharacterRuntimeStateSnapshot"),
        ]

        for snapshot, error_pattern in cases:
            with self.subTest(error_pattern=error_pattern):
                with self.assertRaisesRegex(RoleModelValidationError, error_pattern):
                    build_decision_context(
                        normalized_user_message(),
                        current_state_source=RecordingCurrentStateSource(snapshot),
                    )

    def test_current_state_context_uses_copies(self):
        snapshot = current_state_snapshot()
        source = RecordingCurrentStateSource(snapshot)

        context = build_decision_context(
            normalized_user_message(),
            current_state_source=source,
        )

        snapshot["living_state"]["mood"] = "mutated after context"
        snapshot["source_event_ids"].append("mutated after context")
        context["character_snapshot"]["living_state_brief"]["source_event_ids"].append("mutated")

        self.assertEqual(context["character_snapshot"]["living_state_brief"]["mood"], "focused")
        self.assertEqual(snapshot["source_event_ids"], ["event-state-1", "mutated after context"])

    def test_current_state_source_receives_request_copy(self):
        event = normalized_user_message()
        source = MutatingCurrentStateSource(current_state_snapshot())

        build_decision_context(event, current_state_source=source)

        self.assertEqual(event["event_id"], "event-1")
        self.assertEqual(source.requests[0]["event_id"], "mutated-by-source")

    def test_reads_active_incident_with_expected_request_and_brief(self):
        source = RecordingActiveIncidentSource(active_incident_snapshot())

        context = build_decision_context(
            normalized_user_message(),
            active_incident_source=source,
        )

        self.assertEqual(
            source.requests,
            [
                {
                    "schema_version": "0.1",
                    "trace_id": "trace-1",
                    "event_id": "event-1",
                    "event_type": "USER_MESSAGE",
                    "user_id": "user-1",
                    "conversation_id": "conversation-1",
                }
            ],
        )
        self.assertEqual(
            context["character_snapshot"]["active_incident"],
            active_incident_brief(),
        )
        self.assertEqual(context["allowed_actions"], ["visible_reply"])

    def test_active_incident_source_none_omits_context_field(self):
        source = RecordingActiveIncidentSource(None)

        context = build_decision_context(
            normalized_user_message(),
            active_incident_source=source,
        )

        self.assertNotIn("active_incident", context["character_snapshot"])
        self.assertEqual(source.requests[0]["event_id"], "event-1")

    def test_rejects_malformed_active_incident_source_response(self):
        cases = [
            ({**active_incident_snapshot(), "type": "dance"}, "type"),
            ({**active_incident_snapshot(), "status": "completed"}, "status"),
            ({**active_incident_snapshot(), "started_at": "bad"}, "started_at"),
            ({**active_incident_snapshot(), "remaining_seconds": -1}, "remaining_seconds"),
            ({**active_incident_snapshot(), "source_event_ids": []}, "source_event_ids"),
            ({**active_incident_snapshot(), "source_event_ids": ["event-1"]}, "current event_id"),
            ({**active_incident_snapshot(), "future_field": "nope"}, "future_field"),
            ("not a mapping", "ActiveIncidentSnapshot"),
        ]

        for snapshot, error_pattern in cases:
            with self.subTest(error_pattern=error_pattern):
                with self.assertRaisesRegex(RoleModelValidationError, error_pattern):
                    build_decision_context(
                        normalized_user_message(),
                        active_incident_source=RecordingActiveIncidentSource(snapshot),
                    )

    def test_active_incident_context_uses_copies(self):
        snapshot = active_incident_snapshot()
        source = RecordingActiveIncidentSource(snapshot)

        context = build_decision_context(
            normalized_user_message(),
            active_incident_source=source,
        )

        snapshot["title"] = "mutated after context"
        snapshot["source_event_ids"].append("mutated after context")
        context["character_snapshot"]["active_incident"]["source_event_ids"].append("mutated")

        self.assertEqual(context["character_snapshot"]["active_incident"]["title"], "Eating lunch")
        self.assertEqual(
            snapshot["source_event_ids"],
            ["event-incident-started", "mutated after context"],
        )

    def test_active_incident_source_receives_request_copy(self):
        event = normalized_user_message()
        source = MutatingActiveIncidentSource(active_incident_snapshot())

        build_decision_context(event, active_incident_source=source)

        self.assertEqual(event["event_id"], "event-1")
        self.assertEqual(source.requests[0]["event_id"], "mutated-by-source")

    def test_recent_messages_are_normalized_limited_and_ordered_oldest_to_newest(self):
        messages = [
            recent_message("message-7", created_at="2026-05-14T11:27:00+00:00"),
            recent_message("message-2", created_at="2026-05-14T11:22:00+00:00"),
            recent_message("message-5", created_at="2026-05-14T11:25:00+00:00"),
            recent_message(
                "message-1",
                role="user",
                created_at="2026-05-14T11:21:00+00:00",
                text=" prior user ",
            ),
            recent_message("message-6", created_at="2026-05-14T11:26:00+00:00"),
            recent_message("message-3", created_at="2026-05-14T11:23:00+00:00"),
            recent_message("message-4", created_at="2026-05-14T11:24:00+00:00"),
        ]

        context = build_decision_context(
            normalized_user_message(),
            recent_visible_messages_source=RecordingRecentMessagesSource(messages),
        )

        self.assertEqual(
            [
                message["message_id"]
                for message in context["character_snapshot"]["recent_visible_messages"]
            ],
            [
                "message-2",
                "message-3",
                "message-4",
                "message-5",
                "message-6",
                "message-7",
            ],
        )
        self.assertEqual(
            len(context["character_snapshot"]["recent_visible_messages"]),
            RECENT_VISIBLE_MESSAGES_MAX_MESSAGES,
        )
        self.assertEqual(
            context["character_snapshot"]["recent_visible_messages"][0],
            {
                "schema_version": "0.1",
                "message_id": "message-2",
                "trace_id": "trace-message-2",
                "source_event_id": "event-message-2",
                "conversation_id": "conversation-1",
                "role": "assistant",
                "created_at": "2026-05-14T11:22:00+00:00",
                "text": "previous reply",
            },
        )

    def test_recent_message_token_budget_skips_without_truncating(self):
        oversized_text = "x" * ((RECENT_VISIBLE_MESSAGES_MAX_TEXT_TOKENS * 4) + 1)
        messages = [
            recent_message(
                "message-1", created_at="2026-05-14T11:21:00+00:00", text=oversized_text
            ),
            recent_message("message-2", created_at="2026-05-14T11:22:00+00:00", text="small"),
            recent_message("message-3", created_at="2026-05-14T11:23:00+00:00", text="also small"),
        ]

        context = build_decision_context(
            normalized_user_message(),
            recent_visible_messages_source=RecordingRecentMessagesSource(messages),
        )

        recent_messages = context["character_snapshot"]["recent_visible_messages"]
        self.assertEqual(
            [message["message_id"] for message in recent_messages], ["message-2", "message-3"]
        )
        self.assertEqual(recent_messages[0]["text"], "small")
        self.assertEqual(approximate_text_tokens("x" * 5), 2)

    def test_excludes_current_source_event_from_recent_messages(self):
        messages = [
            recent_message("event-1", created_at="2026-05-14T11:21:00+00:00"),
            recent_message(
                "message-2",
                created_at="2026-05-14T11:22:00+00:00",
                source_event_id="event-1",
            ),
            recent_message("message-3", created_at="2026-05-14T11:23:00+00:00"),
        ]

        context = build_decision_context(
            normalized_user_message(),
            recent_visible_messages_source=RecordingRecentMessagesSource(messages),
        )

        self.assertEqual(
            [
                message["message_id"]
                for message in context["character_snapshot"]["recent_visible_messages"]
            ],
            ["message-3"],
        )

    def test_rejects_recent_messages_at_or_after_current_event_timestamp(self):
        cases = [
            recent_message("message-1", created_at="2026-05-14T11:30:00+00:00"),
            recent_message("message-2", created_at="2026-05-14T11:30:01+00:00"),
        ]

        for message in cases:
            with self.subTest(created_at=message["created_at"]):
                with self.assertRaisesRegex(RoleModelValidationError, "before event.created_at"):
                    build_decision_context(
                        normalized_user_message(),
                        recent_visible_messages_source=RecordingRecentMessagesSource([message]),
                    )

    def test_rejects_duplicate_recent_message_identity_records(self):
        cases = [
            (
                [
                    recent_message("message-1", created_at="2026-05-14T11:21:00+00:00"),
                    recent_message(
                        "message-1",
                        created_at="2026-05-14T11:22:00+00:00",
                        source_event_id="event-message-2",
                    ),
                ],
                "message_id",
            ),
            (
                [
                    recent_message("message-1", created_at="2026-05-14T11:21:00+00:00"),
                    recent_message(
                        "message-2",
                        created_at="2026-05-14T11:22:00+00:00",
                        source_event_id="event-message-1",
                    ),
                ],
                "source_event_id and role",
            ),
        ]

        for messages, error_pattern in cases:
            with self.subTest(error_pattern=error_pattern):
                with self.assertRaisesRegex(RoleModelValidationError, error_pattern):
                    build_decision_context(
                        normalized_user_message(),
                        recent_visible_messages_source=RecordingRecentMessagesSource(messages),
                    )

    def test_allows_user_and_assistant_recent_messages_from_same_source_event(self):
        messages = [
            recent_message(
                "message-prior-user",
                role="user",
                source_event_id="event-prior-turn",
                created_at="2026-05-14T11:21:00+00:00",
                text="prior user message",
            ),
            recent_message(
                "message-prior-assistant",
                role="assistant",
                source_event_id="event-prior-turn",
                created_at="2026-05-14T11:22:00+00:00",
                text="prior assistant reply",
            ),
        ]

        context = build_decision_context(
            normalized_user_message(),
            recent_visible_messages_source=RecordingRecentMessagesSource(messages),
        )

        self.assertEqual(
            [
                (message["source_event_id"], message["role"], message["text"])
                for message in context["character_snapshot"]["recent_visible_messages"]
            ],
            [
                ("event-prior-turn", "user", "prior user message"),
                ("event-prior-turn", "assistant", "prior assistant reply"),
            ],
        )

    def test_rejects_malformed_recent_message_records(self):
        cases = [
            ([{"schema_version": "0.2"}], "schema_version"),
            (
                [recent_message("message-1", conversation_id="other-conversation")],
                "conversation_id",
            ),
            ([recent_message("message-1", role="system")], "role"),
            ([recent_message("message-1", created_at="not-a-timestamp")], "created_at"),
            ([recent_message("message-1", text="   ")], "text"),
            ([{**recent_message("message-1"), "future_field": "nope"}], "future_field"),
            (
                [
                    recent_message(
                        f"message-{index}",
                        created_at="2026-05-14T11:21:00+00:00",
                    )
                    for index in range(RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES + 1)
                ],
                "too many",
            ),
            ("not a list", "RecentVisibleMessagesSource"),
        ]

        for messages, error_pattern in cases:
            with self.subTest(messages=messages):
                with self.assertRaisesRegex(RoleModelValidationError, error_pattern):
                    build_decision_context(
                        normalized_user_message(),
                        recent_visible_messages_source=RecordingRecentMessagesSource(messages),
                    )

    def test_rejects_unsupported_event_type_or_schema_version(self):
        unsupported_type = normalized_user_message()
        unsupported_type["type"] = "TIMER"

        with self.assertRaisesRegex(RoleModelValidationError, "USER_MESSAGE"):
            build_decision_context(unsupported_type)

        unsupported_schema = normalized_user_message()
        unsupported_schema["schema_version"] = "0.2"

        with self.assertRaisesRegex(RoleModelValidationError, "schema_version"):
            build_decision_context(unsupported_schema)

    def test_renders_stable_role_model_input_for_same_context(self):
        context = build_decision_context(normalized_user_message())

        first_input = render_role_model_input(context)
        second_input = render_role_model_input(context)

        self.assertEqual(first_input, second_input)
        self.assertEqual(
            first_input,
            {
                "schema_version": "0.1",
                "trace_id": "trace-1",
                "event_id": "event-1",
                "instructions": ROLE_MODEL_INSTRUCTIONS,
                "decision_context": context,
            },
        )
        context["event"]["text"] = "mutated after render"
        self.assertEqual(first_input["decision_context"]["event"]["text"], "hello")

    def test_renders_state_patch_output_contract_only_for_opted_in_context(self):
        context = build_decision_context(
            normalized_user_message(),
            current_state_source=RecordingCurrentStateSource(current_state_snapshot()),
            allow_state_patch=True,
        )

        model_input = render_role_model_input(context)

        self.assertEqual(model_input["instructions"], STATE_PATCH_ROLE_MODEL_INSTRUCTIONS)
        self.assertIn("state_patch.living_state", model_input["instructions"])
        self.assertEqual(
            model_input["decision_context"]["allowed_actions"],
            ["visible_reply", "state_patch"],
        )

    def test_render_rejects_malformed_nested_decision_context_event(self):
        cases = [
            ({}, "event"),
            (
                {"type": "TIMER", "text": "hello", "created_at": "2026-05-14T11:30:00+00:00"},
                "USER_MESSAGE",
            ),
            (
                {"type": "USER_MESSAGE", "text": "", "created_at": "2026-05-14T11:30:00+00:00"},
                "event.text",
            ),
            ({"type": "USER_MESSAGE", "text": "hello"}, "event.created_at"),
            (
                {
                    "type": "USER_MESSAGE",
                    "text": "hello",
                    "created_at": "2026-05-14T11:30:00+00:00",
                    "user_id": 123,
                },
                "event.user_id",
            ),
        ]

        for event, error_pattern in cases:
            with self.subTest(event=event):
                context = build_decision_context(normalized_user_message())
                context["event"] = event

                with self.assertRaisesRegex(RoleModelValidationError, error_pattern):
                    render_role_model_input(context)

    def test_render_rejects_extra_decision_context_fields(self):
        context = build_decision_context(normalized_user_message())
        context["future_field"] = "not allowed yet"

        with self.assertRaisesRegex(RoleModelValidationError, "future_field"):
            render_role_model_input(context)

    def test_render_validates_recent_messages(self):
        context = build_decision_context(normalized_user_message())
        context["character_snapshot"]["recent_visible_messages"] = [
            recent_message("message-1", text="")
        ]

        with self.assertRaisesRegex(RoleModelValidationError, "text"):
            render_role_model_input(context)

        context = build_decision_context(normalized_user_message())
        context["character_snapshot"]["future_field"] = "not allowed yet"

        with self.assertRaisesRegex(RoleModelValidationError, "future_field"):
            render_role_model_input(context)

        context = build_decision_context(normalized_user_message())
        context["event"]["future_field"] = "not allowed yet"

        with self.assertRaisesRegex(RoleModelValidationError, "future_field"):
            render_role_model_input(context)

        context = build_decision_context(normalized_user_message())
        context["character_snapshot"]["recent_visible_messages"] = [
            recent_message("message-1", created_at="2026-05-14T11:30:00+00:00")
        ]

        with self.assertRaisesRegex(RoleModelValidationError, "before event.created_at"):
            render_role_model_input(context)

        context = build_decision_context(normalized_user_message())
        context["character_snapshot"]["recent_visible_messages"] = [
            recent_message("message-1", created_at="2026-05-14T11:21:00+00:00"),
            recent_message(
                "message-1",
                created_at="2026-05-14T11:22:00+00:00",
                source_event_id="event-message-2",
            ),
        ]

        with self.assertRaisesRegex(RoleModelValidationError, "message_id"):
            render_role_model_input(context)

        context = build_decision_context(normalized_user_message())
        context["character_snapshot"]["recent_visible_messages"] = [
            recent_message("message-1", created_at="2026-05-14T11:21:00+00:00"),
            recent_message(
                "message-2",
                created_at="2026-05-14T11:22:00+00:00",
                source_event_id="event-message-1",
            ),
        ]

        with self.assertRaisesRegex(RoleModelValidationError, "source_event_id"):
            render_role_model_input(context)

        for event_conversation_id in (None, ""):
            with self.subTest(event_conversation_id=event_conversation_id):
                context = build_decision_context(normalized_user_message())
                if event_conversation_id is None:
                    context["event"].pop("conversation_id")
                else:
                    context["event"]["conversation_id"] = event_conversation_id
                context["character_snapshot"]["recent_visible_messages"] = [
                    recent_message("message-1", conversation_id="")
                ]

                with self.assertRaisesRegex(RoleModelValidationError, "event.conversation_id"):
                    render_role_model_input(context)

    def test_render_accepts_and_validates_living_state_brief(self):
        context = build_decision_context(
            normalized_user_message(),
            current_state_source=RecordingCurrentStateSource(current_state_snapshot()),
        )

        rendered = render_role_model_input(context)

        self.assertEqual(
            rendered["decision_context"]["character_snapshot"]["living_state_brief"],
            living_state_brief(),
        )

        context["character_snapshot"]["living_state_brief"]["future_field"] = "not allowed yet"
        with self.assertRaisesRegex(RoleModelValidationError, "future_field"):
            render_role_model_input(context)

        context = build_decision_context(
            normalized_user_message(),
            current_state_source=RecordingCurrentStateSource(current_state_snapshot()),
        )
        context["character_snapshot"]["living_state_brief"]["updated_at"] = "2026-05-14"
        with self.assertRaisesRegex(RoleModelValidationError, "updated_at"):
            render_role_model_input(context)

        context = build_decision_context(
            normalized_user_message(),
            current_state_source=RecordingCurrentStateSource(current_state_snapshot()),
        )
        context["character_snapshot"]["living_state_brief"]["source_event_ids"] = ["event-1"]
        with self.assertRaisesRegex(RoleModelValidationError, "current event_id"):
            render_role_model_input(context)

    def test_render_accepts_and_validates_active_incident(self):
        context = build_decision_context(
            normalized_user_message(),
            active_incident_source=RecordingActiveIncidentSource(active_incident_snapshot()),
        )

        rendered = render_role_model_input(context)

        self.assertEqual(
            rendered["decision_context"]["character_snapshot"]["active_incident"],
            active_incident_brief(),
        )

        context["character_snapshot"]["active_incident"]["future_field"] = "not allowed yet"
        with self.assertRaisesRegex(RoleModelValidationError, "future_field"):
            render_role_model_input(context)

        context = build_decision_context(
            normalized_user_message(),
            active_incident_source=RecordingActiveIncidentSource(active_incident_snapshot()),
        )
        context["character_snapshot"]["active_incident"]["source_event_ids"] = ["event-1"]
        with self.assertRaisesRegex(RoleModelValidationError, "current event_id"):
            render_role_model_input(context)

    def test_active_incident_does_not_change_allowed_actions(self):
        context = build_decision_context(
            normalized_user_message(),
            active_incident_source=RecordingActiveIncidentSource(active_incident_snapshot()),
        )
        model_input = render_role_model_input(context)

        self.assertEqual(context["allowed_actions"], ["visible_reply"])
        self.assertEqual(model_input["instructions"], ROLE_MODEL_INSTRUCTIONS)


class VisibleConversationRecentMessagesSourceTests(unittest.TestCase):
    def test_maps_user_and_assistant_visible_records_to_recent_messages(self):
        record_source = RecordingVisibleConversationRecordSource(
            [
                user_visible_record("message-1"),
                assistant_visible_record("output-1"),
            ]
        )
        source = VisibleConversationRecentMessagesSource(record_source)

        messages = source.read_recent_visible_messages(recent_request())

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
            messages,
            [
                {
                    "schema_version": "0.1",
                    "message_id": "message-1",
                    "trace_id": "trace-message-1",
                    "source_event_id": "event-message-1",
                    "conversation_id": "conversation-1",
                    "role": "user",
                    "created_at": "2026-05-14T11:20:00+00:00",
                    "text": "previous user message",
                },
                {
                    "schema_version": "0.1",
                    "message_id": "output-1",
                    "trace_id": "trace-output-1",
                    "source_event_id": "event-output-1",
                    "conversation_id": "conversation-1",
                    "role": "assistant",
                    "created_at": "2026-05-14T11:21:00+00:00",
                    "text": "previous assistant reply",
                },
            ],
        )
        self.assertNotIn("kind", messages[0])
        self.assertNotIn("source", messages[0])
        self.assertNotIn("user_id", messages[0])
        self.assertNotIn("output_id", messages[1])

    def test_rejects_malformed_recent_message_request(self):
        cases = [
            ({**recent_request(), "schema_version": "0.2"}, "schema_version"),
            ({**recent_request(), "conversation_id": ""}, "conversation_id"),
            ({**recent_request(), "before_event_id": ""}, "before_event_id"),
            ({**recent_request(), "before_created_at": "2026-05-14"}, "before_created_at"),
            ({**recent_request(), "max_candidate_messages": 0}, "max_candidate_messages"),
            ({**recent_request(), "max_candidate_messages": True}, "max_candidate_messages"),
            ({**recent_request(), "future_field": "nope"}, "future_field"),
        ]

        for request, error_pattern in cases:
            with self.subTest(error_pattern=error_pattern):
                source = VisibleConversationRecentMessagesSource(
                    RecordingVisibleConversationRecordSource([])
                )
                with self.assertRaisesRegex(RoleModelValidationError, error_pattern):
                    source.read_recent_visible_messages(request)

    def test_rejects_malformed_visible_conversation_records(self):
        cases = [
            ([{**user_visible_record("message-1"), "kind": "system_message"}], "kind"),
            ([{**user_visible_record("message-1"), "schema_version": "0.2"}], "schema_version"),
            ([{**user_visible_record("message-1"), "conversation_id": "other"}], "conversation_id"),
            ([{**user_visible_record("message-1"), "message_id": ""}], "message_id"),
            ([{**assistant_visible_record("output-1"), "output_id": ""}], "output_id"),
            ([{**assistant_visible_record("output-1"), "created_at": "bad"}], "created_at"),
            ([{**assistant_visible_record("output-1"), "text": "   "}], "text"),
            ([{**user_visible_record("message-1"), "future_field": "nope"}], "future_field"),
            ("not a list", "VisibleConversationRecordSource"),
        ]

        for records, error_pattern in cases:
            with self.subTest(error_pattern=error_pattern):
                source = VisibleConversationRecentMessagesSource(
                    RecordingVisibleConversationRecordSource(records)
                )
                with self.assertRaisesRegex(RoleModelValidationError, error_pattern):
                    source.read_recent_visible_messages(recent_request())

    def test_copies_request_and_returned_records(self):
        request = recent_request()
        records = [user_visible_record("message-1")]
        source = VisibleConversationRecentMessagesSource(
            MutatingVisibleConversationRecordSource(records)
        )

        messages = source.read_recent_visible_messages(request)
        messages[0]["text"] = "mutated by caller"

        self.assertEqual(request["conversation_id"], "conversation-1")
        self.assertEqual(records[0]["text"], "previous user message")


class RoleModelLogEntryTests(unittest.TestCase):
    def test_completed_log_entry_deep_copies_snapshots(self):
        model_input = role_model_input()
        model_output = adapter_output(
            json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello"},
                }
            )
        )
        decision = {
            "schema_version": "0.1",
            "trace_id": "trace-1",
            "event_id": "event-1",
            "action": "visible_reply",
            "visible_reply": {"text": " hello "},
        }

        entry = build_role_model_turn_completed_log_entry(
            model_input,
            model_output,
            decision,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        model_input["decision_context"]["event"]["text"] = "mutated input"
        model_output["raw_text"] = "mutated output"
        decision["visible_reply"]["text"] = "mutated decision"

        self.assertEqual(
            entry["data"]["model_input"]["decision_context"]["event"]["text"],
            "hello",
        )
        self.assertNotEqual(entry["data"]["model_output"]["raw_text"], "mutated output")
        self.assertEqual(entry["data"]["decision"]["visible_reply"]["text"], "hello")

    def test_completed_log_entry_rejects_invalid_decision(self):
        model_input = role_model_input()
        model_output = adapter_output(
            json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello"},
                }
            )
        )
        decision = {
            "schema_version": "0.1",
            "trace_id": "wrong-trace",
            "event_id": "event-1",
            "action": "visible_reply",
            "visible_reply": {"text": "hello"},
        }

        with self.assertRaisesRegex(RoleModelValidationError, "trace_id"):
            build_role_model_turn_completed_log_entry(
                model_input,
                model_output,
                decision,
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
            )

    def test_failed_log_entry_rejects_invalid_failure_stage_or_code(self):
        model_input = role_model_input()

        with self.assertRaisesRegex(RoleModelValidationError, "failure.stage"):
            build_role_model_turn_failed_log_entry(
                model_input,
                stage="unknown",
                code="adapter_exception",
                message="failed",
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
            )

        with self.assertRaisesRegex(RoleModelValidationError, "failure.code"):
            build_role_model_turn_failed_log_entry(
                model_input,
                stage="adapter_call",
                code="malformed_model_output",
                message="failed",
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
            )


class CharacterDecisionParserTests(unittest.TestCase):
    def test_parses_valid_visible_reply_decision(self):
        decision = parse_character_decision(
            role_model_input(),
            adapter_output(
                json.dumps(
                    {
                        "schema_version": "0.1",
                        "action": "visible_reply",
                        "visible_reply": {"text": " Hi there. "},
                    }
                )
            ),
        )

        self.assertEqual(
            decision,
            {
                "schema_version": "0.1",
                "trace_id": "trace-1",
                "event_id": "event-1",
                "action": "visible_reply",
                "visible_reply": {"text": "Hi there."},
            },
        )

    def test_parses_valid_visible_reply_with_allowed_living_state_patch(self):
        model_input = render_role_model_input(
            build_decision_context(
                normalized_user_message(),
                current_state_source=RecordingCurrentStateSource(current_state_snapshot()),
                allow_state_patch=True,
            )
        )

        decision = parse_character_decision(
            model_input,
            adapter_output(
                json.dumps(
                    {
                        "schema_version": "0.1",
                        "action": "visible_reply",
                        "visible_reply": {"text": " Hi there. "},
                        "state_patch": {
                            "living_state": {
                                "current_activity": " answering the user ",
                                "mood": " attentive ",
                            }
                        },
                    }
                )
            ),
        )

        self.assertEqual(
            decision,
            {
                "schema_version": "0.1",
                "trace_id": "trace-1",
                "event_id": "event-1",
                "action": "visible_reply",
                "visible_reply": {"text": "Hi there."},
                "state_patch": {
                    "living_state": {
                        "current_activity": "answering the user",
                        "mood": "attentive",
                    }
                },
            },
        )

    def test_rejects_state_patch_when_model_input_did_not_allow_it(self):
        with self.assertRaisesRegex(RoleModelValidationError, "state_patch"):
            parse_character_decision(
                role_model_input(),
                adapter_output(
                    json.dumps(
                        {
                            "schema_version": "0.1",
                            "action": "visible_reply",
                            "visible_reply": {"text": "hello"},
                            "state_patch": {"living_state": {"mood": "focused"}},
                        }
                    )
                ),
            )

    def test_rejects_malformed_allowed_living_state_patch(self):
        model_input = render_role_model_input(
            build_decision_context(
                normalized_user_message(),
                current_state_source=RecordingCurrentStateSource(current_state_snapshot()),
                allow_state_patch=True,
            )
        )
        cases = [
            ({"living_state": {}}, "at least one"),
            ({"living_state": {"mood": "   "}}, "mood"),
            ({"living_state": {"body_state": "awake"}}, "body_state"),
            ({"body_state": {"fatigue": "low"}}, "body_state"),
        ]

        for patch, error_pattern in cases:
            with self.subTest(error_pattern=error_pattern):
                with self.assertRaisesRegex(RoleModelValidationError, error_pattern):
                    parse_character_decision(
                        model_input,
                        adapter_output(
                            json.dumps(
                                {
                                    "schema_version": "0.1",
                                    "action": "visible_reply",
                                    "visible_reply": {"text": "hello"},
                                    "state_patch": patch,
                                }
                            )
                        ),
                    )

    def test_rejects_malformed_model_output(self):
        cases = [
            ("not json", "raw_text"),
            (
                json.dumps(
                    {
                        "schema_version": "0.2",
                        "action": "visible_reply",
                        "visible_reply": {"text": "hello"},
                    }
                ),
                "schema_version",
            ),
            (
                json.dumps({"action": "visible_reply", "visible_reply": {"text": "hello"}}),
                "schema_version",
            ),
            (
                json.dumps(
                    {
                        "schema_version": "0.1",
                        "action": "state_patch",
                        "visible_reply": {"text": "hello"},
                    }
                ),
                "action",
            ),
            (
                json.dumps({"schema_version": "0.1", "action": "visible_reply"}),
                "visible_reply",
            ),
            (
                json.dumps(
                    {
                        "schema_version": "0.1",
                        "action": "visible_reply",
                        "visible_reply": {"text": "   "},
                    }
                ),
                "visible_reply.text",
            ),
            (
                json.dumps(
                    {
                        "schema_version": "0.1",
                        "action": "visible_reply",
                        "visible_reply": {"text": "hello"},
                        "extra": "field",
                    }
                ),
                "extra",
            ),
            (
                json.dumps(
                    {
                        "schema_version": "0.1",
                        "action": "visible_reply",
                        "visible_reply": {"text": "hello", "tone": "warm"},
                    }
                ),
                "extra",
            ),
        ]

        for raw_text, error_pattern in cases:
            with self.subTest(raw_text=raw_text):
                with self.assertRaisesRegex(RoleModelValidationError, error_pattern):
                    parse_character_decision(role_model_input(), adapter_output(raw_text))


if __name__ == "__main__":
    unittest.main()
