from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime
from math import isfinite
from typing import Any

from runtime.logging import SCHEMA_VERSION

USER_MESSAGE = "USER_MESSAGE"
INCIDENT_COMPLETION = "INCIDENT_COMPLETION"
VISIBLE_REPLY_ACTION = "visible_reply"
STATE_PATCH_ACTION = "state_patch"
LIFE_ACTION = "life_action"
START_INCIDENT_ACTION = "start_incident"
CANCEL_INCIDENT_ACTION = "cancel_incident"
COMPLETE_INCIDENT_ACTION = "complete_incident"
DECISION_READY_FOR_COMMIT_STATUS = "decision_ready_for_commit"
ASSISTANT_VISIBLE_REPLY_KIND = "assistant_visible_reply"
USER_VISIBLE_MESSAGE_KIND = "user_visible_message"
ASSISTANT_VISIBLE_REPLY_ROLE = "assistant"
USER_VISIBLE_MESSAGE_ROLE = "user"
ACTIVE_INCIDENT_TYPES = {
    "idle",
    "eat",
    "drink",
    "sleep",
    "rest",
    "work",
    "think",
    "wait",
    "custom",
}
ACTIVE_INCIDENT_INTERRUPT_POLICIES = {"interruptible", "background", "protected"}
ACTIVE_INCIDENT_RESUME_POLICIES = {"resume", "ask_model", "cancel"}
USER_MESSAGE_INTERRUPTED_ACTIVE_INCIDENT_FIELD = "user_message_interrupted_active_incident"

RuntimeEvent = dict[str, Any]
CharacterDecision = dict[str, Any]
RoleModelTurnResult = dict[str, Any]


class ContractValidationError(ValueError):
    """Raised when a shared runtime contract is violated."""

    def __init__(self, message: str, *, code: str = "invalid_contract") -> None:
        super().__init__(message)
        self.code = code


def validate_normalized_user_message_event(
    event: Any,
    *,
    source_name: str = "RuntimeEvent",
) -> RuntimeEvent:
    if not isinstance(event, Mapping):
        raise ContractValidationError(f"{source_name} must be a mapping.")

    event_id = require_string(event.get("event_id"), f"{source_name}.event_id")
    trace_id = require_string(event.get("trace_id"), f"{source_name}.trace_id")
    event_type = require_equal(event.get("type"), USER_MESSAGE, f"{source_name}.type")
    created_at = validate_iso8601_timestamp(
        event.get("created_at"),
        f"{source_name}.created_at",
    )
    require_equal(event.get("schema_version"), SCHEMA_VERSION, f"{source_name}.schema_version")

    payload = event.get("payload")
    if not isinstance(payload, Mapping):
        raise ContractValidationError(f"{source_name}.payload must be a mapping.")
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ContractValidationError(f"{source_name}.payload.text must be a non-empty string.")

    normalized_payload: dict[str, str] = {"text": text}
    for field_name in ("user_id", "conversation_id"):
        if field_name in payload:
            normalized_payload[field_name] = require_optional_string(
                payload[field_name],
                f"{source_name}.payload.{field_name}",
            )

    return {
        "event_id": event_id,
        "trace_id": trace_id,
        "type": event_type,
        "created_at": created_at,
        "schema_version": SCHEMA_VERSION,
        "payload": normalized_payload,
    }


