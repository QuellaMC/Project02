import json
import sys
import unittest
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from character.state.current import build_active_incident_request  # noqa: E402
from character.state.incidents import InMemoryLifeIncidentStore  # noqa: E402
from commit_effects.incident_start import (  # noqa: E402
    LIFE_INCIDENT_START_FINALIZE_STAGE,
    LifeIncidentStartFinalizerError,
)
from commit_effects.living_state import (  # noqa: E402
    LIVING_STATE_PATCH_FINALIZE_STAGE,
    LivingStatePatchFinalizerError,
)
from runtime.kernel import RuntimeKernel, RuntimeValidationError  # noqa: E402
from runtime.logging import InMemoryRawEventLog  # noqa: E402
from runtime.user_turn import run_user_message_turn  # noqa: E402


def fixed_clock():
    return datetime(2026, 5, 14, 11, 30, 0, tzinfo=UTC)


class SequenceIdGenerator:
    def __init__(self):
        self.calls = []

    def __call__(self, kind):
        self.calls.append(kind)
        return f"{kind}-generated-{len(self.calls)}"


class RecordingRawEventLog:
    def __init__(self, operations=None):
        self.entries = []
        self.operations = operations if operations is not None else []

    def append(self, entry):
        self.entries.append(deepcopy(entry))
        self.operations.append(("raw_log", entry["kind"]))


def assert_context_build_failure_log(test_case, raw_log, *, message_fragment):
    entry = raw_log.entries[-1]
    test_case.assertEqual(entry["kind"], "role_model_turn_failed")
    test_case.assertEqual(entry["trace_id"], "trace-current")
    test_case.assertEqual(entry["event_id"], "event-current")
    test_case.assertEqual(entry["data"]["event"]["event_id"], "event-current")
    test_case.assertNotIn("model_input", entry["data"])
    test_case.assertEqual(entry["data"]["failure"]["stage"], "context_build")
    test_case.assertEqual(entry["data"]["failure"]["code"], "malformed_context")
    test_case.assertIn(message_fragment, entry["data"]["failure"]["message"])


class RecordingAdapter:
    def __init__(self, raw_text=None):
        self.calls = []
        self.raw_text = raw_text or json.dumps(
            {
                "schema_version": "0.1",
                "action": "visible_reply",
                "visible_reply": {"text": "hello back"},
            }
        )

    def generate(self, model_input):
        self.calls.append(deepcopy(model_input))
        return {
            "model_id": "fake-role-model",
            "created_at": "2026-05-14T11:30:00+00:00",
            "raw_text": self.raw_text,
        }


class InMemoryVisibleConversation:
    def __init__(self, records=None):
        self.records = deepcopy(records or [])
        self.read_requests = []

    def append(self, output):
        self.records.append(deepcopy(output))

    def read_visible_conversation_records(self, request):
        self.read_requests.append(deepcopy(request))
        records = [
            record
            for record in self.records
            if record.get("conversation_id") == request["conversation_id"]
        ]
        return deepcopy(records[-request["max_candidate_records"] :])


def current_state_snapshot():
    return {
        "schema_version": "0.1",
        "character_id": "character-1",
        "living_state": {
            "current_activity": "writing notes",
            "mood": "focused",
            "toward_user": "warm",
        },
        "updated_at": "2026-05-14T11:29:00+00:00",
        "source_event_ids": ["event-state-1"],
    }


def living_state_brief():
    return {
        "character_id": "character-1",
        "current_activity": "writing notes",
        "mood": "focused",
        "toward_user": "warm",
        "updated_at": "2026-05-14T11:29:00+00:00",
        "source_event_ids": ["event-state-1"],
    }


def active_incident_snapshot():
    return {
        "schema_version": "0.1",
        "incident_id": "incident-1",
        "type": "eat",
        "status": "active",
        "title": "Eating lunch",
        "started_at": "2026-05-14T11:00:00+00:00",
        "expected_end_at": "2026-05-14T11:40:00+00:00",
        "remaining_seconds": 600,
        "interrupt_policy": "interruptible",
        "resume_policy": "resume",
        "source_event_ids": ["event-incident-started"],
    }


def active_incident_brief():
    return {
        "incident_id": "incident-1",
        "type": "eat",
        "title": "Eating lunch",
        "started_at": "2026-05-14T11:00:00+00:00",
        "expected_end_at": "2026-05-14T11:40:00+00:00",
        "remaining_seconds": 600,
        "interrupt_policy": "interruptible",
        "resume_policy": "resume",
        "source_event_ids": ["event-incident-started"],
    }


class RecordingCurrentStateSource:
    def __init__(self, snapshot):
        self.snapshot = deepcopy(snapshot)
        self.requests = []

    def read_current_state(self, request):
        self.requests.append(deepcopy(request))
        return deepcopy(self.snapshot)


class RecordingActiveIncidentSource:
    def __init__(self, snapshot):
        self.snapshot = deepcopy(snapshot)
        self.requests = []

    def read_active_incident(self, request):
        self.requests.append(deepcopy(request))
        return deepcopy(self.snapshot)


class SequenceActiveIncidentSource:
    def __init__(self, snapshots):
        self.snapshots = [deepcopy(snapshot) for snapshot in snapshots]
        self.requests = []

    def read_active_incident(self, request):
        self.requests.append(deepcopy(request))
        if not self.snapshots:
            return None
        return deepcopy(self.snapshots.pop(0))


class RecordingInterruptedIncidentSource:
    def __init__(self, snapshot):
        self.snapshot = deepcopy(snapshot)
        self.requests = []

    def read_interrupted_incident(self, request):
        self.requests.append(deepcopy(request))
        return deepcopy(self.snapshot)


class RecordingLivingStatePatchStore:
    def __init__(self, snapshot=None, error=None):
        self.snapshot = deepcopy(snapshot or committed_snapshot())
        self.error = error
        self.requests = []

    def prepare_living_state_patch_commit(self, request):
        self.requests.append(deepcopy(request))
        if self.error is not None:
            raise self.error
        return deepcopy(self.snapshot)


class RecordingLivingStatePatchFinalizer:
    def __init__(
        self,
        error=None,
        result_override=None,
        operations=None,
        raw_log_visibility=None,
        expose_before_result_override=False,
        append_before_result_override=False,
        expose_conflicting_success=False,
    ):
        self.error = error
        self.result_override = deepcopy(result_override)
        self.operations = operations if operations is not None else []
        self.raw_log_visibility = raw_log_visibility
        self.expose_before_result_override = expose_before_result_override
        self.append_before_result_override = append_before_result_override
        self.expose_conflicting_success = expose_conflicting_success
        self.requests = []
        self.durable_state_snapshots = []
        self.durable_success_logs = []

    def finalize_living_state_patch_commit(self, request):
        self.requests.append(deepcopy(request))
        if self.error is not None:
            raise self.error
        if self.raw_log_visibility is not None and self.expose_conflicting_success:
            self.raw_log_visibility.expose_committed_success_entry(request["committed_log_entry"])
            conflicting_entry = deepcopy(request["committed_log_entry"])
            conflicting_entry["data"]["visibility_conflict"] = True
            self.raw_log_visibility.expose_committed_success_entry(conflicting_entry)
        if self.result_override is not None:
            if self.raw_log_visibility is not None and self.append_before_result_override:
                self.raw_log_visibility.append(request["committed_log_entry"])
            if self.raw_log_visibility is not None and self.expose_before_result_override:
                self.raw_log_visibility.expose_committed_success_entry(
                    request["committed_log_entry"]
                )
            return deepcopy(self.result_override)
        if self.raw_log_visibility is not None:
            self.raw_log_visibility.expose_committed_success_entry(request["committed_log_entry"])
        self.durable_state_snapshots.append(deepcopy(request["committed_snapshot"]))
        self.durable_success_logs.append(deepcopy(request["committed_log_entry"]))
        self.operations.append(("atomic_finalizer", request["committed_log_entry"]["kind"]))
        return {
            "schema_version": "0.1",
            "trace_id": request["trace_id"],
            "event_id": request["event_id"],
            "event_type": request["event_type"],
            "committed_log_entry_id": request["committed_log_entry"]["log_id"],
        }


class RecordingLifeIncidentStartFinalizer:
    def __init__(
        self,
        error=None,
        result_override=None,
        operations=None,
        raw_log_visibility=None,
        expose_before_result_override=False,
        append_before_result_override=False,
        expose_conflicting_success=False,
    ):
        self.error = error
        self.result_override = deepcopy(result_override)
        self.operations = operations if operations is not None else []
        self.raw_log_visibility = raw_log_visibility
        self.expose_before_result_override = expose_before_result_override
        self.append_before_result_override = append_before_result_override
        self.expose_conflicting_success = expose_conflicting_success
        self.requests = []
        self.durable_started_incidents = []
        self.durable_raw_event_log_entries = []

    def finalize_life_incident_start(self, request):
        self.requests.append(deepcopy(request))
        if self.error is not None:
            raise self.error
        if self.raw_log_visibility is not None and self.expose_conflicting_success:
            self.raw_log_visibility.expose_committed_success_entry(request["committed_log_entry"])
            conflicting_entry = deepcopy(request["committed_log_entry"])
            conflicting_entry["data"]["visibility_conflict"] = True
            self.raw_log_visibility.expose_committed_success_entry(conflicting_entry)
        if self.result_override is not None:
            if self.raw_log_visibility is not None and self.append_before_result_override:
                self.raw_log_visibility.append(request["committed_log_entry"])
            if self.raw_log_visibility is not None and self.expose_before_result_override:
                self.raw_log_visibility.expose_committed_success_entry(
                    request["committed_log_entry"]
                )
            return deepcopy(self.result_override)
        if self.raw_log_visibility is not None:
            self.raw_log_visibility.expose_committed_success_entry(request["committed_log_entry"])
        self.durable_started_incidents.append(deepcopy(request["started_incident"]))
        self.durable_raw_event_log_entries.append(deepcopy(request["committed_log_entry"]))
        self.operations.append(("atomic_finalizer", request["committed_log_entry"]["kind"]))
        return {
            "schema_version": "0.1",
            "trace_id": request["trace_id"],
            "event_id": request["event_id"],
            "event_type": request["event_type"],
            "committed_log_entry_id": request["committed_log_entry"]["log_id"],
        }


