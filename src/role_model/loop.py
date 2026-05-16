from __future__ import annotations

import json
from collections.abc import Mapping
from copy import deepcopy
from datetime import UTC, datetime
from math import ceil
from typing import Any, Protocol

from runtime.contracts import (
    DECISION_READY_FOR_COMMIT_STATUS,
    USER_MESSAGE,
    VISIBLE_REPLY_ACTION,
    ContractValidationError,
    RuntimeEvent,
    normalize_visible_reply_decision,
    reject_extra_keys,
    require_equal,
    require_optional_string,
    require_string,
    validate_iso8601_timestamp,
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

USER_MESSAGE_VISIBLE_REPLY_CALL = "user_message_visible_reply"
RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES = 24
RECENT_VISIBLE_MESSAGES_MAX_MESSAGES = 6
RECENT_VISIBLE_MESSAGES_MAX_TEXT_TOKENS = 1200
ROLE_MODEL_TURN_COMPLETED_KIND = "role_model_turn_completed"
ROLE_MODEL_TURN_FAILED_KIND = "role_model_turn_failed"
FAILURE_CODES_BY_STAGE = {
    "adapter_call": {"adapter_exception"},
    "parse_output": {"malformed_model_output"},
}
ROLE_MODEL_INSTRUCTIONS = (
    "Return one JSON object only. The object must contain schema_version='0.1', "
    "action='visible_reply', and visible_reply.text as a non-empty string. "
    "Do not include extra fields."
)

DecisionContext = dict[str, Any]
RecentVisibleMessage = dict[str, Any]
RecentVisibleMessagesRequest = dict[str, Any]
RoleModelInput = dict[str, Any]
RoleModelAdapterOutput = dict[str, Any]
CharacterDecision = dict[str, Any]
RoleModelTurnResult = dict[str, Any]


class RoleModelValidationError(ValueError):
    """Raised when role-model input or output violates the active schema contract."""


class RoleModelAdapter(Protocol):
    def generate(self, model_input: RoleModelInput) -> RoleModelAdapterOutput: ...


class RecentVisibleMessagesSource(Protocol):
    def read_recent_visible_messages(
        self,
        request: RecentVisibleMessagesRequest,
    ) -> list[RecentVisibleMessage]: ...


def build_decision_context(
    event: RuntimeEvent,
    *,
    recent_visible_messages_source: RecentVisibleMessagesSource | None = None,
) -> DecisionContext:
    normalized_event = _wrap_contract_error(
        lambda: validate_normalized_user_message_event(event, source_name="event")
    )
    payload = normalized_event["payload"]

    event_context = {
        "type": normalized_event["type"],
        "text": payload["text"],
        "created_at": normalized_event["created_at"],
    }
    for field_name in ("user_id", "conversation_id"):
        if field_name in payload:
            event_context[field_name] = payload[field_name]
    recent_visible_messages = _read_recent_visible_messages(
        normalized_event,
        recent_visible_messages_source=recent_visible_messages_source,
    )

    return {
        "schema_version": SCHEMA_VERSION,
        "trace_id": normalized_event["trace_id"],
        "event_id": normalized_event["event_id"],
        "call_type": USER_MESSAGE_VISIBLE_REPLY_CALL,
        "event": event_context,
        "character_snapshot": {
            "recent_visible_messages": recent_visible_messages,
        },
        "allowed_actions": [VISIBLE_REPLY_ACTION],
    }


def render_role_model_input(decision_context: DecisionContext) -> RoleModelInput:
    validated_context = _validate_decision_context(decision_context)

    return {
        "schema_version": SCHEMA_VERSION,
        "trace_id": validated_context["trace_id"],
        "event_id": validated_context["event_id"],
        "instructions": ROLE_MODEL_INSTRUCTIONS,
        "decision_context": validated_context,
    }


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
        lambda: normalize_visible_reply_decision(
            parsed,
            trace_id=validated_model_input["trace_id"],
            event_id=validated_model_input["event_id"],
            require_attached_ids=False,
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
) -> RoleModelTurnResult:
    decision_context = build_decision_context(
        event,
        recent_visible_messages_source=recent_visible_messages_source,
    )
    model_input = render_role_model_input(decision_context)

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
    event_type = decision_context["event"]["type"]
    return {
        "trace_id": event["trace_id"],
        "event_id": event["event_id"],
        "event_type": event_type,
        "model_called": True,
        "status": DECISION_READY_FOR_COMMIT_STATUS,
        "decision": decision,
    }


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
    conversation_id = event["payload"].get("conversation_id")
    if not conversation_id or recent_visible_messages_source is None:
        return []

    request = _build_recent_visible_messages_request(event, conversation_id=conversation_id)
    raw_messages = recent_visible_messages_source.read_recent_visible_messages(deepcopy(request))
    if not isinstance(raw_messages, list):
        raise RoleModelValidationError("RecentVisibleMessagesSource must return a list.")
    if len(raw_messages) > RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES:
        raise RoleModelValidationError("RecentVisibleMessagesSource returned too many records.")

    event_created_at = _parse_sortable_timestamp(event["created_at"])
    normalized_messages: list[tuple[datetime, RecentVisibleMessage]] = []
    for raw_message in raw_messages:
        normalized_message = _validate_recent_visible_message(
            raw_message,
            conversation_id=conversation_id,
        )
        if _is_current_event_message(normalized_message, event_id=event["event_id"]):
            continue
        message_created_at = _parse_recent_message_timestamp_before_event(
            normalized_message,
            event_created_at=event_created_at,
        )
        normalized_messages.append(
            (
                message_created_at,
                normalized_message,
            )
        )
    return _select_recent_visible_messages(normalized_messages)


def _build_recent_visible_messages_request(
    event: RuntimeEvent,
    *,
    conversation_id: str,
) -> RecentVisibleMessagesRequest:
    return {
        "schema_version": SCHEMA_VERSION,
        "conversation_id": conversation_id,
        "before_event_id": event["event_id"],
        "before_created_at": event["created_at"],
        "max_candidate_messages": RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES,
    }


def _validate_recent_visible_message(
    message: Any,
    *,
    conversation_id: str,
) -> RecentVisibleMessage:
    if not isinstance(message, Mapping):
        raise RoleModelValidationError("RecentVisibleMessage must be a mapping.")
    _wrap_contract_error(
        lambda: reject_extra_keys(
            message,
            {
                "schema_version",
                "message_id",
                "trace_id",
                "source_event_id",
                "conversation_id",
                "role",
                "created_at",
                "text",
            },
            "RecentVisibleMessage",
        )
    )
    _wrap_contract_error(
        lambda: require_equal(message.get("schema_version"), SCHEMA_VERSION, "schema_version")
    )
    _wrap_contract_error(
        lambda: require_equal(message.get("conversation_id"), conversation_id, "conversation_id")
    )
    role = _wrap_contract_error(lambda: require_string(message.get("role"), "role"))
    if role not in {"user", "assistant"}:
        raise RoleModelValidationError("role must be 'user' or 'assistant'.")
    text = _wrap_contract_error(lambda: require_string(message.get("text"), "text"))

    return {
        "schema_version": SCHEMA_VERSION,
        "message_id": _wrap_contract_error(
            lambda: require_string(message.get("message_id"), "message_id")
        ),
        "trace_id": _wrap_contract_error(
            lambda: require_string(message.get("trace_id"), "trace_id")
        ),
        "source_event_id": _wrap_contract_error(
            lambda: require_string(message.get("source_event_id"), "source_event_id")
        ),
        "conversation_id": conversation_id,
        "role": role,
        "created_at": _validate_timestamp(message.get("created_at"), "created_at"),
        "text": text,
    }


def _is_current_event_message(message: RecentVisibleMessage, *, event_id: str) -> bool:
    return message["message_id"] == event_id or message["source_event_id"] == event_id


def _parse_recent_message_timestamp_before_event(
    message: RecentVisibleMessage,
    *,
    event_created_at: datetime,
) -> datetime:
    message_created_at = _parse_sortable_timestamp(message["created_at"])
    if message_created_at >= event_created_at:
        raise RoleModelValidationError(
            "RecentVisibleMessage.created_at must be before event.created_at."
        )
    return message_created_at


def _select_recent_visible_messages(
    messages: list[tuple[datetime, RecentVisibleMessage]],
) -> list[RecentVisibleMessage]:
    selected: list[tuple[datetime, RecentVisibleMessage]] = []
    used_tokens = 0
    for timestamp, message in sorted(
        messages,
        key=lambda item: (item[0], item[1]["message_id"]),
        reverse=True,
    ):
        if len(selected) >= RECENT_VISIBLE_MESSAGES_MAX_MESSAGES:
            break
        message_tokens = approximate_text_tokens(message["text"])
        if used_tokens + message_tokens > RECENT_VISIBLE_MESSAGES_MAX_TEXT_TOKENS:
            continue
        selected.append((timestamp, message))
        used_tokens += message_tokens
    return [
        deepcopy(message)
        for _, message in sorted(
            selected,
            key=lambda item: (item[0], item[1]["message_id"]),
        )
    ]


def approximate_text_tokens(text: str) -> int:
    return ceil(len(text) / 4)


def _validate_timestamp(value: Any, field_name: str) -> str:
    return _wrap_contract_error(
        lambda: validate_iso8601_timestamp(value, field_name),
    )


def _parse_sortable_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


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
            {"schema_version", "trace_id", "event_id", "instructions", "decision_context"},
            "RoleModelInput",
        )
    )
    _wrap_contract_error(
        lambda: require_equal(model_input.get("schema_version"), SCHEMA_VERSION, "schema_version")
    )
    _wrap_contract_error(
        lambda: require_equal(
            model_input.get("instructions"),
            ROLE_MODEL_INSTRUCTIONS,
            "instructions",
        )
    )
    decision_context = _validate_decision_context(model_input.get("decision_context"))

    trace_id = _wrap_contract_error(lambda: require_string(model_input.get("trace_id"), "trace_id"))
    event_id = _wrap_contract_error(lambda: require_string(model_input.get("event_id"), "event_id"))
    _wrap_contract_error(lambda: require_equal(trace_id, decision_context["trace_id"], "trace_id"))
    _wrap_contract_error(lambda: require_equal(event_id, decision_context["event_id"], "event_id"))

    return {
        "schema_version": SCHEMA_VERSION,
        "trace_id": trace_id,
        "event_id": event_id,
        "instructions": ROLE_MODEL_INSTRUCTIONS,
        "decision_context": decision_context,
    }


