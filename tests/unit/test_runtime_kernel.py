import sys
import unittest
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from runtime.kernel import (  # noqa: E402
    RuntimeValidationError,
    build_raw_event_log_entry,
    intake_runtime_event,
    normalize_runtime_event,
    route_runtime_event,
)


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


class RuntimeEventNormalizationTests(unittest.TestCase):
    def test_normalizes_user_message_with_missing_ids(self):
        ids = SequenceIdGenerator()

        event = normalize_runtime_event(
            {
                "type": "USER_MESSAGE",
                "payload": {"text": "  hello  ", "user_id": "u-1"},
            },
            id_generator=ids,
            clock=fixed_clock,
        )

        self.assertEqual(
            event,
            {
                "event_id": "event-generated-1",
                "trace_id": "trace-generated-2",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "schema_version": "0.1",
                "payload": {"text": "  hello  ", "user_id": "u-1"},
            },
        )
        self.assertEqual(ids.calls, ["event", "trace"])

    def test_preserves_existing_ids_and_created_at(self):
        ids = SequenceIdGenerator()

        event = normalize_runtime_event(
            {
                "event_id": "event-existing",
                "trace_id": "trace-existing",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T10:20:30Z",
                "schema_version": "0.1",
                "payload": {"text": "hello"},
            },
            id_generator=ids,
            clock=fixed_clock,
        )

        self.assertEqual(event["event_id"], "event-existing")
        self.assertEqual(event["trace_id"], "trace-existing")
        self.assertEqual(event["created_at"], "2026-05-14T10:20:30Z")
        self.assertEqual(ids.calls, [])

    def test_assigns_schema_version_when_missing(self):
        event = normalize_runtime_event(
            {"type": "USER_MESSAGE", "payload": {"text": "hello"}},
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(event["schema_version"], "0.1")

    def test_rejects_unsupported_schema_version(self):
        with self.assertRaisesRegex(RuntimeValidationError, "schema_version"):
            normalize_runtime_event(
                {
                    "type": "USER_MESSAGE",
                    "schema_version": "0.2",
                    "payload": {"text": "hello"},
                },
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
            )

    def test_preserves_valid_provided_created_at(self):
        event = normalize_runtime_event(
            {
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T10:20:30+00:00",
                "payload": {"text": "hello"},
            },
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(event["created_at"], "2026-05-14T10:20:30+00:00")

    def test_rejects_malformed_created_at(self):
        for created_at in (None, "not a timestamp", "2026-05-14"):
            with self.subTest(created_at=created_at):
                with self.assertRaisesRegex(RuntimeValidationError, "created_at"):
                    normalize_runtime_event(
                        {
                            "type": "USER_MESSAGE",
                            "created_at": created_at,
                            "payload": {"text": "hello"},
                        },
                        id_generator=SequenceIdGenerator(),
                        clock=fixed_clock,
                    )

    def test_rejects_unsupported_event_type(self):
        with self.assertRaisesRegex(RuntimeValidationError, "Unsupported event type"):
            normalize_runtime_event(
                {"type": "TIMER", "payload": {"text": "hello"}},
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
            )

    def test_rejects_empty_text(self):
        for text in ("", "   "):
            with self.subTest(text=repr(text)):
                with self.assertRaisesRegex(RuntimeValidationError, "payload.text"):
                    normalize_runtime_event(
                        {"type": "USER_MESSAGE", "payload": {"text": text}},
                        id_generator=SequenceIdGenerator(),
                        clock=fixed_clock,
                    )

    def test_returns_deterministic_user_turn_route(self):
        event = {
            "event_id": "event-1",
            "trace_id": "trace-1",
            "type": "USER_MESSAGE",
            "created_at": "2026-05-14T11:30:00+00:00",
            "schema_version": "0.1",
            "payload": {"text": "hello"},
        }

        route = route_runtime_event(event)

        self.assertEqual(
            route,
            {
                "trace_id": "trace-1",
                "event_id": "event-1",
                "event_type": "USER_MESSAGE",
                "model_needed": True,
                "next_step": "user_turn",
            },
        )

    def test_shared_intake_appends_log_and_returns_normalized_event_with_route(self):
        ids = SequenceIdGenerator()
        raw_log = RecordingRawEventLog()

        result = intake_runtime_event(
            {"type": "USER_MESSAGE", "payload": {"text": "hello"}},
            raw_event_log=raw_log,
            id_generator=ids,
            clock=fixed_clock,
        )

        self.assertEqual(result["event"]["event_id"], "event-generated-1")
        self.assertEqual(result["event"]["trace_id"], "trace-generated-2")
        self.assertEqual(
            result["route"],
            {
                "trace_id": "trace-generated-2",
                "event_id": "event-generated-1",
                "event_type": "USER_MESSAGE",
                "model_needed": True,
                "next_step": "user_turn",
            },
        )
        self.assertEqual(len(raw_log.entries), 1)
        self.assertEqual(raw_log.entries[0]["kind"], "runtime_event_received")

    def test_raw_event_log_entry_copies_event_snapshot(self):
        event = {
            "event_id": "event-1",
            "trace_id": "trace-1",
            "type": "USER_MESSAGE",
            "created_at": "2026-05-14T11:30:00+00:00",
            "schema_version": "0.1",
            "payload": {"text": "hello"},
        }

        entry = build_raw_event_log_entry(
            event,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )
        event["payload"]["text"] = "mutated"

        self.assertEqual(entry["data"]["event"]["payload"]["text"], "hello")

    def test_rejects_unknown_event_route_instead_of_defaulting_logged_only(self):
        event = {
            "event_id": "event-1",
            "trace_id": "trace-1",
            "type": "FUTURE_EVENT_SENTINEL",
            "created_at": "2026-05-14T11:30:00+00:00",
            "schema_version": "0.1",
            "payload": {},
        }

        with self.assertRaisesRegex(RuntimeValidationError, "routing"):
            route_runtime_event(event)


if __name__ == "__main__":
    unittest.main()