class RecordingLifeIncidentCancelFinalizer:
    def __init__(
        self,
        error=None,
        result_override=None,
        operations=None,
        raw_log_visibility=None,
        expose_before_result_override=False,
        append_before_result_override=False,
        expose_conflicting_success=False,
    ):
        self.error = error
        self.result_override = deepcopy(result_override)
        self.operations = operations if operations is not None else []
        self.raw_log_visibility = raw_log_visibility
        self.expose_before_result_override = expose_before_result_override
        self.append_before_result_override = append_before_result_override
        self.expose_conflicting_success = expose_conflicting_success
        self.requests = []
        self.completion_requests = []
        self.durable_cancelled_incidents = []
        self.durable_raw_event_log_entries = []

    def finalize_life_incident_cancel(self, request):
        self.requests.append(deepcopy(request))
        if self.error is not None:
            raise self.error
        if self.raw_log_visibility is not None and self.expose_conflicting_success:
            self.raw_log_visibility.expose_committed_success_entry(request["committed_log_entry"])
            conflicting_entry = deepcopy(request["committed_log_entry"])
            conflicting_entry["data"]["visibility_conflict"] = True
            self.raw_log_visibility.expose_committed_success_entry(conflicting_entry)
        if self.result_override is not None:
            if self.raw_log_visibility is not None and self.append_before_result_override:
                self.raw_log_visibility.append(request["committed_log_entry"])
            if self.raw_log_visibility is not None and self.expose_before_result_override:
                self.raw_log_visibility.expose_committed_success_entry(
                    request["committed_log_entry"]
                )
            return deepcopy(self.result_override)
        if self.raw_log_visibility is not None:
            self.raw_log_visibility.expose_committed_success_entry(request["committed_log_entry"])
        return {
            "schema_version": "0.1",
            "trace_id": request["trace_id"],
            "event_id": request["event_id"],
            "event_type": request["event_type"],
            "committed_log_entry_id": request["committed_log_entry"]["log_id"],
        }

    def complete_life_incident_cancel_after_log_visible(self, request):
        self.completion_requests.append(deepcopy(request))
        self.durable_cancelled_incidents.append(deepcopy(request["cancelled_incident"]))
        self.durable_raw_event_log_entries.append(deepcopy(request["committed_log_entry"]))
        self.operations.append(("atomic_finalizer", request["committed_log_entry"]["kind"]))


def prior_user_record():
    return {
        "schema_version": "0.1",
        "message_id": "message-prior",
        "trace_id": "trace-prior",
        "source_event_id": "event-prior",
        "kind": "user_visible_message",
        "role": "user",
        "conversation_id": "c-1",
        "created_at": "2026-05-14T11:00:00+00:00",
        "text": "prior hello",
        "source": {"runtime_event_type": "USER_MESSAGE"},
    }


def committed_snapshot():
    return {
        "schema_version": "0.1",
        "character_id": "character-1",
        "living_state": {
            "current_activity": "answering the user",
            "mood": "attentive",
            "toward_user": "warm",
        },
        "updated_at": "2026-05-14T11:30:00+00:00",
        "source_event_ids": ["event-state-1", "event-current"],
    }


