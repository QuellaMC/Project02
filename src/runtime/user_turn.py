from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from typing import Any, Protocol

from character.state.current import (
    ActiveIncidentSource,
    CurrentCharacterStateSource,
    InterruptedIncidentSource,
)
from commit_effects.incident_cancel import (
    LIFE_INCIDENT_CANCEL_REJECTED_STATUS,
    LifeIncidentCancelFinalizer,
    commit_life_incident_cancel,
)
from commit_effects.incident_complete import (
    LIFE_INCIDENT_COMPLETE_REJECTED_STATUS,
    LifeIncidentCompleteFinalizer,
    commit_life_incident_complete,
)
from commit_effects.incident_interrupt import (
    LIFE_INCIDENT_INTERRUPT_REJECTED_STATUS,
    LIFE_INCIDENT_INTERRUPTED_STATUS,
    LifeIncidentInterruptFinalizer,
    commit_life_incident_interruption,
)
from commit_effects.incident_start import (
    LIFE_INCIDENT_START_REJECTED_STATUS,
    LifeIncidentStartFinalizer,
    commit_life_incident_start,
)
from commit_effects.living_state import (
    LIVING_STATE_PATCH_REJECTED_STATUS,
    LivingStatePatchFinalizer,
    LivingStatePatchStore,
    commit_living_state_patch,
)
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
USER_TURN_PREFLIGHT_STOP = "user_turn_preflight"
USER_VISIBLE_MESSAGE_COMMIT_STOP = "user_visible_message_commit"
LIVING_STATE_PATCH_COMMIT_STOP = "living_state_patch_commit"
LIFE_INCIDENT_START_COMMIT_STOP = "life_incident_start_commit"
LIFE_INCIDENT_CANCEL_COMMIT_STOP = "life_incident_cancel_commit"
LIFE_INCIDENT_COMPLETE_COMMIT_STOP = "life_incident_complete_commit"
LIFE_INCIDENT_INTERRUPT_COMMIT_STOP = "life_incident_interrupt_commit"
VISIBLE_REPLY_COMMIT_STOP = "visible_reply_commit"
USER_TURN_NEXT_STEP = "user_turn"
CONFLICTING_WRITE_ACTION_OPT_IN_CODE = "conflicting_write_action_opt_in"
MISSING_INCIDENT_CANCEL_SOURCE_CODE = "missing_incident_cancel_source"
MISSING_INCIDENT_COMPLETE_SOURCE_CODE = "missing_incident_complete_source"
MISSING_INCIDENT_INTERRUPT_SOURCE_CODE = "missing_incident_interrupt_source"
MISSING_INTERRUPTED_INCIDENT_SOURCE_CODE = "missing_interrupted_incident_source"
WRITE_ACTION_OPT_IN_CONFLICT_MESSAGE = (
    "Only one write-action opt-in may be enabled for a USER_MESSAGE turn: "
    "state_patch, start_incident, cancel_incident, or complete_incident."
)

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
    active_incident_source: ActiveIncidentSource | None = None,
    interrupted_incident_source: InterruptedIncidentSource | None = None,
    living_state_patch_store: LivingStatePatchStore | None = None,
    living_state_patch_finalizer: LivingStatePatchFinalizer | None = None,
    life_incident_start_finalizer: LifeIncidentStartFinalizer | None = None,
    life_incident_cancel_finalizer: LifeIncidentCancelFinalizer | None = None,
    life_incident_complete_finalizer: LifeIncidentCompleteFinalizer | None = None,
    life_incident_interrupt_finalizer: LifeIncidentInterruptFinalizer | None = None,
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

    allow_state_patch = _state_patch_allowed(
        current_state_source=current_state_source,
        living_state_patch_store=living_state_patch_store,
        living_state_patch_finalizer=living_state_patch_finalizer,
    )
    allow_incident_start = life_incident_start_finalizer is not None
    allow_incident_cancel = life_incident_cancel_finalizer is not None
    allow_incident_complete = life_incident_complete_finalizer is not None
    allow_incident_interrupt = life_incident_interrupt_finalizer is not None
    if (
        sum(
            1
            for enabled in (
                allow_state_patch,
                allow_incident_start,
                allow_incident_cancel,
                allow_incident_complete,
            )
            if enabled
        )
        > 1
    ):
        return _build_stopped_result(
            event,
            route,
            stopped_at=USER_TURN_PREFLIGHT_STOP,
            failure={
                "stage": USER_TURN_PREFLIGHT_STOP,
                "code": CONFLICTING_WRITE_ACTION_OPT_IN_CODE,
                "message": WRITE_ACTION_OPT_IN_CONFLICT_MESSAGE,
            },
        )
    if allow_incident_complete and active_incident_source is None:
        return _build_stopped_result(
            event,
            route,
            stopped_at=USER_TURN_PREFLIGHT_STOP,
            failure={
                "stage": USER_TURN_PREFLIGHT_STOP,
                "code": MISSING_INCIDENT_COMPLETE_SOURCE_CODE,
                "message": "incident complete requires active_incident_source.",
            },
        )
    if allow_incident_cancel and active_incident_source is None:
        return _build_stopped_result(
            event,
            route,
            stopped_at=USER_TURN_PREFLIGHT_STOP,
            failure={
                "stage": USER_TURN_PREFLIGHT_STOP,
                "code": MISSING_INCIDENT_CANCEL_SOURCE_CODE,
                "message": "incident cancel requires active_incident_source.",
            },
        )
    if allow_incident_interrupt and active_incident_source is None:
        return _build_stopped_result(
            event,
            route,
            stopped_at=USER_TURN_PREFLIGHT_STOP,
            failure={
                "stage": USER_TURN_PREFLIGHT_STOP,
                "code": MISSING_INCIDENT_INTERRUPT_SOURCE_CODE,
                "message": "incident interrupt requires active_incident_source.",
            },
        )
    if allow_incident_interrupt and interrupted_incident_source is None:
        return _build_stopped_result(
            event,
            route,
            stopped_at=USER_TURN_PREFLIGHT_STOP,
            failure={
                "stage": USER_TURN_PREFLIGHT_STOP,
                "code": MISSING_INTERRUPTED_INCIDENT_SOURCE_CODE,
                "message": "incident interrupt requires interrupted_incident_source.",
            },
        )

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

    life_incident_interrupt_result: Mapping[str, Any] | None = None
    if allow_incident_interrupt:
        assert active_incident_source is not None
        assert life_incident_interrupt_finalizer is not None
        life_incident_interrupt_result = commit_life_incident_interruption(
            event,
            active_incident_source=active_incident_source,
            life_incident_interrupt_finalizer=life_incident_interrupt_finalizer,
            raw_event_log=raw_event_log,
            id_generator=id_generator,
            clock=clock,
        )
        if life_incident_interrupt_result["status"] == LIFE_INCIDENT_INTERRUPT_REJECTED_STATUS:
            return _build_stopped_result(
                event,
                route,
                stopped_at=LIFE_INCIDENT_INTERRUPT_COMMIT_STOP,
                failure=life_incident_interrupt_result["failure"],
                user_visible_message_result=user_visible_message_result,
                life_incident_interrupt_result=life_incident_interrupt_result,
            )

    interrupted_source_for_context = interrupted_incident_source
    if (
        allow_incident_interrupt
        and life_incident_interrupt_result is not None
        and life_incident_interrupt_result["status"] != LIFE_INCIDENT_INTERRUPTED_STATUS
    ):
        interrupted_source_for_context = None

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
        active_incident_source=active_incident_source,
        interrupted_incident_source=interrupted_source_for_context,
        allow_state_patch=allow_state_patch,
        allow_incident_start=allow_incident_start,
        allow_incident_cancel=allow_incident_cancel,
        allow_incident_complete=allow_incident_complete,
    )

    living_state_patch_result: Mapping[str, Any] | None = None
    if allow_state_patch:
        assert living_state_patch_store is not None
        assert living_state_patch_finalizer is not None
        living_state_patch_result = commit_living_state_patch(
            event,
            role_model_result,
            living_state_patch_store=living_state_patch_store,
            living_state_patch_finalizer=living_state_patch_finalizer,
            raw_event_log=raw_event_log,
            id_generator=id_generator,
            clock=clock,
        )
        if living_state_patch_result["status"] == LIVING_STATE_PATCH_REJECTED_STATUS:
            return _build_stopped_result(
                event,
                route,
                stopped_at=LIVING_STATE_PATCH_COMMIT_STOP,
                failure=living_state_patch_result["failure"],
                user_visible_message_result=user_visible_message_result,
                role_model_result=role_model_result,
                life_incident_interrupt_result=life_incident_interrupt_result,
                living_state_patch_result=living_state_patch_result,
            )

    life_incident_start_result: Mapping[str, Any] | None = None
    life_incident_cancel_result: Mapping[str, Any] | None = None
    life_incident_complete_result: Mapping[str, Any] | None = None
    if allow_incident_start:
        assert life_incident_start_finalizer is not None
        life_incident_start_result = commit_life_incident_start(
            event,
            role_model_result,
            life_incident_start_finalizer=life_incident_start_finalizer,
            raw_event_log=raw_event_log,
            id_generator=id_generator,
            clock=clock,
        )
        if life_incident_start_result["status"] == LIFE_INCIDENT_START_REJECTED_STATUS:
            return _build_stopped_result(
                event,
                route,
                stopped_at=LIFE_INCIDENT_START_COMMIT_STOP,
                failure=life_incident_start_result["failure"],
                user_visible_message_result=user_visible_message_result,
                role_model_result=role_model_result,
                life_incident_interrupt_result=life_incident_interrupt_result,
                living_state_patch_result=living_state_patch_result,
                life_incident_start_result=life_incident_start_result,
            )
    if allow_incident_cancel:
        assert active_incident_source is not None
        assert life_incident_cancel_finalizer is not None
        life_incident_cancel_result = commit_life_incident_cancel(
            event,
            role_model_result,
            active_incident_source=active_incident_source,
            life_incident_cancel_finalizer=life_incident_cancel_finalizer,
            raw_event_log=raw_event_log,
            id_generator=id_generator,
            clock=clock,
        )
        if life_incident_cancel_result["status"] == LIFE_INCIDENT_CANCEL_REJECTED_STATUS:
            return _build_stopped_result(
                event,
                route,
                stopped_at=LIFE_INCIDENT_CANCEL_COMMIT_STOP,
                failure=life_incident_cancel_result["failure"],
                user_visible_message_result=user_visible_message_result,
                role_model_result=role_model_result,
                life_incident_interrupt_result=life_incident_interrupt_result,
                living_state_patch_result=living_state_patch_result,
                life_incident_start_result=life_incident_start_result,
                life_incident_cancel_result=life_incident_cancel_result,
            )
    if allow_incident_complete:
        assert active_incident_source is not None
        assert life_incident_complete_finalizer is not None
        life_incident_complete_result = commit_life_incident_complete(
            event,
            role_model_result,
            active_incident_source=active_incident_source,
            life_incident_complete_finalizer=life_incident_complete_finalizer,
            raw_event_log=raw_event_log,
            id_generator=id_generator,
            clock=clock,
        )
        if life_incident_complete_result["status"] == LIFE_INCIDENT_COMPLETE_REJECTED_STATUS:
            return _build_stopped_result(
                event,
                route,
                stopped_at=LIFE_INCIDENT_COMPLETE_COMMIT_STOP,
                failure=life_incident_complete_result["failure"],
                user_visible_message_result=user_visible_message_result,
                role_model_result=role_model_result,
                life_incident_interrupt_result=life_incident_interrupt_result,
                living_state_patch_result=living_state_patch_result,
                life_incident_start_result=life_incident_start_result,
                life_incident_cancel_result=life_incident_cancel_result,
                life_incident_complete_result=life_incident_complete_result,
            )

    visible_reply_role_model_result = _project_visible_reply_role_model_result(role_model_result)
    visible_reply_result = commit_visible_reply(
        event,
        visible_reply_role_model_result,
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
            life_incident_interrupt_result=life_incident_interrupt_result,
            living_state_patch_result=living_state_patch_result,
            life_incident_start_result=life_incident_start_result,
            life_incident_cancel_result=life_incident_cancel_result,
            life_incident_complete_result=life_incident_complete_result,
            visible_reply_result=visible_reply_result,
        )

    result: UserMessageTurnResult = {
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
    if living_state_patch_result is not None:
        result["living_state_patch_result"] = deepcopy(dict(living_state_patch_result))
    if life_incident_interrupt_result is not None:
        result["life_incident_interrupt_result"] = deepcopy(dict(life_incident_interrupt_result))
    if life_incident_start_result is not None:
        result["life_incident_start_result"] = deepcopy(dict(life_incident_start_result))
    if life_incident_cancel_result is not None:
        result["life_incident_cancel_result"] = deepcopy(dict(life_incident_cancel_result))
    if life_incident_complete_result is not None:
        result["life_incident_complete_result"] = deepcopy(dict(life_incident_complete_result))
    return result


def _require_user_turn_route(route: Mapping[str, Any]) -> None:
    if (
        route.get("event_type") != USER_MESSAGE
        or route.get("model_needed") is not True
        or route.get("next_step") != USER_TURN_NEXT_STEP
    ):
        raise RuntimeValidationError(
            "USER_MESSAGE route must require model work with next_step 'user_turn'."
        )


def _state_patch_allowed(
    *,
    current_state_source: CurrentCharacterStateSource | None,
    living_state_patch_store: LivingStatePatchStore | None,
    living_state_patch_finalizer: LivingStatePatchFinalizer | None,
) -> bool:
    return (
        current_state_source is not None
        and living_state_patch_store is not None
        and living_state_patch_finalizer is not None
    )


def _build_stopped_result(
    event: Mapping[str, Any],
    route: Mapping[str, Any],
    *,
    stopped_at: str,
    failure: Mapping[str, Any],
    user_visible_message_result: Mapping[str, Any] | None = None,
    role_model_result: Mapping[str, Any] | None = None,
    life_incident_interrupt_result: Mapping[str, Any] | None = None,
    living_state_patch_result: Mapping[str, Any] | None = None,
    life_incident_start_result: Mapping[str, Any] | None = None,
    life_incident_cancel_result: Mapping[str, Any] | None = None,
    life_incident_complete_result: Mapping[str, Any] | None = None,
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
    if life_incident_interrupt_result is not None:
        result["life_incident_interrupt_result"] = deepcopy(dict(life_incident_interrupt_result))
    if living_state_patch_result is not None:
        result["living_state_patch_result"] = deepcopy(dict(living_state_patch_result))
    if life_incident_start_result is not None:
        result["life_incident_start_result"] = deepcopy(dict(life_incident_start_result))
    if life_incident_cancel_result is not None:
        result["life_incident_cancel_result"] = deepcopy(dict(life_incident_cancel_result))
    if life_incident_complete_result is not None:
        result["life_incident_complete_result"] = deepcopy(dict(life_incident_complete_result))
    if visible_reply_result is not None:
        result["visible_reply_result"] = deepcopy(dict(visible_reply_result))
    return result


def _project_visible_reply_role_model_result(
    role_model_result: Mapping[str, Any],
) -> dict[str, Any]:
    result = deepcopy(dict(role_model_result))
    decision = result.get("decision")
    if not isinstance(decision, Mapping):
        result["decision"] = decision
        return result
    result["decision"] = {
        "schema_version": decision.get("schema_version"),
        "trace_id": decision.get("trace_id"),
        "event_id": decision.get("event_id"),
        "action": decision.get("action"),
        "visible_reply": deepcopy(decision.get("visible_reply")),
    }
    return result
