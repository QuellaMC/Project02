from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from typing import Any, Protocol

from runtime.contracts import (
    USER_MESSAGE,
    VISIBLE_REPLY_ACTION,
    RuntimeEvent,
    normalize_visible_reply_decision,
    validate_normalized_user_message_event,
)
from runtime.contracts import (
    ContractValidationError as SharedContractValidationError,
)
from runtime.kernel import RawEventLog
from runtime.logging import (
    SCHEMA_VERSION,
    Clock,
    IdGenerator,
    RawEventLogEntry,
    build_raw_log_entry,
    clock_timestamp,
    generate_id,
)

VISIBLE_OUTPUT_KIND = "assistant_visible_reply"
DECISION_READY_FOR_COMMIT_STATUS = "decision_ready_for_commit"
VISIBLE_REPLY_COMMITTED_STATUS = "visible_reply_committed"
VISIBLE_REPLY_REJECTED_STATUS = "visible_reply_rejected"
VISIBLE_REPLY_COMMITTED_KIND = "visible_reply_committed"
VISIBLE_REPLY_REJECTED_KIND = "visible_reply_rejected"
COMMIT_VALIDATION_STAGE = "commit_validation"
SUPPORTED_REJECTION_CODES = {
    "malformed_commit_input",
    "identity_mismatch",
    "unsupported_result_status",
    "unsupported_action",
    "empty_reply_text",
}

RoleModelTurnResult = dict[str, Any]
VisibleConversationOutput = dict[str, Any]
VisibleReplyCommitResult = dict[str, Any]
VisibleReplyRejectResult = dict[str, Any]


class CommitValidationError(ValueError):
    """Raised when Commit and Effects input violates the active schema contract."""

    def __init__(self, message: str, *, code: str = "malformed_commit_input") -> None:
        super().__init__(message)
        self.code = code


class VisibleConversationLog(Protocol):
    def append(self, output: VisibleConversationOutput) -> None: ...


def commit_visible_reply(
    source_event: RuntimeEvent,
    role_model_result: RoleModelTurnResult,
    *,
    visible_conversation_log: VisibleConversationLog,
    raw_event_log: RawEventLog,
    id_generator: IdGenerator,
    clock: Clock,
) -> VisibleReplyCommitResult | VisibleReplyRejectResult:
    source_identity = _extract_trusted_source_identity(source_event)

    try:
        output = build_visible_conversation_output(
            source_event,
            role_model_result,
            id_generator=id_generator,
            clock=clock,
        )
    except CommitValidationError as error:
        failure = _build_failure(error.code, str(error))
        raw_event_log.append(
            build_visible_reply_rejected_log_entry(
                source_event,
                role_model_result_snapshot=role_model_result,
                failure=failure,
                id_generator=id_generator,
                clock=clock,
            )
        )
        return {
            "trace_id": source_identity["trace_id"],
            "event_id": source_identity["event_id"],
            "event_type": source_identity["event_type"],
            "status": VISIBLE_REPLY_REJECTED_STATUS,
            "failure": failure,
        }

    committed_log_entry = build_visible_reply_committed_log_entry(
        source_event,
        role_model_result,
        output,
        id_generator=id_generator,
        clock=clock,
    )
    raw_event_log.append(committed_log_entry)
    visible_conversation_log.append(deepcopy(output))
    return {
        "trace_id": output["trace_id"],
        "event_id": output["source_event_id"],
        "event_type": USER_MESSAGE,
        "status": VISIBLE_REPLY_COMMITTED_STATUS,
        "output": deepcopy(output),
    }


def build_visible_conversation_output(
    source_event: RuntimeEvent,
    role_model_result: RoleModelTurnResult,
    *,
    id_generator: IdGenerator,
    clock: Clock,
) -> VisibleConversationOutput:
    event = _validate_source_event(source_event)
    result = _validate_role_model_result(role_model_result, source_event=event)
    decision = result["decision"]
    payload = event["payload"]

    output: VisibleConversationOutput = {
        "output_id": generate_id("output", id_generator),
        "trace_id": event["trace_id"],
        "source_event_id": event["event_id"],
        "kind": VISIBLE_OUTPUT_KIND,
        "created_at": clock_timestamp(clock),
        "schema_version": SCHEMA_VERSION,
        "text": decision["visible_reply"]["text"],
        "source": {
            "decision_action": VISIBLE_REPLY_ACTION,
            "role_model_status": DECISION_READY_FOR_COMMIT_STATUS,
        },
    }
    for field_name in ("user_id", "conversation_id"):
        if field_name in payload:
            output[field_name] = payload[field_name]
    return output


