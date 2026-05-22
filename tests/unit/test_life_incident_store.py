import sys
import unittest
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from character.state.current import build_active_incident_request  # noqa: E402
from character.state.incidents import InMemoryLifeIncidentStore  # noqa: E402
from commit_effects.incident_cancel import (  # noqa: E402
    LIFE_INCIDENT_CANCEL_REJECTED_STATUS,
    LIFE_INCIDENT_CANCELLED_STATUS,
    LifeIncidentCancelFinalizerError,
    build_cancelled_life_incident_snapshot,
    build_life_incident_cancel_commit_request,
    build_life_incident_cancel_finalize_request,
    build_life_incident_cancelled_log_entry,
    commit_life_incident_cancel,
)
from commit_effects.incident_start import (  # noqa: E402
    LIFE_INCIDENT_START_REJECTED_STATUS,
    LIFE_INCIDENT_STARTED_STATUS,
    LifeIncidentStartFinalizerError,
    build_life_incident_start_commit_request,
    build_life_incident_start_finalize_request,
    build_life_incident_started_log_entry,
    build_started_life_incident_snapshot,
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


class RejectingCancelRawEventLog(InMemoryRawEventLog):
    def expose_committed_success_entry(self, entry):
        if entry["kind"] == "life_incident_cancelled":
            raise RawEventLogQueryValidationError("cancel visibility staging failed")
        super().expose_committed_success_entry(entry)


class RejectingCancelConfirmRawEventLog(InMemoryRawEventLog):
    def confirm_committed_success_entry(self, entry):
        if entry["kind"] == "life_incident_cancelled":
            raise RawEventLogQueryValidationError("cancel visibility confirm failed")
        super().confirm_committed_success_entry(entry)


def normalized_user_message(
    *,
    event_id="event-1",
    trace_id="trace-1",
    user_id="user-1",
    conversation_id="conversation-1",
):
    payload = {"text": "hello"}
    if user_id is not None:
        payload["user_id"] = user_id
    if conversation_id is not None:
        payload["conversation_id"] = conversation_id
    return {
        "event_id": event_id,
        "trace_id": trace_id,
        "type": "USER_MESSAGE",
        "created_at": "2026-05-20T08:59:00+00:00",
        "schema_version": "0.1",
        "payload": payload,
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


def role_model_result_with_cancel(
    *,
    event_id="event-2",
    trace_id="trace-2",
    incident_id="incident-generated-1",
    reason="User needs me now.",
):
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
                "type": "cancel_incident",
                "incident_id": incident_id,
                "reason": reason,
            },
        },
    }


def finalize_request_for(event, role_model_result):
    ids = SequenceIdGenerator()
    commit_request = build_life_incident_start_commit_request(event, role_model_result)
    commit_request["commit_time"] = fixed_clock().isoformat()
    started_incident = build_started_life_incident_snapshot(
        event,
        commit_request["draft"],
        commit_time=commit_request["commit_time"],
        id_generator=ids,
    )
    committed_log_entry = build_life_incident_started_log_entry(
        event,
        role_model_result,
        commit_request["draft"],
        started_incident,
        id_generator=ids,
        clock=fixed_clock,
    )
    return build_life_incident_start_finalize_request(
        commit_request,
        started_incident=started_incident,
        committed_log_entry=committed_log_entry,
    )


