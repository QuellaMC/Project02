from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from copy import deepcopy
from typing import Any, Protocol

from character.state import context as character_context
from character.state.current import (
    ActiveIncidentSource,
    CurrentCharacterStateSource,
    validate_active_incident_brief_for_event,
    validate_living_state_brief_for_event,
)
from runtime.contracts import (
    ACTIVE_INCIDENT_INTERRUPT_POLICIES,
    ACTIVE_INCIDENT_RESUME_POLICIES,
    ACTIVE_INCIDENT_TYPES,
    CANCEL_INCIDENT_ACTION,
    DECISION_READY_FOR_COMMIT_STATUS,
    LIFE_ACTION,
    START_INCIDENT_ACTION,
    STATE_PATCH_ACTION,
    USER_MESSAGE,
    VISIBLE_REPLY_ACTION,
    ContractValidationError,
    RuntimeEvent,
    normalize_visible_reply_decision_with_optional_living_state_patch,
    reject_extra_keys,
    require_equal,
    require_optional_string,
    require_string,
    validate_normalized_user_message_event,
)
from runtime.kernel import RawEventLog
from runtime.logging import (
    SCHEMA_VERSION,
    Clock,
    IdGenerator,
    RawEventLogEntry,
    build_raw_log_entry,
)

USER_MESSAGE_VISIBLE_REPLY_CALL = character_context.USER_MESSAGE_VISIBLE_REPLY_CALL
RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES = character_context.RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES
RECENT_VISIBLE_MESSAGES_MAX_MESSAGES = character_context.RECENT_VISIBLE_MESSAGES_MAX_MESSAGES
RECENT_VISIBLE_MESSAGES_MAX_TEXT_TOKENS = character_context.RECENT_VISIBLE_MESSAGES_MAX_TEXT_TOKENS
ROLE_MODEL_TURN_COMPLETED_KIND = "role_model_turn_completed"
ROLE_MODEL_TURN_FAILED_KIND = "role_model_turn_failed"
FAILURE_CODES_BY_STAGE = {
    "context_build": {"malformed_context"},
    "adapter_call": {"adapter_exception"},
    "parse_output": {"malformed_model_output"},
}


def _format_allowed_contract_values(values: set[str]) -> str:
    return ", ".join(f"'{value}'" for value in sorted(values))


INCIDENT_TYPE_CONTRACT_VALUES = _format_allowed_contract_values(ACTIVE_INCIDENT_TYPES)
INCIDENT_INTERRUPT_POLICY_CONTRACT_VALUES = _format_allowed_contract_values(
    ACTIVE_INCIDENT_INTERRUPT_POLICIES
)
INCIDENT_RESUME_POLICY_CONTRACT_VALUES = _format_allowed_contract_values(
    ACTIVE_INCIDENT_RESUME_POLICIES
)

ROLE_MODEL_INSTRUCTIONS = (
    "Return one JSON object only. The object must contain schema_version='0.1', "
    "action='visible_reply', and visible_reply.text as a non-empty string. "
    "Do not include extra fields."
)
STATE_PATCH_ROLE_MODEL_INSTRUCTIONS = (
    "Return one JSON object only. The object must contain schema_version='0.1', "
    "action='visible_reply', and visible_reply.text as a non-empty string. "
    "It may also include optional state_patch.living_state with only "
    "current_activity, mood, and toward_user as non-empty strings. "
    "Do not include extra fields."
)
INCIDENT_START_ROLE_MODEL_INSTRUCTIONS = (
    "Return one JSON object only. The object must contain schema_version='0.1', "
    "action='visible_reply', and visible_reply.text as a non-empty string. "
    "It may also include optional life_action with type='start_incident' and "
    "incident containing only type, title, optional remaining_seconds, "
    "interrupt_policy, and resume_policy. incident.type must be one of: "
    f"{INCIDENT_TYPE_CONTRACT_VALUES}. interrupt_policy must be one of: "
    f"{INCIDENT_INTERRUPT_POLICY_CONTRACT_VALUES}. resume_policy must be one "
    f"of: {INCIDENT_RESUME_POLICY_CONTRACT_VALUES}. Do not include committed "
    "incident fields or extra fields."
)
INCIDENT_CANCEL_ROLE_MODEL_INSTRUCTIONS = (
    "Return one JSON object only. The object must contain schema_version='0.1', "
    "action='visible_reply', and visible_reply.text as a non-empty string. "
    "It may also include optional life_action with type='cancel_incident', "
    "incident_id as the current active incident ID, and reason as a non-empty "
    "model-provided explanation. Do not include start_incident, cancelled "
    "incident fields, state_patch, or extra fields."
)

