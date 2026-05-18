import sys
import unittest
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from commit_effects.living_state import (  # noqa: E402
    LIVING_STATE_PATCH_COMMITTED_STATUS,
    LIVING_STATE_PATCH_FINALIZE_STAGE,
    LIVING_STATE_PATCH_REJECTED_STATUS,
    LIVING_STATE_PATCH_SKIPPED_STATUS,
    LivingStatePatchFinalizerError,
    LivingStatePatchStoreError,
    build_living_state_patch_commit_request,
    build_living_state_patch_committed_log_entry,
    build_living_state_patch_rejected_log_entry,
    commit_living_state_patch,
)


def fixed_clock():
    return datetime(2026, 5, 17, 9, 0, 0, tzinfo=UTC)


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


class RecordingLivingStatePatchStore:
    def __init__(self, snapshot=None, error=None):
        self.snapshot = snapshot or committed_snapshot()
        self.error = error
        self.requests = []
        self.durable_commits = []

    def prepare_living_state_patch_commit(self, request):
        self.requests.append(deepcopy(request))
        if self.error is not None:
            raise self.error
        return deepcopy(self.snapshot)


class RecordingLivingStatePatchFinalizer:
    def __init__(self, error=None, result_override=None):
        self.error = error
        self.result_override = deepcopy(result_override)
        self.requests = []
        self.durable_state_snapshots = []
        self.durable_success_logs = []

    def finalize_living_state_patch_commit(self, request):
        self.requests.append(deepcopy(request))
        if self.error is not None:
            raise self.error
        if self.result_override is not None:
            return deepcopy(self.result_override)
        self.durable_state_snapshots.append(deepcopy(request["committed_snapshot"]))
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
        "created_at": "2026-05-17T08:59:00+00:00",
        "schema_version": "0.1",
        "payload": {
            "text": "hello",
            "user_id": "user-1",
            "conversation_id": "conversation-1",
        },
    }


def role_model_result_with_patch():
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
            "state_patch": {
                "living_state": {
                    "current_activity": " answering the user ",
                    "mood": " attentive ",
                }
            },
        },
    }


def role_model_result_without_patch():
    result = role_model_result_with_patch()
    del result["decision"]["state_patch"]
    return result


def committed_snapshot():
    return {
        "schema_version": "0.1",
        "character_id": "character-1",
        "living_state": {
            "current_activity": "answering the user",
            "mood": "attentive",
            "toward_user": "warm",
        },
        "updated_at": "2026-05-17T09:00:00+00:00",
        "source_event_ids": ["event-state-1", "event-1"],
    }


