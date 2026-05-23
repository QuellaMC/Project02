from __future__ import annotations

from collections.abc import Callable, Mapping
from copy import deepcopy
from typing import Any, Protocol

from character.state.current import ActiveIncidentSource
from commit_effects.incident_lifecycle import (
    IncidentLifecycleCommitConfig,
    IncidentLifecycleCommitHooks,
    append_lifecycle_source_event_id_once,
    build_lifecycle_failure,
    build_lifecycle_rejected_result,
    commit_life_incident_lifecycle_transition,
    extract_trusted_lifecycle_source_identity,
    normalize_lifecycle_role_model_result,
    read_active_lifecycle_incident,
    require_lifecycle_finalizer_raw_event_log,
    require_matching_lifecycle_field,
    snapshot_lifecycle_value,
    validate_lifecycle_active_incident_for_commit,
    validate_lifecycle_committed_log_entry,
    validate_lifecycle_failure,
    validate_lifecycle_finalize_result,
    validate_lifecycle_source_event,
    validate_lifecycle_source_event_ids,
    wrap_lifecycle_contract_error,
)
from runtime.contracts import (
    CANCEL_INCIDENT_ACTION,
    USER_MESSAGE,
    VISIBLE_REPLY_ACTION,
    RuntimeEvent,
    normalize_cancel_incident_life_action,
    reject_extra_keys,
    require_equal,
    require_optional_string,
    require_string,
    validate_iso8601_timestamp,
)
from runtime.contracts import ContractValidationError as SharedContractValidationError
from runtime.kernel import RawEventLog
from runtime.logging import (
    SCHEMA_VERSION,
    Clock,
    IdGenerator,
    RawEventLogEntry,
    build_raw_log_entry,
)

LIFE_INCIDENT_CANCELLED_STATUS = "life_incident_cancelled"
LIFE_INCIDENT_CANCEL_SKIPPED_STATUS = "life_incident_cancel_skipped"
LIFE_INCIDENT_CANCEL_REJECTED_STATUS = "life_incident_cancel_rejected"
LIFE_INCIDENT_CANCELLED_KIND = "life_incident_cancelled"
LIFE_INCIDENT_CANCEL_REJECTED_KIND = "life_incident_cancel_rejected"
LIFE_INCIDENT_CANCEL_COMMIT_VALIDATION_STAGE = "life_incident_cancel_commit_validation"
LIFE_INCIDENT_CANCEL_FINALIZE_STAGE = "life_incident_cancel_finalize"
SUPPORTED_FAILURE_CODES_BY_STAGE = {
    LIFE_INCIDENT_CANCEL_COMMIT_VALIDATION_STAGE: {
        "malformed_commit_input",
        "active_incident_source_error",
        "identity_mismatch",
        "unsupported_result_status",
        "unsupported_action",
        "empty_reply_text",
        "no_active_incident",
        "incident_id_mismatch",
    },
    LIFE_INCIDENT_CANCEL_FINALIZE_STAGE: {
        "finalize_rejected",
        "malformed_finalize_result",
    },
}

RoleModelTurnResult = dict[str, Any]
LifeIncidentCancelCommitRequest = dict[str, Any]
LifeIncidentCancelFinalizeRequest = dict[str, Any]
LifeIncidentCancelFinalizeResult = dict[str, Any]
LifeIncidentCancelCommitResult = dict[str, Any]


class LifeIncidentCancelCommitValidationError(ValueError):
    """Raised when incident-cancel commit input violates the active contract."""

    def __init__(self, message: str, *, code: str = "malformed_commit_input") -> None:
        super().__init__(message)
        self.code = code


class LifeIncidentCancelFinalizerError(ValueError):
    """Raised by an injected incident-cancel finalizer when it rejects a commit."""

    def __init__(self, message: str, *, code: str = "finalize_rejected") -> None:
        super().__init__(message)
        self.code = code


class LifeIncidentCancelFinalizer(Protocol):
    """MVP-017 atomic incident-cancel-plus-log finalization boundary."""

    def finalize_life_incident_cancel(
        self,
        request: LifeIncidentCancelFinalizeRequest,
    ) -> dict[str, Any]: ...

    def complete_life_incident_cancel_after_log_visible(
        self,
        request: LifeIncidentCancelFinalizeRequest,
    ) -> None: ...