def build_visible_reply_committed_log_entry(
    source_event: RuntimeEvent,
    role_model_result: RoleModelTurnResult,
    output: VisibleConversationOutput,
    *,
    id_generator: IdGenerator,
    clock: Clock,
) -> RawEventLogEntry:
    event = _validate_source_event(source_event)
    result = _validate_role_model_result(role_model_result, source_event=event)
    validated_output = _validate_visible_conversation_output(
        output,
        source_event=event,
        role_model_result=result,
    )

    return build_raw_log_entry(
        trace_id=event["trace_id"],
        event_id=event["event_id"],
        kind=VISIBLE_REPLY_COMMITTED_KIND,
        data={
            "source_event": event,
            "role_model_result": result,
            "output": validated_output,
        },
        id_generator=id_generator,
        clock=clock,
    )


def build_visible_reply_rejected_log_entry(
    source_event: RuntimeEvent,
    *,
    role_model_result_snapshot: Any,
    failure: Mapping[str, Any],
    id_generator: IdGenerator,
    clock: Clock,
    decision_snapshot: Any | None = None,
) -> RawEventLogEntry:
    source_identity = _extract_trusted_source_identity(source_event)
    validated_failure = _validate_failure(failure)
    data: dict[str, Any] = {
        "source_event": _snapshot(source_event),
        "role_model_result_snapshot": _snapshot(role_model_result_snapshot),
        "failure": validated_failure,
    }
    if decision_snapshot is not None:
        data["decision_snapshot"] = _snapshot(decision_snapshot)
    elif (
        isinstance(role_model_result_snapshot, Mapping) and "decision" in role_model_result_snapshot
    ):
        data["decision_snapshot"] = _snapshot(role_model_result_snapshot["decision"])

    return build_raw_log_entry(
        trace_id=source_identity["trace_id"],
        event_id=source_identity["event_id"],
        kind=VISIBLE_REPLY_REJECTED_KIND,
        data=data,
        id_generator=id_generator,
        clock=clock,
    )


def _validate_source_event(source_event: Any) -> RuntimeEvent:
    return _wrap_contract_error(
        lambda: validate_normalized_user_message_event(
            source_event,
            source_name="source_event",
        )
    )


def _validate_role_model_result(
    role_model_result: Any,
    *,
    source_event: RuntimeEvent,
) -> RoleModelTurnResult:
    if not isinstance(role_model_result, Mapping):
        raise CommitValidationError("role_model_result must be a mapping.")
    _reject_extra_keys(
        role_model_result,
        {"trace_id", "event_id", "event_type", "model_called", "status", "decision"},
        "RoleModelTurnResult",
    )
    _require_matching_identity(
        role_model_result.get("trace_id"),
        source_event["trace_id"],
        "trace_id",
    )
    _require_matching_identity(
        role_model_result.get("event_id"),
        source_event["event_id"],
        "event_id",
    )
    _require_equal(role_model_result.get("event_type"), USER_MESSAGE, "event_type")
    if role_model_result.get("model_called") is not True:
        raise CommitValidationError(
            "model_called must be True.",
            code="unsupported_result_status",
        )
    if role_model_result.get("status") != DECISION_READY_FOR_COMMIT_STATUS:
        raise CommitValidationError(
            f"status must be {DECISION_READY_FOR_COMMIT_STATUS!r}.",
            code="unsupported_result_status",
        )
    decision = _validate_decision(role_model_result.get("decision"), source_event=source_event)

    return {
        "trace_id": source_event["trace_id"],
        "event_id": source_event["event_id"],
        "event_type": USER_MESSAGE,
        "model_called": True,
        "status": DECISION_READY_FOR_COMMIT_STATUS,
        "decision": decision,
    }


def _validate_decision(decision: Any, *, source_event: RuntimeEvent) -> dict[str, Any]:
    return _wrap_contract_error(
        lambda: normalize_visible_reply_decision(
            decision,
            trace_id=source_event["trace_id"],
            event_id=source_event["event_id"],
            require_attached_ids=True,
            source_name="CharacterDecision",
        )
    )