class LivingStatePatchCommitTests(unittest.TestCase):
    def test_builds_commit_request_without_model_authored_store_fields(self):
        request = build_living_state_patch_commit_request(
            normalized_user_message(),
            role_model_result_with_patch(),
        )

        self.assertEqual(
            request,
            {
                "schema_version": "0.1",
                "trace_id": "trace-1",
                "event_id": "event-1",
                "event_type": "USER_MESSAGE",
                "decision_action": "visible_reply",
                "patch": {
                    "living_state": {
                        "current_activity": "answering the user",
                        "mood": "attentive",
                    }
                },
                "user_id": "user-1",
                "conversation_id": "conversation-1",
            },
        )
        self.assertNotIn("updated_at", request["patch"]["living_state"])
        self.assertNotIn("source_event_ids", request["patch"]["living_state"])

    def test_returns_skipped_without_log_or_store_call_when_decision_has_no_patch(self):
        raw_log = RecordingRawEventLog()
        store = RecordingLivingStatePatchStore()
        finalizer = RecordingLivingStatePatchFinalizer()

        result = commit_living_state_patch(
            normalized_user_message(),
            role_model_result_without_patch(),
            living_state_patch_store=store,
            living_state_patch_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIVING_STATE_PATCH_SKIPPED_STATUS)
        self.assertEqual(store.requests, [])
        self.assertEqual(finalizer.requests, [])
        self.assertEqual(raw_log.entries, [])

    def test_commits_patch_through_atomic_finalizer_and_uses_copies(self):
        raw_log = RecordingRawEventLog()
        store = RecordingLivingStatePatchStore()
        finalizer = RecordingLivingStatePatchFinalizer()
        event = normalized_user_message()
        role_model_result = role_model_result_with_patch()

        result = commit_living_state_patch(
            event,
            role_model_result,
            living_state_patch_store=store,
            living_state_patch_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        event["payload"]["text"] = "mutated event"
        role_model_result["decision"]["state_patch"]["living_state"]["mood"] = "mutated"
        result["committed_snapshot"]["living_state"]["mood"] = "mutated result"
        store.requests[0]["patch"]["living_state"]["mood"] = "mutated request"
        finalizer.requests[0]["committed_snapshot"]["living_state"]["mood"] = (
            "mutated finalizer request"
        )
        finalizer.requests[0]["committed_log_entry"]["data"]["source_event"]["payload"]["text"] = (
            "mutated finalizer request"
        )

        self.assertEqual(result["status"], LIVING_STATE_PATCH_COMMITTED_STATUS)
        self.assertEqual(
            result["committed_log_entry_id"],
            finalizer.durable_success_logs[0]["log_id"],
        )
        self.assertEqual(store.requests[0]["commit_time"], "2026-05-17T09:00:00+00:00")
        self.assertEqual(
            store.requests[0]["patch"]["living_state"]["current_activity"],
            "answering the user",
        )
        self.assertEqual(len(store.requests), 1)
        self.assertEqual(len(finalizer.requests), 1)
        self.assertEqual(raw_log.entries, [])
        self.assertEqual(finalizer.durable_success_logs[0]["kind"], "living_state_patch_committed")
        self.assertEqual(
            finalizer.requests[0]["committed_snapshot"]["source_event_ids"],
            ["event-state-1", "event-1"],
        )
        self.assertEqual(
            finalizer.durable_state_snapshots[0]["living_state"]["mood"],
            "attentive",
        )
        self.assertEqual(
            finalizer.durable_success_logs[0]["data"]["source_event"]["payload"]["text"],
            "hello",
        )
        self.assertEqual(
            finalizer.durable_success_logs[0]["data"]["patch"]["living_state"]["mood"],
            "attentive",
        )
        self.assertEqual(
            finalizer.durable_success_logs[0]["data"]["committed_snapshot"]["source_event_ids"],
            ["event-state-1", "event-1"],
        )

    def test_finalizer_failure_rejects_without_durable_state_or_success_log(self):
        raw_log = RecordingRawEventLog()
        store = RecordingLivingStatePatchStore()
        finalizer = RecordingLivingStatePatchFinalizer(
            error=LivingStatePatchFinalizerError(
                "finalize rejected",
                code="finalize_rejected",
            )
        )

        result = commit_living_state_patch(
            normalized_user_message(),
            role_model_result_with_patch(),
            living_state_patch_store=store,
            living_state_patch_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIVING_STATE_PATCH_REJECTED_STATUS)
        self.assertEqual(result["failure"]["stage"], LIVING_STATE_PATCH_FINALIZE_STAGE)
        self.assertEqual(result["failure"]["code"], "finalize_rejected")
        self.assertEqual(len(store.requests), 1)
        self.assertEqual(len(finalizer.requests), 1)
        self.assertEqual(finalizer.durable_state_snapshots, [])
        self.assertEqual(finalizer.durable_success_logs, [])
        self.assertEqual(raw_log.entries[0]["kind"], "living_state_patch_rejected")
        self.assertEqual(raw_log.entries[0]["data"]["failure"], result["failure"])

    def test_malformed_finalizer_result_rejects_without_durable_state_or_success_log(self):
        raw_log = RecordingRawEventLog()
        store = RecordingLivingStatePatchStore()
        finalizer = RecordingLivingStatePatchFinalizer(
            result_override={
                "schema_version": "0.1",
                "trace_id": "trace-1",
                "event_id": "event-1",
                "event_type": "USER_MESSAGE",
                "committed_log_entry_id": "wrong-log-id",
            }
        )

        result = commit_living_state_patch(
            normalized_user_message(),
            role_model_result_with_patch(),
            living_state_patch_store=store,
            living_state_patch_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIVING_STATE_PATCH_REJECTED_STATUS)
        self.assertEqual(result["failure"]["stage"], LIVING_STATE_PATCH_FINALIZE_STAGE)
        self.assertEqual(result["failure"]["code"], "malformed_finalize_result")
        self.assertEqual(len(finalizer.requests), 1)
        self.assertEqual(finalizer.durable_state_snapshots, [])
        self.assertEqual(finalizer.durable_success_logs, [])
        self.assertEqual(raw_log.entries[0]["kind"], "living_state_patch_rejected")

    def test_store_rejection_appends_rejected_log_and_returns_failure(self):
        raw_log = RecordingRawEventLog()
        store = RecordingLivingStatePatchStore(
            error=LivingStatePatchStoreError("store rejected", code="store_rejected")
        )
        finalizer = RecordingLivingStatePatchFinalizer()

        result = commit_living_state_patch(
            normalized_user_message(),
            role_model_result_with_patch(),
            living_state_patch_store=store,
            living_state_patch_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIVING_STATE_PATCH_REJECTED_STATUS)
        self.assertEqual(result["failure"]["stage"], "living_state_patch_store")
        self.assertEqual(result["failure"]["code"], "store_rejected")
        self.assertEqual(finalizer.requests, [])
        self.assertEqual(raw_log.entries[0]["kind"], "living_state_patch_rejected")
        self.assertEqual(raw_log.entries[0]["data"]["failure"], result["failure"])

    def test_commit_validation_rejection_logs_before_store_call(self):
        raw_log = RecordingRawEventLog()
        store = RecordingLivingStatePatchStore()
        finalizer = RecordingLivingStatePatchFinalizer()
        role_model_result = role_model_result_with_patch()
        role_model_result["decision"]["state_patch"] = {"living_state": {}}

        result = commit_living_state_patch(
            normalized_user_message(),
            role_model_result,
            living_state_patch_store=store,
            living_state_patch_finalizer=finalizer,
            raw_event_log=raw_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], LIVING_STATE_PATCH_REJECTED_STATUS)
        self.assertEqual(result["failure"]["stage"], "living_state_patch_commit_validation")
        self.assertEqual(result["failure"]["code"], "malformed_commit_input")
        self.assertEqual(store.requests, [])
        self.assertEqual(finalizer.requests, [])
        self.assertEqual(len(raw_log.entries), 1)
        self.assertEqual(raw_log.entries[0]["kind"], "living_state_patch_rejected")
        self.assertEqual(raw_log.entries[0]["data"]["failure"], result["failure"])
        self.assertNotIn("patch_snapshot", raw_log.entries[0]["data"])

    def test_shape_valid_but_inconsistent_store_result_rejects_as_malformed_store_result(self):
        cases = [
            (
                {**committed_snapshot(), "source_event_ids": ["event-state-1"]},
                "source_event_ids",
            ),
            (
                {
                    **committed_snapshot(),
                    "living_state": {
                        **committed_snapshot()["living_state"],
                        "mood": "focused",
                    },
                },
                "living_state.mood",
            ),
            (
                {**committed_snapshot(), "updated_at": "2026-05-17T08:58:00+00:00"},
                "updated_at",
            ),
        ]

        for snapshot, message_pattern in cases:
            with self.subTest(message_pattern=message_pattern):
                raw_log = RecordingRawEventLog()
                store = RecordingLivingStatePatchStore(snapshot=snapshot)
                finalizer = RecordingLivingStatePatchFinalizer()

                result = commit_living_state_patch(
                    normalized_user_message(),
                    role_model_result_with_patch(),
                    living_state_patch_store=store,
                    living_state_patch_finalizer=finalizer,
                    raw_event_log=raw_log,
                    id_generator=SequenceIdGenerator(),
                    clock=fixed_clock,
                )

                self.assertEqual(result["status"], LIVING_STATE_PATCH_REJECTED_STATUS)
                self.assertEqual(result["failure"]["stage"], "living_state_patch_store")
                self.assertEqual(result["failure"]["code"], "malformed_store_result")
                self.assertRegex(result["failure"]["message"], message_pattern)
                self.assertEqual(len(store.requests), 1)
                self.assertEqual(finalizer.requests, [])
                self.assertEqual(len(raw_log.entries), 1)
                self.assertEqual(raw_log.entries[0]["kind"], "living_state_patch_rejected")
                self.assertEqual(raw_log.entries[0]["data"]["failure"], result["failure"])

    def test_committed_log_entry_deep_copies_inputs(self):
        event = normalized_user_message()
        role_model_result = role_model_result_with_patch()
        request = build_living_state_patch_commit_request(event, role_model_result)
        snapshot = committed_snapshot()

        entry = build_living_state_patch_committed_log_entry(
            event,
            role_model_result,
            request["patch"],
            snapshot,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        event["payload"]["text"] = "mutated"
        role_model_result["decision"]["visible_reply"]["text"] = "mutated"
        request["patch"]["living_state"]["mood"] = "mutated"
        snapshot["living_state"]["mood"] = "mutated"

        self.assertEqual(entry["kind"], "living_state_patch_committed")
        self.assertEqual(entry["data"]["source_event"]["payload"]["text"], "hello")
        self.assertEqual(
            entry["data"]["role_model_result"]["decision"]["visible_reply"]["text"],
            "hello back",
        )
        self.assertEqual(entry["data"]["patch"]["living_state"]["mood"], "attentive")
        self.assertEqual(entry["data"]["committed_snapshot"]["living_state"]["mood"], "attentive")

    def test_rejected_log_entry_deep_copies_inputs(self):
        event = normalized_user_message()
        role_model_result = role_model_result_with_patch()
        patch = build_living_state_patch_commit_request(event, role_model_result)["patch"]
        failure = {
            "stage": "living_state_patch_store",
            "code": "store_rejected",
            "message": "store rejected",
        }

        entry = build_living_state_patch_rejected_log_entry(
            event,
            role_model_result_snapshot=role_model_result,
            patch_snapshot=patch,
            failure=failure,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        event["payload"]["text"] = "mutated"
        role_model_result["decision"]["visible_reply"]["text"] = "mutated"
        patch["living_state"]["mood"] = "mutated"
        failure["message"] = "mutated"

        self.assertEqual(entry["kind"], "living_state_patch_rejected")
        self.assertEqual(entry["data"]["source_event"]["payload"]["text"], "hello")
        self.assertEqual(
            entry["data"]["role_model_result_snapshot"]["decision"]["visible_reply"]["text"],
            "hello back",
        )
        self.assertEqual(entry["data"]["patch_snapshot"]["living_state"]["mood"], "attentive")
        self.assertEqual(entry["data"]["failure"]["message"], "store rejected")


if __name__ == "__main__":
    unittest.main()
