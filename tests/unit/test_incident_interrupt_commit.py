import sys
import unittest
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from commit_effects import incident_interrupt as incident_interrupt_module  # noqa: E402
from commit_effects.incident_interrupt import (  # noqa: E402
    LIFE_INCIDENT_CONTINUED_IN_BACKGROUND_STATUS,
    LIFE_INCIDENT_INTERRUPT_COMMIT_VALIDATION_STAGE,
    LIFE_INCIDENT_INTERRUPT_FINALIZE_STAGE,
    LIFE_INCIDENT_INTERRUPT_REJECTED_STATUS,
    LIFE_INCIDENT_INTERRUPT_SKIPPED_STATUS,
    LIFE_INCIDENT_INTERRUPTED_STATUS,
    LIFE_INCIDENT_PROTECTED_FROM_INTERRUPTION_STATUS,
    LifeIncidentInterruptFinalizerError,
    build_interrupted_life_incident_snapshot,
    build_life_incident_interrupt_finalize_request,
    build_life_incident_interrupted_log_entry,
    commit_life_incident_interruption,
)
from runtime.logging import InMemoryRawEventLog, RawEventLogQueryValidationError  # noqa: E402


def fixed_clock():
    return datetime(2026, 5, 25, 9, 0, 0, tzinfo=UTC)


class SequenceIdGenerator:
    def __init__(self):
        self.calls = []

    def __call__(self, kind):
        self.calls.append(kind)
        return f"{kind}-generated-{len(self.calls)}"


class RecordingRawEventLog(InMemoryRawEventLog):
    def __init__(self):
        super().__init__()
        self.appended_entries = []

    def append(self, entry):
        self.appended_entries.append(deepcopy(entry))
        super().append(entry)


class RecordingDiscardRawEventLog(InMemoryRawEventLog):
    def __init__(self):
        super().__init__()
        self.discarded_entries = []

    def discard_committed_success_entry(self, entry):
        self.discarded_entries.append(deepcopy(entry))
        super().discard_committed_success_entry(entry)


class RejectingInterruptConfirmRawEventLog(RecordingDiscardRawEventLog):
    def confirm_committed_success_entry(self, entry):
        if entry["kind"] == "life_incident_interrupted":
            raise RawEventLogQueryValidationError("interrupt visibility confirm failed")
        super().confirm_committed_success_entry(entry)


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


class RecordingLifeIncidentInterruptFinalizer:
    def __init__(self, *, raw_log=None, error=None, result_override=None, completion_error=None):
        self.raw_log = raw_log
        self.error = error
        self.result_override = deepcopy(result_override)
        self.completion_error = completion_error
        self.requests = []
        self.completion_requests = []

    def require_life_incident_interrupt_raw_event_log(self, raw_event_log):
        if self.raw_log is not None and raw_event_log is not self.raw_log:
            raise LifeIncidentInterruptFinalizerError(
                "LifeIncidentStore must finalize against the same Raw Event Log instance.",
                code="malformed_finalize_result",
            )

    def finalize_life_incident_interrupt(self, request):
        self.requests.append(deepcopy(request))
        if self.error is not None:
            raise self.error
        if self.raw_log is not None:
            self.raw_log.expose_committed_success_entry(request["committed_log_entry"])
        if self.result_override is not None:
            return deepcopy(self.result_override)
        return {
            "schema_version": "0.1",
            "trace_id": request["trace_id"],
            "event_id": request["event_id"],
            "event_type": request["event_type"],
            "committed_log_entry_id": request["committed_log_entry"]["log_id"],
        }

    def complete_life_incident_interrupt_after_log_visible(self, request):
        self.completion_requests.append(deepcopy(request))
        if self.completion_error is not None:
            raise self.completion_error