DecisionContext = character_context.DecisionContext
RecentVisibleMessage = character_context.RecentVisibleMessage
RecentVisibleMessagesRequest = character_context.RecentVisibleMessagesRequest
RecentVisibleMessagesSource = character_context.RecentVisibleMessagesSource
VisibleConversationRecord = character_context.VisibleConversationRecord
VisibleConversationRecordSource = character_context.VisibleConversationRecordSource
VisibleConversationRecordsRequest = character_context.VisibleConversationRecordsRequest
_CharacterVisibleConversationRecentMessagesSource = (
    character_context.VisibleConversationRecentMessagesSource
)
RoleModelInput = dict[str, Any]
RoleModelInputEnvelope = RoleModelInput
RoleModelAdapterOutput = dict[str, Any]
CharacterDecision = dict[str, Any]
RoleModelTurnResult = dict[str, Any]
build_character_decision_context = character_context.build_character_decision_context


class RoleModelValidationError(ValueError):
    """Raised when role-model input or output violates the active schema contract."""


class RoleModelAdapter(Protocol):
    def generate(self, model_input: RoleModelInput) -> RoleModelAdapterOutput: ...


class VisibleConversationRecentMessagesSource(_CharacterVisibleConversationRecentMessagesSource):
    def read_recent_visible_messages(
        self,
        request: RecentVisibleMessagesRequest,
    ) -> list[RecentVisibleMessage]:
        return _wrap_contract_error(super().read_recent_visible_messages, request)


def build_decision_context(
    event: RuntimeEvent,
    *,
    recent_visible_messages_source: RecentVisibleMessagesSource | None = None,
    current_state_source: CurrentCharacterStateSource | None = None,
    active_incident_source: ActiveIncidentSource | None = None,
    allow_state_patch: bool = False,
    allow_incident_start: bool = False,
    allow_incident_cancel: bool = False,
) -> DecisionContext:
    _require_supported_write_action_opt_in(
        allow_state_patch=allow_state_patch,
        allow_incident_start=allow_incident_start,
        allow_incident_cancel=allow_incident_cancel,
    )
    if allow_state_patch and current_state_source is None:
        raise RoleModelValidationError("allow_state_patch requires current_state_source.")
    if allow_incident_cancel and active_incident_source is None:
        raise RoleModelValidationError("allow_incident_cancel requires active_incident_source.")
    decision_context = _wrap_contract_error(
        lambda: build_character_decision_context(
            event,
            recent_visible_messages_source=recent_visible_messages_source,
            current_state_source=current_state_source,
            active_incident_source=active_incident_source,
        )
    )
    return decision_context


def build_role_model_input_envelope(
    event: RuntimeEvent,
    decision_context: DecisionContext,
    *,
    allow_state_patch: bool = False,
    allow_incident_start: bool = False,
    allow_incident_cancel: bool = False,
) -> RoleModelInputEnvelope:
    normalized_event = _wrap_contract_error(
        lambda: validate_normalized_user_message_event(event, source_name="event")
    )
    allowed_actions = _allowed_actions_for_call(
        allow_state_patch=allow_state_patch,
        allow_incident_start=allow_incident_start,
        allow_incident_cancel=allow_incident_cancel,
    )
    allowed_life_action_type = _allowed_life_action_type_for_call(
        allow_incident_start=allow_incident_start,
        allow_incident_cancel=allow_incident_cancel,
    )
    event_context = _build_user_message_event_context(normalized_event)
    validated_context = _validate_decision_context(
        decision_context,
        event_context=event_context,
        allowed_actions=allowed_actions,
    )
    _wrap_contract_error(
        lambda: require_equal(
            normalized_event["trace_id"],
            validated_context["trace_id"],
            "trace_id",
        )
    )
    _wrap_contract_error(
        lambda: require_equal(
            normalized_event["event_id"],
            validated_context["event_id"],
            "event_id",
        )
    )

    return {
        "schema_version": SCHEMA_VERSION,
        "trace_id": validated_context["trace_id"],
        "event_id": validated_context["event_id"],
        "call_type": USER_MESSAGE_VISIBLE_REPLY_CALL,
        "event": event_context,
        "allowed_actions": allowed_actions,
        **(
            {"allowed_life_action_type": allowed_life_action_type}
            if allowed_life_action_type is not None
            else {}
        ),
        "instructions": _instructions_for_allowed_actions(
            allowed_actions,
            allowed_life_action_type=allowed_life_action_type,
        ),
        "decision_context": validated_context,
    }