def _validate_decision_context(decision_context: Any) -> DecisionContext:
    if not isinstance(decision_context, Mapping):
        raise RoleModelValidationError("DecisionContext must be a mapping.")
    _wrap_contract_error(
        lambda: reject_extra_keys(
            decision_context,
            {
                "schema_version",
                "trace_id",
                "event_id",
                "call_type",
                "event",
                "character_snapshot",
                "allowed_actions",
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
    _wrap_contract_error(
        lambda: require_equal(
            decision_context.get("call_type"),
            USER_MESSAGE_VISIBLE_REPLY_CALL,
            "call_type",
        )
    )
    if decision_context.get("allowed_actions") != [VISIBLE_REPLY_ACTION]:
        raise RoleModelValidationError("allowed_actions must be ['visible_reply'].")

    event = decision_context.get("event")
    if not isinstance(event, Mapping):
        raise RoleModelValidationError("event must be a mapping.")
    _wrap_contract_error(
        lambda: reject_extra_keys(
            event,
            {"type", "text", "created_at", "user_id", "conversation_id"},
            "DecisionContext.event",
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
            event_context[field_name] = _wrap_contract_error(
                lambda field_name=field_name: require_optional_string(
                    event[field_name],
                    f"event.{field_name}",
                )
            )
    character_snapshot = _validate_character_snapshot(
        decision_context.get("character_snapshot"),
        conversation_id=event_context.get("conversation_id"),
        event_created_at=event_context["created_at"],
        event_id=event_id,
    )

    return {
        "schema_version": SCHEMA_VERSION,
        "trace_id": trace_id,
        "event_id": event_id,
        "call_type": USER_MESSAGE_VISIBLE_REPLY_CALL,
        "event": event_context,
        "character_snapshot": character_snapshot,
        "allowed_actions": [VISIBLE_REPLY_ACTION],
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
            {"recent_visible_messages"},
            "DecisionContext.character_snapshot",
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
        return {"recent_visible_messages": []}

    event_timestamp = _parse_sortable_timestamp(event_created_at)
    normalized_messages: list[tuple[datetime, RecentVisibleMessage]] = []
    for message in recent_visible_messages:
        normalized_message = _validate_recent_visible_message(
            message,
            conversation_id=conversation_id,
        )
        if _is_current_event_message(normalized_message, event_id=event_id):
            raise RoleModelValidationError("recent_visible_messages must exclude current event.")
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
    return {"recent_visible_messages": selected_messages}


def _validate_character_decision(
    decision: CharacterDecision,
    *,
    model_input: RoleModelInput,
) -> CharacterDecision:
    return _wrap_contract_error(
        lambda: normalize_visible_reply_decision(
            decision,
            trace_id=model_input["trace_id"],
            event_id=model_input["event_id"],
            require_attached_ids=True,
            source_name="CharacterDecision",
        )
    )


def _wrap_contract_error(callback):
    try:
        return callback()
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