class StagingCompletionFailingInterruptFinalizer:
    def __init__(self, raw_log, *, completion_error=None):
        self.raw_log = raw_log
        self.completion_error = completion_error
        self.requests = []
        self.completion_requests = []

    def require_life_incident_interrupt_raw_event_log(self, raw_event_log):
        if raw_event_log is not self.raw_log:
            raise LifeIncidentInterruptFinalizerError(
                "LifeIncidentStore must finalize against the same Raw Event Log instance.",
                code="malformed_finalize_result",
            )

    def finalize_life_incident_interrupt(self, request):
        self.requests.append(deepcopy(request))
        self.raw_log.expose_committed_success_entry(request["committed_log_entry"])
        return {
            "schema_version": "0.1",
            "trace_id": request["trace_id"],
            "event_id": request["event_id"],
            "event_type": request["event_type"],
            "committed_log_entry_id": request["committed_log_entry"]["log_id"],
        }

    def complete_life_incident_interrupt_after_log_visible(self, request):
        self.completion_requests.append(deepcopy(request))
        if self.completion_error is not None:
            raise self.completion_error
        raise LifeIncidentInterruptFinalizerError(
            "completion failed after success log visibility",
            code="finalize_rejected",
        )


def normalized_user_message():
    return {
        "event_id": "event-interrupt",
        "trace_id": "trace-interrupt",
        "type": "USER_MESSAGE",
        "created_at": "2026-05-25T08:59:00+00:00",
        "schema_version": "0.1",
        "payload": {
            "text": "are you there?",
            "user_id": "user-1",
            "conversation_id": "conversation-1",
        },
    }


def active_incident_snapshot(*, interrupt_policy="interruptible"):
    return {
        "schema_version": "0.1",
        "incident_id": "incident-1",
        "type": "eat",
        "status": "active",
        "title": "Eating lunch",
        "started_at": "2026-05-25T08:40:00+00:00",
        "expected_end_at": "2026-05-25T09:20:00+00:00",
        "remaining_seconds": 1200,
        "interrupt_policy": interrupt_policy,
        "resume_policy": "resume",
        "source_event_ids": ["event-start"],
    }


