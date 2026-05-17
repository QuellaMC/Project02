from __future__ import annotations

from collections.abc import Mapping
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


class CurrentCharacterStateSource(Protocol):
    def read_current_state(
        self,
        request: CurrentCharacterStateRequest,
    ) -> CharacterRuntimeStateSnapshot: ...


def build_current_character_state_request(event: RuntimeEvent) -> CurrentCharacterStateRequest:
    normalized_event = validate_normalized_user_message_event(
        event,
        source_name="CurrentCharacterStateRequest.event",
    )
    payload = normalized_event["payload"]
    request: CurrentCharacterStateRequest = {
        "schema_version": SCHEMA_VERSION,
        "trace_id": normalized_event["trace_id"],
        "event_id": normalized_event["event_id"],
        "event_type": normalized_event["type"],
    }
    for field_name in ("user_id", "conversation_id"):
        if field_name in payload:
            request[field_name] = payload[field_name]
    return validate_current_character_state_request(request)


def validate_current_character_state_request(
    request: Any,
) -> CurrentCharacterStateRequest:
    if not isinstance(request, Mapping):
        raise ContractValidationError("CurrentCharacterStateRequest must be a mapping.")
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
        "CurrentCharacterStateRequest",
    )
    normalized_request: CurrentCharacterStateRequest = {
        "schema_version": require_equal(
            request.get("schema_version"),
            SCHEMA_VERSION,
            "CurrentCharacterStateRequest.schema_version",
        ),
        "trace_id": require_string(
            request.get("trace_id"),
            "CurrentCharacterStateRequest.trace_id",
        ),
        "event_id": require_string(
            request.get("event_id"),
            "CurrentCharacterStateRequest.event_id",
        ),
        "event_type": require_equal(
            request.get("event_type"),
            USER_MESSAGE,
            "CurrentCharacterStateRequest.event_type",
        ),
    }
    for field_name in ("user_id", "conversation_id"):
        if field_name in request:
            normalized_request[field_name] = require_optional_string(
                request[field_name],
                f"CurrentCharacterStateRequest.{field_name}",
            )
    return normalized_request


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