def _commit_validation_error(message: str, code: str) -> LifeIncidentCancelCommitValidationError:
    return LifeIncidentCancelCommitValidationError(message, code=code)


def _finalizer_error(message: str, code: str) -> LifeIncidentCancelFinalizerError:
    return LifeIncidentCancelFinalizerError(message, code=code)


def build_life_incident_cancel_commit_request(
    source_event: RuntimeEvent,
    role_model_result: RoleModelTurnResult,
) -> LifeIncidentCancelCommitRequest | None:
    event = _validate_source_event(source_event)
    result = _validate_role_model_result(role_model_result, source_event=event)
    decision = result["decision"]
    if "life_action" not in decision:
        return None

    life_action = decision["life_action"]
    payload = event["payload"]
    request: LifeIncidentCancelCommitRequest = {
        "schema_version": SCHEMA_VERSION,
        "trace_id": event["trace_id"],
        "event_id": event["event_id"],
        "event_type": event["type"],
        "decision_action": VISIBLE_REPLY_ACTION,
        "life_action_type": CANCEL_INCIDENT_ACTION,
        "incident_id": life_action["incident_id"],
        "reason": life_action["reason"],
    }
    for field_name in ("user_id", "conversation_id"):
        if field_name in payload:
            request[field_name] = payload[field_name]
    return request


def commit_life_incident_cancel(
    source_event: RuntimeEvent,
    role_model_result: RoleModelTurnResult,
    *,
    active_incident_source: ActiveIncidentSource,
    life_incident_cancel_finalizer: LifeIncidentCancelFinalizer,
    raw_event_log: RawEventLog,
    id_generator: IdGenerator,
    clock: Clock,
) -> LifeIncidentCancelCommitResult:
    source_identity = _extract_trusted_source_identity(source_event)
    return commit_life_incident_lifecycle_transition(
        source_event,
        role_model_result,
        source_identity=source_identity,
        active_incident_source=active_incident_source,
        finalizer=life_incident_cancel_finalizer,
        raw_event_log=raw_event_log,
        id_generator=id_generator,
        clock=clock,
        config=IncidentLifecycleCommitConfig(
            skipped_status=LIFE_INCIDENT_CANCEL_SKIPPED_STATUS,
            success_status=LIFE_INCIDENT_CANCELLED_STATUS,
            success_snapshot_key="cancelled_incident",
            commit_validation_stage=LIFE_INCIDENT_CANCEL_COMMIT_VALIDATION_STAGE,
            finalize_stage=LIFE_INCIDENT_CANCEL_FINALIZE_STAGE,
            finalize_method_name="finalize_life_incident_cancel",
            complete_after_visible_method_name="complete_life_incident_cancel_after_log_visible",
        ),
        hooks=IncidentLifecycleCommitHooks(
            build_commit_request=build_life_incident_cancel_commit_request,
            life_action_from_commit_request=_life_action_from_commit_request,
            read_active_incident=lambda event, source: _read_active_incident_for_cancel(
                event,
                active_incident_source=source,
            ),
            build_transition_snapshot=build_cancelled_life_incident_snapshot,
            build_success_log_entry=build_life_incident_cancelled_log_entry,
            build_finalize_request=build_life_incident_cancel_finalize_request,
            require_finalizer_raw_event_log=_require_finalizer_raw_event_log,
            finalize=lambda finalizer, request: finalizer.finalize_life_incident_cancel(request),
            validate_finalize_result=validate_life_incident_cancel_finalize_result,
            complete_after_visible=lambda finalizer, request: (
                finalizer.complete_life_incident_cancel_after_log_visible(request)
            ),
            build_rejected_log_entry=build_life_incident_cancel_rejected_log_entry,
            build_failure=_build_failure,
            build_rejected_result=_build_rejected_result,
            commit_validation_error_type=LifeIncidentCancelCommitValidationError,
            finalizer_error_type=LifeIncidentCancelFinalizerError,
            commit_validation_error_factory=_commit_validation_error,
            finalizer_error_factory=_finalizer_error,
        ),
    )