def validate_normalized_incident_completion_event(
    event: Any,
    *,
    source_name: str = "RuntimeEvent",
) -> RuntimeEvent:
    if not isinstance(event, Mapping):
        raise ContractValidationError(f"{source_name} must be a mapping.")

    event_id = require_string(event.get("event_id"), f"{source_name}.event_id")
    trace_id = require_string(event.get("trace_id"), f"{source_name}.trace_id")
    event_type = require_equal(event.get("type"), INCIDENT_COMPLETION, f"{source_name}.type")
    created_at = validate_iso8601_timestamp(
        event.get("created_at"),
        f"{source_name}.created_at",
    )
    require_equal(event.get("schema_version"), SCHEMA_VERSION, f"{source_name}.schema_version")

    payload = event.get("payload")
    if not isinstance(payload, Mapping):
        raise ContractValidationError(f"{source_name}.payload must be a mapping.")
    reject_extra_keys(
        payload,
        {"incident_id", "user_id", "conversation_id"},
        f"{source_name}.payload",
    )
    incident_id = require_string(
        payload.get("incident_id"),
        f"{source_name}.payload.incident_id",
    ).strip()
    normalized_payload: dict[str, str] = {"incident_id": incident_id}
    for field_name in ("user_id", "conversation_id"):
        if field_name in payload:
            normalized_payload[field_name] = require_optional_string(
                payload[field_name],
                f"{source_name}.payload.{field_name}",
            )

    return {
        "event_id": event_id,
        "trace_id": trace_id,
        "type": event_type,
        "created_at": created_at,
        "schema_version": SCHEMA_VERSION,
        "payload": normalized_payload,
    }


def normalize_visible_reply_decision(
    decision: Any,
    *,
    trace_id: str,
    event_id: str,
    require_attached_ids: bool,
    source_name: str = "CharacterDecision",
) -> CharacterDecision:
    if not isinstance(decision, Mapping):
        raise ContractValidationError(f"{source_name} must be a mapping.")
    allowed_keys = {"schema_version", "action", "visible_reply"}
    if require_attached_ids:
        allowed_keys |= {"trace_id", "event_id"}
    reject_extra_keys(decision, allowed_keys, source_name)
    require_equal(decision.get("schema_version"), SCHEMA_VERSION, "schema_version")
    if require_attached_ids:
        require_matching_identity(decision.get("trace_id"), trace_id, "trace_id")
        require_matching_identity(decision.get("event_id"), event_id, "event_id")
    if decision.get("action") != VISIBLE_REPLY_ACTION:
        raise ContractValidationError(
            f"action must be {VISIBLE_REPLY_ACTION!r}.",
            code="unsupported_action",
        )

    visible_reply = decision.get("visible_reply")
    if not isinstance(visible_reply, Mapping):
        raise ContractValidationError("visible_reply must be a mapping.")
    reject_extra_keys(visible_reply, {"text"}, "visible_reply")
    reply_text = visible_reply.get("text")
    if not isinstance(reply_text, str) or not reply_text.strip():
        raise ContractValidationError(
            "visible_reply.text must be a non-empty string.",
            code="empty_reply_text",
        )

    return {
        "schema_version": SCHEMA_VERSION,
        "trace_id": trace_id,
        "event_id": event_id,
        "action": VISIBLE_REPLY_ACTION,
        "visible_reply": {"text": reply_text.strip()},
    }


def normalize_visible_reply_decision_with_optional_living_state_patch(
    decision: Any,
    *,
    trace_id: str,
    event_id: str,
    require_attached_ids: bool,
    allow_state_patch: bool,
    allow_life_action: bool = False,
    allowed_life_action_type: str = START_INCIDENT_ACTION,
    source_name: str = "CharacterDecision",
) -> CharacterDecision:
    return _normalize_visible_reply_decision_with_optional_extensions(
        decision,
        trace_id=trace_id,
        event_id=event_id,
        require_attached_ids=require_attached_ids,
        allow_state_patch=allow_state_patch,
        allow_life_action=allow_life_action,
        allowed_life_action_type=allowed_life_action_type,
        source_name=source_name,
    )


