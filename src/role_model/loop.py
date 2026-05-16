from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from copy import deepcopy
from datetime import UTC, datetime
from math import ceil
from typing import Any, Protocol

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
VisibleConversationRecord = dict[str, Any]
VisibleConversationRecordsRequest = dict[str, Any]
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
            raise RoleModelValidationError("VisibleConversationRecordSource must return a list.")
        if len(records) > validated_request["max_candidate_messages"]:
            raise RoleModelValidationError(
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
    seen_message_ids: set[str] = set()
    seen_source_event_ids: set[str] = set()
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
            seen_source_event_ids=seen_source_event_ids,
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
        raise RoleModelValidationError("RecentVisibleMessagesRequest must be a mapping.")
    _wrap_contract_error(
        lambda: reject_extra_keys(
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
    )
    _wrap_contract_error(
        lambda: require_equal(request.get("schema_version"), SCHEMA_VERSION, "schema_version")
    )
    max_candidate_messages = request.get("max_candidate_messages")
    if (
        not isinstance(max_candidate_messages, int)
        or isinstance(max_candidate_messages, bool)
        or max_candidate_messages < 1
        or max_candidate_messages > RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES
    ):
        raise RoleModelValidationError(
            "max_candidate_messages must be an integer from 1 to "
            f"{RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES}."
        )

    return {
        "schema_version": SCHEMA_VERSION,
        "conversation_id": _wrap_contract_error(
            lambda: require_string(request.get("conversation_id"), "conversation_id")
        ),
        "before_event_id": _wrap_contract_error(
            lambda: require_string(request.get("before_event_id"), "before_event_id")
        ),
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
        raise RoleModelValidationError("VisibleConversationRecord must be a mapping.")
    kind = _wrap_contract_error(lambda: require_string(record.get("kind"), "kind"))
    if kind == USER_VISIBLE_MESSAGE_KIND:
        return _map_user_visible_message_record(record, conversation_id=conversation_id)
    if kind == ASSISTANT_VISIBLE_REPLY_KIND:
        return _map_assistant_visible_reply_record(record, conversation_id=conversation_id)
    raise RoleModelValidationError(
        "kind must be 'user_visible_message' or 'assistant_visible_reply'."
    )


def _map_user_visible_message_record(
    record: Mapping[str, Any],
    *,
    conversation_id: str,
) -> RecentVisibleMessage:
    _wrap_contract_error(
        lambda: reject_extra_keys(
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
    )
    _validate_user_visible_message_source(record.get("source"))
    _wrap_contract_error(
        lambda: require_equal(record.get("kind"), USER_VISIBLE_MESSAGE_KIND, "kind")
    )
    _wrap_contract_error(
        lambda: require_equal(record.get("role"), USER_VISIBLE_MESSAGE_ROLE, "role")
    )
    _validate_hidden_optional_user_id(record)

    return _validate_recent_visible_message(
        {
            "schema_version": _validated_schema_version(record),
            "message_id": _wrap_contract_error(
                lambda: require_string(record.get("message_id"), "message_id")
            ),
            "trace_id": _wrap_contract_error(
                lambda: require_string(record.get("trace_id"), "trace_id")
            ),
            "source_event_id": _wrap_contract_error(
                lambda: require_string(record.get("source_event_id"), "source_event_id")
            ),
            "conversation_id": _wrap_contract_error(
                lambda: require_equal(
                    record.get("conversation_id"), conversation_id, "conversation_id"
                )
            ),
            "role": USER_VISIBLE_MESSAGE_ROLE,
            "created_at": _validate_timestamp(record.get("created_at"), "created_at"),
            "text": _wrap_contract_error(lambda: require_string(record.get("text"), "text")),
        },
        conversation_id=conversation_id,
    )


def _map_assistant_visible_reply_record(
    record: Mapping[str, Any],
    *,
    conversation_id: str,
) -> RecentVisibleMessage:
    _wrap_contract_error(
        lambda: reject_extra_keys(
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
    )
    _validate_assistant_visible_reply_source(record.get("source"))
    _wrap_contract_error(
        lambda: require_equal(record.get("kind"), ASSISTANT_VISIBLE_REPLY_KIND, "kind")
    )
    _validate_hidden_optional_user_id(record)

    return _validate_recent_visible_message(
        {
            "schema_version": _validated_schema_version(record),
            "message_id": _wrap_contract_error(
                lambda: require_string(record.get("output_id"), "output_id")
            ),
            "trace_id": _wrap_contract_error(
                lambda: require_string(record.get("trace_id"), "trace_id")
            ),
            "source_event_id": _wrap_contract_error(
                lambda: require_string(record.get("source_event_id"), "source_event_id")
            ),
            "conversation_id": _wrap_contract_error(
                lambda: require_equal(
                    record.get("conversation_id"), conversation_id, "conversation_id"
                )
            ),
            "role": ASSISTANT_VISIBLE_REPLY_ROLE,
            "created_at": _validate_timestamp(record.get("created_at"), "created_at"),
            "text": _wrap_contract_error(lambda: require_string(record.get("text"), "text")),
        },
        conversation_id=conversation_id,
    )


def _validated_schema_version(record: Mapping[str, Any]) -> str:
    _wrap_contract_error(
        lambda: require_equal(record.get("schema_version"), SCHEMA_VERSION, "schema_version")
    )
    return SCHEMA_VERSION


def _validate_user_visible_message_source(source: Any) -> None:
    if not isinstance(source, Mapping):
        raise RoleModelValidationError("source must be a mapping.")
    _wrap_contract_error(
        lambda: reject_extra_keys(source, {"runtime_event_type"}, "UserVisibleMessage.source")
    )
    _wrap_contract_error(
        lambda: require_equal(
            source.get("runtime_event_type"), USER_MESSAGE, "source.runtime_event_type"
        )
    )


def _validate_assistant_visible_reply_source(source: Any) -> None:
    if not isinstance(source, Mapping):
        raise RoleModelValidationError("source must be a mapping.")
    _wrap_contract_error(
        lambda: reject_extra_keys(
            source,
            {"decision_action", "role_model_status"},
            "AssistantVisibleReply.source",
        )
    )
    _wrap_contract_error(
        lambda: require_equal(
            source.get("decision_action"),
            VISIBLE_REPLY_ACTION,
            "source.decision_action",
        )
    )
    _wrap_contract_error(
        lambda: require_equal(
            source.get("role_model_status"),
            DECISION_READY_FOR_COMMIT_STATUS,
            "source.role_model_status",
        )
    )


def _validate_hidden_optional_user_id(record: Mapping[str, Any]) -> None:
    if "user_id" not in record:
        return
    _wrap_contract_error(lambda: require_optional_string(record["user_id"], "user_id"))


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


def _reject_duplicate_recent_message_identity(
    message: RecentVisibleMessage,
    *,
    seen_message_ids: set[str],
    seen_source_event_ids: set[str],
) -> None:
    message_id = message["message_id"]
    if message_id in seen_message_ids:
        raise RoleModelValidationError("RecentVisibleMessage.message_id must be unique.")
    seen_message_ids.add(message_id)

    source_event_id = message["source_event_id"]
    if source_event_id in seen_source_event_ids:
        raise RoleModelValidationError("RecentVisibleMessage.source_event_id must be unique.")
    seen_source_event_ids.add(source_event_id)


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
            value = event[field_name]
            event_context[field_name] = _wrap_contract_error(
                lambda: require_optional_string(
                    value,
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
    seen_message_ids: set[str] = set()
    seen_source_event_ids: set[str] = set()
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
            seen_source_event_ids=seen_source_event_ids,
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


def _wrap_contract_error[T](callback: Callable[[], T]) -> T:
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
