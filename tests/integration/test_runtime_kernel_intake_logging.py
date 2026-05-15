import sys
import unittest
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from runtime.kernel import RuntimeKernel, RuntimeValidationError  # noqa: E402


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


class FailingRawEventLog:
    def append(self, entry):
        raise RuntimeError("append failed")


class RuntimeKernelIntakeLoggingTests(unittest.TestCase):
    def test_user_message_intake_appends_one_raw_log_and_routes_logged_only(self):
        raw_log = RecordingRawEventLog()
        kernel = RuntimeKernel(raw_log, id_generator=SequenceIdGenerator(), clock=fixed_clock)

        route = kernel.handle_event(
            {
                "type": "USER_MESSAGE",
                "payload": {
                    "text": "hello",
                    "user_id": "u-1",
                    "conversation_id": "c-1",
                },
            }
        )

        self.assertEqual(
            route,
            {
                "trace_id": "trace-generated-2",
                "event_id": "event-generated-1",
                "event_type": "USER_MESSAGE",
                "model_needed": False,
                "next_step": "logged_only",
            },
        )
        self.assertEqual(len(raw_log.entries), 1)
        self.assertEqual(raw_log.entries[0]["log_id"], "log-generated-3")
        self.assertEqual(raw_log.entries[0]["kind"], "runtime_event_received")
        self.assertEqual(raw_log.entries[0]["trace_id"], "trace-generated-2")
        self.assertEqual(raw_log.entries[0]["event_id"], "event-generated-1")
        self.assertEqual(raw_log.entries[0]["schema_version"], "0.1")
        self.assertEqual(
            raw_log.entries[0]["data"]["event"]["payload"],
            {"text": "hello", "user_id": "u-1", "conversation_id": "c-1"},
        )

    def test_validation_failure_does_not_append_raw_log(self):
        raw_log = RecordingRawEventLog()
        kernel = RuntimeKernel(raw_log, id_generator=SequenceIdGenerator(), clock=fixed_clock)

        with self.assertRaises(RuntimeValidationError):
            kernel.handle_event({"type": "TIMER", "payload": {"text": "hello"}})

        self.assertEqual(raw_log.entries, [])

    def test_malformed_created_at_does_not_append_raw_log(self):
        for created_at in (None, "2026-05-14"):
            with self.subTest(created_at=created_at):
                raw_log = RecordingRawEventLog()
                kernel = RuntimeKernel(
                    raw_log, id_generator=SequenceIdGenerator(), clock=fixed_clock
                )

                with self.assertRaisesRegex(RuntimeValidationError, "created_at"):
                    kernel.handle_event(
                        {
                            "type": "USER_MESSAGE",
                            "created_at": created_at,
                            "payload": {"text": "hello"},
                        }
                    )

                self.assertEqual(raw_log.entries, [])

    def test_raw_log_append_failure_does_not_return_successful_route(self):
        kernel = RuntimeKernel(
            FailingRawEventLog(), id_generator=SequenceIdGenerator(), clock=fixed_clock
        )

        with self.assertRaisesRegex(RuntimeError, "append failed"):
            kernel.handle_event({"type": "USER_MESSAGE", "payload": {"text": "hello"}})


if __name__ == "__main__":
    unittest.main()
