from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any

from runtime.logging import SCHEMA_VERSION

USER_MESSAGE = "USER_MESSAGE"
VISIBLE_REPLY_ACTION = "visible_reply"
DECISION_READY_FOR_COMMIT_STATUS = "decision_ready_for_commit"
ASSISTANT_VISIBLE_REPLY_KIND = "assistant_visible_reply"
USER_VISIBLE_MESSAGE_KIND = "user_visible_message"
ASSISTANT_VISIBLE_REPLY_ROLE = "assistant"
USER_VISIBLE_MESSAGE_ROLE = "user"

RuntimeEvent = dict[str, Any]
CharacterDecision = dict[str, Any]


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
