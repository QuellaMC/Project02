import sys
import unittest
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from commit_effects.incident_cancel import (  # noqa: E402
    LIFE_INCIDENT_CANCEL_FINALIZE_STAGE,
    LIFE_INCIDENT_CANCEL_REJECTED_STATUS,
    LIFE_INCIDENT_CANCEL_SKIPPED_STATUS,
    LIFE_INCIDENT_CANCELLED_STATUS,
    LifeIncidentCancelFinalizerError,
    build_cancelled_life_incident_snapshot,
    build_life_incident_cancel_commit_request,
    build_life_incident_cancel_finalize_request,
    build_life_incident_cancel_rejected_log_entry,
    build_life_incident_cancelled_log_entry,
    commit_life_incident_cancel,
)


def fixed_clock():
    return datetime(2026, 5, 22, 9, 0, 0, tzinfo=UTC)


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


class RecordingActiveIncidentSource:
    def __init__(self, snapshot):
        self.snapshot = deepcopy(snapshot)
        self.requests = []

    def read_active_incident(self, request):
        self.requests.append(deepcopy(request))
        return deepcopy(self.snapshot)


class RecordingLifeIncidentCancelFinalizer:
    def __init__(self, error=None, result_override=None):
        self.error = error
        self.result_override = deepcopy(result_override)
        self.requests = []
        self.durable_cancelled_incidents = []
        self.durable_raw_event_log_entries = []

    def finalize_life_incident_cancel(self, request):
        self.requests.append(deepcopy(request))
        if self.error is not None:
            raise self.error
        if self.result_override is not None:
            return deepcopy(self.result_override)
        self.durable_cancelled_incidents.append(deepcopy(request["cancelled_incident"]))
        self.durable_raw_event_log_entries.append(deepcopy(request["committed_log_entry"]))
        return {
            "schema_version": "0.1",
            "trace_id": request["trace_id"],
            "event_id": request["event_id"],
            "event_type": request["event_type"],
            "committed_log_entry_id": request["committed_log_entry"]["log_id"],
        }


def normalized_user_message():
    return {
        "event_id": "event-cancel",
        "trace_id": "trace-cancel",
        "type": "USER_MESSAGE",
        "created_at": "2026-05-22T08:59:00+00:00",
        "schema_version": "0.1",
        "payload": {
            "text": "stop that",
            "user_id": "user-1",
            "conversation_id": "conversation-1",
        },
    }


def active_incident_snapshot():
    return {
        "schema_version": "0.1",
        "incident_id": "incident-1",
        "type": "think",
        "status": "active",
        "title": "thinking through the plan",
        "started_at": "2026-05-22T08:40:00+00:00",
        "remaining_seconds": 300,
        "interrupt_policy": "interruptible",
        "resume_policy": "ask_model",
        "source_event_ids": ["event-start"],
    }


def role_model_result_with_cancel(*, incident_id="incident-1", reason="User needs me now."):
    return {
        "trace_id": "trace-cancel",
        "event_id": "event-cancel",
        "event_type": "USER_MESSAGE",
        "model_called": True,
        "status": "decision_ready_for_commit",
        "decision": {
            "schema_version": "0.1",
            "trace_id": "trace-cancel",
            "event_id": "event-cancel",
            "action": "visible_reply",
            "visible_reply": {"text": "hello back"},
            "life_action": {
                "type": "cancel_incident",
                "incident_id": incident_id,
                "reason": reason,
            },
        },
    }


def role_model_result_without_life_action():
    result = role_model_result_with_cancel()
    del result["decision"]["life_action"]
    return result