def render_role_model_input(
    event: RuntimeEvent,
    decision_context: DecisionContext,
    *,
    allow_state_patch: bool = False,
    allow_incident_start: bool = False,
    allow_incident_cancel: bool = False,
) -> RoleModelInput:
    return build_role_model_input_envelope(
        event,
        decision_context,
        allow_state_patch=allow_state_patch,
        allow_incident_start=allow_incident_start,
        allow_incident_cancel=allow_incident_cancel,
    )


def parse_character_decision(
    role_model_input: RoleModelInput,
    model_output: RoleModelAdapterOutput,
) -> CharacterDecision:
    validated_model_input = _validate_role_model_input(role_model_input)
    raw_text = _validate_adapter_output(model_output)["raw_text"]
    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError as error:
        raise RoleModelValidationError("raw_text must contain a JSON object.") from error

    if not isinstance(parsed, Mapping):
        raise RoleModelValidationError("raw_text must contain a JSON object.")

    return _wrap_contract_error(
        lambda: normalize_visible_reply_decision_with_optional_living_state_patch(
            parsed,
            trace_id=validated_model_input["trace_id"],
            event_id=validated_model_input["event_id"],
            require_attached_ids=False,
            allow_state_patch=_state_patch_allowed(validated_model_input["allowed_actions"]),
            allow_life_action=_life_action_allowed(validated_model_input["allowed_actions"]),
            allowed_life_action_type=_allowed_life_action_type(validated_model_input),
            source_name="model output",
        )
    )


def run_role_model_turn(
    event: RuntimeEvent,
    *,
    adapter: RoleModelAdapter,
    raw_event_log: RawEventLog,
    id_generator: IdGenerator,
    clock: Clock,
    recent_visible_messages_source: RecentVisibleMessagesSource | None = None,
    current_state_source: CurrentCharacterStateSource | None = None,
    active_incident_source: ActiveIncidentSource | None = None,
    allow_state_patch: bool = False,
    allow_incident_start: bool = False,
    allow_incident_cancel: bool = False,
) -> RoleModelTurnResult:
    try:
        decision_context = build_decision_context(
            event,
            recent_visible_messages_source=recent_visible_messages_source,
            current_state_source=current_state_source,
            active_incident_source=active_incident_source,
            allow_state_patch=allow_state_patch,
            allow_incident_start=allow_incident_start,
            allow_incident_cancel=allow_incident_cancel,
        )
        model_input = render_role_model_input(
            event,
            decision_context,
            allow_state_patch=allow_state_patch,
            allow_incident_start=allow_incident_start,
            allow_incident_cancel=allow_incident_cancel,
        )
    except RoleModelValidationError as error:
        raw_event_log.append(
            build_role_model_context_failed_log_entry(
                event,
                stage="context_build",
                code="malformed_context",
                message=str(error),
                id_generator=id_generator,
                clock=clock,
            )
        )
        raise

    try:
        model_output = adapter.generate(deepcopy(model_input))
    except Exception as error:
        raw_event_log.append(
            build_role_model_turn_failed_log_entry(
                model_input,
                stage="adapter_call",
                code="adapter_exception",
                message=str(error),
                id_generator=id_generator,
                clock=clock,
            )
        )
        raise

    try:
        decision = parse_character_decision(model_input, model_output)
    except RoleModelValidationError as error:
        raw_event_log.append(
            build_role_model_turn_failed_log_entry(
                model_input,
                model_output=model_output,
                stage="parse_output",
                code="malformed_model_output",
                message=str(error),
                id_generator=id_generator,
                clock=clock,
            )
        )
        raise

    raw_event_log.append(
        build_role_model_turn_completed_log_entry(
            model_input,
            model_output,
            decision,
            id_generator=id_generator,
            clock=clock,
        )
    )
    return {
        "trace_id": event["trace_id"],
        "event_id": event["event_id"],
        "event_type": model_input["event"]["type"],
        "model_called": True,
        "status": DECISION_READY_FOR_COMMIT_STATUS,
        "decision": decision,
    }


