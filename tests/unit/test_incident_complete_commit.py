import sys
import unittest
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from commit_effects.incident_complete import (  # noqa: E402
    INCIDENT_COMPLETION_EVENT_COMMIT_VALIDATION_STAGE,
    INCIDENT_COMPLETION_EVENT_FINALIZE_STAGE,
    LIFE_INCIDENT_COMPLETE_COMMIT_VALIDATION_STAGE,
    LIFE_INCIDENT_COMPLETE_FINALIZE_STAGE,
    LIFE_INCIDENT_COMPLETE_REJECTED_STATUS,
    LIFE_INCIDENT_COMPLETE_SKIPPED_STATUS,
    LIFE_INCIDENT_COMPLETED_STATUS,
    LifeIncidentCompleteFinalizerError,
    build_completed_life_incident_snapshot,
    build_life_incident_complete_commit_request,
    build_life_incident_complete_finalize_request,
    build_life_incident_complete_rejected_log_entry,
    build_life_incident_completed_log_entry,
    build_life_incident_completion_event_commit_request,
    build_life_incident_completion_event_completed_log_entry,
    commit_life_incident_complete,
    commit_life_incident_completion_event,
)
from runtime.logging import InMemoryRawEventLog, RawEventLogQueryValidationError  # noqa: E402


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
    def __init__(self, snapshot, *, error=None):
        self.snapshot = deepcopy(snapshot)
        self.error = error
        self.requests = []

    def read_active_incident(self, request):
        self.requests.append(deepcopy(request))
        if self.error is not None:
            raise self.error
        return deepcopy(self.snapshot)


class RecordingLifeIncidentCompleteFinalizer:
    def __init__(self, error=None, result_override=None):
        self.error = error
        self.result_override = deepcopy(result_override)
        self.requests = []
        self.completion_requests = []
        self.durable_completed_incidents = []
        self.durable_raw_event_log_entries = []

    def finalize_life_incident_complete(self, request):
        self.requests.append(deepcopy(request))
        if self.error is not None:
            raise self.error
        if self.result_override is not None:
            return deepcopy(self.result_override)
        return {
            "schema_version": "0.1",
            "trace_id": request["trace_id"],
            "event_id": request["event_id"],
            "event_type": request["event_type"],
            "committed_log_entry_id": request["committed_log_entry"]["log_id"],
        }

    def complete_life_incident_complete_after_log_visible(self, request):
        self.completion_requests.append(deepcopy(request))
        self.durable_completed_incidents.append(deepcopy(request["completed_incident"]))
        self.durable_raw_event_log_entries.append(deepcopy(request["committed_log_entry"]))


class StagingCompletionFailingCompleteFinalizer:
    def __init__(self, raw_log, *, completion_error=None):
        self.raw_log = raw_log
        self.completion_error = completion_error
        self.requests = []
        self.completion_requests = []

    def require_life_incident_complete_raw_event_log(self, raw_event_log):
        if raw_event_log is not self.raw_log:
            raise LifeIncidentCompleteFinalizerError(
                "LifeIncidentStore must finalize against the same Raw Event Log instance.",
                code="malformed_finalize_result",
            )

    def finalize_life_incident_complete(self, request):
        self.requests.append(deepcopy(request))
        self.raw_log.expose_committed_success_entry(request["committed_log_entry"])
        return {
            "schema_version": "0.1",
            "trace_id": request["trace_id"],
            "event_id": request["event_id"],
            "event_type": request["event_type"],
            "committed_log_entry_id": request["committed_log_entry"]["log_id"],
        }

    def complete_life_incident_complete_after_log_visible(self, request):
        self.completion_requests.append(deepcopy(request))
        if self.completion_error is not None:
            raise self.completion_error
        raise LifeIncidentCompleteFinalizerError(
            "completion failed after success log visibility",
            code="finalize_rejected",
        )


class RejectingCompleteRawEventLog(InMemoryRawEventLog):
    def expose_committed_success_entry(self, entry):
        if entry["kind"] == "life_incident_completed":
            raise RawEventLogQueryValidationError("complete visibility staging failed")
        super().expose_committed_success_entry(entry)


