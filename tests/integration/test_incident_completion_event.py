import sys
import unittest
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from character.state.current import build_active_incident_request  # noqa: E402
from character.state.incidents import InMemoryLifeIncidentStore  # noqa: E402
from commit_effects.incident_complete import (  # noqa: E402
    LIFE_INCIDENT_COMPLETE_REJECTED_STATUS,
    LIFE_INCIDENT_COMPLETED_STATUS,
    commit_life_incident_completion_event,
)
from commit_effects.incident_start import (  # noqa: E402
    LIFE_INCIDENT_STARTED_STATUS,
    commit_life_incident_start,
)
from runtime.kernel import intake_runtime_event  # noqa: E402
from runtime.logging import InMemoryRawEventLog  # noqa: E402


def fixed_clock():
    return datetime(2026, 5, 24, 9, 0, 0, tzinfo=UTC)


class SequenceIdGenerator:
    def __init__(self):
        self.calls = []

    def __call__(self, kind):
        self.calls.append(kind)
        return f"{kind}-generated-{len(self.calls)}"


def start_event():
    return {
        "event_id": "event-start",
        "trace_id": "trace-start",
        "type": "USER_MESSAGE",
        "created_at": "2026-05-24T08:45:00+00:00",
        "schema_version": "0.1",
        "payload": {
            "text": "take a moment",
            "user_id": "user-1",
            "conversation_id": "conversation-1",
        },
    }


def role_model_result_with_incident():
    return {
        "trace_id": "trace-start",
        "event_id": "event-start",
        "event_type": "USER_MESSAGE",
        "model_called": True,
        "status": "decision_ready_for_commit",
        "decision": {
            "schema_version": "0.1",
            "trace_id": "trace-start",
            "event_id": "event-start",
            "action": "visible_reply",
            "visible_reply": {"text": "I will think it through."},
            "life_action": {
                "type": "start_incident",
                "incident": {
                    "type": "think",
                    "title": "thinking through the plan",
                    "remaining_seconds": 300,
                    "interrupt_policy": "interruptible",
                    "resume_policy": "ask_model",
                },
            },
        },
    }


class IncidentCompletionEventIntegrationTests(unittest.TestCase):
    def test_kernel_intake_and_commit_complete_matching_active_incident(self):
        raw_log = InMemoryRawEventLog()
        store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        ids = SequenceIdGenerator()

        start_result = commit_life_incident_start(
            start_event(),
            role_model_result_with_incident(),
            life_incident_start_finalizer=store,
            raw_event_log=raw_log,
            id_generator=ids,
            clock=fixed_clock,
        )
        intake_result = intake_runtime_event(
            {
                "event_id": "event-completion",
                "trace_id": "trace-completion",
                "type": "INCIDENT_COMPLETION",
                "created_at": "2026-05-24T08:59:00+00:00",
                "schema_version": "0.1",
                "payload": {
                    "incident_id": "incident-generated-1",
                    "user_id": "user-1",
                    "conversation_id": "conversation-1",
                },
            },
            raw_event_log=raw_log,
            id_generator=ids,
            clock=fixed_clock,
        )

        result = commit_life_incident_completion_event(
            intake_result["event"],
            active_incident_source=store,
            life_incident_complete_finalizer=store,
            raw_event_log=raw_log,
            id_generator=ids,
            clock=fixed_clock,
        )
        completion_entries = raw_log.query(
            {"trace_id": "trace-completion", "kinds": ["life_incident_completed"]}
        )["entries"]

        self.assertEqual(start_result["status"], LIFE_INCIDENT_STARTED_STATUS)
        self.assertEqual(
            intake_result["route"],
            {
                "trace_id": "trace-completion",
                "event_id": "event-completion",
                "event_type": "INCIDENT_COMPLETION",
                "model_needed": False,
                "next_step": "incident_completion_commit",
            },
        )
        self.assertEqual(result["status"], LIFE_INCIDENT_COMPLETED_STATUS)
        self.assertEqual(result["event_type"], "INCIDENT_COMPLETION")
        self.assertIsNone(
            store.read_active_incident(build_active_incident_request(intake_result["event"]))
        )
        self.assertEqual(len(completion_entries), 1)
        self.assertEqual(result["committed_log_entry_id"], completion_entries[0]["log_id"])
        self.assertEqual(
            completion_entries[0]["data"]["completion_source"],
            "incident_completion_event",
        )
        self.assertEqual(
            completion_entries[0]["data"]["completed_incident"]["source_event_ids"],
            ["event-start", "event-completion"],
        )

    def test_event_with_no_active_incident_rejects_without_model_logs(self):
        raw_log = InMemoryRawEventLog()
        store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        ids = SequenceIdGenerator()
        intake_result = intake_runtime_event(
            {
                "event_id": "event-completion",
                "trace_id": "trace-completion",
                "type": "INCIDENT_COMPLETION",
                "created_at": "2026-05-24T08:59:00+00:00",
                "schema_version": "0.1",
                "payload": {"incident_id": "incident-missing"},
            },
            raw_event_log=raw_log,
            id_generator=ids,
            clock=fixed_clock,
        )

        result = commit_life_incident_completion_event(
            intake_result["event"],
            active_incident_source=store,
            life_incident_complete_finalizer=store,
            raw_event_log=raw_log,
            id_generator=ids,
            clock=fixed_clock,
        )
        entries = raw_log.query({"trace_id": "trace-completion"})["entries"]

        self.assertEqual(result["status"], LIFE_INCIDENT_COMPLETE_REJECTED_STATUS)
        self.assertEqual(
            [entry["kind"] for entry in entries],
            ["runtime_event_received", "life_incident_complete_rejected"],
        )
        self.assertEqual(entries[1]["data"]["completion_source"], "incident_completion_event")
        self.assertNotIn("role_model_result_snapshot", entries[1]["data"])

    def test_mismatched_event_leaves_original_active_incident_visible(self):
        raw_log = InMemoryRawEventLog()
        store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        ids = SequenceIdGenerator()
        start = start_event()
        commit_life_incident_start(
            start,
            role_model_result_with_incident(),
            life_incident_start_finalizer=store,
            raw_event_log=raw_log,
            id_generator=ids,
            clock=fixed_clock,
        )
        intake_result = intake_runtime_event(
            {
                "event_id": "event-completion",
                "trace_id": "trace-completion",
                "type": "INCIDENT_COMPLETION",
                "created_at": "2026-05-24T08:59:00+00:00",
                "schema_version": "0.1",
                "payload": {
                    "incident_id": "incident-other",
                    "user_id": "user-1",
                    "conversation_id": "conversation-1",
                },
            },
            raw_event_log=raw_log,
            id_generator=ids,
            clock=fixed_clock,
        )

        result = commit_life_incident_completion_event(
            intake_result["event"],
            active_incident_source=store,
            life_incident_complete_finalizer=store,
            raw_event_log=raw_log,
            id_generator=ids,
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_COMPLETE_REJECTED_STATUS)
        self.assertEqual(result["failure"]["code"], "incident_id_mismatch")
        self.assertEqual(
            store.read_active_incident(build_active_incident_request(start))["incident_id"],
            "incident-generated-1",
        )


if __name__ == "__main__":
    unittest.main()