def build_role_model_context_failed_log_entry(
    event: RuntimeEvent,
    *,
    stage: str,
    code: str,
    message: str,
    id_generator: IdGenerator,
    clock: Clock,
) -> RawEventLogEntry:
    normalized_event = _wrap_contract_error(
        lambda: validate_normalized_user_message_event(event, source_name="event")
    )
    validated_failure = _validate_failure(stage=stage, code=code, message=message)

    return build_raw_log_entry(
        trace_id=normalized_event["trace_id"],
        event_id=normalized_event["event_id"],
        kind=ROLE_MODEL_TURN_FAILED_KIND,
        data={
            "event": normalized_event,
            "failure": validated_failure,
        },
        id_generator=id_generator,
        clock=clock,
    )


def build_role_model_turn_completed_log_entry(
    model_input: RoleModelInput,
    model_output: RoleModelAdapterOutput,
    decision: CharacterDecision,
    *,
    id_generator: IdGenerator,
    clock: Clock,
) -> RawEventLogEntry:
    validated_model_input = _validate_role_model_input(model_input)
    validated_model_output = _validate_adapter_output(model_output)
    validated_decision = _validate_character_decision(
        decision,
        model_input=validated_model_input,
    )

    return build_raw_log_entry(
        trace_id=validated_model_input["trace_id"],
        event_id=validated_model_input["event_id"],
        kind=ROLE_MODEL_TURN_COMPLETED_KIND,
        data={
            "model_input": validated_model_input,
            "model_output": validated_model_output,
            "decision": validated_decision,
        },
        id_generator=id_generator,
        clock=clock,
    )


def build_role_model_turn_failed_log_entry(
    model_input: RoleModelInput,
    *,
    stage: str,
    code: str,
    message: str,
    id_generator: IdGenerator,
    clock: Clock,
    model_output: RoleModelAdapterOutput | None = None,
) -> RawEventLogEntry:
    validated_model_input = _validate_role_model_input(model_input)
    validated_failure = _validate_failure(stage=stage, code=code, message=message)
    data: dict[str, Any] = {
        "model_input": validated_model_input,
        "failure": validated_failure,
    }
    if model_output is not None:
        try:
            data["model_output"] = _validate_adapter_output(model_output)
        except RoleModelValidationError:
            data["raw_model_output_snapshot"] = _snapshot_failure_model_output(model_output)

    return build_raw_log_entry(
        trace_id=validated_model_input["trace_id"],
        event_id=validated_model_input["event_id"],
        kind=ROLE_MODEL_TURN_FAILED_KIND,
        data=data,
        id_generator=id_generator,
        clock=clock,
    )


def _validate_adapter_output(model_output: RoleModelAdapterOutput) -> RoleModelAdapterOutput:
    if not isinstance(model_output, Mapping):
        raise RoleModelValidationError("RoleModelAdapterOutput must be a mapping.")
    return {
        "model_id": _wrap_contract_error(
            lambda: require_string(model_output.get("model_id"), "model_id")
        ),
        "created_at": _wrap_contract_error(
            lambda: require_string(model_output.get("created_at"), "created_at")
        ),
        "raw_text": _wrap_contract_error(
            lambda: require_string(model_output.get("raw_text"), "raw_text")
        ),
    }


def _read_recent_visible_messages(
    event: RuntimeEvent,
    *,
    recent_visible_messages_source: RecentVisibleMessagesSource | None,
) -> list[RecentVisibleMessage]:
    return _wrap_contract_error(
        lambda: character_context._read_recent_visible_messages(
            event,
            recent_visible_messages_source=recent_visible_messages_source,
        )
    )


