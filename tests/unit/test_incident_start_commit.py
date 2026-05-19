import sys
import unittest
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from commit_effects.incident_start import (  # noqa: E402
    LIFE_INCIDENT_START_FINALIZE_STAGE,
    LIFE_INCIDENT_START_REJECTED_STATUS,
    LIFE_INCIDENT_START_SKIPPED_STATUS,
    LIFE_INCIDENT_STARTED_STATUS,
    LifeIncidentStartFinalizerError,
    build_life_incident_start_commit_request,
    build_life_incident_start_finalize_request,
    build_life_incident_start_rejected_log_entry,
    build_life_incident_started_log_entry,
    build_started_life_incident_snapshot,
    commit_life_incident_start,
)


def fixed_clock():
    return datetime(2026, 5, 19, 9, 0, 0, tzinfo=UTC)


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
        self.entries.append(deepcopy(entry))


class RecordingLifeIncidentStartFinalizer:
    def __init__(self, error=None, result_override=None):
        self.error = error
        self.result_override = deepcopy(result_override)
        self.requests = []
        self.durable_started_incidents = []
        self.durable_success_logs = []

    def finalize_life_incident_start(self, request):
        self.requests.append(deepcopy(request))
        if self.error is not None:
            raise self.error
        if self.result_override is not None:
            return deepcopy(self.result_override)
        self.durable_started_incidents.append(deepcopy(request["started_incident"]))
        self.durable_success_logs.append(deepcopy(request["committed_log_entry"]))
        return {
            "schema_version": "0.1",
            "trace_id": request["trace_id"],
            "event_id": request["event_id"],
            "event_type": request["event_type"],
            "committed_log_entry_id": request["committed_log_entry"]["log_id"],
        }


def normalized_user_message():
    return {
        "event_id": "event-1",
        "trace_id": "trace-1",
        "type": "USER_MESSAGE",
        "created_at": "2026-05-19T08:59:00+00:00",
        "schema_version": "0.1",
        "payload": {
            "text": "hello",
            "user_id": "user-1",
            "conversation_id": "conversation-1",
        },
    }


def incident_draft():
    return {
        "type": "think",
        "title": "thinking through the plan",
        "remaining_seconds": 300,
        "interrupt_policy": "interruptible",
        "resume_policy": "ask_model",
    }


def role_model_result_with_incident():
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
            "visible_reply": {"text": "hello back"},
            "life_action": {
                "type": "start_incident",
                "incident": incident_draft(),
            },
        },
    }


def role_model_result_without_incident():
    result = role_model_result_with_incident()
    del result["decision"]["life_action"]
    return result


