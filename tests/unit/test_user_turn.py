import sys
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

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
    def __init__(self):
        self.entries = []

    def append(self, entry):
        self.entries.append(entry)


class RecordingVisibleConversation:
    def __init__(self):
        self.records = []

    def append(self, output):
        self.records.append(output)

    def read_visible_conversation_records(self, request):
        return []


class UserTurnStopTests(unittest.TestCase):
    def test_rejects_conflicting_write_opt_ins_before_user_visible_message_commit(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = RecordingVisibleConversation()
        adapter = Mock()

        with (
            patch("runtime.user_turn.commit_user_visible_message") as commit_user,
            patch("runtime.user_turn.run_role_model_turn") as role_model_turn,
            patch("runtime.user_turn.commit_living_state_patch") as commit_patch,
            patch("runtime.user_turn.commit_life_incident_start") as commit_incident,
            patch("runtime.user_turn.commit_visible_reply") as commit_reply,
        ):
            result = run_user_message_turn(
                {
                    "event_id": "event-1",
                    "trace_id": "trace-1",
                    "type": "USER_MESSAGE",
                    "created_at": "2026-05-14T11:30:00+00:00",
                    "payload": {"text": "hello", "conversation_id": "c-1"},
                },
                adapter=adapter,
                raw_event_log=raw_log,
                visible_conversation=visible_conversation,
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
                current_state_source=object(),
                living_state_patch_store=object(),
                living_state_patch_finalizer=object(),
                life_incident_start_finalizer=object(),
            )

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(result["stopped_at"], "user_turn_preflight")
        self.assertEqual(result["failure"]["stage"], "user_turn_preflight")
        self.assertEqual(result["failure"]["code"], "conflicting_write_action_opt_in")
        self.assertIn("state_patch and life_action", result["failure"]["message"])
        self.assertNotIn("user_visible_message_result", result)
        self.assertNotIn("role_model_result", result)
        self.assertEqual([entry["kind"] for entry in raw_log.entries], ["runtime_event_received"])
        self.assertEqual(visible_conversation.records, [])
        commit_user.assert_not_called()
        role_model_turn.assert_not_called()
        commit_patch.assert_not_called()
        commit_incident.assert_not_called()
        commit_reply.assert_not_called()
        adapter.generate.assert_not_called()

    def test_stops_before_model_when_user_visible_message_commit_rejects(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = RecordingVisibleConversation()
        adapter = Mock()
        current_state_source = object()
        rejected_result = {
            "trace_id": "trace-1",
            "event_id": "event-1",
            "event_type": "USER_MESSAGE",
            "status": "user_visible_message_rejected",
            "failure": {
                "stage": "user_visible_message_validation",
                "code": "malformed_commit_input",
                "message": "projection rejected",
            },
        }

        with (
            patch(
                "runtime.user_turn.commit_user_visible_message",
                return_value=rejected_result,
            ) as commit_user,
            patch("runtime.user_turn.run_role_model_turn") as role_model_turn,
        ):
            result = run_user_message_turn(
                {
                    "event_id": "event-1",
                    "trace_id": "trace-1",
                    "type": "USER_MESSAGE",
                    "created_at": "2026-05-14T11:30:00+00:00",
                    "payload": {"text": "hello", "conversation_id": "c-1"},
                },
                adapter=adapter,
                raw_event_log=raw_log,
                visible_conversation=visible_conversation,
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
                current_state_source=current_state_source,
            )

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(result["stopped_at"], "user_visible_message_commit")
        self.assertEqual(result["failure"]["message"], "projection rejected")
        self.assertEqual(result["user_visible_message_result"], rejected_result)
        self.assertNotIn("role_model_result", result)
        self.assertNotIn("visible_reply_result", result)
        self.assertEqual(result["kernel_route"]["next_step"], "user_turn")
        commit_user.assert_called_once()
        role_model_turn.assert_not_called()
        adapter.generate.assert_not_called()

    def test_stops_after_model_when_visible_reply_commit_rejects(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = RecordingVisibleConversation()
        adapter = Mock()
        current_state_source = object()
        active_incident_source = object()
        user_commit_result = {
            "trace_id": "trace-1",
            "event_id": "event-1",
            "event_type": "USER_MESSAGE",
            "status": "user_visible_message_committed",
            "message": {"message_id": "message-1"},
        }
        role_model_result = {
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
            },
        }
        visible_reply_result = {
            "trace_id": "trace-1",
            "event_id": "event-1",
            "event_type": "USER_MESSAGE",
            "status": "visible_reply_rejected",
            "failure": {
                "stage": "commit_validation",
                "code": "malformed_commit_input",
                "message": "reply rejected",
            },
        }

        with (
            patch(
                "runtime.user_turn.commit_user_visible_message",
                return_value=user_commit_result,
            ),
            patch(
                "runtime.user_turn.run_role_model_turn",
                return_value=role_model_result,
            ) as role_model_turn,
            patch(
                "runtime.user_turn.commit_visible_reply",
                return_value=visible_reply_result,
            ) as commit_reply,
        ):
            result = run_user_message_turn(
                {
                    "event_id": "event-1",
                    "trace_id": "trace-1",
                    "type": "USER_MESSAGE",
                    "created_at": "2026-05-14T11:30:00+00:00",
                    "payload": {"text": "hello", "conversation_id": "c-1"},
                },
                adapter=adapter,
                raw_event_log=raw_log,
                visible_conversation=visible_conversation,
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
                current_state_source=current_state_source,
                active_incident_source=active_incident_source,
            )

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(result["stopped_at"], "visible_reply_commit")
        self.assertEqual(result["failure"]["message"], "reply rejected")
        self.assertEqual(result["user_visible_message_result"], user_commit_result)
        self.assertEqual(result["role_model_result"], role_model_result)
        self.assertEqual(result["visible_reply_result"], visible_reply_result)
        role_model_turn.assert_called_once()
        self.assertIs(
            role_model_turn.call_args.kwargs["current_state_source"],
            current_state_source,
        )
        self.assertIs(
            role_model_turn.call_args.kwargs["active_incident_source"],
            active_incident_source,
        )
        self.assertIs(role_model_turn.call_args.kwargs["allow_state_patch"], False)
        commit_reply.assert_called_once()

    def test_opts_into_living_state_patch_when_read_and_write_boundaries_exist(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = RecordingVisibleConversation()
        adapter = Mock()
        current_state_source = object()
        living_state_patch_store = object()
        living_state_patch_finalizer = object()
        user_commit_result = {
            "trace_id": "trace-1",
            "event_id": "event-1",
            "event_type": "USER_MESSAGE",
            "status": "user_visible_message_committed",
            "message": {"message_id": "message-1"},
        }
        role_model_result = {
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
                "state_patch": {"living_state": {"mood": "attentive"}},
            },
        }
        state_patch_result = {
            "schema_version": "0.1",
            "trace_id": "trace-1",
            "event_id": "event-1",
            "event_type": "USER_MESSAGE",
            "status": "living_state_patch_committed",
            "committed_snapshot": {"schema_version": "0.1"},
        }
        visible_reply_result = {
            "trace_id": "trace-1",
            "event_id": "event-1",
            "event_type": "USER_MESSAGE",
            "status": "visible_reply_committed",
            "output": {"output_id": "output-1"},
        }

        with (
            patch(
                "runtime.user_turn.commit_user_visible_message",
                return_value=user_commit_result,
            ),
            patch(
                "runtime.user_turn.run_role_model_turn",
                return_value=role_model_result,
            ) as role_model_turn,
            patch(
                "runtime.user_turn.commit_living_state_patch",
                return_value=state_patch_result,
            ) as commit_patch,
            patch(
                "runtime.user_turn.commit_visible_reply",
                return_value=visible_reply_result,
            ) as commit_reply,
        ):
            result = run_user_message_turn(
                {
                    "event_id": "event-1",
                    "trace_id": "trace-1",
                    "type": "USER_MESSAGE",
                    "created_at": "2026-05-14T11:30:00+00:00",
                    "payload": {"text": "hello", "conversation_id": "c-1"},
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
        self.assertEqual(result["living_state_patch_result"], state_patch_result)
        self.assertIs(role_model_turn.call_args.kwargs["allow_state_patch"], True)
        self.assertIs(
            role_model_turn.call_args.kwargs["current_state_source"],
            current_state_source,
        )
        self.assertIs(
            commit_patch.call_args.kwargs["living_state_patch_store"],
            living_state_patch_store,
        )
        self.assertIs(
            commit_patch.call_args.kwargs["living_state_patch_finalizer"],
            living_state_patch_finalizer,
        )
        commit_reply.assert_called_once()
        projected_result = commit_reply.call_args.args[1]
        self.assertNotIn("state_patch", projected_result["decision"])

    def test_store_without_finalizer_does_not_opt_into_living_state_patch(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = RecordingVisibleConversation()
        adapter = Mock()
        current_state_source = object()
        active_incident_source = object()
        living_state_patch_store = object()
        user_commit_result = {
            "trace_id": "trace-1",
            "event_id": "event-1",
            "event_type": "USER_MESSAGE",
            "status": "user_visible_message_committed",
            "message": {"message_id": "message-1"},
        }
        role_model_result = {
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
            },
        }
        visible_reply_result = {
            "trace_id": "trace-1",
            "event_id": "event-1",
            "event_type": "USER_MESSAGE",
            "status": "visible_reply_committed",
            "output": {"output_id": "output-1"},
        }

        with (
            patch(
                "runtime.user_turn.commit_user_visible_message",
                return_value=user_commit_result,
            ),
            patch(
                "runtime.user_turn.run_role_model_turn",
                return_value=role_model_result,
            ) as role_model_turn,
            patch("runtime.user_turn.commit_living_state_patch") as commit_patch,
            patch(
                "runtime.user_turn.commit_visible_reply",
                return_value=visible_reply_result,
            ),
        ):
            result = run_user_message_turn(
                {
                    "event_id": "event-1",
                    "trace_id": "trace-1",
                    "type": "USER_MESSAGE",
                    "created_at": "2026-05-14T11:30:00+00:00",
                    "payload": {"text": "hello", "conversation_id": "c-1"},
                },
                adapter=adapter,
                raw_event_log=raw_log,
                visible_conversation=visible_conversation,
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
                current_state_source=current_state_source,
                active_incident_source=active_incident_source,
                living_state_patch_store=living_state_patch_store,
            )

        self.assertEqual(result["status"], "user_turn_committed")
        self.assertIs(role_model_turn.call_args.kwargs["allow_state_patch"], False)
        self.assertIs(
            role_model_turn.call_args.kwargs["current_state_source"],
            current_state_source,
        )
        self.assertIs(
            role_model_turn.call_args.kwargs["active_incident_source"],
            active_incident_source,
        )
        self.assertNotIn("living_state_patch_result", result)
        commit_patch.assert_not_called()

    def test_state_patch_rejection_stops_before_visible_reply_commit(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = RecordingVisibleConversation()
        adapter = Mock()
        user_commit_result = {
            "trace_id": "trace-1",
            "event_id": "event-1",
            "event_type": "USER_MESSAGE",
            "status": "user_visible_message_committed",
            "message": {"message_id": "message-1"},
        }
        role_model_result = {
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
                "state_patch": {"living_state": {"mood": "attentive"}},
            },
        }
        rejected_result = {
            "schema_version": "0.1",
            "trace_id": "trace-1",
            "event_id": "event-1",
            "event_type": "USER_MESSAGE",
            "status": "living_state_patch_rejected",
            "failure": {
                "stage": "living_state_patch_store",
                "code": "store_rejected",
                "message": "store rejected",
            },
        }

        with (
            patch(
                "runtime.user_turn.commit_user_visible_message",
                return_value=user_commit_result,
            ),
            patch(
                "runtime.user_turn.run_role_model_turn",
                return_value=role_model_result,
            ),
            patch(
                "runtime.user_turn.commit_living_state_patch",
                return_value=rejected_result,
            ),
            patch("runtime.user_turn.commit_visible_reply") as commit_reply,
        ):
            result = run_user_message_turn(
                {
                    "event_id": "event-1",
                    "trace_id": "trace-1",
                    "type": "USER_MESSAGE",
                    "created_at": "2026-05-14T11:30:00+00:00",
                    "payload": {"text": "hello", "conversation_id": "c-1"},
                },
                adapter=adapter,
                raw_event_log=raw_log,
                visible_conversation=visible_conversation,
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
                current_state_source=object(),
                living_state_patch_store=object(),
                living_state_patch_finalizer=object(),
            )

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(result["stopped_at"], "living_state_patch_commit")
        self.assertEqual(result["failure"]["message"], "store rejected")
        self.assertEqual(result["living_state_patch_result"], rejected_result)
        commit_reply.assert_not_called()

    def test_opts_into_incident_start_when_finalizer_exists(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = RecordingVisibleConversation()
        adapter = Mock()
        life_incident_start_finalizer = object()
        user_commit_result = {
            "trace_id": "trace-1",
            "event_id": "event-1",
            "event_type": "USER_MESSAGE",
            "status": "user_visible_message_committed",
            "message": {"message_id": "message-1"},
        }
        role_model_result = {
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
                    "incident": {
                        "type": "think",
                        "title": "Think",
                        "interrupt_policy": "interruptible",
                        "resume_policy": "resume",
                    },
                },
            },
        }
        incident_result = {
            "schema_version": "0.1",
            "trace_id": "trace-1",
            "event_id": "event-1",
            "event_type": "USER_MESSAGE",
            "status": "life_incident_started",
            "started_incident": {"schema_version": "0.1"},
            "committed_log_entry_id": "log-1",
        }
        visible_reply_result = {
            "trace_id": "trace-1",
            "event_id": "event-1",
            "event_type": "USER_MESSAGE",
            "status": "visible_reply_committed",
            "output": {"output_id": "output-1"},
        }

        with (
            patch(
                "runtime.user_turn.commit_user_visible_message",
                return_value=user_commit_result,
            ),
            patch(
                "runtime.user_turn.run_role_model_turn",
                return_value=role_model_result,
            ) as role_model_turn,
            patch(
                "runtime.user_turn.commit_life_incident_start",
                return_value=incident_result,
            ) as commit_incident,
            patch(
                "runtime.user_turn.commit_visible_reply",
                return_value=visible_reply_result,
            ) as commit_reply,
        ):
            result = run_user_message_turn(
                {
                    "event_id": "event-1",
                    "trace_id": "trace-1",
                    "type": "USER_MESSAGE",
                    "created_at": "2026-05-14T11:30:00+00:00",
                    "payload": {"text": "hello", "conversation_id": "c-1"},
                },
                adapter=adapter,
                raw_event_log=raw_log,
                visible_conversation=visible_conversation,
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
                life_incident_start_finalizer=life_incident_start_finalizer,
            )

        self.assertEqual(result["status"], "user_turn_committed")
        self.assertEqual(result["life_incident_start_result"], incident_result)
        self.assertIs(role_model_turn.call_args.kwargs["allow_incident_start"], True)
        self.assertIs(
            commit_incident.call_args.kwargs["life_incident_start_finalizer"],
            life_incident_start_finalizer,
        )
        commit_reply.assert_called_once()
        projected_result = commit_reply.call_args.args[1]
        self.assertNotIn("life_action", projected_result["decision"])

    def test_incident_start_rejection_stops_before_visible_reply_commit(self):
        raw_log = RecordingRawEventLog()
        visible_conversation = RecordingVisibleConversation()
        adapter = Mock()
        user_commit_result = {
            "trace_id": "trace-1",
            "event_id": "event-1",
            "event_type": "USER_MESSAGE",
            "status": "user_visible_message_committed",
            "message": {"message_id": "message-1"},
        }
        role_model_result = {
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
                    "incident": {
                        "type": "think",
                        "title": "Think",
                        "interrupt_policy": "interruptible",
                        "resume_policy": "resume",
                    },
                },
            },
        }
        rejected_result = {
            "schema_version": "0.1",
            "trace_id": "trace-1",
            "event_id": "event-1",
            "event_type": "USER_MESSAGE",
            "status": "life_incident_start_rejected",
            "failure": {
                "stage": "life_incident_start_finalize",
                "code": "finalize_rejected",
                "message": "finalize rejected",
            },
        }

        with (
            patch(
                "runtime.user_turn.commit_user_visible_message",
                return_value=user_commit_result,
            ),
            patch(
                "runtime.user_turn.run_role_model_turn",
                return_value=role_model_result,
            ),
            patch(
                "runtime.user_turn.commit_life_incident_start",
                return_value=rejected_result,
            ),
            patch("runtime.user_turn.commit_visible_reply") as commit_reply,
        ):
            result = run_user_message_turn(
                {
                    "event_id": "event-1",
                    "trace_id": "trace-1",
                    "type": "USER_MESSAGE",
                    "created_at": "2026-05-14T11:30:00+00:00",
                    "payload": {"text": "hello", "conversation_id": "c-1"},
                },
                adapter=adapter,
                raw_event_log=raw_log,
                visible_conversation=visible_conversation,
                id_generator=SequenceIdGenerator(),
                clock=fixed_clock,
                life_incident_start_finalizer=object(),
            )

        self.assertEqual(result["status"], "user_turn_stopped")
        self.assertEqual(result["stopped_at"], "life_incident_start_commit")
        self.assertEqual(result["failure"]["message"], "finalize rejected")
        self.assertEqual(result["life_incident_start_result"], rejected_result)
        commit_reply.assert_not_called()


if __name__ == "__main__":
    unittest.main()