def _build_recent_visible_messages_request(
    event: RuntimeEvent,
    *,
    conversation_id: str,
) -> RecentVisibleMessagesRequest:
    return _wrap_contract_error(
        lambda: character_context._build_recent_visible_messages_request(
            event,
            conversation_id=conversation_id,
        )
    )


def _validate_recent_visible_messages_request(request: Any) -> RecentVisibleMessagesRequest:
    return _wrap_contract_error(
        lambda: character_context._validate_recent_visible_messages_request(request)
    )


def _validate_recent_visible_message(
    message: Any,
    *,
    conversation_id: str,
) -> RecentVisibleMessage:
    return _wrap_contract_error(
        lambda: character_context._validate_recent_visible_message(
            message,
            conversation_id=conversation_id,
        )
    )


def _is_current_event_message(message: RecentVisibleMessage, *, event_id: str) -> bool:
    return character_context._is_current_event_message(message, event_id=event_id)


def _parse_recent_message_timestamp_before_event(
    message: RecentVisibleMessage,
    *,
    event_created_at: Any,
) -> Any:
    return _wrap_contract_error(
        lambda: character_context._parse_recent_message_timestamp_before_event(
            message,
            event_created_at=event_created_at,
        )
    )


def _reject_duplicate_recent_message_identity(
    message: RecentVisibleMessage,
    *,
    seen_message_ids: set[str],
    seen_source_event_roles: set[tuple[str, str]],
) -> None:
    return _wrap_contract_error(
        lambda: character_context._reject_duplicate_recent_message_identity(
            message,
            seen_message_ids=seen_message_ids,
            seen_source_event_roles=seen_source_event_roles,
        )
    )


def _select_recent_visible_messages(
    messages: list[tuple[Any, RecentVisibleMessage]],
) -> list[RecentVisibleMessage]:
    return _wrap_contract_error(lambda: character_context._select_recent_visible_messages(messages))


def approximate_text_tokens(text: str) -> int:
    return character_context.approximate_text_tokens(text)


def _validate_timestamp(value: Any, field_name: str) -> str:
    return _wrap_contract_error(lambda: character_context._validate_timestamp(value, field_name))


def _parse_sortable_timestamp(value: str) -> Any:
    return character_context._parse_sortable_timestamp(value)


def _snapshot_failure_model_output(model_output: Any) -> Any:
    if isinstance(model_output, Mapping):
        return deepcopy(dict(model_output))
    return {"raw_value": repr(model_output)}


def _validate_role_model_input(model_input: RoleModelInput) -> RoleModelInput:
    if not isinstance(model_input, Mapping):
        raise RoleModelValidationError("RoleModelInput must be a mapping.")
    _wrap_contract_error(
        lambda: reject_extra_keys(
            model_input,
            {
                "schema_version",
                "trace_id",
                "event_id",
                "call_type",
                "event",
                "allowed_actions",
                "allowed_life_action_type",
                "instructions",
                "decision_context",
            },
            "RoleModelInput",
        )
    )
    _wrap_contract_error(
        lambda: require_equal(model_input.get("schema_version"), SCHEMA_VERSION, "schema_version")
    )
    _wrap_contract_error(
        lambda: require_equal(
            model_input.get("call_type"),
            USER_MESSAGE_VISIBLE_REPLY_CALL,
            "call_type",
        )
    )
    event_context = _validate_event_context(model_input.get("event"))
    allowed_actions = _validate_allowed_actions(model_input.get("allowed_actions"))
    decision_context = _validate_decision_context(
        model_input.get("decision_context"),
        event_context=event_context,
        allowed_actions=allowed_actions,
    )
    allowed_life_action_type = _validate_allowed_life_action_type(
        model_input.get("allowed_life_action_type"),
        allowed_actions,
    )
    instructions = _wrap_contract_error(
        lambda: _validate_instructions_for_allowed_actions(
            model_input.get("instructions"),
            allowed_actions,
            allowed_life_action_type=allowed_life_action_type,
        )
    )

    trace_id = _wrap_contract_error(lambda: require_string(model_input.get("trace_id"), "trace_id"))
    event_id = _wrap_contract_error(lambda: require_string(model_input.get("event_id"), "event_id"))
    _wrap_contract_error(lambda: require_equal(trace_id, decision_context["trace_id"], "trace_id"))
    _wrap_contract_error(lambda: require_equal(event_id, decision_context["event_id"], "event_id"))

    return {
        "schema_version": SCHEMA_VERSION,
        "trace_id": trace_id,
        "event_id": event_id,
        "call_type": USER_MESSAGE_VISIBLE_REPLY_CALL,
        "event": event_context,
        "allowed_actions": allowed_actions,
        **(
            {"allowed_life_action_type": allowed_life_action_type}
            if allowed_life_action_type is not None
            else {}
        ),
        "instructions": instructions,
        "decision_context": decision_context,
    }


