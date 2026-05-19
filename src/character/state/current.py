from __future__ import annotations

from collections.abc import Mapping
from math import isfinite
from typing import Any, Protocol

from runtime.contracts import (
    USER_MESSAGE,
    ContractValidationError,
    RuntimeEvent,
    reject_extra_keys,
    require_equal,
    require_optional_string,
    require_string,
    validate_iso8601_timestamp,
    validate_normalized_user_message_event,
)
from runtime.logging import SCHEMA_VERSION

CurrentCharacterStateRequest = dict[str, Any]
CharacterRuntimeStateSnapshot = dict[str, Any]
LivingStateBrief = dict[str, Any]
ActiveIncidentRequest = dict[str, Any]
ActiveIncidentSnapshot = dict[str, Any]
ActiveIncidentBrief = dict[str, Any]

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


class CurrentCharacterStateSource(Protocol):
    def read_current_state(
        self,
        request: CurrentCharacterStateRequest,
    ) -> CharacterRuntimeStateSnapshot: ...


class ActiveIncidentSource(Protocol):
    def read_active_incident(
        self,
        request: ActiveIncidentRequest,
    ) -> ActiveIncidentSnapshot | None: ...


def build_current_character_state_request(event: RuntimeEvent) -> CurrentCharacterStateRequest:
    return _build_user_message_read_request(
        event,
        request_name="CurrentCharacterStateRequest",
    )


def validate_current_character_state_request(
    request: Any,
) -> CurrentCharacterStateRequest:
    return _validate_user_message_read_request(
        request,
        request_name="CurrentCharacterStateRequest",
    )


def build_active_incident_request(event: RuntimeEvent) -> ActiveIncidentRequest:
    return _build_user_message_read_request(
        event,
        request_name="ActiveIncidentRequest",
    )


def validate_active_incident_request(request: Any) -> ActiveIncidentRequest:
    return _validate_user_message_read_request(
        request,
        request_name="ActiveIncidentRequest",
    )


def build_living_state_brief(snapshot: Any) -> LivingStateBrief:
    validated_snapshot = validate_current_character_state_snapshot(snapshot)
    living_state = validated_snapshot["living_state"]
    return validate_living_state_brief(
        {
            "character_id": validated_snapshot["character_id"],
            "current_activity": living_state["current_activity"],
            "mood": living_state["mood"],
            "toward_user": living_state["toward_user"],
            "updated_at": validated_snapshot["updated_at"],
            "source_event_ids": list(validated_snapshot["source_event_ids"]),
        }
    )


def validate_current_character_state_snapshot(
    snapshot: Any,
) -> CharacterRuntimeStateSnapshot:
    if not isinstance(snapshot, Mapping):
        raise ContractValidationError("CharacterRuntimeStateSnapshot must be a mapping.")
    reject_extra_keys(
        snapshot,
        {
            "schema_version",
            "character_id",
            "living_state",
            "updated_at",
            "source_event_ids",
        },
        "CharacterRuntimeStateSnapshot",
    )
    living_state = snapshot.get("living_state")
    if not isinstance(living_state, Mapping):
        raise ContractValidationError(
            "CharacterRuntimeStateSnapshot.living_state must be a mapping."
        )
    reject_extra_keys(
        living_state,
        {"current_activity", "mood", "toward_user"},
        "CharacterRuntimeStateSnapshot.living_state",
    )
    return {
        "schema_version": require_equal(
            snapshot.get("schema_version"),
            SCHEMA_VERSION,
            "CharacterRuntimeStateSnapshot.schema_version",
        ),
        "character_id": require_string(
            snapshot.get("character_id"),
            "CharacterRuntimeStateSnapshot.character_id",
        ),
        "living_state": {
            "current_activity": require_string(
                living_state.get("current_activity"),
                "CharacterRuntimeStateSnapshot.living_state.current_activity",
            ),
            "mood": require_string(
                living_state.get("mood"),
                "CharacterRuntimeStateSnapshot.living_state.mood",
            ),
            "toward_user": require_string(
                living_state.get("toward_user"),
                "CharacterRuntimeStateSnapshot.living_state.toward_user",
            ),
        },
        "updated_at": validate_iso8601_timestamp(
            snapshot.get("updated_at"),
            "CharacterRuntimeStateSnapshot.updated_at",
        ),
        "source_event_ids": _validate_source_event_ids(
            snapshot.get("source_event_ids"),
            "CharacterRuntimeStateSnapshot.source_event_ids",
        ),
    }