def _validate_visible_conversation_output(
    output: Any,
    *,
    source_event: RuntimeEvent,
    role_model_result: RoleModelTurnResult,
) -> VisibleConversationOutput:
    if not isinstance(output, Mapping):
        raise CommitValidationError("VisibleConversationOutput must be a mapping.")
    expected_keys = {
        "output_id",
        "trace_id",
        "source_event_id",
        "kind",
        "created_at",
        "schema_version",
        "text",
        "source",
    }
    expected_keys.update(
        field for field in ("user_id", "conversation_id") if field in source_event["payload"]
    )
    _reject_extra_keys(output, expected_keys, "VisibleConversationOutput")
    validated = {
        "output_id": _require_string(output.get("output_id"), "output_id"),
        "trace_id": _require_exact_string(
            output.get("trace_id"), source_event["trace_id"], "trace_id"
        ),
        "source_event_id": _require_exact_string(
            output.get("source_event_id"),
            source_event["event_id"],
            "source_event_id",
        ),
        "kind": _require_exact_string(output.get("kind"), VISIBLE_OUTPUT_KIND, "kind"),
        "created_at": _require_string(output.get("created_at"), "created_at"),
        "schema_version": _require_exact_string(
            output.get("schema_version"),
            SCHEMA_VERSION,
            "schema_version",
        ),
        "text": _require_exact_string(
            output.get("text"),
            role_model_result["decision"]["visible_reply"]["text"],
            "text",
        ),
        "source": _validate_output_source(output.get("source")),
    }
    for field_name in ("user_id", "conversation_id"):
        if field_name in source_event["payload"]:
            validated[field_name] = _require_exact_string(
                output.get(field_name),
                source_event["payload"][field_name],
                field_name,
            )
    return validated


def _validate_output_source(source: Any) -> dict[str, str]:
    if not isinstance(source, Mapping):
        raise CommitValidationError("VisibleConversationOutput.source must be a mapping.")
    _reject_extra_keys(
        source, {"decision_action", "role_model_status"}, "VisibleConversationOutput.source"
    )
    return {
        "decision_action": _require_exact_string(
            source.get("decision_action"),
            VISIBLE_REPLY_ACTION,
            "source.decision_action",
        ),
        "role_model_status": _require_exact_string(
            source.get("role_model_status"),
            DECISION_READY_FOR_COMMIT_STATUS,
            "source.role_model_status",
        ),
    }


def _extract_trusted_source_identity(source_event: Any) -> dict[str, str]:
    if not isinstance(source_event, Mapping):
        raise CommitValidationError("source_event must be a mapping.")
    trace_id = _require_string(source_event.get("trace_id"), "trace_id")
    event_id = _require_string(source_event.get("event_id"), "event_id")
    event_type = source_event.get("type")
    return {
        "trace_id": trace_id,
        "event_id": event_id,
        "event_type": event_type
        if isinstance(event_type, str) and event_type.strip()
        else USER_MESSAGE,
    }


def _validate_failure(failure: Mapping[str, Any]) -> dict[str, str]:
    if not isinstance(failure, Mapping):
        raise CommitValidationError("failure must be a mapping.")
    _reject_extra_keys(failure, {"stage", "code", "message"}, "failure")
    _require_equal(failure.get("stage"), COMMIT_VALIDATION_STAGE, "failure.stage")
    code = failure.get("code")
    if code not in SUPPORTED_REJECTION_CODES:
        raise CommitValidationError("failure.code must be a supported commit validation code.")
    return {
        "stage": COMMIT_VALIDATION_STAGE,
        "code": code,
        "message": _require_string(failure.get("message"), "failure.message"),
    }


def _build_failure(code: str, message: str) -> dict[str, str]:
    if code not in SUPPORTED_REJECTION_CODES:
        code = "malformed_commit_input"
    return {
        "stage": COMMIT_VALIDATION_STAGE,
        "code": code,
        "message": message,
    }


def _wrap_contract_error(callback):
    try:
        return callback()
    except SharedContractValidationError as error:
        raise CommitValidationError(str(error), code=error.code) from error


def _require_matching_identity(value: Any, expected: str, field_name: str) -> None:
    if value != expected:
        raise CommitValidationError(
            f"{field_name} must match source_event.{field_name}.",
            code="identity_mismatch",
        )


def _require_equal(value: Any, expected: str, field_name: str) -> None:
    if value != expected:
        raise CommitValidationError(f"{field_name} must be {expected!r}.")


def _require_exact_string(value: Any, expected: str, field_name: str) -> str:
    _require_equal(value, expected, field_name)
    return expected


def _require_string(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CommitValidationError(f"{field_name} must be a non-empty string.")
    return value


def _reject_extra_keys(value: Mapping[str, Any], allowed_keys: set[str], name: str) -> None:
    extra_keys = set(value) - allowed_keys
    if extra_keys:
        formatted = ", ".join(sorted(extra_keys))
        raise CommitValidationError(f"{name} contains extra field(s): {formatted}.")


def _snapshot(value: Any) -> Any:
    if isinstance(value, Mapping):
        return deepcopy(dict(value))
    return {"raw_value": repr(value)}