def _validate_decision_context(
    decision_context: Any,
    *,
    event_context: Mapping[str, Any],
    allowed_actions: list[str],
) -> DecisionContext:
    if not isinstance(decision_context, Mapping):
        raise RoleModelValidationError("DecisionContext must be a mapping.")
    _wrap_contract_error(
        lambda: reject_extra_keys(
            decision_context,
            {
                "schema_version",
                "trace_id",
                "event_id",
                "character_snapshot",
            },
            "DecisionContext",
        )
    )
    _wrap_contract_error(
        lambda: require_equal(
            decision_context.get("schema_version"),
            SCHEMA_VERSION,
            "schema_version",
        )
    )
    trace_id = _wrap_contract_error(
        lambda: require_string(decision_context.get("trace_id"), "trace_id")
    )
    event_id = _wrap_contract_error(
        lambda: require_string(decision_context.get("event_id"), "event_id")
    )
    character_snapshot = _validate_character_snapshot(
        decision_context.get("character_snapshot"),
        conversation_id=event_context.get("conversation_id"),
        event_created_at=event_context["created_at"],
        event_id=event_id,
    )
    if _state_patch_allowed(allowed_actions) and "living_state_brief" not in character_snapshot:
        raise RoleModelValidationError(
            "allowed state_patch requires character_snapshot.living_state_brief."
        )

    return {
        "schema_version": SCHEMA_VERSION,
        "trace_id": trace_id,
        "event_id": event_id,
        "character_snapshot": character_snapshot,
    }


def _validate_character_snapshot(
    character_snapshot: Any,
    *,
    conversation_id: str | None,
    event_created_at: str,
    event_id: str,
) -> dict[str, Any]:
    if not isinstance(character_snapshot, Mapping):
        raise RoleModelValidationError("character_snapshot must be a mapping.")
    _wrap_contract_error(
        lambda: reject_extra_keys(
            character_snapshot,
            {"recent_visible_messages", "living_state_brief", "active_incident"},
            "DecisionContext.character_snapshot",
        )
    )
    normalized_snapshot: dict[str, Any] = {}
    if "living_state_brief" in character_snapshot:
        normalized_snapshot["living_state_brief"] = _wrap_contract_error(
            lambda: validate_living_state_brief_for_event(
                character_snapshot["living_state_brief"],
                event_id=event_id,
            )
        )
    if "active_incident" in character_snapshot:
        normalized_snapshot["active_incident"] = _wrap_contract_error(
            lambda: validate_active_incident_brief_for_event(
                character_snapshot["active_incident"],
                event_id=event_id,
            )
        )

    recent_visible_messages = character_snapshot.get("recent_visible_messages")
    if not isinstance(recent_visible_messages, list):
        raise RoleModelValidationError("recent_visible_messages must be a list.")
    if not conversation_id:
        if recent_visible_messages:
            raise RoleModelValidationError(
                "recent_visible_messages require a non-empty event.conversation_id."
            )
        return {"recent_visible_messages": [], **normalized_snapshot}

    event_timestamp = _parse_sortable_timestamp(event_created_at)
    normalized_messages: list[tuple[Any, RecentVisibleMessage]] = []
    seen_message_ids: set[str] = set()
    seen_source_event_roles: set[tuple[str, str]] = set()
    for message in recent_visible_messages:
        normalized_message = _validate_recent_visible_message(
            message,
            conversation_id=conversation_id,
        )
        if _is_current_event_message(normalized_message, event_id=event_id):
            raise RoleModelValidationError("recent_visible_messages must exclude current event.")
        _reject_duplicate_recent_message_identity(
            normalized_message,
            seen_message_ids=seen_message_ids,
            seen_source_event_roles=seen_source_event_roles,
        )
        message_created_at = _parse_recent_message_timestamp_before_event(
            normalized_message,
            event_created_at=event_timestamp,
        )
        normalized_messages.append(
            (
                message_created_at,
                normalized_message,
            )
        )
    selected_messages = _select_recent_visible_messages(normalized_messages)
    if len(selected_messages) != len(recent_visible_messages):
        raise RoleModelValidationError("recent_visible_messages must fit the active budget.")
    return {"recent_visible_messages": selected_messages, **normalized_snapshot}