class IncidentStartCommitTests(unittest.TestCase):
    def test_builds_commit_request_without_model_authored_committed_fields(self):
        result = role_model_result_with_incident()
        result["decision"]["life_action"]["incident"]["title"] = " Thinking "

        request = build_life_incident_start_commit_request(
            normalized_user_message(),
            result,
        )

        self.assertEqual(
            request,
            {
                "schema_version": "0.1",
                "trace_id": "trace-1",
                "event_id": "event-1",
                "event_type": "USER_MESSAGE",
                "decision_action": "visible_reply",
                "life_action_type": "start_incident",
                "draft": {
                    "type": "think",
                    "title": "Thinking",
                    "remaining_seconds": 300,
                    "interrupt_policy": "interruptible",
                    "resume_policy": "ask_model",
                },
                "user_id": "user-1",
                "conversation_id": "conversation-1",
            },
        )
        self.assertNotIn("incident_id", request["draft"])
        self.assertNotIn("status", request["draft"])
        self.assertNotIn("started_at", request["draft"])
        self.assertNotIn("source_event_ids", request["draft"])

    def test_returns_skipped_without_log_or_finalizer_call_when_decision_has_no_life_action(self):
        raw_log = RecordingRawEventLog()
        finalizer = RecordingLifeIncidentStartFinalizer()

        result = commit_life_incident_start(
            normalized_user_message(),
            role_model_result_without_incident(),
            life_incident_start_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_START_SKIPPED_STATUS)
        self.assertEqual(finalizer.requests, [])
        self.assertEqual(raw_log.entries, [])

    def test_commits_started_incident_through_atomic_finalizer_and_uses_copies(self):
        raw_log = RecordingRawEventLog()
        finalizer = RecordingLifeIncidentStartFinalizer()
        event = normalized_user_message()
        role_model_result = role_model_result_with_incident()

        result = commit_life_incident_start(
            event,
            role_model_result,
            life_incident_start_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        event["payload"]["text"] = "mutated event"
        role_model_result["decision"]["life_action"]["incident"]["title"] = "mutated"
        result["started_incident"]["title"] = "mutated result"
        finalizer.requests[0]["started_incident"]["title"] = "mutated request"
        finalizer.requests[0]["committed_log_entry"]["data"]["source_event"]["payload"]["text"] = (
            "mutated request"
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_STARTED_STATUS)
        self.assertEqual(
            result["committed_log_entry_id"],
            finalizer.durable_success_logs[0]["log_id"],
        )
        self.assertEqual(raw_log.entries, [])
        self.assertEqual(len(finalizer.requests), 1)
        self.assertEqual(finalizer.requests[0]["commit_time"], "2026-05-19T09:00:00+00:00")
        self.assertEqual(
            finalizer.durable_started_incidents[0],
            {
                "schema_version": "0.1",
                "incident_id": "incident-generated-1",
                "type": "think",
                "status": "active",
                "title": "thinking through the plan",
                "started_at": "2026-05-19T09:00:00+00:00",
                "remaining_seconds": 300,
                "interrupt_policy": "interruptible",
                "resume_policy": "ask_model",
                "source_event_ids": ["event-1"],
            },
        )
        self.assertEqual(finalizer.durable_success_logs[0]["kind"], "life_incident_started")
        self.assertEqual(
            finalizer.durable_success_logs[0]["data"]["source_event"]["payload"]["text"],
            "hello",
        )
        self.assertEqual(
            finalizer.durable_success_logs[0]["data"]["draft"]["title"],
            "thinking through the plan",
        )

    def test_finalizer_failure_rejects_without_durable_incident_or_success_log(self):
        raw_log = RecordingRawEventLog()
        finalizer = RecordingLifeIncidentStartFinalizer(
            error=LifeIncidentStartFinalizerError(
                "finalize rejected",
                code="finalize_rejected",
            )
        )

        result = commit_life_incident_start(
            normalized_user_message(),
            role_model_result_with_incident(),
            life_incident_start_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_START_REJECTED_STATUS)
        self.assertEqual(result["failure"]["stage"], LIFE_INCIDENT_START_FINALIZE_STAGE)
        self.assertEqual(result["failure"]["code"], "finalize_rejected")
        self.assertEqual(finalizer.durable_started_incidents, [])
        self.assertEqual(finalizer.durable_success_logs, [])
        self.assertEqual(raw_log.entries[0]["kind"], "life_incident_start_rejected")
        self.assertEqual(raw_log.entries[0]["data"]["failure"], result["failure"])

    def test_malformed_finalizer_result_means_no_durable_visibility_occurred(self):
        raw_log = RecordingRawEventLog()
        finalizer = RecordingLifeIncidentStartFinalizer(
            result_override={
                "schema_version": "0.1",
                "trace_id": "trace-1",
                "event_id": "event-1",
                "event_type": "USER_MESSAGE",
                "committed_log_entry_id": "wrong-log-id",
            }
        )

        result = commit_life_incident_start(
            normalized_user_message(),
            role_model_result_with_incident(),
            life_incident_start_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_START_REJECTED_STATUS)
        self.assertEqual(result["failure"]["stage"], LIFE_INCIDENT_START_FINALIZE_STAGE)
        self.assertEqual(result["failure"]["code"], "malformed_finalize_result")
        self.assertEqual(finalizer.durable_started_incidents, [])
        self.assertEqual(finalizer.durable_success_logs, [])
        self.assertEqual(raw_log.entries[0]["kind"], "life_incident_start_rejected")

    def test_started_incident_snapshot_reuses_active_incident_validation(self):
        snapshot = build_started_life_incident_snapshot(
            normalized_user_message(),
            incident_draft(),
            commit_time="2026-05-19T09:00:00+00:00",
            id_generator=SequenceIdGenerator(),
        )

        self.assertEqual(snapshot["status"], "active")
        self.assertEqual(snapshot["source_event_ids"], ["event-1"])
        self.assertEqual(snapshot["started_at"], "2026-05-19T09:00:00+00:00")

        with self.assertRaisesRegex(ValueError, "status"):
            build_life_incident_start_finalize_request(
                {
                    **build_life_incident_start_commit_request(
                        normalized_user_message(),
                        role_model_result_with_incident(),
                    ),
                    "commit_time": "2026-05-19T09:00:00+00:00",
                },
                started_incident={**snapshot, "status": "queued"},
                committed_log_entry=build_life_incident_started_log_entry(
                    normalized_user_message(),
                    role_model_result_with_incident(),
                    incident_draft(),
                    snapshot,
                    id_generator=SequenceIdGenerator(),
                    clock=fixed_clock,
                ),
            )

    def test_committed_and_rejected_log_entries_deep_copy_inputs(self):
        event = normalized_user_message()
        role_model_result = role_model_result_with_incident()
        draft = incident_draft()
        started_incident = build_started_life_incident_snapshot(
            event,
            draft,
            commit_time="2026-05-19T09:00:00+00:00",
            id_generator=SequenceIdGenerator(),
        )

        committed = build_life_incident_started_log_entry(
            event,
            role_model_result,
            draft,
            started_incident,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )
        failure = {
            "stage": "life_incident_start_finalize",
            "code": "finalize_rejected",
            "message": "finalize rejected",
        }
        rejected = build_life_incident_start_rejected_log_entry(
            event,
            role_model_result_snapshot=role_model_result,
            draft_snapshot=draft,
            started_incident_snapshot=started_incident,
            failure=failure,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        event["payload"]["text"] = "mutated"
        role_model_result["decision"]["visible_reply"]["text"] = "mutated"
        draft["title"] = "mutated"
        started_incident["title"] = "mutated"
        failure["message"] = "mutated"

        self.assertEqual(committed["kind"], "life_incident_started")
        self.assertEqual(committed["data"]["source_event"]["payload"]["text"], "hello")
        self.assertEqual(
            committed["data"]["role_model_result"]["decision"]["visible_reply"]["text"],
            "hello back",
        )
        self.assertEqual(committed["data"]["draft"]["title"], "thinking through the plan")
        self.assertEqual(
            committed["data"]["started_incident"]["title"],
            "thinking through the plan",
        )
        self.assertEqual(rejected["kind"], "life_incident_start_rejected")
        self.assertEqual(rejected["data"]["draft_snapshot"]["title"], "thinking through the plan")
        self.assertEqual(rejected["data"]["failure"]["message"], "finalize rejected")


if __name__ == "__main__":
    unittest.main()
