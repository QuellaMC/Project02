from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from typing import Any, Protocol

from character.state.current import CurrentCharacterStateSource
from commit_effects.visible_reply import (
    USER_VISIBLE_MESSAGE_COMMITTED_STATUS,
    VISIBLE_REPLY_COMMITTED_STATUS,
    commit_user_visible_message,
    commit_visible_reply,
)
from role_model.loop import (
    RoleModelAdapter,
    VisibleConversationRecentMessagesSource,
    VisibleConversationRecordSource,
    run_role_model_turn,
)
from runtime.contracts import USER_MESSAGE
from runtime.kernel import RawEventLog, RuntimeValidationError, intake_runtime_event
from runtime.logging import SCHEMA_VERSION, Clock, IdGenerator

USER_TURN_COMMITTED_STATUS = "user_turn_committed"
USER_TURN_STOPPED_STATUS = "user_turn_stopped"
USER_VISIBLE_MESSAGE_COMMIT_STOP = "user_visible_message_commit"
VISIBLE_REPLY_COMMIT_STOP = "visible_reply_commit"
USER_TURN_NEXT_STEP = "user_turn"

UserMessageTurnResult = dict[str, Any]


class VisibleConversationBoundary(VisibleConversationRecordSource, Protocol):
    def append(self, output: dict[str, Any]) -> None: ...


def run_user_message_turn(
    event_input: Mapping[str, Any],
    *,
    adapter: RoleModelAdapter,
    raw_event_log: RawEventLog,
    visible_conversation: VisibleConversationBoundary,
    id_generator: IdGenerator,
    clock: Clock,
    current_state_source: CurrentCharacterStateSource | None = None,
) -> UserMessageTurnResult:
    intake_result = intake_runtime_event(
        event_input,
        raw_event_log=raw_event_log,
        id_generator=id_generator,
        clock=clock,
    )
    event = intake_result["event"]
    route = intake_result["route"]
    _require_user_turn_route(route)

    user_visible_message_result = commit_user_visible_message(
        event,
        visible_conversation_log=visible_conversation,
        raw_event_log=raw_event_log,
        id_generator=id_generator,
        clock=clock,
    )
    if user_visible_message_result["status"] != USER_VISIBLE_MESSAGE_COMMITTED_STATUS:
        return _build_stopped_result(
            event,
            route,
            stopped_at=USER_VISIBLE_MESSAGE_COMMIT_STOP,
            failure=user_visible_message_result["failure"],
            user_visible_message_result=user_visible_message_result,
        )

    role_model_result = run_role_model_turn(
        event,
        adapter=adapter,
        raw_event_log=raw_event_log,
        id_generator=id_generator,
        clock=clock,
        recent_visible_messages_source=VisibleConversationRecentMessagesSource(
            visible_conversation
        ),
        current_state_source=current_state_source,
    )

    visible_reply_result = commit_visible_reply(
        event,
        role_model_result,
        visible_conversation_log=visible_conversation,
        raw_event_log=raw_event_log,
        id_generator=id_generator,
        clock=clock,
    )
    if visible_reply_result["status"] != VISIBLE_REPLY_COMMITTED_STATUS:
        return _build_stopped_result(
            event,
            route,
            stopped_at=VISIBLE_REPLY_COMMIT_STOP,
            failure=visible_reply_result["failure"],
            user_visible_message_result=user_visible_message_result,
            role_model_result=role_model_result,
            visible_reply_result=visible_reply_result,
        )

    return {
        "schema_version": SCHEMA_VERSION,
        "trace_id": event["trace_id"],
        "event_id": event["event_id"],
        "event_type": USER_MESSAGE,
        "status": USER_TURN_COMMITTED_STATUS,
        "kernel_route": deepcopy(route),
        "user_visible_message_result": deepcopy(user_visible_message_result),
        "role_model_result": deepcopy(role_model_result),
        "visible_reply_result": deepcopy(visible_reply_result),
        "visible_record_ids": {
            "user_message_id": user_visible_message_result["message"]["message_id"],
            "assistant_output_id": visible_reply_result["output"]["output_id"],
        },
    }


def _require_user_turn_route(route: Mapping[str, Any]) -> None:
    if (
        route.get("event_type") != USER_MESSAGE
        or route.get("model_needed") is not True
        or route.get("next_step") != USER_TURN_NEXT_STEP
    ):
        raise RuntimeValidationError(
            "USER_MESSAGE route must require model work with next_step 'user_turn'."
        )


def _build_stopped_result(
    event: Mapping[str, Any],
    route: Mapping[str, Any],
    *,
    stopped_at: str,
    failure: Mapping[str, Any],
    user_visible_message_result: Mapping[str, Any] | None = None,
    role_model_result: Mapping[str, Any] | None = None,
    visible_reply_result: Mapping[str, Any] | None = None,
) -> UserMessageTurnResult:
    result: UserMessageTurnResult = {
        "schema_version": SCHEMA_VERSION,
        "trace_id": event["trace_id"],
        "event_id": event["event_id"],
        "event_type": USER_MESSAGE,
        "status": USER_TURN_STOPPED_STATUS,
        "stopped_at": stopped_at,
        "kernel_route": deepcopy(dict(route)),
        "failure": deepcopy(dict(failure)),
    }
    if user_visible_message_result is not None:
        result["user_visible_message_result"] = deepcopy(dict(user_visible_message_result))
    if role_model_result is not None:
        result["role_model_result"] = deepcopy(dict(role_model_result))
    if visible_reply_result is not None:
        result["visible_reply_result"] = deepcopy(dict(visible_reply_result))
    return result
