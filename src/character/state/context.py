from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from datetime import UTC, datetime
from math import ceil
from typing import Any, Protocol

from character.state.current import (
    ActiveIncidentSource,
    CurrentCharacterStateSource,
    build_active_incident_brief,
    build_active_incident_request,
    build_current_character_state_request,
    build_living_state_brief,
    validate_active_incident_brief_for_event,
    validate_living_state_brief_for_event,
)
from runtime.contracts import (
    ASSISTANT_VISIBLE_REPLY_KIND,
    ASSISTANT_VISIBLE_REPLY_ROLE,
    DECISION_READY_FOR_COMMIT_STATUS,
    USER_MESSAGE,
    USER_VISIBLE_MESSAGE_KIND,
    USER_VISIBLE_MESSAGE_ROLE,
    VISIBLE_REPLY_ACTION,
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

USER_MESSAGE_VISIBLE_REPLY_CALL = "user_message_visible_reply"
RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES = 24
RECENT_VISIBLE_MESSAGES_MAX_MESSAGES = 6
RECENT_VISIBLE_MESSAGES_MAX_TEXT_TOKENS = 1200

DecisionContext = dict[str, Any]
RecentVisibleMessage = dict[str, Any]
RecentVisibleMessagesRequest = dict[str, Any]
VisibleConversationRecord = dict[str, Any]
VisibleConversationRecordsRequest = dict[str, Any]


class RecentVisibleMessagesSource(Protocol):
    def read_recent_visible_messages(
        self,
        request: RecentVisibleMessagesRequest,
    ) -> list[RecentVisibleMessage]: ...


class VisibleConversationRecordSource(Protocol):
    def read_visible_conversation_records(
        self,
        request: VisibleConversationRecordsRequest,
    ) -> list[VisibleConversationRecord]: ...


class VisibleConversationRecentMessagesSource:
    def __init__(self, visible_conversation_record_source: VisibleConversationRecordSource) -> None:
        self._visible_conversation_record_source = visible_conversation_record_source

    def read_recent_visible_messages(
        self,
        request: RecentVisibleMessagesRequest,
    ) -> list[RecentVisibleMessage]:
        validated_request = _validate_recent_visible_messages_request(request)
        record_request = _build_visible_conversation_records_request(validated_request)
        records = self._visible_conversation_record_source.read_visible_conversation_records(
            deepcopy(record_request)
        )
        if not isinstance(records, list):
            raise ContractValidationError("VisibleConversationRecordSource must return a list.")
        if len(records) > validated_request["max_candidate_messages"]:
            raise ContractValidationError(
                "VisibleConversationRecordSource returned too many records."
            )

        return [
            deepcopy(
                _map_visible_conversation_record(
                    record,
                    conversation_id=validated_request["conversation_id"],
                )
            )
            for record in records
        ]


def build_character_decision_context(
    event: RuntimeEvent,
    *,
    recent_visible_messages_source: RecentVisibleMessagesSource | None = None,
    current_state_source: CurrentCharacterStateSource | None = None,
    active_incident_source: ActiveIncidentSource | None = None,
) -> DecisionContext:
    normalized_event = validate_normalized_user_message_event(event, source_name="event")
    recent_visible_messages = _read_recent_visible_messages(
        normalized_event,
        recent_visible_messages_source=recent_visible_messages_source,
    )
    living_state_brief = _read_living_state_brief(
        normalized_event,
        current_state_source=current_state_source,
    )
    active_incident_brief = _read_active_incident_brief(
        normalized_event,
        active_incident_source=active_incident_source,
    )

    character_snapshot: dict[str, Any] = {
        "recent_visible_messages": recent_visible_messages,
    }
    if living_state_brief is not None:
        character_snapshot["living_state_brief"] = living_state_brief
    if active_incident_brief is not None:
        character_snapshot["active_incident"] = active_incident_brief

    return {
        "schema_version": SCHEMA_VERSION,
        "trace_id": normalized_event["trace_id"],
        "event_id": normalized_event["event_id"],
        "character_snapshot": character_snapshot,
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
        raise ContractValidationError("RecentVisibleMessagesSource must return a list.")
    if len(raw_messages) > RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES:
        raise ContractValidationError("RecentVisibleMessagesSource returned too many records.")

    event_created_at = _parse_sortable_timestamp(event["created_at"])
    normalized_messages: list[tuple[datetime, RecentVisibleMessage]] = []
    seen_message_ids: set[str] = set()
    seen_source_event_roles: set[tuple[str, str]] = set()
    for raw_message in raw_messages:
        normalized_message = _validate_recent_visible_message(
            raw_message,
            conversation_id=conversation_id,
        )
        if _is_current_event_message(normalized_message, event_id=event["event_id"]):
            continue
        _reject_duplicate_recent_message_identity(
            normalized_message,
            seen_message_ids=seen_message_ids,
            seen_source_event_roles=seen_source_event_roles,
        )
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


def _read_living_state_brief(
    event: RuntimeEvent,
    *,
    current_state_source: CurrentCharacterStateSource | None,
) -> dict[str, Any] | None:
    if current_state_source is None:
        return None

    request = build_current_character_state_request(event)
    snapshot = current_state_source.read_current_state(deepcopy(request))
    living_state_brief = build_living_state_brief(snapshot)
    return validate_living_state_brief_for_event(
        living_state_brief,
        event_id=event["event_id"],
    )


def _read_active_incident_brief(
    event: RuntimeEvent,
    *,
    active_incident_source: ActiveIncidentSource | None,
) -> dict[str, Any] | None:
    if active_incident_source is None:
        return None

    request = build_active_incident_request(event)
    snapshot = active_incident_source.read_active_incident(deepcopy(request))
    if snapshot is None:
        return None
    active_incident_brief = build_active_incident_brief(snapshot)
    return validate_active_incident_brief_for_event(
        active_incident_brief,
        event_id=event["event_id"],
    )


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


def _validate_recent_visible_messages_request(request: Any) -> RecentVisibleMessagesRequest:
    if not isinstance(request, Mapping):
        raise ContractValidationError("RecentVisibleMessagesRequest must be a mapping.")
    reject_extra_keys(
        request,
        {
            "schema_version",
            "conversation_id",
            "before_event_id",
            "before_created_at",
            "max_candidate_messages",
        },
        "RecentVisibleMessagesRequest",
    )
    require_equal(request.get("schema_version"), SCHEMA_VERSION, "schema_version")
    max_candidate_messages = request.get("max_candidate_messages")
    if (
        not isinstance(max_candidate_messages, int)
        or isinstance(max_candidate_messages, bool)
        or max_candidate_messages < 1
        or max_candidate_messages > RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES
    ):
        raise ContractValidationError(
            "max_candidate_messages must be an integer from 1 to "
            f"{RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES}."
        )

    return {
        "schema_version": SCHEMA_VERSION,
        "conversation_id": require_string(request.get("conversation_id"), "conversation_id"),
        "before_event_id": require_string(request.get("before_event_id"), "before_event_id"),
        "before_created_at": _validate_timestamp(
            request.get("before_created_at"),
            "before_created_at",
        ),
        "max_candidate_messages": max_candidate_messages,
    }


def _build_visible_conversation_records_request(
    request: RecentVisibleMessagesRequest,
) -> VisibleConversationRecordsRequest:
    return {
        "schema_version": SCHEMA_VERSION,
        "conversation_id": request["conversation_id"],
        "before_event_id": request["before_event_id"],
        "before_created_at": request["before_created_at"],
        "max_candidate_records": request["max_candidate_messages"],
    }


def _map_visible_conversation_record(
    record: Any,
    *,
    conversation_id: str,
) -> RecentVisibleMessage:
    if not isinstance(record, Mapping):
        raise ContractValidationError("VisibleConversationRecord must be a mapping.")
    kind = require_string(record.get("kind"), "kind")
    if kind == USER_VISIBLE_MESSAGE_KIND:
        return _map_user_visible_message_record(record, conversation_id=conversation_id)
    if kind == ASSISTANT_VISIBLE_REPLY_KIND:
        return _map_assistant_visible_reply_record(record, conversation_id=conversation_id)
    raise ContractValidationError(
        "kind must be 'user_visible_message' or 'assistant_visible_reply'."
    )


def _map_user_visible_message_record(
    record: Mapping[str, Any],
    *,
    conversation_id: str,
) -> RecentVisibleMessage:
    reject_extra_keys(
        record,
        {
            "schema_version",
            "message_id",
            "trace_id",
            "source_event_id",
            "kind",
            "role",
            "conversation_id",
            "created_at",
            "text",
            "source",
            "user_id",
        },
        "UserVisibleMessage",
    )
    _validate_user_visible_message_source(record.get("source"))
    require_equal(record.get("kind"), USER_VISIBLE_MESSAGE_KIND, "kind")
    require_equal(record.get("role"), USER_VISIBLE_MESSAGE_ROLE, "role")
    _validate_hidden_optional_user_id(record)

    return _validate_recent_visible_message(
        {
            "schema_version": _validated_schema_version(record),
            "message_id": require_string(record.get("message_id"), "message_id"),
            "trace_id": require_string(record.get("trace_id"), "trace_id"),
            "source_event_id": require_string(record.get("source_event_id"), "source_event_id"),
            "conversation_id": require_equal(
                record.get("conversation_id"), conversation_id, "conversation_id"
            ),
            "role": USER_VISIBLE_MESSAGE_ROLE,
            "created_at": _validate_timestamp(record.get("created_at"), "created_at"),
            "text": require_string(record.get("text"), "text"),
        },
        conversation_id=conversation_id,
    )


def _map_assistant_visible_reply_record(
    record: Mapping[str, Any],
    *,
    conversation_id: str,
) -> RecentVisibleMessage:
    reject_extra_keys(
        record,
        {
            "schema_version",
            "output_id",
            "trace_id",
            "source_event_id",
            "kind",
            "conversation_id",
            "created_at",
            "text",
            "source",
            "user_id",
        },
        "AssistantVisibleReply",
    )
    _validate_assistant_visible_reply_source(record.get("source"))
    require_equal(record.get("kind"), ASSISTANT_VISIBLE_REPLY_KIND, "kind")
    _validate_hidden_optional_user_id(record)

    return _validate_recent_visible_message(
        {
            "schema_version": _validated_schema_version(record),
            "message_id": require_string(record.get("output_id"), "output_id"),
            "trace_id": require_string(record.get("trace_id"), "trace_id"),
            "source_event_id": require_string(record.get("source_event_id"), "source_event_id"),
            "conversation_id": require_equal(
                record.get("conversation_id"), conversation_id, "conversation_id"
            ),
            "role": ASSISTANT_VISIBLE_REPLY_ROLE,
            "created_at": _validate_timestamp(record.get("created_at"), "created_at"),
            "text": require_string(record.get("text"), "text"),
        },
        conversation_id=conversation_id,
    )


def _validated_schema_version(record: Mapping[str, Any]) -> str:
    require_equal(record.get("schema_version"), SCHEMA_VERSION, "schema_version")
    return SCHEMA_VERSION


def _validate_user_visible_message_source(source: Any) -> None:
    if not isinstance(source, Mapping):
        raise ContractValidationError("source must be a mapping.")
    reject_extra_keys(source, {"runtime_event_type"}, "UserVisibleMessage.source")
    require_equal(source.get("runtime_event_type"), USER_MESSAGE, "source.runtime_event_type")


def _validate_assistant_visible_reply_source(source: Any) -> None:
    if not isinstance(source, Mapping):
        raise ContractValidationError("source must be a mapping.")
    reject_extra_keys(
        source,
        {"decision_action", "role_model_status"},
        "AssistantVisibleReply.source",
    )
    require_equal(
        source.get("decision_action"),
        VISIBLE_REPLY_ACTION,
        "source.decision_action",
    )
    require_equal(
        source.get("role_model_status"),
        DECISION_READY_FOR_COMMIT_STATUS,
        "source.role_model_status",
    )


def _validate_hidden_optional_user_id(record: Mapping[str, Any]) -> None:
    if "user_id" not in record:
        return
    require_optional_string(record["user_id"], "user_id")


def _validate_recent_visible_message(
    message: Any,
    *,
    conversation_id: str,
) -> RecentVisibleMessage:
    if not isinstance(message, Mapping):
        raise ContractValidationError("RecentVisibleMessage must be a mapping.")
    reject_extra_keys(
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
    require_equal(message.get("schema_version"), SCHEMA_VERSION, "schema_version")
    require_equal(message.get("conversation_id"), conversation_id, "conversation_id")
    role = require_string(message.get("role"), "role")
    if role not in {USER_VISIBLE_MESSAGE_ROLE, ASSISTANT_VISIBLE_REPLY_ROLE}:
        raise ContractValidationError(
            f"role must be {USER_VISIBLE_MESSAGE_ROLE!r} or {ASSISTANT_VISIBLE_REPLY_ROLE!r}."
        )
    text = require_string(message.get("text"), "text")

    return {
        "schema_version": SCHEMA_VERSION,
        "message_id": require_string(message.get("message_id"), "message_id"),
        "trace_id": require_string(message.get("trace_id"), "trace_id"),
        "source_event_id": require_string(message.get("source_event_id"), "source_event_id"),
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
        raise ContractValidationError(
            "RecentVisibleMessage.created_at must be before event.created_at."
        )
    return message_created_at


def _reject_duplicate_recent_message_identity(
    message: RecentVisibleMessage,
    *,
    seen_message_ids: set[str],
    seen_source_event_roles: set[tuple[str, str]],
) -> None:
    message_id = message["message_id"]
    if message_id in seen_message_ids:
        raise ContractValidationError("RecentVisibleMessage.message_id must be unique.")
    seen_message_ids.add(message_id)

    source_event_role = (message["source_event_id"], message["role"])
    if source_event_role in seen_source_event_roles:
        raise ContractValidationError(
            "RecentVisibleMessage.source_event_id and role pair must be unique."
        )
    seen_source_event_roles.add(source_event_role)


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
    return validate_iso8601_timestamp(value, field_name)


def _parse_sortable_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)
