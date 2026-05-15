from __future__ import annotations

import json
from collections.abc import Mapping
from copy import deepcopy
from typing import Any, Protocol

from runtime.contracts import (
    DECISION_READY_FOR_COMMIT_STATUS,
    USER_MESSAGE,
    VISIBLE_REPLY_ACTION,
    ContractValidationError,
    RuntimeEvent,
    normalize_visible_reply_decision,
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
RoleModelInput = dict[str, Any]
RoleModelAdapterOutput = dict[str, Any]
CharacterDecision = dict[str, Any]
RoleModelTurnResult = dict[str, Any]


class RoleModelValidationError(ValueError):
    """Raised when role-model input or output violates the active schema contract."""


class RoleModelAdapter(Protocol):
    def generate(self, model_input: RoleModelInput) -> RoleModelAdapterOutput: ...


def build_decision_context(event: RuntimeEvent) -> DecisionContext:
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

    return {
        "schema_version": SCHEMA_VERSION,
        "trace_id": normalized_event["trace_id"],
        "event_id": normalized_event["event_id"],
        "call_type": USER_MESSAGE_VISIBLE_REPLY_CALL,
        "event": event_context,
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
) -> RoleModelTurnResult:
    decision_context = build_decision_context(event)
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
        "model_id": _require_string(model_output.get("model_id"), "model_id"),
        "created_at": _require_string(model_output.get("created_at"), "created_at"),
        "raw_text": _require_string(model_output.get("raw_text"), "raw_text"),
    }


def _snapshot_failure_model_output(model_output: Any) -> Any:
    if isinstance(model_output, Mapping):
        return deepcopy(dict(model_output))
    return {"raw_value": repr(model_output)}


def _validate_role_model_input(model_input: RoleModelInput) -> RoleModelInput:
    if not isinstance(model_input, Mapping):
        raise RoleModelValidationError("RoleModelInput must be a mapping.")
    _reject_extra_keys(
        model_input,
        {"schema_version", "trace_id", "event_id", "instructions", "decision_context"},
        "RoleModelInput",
    )
    _require_equal(model_input.get("schema_version"), SCHEMA_VERSION, "schema_version")
    _require_equal(model_input.get("instructions"), ROLE_MODEL_INSTRUCTIONS, "instructions")
    decision_context = _validate_decision_context(model_input.get("decision_context"))

    trace_id = _require_string(model_input.get("trace_id"), "trace_id")
    event_id = _require_string(model_input.get("event_id"), "event_id")
    _require_equal(trace_id, decision_context["trace_id"], "trace_id")
    _require_equal(event_id, decision_context["event_id"], "event_id")

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
    _reject_extra_keys(
        decision_context,
        {"schema_version", "trace_id", "event_id", "call_type", "event", "allowed_actions"},
        "DecisionContext",
    )
    _require_equal(decision_context.get("schema_version"), SCHEMA_VERSION, "schema_version")
    trace_id = _require_string(decision_context.get("trace_id"), "trace_id")
    event_id = _require_string(decision_context.get("event_id"), "event_id")
    _require_equal(
        decision_context.get("call_type"),
        USER_MESSAGE_VISIBLE_REPLY_CALL,
        "call_type",
    )
    if decision_context.get("allowed_actions") != [VISIBLE_REPLY_ACTION]:
        raise RoleModelValidationError("allowed_actions must be ['visible_reply'].")

    event = decision_context.get("event")
    if not isinstance(event, Mapping):
        raise RoleModelValidationError("event must be a mapping.")
    _reject_extra_keys(
        event,
        {"type", "text", "created_at", "user_id", "conversation_id"},
        "DecisionContext.event",
    )
    event_type = _require_event_type(event.get("type"), "event.type")
    text = event.get("text")
    if not isinstance(text, str) or not text.strip():
        raise RoleModelValidationError("event.text must be a non-empty string.")
    event_context = {
        "type": event_type,
        "text": text,
        "created_at": _require_string(event.get("created_at"), "event.created_at"),
    }
    for field_name in ("user_id", "conversation_id"):
        if field_name in event:
            event_context[field_name] = _require_optional_payload_string(
                event[field_name], f"event.{field_name}"
            )

    return {
        "schema_version": SCHEMA_VERSION,
        "trace_id": trace_id,
        "event_id": event_id,
        "call_type": USER_MESSAGE_VISIBLE_REPLY_CALL,
        "event": event_context,
        "allowed_actions": [VISIBLE_REPLY_ACTION],
    }


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
        "message": _require_failure_message(message),
    }


def _reject_extra_keys(value: Mapping[str, Any], allowed_keys: set[str], name: str) -> None:
    extra_keys = set(value) - allowed_keys
    if extra_keys:
        formatted = ", ".join(sorted(extra_keys))
        raise RoleModelValidationError(f"{name} contains extra field(s): {formatted}.")


def _require_equal(value: Any, expected: str, field_name: str) -> None:
    if value != expected:
        raise RoleModelValidationError(f"{field_name} must be {expected!r}.")


def _require_event_type(value: Any, field_name: str) -> str:
    _require_equal(value, USER_MESSAGE, field_name)
    return value


def _require_string(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RoleModelValidationError(f"{field_name} must be a non-empty string.")
    return value


def _require_optional_payload_string(value: Any, field_name: str) -> str:
    if not isinstance(value, str):
        raise RoleModelValidationError(f"{field_name} must be a string.")
    return value


def _require_failure_message(value: Any) -> str:
    if not isinstance(value, str):
        raise RoleModelValidationError("failure.message must be a string.")
    return value