def _validate_character_decision(
    decision: CharacterDecision,
    *,
    model_input: RoleModelInput,
) -> CharacterDecision:
    return _wrap_contract_error(
        lambda: normalize_visible_reply_decision_with_optional_living_state_patch(
            decision,
            trace_id=model_input["trace_id"],
            event_id=model_input["event_id"],
            require_attached_ids=True,
            allow_state_patch=_state_patch_allowed(model_input["allowed_actions"]),
            allow_life_action=_life_action_allowed(model_input["allowed_actions"]),
            allowed_life_action_type=_allowed_life_action_type(model_input),
            source_name="CharacterDecision",
        )
    )


def _allowed_actions_for_call(
    *,
    allow_state_patch: bool,
    allow_incident_start: bool,
    allow_incident_cancel: bool,
) -> list[str]:
    _require_supported_write_action_opt_in(
        allow_state_patch=allow_state_patch,
        allow_incident_start=allow_incident_start,
        allow_incident_cancel=allow_incident_cancel,
    )
    allowed_actions = [VISIBLE_REPLY_ACTION]
    if allow_state_patch:
        allowed_actions.append(STATE_PATCH_ACTION)
    if allow_incident_start or allow_incident_cancel:
        allowed_actions.append(LIFE_ACTION)
    return allowed_actions


def _require_supported_write_action_opt_in(
    *,
    allow_state_patch: bool,
    allow_incident_start: bool,
    allow_incident_cancel: bool,
) -> None:
    enabled_count = sum(
        1 for enabled in (allow_state_patch, allow_incident_start, allow_incident_cancel) if enabled
    )
    if enabled_count > 1:
        raise RoleModelValidationError(
            "Only one write-action opt-in may be enabled for a USER_MESSAGE turn: "
            "state_patch, start_incident, or cancel_incident."
        )


def _build_user_message_event_context(event: RuntimeEvent) -> dict[str, Any]:
    payload = event["payload"]
    event_context: dict[str, Any] = {
        "type": event["type"],
        "text": payload["text"],
        "created_at": event["created_at"],
    }
    for field_name in ("user_id", "conversation_id"):
        if field_name in payload:
            event_context[field_name] = payload[field_name]
    return event_context


def _validate_event_context(event: Any) -> dict[str, Any]:
    if not isinstance(event, Mapping):
        raise RoleModelValidationError("event must be a mapping.")
    _wrap_contract_error(
        lambda: reject_extra_keys(
            event,
            {"type", "text", "created_at", "user_id", "conversation_id"},
            "RoleModelInput.event",
        )
    )
    event_type = _wrap_contract_error(
        lambda: require_equal(event.get("type"), USER_MESSAGE, "event.type")
    )
    text = _wrap_contract_error(lambda: require_string(event.get("text"), "event.text"))
    event_context = {
        "type": event_type,
        "text": text,
        "created_at": _validate_timestamp(event.get("created_at"), "event.created_at"),
    }
    for field_name in ("user_id", "conversation_id"):
        if field_name in event:
            value = event[field_name]
            event_context[field_name] = _wrap_contract_error(
                lambda: require_optional_string(
                    value,
                    f"event.{field_name}",
                )
            )
    return event_context