def normalize_visible_reply_decision_with_optional_life_action(
    decision: Any,
    *,
    trace_id: str,
    event_id: str,
    require_attached_ids: bool,
    allow_life_action: bool,
    allowed_life_action_type: str = START_INCIDENT_ACTION,
    source_name: str = "CharacterDecision",
) -> CharacterDecision:
    return _normalize_visible_reply_decision_with_optional_extensions(
        decision,
        trace_id=trace_id,
        event_id=event_id,
        require_attached_ids=require_attached_ids,
        allow_state_patch=False,
        allow_life_action=allow_life_action,
        allowed_life_action_type=allowed_life_action_type,
        source_name=source_name,
    )


def _normalize_visible_reply_decision_with_optional_extensions(
    decision: Any,
    *,
    trace_id: str,
    event_id: str,
    require_attached_ids: bool,
    allow_state_patch: bool,
    allow_life_action: bool,
    allowed_life_action_type: str = START_INCIDENT_ACTION,
    source_name: str,
) -> CharacterDecision:
    if allow_state_patch and allow_life_action:
        raise ContractValidationError(
            "state_patch and life_action cannot both be allowed in this contract."
        )
    if not allow_state_patch and not allow_life_action:
        return normalize_visible_reply_decision(
            decision,
            trace_id=trace_id,
            event_id=event_id,
            require_attached_ids=require_attached_ids,
            source_name=source_name,
        )
    if not isinstance(decision, Mapping):
        raise ContractValidationError(f"{source_name} must be a mapping.")

    allowed_keys = {"schema_version", "action", "visible_reply"}
    if allow_state_patch:
        allowed_keys.add("state_patch")
    if allow_life_action:
        allowed_keys.add("life_action")
    if require_attached_ids:
        allowed_keys |= {"trace_id", "event_id"}
    reject_extra_keys(decision, allowed_keys, source_name)

    visible_reply_decision = {
        "schema_version": decision.get("schema_version"),
        "action": decision.get("action"),
        "visible_reply": decision.get("visible_reply"),
    }
    if require_attached_ids:
        visible_reply_decision["trace_id"] = decision.get("trace_id")
        visible_reply_decision["event_id"] = decision.get("event_id")

    normalized = normalize_visible_reply_decision(
        visible_reply_decision,
        trace_id=trace_id,
        event_id=event_id,
        require_attached_ids=require_attached_ids,
        source_name=source_name,
    )
    if "state_patch" in decision:
        normalized["state_patch"] = normalize_living_state_patch(
            decision["state_patch"],
            source_name=f"{source_name}.state_patch",
        )
    if "life_action" in decision:
        normalized["life_action"] = normalize_life_action(
            decision["life_action"],
            allowed_life_action_type=allowed_life_action_type,
            source_name=f"{source_name}.life_action",
        )
    return normalized


def normalize_life_action(
    life_action: Any,
    *,
    allowed_life_action_type: str,
    source_name: str = "life_action",
) -> dict[str, Any]:
    if allowed_life_action_type == START_INCIDENT_ACTION:
        return normalize_start_incident_life_action(life_action, source_name=source_name)
    if allowed_life_action_type == CANCEL_INCIDENT_ACTION:
        return normalize_cancel_incident_life_action(life_action, source_name=source_name)
    if allowed_life_action_type == COMPLETE_INCIDENT_ACTION:
        return normalize_complete_incident_life_action(life_action, source_name=source_name)
    raise ContractValidationError(
        "allowed_life_action_type must be 'start_incident', "
        "'cancel_incident', or 'complete_incident'."
    )