def validate_living_state_brief(brief: Any) -> LivingStateBrief:
    if not isinstance(brief, Mapping):
        raise ContractValidationError("living_state_brief must be a mapping.")
    reject_extra_keys(
        brief,
        {
            "character_id",
            "current_activity",
            "mood",
            "toward_user",
            "updated_at",
            "source_event_ids",
        },
        "living_state_brief",
    )
    return {
        "character_id": require_string(
            brief.get("character_id"),
            "living_state_brief.character_id",
        ),
        "current_activity": require_string(
            brief.get("current_activity"),
            "living_state_brief.current_activity",
        ),
        "mood": require_string(
            brief.get("mood"),
            "living_state_brief.mood",
        ),
        "toward_user": require_string(
            brief.get("toward_user"),
            "living_state_brief.toward_user",
        ),
        "updated_at": validate_iso8601_timestamp(
            brief.get("updated_at"),
            "living_state_brief.updated_at",
        ),
        "source_event_ids": _validate_source_event_ids(
            brief.get("source_event_ids"),
            "living_state_brief.source_event_ids",
        ),
    }


def validate_living_state_brief_for_event(
    brief: Any,
    *,
    event_id: str,
) -> LivingStateBrief:
    validated_brief = validate_living_state_brief(brief)
    current_event_id = require_string(event_id, "event_id")
    if current_event_id in validated_brief["source_event_ids"]:
        raise ContractValidationError(
            "living_state_brief.source_event_ids must not include current event_id."
        )
    return validated_brief


def build_active_incident_brief(snapshot: Any) -> ActiveIncidentBrief:
    validated_snapshot = validate_active_incident_snapshot(snapshot)
    brief: ActiveIncidentBrief = {
        "incident_id": validated_snapshot["incident_id"],
        "type": validated_snapshot["type"],
        "title": validated_snapshot["title"],
        "interrupt_policy": validated_snapshot["interrupt_policy"],
        "resume_policy": validated_snapshot["resume_policy"],
        "source_event_ids": list(validated_snapshot["source_event_ids"]),
    }
    for field_name in ("started_at", "expected_end_at", "remaining_seconds"):
        if field_name in validated_snapshot:
            brief[field_name] = validated_snapshot[field_name]
    return validate_active_incident_brief(brief)


def validate_active_incident_snapshot(snapshot: Any) -> ActiveIncidentSnapshot:
    if not isinstance(snapshot, Mapping):
        raise ContractValidationError("ActiveIncidentSnapshot must be a mapping.")
    reject_extra_keys(
        snapshot,
        {
            "schema_version",
            "incident_id",
            "type",
            "status",
            "title",
            "started_at",
            "expected_end_at",
            "remaining_seconds",
            "interrupt_policy",
            "resume_policy",
            "source_event_ids",
        },
        "ActiveIncidentSnapshot",
    )
    normalized_snapshot: ActiveIncidentSnapshot = {
        "schema_version": require_equal(
            snapshot.get("schema_version"),
            SCHEMA_VERSION,
            "ActiveIncidentSnapshot.schema_version",
        ),
        "incident_id": require_string(
            snapshot.get("incident_id"),
            "ActiveIncidentSnapshot.incident_id",
        ),
        "type": _require_supported_value(
            snapshot.get("type"),
            ACTIVE_INCIDENT_TYPES,
            "ActiveIncidentSnapshot.type",
        ),
        "status": require_equal(
            snapshot.get("status"),
            "active",
            "ActiveIncidentSnapshot.status",
        ),
        "title": require_string(
            snapshot.get("title"),
            "ActiveIncidentSnapshot.title",
        ),
        "interrupt_policy": _require_supported_value(
            snapshot.get("interrupt_policy"),
            ACTIVE_INCIDENT_INTERRUPT_POLICIES,
            "ActiveIncidentSnapshot.interrupt_policy",
        ),
        "resume_policy": _require_supported_value(
            snapshot.get("resume_policy"),
            ACTIVE_INCIDENT_RESUME_POLICIES,
            "ActiveIncidentSnapshot.resume_policy",
        ),
        "source_event_ids": _validate_non_empty_source_event_ids(
            snapshot.get("source_event_ids"),
            "ActiveIncidentSnapshot.source_event_ids",
        ),
    }
    for field_name in ("started_at", "expected_end_at"):
        if field_name in snapshot:
            normalized_snapshot[field_name] = validate_iso8601_timestamp(
                snapshot[field_name],
                f"ActiveIncidentSnapshot.{field_name}",
            )
    if "remaining_seconds" in snapshot:
        normalized_snapshot["remaining_seconds"] = _validate_remaining_seconds(
            snapshot["remaining_seconds"],
            "ActiveIncidentSnapshot.remaining_seconds",
        )
    return normalized_snapshot