def _validate_allowed_actions(value: Any) -> list[str]:
    if value == [VISIBLE_REPLY_ACTION]:
        return [VISIBLE_REPLY_ACTION]
    if value == [VISIBLE_REPLY_ACTION, STATE_PATCH_ACTION]:
        return [VISIBLE_REPLY_ACTION, STATE_PATCH_ACTION]
    if value == [VISIBLE_REPLY_ACTION, LIFE_ACTION]:
        return [VISIBLE_REPLY_ACTION, LIFE_ACTION]
    raise RoleModelValidationError(
        "allowed_actions must be ['visible_reply'], ['visible_reply', 'state_patch'], "
        "or ['visible_reply', 'life_action']."
    )


def _state_patch_allowed(allowed_actions: list[str]) -> bool:
    return allowed_actions == [VISIBLE_REPLY_ACTION, STATE_PATCH_ACTION]


def _life_action_allowed(allowed_actions: list[str]) -> bool:
    return allowed_actions == [VISIBLE_REPLY_ACTION, LIFE_ACTION]


def _allowed_life_action_type_for_call(
    *,
    allow_incident_start: bool,
    allow_incident_cancel: bool,
) -> str | None:
    if allow_incident_start:
        return START_INCIDENT_ACTION
    if allow_incident_cancel:
        return CANCEL_INCIDENT_ACTION
    return None


def _instructions_for_allowed_actions(
    allowed_actions: list[str],
    *,
    allowed_life_action_type: str | None = START_INCIDENT_ACTION,
) -> str:
    if _state_patch_allowed(allowed_actions):
        return STATE_PATCH_ROLE_MODEL_INSTRUCTIONS
    if _life_action_allowed(allowed_actions):
        if allowed_life_action_type == CANCEL_INCIDENT_ACTION:
            return INCIDENT_CANCEL_ROLE_MODEL_INSTRUCTIONS
        return INCIDENT_START_ROLE_MODEL_INSTRUCTIONS
    return ROLE_MODEL_INSTRUCTIONS


def _validate_allowed_life_action_type(value: Any, allowed_actions: list[str]) -> str | None:
    if not _life_action_allowed(allowed_actions):
        if value is not None:
            raise RoleModelValidationError(
                "allowed_life_action_type is only valid when life_action is allowed."
            )
        return None
    if not isinstance(value, str):
        raise RoleModelValidationError(
            "allowed_life_action_type must match the selected life_action subtype."
        )
    if value in {START_INCIDENT_ACTION, CANCEL_INCIDENT_ACTION}:
        return value
    raise RoleModelValidationError(
        "allowed_life_action_type must match the selected life_action subtype."
    )


def _validate_instructions_for_allowed_actions(
    value: Any,
    allowed_actions: list[str],
    *,
    allowed_life_action_type: str | None,
) -> str:
    if _life_action_allowed(allowed_actions):
        if not isinstance(value, str):
            raise ContractValidationError(
                "instructions must match the allowed life_action subtype."
            )
        expected_instructions = _instructions_for_allowed_actions(
            allowed_actions,
            allowed_life_action_type=allowed_life_action_type,
        )
        if value == expected_instructions:
            return value
        raise ContractValidationError("instructions must match the allowed life_action subtype.")
    return require_equal(
        value,
        _instructions_for_allowed_actions(allowed_actions),
        "instructions",
    )


def _allowed_life_action_type(model_input: Mapping[str, Any]) -> str:
    if not _life_action_allowed(model_input["allowed_actions"]):
        return START_INCIDENT_ACTION
    return model_input["allowed_life_action_type"]


def _wrap_contract_error[**P, T](callback: Callable[P, T], *args: P.args, **kwargs: P.kwargs) -> T:
    try:
        return callback(*args, **kwargs)
    except ContractValidationError as error:
        raise RoleModelValidationError(str(error)) from error


def _validate_failure(*, stage: str, code: str, message: str) -> dict[str, str]:
    if stage not in FAILURE_CODES_BY_STAGE:
        raise RoleModelValidationError("failure.stage must be a supported failure stage.")
    if code not in FAILURE_CODES_BY_STAGE[stage]:
        raise RoleModelValidationError("failure.code must match failure.stage.")
    return {
        "stage": stage,
        "code": code,
        "message": _wrap_contract_error(
            lambda: require_optional_string(message, "failure.message")
        ),
    }