class IncidentInterruptCommitTests(unittest.TestCase):
    def test_interruptible_incident_is_staged_and_completed_after_visibility(self):
        raw_log = RecordingRawEventLog()
        active_incident = active_incident_snapshot()
        finalizer = RecordingLifeIncidentInterruptFinalizer(raw_log=raw_log)

        result = commit_life_incident_interruption(
            normalized_user_message(),
            active_incident_source=RecordingActiveIncidentSource(active_incident),
            life_incident_interrupt_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_INTERRUPTED_STATUS)
        self.assertEqual(result["interrupted_incident"]["status"], "interrupted")
        self.assertEqual(
            result["interrupted_incident"]["interrupted_at"], "2026-05-25T09:00:00+00:00"
        )
        self.assertEqual(
            result["interrupted_incident"]["source_event_ids"], ["event-start", "event-interrupt"]
        )
        self.assertEqual(len(finalizer.requests), 1)
        self.assertEqual(len(finalizer.completion_requests), 1)
        visible_logs = raw_log.query(
            {
                "trace_id": "trace-interrupt",
                "event_id": "event-interrupt",
                "kinds": ["life_incident_interrupted"],
            }
        )["entries"]
        self.assertEqual(len(visible_logs), 1)
        self.assertEqual(visible_logs[0]["data"]["active_incident"], active_incident)
        self.assertEqual(
            visible_logs[0]["data"]["interrupted_incident"],
            result["interrupted_incident"],
        )

    def test_background_policy_logs_outcome_and_leaves_active_incident_unchanged(self):
        raw_log = RecordingRawEventLog()
        active_incident = active_incident_snapshot(interrupt_policy="background")
        finalizer = RecordingLifeIncidentInterruptFinalizer(raw_log=raw_log)

        result = commit_life_incident_interruption(
            normalized_user_message(),
            active_incident_source=RecordingActiveIncidentSource(active_incident),
            life_incident_interrupt_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_CONTINUED_IN_BACKGROUND_STATUS)
        self.assertEqual(result["active_incident"], active_incident)
        self.assertEqual(finalizer.requests, [])
        visible_logs = raw_log.query(
            {
                "trace_id": "trace-interrupt",
                "event_id": "event-interrupt",
                "kinds": ["life_incident_continued_in_background"],
            }
        )["entries"]
        self.assertEqual(len(visible_logs), 1)
        self.assertEqual(visible_logs[0]["data"]["outcome"], "continued_in_background")
        self.assertEqual(visible_logs[0]["data"]["active_incident"], active_incident)

    def test_protected_policy_logs_outcome_and_leaves_active_incident_unchanged(self):
        raw_log = RecordingRawEventLog()
        active_incident = active_incident_snapshot(interrupt_policy="protected")

        result = commit_life_incident_interruption(
            normalized_user_message(),
            active_incident_source=RecordingActiveIncidentSource(active_incident),
            life_incident_interrupt_finalizer=RecordingLifeIncidentInterruptFinalizer(
                raw_log=raw_log
            ),
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_PROTECTED_FROM_INTERRUPTION_STATUS)
        self.assertEqual(result["active_incident"], active_incident)
        visible_logs = raw_log.query(
            {
                "trace_id": "trace-interrupt",
                "event_id": "event-interrupt",
                "kinds": ["life_incident_protected_from_interruption"],
            }
        )["entries"]
        self.assertEqual(len(visible_logs), 1)
        self.assertEqual(visible_logs[0]["data"]["outcome"], "protected_from_interruption")
        self.assertEqual(visible_logs[0]["data"]["active_incident"], active_incident)

    def test_skips_without_log_or_finalizer_when_no_active_incident_exists(self):
        raw_log = RecordingRawEventLog()
        active_source = RecordingActiveIncidentSource(None)
        finalizer = RecordingLifeIncidentInterruptFinalizer(raw_log=raw_log)

        result = commit_life_incident_interruption(
            normalized_user_message(),
            active_incident_source=active_source,
            life_incident_interrupt_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_INTERRUPT_SKIPPED_STATUS)
        self.assertEqual(len(active_source.requests), 1)
        self.assertEqual(finalizer.requests, [])
        self.assertEqual(raw_log.query({"trace_id": "trace-interrupt"})["entries"], [])

    def test_rejects_and_discards_interrupt_success_when_visibility_confirmation_fails(self):
        raw_log = RejectingInterruptConfirmRawEventLog()
        active_incident = active_incident_snapshot()
        finalizer = RecordingLifeIncidentInterruptFinalizer(raw_log=raw_log)

        result = commit_life_incident_interruption(
            normalized_user_message(),
            active_incident_source=RecordingActiveIncidentSource(active_incident),
            life_incident_interrupt_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_INTERRUPT_REJECTED_STATUS)
        self.assertEqual(result["failure"]["stage"], LIFE_INCIDENT_INTERRUPT_FINALIZE_STAGE)
        self.assertEqual(result["failure"]["code"], "malformed_finalize_result")
        self.assertEqual(finalizer.completion_requests, [])
        visible_success = raw_log.query(
            {
                "trace_id": "trace-interrupt",
                "event_id": "event-interrupt",
                "kinds": ["life_incident_interrupted"],
            }
        )["entries"]
        rejected = raw_log.query(
            {
                "trace_id": "trace-interrupt",
                "event_id": "event-interrupt",
                "kinds": ["life_incident_interrupt_rejected"],
            }
        )["entries"]
        self.assertEqual(visible_success, [])
        self.assertEqual(len(rejected), 1)
        self.assertEqual(len(raw_log.discarded_entries), 1)
        self.assertEqual(raw_log.discarded_entries[0]["kind"], "life_incident_interrupted")

    def test_rejects_source_errors_with_query_visible_failure_log(self):
        raw_log = RecordingRawEventLog()

        result = commit_life_incident_interruption(
            normalized_user_message(),
            active_incident_source=RecordingActiveIncidentSource(
                active_incident_snapshot(),
                error=RuntimeError("source unavailable"),
            ),
            life_incident_interrupt_finalizer=RecordingLifeIncidentInterruptFinalizer(
                raw_log=raw_log
            ),
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_INTERRUPT_REJECTED_STATUS)
        self.assertEqual(
            result["failure"]["stage"], LIFE_INCIDENT_INTERRUPT_COMMIT_VALIDATION_STAGE
        )
        self.assertEqual(result["failure"]["code"], "active_incident_source_error")
        rejected = raw_log.query(
            {
                "trace_id": "trace-interrupt",
                "event_id": "event-interrupt",
                "kinds": ["life_incident_interrupt_rejected"],
            }
        )["entries"]
        self.assertEqual(len(rejected), 1)
        self.assertEqual(rejected[0]["data"]["failure"], result["failure"])

    def test_completion_failure_after_success_visibility_returns_success_without_rejected_log(self):
        raw_log = RecordingDiscardRawEventLog()
        active_incident = active_incident_snapshot()
        finalizer = StagingCompletionFailingInterruptFinalizer(raw_log)

        result = commit_life_incident_interruption(
            normalized_user_message(),
            active_incident_source=RecordingActiveIncidentSource(active_incident),
            life_incident_interrupt_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        entries = raw_log.query({"trace_id": "trace-interrupt"})["entries"]
        rejected = raw_log.query(
            {
                "trace_id": "trace-interrupt",
                "event_id": "event-interrupt",
                "kinds": ["life_incident_interrupt_rejected"],
            }
        )["entries"]

        self.assertEqual(result["status"], LIFE_INCIDENT_INTERRUPTED_STATUS)
        self.assertEqual(result["interrupted_incident"]["status"], "interrupted")
        self.assertEqual(len(finalizer.completion_requests), 1)
        self.assertEqual(
            [entry["kind"] for entry in entries],
            ["life_incident_interrupted"],
        )
        self.assertEqual(rejected, [])
        self.assertEqual(raw_log.discarded_entries, [])

    def test_completion_runtime_error_after_success_visibility_returns_success(self):
        raw_log = InMemoryRawEventLog()
        active_incident = active_incident_snapshot()
        finalizer = StagingCompletionFailingInterruptFinalizer(
            raw_log,
            completion_error=RuntimeError("incident interrupt write failed"),
        )

        result = commit_life_incident_interruption(
            normalized_user_message(),
            active_incident_source=RecordingActiveIncidentSource(active_incident),
            life_incident_interrupt_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        rejected = raw_log.query(
            {
                "trace_id": "trace-interrupt",
                "event_id": "event-interrupt",
                "kinds": ["life_incident_interrupt_rejected"],
            }
        )["entries"]

        self.assertEqual(result["status"], LIFE_INCIDENT_INTERRUPTED_STATUS)
        self.assertEqual(result["interrupted_incident"]["incident_id"], "incident-1")
        self.assertEqual(rejected, [])
        self.assertEqual(len(finalizer.completion_requests), 1)

    def test_builders_preserve_active_identity_and_validate_log_shape(self):
        event = normalized_user_message()
        active_incident = active_incident_snapshot()
        commit_request = {
            "schema_version": "0.1",
            "trace_id": "trace-interrupt",
            "event_id": "event-interrupt",
            "event_type": "USER_MESSAGE",
            "incident_id": "incident-1",
            "commit_time": "2026-05-25T09:00:00+00:00",
            "user_id": "user-1",
            "conversation_id": "conversation-1",
        }

        interrupted_incident = build_interrupted_life_incident_snapshot(
            active_incident,
            commit_request,
        )
        log_entry = build_life_incident_interrupted_log_entry(
            event,
            active_incident,
            interrupted_incident,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )
        finalize_request = build_life_incident_interrupt_finalize_request(
            commit_request,
            active_incident=active_incident,
            interrupted_incident=interrupted_incident,
            committed_log_entry=log_entry,
        )

        self.assertEqual(interrupted_incident["incident_id"], "incident-1")
        self.assertEqual(interrupted_incident["status"], "interrupted")
        self.assertNotIn("decision_action", finalize_request)
        self.assertEqual(
            finalize_request["committed_log_entry"]["kind"], "life_incident_interrupted"
        )

    def test_interrupted_log_clock_accepts_z_suffix_commit_time(self):
        event = normalized_user_message()
        active_incident = active_incident_snapshot()
        commit_request = {
            "schema_version": "0.1",
            "trace_id": "trace-interrupt",
            "event_id": "event-interrupt",
            "event_type": "USER_MESSAGE",
            "incident_id": "incident-1",
            "commit_time": "2026-05-25T09:00:00Z",
            "user_id": "user-1",
            "conversation_id": "conversation-1",
        }
        interrupted_incident = build_interrupted_life_incident_snapshot(
            active_incident,
            commit_request,
        )

        log_entry = build_life_incident_interrupted_log_entry(
            event,
            active_incident,
            interrupted_incident,
            id_generator=SequenceIdGenerator(),
            clock=incident_interrupt_module._clock_at(commit_request["commit_time"]),
        )

        self.assertEqual(log_entry["created_at"], "2026-05-25T09:00:00+00:00")


if __name__ == "__main__":
    unittest.main()