def normalized_user_message():
    return {
        "event_id": "event-complete",
        "trace_id": "trace-complete",
        "type": "USER_MESSAGE",
        "created_at": "2026-05-22T08:59:00+00:00",
        "schema_version": "0.1",
        "payload": {
            "text": "stop that",
            "user_id": "user-1",
            "conversation_id": "conversation-1",
        },
    }


def normalized_incident_completion_event(*, incident_id="incident-1"):
    return {
        "event_id": "event-completion-due",
        "trace_id": "trace-completion-due",
        "type": "INCIDENT_COMPLETION",
        "created_at": "2026-05-22T08:59:30+00:00",
        "schema_version": "0.1",
        "payload": {
            "incident_id": incident_id,
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


def role_model_result_with_complete(*, incident_id="incident-1"):
    return {
        "trace_id": "trace-complete",
        "event_id": "event-complete",
        "event_type": "USER_MESSAGE",
        "model_called": True,
        "status": "decision_ready_for_commit",
        "decision": {
            "schema_version": "0.1",
            "trace_id": "trace-complete",
            "event_id": "event-complete",
            "action": "visible_reply",
            "visible_reply": {"text": "hello back"},
            "life_action": {
                "type": "complete_incident",
                "incident_id": incident_id,
            },
        },
    }


def role_model_result_without_life_action():
    result = role_model_result_with_complete()
    del result["decision"]["life_action"]
    return result


class IncidentCompleteCommitTests(unittest.TestCase):
    def test_builds_commit_request_from_complete_life_action(self):
        result = role_model_result_with_complete(incident_id=" incident-1 ")

        request = build_life_incident_complete_commit_request(
            normalized_user_message(),
            result,
        )

        self.assertEqual(
            request,
            {
                "schema_version": "0.1",
                "trace_id": "trace-complete",
                "event_id": "event-complete",
                "event_type": "USER_MESSAGE",
                "decision_action": "visible_reply",
                "life_action_type": "complete_incident",
                "incident_id": "incident-1",
                "user_id": "user-1",
                "conversation_id": "conversation-1",
            },
        )

    def test_builds_event_commit_request_from_incident_completion_event(self):
        event = normalized_incident_completion_event(incident_id=" incident-1 ")

        request = build_life_incident_completion_event_commit_request(event)

        self.assertEqual(
            request,
            {
                "schema_version": "0.1",
                "trace_id": "trace-completion-due",
                "event_id": "event-completion-due",
                "event_type": "INCIDENT_COMPLETION",
                "incident_id": "incident-1",
                "user_id": "user-1",
                "conversation_id": "conversation-1",
            },
        )

    def test_finalize_request_allows_normalized_empty_optional_identity_fields(self):
        event = normalized_user_message()
        event["payload"]["user_id"] = ""
        event["payload"]["conversation_id"] = ""
        role_model_result = role_model_result_with_complete()
        active_incident = active_incident_snapshot()
        request = build_life_incident_complete_commit_request(event, role_model_result)
        request["commit_time"] = "2026-05-22T09:00:00+00:00"
        completed_incident = build_completed_life_incident_snapshot(
            active_incident,
            request,
        )
        committed_log_entry = build_life_incident_completed_log_entry(
            event,
            role_model_result,
            role_model_result["decision"]["life_action"],
            active_incident,
            completed_incident,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        finalize_request = build_life_incident_complete_finalize_request(
            request,
            active_incident=active_incident,
            completed_incident=completed_incident,
            committed_log_entry=committed_log_entry,
        )

        self.assertEqual(finalize_request["user_id"], "")
        self.assertEqual(finalize_request["conversation_id"], "")

    def test_returns_skipped_without_active_read_or_finalizer_call_when_no_life_action(self):
        raw_log = RecordingRawEventLog()
        active_source = RecordingActiveIncidentSource(active_incident_snapshot())
        finalizer = RecordingLifeIncidentCompleteFinalizer()

        result = commit_life_incident_complete(
            normalized_user_message(),
            role_model_result_without_life_action(),
            active_incident_source=active_source,
            life_incident_complete_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_COMPLETE_SKIPPED_STATUS)
        self.assertEqual(active_source.requests, [])
        self.assertEqual(finalizer.requests, [])
        self.assertEqual(raw_log.entries, [])

    def test_finalizer_receives_active_and_completed_snapshots_before_visible_reply(self):
        raw_log = RecordingRawEventLog()
        active_source = RecordingActiveIncidentSource(active_incident_snapshot())
        finalizer = RecordingLifeIncidentCompleteFinalizer()
        event = normalized_user_message()
        role_model_result = role_model_result_with_complete()

        result = commit_life_incident_complete(
            event,
            role_model_result,
            active_incident_source=active_source,
            life_incident_complete_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        event["payload"]["text"] = "mutated event"
        result["completed_incident"]["title"] = "mutated result"
        finalizer.requests[0]["completed_incident"]["title"] = "mutated request"
        finalizer.requests[0]["committed_log_entry"]["data"]["source_event"]["payload"]["text"] = (
            "mutated request"
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_COMPLETED_STATUS)
        self.assertEqual(
            active_source.requests,
            [
                {
                    "schema_version": "0.1",
                    "trace_id": "trace-complete",
                    "event_id": "event-complete",
                    "event_type": "USER_MESSAGE",
                    "user_id": "user-1",
                    "conversation_id": "conversation-1",
                }
            ],
        )
        self.assertEqual(raw_log.entries, [])
        self.assertEqual(
            finalizer.durable_completed_incidents[0],
            {
                "schema_version": "0.1",
                "incident_id": "incident-1",
                "type": "think",
                "status": "completed",
                "title": "thinking through the plan",
                "started_at": "2026-05-22T08:40:00+00:00",
                "remaining_seconds": 300,
                "interrupt_policy": "interruptible",
                "resume_policy": "ask_model",
                "actual_end_at": "2026-05-22T09:00:00+00:00",
                "source_event_ids": ["event-start", "event-complete"],
            },
        )
        self.assertEqual(
            result["committed_log_entry_id"],
            finalizer.durable_raw_event_log_entries[0]["log_id"],
        )
        self.assertEqual(
            finalizer.durable_raw_event_log_entries[0]["kind"],
            "life_incident_completed",
        )
        self.assertEqual(
            finalizer.durable_raw_event_log_entries[0]["data"]["source_event"]["payload"]["text"],
            "stop that",
        )
        self.assertEqual(
            finalizer.completion_requests[0]["committed_log_entry"]["log_id"],
            result["committed_log_entry_id"],
        )

    def test_event_completion_finalizes_without_role_model_data(self):
        raw_log = RecordingRawEventLog()
        active_source = RecordingActiveIncidentSource(active_incident_snapshot())
        finalizer = RecordingLifeIncidentCompleteFinalizer()
        event = normalized_incident_completion_event()

        result = commit_life_incident_completion_event(
            event,
            active_incident_source=active_source,
            life_incident_complete_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        event["payload"]["incident_id"] = "mutated"
        result["completed_incident"]["title"] = "mutated result"
        finalizer.requests[0]["completed_incident"]["title"] = "mutated request"

        self.assertEqual(result["status"], LIFE_INCIDENT_COMPLETED_STATUS)
        self.assertEqual(result["event_type"], "INCIDENT_COMPLETION")
        self.assertEqual(
            active_source.requests,
            [
                {
                    "schema_version": "0.1",
                    "trace_id": "trace-completion-due",
                    "event_id": "event-completion-due",
                    "event_type": "INCIDENT_COMPLETION",
                    "user_id": "user-1",
                    "conversation_id": "conversation-1",
                }
            ],
        )
        self.assertEqual(raw_log.entries, [])
        self.assertEqual(
            finalizer.durable_completed_incidents[0]["source_event_ids"],
            ["event-start", "event-completion-due"],
        )
        committed_log = finalizer.durable_raw_event_log_entries[0]
        self.assertEqual(committed_log["kind"], "life_incident_completed")
        self.assertEqual(
            committed_log["data"],
            {
                "source_event": normalized_incident_completion_event(),
                "completion_source": "incident_completion_event",
                "active_incident": active_incident_snapshot(),
                "completed_incident": {
                    "schema_version": "0.1",
                    "incident_id": "incident-1",
                    "type": "think",
                    "status": "completed",
                    "title": "thinking through the plan",
                    "started_at": "2026-05-22T08:40:00+00:00",
                    "remaining_seconds": 300,
                    "interrupt_policy": "interruptible",
                    "resume_policy": "ask_model",
                    "actual_end_at": "2026-05-22T09:00:00+00:00",
                    "source_event_ids": ["event-start", "event-completion-due"],
                },
            },
        )
        self.assertNotIn("role_model_result", committed_log["data"])
        self.assertNotIn("life_action", committed_log["data"])

    def test_event_completion_rejects_when_no_active_incident_without_finalizer_call(self):
        raw_log = RecordingRawEventLog()
        active_source = RecordingActiveIncidentSource(None)
        finalizer = RecordingLifeIncidentCompleteFinalizer()

        result = commit_life_incident_completion_event(
            normalized_incident_completion_event(),
            active_incident_source=active_source,
            life_incident_complete_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_COMPLETE_REJECTED_STATUS)
        self.assertEqual(result["event_type"], "INCIDENT_COMPLETION")
        self.assertEqual(
            result["failure"]["stage"], INCIDENT_COMPLETION_EVENT_COMMIT_VALIDATION_STAGE
        )
        self.assertEqual(result["failure"]["code"], "no_active_incident")
        self.assertEqual(finalizer.requests, [])
        self.assertEqual(raw_log.entries[0]["kind"], "life_incident_complete_rejected")
        self.assertEqual(
            raw_log.entries[0]["data"]["completion_source"], "incident_completion_event"
        )
        self.assertNotIn("role_model_result_snapshot", raw_log.entries[0]["data"])

    def test_malformed_event_completion_returns_rejected_result_and_log_entry(self):
        raw_log = RecordingRawEventLog()
        active_source = RecordingActiveIncidentSource(active_incident_snapshot())
        finalizer = RecordingLifeIncidentCompleteFinalizer()
        event = normalized_incident_completion_event()
        del event["payload"]["incident_id"]

        result = commit_life_incident_completion_event(
            event,
            active_incident_source=active_source,
            life_incident_complete_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_COMPLETE_REJECTED_STATUS)
        self.assertEqual(result["event_type"], "INCIDENT_COMPLETION")
        self.assertEqual(
            result["failure"]["stage"], INCIDENT_COMPLETION_EVENT_COMMIT_VALIDATION_STAGE
        )
        self.assertEqual(result["failure"]["code"], "malformed_commit_input")
        self.assertIn("source_event.payload.incident_id", result["failure"]["message"])
        self.assertEqual(active_source.requests, [])
        self.assertEqual(finalizer.requests, [])
        self.assertEqual(raw_log.entries[0]["kind"], "life_incident_complete_rejected")
        self.assertEqual(raw_log.entries[0]["trace_id"], "trace-completion-due")
        self.assertEqual(raw_log.entries[0]["event_id"], "event-completion-due")
        self.assertEqual(raw_log.entries[0]["data"]["failure"], result["failure"])

    def test_event_completion_active_source_runtime_error_returns_rejected_result(self):
        raw_log = RecordingRawEventLog()
        active_source = RecordingActiveIncidentSource(
            None,
            error=RuntimeError("incident store unavailable"),
        )
        finalizer = RecordingLifeIncidentCompleteFinalizer()

        result = commit_life_incident_completion_event(
            normalized_incident_completion_event(),
            active_incident_source=active_source,
            life_incident_complete_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_COMPLETE_REJECTED_STATUS)
        self.assertEqual(
            result["failure"]["stage"], INCIDENT_COMPLETION_EVENT_COMMIT_VALIDATION_STAGE
        )
        self.assertEqual(result["failure"]["code"], "active_incident_source_error")
        self.assertIn("incident store unavailable", result["failure"]["message"])
        self.assertEqual(finalizer.requests, [])
        self.assertEqual(raw_log.entries[0]["kind"], "life_incident_complete_rejected")

    def test_event_completion_rejects_incident_id_mismatch_without_finalizer_call(self):
        raw_log = RecordingRawEventLog()
        active_source = RecordingActiveIncidentSource(active_incident_snapshot())
        finalizer = RecordingLifeIncidentCompleteFinalizer()

        result = commit_life_incident_completion_event(
            normalized_incident_completion_event(incident_id="incident-other"),
            active_incident_source=active_source,
            life_incident_complete_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_COMPLETE_REJECTED_STATUS)
        self.assertEqual(
            result["failure"]["stage"], INCIDENT_COMPLETION_EVENT_COMMIT_VALIDATION_STAGE
        )
        self.assertEqual(result["failure"]["code"], "incident_id_mismatch")
        self.assertEqual(finalizer.requests, [])
        self.assertEqual(raw_log.entries[0]["kind"], "life_incident_complete_rejected")
        self.assertEqual(
            raw_log.entries[0]["data"]["active_incident_snapshot"]["incident_id"], "incident-1"
        )

    def test_event_completion_raw_log_mismatch_rejects_before_staging(self):
        store_raw_log = InMemoryRawEventLog()
        commit_raw_log = InMemoryRawEventLog()
        active_source = RecordingActiveIncidentSource(active_incident_snapshot())
        finalizer = StagingCompletionFailingCompleteFinalizer(store_raw_log)

        result = commit_life_incident_completion_event(
            normalized_incident_completion_event(),
            active_incident_source=active_source,
            life_incident_complete_finalizer=finalizer,
            raw_event_log=commit_raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_COMPLETE_REJECTED_STATUS)
        self.assertEqual(result["failure"]["stage"], INCIDENT_COMPLETION_EVENT_FINALIZE_STAGE)
        self.assertEqual(result["failure"]["code"], "malformed_finalize_result")
        self.assertIn("same Raw Event Log instance", result["failure"]["message"])
        self.assertEqual(finalizer.requests, [])
        self.assertEqual(
            [
                entry["kind"]
                for entry in commit_raw_log.query({"trace_id": "trace-completion-due"})["entries"]
            ],
            ["life_incident_complete_rejected"],
        )
        self.assertEqual(
            store_raw_log.query({"trace_id": "trace-completion-due"})["entries"],
            [],
        )

    def test_event_completion_finalizer_failure_rejects_without_success_log(self):
        raw_log = RecordingRawEventLog()
        active_source = RecordingActiveIncidentSource(active_incident_snapshot())
        finalizer = RecordingLifeIncidentCompleteFinalizer(
            error=LifeIncidentCompleteFinalizerError(
                "finalize rejected",
                code="finalize_rejected",
            )
        )

        result = commit_life_incident_completion_event(
            normalized_incident_completion_event(),
            active_incident_source=active_source,
            life_incident_complete_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_COMPLETE_REJECTED_STATUS)
        self.assertEqual(result["failure"]["stage"], INCIDENT_COMPLETION_EVENT_FINALIZE_STAGE)
        self.assertEqual(result["failure"]["code"], "finalize_rejected")
        self.assertEqual(finalizer.durable_completed_incidents, [])
        self.assertEqual(finalizer.durable_raw_event_log_entries, [])
        self.assertEqual(raw_log.entries[0]["kind"], "life_incident_complete_rejected")

    def test_event_completion_visibility_staging_failure_rejects_without_success_log(self):
        raw_log = RejectingCompleteRawEventLog()
        active_source = RecordingActiveIncidentSource(active_incident_snapshot())
        finalizer = StagingCompletionFailingCompleteFinalizer(raw_log)

        result = commit_life_incident_completion_event(
            normalized_incident_completion_event(),
            active_incident_source=active_source,
            life_incident_complete_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        entries = raw_log.query({"trace_id": "trace-completion-due"})["entries"]

        self.assertEqual(result["status"], LIFE_INCIDENT_COMPLETE_REJECTED_STATUS)
        self.assertEqual(result["failure"]["stage"], INCIDENT_COMPLETION_EVENT_FINALIZE_STAGE)
        self.assertEqual(result["failure"]["code"], "malformed_finalize_result")
        self.assertIn("complete visibility staging failed", result["failure"]["message"])
        self.assertEqual(finalizer.completion_requests, [])
        self.assertEqual(
            [entry["kind"] for entry in entries],
            ["life_incident_complete_rejected"],
        )

    def test_event_completion_failure_after_success_visibility_keeps_success_and_audit(self):
        raw_log = InMemoryRawEventLog()
        active_source = RecordingActiveIncidentSource(active_incident_snapshot())
        finalizer = StagingCompletionFailingCompleteFinalizer(raw_log)

        result = commit_life_incident_completion_event(
            normalized_incident_completion_event(),
            active_incident_source=active_source,
            life_incident_complete_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        entries = raw_log.query({"trace_id": "trace-completion-due"})["entries"]

        self.assertEqual(result["status"], LIFE_INCIDENT_COMPLETE_REJECTED_STATUS)
        self.assertEqual(result["event_type"], "INCIDENT_COMPLETION")
        self.assertEqual(result["failure"]["stage"], INCIDENT_COMPLETION_EVENT_FINALIZE_STAGE)
        self.assertEqual(result["failure"]["code"], "finalize_rejected")
        self.assertIn("completion failed", result["failure"]["message"])
        self.assertEqual(
            [entry["kind"] for entry in entries],
            ["life_incident_completed", "life_incident_complete_rejected"],
        )
        self.assertEqual(
            entries[0]["data"]["completion_source"],
            "incident_completion_event",
        )

    def test_rejects_when_no_active_incident_without_finalizer_call(self):
        raw_log = RecordingRawEventLog()
        active_source = RecordingActiveIncidentSource(None)
        finalizer = RecordingLifeIncidentCompleteFinalizer()

        result = commit_life_incident_complete(
            normalized_user_message(),
            role_model_result_with_complete(),
            active_incident_source=active_source,
            life_incident_complete_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_COMPLETE_REJECTED_STATUS)
        self.assertEqual(result["failure"]["code"], "no_active_incident")
        self.assertEqual(finalizer.requests, [])
        self.assertEqual(raw_log.entries[0]["kind"], "life_incident_complete_rejected")
        self.assertEqual(raw_log.entries[0]["data"]["failure"], result["failure"])

    def test_active_incident_source_runtime_error_returns_rejected_result(self):
        raw_log = RecordingRawEventLog()
        active_source = RecordingActiveIncidentSource(
            None,
            error=RuntimeError("incident store unavailable"),
        )
        finalizer = RecordingLifeIncidentCompleteFinalizer()

        result = commit_life_incident_complete(
            normalized_user_message(),
            role_model_result_with_complete(),
            active_incident_source=active_source,
            life_incident_complete_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_COMPLETE_REJECTED_STATUS)
        self.assertEqual(result["failure"]["stage"], LIFE_INCIDENT_COMPLETE_COMMIT_VALIDATION_STAGE)
        self.assertEqual(result["failure"]["code"], "active_incident_source_error")
        self.assertIn("incident store unavailable", result["failure"]["message"])
        self.assertEqual(finalizer.requests, [])
        self.assertEqual(raw_log.entries[0]["kind"], "life_incident_complete_rejected")

    def test_rejects_incident_id_mismatch_without_finalizer_call(self):
        raw_log = RecordingRawEventLog()
        active_source = RecordingActiveIncidentSource(active_incident_snapshot())
        finalizer = RecordingLifeIncidentCompleteFinalizer()

        result = commit_life_incident_complete(
            normalized_user_message(),
            role_model_result_with_complete(incident_id="incident-other"),
            active_incident_source=active_source,
            life_incident_complete_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_COMPLETE_REJECTED_STATUS)
        self.assertEqual(result["failure"]["code"], "incident_id_mismatch")
        self.assertEqual(finalizer.requests, [])
        self.assertEqual(raw_log.entries[0]["kind"], "life_incident_complete_rejected")
        self.assertEqual(
            raw_log.entries[0]["data"]["active_incident_snapshot"]["incident_id"], "incident-1"
        )

    def test_finalizer_failure_rejects_without_durable_complete_or_raw_log_entry(self):
        raw_log = RecordingRawEventLog()
        active_source = RecordingActiveIncidentSource(active_incident_snapshot())
        finalizer = RecordingLifeIncidentCompleteFinalizer(
            error=LifeIncidentCompleteFinalizerError(
                "finalize rejected",
                code="finalize_rejected",
            )
        )

        result = commit_life_incident_complete(
            normalized_user_message(),
            role_model_result_with_complete(),
            active_incident_source=active_source,
            life_incident_complete_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_COMPLETE_REJECTED_STATUS)
        self.assertEqual(result["failure"]["stage"], LIFE_INCIDENT_COMPLETE_FINALIZE_STAGE)
        self.assertEqual(result["failure"]["code"], "finalize_rejected")
        self.assertEqual(finalizer.durable_completed_incidents, [])
        self.assertEqual(finalizer.durable_raw_event_log_entries, [])
        self.assertEqual(raw_log.entries[0]["kind"], "life_incident_complete_rejected")

    def test_finalizer_runtime_error_returns_rejected_result(self):
        raw_log = RecordingRawEventLog()
        active_source = RecordingActiveIncidentSource(active_incident_snapshot())
        finalizer = RecordingLifeIncidentCompleteFinalizer(
            error=RuntimeError("finalizer storage failed")
        )

        result = commit_life_incident_complete(
            normalized_user_message(),
            role_model_result_with_complete(),
            active_incident_source=active_source,
            life_incident_complete_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_COMPLETE_REJECTED_STATUS)
        self.assertEqual(result["failure"]["stage"], LIFE_INCIDENT_COMPLETE_FINALIZE_STAGE)
        self.assertEqual(result["failure"]["code"], "finalize_rejected")
        self.assertIn("finalizer storage failed", result["failure"]["message"])
        self.assertEqual(finalizer.durable_completed_incidents, [])
        self.assertEqual(finalizer.durable_raw_event_log_entries, [])
        self.assertEqual(raw_log.entries[0]["kind"], "life_incident_complete_rejected")

    def test_malformed_finalizer_result_rejects(self):
        raw_log = RecordingRawEventLog()
        active_source = RecordingActiveIncidentSource(active_incident_snapshot())
        finalizer = RecordingLifeIncidentCompleteFinalizer(
            result_override={
                "schema_version": "0.1",
                "trace_id": "trace-complete",
                "event_id": "event-complete",
                "event_type": "USER_MESSAGE",
                "committed_log_entry_id": "wrong-log-id",
            }
        )

        result = commit_life_incident_complete(
            normalized_user_message(),
            role_model_result_with_complete(),
            active_incident_source=active_source,
            life_incident_complete_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_COMPLETE_REJECTED_STATUS)
        self.assertEqual(result["failure"]["stage"], LIFE_INCIDENT_COMPLETE_FINALIZE_STAGE)
        self.assertEqual(result["failure"]["code"], "malformed_finalize_result")
        self.assertEqual(finalizer.durable_completed_incidents, [])
        self.assertEqual(finalizer.durable_raw_event_log_entries, [])
        self.assertEqual(finalizer.completion_requests, [])

    def test_completion_failure_after_success_visibility_returns_rejected_result(self):
        raw_log = InMemoryRawEventLog()
        active_source = RecordingActiveIncidentSource(active_incident_snapshot())
        finalizer = StagingCompletionFailingCompleteFinalizer(raw_log)

        result = commit_life_incident_complete(
            normalized_user_message(),
            role_model_result_with_complete(),
            active_incident_source=active_source,
            life_incident_complete_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        entries = raw_log.query({"trace_id": "trace-complete"})["entries"]

        self.assertEqual(result["status"], LIFE_INCIDENT_COMPLETE_REJECTED_STATUS)
        self.assertEqual(result["failure"]["stage"], LIFE_INCIDENT_COMPLETE_FINALIZE_STAGE)
        self.assertEqual(result["failure"]["code"], "finalize_rejected")
        self.assertIn("completion failed", result["failure"]["message"])
        self.assertEqual(len(finalizer.completion_requests), 1)
        self.assertEqual(
            [entry["kind"] for entry in entries],
            ["life_incident_completed", "life_incident_complete_rejected"],
        )

    def test_completion_runtime_error_after_success_visibility_returns_rejected_result(self):
        raw_log = InMemoryRawEventLog()
        active_source = RecordingActiveIncidentSource(active_incident_snapshot())
        finalizer = StagingCompletionFailingCompleteFinalizer(
            raw_log,
            completion_error=RuntimeError("incident removal write failed"),
        )

        result = commit_life_incident_complete(
            normalized_user_message(),
            role_model_result_with_complete(),
            active_incident_source=active_source,
            life_incident_complete_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        entries = raw_log.query({"trace_id": "trace-complete"})["entries"]

        self.assertEqual(result["status"], LIFE_INCIDENT_COMPLETE_REJECTED_STATUS)
        self.assertEqual(result["failure"]["stage"], LIFE_INCIDENT_COMPLETE_FINALIZE_STAGE)
        self.assertEqual(result["failure"]["code"], "finalize_rejected")
        self.assertIn("incident removal write failed", result["failure"]["message"])
        self.assertEqual(len(finalizer.completion_requests), 1)
        self.assertEqual(
            [entry["kind"] for entry in entries],
            ["life_incident_completed", "life_incident_complete_rejected"],
        )

    def test_completed_snapshot_and_log_entries_deep_copy_inputs(self):
        event = normalized_user_message()
        role_model_result = role_model_result_with_complete()
        active_incident = active_incident_snapshot()
        request = build_life_incident_complete_commit_request(event, role_model_result)
        request["commit_time"] = "2026-05-22T09:00:00+00:00"
        life_action = deepcopy(role_model_result["decision"]["life_action"])
        completed_incident = build_completed_life_incident_snapshot(
            active_incident,
            request,
        )
        committed = build_life_incident_completed_log_entry(
            event,
            role_model_result,
            life_action,
            active_incident,
            completed_incident,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )
        failure = {
            "stage": "life_incident_complete_finalize",
            "code": "finalize_rejected",
            "message": "finalize rejected",
        }
        rejected = build_life_incident_complete_rejected_log_entry(
            event,
            role_model_result_snapshot=role_model_result,
            life_action_snapshot=life_action,
            active_incident_snapshot=active_incident,
            completed_incident_snapshot=completed_incident,
            failure=failure,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        event["payload"]["text"] = "mutated"
        role_model_result["decision"]["visible_reply"]["text"] = "mutated"
        active_incident["title"] = "mutated"
        completed_incident["title"] = "mutated"
        failure["message"] = "mutated"

        self.assertEqual(committed["kind"], "life_incident_completed")
        self.assertEqual(committed["data"]["source_event"]["payload"]["text"], "stop that")
        self.assertEqual(
            committed["data"]["role_model_result"]["decision"]["visible_reply"]["text"],
            "hello back",
        )
        self.assertEqual(committed["data"]["active_incident"]["title"], "thinking through the plan")
        self.assertEqual(
            committed["data"]["completed_incident"]["title"],
            "thinking through the plan",
        )
        self.assertEqual(rejected["kind"], "life_incident_complete_rejected")
        self.assertEqual(
            rejected["data"]["active_incident_snapshot"]["title"],
            "thinking through the plan",
        )
        self.assertEqual(rejected["data"]["failure"]["message"], "finalize rejected")

    def test_event_completed_log_entries_deep_copy_inputs(self):
        event = normalized_incident_completion_event()
        active_incident = active_incident_snapshot()
        request = build_life_incident_completion_event_commit_request(event)
        request["commit_time"] = "2026-05-22T09:00:00+00:00"
        completed_incident = build_completed_life_incident_snapshot(
            active_incident,
            request,
        )
        committed = build_life_incident_completion_event_completed_log_entry(
            event,
            active_incident,
            completed_incident,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        event["payload"]["incident_id"] = "mutated"
        active_incident["title"] = "mutated"
        completed_incident["title"] = "mutated"

        self.assertEqual(committed["kind"], "life_incident_completed")
        self.assertEqual(committed["data"]["source_event"]["payload"]["incident_id"], "incident-1")
        self.assertEqual(committed["data"]["active_incident"]["title"], "thinking through the plan")
        self.assertEqual(
            committed["data"]["completed_incident"]["title"],
            "thinking through the plan",
        )


if __name__ == "__main__":
    unittest.main()
