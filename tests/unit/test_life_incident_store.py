import sys
import unittest
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from character.state.current import build_active_incident_request  # noqa: E402
from character.state.incidents import InMemoryLifeIncidentStore  # noqa: E402
from commit_effects.incident_start import (  # noqa: E402
    LIFE_INCIDENT_START_REJECTED_STATUS,
    LIFE_INCIDENT_STARTED_STATUS,
    commit_life_incident_start,
)
from runtime.logging import InMemoryRawEventLog, RawEventLogQueryValidationError  # noqa: E402


def fixed_clock():
    return datetime(2026, 5, 20, 9, 0, 0, tzinfo=UTC)


class SequenceIdGenerator:
    def __init__(self):
        self.calls = []

    def __call__(self, kind):
        self.calls.append(kind)
        return f"{kind}-generated-{len(self.calls)}"


class RejectingRawEventLog(InMemoryRawEventLog):
    def expose_committed_success_entry(self, entry):
        raise RawEventLogQueryValidationError("visibility staging failed")


def normalized_user_message(*, event_id="event-1", trace_id="trace-1"):
    return {
        "event_id": event_id,
        "trace_id": trace_id,
        "type": "USER_MESSAGE",
        "created_at": "2026-05-20T08:59:00+00:00",
        "schema_version": "0.1",
        "payload": {
            "text": "hello",
            "user_id": "user-1",
            "conversation_id": "conversation-1",
        },
    }


def role_model_result_with_incident(*, event_id="event-1", trace_id="trace-1", title=None):
    return {
        "trace_id": trace_id,
        "event_id": event_id,
        "event_type": "USER_MESSAGE",
        "model_called": True,
        "status": "decision_ready_for_commit",
        "decision": {
            "schema_version": "0.1",
            "trace_id": trace_id,
            "event_id": event_id,
            "action": "visible_reply",
            "visible_reply": {"text": "hello back"},
            "life_action": {
                "type": "start_incident",
                "incident": {
                    "type": "think",
                    "title": title or "thinking through the plan",
                    "remaining_seconds": 300,
                    "interrupt_policy": "interruptible",
                    "resume_policy": "ask_model",
                },
            },
        },
    }


class InMemoryLifeIncidentStoreTests(unittest.TestCase):
    def test_finalizes_start_and_reads_active_incident_through_existing_contract(self):
        raw_log = InMemoryRawEventLog()
        store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        event = normalized_user_message()
        role_model_result = role_model_result_with_incident()

        result = commit_life_incident_start(
            event,
            role_model_result,
            life_incident_start_finalizer=store,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        read_request = build_active_incident_request(event)
        active_incident = store.read_active_incident(read_request)
        success_entries = raw_log.query(
            {"trace_id": result["trace_id"], "kinds": ["life_incident_started"]}
        )["entries"]

        self.assertEqual(result["status"], LIFE_INCIDENT_STARTED_STATUS)
        self.assertEqual(len(success_entries), 1)
        self.assertEqual(result["committed_log_entry_id"], success_entries[0]["log_id"])
        self.assertEqual(active_incident["incident_id"], "incident-generated-1")
        self.assertEqual(active_incident["started_at"], "2026-05-20T09:00:00+00:00")
        self.assertEqual(active_incident["source_event_ids"], ["event-1"])
        self.assertEqual(success_entries[0]["trace_id"], "trace-1")
        self.assertEqual(success_entries[0]["event_id"], "event-1")
        self.assertEqual(
            success_entries[0]["data"]["started_incident"],
            active_incident,
        )

        event["payload"]["text"] = "mutated event"
        role_model_result["decision"]["life_action"]["incident"]["title"] = "mutated role result"
        active_incident["title"] = "mutated read"
        success_entries[0]["data"]["started_incident"]["title"] = "mutated query"

        self.assertEqual(
            store.read_active_incident(read_request)["title"],
            "thinking through the plan",
        )
        self.assertEqual(
            raw_log.query({"trace_id": "trace-1", "kinds": ["life_incident_started"]})[
                "entries"
            ][0]["data"]["started_incident"]["title"],
            "thinking through the plan",
        )

    def test_visibility_staging_failure_rejects_without_storing_active_incident(self):
        raw_log = RejectingRawEventLog()
        store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        event = normalized_user_message()

        result = commit_life_incident_start(
            event,
            role_model_result_with_incident(),
            life_incident_start_finalizer=store,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_START_REJECTED_STATUS)
        self.assertEqual(result["failure"]["stage"], "life_incident_start_finalize")
        self.assertEqual(result["failure"]["code"], "malformed_finalize_result")
        self.assertEqual(store.read_active_incident(build_active_incident_request(event)), None)
        self.assertEqual(
            raw_log.query({"trace_id": "trace-1", "kinds": ["life_incident_started"]})["entries"],
            [],
        )

    def test_second_start_fails_closed_without_overwriting_active_incident(self):
        raw_log = InMemoryRawEventLog()
        store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        first_event = normalized_user_message(event_id="event-1", trace_id="trace-1")
        second_event = normalized_user_message(event_id="event-2", trace_id="trace-2")

        first_result = commit_life_incident_start(
            first_event,
            role_model_result_with_incident(event_id="event-1", trace_id="trace-1"),
            life_incident_start_finalizer=store,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )
        first_incident = deepcopy(
            store.read_active_incident(build_active_incident_request(first_event))
        )
        second_result = commit_life_incident_start(
            second_event,
            role_model_result_with_incident(
                event_id="event-2",
                trace_id="trace-2",
                title="second incident",
            ),
            life_incident_start_finalizer=store,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(first_result["status"], LIFE_INCIDENT_STARTED_STATUS)
        self.assertEqual(second_result["status"], LIFE_INCIDENT_START_REJECTED_STATUS)
        self.assertIn("already exists", second_result["failure"]["message"])
        self.assertEqual(
            store.read_active_incident(build_active_incident_request(second_event)),
            first_incident,
        )
        self.assertEqual(
            raw_log.query({"trace_id": "trace-2", "kinds": ["life_incident_started"]})[
                "entries"
            ],
            [],
        )
        self.assertEqual(
            raw_log.query({"trace_id": "trace-1", "kinds": ["life_incident_started"]})[
                "entries"
            ][0]["data"]["started_incident"],
            first_incident,
        )


if __name__ == "__main__":
    unittest.main()