def normalize_start_incident_life_action(
    life_action: Any,
    *,
    source_name: str = "life_action",
) -> dict[str, Any]:
    if not isinstance(life_action, Mapping):
        raise ContractValidationError(f"{source_name} must be a mapping.")
    action_type = require_equal(
        life_action.get("type"),
        START_INCIDENT_ACTION,
        f"{source_name}.type",
    )
    reject_extra_keys(life_action, {"type", "incident"}, source_name)
    incident = life_action.get("incident")
    if not isinstance(incident, Mapping):
        raise ContractValidationError(f"{source_name}.incident must be a mapping.")
    reject_extra_keys(
        incident,
        {"type", "title", "remaining_seconds", "interrupt_policy", "resume_policy"},
        f"{source_name}.incident",
    )

    normalized_incident: dict[str, Any] = {
        "type": require_supported_value(
            incident.get("type"),
            ACTIVE_INCIDENT_TYPES,
            f"{source_name}.incident.type",
        ),
        "title": require_string(
            incident.get("title"),
            f"{source_name}.incident.title",
        ).strip(),
        "interrupt_policy": require_supported_value(
            incident.get("interrupt_policy"),
            ACTIVE_INCIDENT_INTERRUPT_POLICIES,
            f"{source_name}.incident.interrupt_policy",
        ),
        "resume_policy": require_supported_value(
            incident.get("resume_policy"),
            ACTIVE_INCIDENT_RESUME_POLICIES,
            f"{source_name}.incident.resume_policy",
        ),
    }
    if "remaining_seconds" in incident:
        normalized_incident["remaining_seconds"] = validate_remaining_seconds(
            incident["remaining_seconds"],
            f"{source_name}.incident.remaining_seconds",
        )

    return {
        "type": action_type,
        "incident": normalized_incident,
    }


def normalize_cancel_incident_life_action(
    life_action: Any,
    *,
    source_name: str = "life_action",
) -> dict[str, str]:
    if not isinstance(life_action, Mapping):
        raise ContractValidationError(f"{source_name} must be a mapping.")
    action_type = require_equal(
        life_action.get("type"),
        CANCEL_INCIDENT_ACTION,
        f"{source_name}.type",
    )
    reject_extra_keys(life_action, {"type", "incident_id", "reason"}, source_name)
    incident_id = require_string(
        life_action.get("incident_id"),
        f"{source_name}.incident_id",
    ).strip()
    reason = require_string(life_action.get("reason"), f"{source_name}.reason").strip()
    if not incident_id:
        raise ContractValidationError(f"{source_name}.incident_id must be a non-empty string.")
    if not reason:
        raise ContractValidationError(f"{source_name}.reason must be a non-empty string.")
    return {
        "type": action_type,
        "incident_id": incident_id,
        "reason": reason,
    }


def normalize_complete_incident_life_action(
    life_action: Any,
    *,
    source_name: str = "life_action",
) -> dict[str, str]:
    if not isinstance(life_action, Mapping):
        raise ContractValidationError(f"{source_name} must be a mapping.")
    action_type = require_equal(
        life_action.get("type"),
        COMPLETE_INCIDENT_ACTION,
        f"{source_name}.type",
    )
    reject_extra_keys(life_action, {"type", "incident_id"}, source_name)
    incident_id = require_string(
        life_action.get("incident_id"),
        f"{source_name}.incident_id",
    ).strip()
    if not incident_id:
        raise ContractValidationError(f"{source_name}.incident_id must be a non-empty string.")
    return {
        "type": action_type,
        "incident_id": incident_id,
    }


def normalize_living_state_patch(
    patch: Any,
    *,
    source_name: str = "state_patch",
) -> dict[str, dict[str, str]]:
    if not isinstance(patch, Mapping):
        raise ContractValidationError(f"{source_name} must be a mapping.")
    reject_extra_keys(patch, {"living_state"}, source_name)

    living_state = patch.get("living_state")
    if not isinstance(living_state, Mapping):
        raise ContractValidationError(f"{source_name}.living_state must be a mapping.")
    reject_extra_keys(
        living_state,
        {"current_activity", "mood", "toward_user"},
        f"{source_name}.living_state",
    )
    if not living_state:
        raise ContractValidationError(
            f"{source_name}.living_state must include at least one field."
        )

    normalized_living_state: dict[str, str] = {}
    for field_name in ("current_activity", "mood", "toward_user"):
        if field_name in living_state:
            normalized_living_state[field_name] = require_string(
                living_state[field_name],
                f"{source_name}.living_state.{field_name}",
            ).strip()

    if not normalized_living_state:
        raise ContractValidationError(
            f"{source_name}.living_state must include at least one field."
        )
    return {"living_state": normalized_living_state}


