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
    RoleModelValidationError,
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
                "source_event_id",
            ),
        ]

        for messages, error_pattern in cases:
            with self.subTest(error_pattern=error_pattern):
                with self.assertRaisesRegex(RoleModelValidationError, error_pattern):
                    build_decision_context(
                        normalized_user_message(),
                        recent_visible_messages_source=RecordingRecentMessagesSource(messages),
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