def build_cancelled_life_incident_snapshot(
    active_incident: Mapping[str, Any],
    commit_request: Mapping[str, Any],
) -> dict[str, Any]:
    validated_active_incident = _validate_active_incident_for_commit(active_incident)
    validated_request = _validate_cancel_commit_request(commit_request)
    source_event_ids = _append_source_event_id_once(
        validated_active_incident["source_event_ids"],
        validated_request["event_id"],
    )
    snapshot: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "incident_id": validated_active_incident["incident_id"],
        "type": validated_active_incident["type"],
        "status": "cancelled",
        "title": validated_active_incident["title"],
        "interrupt_policy": validated_active_incident["interrupt_policy"],
        "resume_policy": validated_active_incident["resume_policy"],
        "cancelled_at": validated_request["commit_time"],
        "cancellation_reason": validated_request["reason"],
        "source_event_ids": source_event_ids,
    }
    for field_name in ("started_at", "expected_end_at", "remaining_seconds"):
        if field_name in validated_active_incident:
            snapshot[field_name] = validated_active_incident[field_name]
    return validate_cancelled_life_incident_snapshot(
        snapshot,
        active_incident=validated_active_incident,
        commit_request=validated_request,
    )


def build_life_incident_cancelled_log_entry(
    source_event: RuntimeEvent,
    role_model_result: RoleModelTurnResult,
    life_action: Mapping[str, Any],
    active_incident: Mapping[str, Any],
    cancelled_incident: Mapping[str, Any],
    *,
    id_generator: IdGenerator,
    clock: Clock,
) -> RawEventLogEntry:
    event = _validate_source_event(source_event)
    result = _validate_role_model_result(role_model_result, source_event=event)
    normalized_life_action = _normalize_cancel_life_action(life_action)
    validated_active_incident = _validate_active_incident_for_commit(active_incident)
    commit_request = {
        "schema_version": SCHEMA_VERSION,
        "trace_id": event["trace_id"],
        "event_id": event["event_id"],
        "event_type": event["type"],
        "decision_action": VISIBLE_REPLY_ACTION,
        "life_action_type": CANCEL_INCIDENT_ACTION,
        "incident_id": normalized_life_action["incident_id"],
        "reason": normalized_life_action["reason"],
        "commit_time": cancelled_incident.get("cancelled_at")
        if isinstance(cancelled_incident, Mapping)
        else None,
    }
    validated_cancelled_incident = validate_cancelled_life_incident_snapshot(
        cancelled_incident,
        active_incident=validated_active_incident,
        commit_request=commit_request,
    )

    return build_raw_log_entry(
        trace_id=event["trace_id"],
        event_id=event["event_id"],
        kind=LIFE_INCIDENT_CANCELLED_KIND,
        data={
            "source_event": event,
            "role_model_result": result,
            "life_action": normalized_life_action,
            "active_incident": validated_active_incident,
            "cancelled_incident": validated_cancelled_incident,
        },
        id_generator=id_generator,
        clock=clock,
    )


def build_life_incident_cancel_finalize_request(
    commit_request: Mapping[str, Any],
    *,
    active_incident: Mapping[str, Any],
    cancelled_incident: Mapping[str, Any],
    committed_log_entry: Mapping[str, Any],
) -> LifeIncidentCancelFinalizeRequest:
    validated_request = _validate_cancel_commit_request(commit_request)
    validated_active_incident = _validate_active_incident_for_commit(active_incident)
    validated_cancelled_incident = validate_cancelled_life_incident_snapshot(
        cancelled_incident,
        active_incident=validated_active_incident,
        commit_request=validated_request,
    )
    validated_committed_log_entry = _validate_committed_log_entry(
        committed_log_entry,
        source_identity=validated_request,
    )
    finalized_request = deepcopy(dict(validated_request))
    finalized_request["active_incident"] = validated_active_incident
    finalized_request["cancelled_incident"] = validated_cancelled_incident
    finalized_request["committed_log_entry"] = validated_committed_log_entry
    return finalized_request


def validate_life_incident_cancel_finalize_result(
    finalize_result: Any,
    *,
    source_identity: Mapping[str, str],
    committed_log_entry: Mapping[str, Any],
) -> LifeIncidentCancelFinalizeResult:
    return validate_lifecycle_finalize_result(
        finalize_result,
        source_identity=source_identity,
        committed_log_entry=committed_log_entry,
        result_name="LifeIncidentCancelFinalizeResult",
        finalizer_error_factory=_finalizer_error,
    )