def normalize_role_model_turn_result(
    role_model_result: Any,
    *,
    source_event: RuntimeEvent,
    decision_normalizer: Callable[[Any], CharacterDecision],
    source_name: str = "RoleModelTurnResult",
) -> RoleModelTurnResult:
    event = validate_normalized_user_message_event(source_event, source_name="source_event")
    if not isinstance(role_model_result, Mapping):
        raise ContractValidationError(f"{source_name} must be a mapping.")
    reject_extra_keys(
        role_model_result,
        {"trace_id", "event_id", "event_type", "model_called", "status", "decision"},
        source_name,
    )
    require_matching_identity(role_model_result.get("trace_id"), event["trace_id"], "trace_id")
    require_matching_identity(role_model_result.get("event_id"), event["event_id"], "event_id")
    event_type = require_equal(role_model_result.get("event_type"), USER_MESSAGE, "event_type")
    if role_model_result.get("model_called") is not True:
        raise ContractValidationError(
            "model_called must be True.",
            code="unsupported_result_status",
        )
    if role_model_result.get("status") != DECISION_READY_FOR_COMMIT_STATUS:
        raise ContractValidationError(
            f"status must be {DECISION_READY_FOR_COMMIT_STATUS!r}.",
            code="unsupported_result_status",
        )

    return {
        "trace_id": event["trace_id"],
        "event_id": event["event_id"],
        "event_type": event_type,
        "model_called": True,
        "status": DECISION_READY_FOR_COMMIT_STATUS,
        "decision": decision_normalizer(role_model_result.get("decision")),
    }


def validate_iso8601_timestamp(value: Any, field_name: str) -> str:
    if not isinstance(value, str):
        raise ContractValidationError(f"{field_name} must be an ISO-8601 timestamp string.")
    if not value.strip() or not _has_datetime_component(value.strip()):
        raise ContractValidationError(f"{field_name} must be an ISO-8601 timestamp string.")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ContractValidationError(
            f"{field_name} must be an ISO-8601 timestamp string."
        ) from error
    return value


def require_string(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ContractValidationError(f"{field_name} must be a non-empty string.")
    return value


def require_optional_string(value: Any, field_name: str) -> str:
    if not isinstance(value, str):
        raise ContractValidationError(f"{field_name} must be a string.")
    return value


def require_equal(value: Any, expected: str, field_name: str) -> Any:
    if value != expected:
        raise ContractValidationError(f"{field_name} must be {expected!r}.")
    return value


def require_supported_value(value: Any, allowed_values: set[str], field_name: str) -> str:
    normalized_value = require_string(value, field_name)
    if normalized_value not in allowed_values:
        formatted = ", ".join(sorted(allowed_values))
        raise ContractValidationError(f"{field_name} must be one of: {formatted}.")
    return normalized_value


def validate_remaining_seconds(value: Any, field_name: str) -> int | float:
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not isfinite(value)
        or value < 0
    ):
        raise ContractValidationError(f"{field_name} must be a non-negative number.")
    return value


def require_matching_identity(value: Any, expected: str, field_name: str) -> None:
    if value != expected:
        raise ContractValidationError(
            f"{field_name} must match source_event.{field_name}.",
            code="identity_mismatch",
        )


def reject_extra_keys(value: Mapping[str, Any], allowed_keys: set[str], name: str) -> None:
    extra_keys = set(value) - allowed_keys
    if extra_keys:
        formatted = ", ".join(sorted(extra_keys))
        raise ContractValidationError(f"{name} contains extra field(s): {formatted}.")


def _has_datetime_component(value: str) -> bool:
    return "T" in value or "t" in value or (len(value) > 10 and value[10].isspace())