def validate_active_incident_brief(brief: Any) -> ActiveIncidentBrief:
    if not isinstance(brief, Mapping):
        raise ContractValidationError("active_incident must be a mapping.")
    reject_extra_keys(
        brief,
        {
            "incident_id",
            "type",
            "title",
            "started_at",
            "expected_end_at",
            "remaining_seconds",
            "interrupt_policy",
            "resume_policy",
            "source_event_ids",
        },
        "active_incident",
    )
    normalized_brief: ActiveIncidentBrief = {
        "incident_id": require_string(
            brief.get("incident_id"),
            "active_incident.incident_id",
        ),
        "type": _require_supported_value(
            brief.get("type"),
            ACTIVE_INCIDENT_TYPES,
            "active_incident.type",
        ),
        "title": require_string(
            brief.get("title"),
            "active_incident.title",
        ),
        "interrupt_policy": _require_supported_value(
            brief.get("interrupt_policy"),
            ACTIVE_INCIDENT_INTERRUPT_POLICIES,
            "active_incident.interrupt_policy",
        ),
        "resume_policy": _require_supported_value(
            brief.get("resume_policy"),
            ACTIVE_INCIDENT_RESUME_POLICIES,
            "active_incident.resume_policy",
        ),
        "source_event_ids": _validate_non_empty_source_event_ids(
            brief.get("source_event_ids"),
            "active_incident.source_event_ids",
        ),
    }
    for field_name in ("started_at", "expected_end_at"):
        if field_name in brief:
            normalized_brief[field_name] = validate_iso8601_timestamp(
                brief[field_name],
                f"active_incident.{field_name}",
            )
    if "remaining_seconds" in brief:
        normalized_brief["remaining_seconds"] = _validate_remaining_seconds(
            brief["remaining_seconds"],
            "active_incident.remaining_seconds",
        )
    return normalized_brief


def validate_active_incident_brief_for_event(
    brief: Any,
    *,
    event_id: str,
) -> ActiveIncidentBrief:
    validated_brief = validate_active_incident_brief(brief)
    current_event_id = require_string(event_id, "event_id")
    if current_event_id in validated_brief["source_event_ids"]:
        raise ContractValidationError(
            "active_incident.source_event_ids must not include current event_id."
        )
    return validated_brief


def _build_user_message_read_request(
    event: RuntimeEvent,
    *,
    request_name: str,
) -> dict[str, Any]:
    normalized_event = validate_normalized_user_message_event(
        event,
        source_name=f"{request_name}.event",
    )
    payload = normalized_event["payload"]
    request: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "trace_id": normalized_event["trace_id"],
        "event_id": normalized_event["event_id"],
        "event_type": normalized_event["type"],
    }
    for field_name in ("user_id", "conversation_id"):
        if field_name in payload:
            request[field_name] = payload[field_name]
    return _validate_user_message_read_request(request, request_name=request_name)


def _validate_user_message_read_request(
    request: Any,
    *,
    request_name: str,
) -> dict[str, Any]:
    if not isinstance(request, Mapping):
        raise ContractValidationError(f"{request_name} must be a mapping.")
    reject_extra_keys(
        request,
        {
            "schema_version",
            "trace_id",
            "event_id",
            "event_type",
            "user_id",
            "conversation_id",
        },
        request_name,
    )
    normalized_request: dict[str, Any] = {
        "schema_version": require_equal(
            request.get("schema_version"),
            SCHEMA_VERSION,
            f"{request_name}.schema_version",
        ),
        "trace_id": require_string(
            request.get("trace_id"),
            f"{request_name}.trace_id",
        ),
        "event_id": require_string(
            request.get("event_id"),
            f"{request_name}.event_id",
        ),
        "event_type": require_equal(
            request.get("event_type"),
            USER_MESSAGE,
            f"{request_name}.event_type",
        ),
    }
    for field_name in ("user_id", "conversation_id"):
        if field_name in request:
            normalized_request[field_name] = require_optional_string(
                request[field_name],
                f"{request_name}.{field_name}",
            )
    return normalized_request


def _validate_source_event_ids(value: Any, field_name: str) -> list[str]:
    if not isinstance(value, list):
        raise ContractValidationError(f"{field_name} must be a list.")
    source_event_ids: list[str] = []
    for index, source_event_id in enumerate(value):
        source_event_ids.append(
            require_string(
                source_event_id,
                f"{field_name}[{index}]",
            )
        )
    return source_event_ids


def _validate_non_empty_source_event_ids(value: Any, field_name: str) -> list[str]:
    source_event_ids = _validate_source_event_ids(value, field_name)
    if not source_event_ids:
        raise ContractValidationError(f"{field_name} must include at least one source event ID.")
    return source_event_ids


def _require_supported_value(value: Any, allowed_values: set[str], field_name: str) -> str:
    normalized_value = require_string(value, field_name)
    if normalized_value not in allowed_values:
        formatted = ", ".join(sorted(allowed_values))
        raise ContractValidationError(f"{field_name} must be one of: {formatted}.")
    return normalized_value


def _validate_remaining_seconds(value: Any, field_name: str) -> int | float:
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not isfinite(value)
        or value < 0
    ):
        raise ContractValidationError(f"{field_name} must be a non-negative number.")
    return value