def build_life_incident_cancel_rejected_log_entry(
    source_event: RuntimeEvent,
    *,
    role_model_result_snapshot: Any,
    life_action_snapshot: Any | None,
    active_incident_snapshot: Any | None,
    cancelled_incident_snapshot: Any | None,
    failure: Mapping[str, Any],
    id_generator: IdGenerator,
    clock: Clock,
) -> RawEventLogEntry:
    source_identity = _extract_trusted_source_identity(source_event)
    validated_failure = _validate_failure(failure)
    data: dict[str, Any] = {
        "source_event": _snapshot(source_event),
        "role_model_result_snapshot": _snapshot(role_model_result_snapshot),
        "failure": validated_failure,
    }
    if life_action_snapshot is not None:
        data["life_action_snapshot"] = _snapshot(life_action_snapshot)
    if active_incident_snapshot is not None:
        data["active_incident_snapshot"] = _snapshot(active_incident_snapshot)
    if cancelled_incident_snapshot is not None:
        data["cancelled_incident_snapshot"] = _snapshot(cancelled_incident_snapshot)

    return build_raw_log_entry(
        trace_id=source_identity["trace_id"],
        event_id=source_identity["event_id"],
        kind=LIFE_INCIDENT_CANCEL_REJECTED_KIND,
        data=data,
        id_generator=id_generator,
        clock=clock,
    )


def validate_cancelled_life_incident_snapshot(
    snapshot: Any,
    *,
    active_incident: Mapping[str, Any],
    commit_request: Mapping[str, Any],
) -> dict[str, Any]:
    if not isinstance(snapshot, Mapping):
        raise LifeIncidentCancelCommitValidationError(
            "CancelledLifeIncidentSnapshot must be a mapping."
        )
    try:
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
                "cancelled_at",
                "cancellation_reason",
                "source_event_ids",
            },
            "CancelledLifeIncidentSnapshot",
        )
        schema_version = require_equal(
            snapshot.get("schema_version"),
            SCHEMA_VERSION,
            "CancelledLifeIncidentSnapshot.schema_version",
        )
        incident_id = require_string(
            snapshot.get("incident_id"),
            "CancelledLifeIncidentSnapshot.incident_id",
        )
        status = require_equal(
            snapshot.get("status"),
            "cancelled",
            "CancelledLifeIncidentSnapshot.status",
        )
        cancelled_at = validate_iso8601_timestamp(
            snapshot.get("cancelled_at"),
            "CancelledLifeIncidentSnapshot.cancelled_at",
        )
        cancellation_reason = require_string(
            snapshot.get("cancellation_reason"),
            "CancelledLifeIncidentSnapshot.cancellation_reason",
        )
    except SharedContractValidationError as error:
        raise LifeIncidentCancelCommitValidationError(str(error), code=error.code) from error

    validated_active_incident = _validate_active_incident_for_commit(active_incident)
    validated_request = _validate_cancel_commit_request(commit_request)
    if incident_id != validated_active_incident["incident_id"]:
        raise LifeIncidentCancelCommitValidationError(
            "cancelled_incident.incident_id must match active_incident.incident_id."
        )
    if incident_id != validated_request["incident_id"]:
        raise LifeIncidentCancelCommitValidationError(
            "cancelled_incident.incident_id must match LifeIncidentCancelCommitRequest.incident_id."
        )
    if cancelled_at != validated_request["commit_time"]:
        raise LifeIncidentCancelCommitValidationError(
            "cancelled_incident.cancelled_at must match commit_time."
        )
    if cancellation_reason != validated_request["reason"]:
        raise LifeIncidentCancelCommitValidationError(
            "cancelled_incident.cancellation_reason must match reason."
        )

    normalized_snapshot: dict[str, Any] = {
        "schema_version": schema_version,
        "incident_id": incident_id,
        "type": _require_matching_field(snapshot, validated_active_incident, "type"),
        "status": status,
        "title": _require_matching_field(snapshot, validated_active_incident, "title"),
        "interrupt_policy": _require_matching_field(
            snapshot,
            validated_active_incident,
            "interrupt_policy",
        ),
        "resume_policy": _require_matching_field(
            snapshot,
            validated_active_incident,
            "resume_policy",
        ),
        "cancelled_at": cancelled_at,
        "cancellation_reason": cancellation_reason,
        "source_event_ids": _validate_cancelled_source_event_ids(
            snapshot.get("source_event_ids"),
            active_source_event_ids=validated_active_incident["source_event_ids"],
            event_id=validated_request["event_id"],
        ),
    }
    for field_name in ("started_at", "expected_end_at", "remaining_seconds"):
        if field_name in validated_active_incident:
            normalized_snapshot[field_name] = _require_matching_field(
                snapshot,
                validated_active_incident,
                field_name,
            )
        elif field_name in snapshot:
            raise LifeIncidentCancelCommitValidationError(
                f"cancelled_incident.{field_name} must be omitted when active_incident omits it."
            )
    return normalized_snapshot