def cancel_finalize_request_for(event, role_model_result, active_incident):
    ids = SequenceIdGenerator()
    commit_request = build_life_incident_cancel_commit_request(event, role_model_result)
    commit_request["commit_time"] = fixed_clock().isoformat()
    life_action = deepcopy(role_model_result["decision"]["life_action"])
    cancelled_incident = build_cancelled_life_incident_snapshot(
        active_incident,
        commit_request,
    )
    committed_log_entry = build_life_incident_cancelled_log_entry(
        event,
        role_model_result,
        life_action,
        active_incident,
        cancelled_incident,
        id_generator=ids,
        clock=fixed_clock,
    )
    return build_life_incident_cancel_finalize_request(
        commit_request,
        active_incident=active_incident,
        cancelled_incident=cancelled_incident,
        committed_log_entry=committed_log_entry,
    )


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
            raw_log.query({"trace_id": "trace-1", "kinds": ["life_incident_started"]})["entries"][
                0
            ]["data"]["started_incident"]["title"],
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

    def test_direct_visibility_staging_failure_raises_finalizer_error(self):
        raw_log = RejectingRawEventLog()
        store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        event = normalized_user_message()
        request = finalize_request_for(event, role_model_result_with_incident())

        with self.assertRaises(LifeIncidentStartFinalizerError) as context:
            store.finalize_life_incident_start(request)

        self.assertEqual(context.exception.code, "malformed_finalize_result")
        self.assertEqual(store.read_active_incident(build_active_incident_request(event)), None)

    def test_raw_log_mismatch_rejects_before_staging_or_storing_active_incident(self):
        store_raw_log = InMemoryRawEventLog()
        commit_raw_log = InMemoryRawEventLog()
        store = InMemoryLifeIncidentStore(raw_event_log=store_raw_log)
        event = normalized_user_message()

        result = commit_life_incident_start(
            event,
            role_model_result_with_incident(),
            life_incident_start_finalizer=store,
            raw_event_log=commit_raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_START_REJECTED_STATUS)
        self.assertEqual(result["failure"]["stage"], "life_incident_start_finalize")
        self.assertEqual(result["failure"]["code"], "malformed_finalize_result")
        self.assertIn("same Raw Event Log instance", result["failure"]["message"])
        self.assertEqual(store.read_active_incident(build_active_incident_request(event)), None)
        self.assertEqual(
            store_raw_log.query({"trace_id": "trace-1", "kinds": ["life_incident_started"]})[
                "entries"
            ],
            [],
        )
        self.assertEqual(
            [entry["kind"] for entry in commit_raw_log.query({"trace_id": "trace-1"})["entries"]],
            ["life_incident_start_rejected"],
        )

    def test_same_scope_second_start_fails_closed_without_overwriting_active_incident(self):
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
            raw_log.query({"trace_id": "trace-2", "kinds": ["life_incident_started"]})["entries"],
            [],
        )
        self.assertEqual(
            raw_log.query({"trace_id": "trace-1", "kinds": ["life_incident_started"]})["entries"][
                0
            ]["data"]["started_incident"],
            first_incident,
        )

    def test_different_scope_starts_both_succeed(self):
        raw_log = InMemoryRawEventLog()
        store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        ids = SequenceIdGenerator()
        first_event = normalized_user_message(
            event_id="event-1",
            trace_id="trace-1",
            user_id="user-1",
            conversation_id="conversation-1",
        )
        second_event = normalized_user_message(
            event_id="event-2",
            trace_id="trace-2",
            user_id="user-2",
            conversation_id="conversation-1",
        )

        first_result = commit_life_incident_start(
            first_event,
            role_model_result_with_incident(event_id="event-1", trace_id="trace-1"),
            life_incident_start_finalizer=store,
            raw_event_log=raw_log,
            id_generator=ids,
            clock=fixed_clock,
        )
        second_result = commit_life_incident_start(
            second_event,
            role_model_result_with_incident(
                event_id="event-2",
                trace_id="trace-2",
                title="second user's incident",
            ),
            life_incident_start_finalizer=store,
            raw_event_log=raw_log,
            id_generator=ids,
            clock=fixed_clock,
        )

        self.assertEqual(first_result["status"], LIFE_INCIDENT_STARTED_STATUS)
        self.assertEqual(second_result["status"], LIFE_INCIDENT_STARTED_STATUS)
        self.assertEqual(
            store.read_active_incident(build_active_incident_request(first_event))["title"],
            "thinking through the plan",
        )
        self.assertEqual(
            store.read_active_incident(build_active_incident_request(second_event))["title"],
            "second user's incident",
        )
        self.assertEqual(
            len(
                raw_log.query({"trace_id": "trace-1", "kinds": ["life_incident_started"]})[
                    "entries"
                ]
            ),
            1,
        )
        self.assertEqual(
            len(
                raw_log.query({"trace_id": "trace-2", "kinds": ["life_incident_started"]})[
                    "entries"
                ]
            ),
            1,
        )

    def test_reads_are_isolated_by_scope(self):
        raw_log = InMemoryRawEventLog()
        store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        ids = SequenceIdGenerator()
        first_event = normalized_user_message(
            event_id="event-1",
            trace_id="trace-1",
            user_id="user-1",
            conversation_id="conversation-1",
        )
        second_event = normalized_user_message(
            event_id="event-2",
            trace_id="trace-2",
            user_id="user-1",
            conversation_id="conversation-2",
        )
        empty_scope_event = normalized_user_message(
            event_id="event-3",
            trace_id="trace-3",
            user_id="user-3",
            conversation_id="conversation-3",
        )

        commit_life_incident_start(
            first_event,
            role_model_result_with_incident(event_id="event-1", trace_id="trace-1"),
            life_incident_start_finalizer=store,
            raw_event_log=raw_log,
            id_generator=ids,
            clock=fixed_clock,
        )
        commit_life_incident_start(
            second_event,
            role_model_result_with_incident(
                event_id="event-2",
                trace_id="trace-2",
                title="second conversation incident",
            ),
            life_incident_start_finalizer=store,
            raw_event_log=raw_log,
            id_generator=ids,
            clock=fixed_clock,
        )

        self.assertEqual(
            store.read_active_incident(build_active_incident_request(first_event))["title"],
            "thinking through the plan",
        )
        self.assertEqual(
            store.read_active_incident(build_active_incident_request(second_event))["title"],
            "second conversation incident",
        )
        self.assertIsNone(
            store.read_active_incident(build_active_incident_request(empty_scope_event))
        )

    def test_default_single_user_self_use_scope_behaves_like_current_mvp(self):
        raw_log = InMemoryRawEventLog()
        store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        first_event = normalized_user_message(
            event_id="event-1",
            trace_id="trace-1",
            user_id=None,
            conversation_id=None,
        )
        second_event = normalized_user_message(
            event_id="event-2",
            trace_id="trace-2",
            user_id=None,
            conversation_id=None,
        )

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
                title="second self-use incident",
            ),
            life_incident_start_finalizer=store,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(first_result["status"], LIFE_INCIDENT_STARTED_STATUS)
        self.assertEqual(second_result["status"], LIFE_INCIDENT_START_REJECTED_STATUS)
        self.assertEqual(
            store.read_active_incident(build_active_incident_request(second_event)),
            first_incident,
        )
        self.assertEqual(
            raw_log.query({"trace_id": "trace-2", "kinds": ["life_incident_started"]})["entries"],
            [],
        )

    def test_explicit_null_identity_fields_use_default_single_user_self_use_scope(self):
        raw_log = InMemoryRawEventLog()
        store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        first_event = normalized_user_message(
            event_id="event-1",
            trace_id="trace-1",
            user_id=None,
            conversation_id=None,
        )
        second_event = normalized_user_message(
            event_id="event-2",
            trace_id="trace-2",
            user_id=None,
            conversation_id=None,
        )
        first_request = finalize_request_for(
            first_event,
            role_model_result_with_incident(event_id="event-1", trace_id="trace-1"),
        )
        first_request["user_id"] = None
        first_request["conversation_id"] = None

        store.finalize_life_incident_start(first_request)
        read_request = build_active_incident_request(first_event)
        read_request["user_id"] = None
        read_request["conversation_id"] = None
        active_incident = store.read_active_incident(read_request)
        second_request = finalize_request_for(
            second_event,
            role_model_result_with_incident(
                event_id="event-2",
                trace_id="trace-2",
                title="second self-use incident",
            ),
        )

        with self.assertRaises(LifeIncidentStartFinalizerError) as context:
            store.finalize_life_incident_start(second_request)

        self.assertEqual(active_incident["title"], "thinking through the plan")
        self.assertEqual(context.exception.code, "finalize_rejected")
        self.assertIn("already exists", str(context.exception))

    def test_malformed_committed_log_entry_raises_finalizer_error(self):
        raw_log = InMemoryRawEventLog()
        store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        event = normalized_user_message()
        request = finalize_request_for(event, role_model_result_with_incident())
        request["committed_log_entry"] = "not a raw log entry"

        with self.assertRaises(LifeIncidentStartFinalizerError) as context:
            store.finalize_life_incident_start(request)

        self.assertEqual(context.exception.code, "malformed_finalize_result")

    def test_finalizes_cancel_and_clears_same_scope_active_incident(self):
        raw_log = InMemoryRawEventLog()
        store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        start_event = normalized_user_message(event_id="event-1", trace_id="trace-1")
        cancel_event = normalized_user_message(event_id="event-2", trace_id="trace-2")

        start_result = commit_life_incident_start(
            start_event,
            role_model_result_with_incident(event_id="event-1", trace_id="trace-1"),
            life_incident_start_finalizer=store,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )
        cancel_result = commit_life_incident_cancel(
            cancel_event,
            role_model_result_with_cancel(),
            active_incident_source=store,
            life_incident_cancel_finalizer=store,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        read_request = build_active_incident_request(cancel_event)
        success_entries = raw_log.query(
            {"trace_id": "trace-2", "kinds": ["life_incident_cancelled"]}
        )["entries"]

        self.assertEqual(start_result["status"], LIFE_INCIDENT_STARTED_STATUS)
        self.assertEqual(cancel_result["status"], LIFE_INCIDENT_CANCELLED_STATUS)
        self.assertIsNone(store.read_active_incident(read_request))
        self.assertEqual(len(success_entries), 1)
        self.assertEqual(cancel_result["committed_log_entry_id"], success_entries[0]["log_id"])
        self.assertEqual(
            success_entries[0]["data"]["cancelled_incident"],
            cancel_result["cancelled_incident"],
        )
        self.assertEqual(
            cancel_result["cancelled_incident"]["source_event_ids"],
            ["event-1", "event-2"],
        )

        cancel_result["cancelled_incident"]["title"] = "mutated result"
        success_entries[0]["data"]["cancelled_incident"]["title"] = "mutated query"
        self.assertIsNone(store.read_active_incident(read_request))
        self.assertEqual(
            raw_log.query({"trace_id": "trace-2", "kinds": ["life_incident_cancelled"]})["entries"][
                0
            ]["data"]["cancelled_incident"]["title"],
            "thinking through the plan",
        )

    def test_cancel_visibility_staging_failure_rejects_without_clearing_active_incident(self):
        raw_log = RejectingCancelRawEventLog()
        store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        start_event = normalized_user_message(event_id="event-1", trace_id="trace-1")
        cancel_event = normalized_user_message(event_id="event-2", trace_id="trace-2")
        ids = SequenceIdGenerator()
        commit_life_incident_start(
            start_event,
            role_model_result_with_incident(event_id="event-1", trace_id="trace-1"),
            life_incident_start_finalizer=store,
            raw_event_log=raw_log,
            id_generator=ids,
            clock=fixed_clock,
        )

        result = commit_life_incident_cancel(
            cancel_event,
            role_model_result_with_cancel(),
            active_incident_source=store,
            life_incident_cancel_finalizer=store,
            raw_event_log=raw_log,
            id_generator=ids,
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_CANCEL_REJECTED_STATUS)
        self.assertEqual(result["failure"]["stage"], "life_incident_cancel_finalize")
        self.assertEqual(result["failure"]["code"], "malformed_finalize_result")
        self.assertIsNotNone(
            store.read_active_incident(build_active_incident_request(cancel_event))
        )

    def test_direct_cancel_visibility_staging_failure_raises_finalizer_error(self):
        raw_log = RejectingCancelRawEventLog()
        store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        start_event = normalized_user_message(event_id="event-1", trace_id="trace-1")
        cancel_event = normalized_user_message(event_id="event-2", trace_id="trace-2")
        ids = SequenceIdGenerator()
        commit_life_incident_start(
            start_event,
            role_model_result_with_incident(event_id="event-1", trace_id="trace-1"),
            life_incident_start_finalizer=store,
            raw_event_log=raw_log,
            id_generator=ids,
            clock=fixed_clock,
        )
        active_incident = store.read_active_incident(build_active_incident_request(cancel_event))
        request = cancel_finalize_request_for(
            cancel_event,
            role_model_result_with_cancel(),
            active_incident,
        )

        with self.assertRaises(LifeIncidentCancelFinalizerError) as context:
            store.finalize_life_incident_cancel(request)

        self.assertEqual(context.exception.code, "malformed_finalize_result")
        self.assertEqual(
            store.read_active_incident(build_active_incident_request(cancel_event)),
            active_incident,
        )

    def test_cancel_visibility_confirm_failure_rejects_without_clearing_active_incident(self):
        raw_log = RejectingCancelConfirmRawEventLog()
        store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        start_event = normalized_user_message(event_id="event-1", trace_id="trace-1")
        cancel_event = normalized_user_message(event_id="event-2", trace_id="trace-2")
        ids = SequenceIdGenerator()
        commit_life_incident_start(
            start_event,
            role_model_result_with_incident(event_id="event-1", trace_id="trace-1"),
            life_incident_start_finalizer=store,
            raw_event_log=raw_log,
            id_generator=ids,
            clock=fixed_clock,
        )
        active_incident = deepcopy(
            store.read_active_incident(build_active_incident_request(cancel_event))
        )

        result = commit_life_incident_cancel(
            cancel_event,
            role_model_result_with_cancel(),
            active_incident_source=store,
            life_incident_cancel_finalizer=store,
            raw_event_log=raw_log,
            id_generator=ids,
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_CANCEL_REJECTED_STATUS)
        self.assertEqual(result["failure"]["stage"], "life_incident_cancel_finalize")
        self.assertEqual(result["failure"]["code"], "malformed_finalize_result")
        self.assertIn("cancel visibility confirm failed", result["failure"]["message"])
        self.assertEqual(
            store.read_active_incident(build_active_incident_request(cancel_event)),
            active_incident,
        )
        self.assertEqual(
            raw_log.query({"trace_id": "trace-2", "kinds": ["life_incident_cancelled"]})["entries"],
            [],
        )

    def test_raw_log_mismatch_rejects_cancel_before_staging_or_clearing_active_incident(self):
        store_raw_log = InMemoryRawEventLog()
        commit_raw_log = InMemoryRawEventLog()
        store = InMemoryLifeIncidentStore(raw_event_log=store_raw_log)
        start_event = normalized_user_message(event_id="event-1", trace_id="trace-1")
        cancel_event = normalized_user_message(event_id="event-2", trace_id="trace-2")
        commit_life_incident_start(
            start_event,
            role_model_result_with_incident(event_id="event-1", trace_id="trace-1"),
            life_incident_start_finalizer=store,
            raw_event_log=store_raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        result = commit_life_incident_cancel(
            cancel_event,
            role_model_result_with_cancel(),
            active_incident_source=store,
            life_incident_cancel_finalizer=store,
            raw_event_log=commit_raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIFE_INCIDENT_CANCEL_REJECTED_STATUS)
        self.assertEqual(result["failure"]["stage"], "life_incident_cancel_finalize")
        self.assertEqual(result["failure"]["code"], "malformed_finalize_result")
        self.assertIn("same Raw Event Log instance", result["failure"]["message"])
        self.assertIsNotNone(
            store.read_active_incident(build_active_incident_request(cancel_event))
        )
        self.assertEqual(
            store_raw_log.query({"trace_id": "trace-2", "kinds": ["life_incident_cancelled"]})[
                "entries"
            ],
            [],
        )
        self.assertEqual(
            [entry["kind"] for entry in commit_raw_log.query({"trace_id": "trace-2"})["entries"]],
            ["life_incident_cancel_rejected"],
        )

    def test_cancel_raw_log_mismatch_direct_check_raises_cancel_finalizer_error(self):
        store_raw_log = InMemoryRawEventLog()
        commit_raw_log = InMemoryRawEventLog()
        store = InMemoryLifeIncidentStore(raw_event_log=store_raw_log)

        with self.assertRaises(LifeIncidentCancelFinalizerError) as context:
            store.require_life_incident_cancel_raw_event_log(commit_raw_log)

        self.assertEqual(context.exception.code, "malformed_finalize_result")
        self.assertIn("same Raw Event Log instance", str(context.exception))

    def test_cancel_clears_only_matching_scope(self):
        raw_log = InMemoryRawEventLog()
        store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        first_event = normalized_user_message(
            event_id="event-1",
            trace_id="trace-1",
            user_id="user-1",
            conversation_id="conversation-1",
        )
        second_event = normalized_user_message(
            event_id="event-2",
            trace_id="trace-2",
            user_id="user-2",
            conversation_id="conversation-1",
        )
        cancel_event = normalized_user_message(
            event_id="event-3",
            trace_id="trace-3",
            user_id="user-1",
            conversation_id="conversation-1",
        )
        ids = SequenceIdGenerator()
        commit_life_incident_start(
            first_event,
            role_model_result_with_incident(event_id="event-1", trace_id="trace-1"),
            life_incident_start_finalizer=store,
            raw_event_log=raw_log,
            id_generator=ids,
            clock=fixed_clock,
        )
        second_result = commit_life_incident_start(
            second_event,
            role_model_result_with_incident(
                event_id="event-2",
                trace_id="trace-2",
                title="second user incident",
            ),
            life_incident_start_finalizer=store,
            raw_event_log=raw_log,
            id_generator=ids,
            clock=fixed_clock,
        )

        cancel_result = commit_life_incident_cancel(
            cancel_event,
            role_model_result_with_cancel(
                event_id="event-3",
                trace_id="trace-3",
                incident_id="incident-generated-1",
            ),
            active_incident_source=store,
            life_incident_cancel_finalizer=store,
            raw_event_log=raw_log,
            id_generator=ids,
            clock=fixed_clock,
        )

        self.assertEqual(second_result["status"], LIFE_INCIDENT_STARTED_STATUS)
        self.assertEqual(cancel_result["status"], LIFE_INCIDENT_CANCELLED_STATUS)
        self.assertIsNone(store.read_active_incident(build_active_incident_request(cancel_event)))
        self.assertEqual(
            store.read_active_incident(build_active_incident_request(second_event))["title"],
            "second user incident",
        )

    def test_direct_cancel_rejects_when_current_active_incident_changed(self):
        raw_log = InMemoryRawEventLog()
        store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        start_event = normalized_user_message(event_id="event-1", trace_id="trace-1")
        event = normalized_user_message(event_id="event-2", trace_id="trace-2")
        commit_life_incident_start(
            start_event,
            role_model_result_with_incident(event_id="event-1", trace_id="trace-1"),
            life_incident_start_finalizer=store,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )
        active_incident = store.read_active_incident(build_active_incident_request(event))
        stale_active_incident = {**active_incident, "title": "stale title"}
        request = cancel_finalize_request_for(
            event,
            role_model_result_with_cancel(event_id="event-2", trace_id="trace-2"),
            stale_active_incident,
        )

        with self.assertRaises(LifeIncidentCancelFinalizerError) as context:
            store.finalize_life_incident_cancel(request)

        self.assertEqual(context.exception.code, "finalize_rejected")
        self.assertEqual(
            store.read_active_incident(build_active_incident_request(event)),
            active_incident,
        )


if __name__ == "__main__":
    unittest.main()