class UserMessageTurnIntegrationTests(unittest.TestCase):
    def test_runs_one_user_turn_with_shared_route_and_committed_visible_records(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        adapter = RecordingAdapter()

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "schema_version": "0.1",
                "payload": {
                    "text": "hello now",
                    "user_id": "u-1",
                    "conversation_id": "c-1",
                },
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(result["status"], "user_turn_committed")
        self.assertEqual(result["trace_id"], "trace-current")
        self.assertEqual(result["event_id"], "event-current")
        self.assertEqual(
            result["kernel_route"],
            {
                "trace_id": "trace-current",
                "event_id": "event-current",
                "event_type": "USER_MESSAGE",
                "model_needed": True,
                "next_step": "user_turn",
            },
        )
        self.assertEqual(
            [entry["kind"] for entry in raw_log.entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "visible_reply_committed",
            ],
        )
        self.assertEqual(
            [record["kind"] for record in visible_conversation.records],
            [
                "user_visible_message",
                "user_visible_message",
                "assistant_visible_reply",
            ],
        )
        self.assertEqual(visible_conversation.records[1]["text"], "hello now")
        self.assertEqual(visible_conversation.records[2]["text"], "hello back")
        self.assertEqual(
            result["visible_record_ids"],
            {
                "user_message_id": visible_conversation.records[1]["message_id"],
                "assistant_output_id": visible_conversation.records[2]["output_id"],
            },
        )

        recent_messages = adapter.calls[0]["decision_context"]["character_snapshot"][
            "recent_visible_messages"
        ]
        self.assertEqual(
            recent_messages,
            [
                {
                    "schema_version": "0.1",
                    "message_id": "message-prior",
                    "trace_id": "trace-prior",
                    "source_event_id": "event-prior",
                    "conversation_id": "c-1",
                    "role": "user",
                    "created_at": "2026-05-14T11:00:00+00:00",
                    "text": "prior hello",
                }
            ],
        )
        self.assertEqual(len(adapter.calls), 1)
        self.assertEqual(len(visible_conversation.read_requests), 1)

        result["user_visible_message_result"]["message"]["text"] = "mutated"
        result["visible_reply_result"]["output"]["text"] = "mutated"
        self.assertEqual(visible_conversation.records[1]["text"], "hello now")
        self.assertEqual(visible_conversation.records[2]["text"], "hello back")

    def test_raw_log_query_surface_returns_ordinary_turn_logs(self):
        raw_log = InMemoryRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "schema_version": "0.1",
                "payload": {
                    "text": "hello now",
                    "user_id": "u-1",
                    "conversation_id": "c-1",
                },
            },
            adapter=RecordingAdapter(),
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        all_entries = raw_log.query({"trace_id": result["trace_id"]})["entries"]
        visible_reply_entries = raw_log.query(
            {
                "trace_id": result["trace_id"],
                "event_id": result["event_id"],
                "kinds": ["visible_reply_committed"],
            }
        )["entries"]

        self.assertEqual(
            [entry["kind"] for entry in all_entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "visible_reply_committed",
            ],
        )
        self.assertEqual(
            [entry["kind"] for entry in visible_reply_entries],
            ["visible_reply_committed"],
        )

    def test_runs_one_user_turn_with_current_state_in_model_input(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        adapter = RecordingAdapter()
        current_state_source = RecordingCurrentStateSource(current_state_snapshot())

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "schema_version": "0.1",
                "payload": {
                    "text": "hello now",
                    "user_id": "u-1",
                    "conversation_id": "c-1",
                },
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            current_state_source=current_state_source,
        )

        self.assertEqual(result["status"], "user_turn_committed")
        self.assertEqual(
            current_state_source.requests,
            [
                {
                    "schema_version": "0.1",
                    "trace_id": "trace-current",
                    "event_id": "event-current",
                    "event_type": "USER_MESSAGE",
                    "user_id": "u-1",
                    "conversation_id": "c-1",
                }
            ],
        )
        character_snapshot = adapter.calls[0]["decision_context"]["character_snapshot"]
        self.assertEqual(character_snapshot["living_state_brief"], living_state_brief())
        self.assertEqual(
            [message["message_id"] for message in character_snapshot["recent_visible_messages"]],
            ["message-prior"],
        )
        self.assertEqual(
            [entry["kind"] for entry in raw_log.entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "visible_reply_committed",
            ],
        )
        self.assertEqual(
            raw_log.entries[2]["data"]["model_input"]["decision_context"]["character_snapshot"][
                "living_state_brief"
            ],
            living_state_brief(),
        )

    def test_runs_one_user_turn_with_active_incident_in_model_input_and_raw_log(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        adapter = RecordingAdapter()
        active_incident_source = RecordingActiveIncidentSource(active_incident_snapshot())

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "schema_version": "0.1",
                "payload": {
                    "text": "hello now",
                    "user_id": "u-1",
                    "conversation_id": "c-1",
                },
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            active_incident_source=active_incident_source,
        )

        self.assertEqual(result["status"], "user_turn_committed")
        self.assertEqual(
            active_incident_source.requests,
            [
                {
                    "schema_version": "0.1",
                    "trace_id": "trace-current",
                    "event_id": "event-current",
                    "event_type": "USER_MESSAGE",
                    "user_id": "u-1",
                    "conversation_id": "c-1",
                }
            ],
        )
        character_snapshot = adapter.calls[0]["decision_context"]["character_snapshot"]
        self.assertEqual(character_snapshot["active_incident"], active_incident_brief())
        self.assertNotIn("life_action", adapter.calls[0]["allowed_actions"])
        self.assertEqual(
            raw_log.entries[2]["data"]["model_input"]["decision_context"]["character_snapshot"][
                "active_incident"
            ],
            active_incident_brief(),
        )
        self.assertEqual(
            [entry["kind"] for entry in raw_log.entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "visible_reply_committed",
            ],
        )

    def test_active_incident_source_none_preserves_visible_reply_flow(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        adapter = RecordingAdapter()
        active_incident_source = RecordingActiveIncidentSource(None)

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "payload": {"text": "hello now", "conversation_id": "c-1"},
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            active_incident_source=active_incident_source,
        )

        self.assertEqual(result["status"], "user_turn_committed")
        self.assertNotIn(
            "active_incident",
            adapter.calls[0]["decision_context"]["character_snapshot"],
        )
        self.assertEqual(visible_conversation.records[-1]["text"], "hello back")

    def test_incident_start_enabled_turn_commits_incident_before_assistant_reply(self):
        operations = []
        raw_log = RecordingRawEventLog(operations=operations)
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        life_incident_start_finalizer = RecordingLifeIncidentStartFinalizer(operations=operations)
        adapter = RecordingAdapter(
            raw_text=json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
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
                }
            )
        )

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "schema_version": "0.1",
                "payload": {
                    "text": "hello now",
                    "user_id": "u-1",
                    "conversation_id": "c-1",
                },
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            life_incident_start_finalizer=life_incident_start_finalizer,
        )

        self.assertEqual(result["status"], "user_turn_committed")
        self.assertEqual(
            adapter.calls[0]["allowed_actions"],
            ["visible_reply", "life_action"],
        )
        self.assertEqual(
            [kind for _source, kind in operations],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "life_incident_started",
                "visible_reply_committed",
            ],
        )
        self.assertEqual(len(life_incident_start_finalizer.requests), 1)
        self.assertEqual(len(life_incident_start_finalizer.durable_started_incidents), 1)
        self.assertEqual(len(life_incident_start_finalizer.durable_raw_event_log_entries), 1)
        self.assertEqual(
            life_incident_start_finalizer.durable_started_incidents[0],
            {
                "schema_version": "0.1",
                "incident_id": "incident-generated-5",
                "type": "think",
                "status": "active",
                "title": "thinking through the plan",
                "started_at": "2026-05-14T11:30:00+00:00",
                "remaining_seconds": 300,
                "interrupt_policy": "interruptible",
                "resume_policy": "ask_model",
                "source_event_ids": ["event-current"],
            },
        )
        self.assertEqual(
            result["life_incident_start_result"]["committed_log_entry_id"],
            life_incident_start_finalizer.durable_raw_event_log_entries[0]["log_id"],
        )
        self.assertNotIn(
            "life_action",
            raw_log.entries[3]["data"]["role_model_result"]["decision"],
        )
        self.assertEqual(visible_conversation.records[-1]["text"], "hello back")

    def test_raw_log_query_surface_includes_incident_start_success_log_in_order(self):
        raw_log = InMemoryRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        life_incident_start_finalizer = RecordingLifeIncidentStartFinalizer(
            raw_log_visibility=raw_log
        )
        adapter = RecordingAdapter(
            raw_text=json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
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
                }
            )
        )

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "schema_version": "0.1",
                "payload": {
                    "text": "hello now",
                    "user_id": "u-1",
                    "conversation_id": "c-1",
                },
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            life_incident_start_finalizer=life_incident_start_finalizer,
        )

        entries = raw_log.query({"trace_id": result["trace_id"]})["entries"]
        success_entries = raw_log.query(
            {"trace_id": result["trace_id"], "kinds": ["life_incident_started"]}
        )["entries"]

        self.assertEqual(result["status"], "user_turn_committed")
        self.assertEqual(
            [entry["kind"] for entry in entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "life_incident_started",
                "visible_reply_committed",
            ],
        )
        self.assertEqual(len(success_entries), 1)
        self.assertEqual(
            result["life_incident_start_result"]["committed_log_entry_id"],
            success_entries[0]["log_id"],
        )

    def test_incident_start_turn_with_concrete_store_reads_incident_and_query_success_log(self):
        raw_log = InMemoryRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        life_incident_store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        event_input = {
            "event_id": "event-current",
            "trace_id": "trace-current",
            "type": "USER_MESSAGE",
            "created_at": "2026-05-14T11:30:00+00:00",
            "schema_version": "0.1",
            "payload": {
                "text": "hello now",
                "user_id": "u-1",
                "conversation_id": "c-1",
            },
        }
        adapter = RecordingAdapter(
            raw_text=json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
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
                }
            )
        )

        result = run_user_message_turn(
            event_input,
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            life_incident_start_finalizer=life_incident_store,
        )

        active_incident = life_incident_store.read_active_incident(
            build_active_incident_request(event_input)
        )
        success_entries = raw_log.query(
            {"trace_id": result["trace_id"], "kinds": ["life_incident_started"]}
        )["entries"]

        self.assertEqual(result["status"], "user_turn_committed")
        self.assertEqual(active_incident["incident_id"], "incident-generated-5")
        self.assertEqual(active_incident["source_event_ids"], ["event-current"])
        self.assertEqual(len(success_entries), 1)
        self.assertEqual(
            result["life_incident_start_result"]["committed_log_entry_id"],
            success_entries[0]["log_id"],
        )
        self.assertEqual(
            success_entries[0]["data"]["started_incident"],
            active_incident,
        )
        self.assertEqual(
            [entry["kind"] for entry in raw_log.query({"trace_id": result["trace_id"]})["entries"]],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "life_incident_started",
                "visible_reply_committed",
            ],
        )

    def test_user_turn_interrupts_active_incident_before_model_context(self):
        raw_log = InMemoryRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        life_incident_store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        ids = SequenceIdGenerator()
        start_event = {
            "event_id": "event-start",
            "trace_id": "trace-start",
            "type": "USER_MESSAGE",
            "created_at": "2026-05-14T11:25:00+00:00",
            "schema_version": "0.1",
            "payload": {
                "text": "go eat",
                "user_id": "u-1",
                "conversation_id": "c-1",
            },
        }
        run_user_message_turn(
            start_event,
            adapter=RecordingAdapter(
                raw_text=json.dumps(
                    {
                        "schema_version": "0.1",
                        "action": "visible_reply",
                        "visible_reply": {"text": "eating"},
                        "life_action": {
                            "type": "start_incident",
                            "incident": {
                                "type": "eat",
                                "title": "Eating lunch",
                                "remaining_seconds": 1200,
                                "interrupt_policy": "interruptible",
                                "resume_policy": "resume",
                            },
                        },
                    }
                )
            ),
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=ids,
            clock=fixed_clock,
            life_incident_start_finalizer=life_incident_store,
        )
        interrupt_event = {
            "event_id": "event-interrupt",
            "trace_id": "trace-interrupt",
            "type": "USER_MESSAGE",
            "created_at": "2026-05-14T11:31:00+00:00",
            "schema_version": "0.1",
            "payload": {
                "text": "are you there?",
                "user_id": "u-1",
                "conversation_id": "c-1",
            },
        }
        adapter = RecordingAdapter()

        result = run_user_message_turn(
            interrupt_event,
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=ids,
            clock=fixed_clock,
            active_incident_source=life_incident_store,
            life_incident_interrupt_finalizer=life_incident_store,
            interrupted_incident_source=life_incident_store,
        )

        character_snapshot = adapter.calls[0]["decision_context"]["character_snapshot"]
        interrupt_entries = raw_log.query({"trace_id": "trace-interrupt"})["entries"]

        self.assertEqual(result["status"], "user_turn_committed")
        self.assertEqual(
            result["life_incident_interrupt_result"]["status"], "life_incident_interrupted"
        )
        self.assertNotIn("active_incident", character_snapshot)
        self.assertEqual(
            character_snapshot["interrupted_incident"]["incident_id"],
            result["life_incident_interrupt_result"]["interrupted_incident"]["incident_id"],
        )
        self.assertIsNone(
            life_incident_store.read_active_incident(build_active_incident_request(interrupt_event))
        )
        self.assertIsNotNone(
            life_incident_store.read_interrupted_incident(
                build_active_incident_request(interrupt_event)
            )
        )
        self.assertEqual(
            [entry["kind"] for entry in interrupt_entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "life_incident_interrupted",
                "role_model_turn_completed",
                "visible_reply_committed",
            ],
        )

    def test_user_turn_interrupt_context_suppresses_stale_active_source(self):
        raw_log = InMemoryRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        life_incident_store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        ids = SequenceIdGenerator()
        start_event = {
            "event_id": "event-start",
            "trace_id": "trace-start",
            "type": "USER_MESSAGE",
            "created_at": "2026-05-14T11:25:00+00:00",
            "schema_version": "0.1",
            "payload": {
                "text": "go eat",
                "user_id": "u-1",
                "conversation_id": "c-1",
            },
        }
        run_user_message_turn(
            start_event,
            adapter=RecordingAdapter(
                raw_text=json.dumps(
                    {
                        "schema_version": "0.1",
                        "action": "visible_reply",
                        "visible_reply": {"text": "eating"},
                        "life_action": {
                            "type": "start_incident",
                            "incident": {
                                "type": "eat",
                                "title": "Eating lunch",
                                "remaining_seconds": 1200,
                                "interrupt_policy": "interruptible",
                                "resume_policy": "resume",
                            },
                        },
                    }
                )
            ),
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=ids,
            clock=fixed_clock,
            life_incident_start_finalizer=life_incident_store,
        )
        stale_active_source = RecordingActiveIncidentSource(
            life_incident_store.read_active_incident(build_active_incident_request(start_event))
        )
        lagging_interrupted_source = RecordingInterruptedIncidentSource(None)
        interrupt_event = {
            "event_id": "event-interrupt",
            "trace_id": "trace-interrupt",
            "type": "USER_MESSAGE",
            "created_at": "2026-05-14T11:31:00+00:00",
            "schema_version": "0.1",
            "payload": {
                "text": "are you there?",
                "user_id": "u-1",
                "conversation_id": "c-1",
            },
        }
        adapter = RecordingAdapter()

        result = run_user_message_turn(
            interrupt_event,
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=ids,
            clock=fixed_clock,
            active_incident_source=stale_active_source,
            life_incident_interrupt_finalizer=life_incident_store,
            interrupted_incident_source=lagging_interrupted_source,
        )

        character_snapshot = adapter.calls[0]["decision_context"]["character_snapshot"]

        self.assertEqual(result["status"], "user_turn_committed")
        self.assertEqual(
            result["life_incident_interrupt_result"]["status"], "life_incident_interrupted"
        )
        self.assertEqual(len(stale_active_source.requests), 1)
        self.assertEqual(lagging_interrupted_source.requests, [])
        self.assertNotIn("active_incident", character_snapshot)
        self.assertEqual(
            character_snapshot["interrupted_incident"]["incident_id"],
            result["life_incident_interrupt_result"]["interrupted_incident"]["incident_id"],
        )

    def test_user_turn_interrupt_skipped_without_interrupted_source_reaches_model(self):
        raw_log = InMemoryRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        life_incident_store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        ids = SequenceIdGenerator()
        interrupt_event = {
            "event_id": "event-interrupt",
            "trace_id": "trace-interrupt",
            "type": "USER_MESSAGE",
            "created_at": "2026-05-14T11:31:00+00:00",
            "schema_version": "0.1",
            "payload": {
                "text": "are you there?",
                "user_id": "u-1",
                "conversation_id": "c-1",
            },
        }
        adapter = RecordingAdapter()

        result = run_user_message_turn(
            interrupt_event,
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=ids,
            clock=fixed_clock,
            active_incident_source=life_incident_store,
            life_incident_interrupt_finalizer=life_incident_store,
        )

        character_snapshot = adapter.calls[0]["decision_context"]["character_snapshot"]

        self.assertEqual(result["status"], "user_turn_committed")
        self.assertEqual(
            result["life_incident_interrupt_result"]["status"],
            "life_incident_interrupt_skipped",
        )
        self.assertNotIn("active_incident", character_snapshot)
        self.assertNotIn("interrupted_incident", character_snapshot)
        self.assertEqual(
            [entry["kind"] for entry in raw_log.query({"trace_id": "trace-interrupt"})["entries"]],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "visible_reply_committed",
            ],
        )

    def test_user_turn_non_interruptible_policy_logs_before_model_context_and_keeps_active(self):
        cases = [
            {
                "policy": "background",
                "incident_type": "work",
                "title": "Working quietly",
                "reply": "working",
                "user_text": "quick question",
                "expected_status": "life_incident_continued_in_background",
                "expected_kind": "life_incident_continued_in_background",
            },
            {
                "policy": "protected",
                "incident_type": "sleep",
                "title": "Sleeping deeply",
                "reply": "sleeping",
                "user_text": "wake up?",
                "expected_status": "life_incident_protected_from_interruption",
                "expected_kind": "life_incident_protected_from_interruption",
            },
        ]

        for case in cases:
            with self.subTest(policy=case["policy"]):
                raw_log = InMemoryRawEventLog()
                visible_conversation = InMemoryVisibleConversation([prior_user_record()])
                life_incident_store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
                ids = SequenceIdGenerator()
                start_event = {
                    "event_id": "event-start",
                    "trace_id": "trace-start",
                    "type": "USER_MESSAGE",
                    "created_at": "2026-05-14T11:25:00+00:00",
                    "schema_version": "0.1",
                    "payload": {
                        "text": "go work",
                        "user_id": "u-1",
                        "conversation_id": "c-1",
                    },
                }
                run_user_message_turn(
                    start_event,
                    adapter=RecordingAdapter(
                        raw_text=json.dumps(
                            {
                                "schema_version": "0.1",
                                "action": "visible_reply",
                                "visible_reply": {"text": case["reply"]},
                                "life_action": {
                                    "type": "start_incident",
                                    "incident": {
                                        "type": case["incident_type"],
                                        "title": case["title"],
                                        "remaining_seconds": 1200,
                                        "interrupt_policy": case["policy"],
                                        "resume_policy": "resume",
                                    },
                                },
                            }
                        )
                    ),
                    raw_event_log=raw_log,
                    visible_conversation=visible_conversation,
                    id_generator=ids,
                    clock=fixed_clock,
                    life_incident_start_finalizer=life_incident_store,
                )
                policy_active_snapshot = life_incident_store.read_active_incident(
                    build_active_incident_request(start_event)
                )
                unstable_active_source = SequenceActiveIncidentSource(
                    [policy_active_snapshot, None]
                )
                interrupt_event = {
                    "event_id": "event-interrupt",
                    "trace_id": "trace-interrupt",
                    "type": "USER_MESSAGE",
                    "created_at": "2026-05-14T11:31:00+00:00",
                    "schema_version": "0.1",
                    "payload": {
                        "text": case["user_text"],
                        "user_id": "u-1",
                        "conversation_id": "c-1",
                    },
                }
                adapter = RecordingAdapter()

                result = run_user_message_turn(
                    interrupt_event,
                    adapter=adapter,
                    raw_event_log=raw_log,
                    visible_conversation=visible_conversation,
                    id_generator=ids,
                    clock=fixed_clock,
                    active_incident_source=unstable_active_source,
                    life_incident_interrupt_finalizer=life_incident_store,
                )

                character_snapshot = adapter.calls[0]["decision_context"]["character_snapshot"]

                self.assertEqual(result["status"], "user_turn_committed")
                self.assertEqual(
                    result["life_incident_interrupt_result"]["status"],
                    case["expected_status"],
                )
                self.assertEqual(
                    result["life_incident_interrupt_result"]["active_incident"]["interrupt_policy"],
                    case["policy"],
                )
                self.assertEqual(len(unstable_active_source.requests), 1)
                self.assertIn("active_incident", character_snapshot)
                self.assertEqual(character_snapshot["active_incident"]["title"], case["title"])
                self.assertNotIn("interrupted_incident", character_snapshot)
                self.assertIsNotNone(
                    life_incident_store.read_active_incident(
                        build_active_incident_request(interrupt_event)
                    )
                )
                self.assertEqual(
                    [
                        entry["kind"]
                        for entry in raw_log.query({"trace_id": "trace-interrupt"})["entries"]
                    ],
                    [
                        "runtime_event_received",
                        "user_visible_message_committed",
                        case["expected_kind"],
                        "role_model_turn_completed",
                        "visible_reply_committed",
                    ],
                )

    def test_incident_cancel_enabled_turn_with_concrete_store_clears_incident_before_reply(self):
        raw_log = InMemoryRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        life_incident_store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        ids = SequenceIdGenerator()
        start_event = {
            "event_id": "event-start",
            "trace_id": "trace-start",
            "type": "USER_MESSAGE",
            "created_at": "2026-05-14T11:25:00+00:00",
            "schema_version": "0.1",
            "payload": {
                "text": "go think",
                "user_id": "u-1",
                "conversation_id": "c-1",
            },
        }
        run_user_message_turn(
            start_event,
            adapter=RecordingAdapter(
                raw_text=json.dumps(
                    {
                        "schema_version": "0.1",
                        "action": "visible_reply",
                        "visible_reply": {"text": "thinking"},
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
                    }
                )
            ),
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=ids,
            clock=fixed_clock,
            life_incident_start_finalizer=life_incident_store,
        )
        active_incident = life_incident_store.read_active_incident(
            build_active_incident_request(start_event)
        )
        cancel_event = {
            "event_id": "event-cancel",
            "trace_id": "trace-cancel",
            "type": "USER_MESSAGE",
            "created_at": "2026-05-14T11:31:00+00:00",
            "schema_version": "0.1",
            "payload": {
                "text": "stop thinking and answer",
                "user_id": "u-1",
                "conversation_id": "c-1",
            },
        }

        result = run_user_message_turn(
            cancel_event,
            adapter=RecordingAdapter(
                raw_text=json.dumps(
                    {
                        "schema_version": "0.1",
                        "action": "visible_reply",
                        "visible_reply": {"text": "hello back"},
                        "life_action": {
                            "type": "cancel_incident",
                            "incident_id": active_incident["incident_id"],
                            "reason": "User needs an immediate answer.",
                        },
                    }
                )
            ),
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=ids,
            clock=fixed_clock,
            active_incident_source=life_incident_store,
            life_incident_cancel_finalizer=life_incident_store,
        )

        cancel_entries = raw_log.query({"trace_id": "trace-cancel"})["entries"]
        success_entries = raw_log.query(
            {"trace_id": "trace-cancel", "kinds": ["life_incident_cancelled"]}
        )["entries"]

        self.assertEqual(result["status"], "user_turn_committed")
        self.assertEqual(
            result["life_incident_cancel_result"]["cancelled_incident"]["incident_id"],
            active_incident["incident_id"],
        )
        self.assertIsNone(
            life_incident_store.read_active_incident(build_active_incident_request(cancel_event))
        )
        self.assertEqual(
            [entry["kind"] for entry in cancel_entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "life_incident_cancelled",
                "visible_reply_committed",
            ],
        )
        self.assertEqual(len(success_entries), 1)
        self.assertEqual(
            result["life_incident_cancel_result"]["committed_log_entry_id"],
            success_entries[0]["log_id"],
        )
        self.assertEqual(visible_conversation.records[-1]["text"], "hello back")

    def test_incident_cancel_enabled_turn_with_no_active_incident_stops_before_reply(self):
        raw_log = InMemoryRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        life_incident_store = InMemoryLifeIncidentStore(raw_event_log=raw_log)

        result = run_user_message_turn(
            {
                "event_id": "event-cancel",
                "trace_id": "trace-cancel",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "schema_version": "0.1",
                "payload": {
                    "text": "stop",
                    "user_id": "u-1",
                    "conversation_id": "c-1",
                },
            },
            adapter=RecordingAdapter(
                raw_text=json.dumps(
                    {
                        "schema_version": "0.1",
                        "action": "visible_reply",
                        "visible_reply": {"text": "hello back"},
                        "life_action": {
                            "type": "cancel_incident",
                            "incident_id": "incident-missing",
                            "reason": "User needs attention.",
                        },
                    }
                )
            ),
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            active_incident_source=life_incident_store,
            life_incident_cancel_finalizer=life_incident_store,
        )

        entries = raw_log.query({"trace_id": "trace-cancel"})["entries"]

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(result["stopped_at"], "life_incident_cancel_commit")
        self.assertEqual(result["failure"]["code"], "no_active_incident")
        self.assertEqual(
            [entry["kind"] for entry in entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "life_incident_cancel_rejected",
            ],
        )
        self.assertEqual(
            [record["kind"] for record in visible_conversation.records],
            [
                "user_visible_message",
                "user_visible_message",
            ],
        )

    def test_incident_cancel_enabled_turn_with_mismatched_id_preserves_active_incident(self):
        raw_log = InMemoryRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        life_incident_store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        ids = SequenceIdGenerator()
        start_event = {
            "event_id": "event-start",
            "trace_id": "trace-start",
            "type": "USER_MESSAGE",
            "created_at": "2026-05-14T11:25:00+00:00",
            "schema_version": "0.1",
            "payload": {
                "text": "go think",
                "user_id": "u-1",
                "conversation_id": "c-1",
            },
        }
        run_user_message_turn(
            start_event,
            adapter=RecordingAdapter(
                raw_text=json.dumps(
                    {
                        "schema_version": "0.1",
                        "action": "visible_reply",
                        "visible_reply": {"text": "thinking"},
                        "life_action": {
                            "type": "start_incident",
                            "incident": {
                                "type": "think",
                                "title": "thinking through the plan",
                                "interrupt_policy": "interruptible",
                                "resume_policy": "ask_model",
                            },
                        },
                    }
                )
            ),
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=ids,
            clock=fixed_clock,
            life_incident_start_finalizer=life_incident_store,
        )
        original_active = deepcopy(
            life_incident_store.read_active_incident(build_active_incident_request(start_event))
        )

        result = run_user_message_turn(
            {
                "event_id": "event-cancel",
                "trace_id": "trace-cancel",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:31:00+00:00",
                "schema_version": "0.1",
                "payload": {
                    "text": "stop",
                    "user_id": "u-1",
                    "conversation_id": "c-1",
                },
            },
            adapter=RecordingAdapter(
                raw_text=json.dumps(
                    {
                        "schema_version": "0.1",
                        "action": "visible_reply",
                        "visible_reply": {"text": "hello back"},
                        "life_action": {
                            "type": "cancel_incident",
                            "incident_id": "incident-other",
                            "reason": "User needs attention.",
                        },
                    }
                )
            ),
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=ids,
            clock=fixed_clock,
            active_incident_source=life_incident_store,
            life_incident_cancel_finalizer=life_incident_store,
        )

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(result["failure"]["code"], "incident_id_mismatch")
        self.assertEqual(
            life_incident_store.read_active_incident(build_active_incident_request(start_event)),
            original_active,
        )
        self.assertEqual(
            raw_log.query({"trace_id": "trace-cancel", "kinds": ["life_incident_cancelled"]})[
                "entries"
            ],
            [],
        )

    def test_incident_complete_enabled_turn_with_concrete_store_clears_incident_before_reply(self):
        raw_log = InMemoryRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        life_incident_store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        ids = SequenceIdGenerator()
        start_event = {
            "event_id": "event-start",
            "trace_id": "trace-start",
            "type": "USER_MESSAGE",
            "created_at": "2026-05-14T11:25:00+00:00",
            "schema_version": "0.1",
            "payload": {
                "text": "go think",
                "user_id": "u-1",
                "conversation_id": "c-1",
            },
        }
        run_user_message_turn(
            start_event,
            adapter=RecordingAdapter(
                raw_text=json.dumps(
                    {
                        "schema_version": "0.1",
                        "action": "visible_reply",
                        "visible_reply": {"text": "thinking"},
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
                    }
                )
            ),
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=ids,
            clock=fixed_clock,
            life_incident_start_finalizer=life_incident_store,
        )
        active_incident = life_incident_store.read_active_incident(
            build_active_incident_request(start_event)
        )
        complete_event = {
            "event_id": "event-complete",
            "trace_id": "trace-complete",
            "type": "USER_MESSAGE",
            "created_at": "2026-05-14T11:31:00+00:00",
            "schema_version": "0.1",
            "payload": {
                "text": "that task is done",
                "user_id": "u-1",
                "conversation_id": "c-1",
            },
        }

        result = run_user_message_turn(
            complete_event,
            adapter=RecordingAdapter(
                raw_text=json.dumps(
                    {
                        "schema_version": "0.1",
                        "action": "visible_reply",
                        "visible_reply": {"text": "hello back"},
                        "life_action": {
                            "type": "complete_incident",
                            "incident_id": active_incident["incident_id"],
                        },
                    }
                )
            ),
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=ids,
            clock=fixed_clock,
            active_incident_source=life_incident_store,
            life_incident_complete_finalizer=life_incident_store,
        )

        complete_entries = raw_log.query({"trace_id": "trace-complete"})["entries"]
        success_entries = raw_log.query(
            {"trace_id": "trace-complete", "kinds": ["life_incident_completed"]}
        )["entries"]

        self.assertEqual(result["status"], "user_turn_committed")
        self.assertEqual(
            result["life_incident_complete_result"]["completed_incident"]["incident_id"],
            active_incident["incident_id"],
        )
        self.assertIsNone(
            life_incident_store.read_active_incident(build_active_incident_request(complete_event))
        )
        self.assertEqual(
            [entry["kind"] for entry in complete_entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "life_incident_completed",
                "visible_reply_committed",
            ],
        )
        self.assertEqual(len(success_entries), 1)
        self.assertEqual(
            result["life_incident_complete_result"]["committed_log_entry_id"],
            success_entries[0]["log_id"],
        )
        self.assertEqual(visible_conversation.records[-1]["text"], "hello back")

    def test_incident_complete_enabled_turn_with_no_active_incident_stops_before_reply(self):
        raw_log = InMemoryRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        life_incident_store = InMemoryLifeIncidentStore(raw_event_log=raw_log)

        result = run_user_message_turn(
            {
                "event_id": "event-complete",
                "trace_id": "trace-complete",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "schema_version": "0.1",
                "payload": {
                    "text": "done",
                    "user_id": "u-1",
                    "conversation_id": "c-1",
                },
            },
            adapter=RecordingAdapter(
                raw_text=json.dumps(
                    {
                        "schema_version": "0.1",
                        "action": "visible_reply",
                        "visible_reply": {"text": "hello back"},
                        "life_action": {
                            "type": "complete_incident",
                            "incident_id": "incident-missing",
                        },
                    }
                )
            ),
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            active_incident_source=life_incident_store,
            life_incident_complete_finalizer=life_incident_store,
        )

        entries = raw_log.query({"trace_id": "trace-complete"})["entries"]

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(result["stopped_at"], "life_incident_complete_commit")
        self.assertEqual(result["failure"]["code"], "no_active_incident")
        self.assertEqual(
            [entry["kind"] for entry in entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "life_incident_complete_rejected",
            ],
        )
        self.assertEqual(
            [record["kind"] for record in visible_conversation.records],
            [
                "user_visible_message",
                "user_visible_message",
            ],
        )

    def test_incident_complete_enabled_turn_with_mismatched_id_preserves_active_incident(self):
        raw_log = InMemoryRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        life_incident_store = InMemoryLifeIncidentStore(raw_event_log=raw_log)
        ids = SequenceIdGenerator()
        start_event = {
            "event_id": "event-start",
            "trace_id": "trace-start",
            "type": "USER_MESSAGE",
            "created_at": "2026-05-14T11:25:00+00:00",
            "schema_version": "0.1",
            "payload": {
                "text": "go think",
                "user_id": "u-1",
                "conversation_id": "c-1",
            },
        }
        run_user_message_turn(
            start_event,
            adapter=RecordingAdapter(
                raw_text=json.dumps(
                    {
                        "schema_version": "0.1",
                        "action": "visible_reply",
                        "visible_reply": {"text": "thinking"},
                        "life_action": {
                            "type": "start_incident",
                            "incident": {
                                "type": "think",
                                "title": "thinking through the plan",
                                "interrupt_policy": "interruptible",
                                "resume_policy": "ask_model",
                            },
                        },
                    }
                )
            ),
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=ids,
            clock=fixed_clock,
            life_incident_start_finalizer=life_incident_store,
        )
        original_active = deepcopy(
            life_incident_store.read_active_incident(build_active_incident_request(start_event))
        )

        result = run_user_message_turn(
            {
                "event_id": "event-complete",
                "trace_id": "trace-complete",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:31:00+00:00",
                "schema_version": "0.1",
                "payload": {
                    "text": "done",
                    "user_id": "u-1",
                    "conversation_id": "c-1",
                },
            },
            adapter=RecordingAdapter(
                raw_text=json.dumps(
                    {
                        "schema_version": "0.1",
                        "action": "visible_reply",
                        "visible_reply": {"text": "hello back"},
                        "life_action": {
                            "type": "complete_incident",
                            "incident_id": "incident-other",
                        },
                    }
                )
            ),
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=ids,
            clock=fixed_clock,
            active_incident_source=life_incident_store,
            life_incident_complete_finalizer=life_incident_store,
        )

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(result["failure"]["code"], "incident_id_mismatch")
        self.assertEqual(
            life_incident_store.read_active_incident(build_active_incident_request(start_event)),
            original_active,
        )
        self.assertEqual(
            raw_log.query({"trace_id": "trace-complete", "kinds": ["life_incident_completed"]})[
                "entries"
            ],
            [],
        )

    def test_incident_start_enabled_turn_without_life_action_preserves_visible_reply_flow(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        life_incident_start_finalizer = RecordingLifeIncidentStartFinalizer()
        adapter = RecordingAdapter()

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "schema_version": "0.1",
                "payload": {
                    "text": "hello now",
                    "user_id": "u-1",
                    "conversation_id": "c-1",
                },
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            life_incident_start_finalizer=life_incident_start_finalizer,
        )

        self.assertEqual(result["status"], "user_turn_committed")
        self.assertEqual(
            result["life_incident_start_result"]["status"],
            "life_incident_start_skipped",
        )
        self.assertEqual(life_incident_start_finalizer.requests, [])
        self.assertEqual(life_incident_start_finalizer.durable_started_incidents, [])
        self.assertEqual(life_incident_start_finalizer.durable_raw_event_log_entries, [])
        self.assertEqual(
            [entry["kind"] for entry in raw_log.entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "visible_reply_committed",
            ],
        )
        self.assertEqual(visible_conversation.records[-1]["text"], "hello back")

    def test_malformed_life_action_stops_after_role_model_failure(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        life_incident_start_finalizer = RecordingLifeIncidentStartFinalizer()
        adapter = RecordingAdapter(
            raw_text=json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                    "life_action": {
                        "type": "start_incident",
                        "incident": {
                            "type": "think",
                            "title": "think",
                            "status": "active",
                            "interrupt_policy": "interruptible",
                            "resume_policy": "resume",
                        },
                    },
                }
            )
        )

        with self.assertRaisesRegex(ValueError, "status"):
            run_user_message_turn(
                {
                    "event_id": "event-current",
                    "trace_id": "trace-current",
                    "type": "USER_MESSAGE",
                    "created_at": "2026-05-14T11:30:00+00:00",
                    "payload": {"text": "hello now", "conversation_id": "c-1"},
                },
                adapter=adapter,
                raw_event_log=raw_log,
                visible_conversation=visible_conversation,
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
                life_incident_start_finalizer=life_incident_start_finalizer,
            )

        self.assertEqual(
            [entry["kind"] for entry in raw_log.entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_failed",
            ],
        )
        self.assertEqual(raw_log.entries[2]["data"]["failure"]["stage"], "parse_output")
        self.assertEqual(life_incident_start_finalizer.requests, [])
        self.assertEqual(
            [record["kind"] for record in visible_conversation.records],
            ["user_visible_message", "user_visible_message"],
        )

    def test_incident_start_finalizer_rejection_stops_before_assistant_reply(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        life_incident_start_finalizer = RecordingLifeIncidentStartFinalizer(
            error=LifeIncidentStartFinalizerError(
                "finalize rejected",
                code="finalize_rejected",
            )
        )
        adapter = RecordingAdapter(
            raw_text=json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                    "life_action": {
                        "type": "start_incident",
                        "incident": {
                            "type": "think",
                            "title": "thinking through the plan",
                            "interrupt_policy": "interruptible",
                            "resume_policy": "ask_model",
                        },
                    },
                }
            )
        )

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "payload": {"text": "hello now", "conversation_id": "c-1"},
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            life_incident_start_finalizer=life_incident_start_finalizer,
        )

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(result["stopped_at"], "life_incident_start_commit")
        self.assertEqual(result["failure"]["stage"], "life_incident_start_finalize")
        self.assertEqual(
            [entry["kind"] for entry in raw_log.entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "life_incident_start_rejected",
            ],
        )
        self.assertEqual(
            [record["kind"] for record in visible_conversation.records],
            ["user_visible_message", "user_visible_message"],
        )
        self.assertEqual(len(life_incident_start_finalizer.requests), 1)
        self.assertEqual(life_incident_start_finalizer.durable_started_incidents, [])
        self.assertEqual(life_incident_start_finalizer.durable_raw_event_log_entries, [])

    def test_raw_log_query_surface_excludes_incident_success_log_on_finalizer_rejection(self):
        raw_log = InMemoryRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        life_incident_start_finalizer = RecordingLifeIncidentStartFinalizer(
            error=LifeIncidentStartFinalizerError(
                "finalize rejected",
                code="finalize_rejected",
            ),
            raw_log_visibility=raw_log,
        )
        adapter = RecordingAdapter(
            raw_text=json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                    "life_action": {
                        "type": "start_incident",
                        "incident": {
                            "type": "think",
                            "title": "thinking through the plan",
                            "interrupt_policy": "interruptible",
                            "resume_policy": "ask_model",
                        },
                    },
                }
            )
        )

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "payload": {"text": "hello now", "conversation_id": "c-1"},
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            life_incident_start_finalizer=life_incident_start_finalizer,
        )

        entries = raw_log.query({"trace_id": result["trace_id"]})["entries"]
        success_entries = raw_log.query(
            {"trace_id": result["trace_id"], "kinds": ["life_incident_started"]}
        )["entries"]

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(
            [entry["kind"] for entry in entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "life_incident_start_rejected",
            ],
        )
        self.assertEqual(success_entries, [])

    def test_raw_log_query_surface_excludes_incident_success_log_on_malformed_finalize(self):
        raw_log = InMemoryRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        life_incident_start_finalizer = RecordingLifeIncidentStartFinalizer(
            result_override={
                "schema_version": "0.1",
                "trace_id": "trace-current",
                "event_id": "event-current",
                "event_type": "USER_MESSAGE",
                "committed_log_entry_id": "wrong-log-id",
            },
            raw_log_visibility=raw_log,
            expose_before_result_override=True,
        )
        adapter = RecordingAdapter(
            raw_text=json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                    "life_action": {
                        "type": "start_incident",
                        "incident": {
                            "type": "think",
                            "title": "thinking through the plan",
                            "interrupt_policy": "interruptible",
                            "resume_policy": "ask_model",
                        },
                    },
                }
            )
        )

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "payload": {"text": "hello now", "conversation_id": "c-1"},
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            life_incident_start_finalizer=life_incident_start_finalizer,
        )

        entries = raw_log.query({"trace_id": result["trace_id"]})["entries"]
        success_entries = raw_log.query(
            {"trace_id": result["trace_id"], "kinds": ["life_incident_started"]}
        )["entries"]

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(result["failure"]["stage"], "life_incident_start_finalize")
        self.assertEqual(result["failure"]["code"], "malformed_finalize_result")
        self.assertEqual(
            [entry["kind"] for entry in entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "life_incident_start_rejected",
            ],
        )
        self.assertEqual(success_entries, [])
        self.assertEqual(life_incident_start_finalizer.durable_started_incidents, [])
        self.assertEqual(life_incident_start_finalizer.durable_raw_event_log_entries, [])

    def test_raw_log_query_surface_rejects_incident_staging_visibility_failure(self):
        raw_log = InMemoryRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        life_incident_start_finalizer = RecordingLifeIncidentStartFinalizer(
            raw_log_visibility=raw_log,
            expose_conflicting_success=True,
        )
        adapter = RecordingAdapter(
            raw_text=json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                    "life_action": {
                        "type": "start_incident",
                        "incident": {
                            "type": "think",
                            "title": "thinking through the plan",
                            "interrupt_policy": "interruptible",
                            "resume_policy": "ask_model",
                        },
                    },
                }
            )
        )

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "payload": {"text": "hello now", "conversation_id": "c-1"},
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            life_incident_start_finalizer=life_incident_start_finalizer,
        )

        entries = raw_log.query({"trace_id": result["trace_id"]})["entries"]
        success_entries = raw_log.query(
            {"trace_id": result["trace_id"], "kinds": ["life_incident_started"]}
        )["entries"]

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(result["failure"]["stage"], LIFE_INCIDENT_START_FINALIZE_STAGE)
        self.assertEqual(result["failure"]["code"], "malformed_finalize_result")
        self.assertIn("already exists with different data", result["failure"]["message"])
        self.assertEqual(
            [entry["kind"] for entry in entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "life_incident_start_rejected",
            ],
        )
        self.assertEqual(success_entries, [])
        self.assertEqual(life_incident_start_finalizer.durable_started_incidents, [])
        self.assertEqual(life_incident_start_finalizer.durable_raw_event_log_entries, [])

    def test_raw_log_query_surface_rejects_incident_success_accidentally_appended(self):
        raw_log = InMemoryRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        life_incident_start_finalizer = RecordingLifeIncidentStartFinalizer(
            result_override={
                "schema_version": "0.1",
                "trace_id": "trace-current",
                "event_id": "event-current",
                "event_type": "USER_MESSAGE",
                "committed_log_entry_id": "wrong-log-id",
            },
            raw_log_visibility=raw_log,
            append_before_result_override=True,
        )
        adapter = RecordingAdapter(
            raw_text=json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                    "life_action": {
                        "type": "start_incident",
                        "incident": {
                            "type": "think",
                            "title": "thinking through the plan",
                            "interrupt_policy": "interruptible",
                            "resume_policy": "ask_model",
                        },
                    },
                }
            )
        )

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "payload": {"text": "hello now", "conversation_id": "c-1"},
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            life_incident_start_finalizer=life_incident_start_finalizer,
        )

        entries = raw_log.query({"trace_id": result["trace_id"]})["entries"]
        success_entries = raw_log.query(
            {"trace_id": result["trace_id"], "kinds": ["life_incident_started"]}
        )["entries"]

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(result["failure"]["stage"], LIFE_INCIDENT_START_FINALIZE_STAGE)
        self.assertEqual(result["failure"]["code"], "malformed_finalize_result")
        self.assertIn("must be exposed and confirmed before append", result["failure"]["message"])
        self.assertEqual(
            [entry["kind"] for entry in entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "life_incident_start_rejected",
            ],
        )
        self.assertEqual(success_entries, [])

    def test_raw_log_query_surface_rejects_incident_success_when_finalizer_does_not_stage(self):
        raw_log = InMemoryRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        life_incident_start_finalizer = RecordingLifeIncidentStartFinalizer()
        adapter = RecordingAdapter(
            raw_text=json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                    "life_action": {
                        "type": "start_incident",
                        "incident": {
                            "type": "think",
                            "title": "thinking through the plan",
                            "interrupt_policy": "interruptible",
                            "resume_policy": "ask_model",
                        },
                    },
                }
            )
        )

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "payload": {"text": "hello now", "conversation_id": "c-1"},
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            life_incident_start_finalizer=life_incident_start_finalizer,
        )

        entries = raw_log.query({"trace_id": result["trace_id"]})["entries"]
        success_entries = raw_log.query(
            {"trace_id": result["trace_id"], "kinds": ["life_incident_started"]}
        )["entries"]

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(result["failure"]["stage"], LIFE_INCIDENT_START_FINALIZE_STAGE)
        self.assertEqual(result["failure"]["code"], "malformed_finalize_result")
        self.assertIn("not staged by finalizer visibility", result["failure"]["message"])
        self.assertEqual(
            [entry["kind"] for entry in entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "life_incident_start_rejected",
            ],
        )
        self.assertEqual(success_entries, [])

    def test_conflicting_write_opt_ins_stop_before_user_visible_message_commit(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        adapter = RecordingAdapter()
        current_state_source = RecordingCurrentStateSource(current_state_snapshot())
        living_state_patch_store = RecordingLivingStatePatchStore()
        living_state_patch_finalizer = RecordingLivingStatePatchFinalizer()
        life_incident_start_finalizer = RecordingLifeIncidentStartFinalizer()

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "schema_version": "0.1",
                "payload": {
                    "text": "hello now",
                    "user_id": "u-1",
                    "conversation_id": "c-1",
                },
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            current_state_source=current_state_source,
            living_state_patch_store=living_state_patch_store,
            living_state_patch_finalizer=living_state_patch_finalizer,
            life_incident_start_finalizer=life_incident_start_finalizer,
        )

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(result["stopped_at"], "user_turn_preflight")
        self.assertEqual(result["failure"]["stage"], "user_turn_preflight")
        self.assertEqual(result["failure"]["code"], "conflicting_write_action_opt_in")
        self.assertIn("Only one write-action opt-in", result["failure"]["message"])
        self.assertIn("cancel_incident", result["failure"]["message"])
        self.assertIn("interrupt_incident", result["failure"]["message"])
        self.assertNotIn("user_visible_message_result", result)
        self.assertNotIn("role_model_result", result)
        self.assertNotIn("visible_reply_result", result)
        self.assertEqual([entry["kind"] for entry in raw_log.entries], ["runtime_event_received"])
        self.assertEqual(visible_conversation.records, [prior_user_record()])
        self.assertEqual(visible_conversation.read_requests, [])
        self.assertEqual(adapter.calls, [])
        self.assertEqual(current_state_source.requests, [])
        self.assertEqual(living_state_patch_store.requests, [])
        self.assertEqual(living_state_patch_finalizer.requests, [])
        self.assertEqual(life_incident_start_finalizer.requests, [])
        self.assertEqual(life_incident_start_finalizer.durable_started_incidents, [])
        self.assertEqual(life_incident_start_finalizer.durable_raw_event_log_entries, [])

    def test_incident_interrupt_conflict_stops_before_user_visible_message_commit(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        adapter = RecordingAdapter()
        life_incident_start_finalizer = RecordingLifeIncidentStartFinalizer()

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "schema_version": "0.1",
                "payload": {
                    "text": "hello now",
                    "user_id": "u-1",
                    "conversation_id": "c-1",
                },
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            life_incident_start_finalizer=life_incident_start_finalizer,
            life_incident_interrupt_finalizer=object(),
        )

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(result["stopped_at"], "user_turn_preflight")
        self.assertEqual(result["failure"]["stage"], "user_turn_preflight")
        self.assertEqual(result["failure"]["code"], "conflicting_write_action_opt_in")
        self.assertIn("interrupt_incident", result["failure"]["message"])
        self.assertNotIn("user_visible_message_result", result)
        self.assertNotIn("life_incident_interrupt_result", result)
        self.assertNotIn("role_model_result", result)
        self.assertEqual([entry["kind"] for entry in raw_log.entries], ["runtime_event_received"])
        self.assertEqual(visible_conversation.records, [prior_user_record()])
        self.assertEqual(visible_conversation.read_requests, [])
        self.assertEqual(adapter.calls, [])
        self.assertEqual(life_incident_start_finalizer.requests, [])
        self.assertEqual(life_incident_start_finalizer.durable_started_incidents, [])
        self.assertEqual(life_incident_start_finalizer.durable_raw_event_log_entries, [])

    def test_state_enabled_turn_commits_living_state_patch_before_assistant_reply(self):
        operations = []
        raw_log = RecordingRawEventLog(operations=operations)
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        current_state_source = RecordingCurrentStateSource(current_state_snapshot())
        active_incident_source = RecordingActiveIncidentSource(active_incident_snapshot())
        living_state_patch_store = RecordingLivingStatePatchStore()
        living_state_patch_finalizer = RecordingLivingStatePatchFinalizer(operations=operations)
        adapter = RecordingAdapter(
            raw_text=json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                    "state_patch": {
                        "living_state": {
                            "current_activity": "answering the user",
                            "mood": "attentive",
                        }
                    },
                }
            )
        )

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "schema_version": "0.1",
                "payload": {
                    "text": "hello now",
                    "user_id": "u-1",
                    "conversation_id": "c-1",
                },
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            current_state_source=current_state_source,
            active_incident_source=active_incident_source,
            living_state_patch_store=living_state_patch_store,
            living_state_patch_finalizer=living_state_patch_finalizer,
        )

        self.assertEqual(result["status"], "user_turn_committed")
        self.assertEqual(
            adapter.calls[0]["allowed_actions"],
            ["visible_reply", "state_patch"],
        )
        self.assertEqual(
            adapter.calls[0]["decision_context"]["character_snapshot"]["active_incident"],
            active_incident_brief(),
        )
        self.assertEqual(
            [kind for _source, kind in operations],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "living_state_patch_committed",
                "visible_reply_committed",
            ],
        )
        self.assertEqual(len(living_state_patch_store.requests), 1)
        self.assertEqual(len(living_state_patch_finalizer.requests), 1)
        self.assertEqual(len(living_state_patch_finalizer.durable_state_snapshots), 1)
        self.assertEqual(len(living_state_patch_finalizer.durable_success_logs), 1)
        self.assertEqual(
            living_state_patch_store.requests[0],
            {
                "schema_version": "0.1",
                "trace_id": "trace-current",
                "event_id": "event-current",
                "event_type": "USER_MESSAGE",
                "commit_time": "2026-05-14T11:30:00+00:00",
                "decision_action": "visible_reply",
                "patch": {
                    "living_state": {
                        "current_activity": "answering the user",
                        "mood": "attentive",
                    }
                },
                "user_id": "u-1",
                "conversation_id": "c-1",
            },
        )
        self.assertNotIn(
            "updated_at",
            living_state_patch_store.requests[0]["patch"]["living_state"],
        )
        self.assertNotIn(
            "source_event_ids",
            living_state_patch_store.requests[0]["patch"]["living_state"],
        )
        self.assertEqual(
            result["living_state_patch_result"]["committed_snapshot"],
            committed_snapshot(),
        )
        self.assertEqual(
            result["living_state_patch_result"]["committed_log_entry_id"],
            living_state_patch_finalizer.durable_success_logs[0]["log_id"],
        )
        self.assertEqual(
            living_state_patch_finalizer.durable_success_logs[0]["data"]["committed_snapshot"][
                "updated_at"
            ],
            "2026-05-14T11:30:00+00:00",
        )
        self.assertEqual(visible_conversation.records[-1]["text"], "hello back")
        self.assertNotIn(
            "state_patch",
            raw_log.entries[3]["data"]["role_model_result"]["decision"],
        )

    def test_raw_log_query_surface_includes_living_state_success_log_in_order(self):
        raw_log = InMemoryRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        current_state_source = RecordingCurrentStateSource(current_state_snapshot())
        living_state_patch_store = RecordingLivingStatePatchStore()
        living_state_patch_finalizer = RecordingLivingStatePatchFinalizer(
            raw_log_visibility=raw_log
        )
        adapter = RecordingAdapter(
            raw_text=json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                    "state_patch": {
                        "living_state": {
                            "current_activity": "answering the user",
                            "mood": "attentive",
                        }
                    },
                }
            )
        )

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "schema_version": "0.1",
                "payload": {
                    "text": "hello now",
                    "user_id": "u-1",
                    "conversation_id": "c-1",
                },
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            current_state_source=current_state_source,
            living_state_patch_store=living_state_patch_store,
            living_state_patch_finalizer=living_state_patch_finalizer,
        )

        entries = raw_log.query({"trace_id": result["trace_id"]})["entries"]
        success_entries = raw_log.query(
            {"trace_id": result["trace_id"], "kinds": ["living_state_patch_committed"]}
        )["entries"]

        self.assertEqual(result["status"], "user_turn_committed")
        self.assertEqual(
            [entry["kind"] for entry in entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "living_state_patch_committed",
                "visible_reply_committed",
            ],
        )
        self.assertEqual(len(success_entries), 1)
        self.assertEqual(
            result["living_state_patch_result"]["committed_log_entry_id"],
            success_entries[0]["log_id"],
        )

    def test_state_enabled_turn_without_patch_preserves_visible_reply_flow(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        current_state_source = RecordingCurrentStateSource(current_state_snapshot())
        living_state_patch_store = RecordingLivingStatePatchStore()
        living_state_patch_finalizer = RecordingLivingStatePatchFinalizer()
        adapter = RecordingAdapter()

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "schema_version": "0.1",
                "payload": {
                    "text": "hello now",
                    "user_id": "u-1",
                    "conversation_id": "c-1",
                },
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            current_state_source=current_state_source,
            living_state_patch_store=living_state_patch_store,
            living_state_patch_finalizer=living_state_patch_finalizer,
        )

        self.assertEqual(result["status"], "user_turn_committed")
        self.assertEqual(
            adapter.calls[0]["allowed_actions"],
            ["visible_reply", "state_patch"],
        )
        self.assertEqual(
            result["living_state_patch_result"]["status"],
            "living_state_patch_skipped",
        )
        self.assertEqual(living_state_patch_store.requests, [])
        self.assertEqual(living_state_patch_finalizer.requests, [])
        self.assertEqual(living_state_patch_finalizer.durable_state_snapshots, [])
        self.assertEqual(living_state_patch_finalizer.durable_success_logs, [])
        self.assertEqual(
            [entry["kind"] for entry in raw_log.entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "visible_reply_committed",
            ],
        )
        self.assertEqual(
            [record["kind"] for record in visible_conversation.records],
            [
                "user_visible_message",
                "user_visible_message",
                "assistant_visible_reply",
            ],
        )
        self.assertEqual(visible_conversation.records[-1]["text"], "hello back")
        self.assertNotIn(
            "living_state_patch_committed",
            [entry["kind"] for entry in raw_log.entries],
        )
        self.assertNotIn(
            "living_state_patch_rejected",
            [entry["kind"] for entry in raw_log.entries],
        )

    def test_state_patch_store_rejection_stops_before_assistant_reply(self):
        from commit_effects.living_state import LivingStatePatchStoreError

        raw_log = RecordingRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        adapter = RecordingAdapter(
            raw_text=json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                    "state_patch": {"living_state": {"mood": "attentive"}},
                }
            )
        )
        living_state_patch_store = RecordingLivingStatePatchStore(
            error=LivingStatePatchStoreError("store rejected", code="store_rejected")
        )
        living_state_patch_finalizer = RecordingLivingStatePatchFinalizer()

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "payload": {"text": "hello now", "conversation_id": "c-1"},
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            current_state_source=RecordingCurrentStateSource(current_state_snapshot()),
            living_state_patch_store=living_state_patch_store,
            living_state_patch_finalizer=living_state_patch_finalizer,
        )

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(result["stopped_at"], "living_state_patch_commit")
        self.assertEqual(
            [entry["kind"] for entry in raw_log.entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "living_state_patch_rejected",
            ],
        )
        self.assertEqual(
            [record["kind"] for record in visible_conversation.records],
            ["user_visible_message", "user_visible_message"],
        )
        self.assertEqual(living_state_patch_finalizer.requests, [])
        self.assertEqual(living_state_patch_finalizer.durable_state_snapshots, [])
        self.assertEqual(living_state_patch_finalizer.durable_success_logs, [])

    def test_state_patch_finalizer_rejection_stops_before_assistant_reply(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        adapter = RecordingAdapter(
            raw_text=json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                    "state_patch": {"living_state": {"mood": "attentive"}},
                }
            )
        )
        living_state_patch_store = RecordingLivingStatePatchStore()
        living_state_patch_finalizer = RecordingLivingStatePatchFinalizer(
            error=LivingStatePatchFinalizerError(
                "finalize rejected",
                code="finalize_rejected",
            )
        )

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "payload": {"text": "hello now", "conversation_id": "c-1"},
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            current_state_source=RecordingCurrentStateSource(current_state_snapshot()),
            living_state_patch_store=living_state_patch_store,
            living_state_patch_finalizer=living_state_patch_finalizer,
        )

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(result["stopped_at"], "living_state_patch_commit")
        self.assertEqual(result["failure"]["stage"], LIVING_STATE_PATCH_FINALIZE_STAGE)
        self.assertEqual(
            [entry["kind"] for entry in raw_log.entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "living_state_patch_rejected",
            ],
        )
        self.assertEqual(
            [record["kind"] for record in visible_conversation.records],
            ["user_visible_message", "user_visible_message"],
        )
        self.assertEqual(len(living_state_patch_store.requests), 1)
        self.assertEqual(len(living_state_patch_finalizer.requests), 1)
        self.assertEqual(living_state_patch_finalizer.durable_state_snapshots, [])
        self.assertEqual(living_state_patch_finalizer.durable_success_logs, [])

    def test_raw_log_query_surface_excludes_state_success_log_on_finalizer_rejection(self):
        raw_log = InMemoryRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        adapter = RecordingAdapter(
            raw_text=json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                    "state_patch": {"living_state": {"mood": "attentive"}},
                }
            )
        )
        living_state_patch_store = RecordingLivingStatePatchStore()
        living_state_patch_finalizer = RecordingLivingStatePatchFinalizer(
            error=LivingStatePatchFinalizerError(
                "finalize rejected",
                code="finalize_rejected",
            ),
            raw_log_visibility=raw_log,
        )

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "payload": {"text": "hello now", "conversation_id": "c-1"},
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            current_state_source=RecordingCurrentStateSource(current_state_snapshot()),
            living_state_patch_store=living_state_patch_store,
            living_state_patch_finalizer=living_state_patch_finalizer,
        )

        entries = raw_log.query({"trace_id": result["trace_id"]})["entries"]
        success_entries = raw_log.query(
            {"trace_id": result["trace_id"], "kinds": ["living_state_patch_committed"]}
        )["entries"]

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(
            [entry["kind"] for entry in entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "living_state_patch_rejected",
            ],
        )
        self.assertEqual(success_entries, [])

    def test_raw_log_query_surface_excludes_state_success_log_on_malformed_finalize(self):
        raw_log = InMemoryRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        adapter = RecordingAdapter(
            raw_text=json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                    "state_patch": {"living_state": {"mood": "attentive"}},
                }
            )
        )
        living_state_patch_store = RecordingLivingStatePatchStore()
        living_state_patch_finalizer = RecordingLivingStatePatchFinalizer(
            result_override={
                "schema_version": "0.1",
                "trace_id": "trace-current",
                "event_id": "event-current",
                "event_type": "USER_MESSAGE",
                "committed_log_entry_id": "wrong-log-id",
            },
            raw_log_visibility=raw_log,
            expose_before_result_override=True,
        )

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "payload": {"text": "hello now", "conversation_id": "c-1"},
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            current_state_source=RecordingCurrentStateSource(current_state_snapshot()),
            living_state_patch_store=living_state_patch_store,
            living_state_patch_finalizer=living_state_patch_finalizer,
        )

        entries = raw_log.query({"trace_id": result["trace_id"]})["entries"]
        success_entries = raw_log.query(
            {"trace_id": result["trace_id"], "kinds": ["living_state_patch_committed"]}
        )["entries"]

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(result["failure"]["stage"], LIVING_STATE_PATCH_FINALIZE_STAGE)
        self.assertEqual(result["failure"]["code"], "malformed_finalize_result")
        self.assertEqual(
            [entry["kind"] for entry in entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "living_state_patch_rejected",
            ],
        )
        self.assertEqual(success_entries, [])
        self.assertEqual(living_state_patch_finalizer.durable_state_snapshots, [])
        self.assertEqual(living_state_patch_finalizer.durable_success_logs, [])

    def test_raw_log_query_surface_rejects_state_staging_visibility_failure(self):
        raw_log = InMemoryRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        adapter = RecordingAdapter(
            raw_text=json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                    "state_patch": {"living_state": {"mood": "attentive"}},
                }
            )
        )
        living_state_patch_store = RecordingLivingStatePatchStore()
        living_state_patch_finalizer = RecordingLivingStatePatchFinalizer(
            raw_log_visibility=raw_log,
            expose_conflicting_success=True,
        )

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "payload": {"text": "hello now", "conversation_id": "c-1"},
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            current_state_source=RecordingCurrentStateSource(current_state_snapshot()),
            living_state_patch_store=living_state_patch_store,
            living_state_patch_finalizer=living_state_patch_finalizer,
        )

        entries = raw_log.query({"trace_id": result["trace_id"]})["entries"]
        success_entries = raw_log.query(
            {"trace_id": result["trace_id"], "kinds": ["living_state_patch_committed"]}
        )["entries"]

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(result["failure"]["stage"], LIVING_STATE_PATCH_FINALIZE_STAGE)
        self.assertEqual(result["failure"]["code"], "malformed_finalize_result")
        self.assertIn("already exists with different data", result["failure"]["message"])
        self.assertEqual(
            [entry["kind"] for entry in entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "living_state_patch_rejected",
            ],
        )
        self.assertEqual(success_entries, [])
        self.assertEqual(living_state_patch_finalizer.durable_state_snapshots, [])
        self.assertEqual(living_state_patch_finalizer.durable_success_logs, [])

    def test_raw_log_query_surface_rejects_state_success_accidentally_appended(self):
        raw_log = InMemoryRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        adapter = RecordingAdapter(
            raw_text=json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                    "state_patch": {"living_state": {"mood": "attentive"}},
                }
            )
        )
        living_state_patch_store = RecordingLivingStatePatchStore()
        living_state_patch_finalizer = RecordingLivingStatePatchFinalizer(
            result_override={
                "schema_version": "0.1",
                "trace_id": "trace-current",
                "event_id": "event-current",
                "event_type": "USER_MESSAGE",
                "committed_log_entry_id": "wrong-log-id",
            },
            raw_log_visibility=raw_log,
            append_before_result_override=True,
        )

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "payload": {"text": "hello now", "conversation_id": "c-1"},
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            current_state_source=RecordingCurrentStateSource(current_state_snapshot()),
            living_state_patch_store=living_state_patch_store,
            living_state_patch_finalizer=living_state_patch_finalizer,
        )

        entries = raw_log.query({"trace_id": result["trace_id"]})["entries"]
        success_entries = raw_log.query(
            {"trace_id": result["trace_id"], "kinds": ["living_state_patch_committed"]}
        )["entries"]

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(result["failure"]["stage"], LIVING_STATE_PATCH_FINALIZE_STAGE)
        self.assertEqual(result["failure"]["code"], "malformed_finalize_result")
        self.assertIn("must be exposed and confirmed before append", result["failure"]["message"])
        self.assertEqual(
            [entry["kind"] for entry in entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "living_state_patch_rejected",
            ],
        )
        self.assertEqual(success_entries, [])

    def test_raw_log_query_surface_rejects_state_success_when_finalizer_does_not_stage(self):
        raw_log = InMemoryRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        adapter = RecordingAdapter(
            raw_text=json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                    "state_patch": {"living_state": {"mood": "attentive"}},
                }
            )
        )
        living_state_patch_store = RecordingLivingStatePatchStore()
        living_state_patch_finalizer = RecordingLivingStatePatchFinalizer()

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "payload": {"text": "hello now", "conversation_id": "c-1"},
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            current_state_source=RecordingCurrentStateSource(current_state_snapshot()),
            living_state_patch_store=living_state_patch_store,
            living_state_patch_finalizer=living_state_patch_finalizer,
        )

        entries = raw_log.query({"trace_id": result["trace_id"]})["entries"]
        success_entries = raw_log.query(
            {"trace_id": result["trace_id"], "kinds": ["living_state_patch_committed"]}
        )["entries"]

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(result["failure"]["stage"], LIVING_STATE_PATCH_FINALIZE_STAGE)
        self.assertEqual(result["failure"]["code"], "malformed_finalize_result")
        self.assertIn("not staged by finalizer visibility", result["failure"]["message"])
        self.assertEqual(
            [entry["kind"] for entry in entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "living_state_patch_rejected",
            ],
        )
        self.assertEqual(success_entries, [])

    def test_shape_valid_bad_store_result_stops_before_assistant_reply(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        adapter = RecordingAdapter(
            raw_text=json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                    "state_patch": {"living_state": {"mood": "attentive"}},
                }
            )
        )
        living_state_patch_store = RecordingLivingStatePatchStore(
            snapshot={**committed_snapshot(), "source_event_ids": ["event-state-1"]}
        )
        living_state_patch_finalizer = RecordingLivingStatePatchFinalizer()

        result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "payload": {"text": "hello now", "conversation_id": "c-1"},
            },
            adapter=adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
            current_state_source=RecordingCurrentStateSource(current_state_snapshot()),
            living_state_patch_store=living_state_patch_store,
            living_state_patch_finalizer=living_state_patch_finalizer,
        )

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(result["stopped_at"], "living_state_patch_commit")
        self.assertEqual(result["failure"]["stage"], "living_state_patch_store")
        self.assertEqual(result["failure"]["code"], "malformed_store_result")
        self.assertEqual(
            [entry["kind"] for entry in raw_log.entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_completed",
                "living_state_patch_rejected",
            ],
        )
        self.assertNotIn(
            "living_state_patch_committed",
            [entry["kind"] for entry in raw_log.entries],
        )
        self.assertEqual(
            [record["kind"] for record in visible_conversation.records],
            ["user_visible_message", "user_visible_message"],
        )
        self.assertEqual(living_state_patch_finalizer.requests, [])
        self.assertEqual(living_state_patch_finalizer.durable_state_snapshots, [])
        self.assertEqual(living_state_patch_finalizer.durable_success_logs, [])

    def test_state_patch_without_write_opt_in_is_malformed_model_output(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])
        adapter = RecordingAdapter(
            raw_text=json.dumps(
                {
                    "schema_version": "0.1",
                    "action": "visible_reply",
                    "visible_reply": {"text": "hello back"},
                    "state_patch": {"living_state": {"mood": "attentive"}},
                }
            )
        )

        with self.assertRaisesRegex(ValueError, "state_patch"):
            run_user_message_turn(
                {
                    "event_id": "event-current",
                    "trace_id": "trace-current",
                    "type": "USER_MESSAGE",
                    "created_at": "2026-05-14T11:30:00+00:00",
                    "payload": {"text": "hello now", "conversation_id": "c-1"},
                },
                adapter=adapter,
                raw_event_log=raw_log,
                visible_conversation=visible_conversation,
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
                current_state_source=RecordingCurrentStateSource(current_state_snapshot()),
            )

        self.assertEqual(
            [entry["kind"] for entry in raw_log.entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_failed",
            ],
        )
        self.assertNotIn(
            "living_state_patch_rejected",
            [entry["kind"] for entry in raw_log.entries],
        )

    def test_second_turn_uses_completed_prior_turn_as_recent_context(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = InMemoryVisibleConversation()
        first_adapter = RecordingAdapter()
        second_adapter = RecordingAdapter()

        run_user_message_turn(
            {
                "event_id": "event-first",
                "trace_id": "trace-first",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:20:00+00:00",
                "payload": {"text": "first hello", "conversation_id": "c-1"},
            },
            adapter=first_adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        second_result = run_user_message_turn(
            {
                "event_id": "event-second",
                "trace_id": "trace-second",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:31:00+00:00",
                "payload": {"text": "second hello", "conversation_id": "c-1"},
            },
            adapter=second_adapter,
            raw_event_log=raw_log,
            visible_conversation=visible_conversation,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(second_result["status"], "user_turn_committed")
        recent_messages = second_adapter.calls[0]["decision_context"]["character_snapshot"][
            "recent_visible_messages"
        ]
        self.assertEqual(
            [
                (message["source_event_id"], message["role"], message["text"])
                for message in recent_messages
            ],
            [
                ("event-first", "user", "first hello"),
                ("event-first", "assistant", "hello back"),
            ],
        )
        self.assertNotIn(
            "event-second",
            {message["source_event_id"] for message in recent_messages},
        )

    def test_kernel_handle_event_and_user_turn_share_intake_route(self):
        kernel_log = RecordingRawEventLog()
        turn_log = RecordingRawEventLog()

        kernel_route = RuntimeKernel(
            kernel_log,
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        ).handle_event(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "payload": {"text": "hello", "conversation_id": "c-1"},
            }
        )
        turn_result = run_user_message_turn(
            {
                "event_id": "event-current",
                "trace_id": "trace-current",
                "type": "USER_MESSAGE",
                "created_at": "2026-05-14T11:30:00+00:00",
                "payload": {"text": "hello", "conversation_id": "c-1"},
            },
            adapter=RecordingAdapter(),
            raw_event_log=turn_log,
            visible_conversation=InMemoryVisibleConversation(),
            id_generator=SequenceIdGenerator(),
            clock=fixed_clock,
        )

        self.assertEqual(turn_result["kernel_route"], kernel_route)
        self.assertEqual(kernel_log.entries[0]["kind"], "runtime_event_received")
        self.assertEqual(turn_log.entries[0]["kind"], "runtime_event_received")

    def test_malformed_input_stops_before_raw_log_or_visible_appends(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = InMemoryVisibleConversation()

        with self.assertRaises(RuntimeValidationError):
            run_user_message_turn(
                {"type": "TIMER", "payload": {"text": "hello"}},
                adapter=RecordingAdapter(),
                raw_event_log=raw_log,
                visible_conversation=visible_conversation,
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
            )

        self.assertEqual(raw_log.entries, [])
        self.assertEqual(visible_conversation.records, [])

    def test_malformed_model_output_logs_failure_without_assistant_reply(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = InMemoryVisibleConversation([prior_user_record()])

        with self.assertRaisesRegex(ValueError, "raw_text"):
            run_user_message_turn(
                {
                    "event_id": "event-current",
                    "trace_id": "trace-current",
                    "type": "USER_MESSAGE",
                    "created_at": "2026-05-14T11:30:00+00:00",
                    "payload": {"text": "hello now", "conversation_id": "c-1"},
                },
                adapter=RecordingAdapter(raw_text="not json"),
                raw_event_log=raw_log,
                visible_conversation=visible_conversation,
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
            )

        self.assertEqual(
            [entry["kind"] for entry in raw_log.entries],
            [
                "runtime_event_received",
                "user_visible_message_committed",
                "role_model_turn_failed",
            ],
        )
        self.assertEqual(
            [record["kind"] for record in visible_conversation.records],
            ["user_visible_message", "user_visible_message"],
        )

    def test_malformed_current_state_stops_before_adapter_and_assistant_reply(self):
        cases = [
            ({**current_state_snapshot(), "source_event_ids": [123]}, "source_event_ids"),
            (
                {**current_state_snapshot(), "source_event_ids": ["event-current"]},
                "current event_id",
            ),
        ]

        for snapshot, error_pattern in cases:
            with self.subTest(error_pattern=error_pattern):
                raw_log = RecordingRawEventLog()
                visible_conversation = InMemoryVisibleConversation([prior_user_record()])
                adapter = RecordingAdapter()
                current_state_source = RecordingCurrentStateSource(snapshot)

                with self.assertRaisesRegex(ValueError, error_pattern):
                    run_user_message_turn(
                        {
                            "event_id": "event-current",
                            "trace_id": "trace-current",
                            "type": "USER_MESSAGE",
                            "created_at": "2026-05-14T11:30:00+00:00",
                            "payload": {"text": "hello now", "conversation_id": "c-1"},
                        },
                        adapter=adapter,
                        raw_event_log=raw_log,
                        visible_conversation=visible_conversation,
                        id_generator=SequenceIdGenerator(),
                        clock=fixed_clock,
                        current_state_source=current_state_source,
                    )

                self.assertEqual(adapter.calls, [])
                self.assertEqual(
                    [entry["kind"] for entry in raw_log.entries],
                    [
                        "runtime_event_received",
                        "user_visible_message_committed",
                        "role_model_turn_failed",
                    ],
                )
                assert_context_build_failure_log(
                    self,
                    raw_log,
                    message_fragment=error_pattern,
                )
                self.assertEqual(
                    [record["kind"] for record in visible_conversation.records],
                    ["user_visible_message", "user_visible_message"],
                )

    def test_malformed_active_incident_stops_before_adapter_and_assistant_reply(self):
        cases = [
            ({**active_incident_snapshot(), "status": "completed"}, "status"),
            (
                {**active_incident_snapshot(), "source_event_ids": ["event-current"]},
                "current event_id",
            ),
        ]

        for snapshot, error_pattern in cases:
            with self.subTest(error_pattern=error_pattern):
                raw_log = RecordingRawEventLog()
                visible_conversation = InMemoryVisibleConversation([prior_user_record()])
                adapter = RecordingAdapter()
                active_incident_source = RecordingActiveIncidentSource(snapshot)

                with self.assertRaisesRegex(ValueError, error_pattern):
                    run_user_message_turn(
                        {
                            "event_id": "event-current",
                            "trace_id": "trace-current",
                            "type": "USER_MESSAGE",
                            "created_at": "2026-05-14T11:30:00+00:00",
                            "payload": {"text": "hello now", "conversation_id": "c-1"},
                        },
                        adapter=adapter,
                        raw_event_log=raw_log,
                        visible_conversation=visible_conversation,
                        id_generator=SequenceIdGenerator(),
                        clock=fixed_clock,
                        active_incident_source=active_incident_source,
                    )

                self.assertEqual(adapter.calls, [])
                self.assertEqual(
                    [entry["kind"] for entry in raw_log.entries],
                    [
                        "runtime_event_received",
                        "user_visible_message_committed",
                        "role_model_turn_failed",
                    ],
                )
                assert_context_build_failure_log(
                    self,
                    raw_log,
                    message_fragment=error_pattern,
                )
                self.assertNotIn(
                    "living_state_patch_rejected",
                    [entry["kind"] for entry in raw_log.entries],
                )
                self.assertEqual(
                    [record["kind"] for record in visible_conversation.records],
                    ["user_visible_message", "user_visible_message"],
                )


if __name__ == "__main__":
    unittest.main()