def _validate_source_event(source_event: Any) -> RuntimeEvent:
    return validate_lifecycle_source_event(
        source_event,
        commit_validation_error_factory=_commit_validation_error,
    )


def _validate_role_model_result(
    role_model_result: Any,
    *,
    source_event: RuntimeEvent,
) -> RoleModelTurnResult:
    return normalize_lifecycle_role_model_result(
        role_model_result,
        source_event=source_event,
        allowed_life_action_type=CANCEL_INCIDENT_ACTION,
        commit_validation_error_factory=_commit_validation_error,
    )


def _read_active_incident_for_cancel(
    source_event: RuntimeEvent,
    *,
    active_incident_source: ActiveIncidentSource,
) -> dict[str, Any]:
    return read_active_lifecycle_incident(
        source_event,
        active_incident_source=active_incident_source,
        commit_validation_error_factory=_commit_validation_error,
    )


def _validate_active_incident_for_commit(active_incident: Any) -> dict[str, Any]:
    return validate_lifecycle_active_incident_for_commit(
        active_incident,
        commit_validation_error_factory=_commit_validation_error,
    )


def _normalize_cancel_life_action(life_action: Any) -> dict[str, str]:
    return _wrap_validation_contract_error(
        lambda: normalize_cancel_incident_life_action(
            life_action,
            source_name="life_action",
        )
    )


def _life_action_from_commit_request(
    request: Mapping[str, Any],
) -> dict[str, str]:
    return _normalize_cancel_life_action(
        {
            "type": CANCEL_INCIDENT_ACTION,
            "incident_id": request.get("incident_id") if isinstance(request, Mapping) else None,
            "reason": request.get("reason") if isinstance(request, Mapping) else None,
        }
    )


def _validate_cancel_commit_request(
    commit_request: Mapping[str, Any],
) -> LifeIncidentCancelCommitRequest:
    if not isinstance(commit_request, Mapping):
        raise LifeIncidentCancelCommitValidationError("commit_request must be a mapping.")
    try:
        reject_extra_keys(
            commit_request,
            {
                "schema_version",
                "trace_id",
                "event_id",
                "event_type",
                "decision_action",
                "life_action_type",
                "incident_id",
                "reason",
                "commit_time",
                "user_id",
                "conversation_id",
            },
            "LifeIncidentCancelCommitRequest",
        )
        schema_version = require_equal(
            commit_request.get("schema_version"),
            SCHEMA_VERSION,
            "LifeIncidentCancelCommitRequest.schema_version",
        )
        trace_id = require_string(
            commit_request.get("trace_id"),
            "LifeIncidentCancelCommitRequest.trace_id",
        )
        event_id = require_string(
            commit_request.get("event_id"),
            "LifeIncidentCancelCommitRequest.event_id",
        )
        event_type = require_equal(
            commit_request.get("event_type"),
            USER_MESSAGE,
            "LifeIncidentCancelCommitRequest.event_type",
        )
        decision_action = require_equal(
            commit_request.get("decision_action"),
            VISIBLE_REPLY_ACTION,
            "LifeIncidentCancelCommitRequest.decision_action",
        )
        life_action_type = require_equal(
            commit_request.get("life_action_type"),
            CANCEL_INCIDENT_ACTION,
            "LifeIncidentCancelCommitRequest.life_action_type",
        )
        incident_id = require_string(
            commit_request.get("incident_id"),
            "LifeIncidentCancelCommitRequest.incident_id",
        )
        reason = require_string(
            commit_request.get("reason"),
            "LifeIncidentCancelCommitRequest.reason",
        )
        commit_time = validate_iso8601_timestamp(
            commit_request.get("commit_time"),
            "LifeIncidentCancelCommitRequest.commit_time",
        )
    except SharedContractValidationError as error:
        raise LifeIncidentCancelCommitValidationError(str(error), code=error.code) from error

    validated_request: LifeIncidentCancelCommitRequest = {
        "schema_version": schema_version,
        "trace_id": trace_id,
        "event_id": event_id,
        "event_type": event_type,
        "decision_action": decision_action,
        "life_action_type": life_action_type,
        "incident_id": incident_id.strip(),
        "reason": reason.strip(),
        "commit_time": commit_time,
    }
    for field_name in ("user_id", "conversation_id"):
        if field_name in commit_request:
            value = commit_request[field_name]
            if value is not None:
                validated_request[field_name] = require_optional_string(
                    value,
                    f"LifeIncidentCancelCommitRequest.{field_name}",
                )
    return validated_request