class IncidentCancelCommitTests(unittest.TestCase):
    def test_builds_commit_request_from_cancel_life_action(self):
        result = role_model_result_with_cancel(
            incident_id=" incident-1 ",
            reason=" User needs attention now. ",
        )

        request = build_life_incident_cancel_commit_request(
            normalized_user_message(),
            result,
        )

        self.assertEqual(
            request,
            {
                "schema_version": "0.1",
                "trace_id": "trace-cancel",
                "event_id": "event-cancel",
                "event_type": "USER_MESSAGE",
                "decision_action": "visible_reply",
                "life_action_type": "cancel_incident",
                "incident_id": "incident-1",
                "reason": "User needs attention now.",
                "user_id": "user-1",
                "conversation_id": "conversation-1",
            },
        )

    def test_finalize_request_allows_normalized_empty_optional_identity_fields(self):
        event = normalized_user_message()
        event["payload"]["user_id"] = ""
        event["payload"]["conversation_id"] = ""
        role_model_result = role_model_result_with_cancel()
        active_incident = active_incident_snapshot()
        request = build_life_incident_cancel_commit_request(event, role_model_result)
        request["commit_time"] = "2026-05-22T09:00:00+00:00"
        cancelled_incident = build_cancelled_life_incident_snapshot(
            active_incident,
            request,
        )
        committed_log_entry = build_life_incident_cancelled_log_entry(
            event,
            role_model_result,
            role_model_result["decision"]["life_action"],
            active_incident,
            cancelled_incident,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        finalize_request = build_life_incident_cancel_finalize_request(
            request,
            active_incident=active_incident,
            cancelled_incident=cancelled_incident,
            committed_log_entry=committed_log_entry,
        )

        self.assertEqual(finalize_request["user_id"], "")
        self.assertEqual(finalize_request["conversation_id"], "")

    def test_returns_skipped_without_active_read_or_finalizer_call_when_no_life_action(self):
        raw_log = RecordingRawEventLog()
        active_source = RecordingActiveIncidentSource(active_incident_snapshot())
        finalizer = RecordingLifeIncidentCancelFinalizer()

        result = commit_life_incident_cancel(
            normalized_user_message(),
            role_model_result_without_life_action(),
            active_incident_source=active_source,
            life_incident_cancel_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_CANCEL_SKIPPED_STATUS)
        self.assertEqual(active_source.requests, [])
        self.assertEqual(finalizer.requests, [])
        self.assertEqual(raw_log.entries, [])

    def test_finalizer_receives_active_and_cancelled_snapshots_before_visible_reply(self):
        raw_log = RecordingRawEventLog()
        active_source = RecordingActiveIncidentSource(active_incident_snapshot())
        finalizer = RecordingLifeIncidentCancelFinalizer()
        event = normalized_user_message()
        role_model_result = role_model_result_with_cancel()

        result = commit_life_incident_cancel(
            event,
            role_model_result,
            active_incident_source=active_source,
            life_incident_cancel_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        event["payload"]["text"] = "mutated event"
        role_model_result["decision"]["life_action"]["reason"] = "mutated reason"
        result["cancelled_incident"]["title"] = "mutated result"
        finalizer.requests[0]["cancelled_incident"]["title"] = "mutated request"
        finalizer.requests[0]["committed_log_entry"]["data"]["source_event"]["payload"]["text"] = (
            "mutated request"
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_CANCELLED_STATUS)
        self.assertEqual(
            active_source.requests,
            [
                {
                    "schema_version": "0.1",
                    "trace_id": "trace-cancel",
                    "event_id": "event-cancel",
                    "event_type": "USER_MESSAGE",
                    "user_id": "user-1",
                    "conversation_id": "conversation-1",
                }
            ],
        )
        self.assertEqual(raw_log.entries, [])
        self.assertEqual(
            finalizer.durable_cancelled_incidents[0],
            {
                "schema_version": "0.1",
                "incident_id": "incident-1",
                "type": "think",
                "status": "cancelled",
                "title": "thinking through the plan",
                "started_at": "2026-05-22T08:40:00+00:00",
                "remaining_seconds": 300,
                "interrupt_policy": "interruptible",
                "resume_policy": "ask_model",
                "cancelled_at": "2026-05-22T09:00:00+00:00",
                "cancellation_reason": "User needs me now.",
                "source_event_ids": ["event-start", "event-cancel"],
            },
        )
        self.assertEqual(
            result["committed_log_entry_id"],
            finalizer.durable_raw_event_log_entries[0]["log_id"],
        )
        self.assertEqual(
            finalizer.durable_raw_event_log_entries[0]["kind"],
            "life_incident_cancelled",
        )
        self.assertEqual(
            finalizer.durable_raw_event_log_entries[0]["data"]["source_event"]["payload"]["text"],
            "stop that",
        )

    def test_rejects_when_no_active_incident_without_finalizer_call(self):
        raw_log = RecordingRawEventLog()
        active_source = RecordingActiveIncidentSource(None)
        finalizer = RecordingLifeIncidentCancelFinalizer()

        result = commit_life_incident_cancel(
            normalized_user_message(),
            role_model_result_with_cancel(),
            active_incident_source=active_source,
            life_incident_cancel_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_CANCEL_REJECTED_STATUS)
        self.assertEqual(result["failure"]["code"], "no_active_incident")
        self.assertEqual(finalizer.requests, [])
        self.assertEqual(raw_log.entries[0]["kind"], "life_incident_cancel_rejected")
        self.assertEqual(raw_log.entries[0]["data"]["failure"], result["failure"])

    def test_rejects_incident_id_mismatch_without_finalizer_call(self):
        raw_log = RecordingRawEventLog()
        active_source = RecordingActiveIncidentSource(active_incident_snapshot())
        finalizer = RecordingLifeIncidentCancelFinalizer()

        result = commit_life_incident_cancel(
            normalized_user_message(),
            role_model_result_with_cancel(incident_id="incident-other"),
            active_incident_source=active_source,
            life_incident_cancel_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_CANCEL_REJECTED_STATUS)
        self.assertEqual(result["failure"]["code"], "incident_id_mismatch")
        self.assertEqual(finalizer.requests, [])
        self.assertEqual(raw_log.entries[0]["kind"], "life_incident_cancel_rejected")
        self.assertEqual(
            raw_log.entries[0]["data"]["active_incident_snapshot"]["incident_id"], "incident-1"
        )

    def test_finalizer_failure_rejects_without_durable_cancel_or_raw_log_entry(self):
        raw_log = RecordingRawEventLog()
        active_source = RecordingActiveIncidentSource(active_incident_snapshot())
        finalizer = RecordingLifeIncidentCancelFinalizer(
            error=LifeIncidentCancelFinalizerError(
                "finalize rejected",
                code="finalize_rejected",
            )
        )

        result = commit_life_incident_cancel(
            normalized_user_message(),
            role_model_result_with_cancel(),
            active_incident_source=active_source,
            life_incident_cancel_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_CANCEL_REJECTED_STATUS)
        self.assertEqual(result["failure"]["stage"], LIFE_INCIDENT_CANCEL_FINALIZE_STAGE)
        self.assertEqual(result["failure"]["code"], "finalize_rejected")
        self.assertEqual(finalizer.durable_cancelled_incidents, [])
        self.assertEqual(finalizer.durable_raw_event_log_entries, [])
        self.assertEqual(raw_log.entries[0]["kind"], "life_incident_cancel_rejected")

    def test_malformed_finalizer_result_rejects(self):
        raw_log = RecordingRawEventLog()
        active_source = RecordingActiveIncidentSource(active_incident_snapshot())
        finalizer = RecordingLifeIncidentCancelFinalizer(
            result_override={
                "schema_version": "0.1",
                "trace_id": "trace-cancel",
                "event_id": "event-cancel",
                "event_type": "USER_MESSAGE",
                "committed_log_entry_id": "wrong-log-id",
            }
        )

        result = commit_life_incident_cancel(
            normalized_user_message(),
            role_model_result_with_cancel(),
            active_incident_source=active_source,
            life_incident_cancel_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_CANCEL_REJECTED_STATUS)
        self.assertEqual(result["failure"]["stage"], LIFE_INCIDENT_CANCEL_FINALIZE_STAGE)
        self.assertEqual(result["failure"]["code"], "malformed_finalize_result")
        self.assertEqual(finalizer.durable_cancelled_incidents, [])
        self.assertEqual(finalizer.durable_raw_event_log_entries, [])

    def test_cancelled_snapshot_and_log_entries_deep_copy_inputs(self):
        event = normalized_user_message()
        role_model_result = role_model_result_with_cancel()
        active_incident = active_incident_snapshot()
        request = build_life_incident_cancel_commit_request(event, role_model_result)
        request["commit_time"] = "2026-05-22T09:00:00+00:00"
        life_action = deepcopy(role_model_result["decision"]["life_action"])
        cancelled_incident = build_cancelled_life_incident_snapshot(
            active_incident,
            request,
        )
        committed = build_life_incident_cancelled_log_entry(
            event,
            role_model_result,
            life_action,
            active_incident,
            cancelled_incident,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )
        failure = {
            "stage": "life_incident_cancel_finalize",
            "code": "finalize_rejected",
            "message": "finalize rejected",
        }
        rejected = build_life_incident_cancel_rejected_log_entry(
            event,
            role_model_result_snapshot=role_model_result,
            life_action_snapshot=life_action,
            active_incident_snapshot=active_incident,
            cancelled_incident_snapshot=cancelled_incident,
            failure=failure,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        event["payload"]["text"] = "mutated"
        role_model_result["decision"]["visible_reply"]["text"] = "mutated"
        active_incident["title"] = "mutated"
        cancelled_incident["title"] = "mutated"
        failure["message"] = "mutated"

        self.assertEqual(committed["kind"], "life_incident_cancelled")
        self.assertEqual(committed["data"]["source_event"]["payload"]["text"], "stop that")
        self.assertEqual(
            committed["data"]["role_model_result"]["decision"]["visible_reply"]["text"],
            "hello back",
        )
        self.assertEqual(committed["data"]["active_incident"]["title"], "thinking through the plan")
        self.assertEqual(
            committed["data"]["cancelled_incident"]["title"],
            "thinking through the plan",
        )
        self.assertEqual(rejected["kind"], "life_incident_cancel_rejected")
        self.assertEqual(
            rejected["data"]["active_incident_snapshot"]["title"],
            "thinking through the plan",
        )
        self.assertEqual(rejected["data"]["failure"]["message"], "finalize rejected")


if __name__ == "__main__":
    unittest.main()