def _validate_committed_log_entry(
    committed_log_entry: Any,
    *,
    source_identity: Mapping[str, str],
) -> dict[str, Any]:
    return validate_lifecycle_committed_log_entry(
        committed_log_entry,
        source_identity=source_identity,
        success_kind=LIFE_INCIDENT_CANCELLED_KIND,
        commit_validation_error_factory=_commit_validation_error,
    )


def _extract_trusted_source_identity(source_event: Any) -> dict[str, str]:
    return extract_trusted_lifecycle_source_identity(
        source_event,
        commit_validation_error_factory=_commit_validation_error,
    )


def _build_rejected_result(
    source_identity: Mapping[str, str],
    failure: Mapping[str, str],
) -> LifeIncidentCancelCommitResult:
    return build_lifecycle_rejected_result(
        source_identity,
        failure,
        rejected_status=LIFE_INCIDENT_CANCEL_REJECTED_STATUS,
    )


def _validate_failure(failure: Mapping[str, Any]) -> dict[str, str]:
    return validate_lifecycle_failure(
        failure,
        supported_failure_codes_by_stage=SUPPORTED_FAILURE_CODES_BY_STAGE,
        lifecycle_label="incident-cancel",
        commit_validation_error_factory=_commit_validation_error,
    )


def _build_failure(stage: str, code: str, message: str) -> dict[str, str]:
    return build_lifecycle_failure(
        stage,
        code,
        message,
        supported_failure_codes_by_stage=SUPPORTED_FAILURE_CODES_BY_STAGE,
        finalize_stage=LIFE_INCIDENT_CANCEL_FINALIZE_STAGE,
    )


def _require_finalizer_raw_event_log(
    finalizer: LifeIncidentCancelFinalizer,
    raw_event_log: RawEventLog,
) -> None:
    require_lifecycle_finalizer_raw_event_log(
        finalizer,
        raw_event_log,
        specific_method_name="require_life_incident_cancel_raw_event_log",
        finalizer_error_factory=_finalizer_error,
    )


def _require_matching_field(
    snapshot: Mapping[str, Any],
    active_incident: Mapping[str, Any],
    field_name: str,
) -> Any:
    return require_matching_lifecycle_field(
        snapshot,
        active_incident,
        field_name,
        snapshot_name="cancelled_incident",
        commit_validation_error_factory=_commit_validation_error,
    )


def _append_source_event_id_once(source_event_ids: list[str], event_id: str) -> list[str]:
    return append_lifecycle_source_event_id_once(source_event_ids, event_id)


def _validate_cancelled_source_event_ids(
    value: Any,
    *,
    active_source_event_ids: list[str],
    event_id: str,
) -> list[str]:
    return validate_lifecycle_source_event_ids(
        value,
        active_source_event_ids=active_source_event_ids,
        event_id=event_id,
        snapshot_name="cancelled_incident",
        commit_validation_error_factory=_commit_validation_error,
    )


def _wrap_validation_contract_error[T](callback: Callable[[], T]) -> T:
    return wrap_lifecycle_contract_error(
        callback,
        commit_validation_error_factory=_commit_validation_error,
    )


def _snapshot(value: Any) -> Any:
    return snapshot_lifecycle_value(value)
