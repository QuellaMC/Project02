from __future__ import annotations

from collections.abc import Callable, Mapping
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any, Protocol

from character.state.current import ActiveIncidentSource, build_active_incident_request
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
    COMPLETE_INCIDENT_ACTION,
    INCIDENT_COMPLETION,
    USER_MESSAGE,
    VISIBLE_REPLY_ACTION,
    RuntimeEvent,
    normalize_complete_incident_life_action,
    reject_extra_keys,
    require_equal,
    require_optional_string,
    require_string,
    require_supported_value,
    validate_iso8601_timestamp,
    validate_normalized_incident_completion_event,
)
from runtime.contracts import ContractValidationError as SharedContractValidationError
from runtime.kernel import RawEventLog
from runtime.logging import (
    SCHEMA_VERSION,
    Clock,
    IdGenerator,
    RawEventLogEntry,
    RawEventLogQueryValidationError,
    build_raw_log_entry,
    clock_timestamp,
    confirm_committed_success_entry_visibility,
    discard_committed_success_entry_visibility,
)

LIFE_INCIDENT_COMPLETED_STATUS = "life_incident_completed"
LIFE_INCIDENT_COMPLETE_SKIPPED_STATUS = "life_incident_complete_skipped"
LIFE_INCIDENT_COMPLETE_REJECTED_STATUS = "life_incident_complete_rejected"
LIFE_INCIDENT_COMPLETED_KIND = "life_incident_completed"
LIFE_INCIDENT_COMPLETE_REJECTED_KIND = "life_incident_complete_rejected"
LIFE_INCIDENT_COMPLETE_COMMIT_VALIDATION_STAGE = "life_incident_complete_commit_validation"
LIFE_INCIDENT_COMPLETE_FINALIZE_STAGE = "life_incident_complete_finalize"
INCIDENT_COMPLETION_EVENT_COMMIT_VALIDATION_STAGE = "incident_completion_event_commit_validation"
INCIDENT_COMPLETION_EVENT_FINALIZE_STAGE = "incident_completion_event_finalize"
INCIDENT_COMPLETION_EVENT_SOURCE = "incident_completion_event"
SUPPORTED_FAILURE_CODES_BY_STAGE = {
    LIFE_INCIDENT_COMPLETE_COMMIT_VALIDATION_STAGE: {
        "malformed_commit_input",
        "active_incident_source_error",
        "identity_mismatch",
        "unsupported_result_status",
        "unsupported_action",
        "empty_reply_text",
        "no_active_incident",
        "incident_id_mismatch",
    },
    LIFE_INCIDENT_COMPLETE_FINALIZE_STAGE: {
        "finalize_rejected",
        "malformed_finalize_result",
    },
}
SUPPORTED_EVENT_FAILURE_CODES_BY_STAGE = {
    INCIDENT_COMPLETION_EVENT_COMMIT_VALIDATION_STAGE: {
        "malformed_commit_input",
        "active_incident_source_error",
        "identity_mismatch",
        "no_active_incident",
        "incident_id_mismatch",
    },
    INCIDENT_COMPLETION_EVENT_FINALIZE_STAGE: {
        "finalize_rejected",
        "malformed_finalize_result",
    },
}

RoleModelTurnResult = dict[str, Any]
LifeIncidentCompleteCommitRequest = dict[str, Any]
LifeIncidentCompleteFinalizeRequest = dict[str, Any]
LifeIncidentCompleteFinalizeResult = dict[str, Any]
LifeIncidentCompleteCommitResult = dict[str, Any]
LifeIncidentCompletionEventCommitRequest = dict[str, Any]


class LifeIncidentCompleteCommitValidationError(ValueError):
    """Raised when incident-complete commit input violates the active contract."""

    def __init__(self, message: str, *, code: str = "malformed_commit_input") -> None:
        super().__init__(message)
        self.code = code


class LifeIncidentCompleteFinalizerError(ValueError):
    """Raised by an injected incident-complete finalizer when it rejects a commit."""

    def __init__(self, message: str, *, code: str = "finalize_rejected") -> None:
        super().__init__(message)
        self.code = code


class LifeIncidentCompleteFinalizer(Protocol):
    """MVP-018 atomic incident-complete-plus-log finalization boundary."""

    def finalize_life_incident_complete(
        self,
        request: LifeIncidentCompleteFinalizeRequest,
    ) -> dict[str, Any]: ...

    def complete_life_incident_complete_after_log_visible(
        self,
        request: LifeIncidentCompleteFinalizeRequest,
    ) -> None: ...


def _commit_validation_error(message: str, code: str) -> LifeIncidentCompleteCommitValidationError:
    return LifeIncidentCompleteCommitValidationError(message, code=code)


def _finalizer_error(message: str, code: str) -> LifeIncidentCompleteFinalizerError:
    return LifeIncidentCompleteFinalizerError(message, code=code)


def build_life_incident_complete_commit_request(
    source_event: RuntimeEvent,
    role_model_result: RoleModelTurnResult,
) -> LifeIncidentCompleteCommitRequest | None:
    event = _validate_source_event(source_event)
    result = _validate_role_model_result(role_model_result, source_event=event)
    decision = result["decision"]
    if "life_action" not in decision:
        return None

    life_action = decision["life_action"]
    payload = event["payload"]
    request: LifeIncidentCompleteCommitRequest = {
        "schema_version": SCHEMA_VERSION,
        "trace_id": event["trace_id"],
        "event_id": event["event_id"],
        "event_type": event["type"],
        "decision_action": VISIBLE_REPLY_ACTION,
        "life_action_type": COMPLETE_INCIDENT_ACTION,
        "incident_id": life_action["incident_id"],
    }
    for field_name in ("user_id", "conversation_id"):
        if field_name in payload:
            request[field_name] = payload[field_name]
    return request


def commit_life_incident_complete(
    source_event: RuntimeEvent,
    role_model_result: RoleModelTurnResult,
    *,
    active_incident_source: ActiveIncidentSource,
    life_incident_complete_finalizer: LifeIncidentCompleteFinalizer,
    raw_event_log: RawEventLog,
    id_generator: IdGenerator,
    clock: Clock,
) -> LifeIncidentCompleteCommitResult:
    source_identity = _extract_trusted_source_identity(source_event)
    return commit_life_incident_lifecycle_transition(
        source_event,
        role_model_result,
        source_identity=source_identity,
        active_incident_source=active_incident_source,
        finalizer=life_incident_complete_finalizer,
        raw_event_log=raw_event_log,
        id_generator=id_generator,
        clock=clock,
        config=IncidentLifecycleCommitConfig(
            skipped_status=LIFE_INCIDENT_COMPLETE_SKIPPED_STATUS,
            success_status=LIFE_INCIDENT_COMPLETED_STATUS,
            success_snapshot_key="completed_incident",
            commit_validation_stage=LIFE_INCIDENT_COMPLETE_COMMIT_VALIDATION_STAGE,
            finalize_stage=LIFE_INCIDENT_COMPLETE_FINALIZE_STAGE,
            finalize_method_name="finalize_life_incident_complete",
            complete_after_visible_method_name="complete_life_incident_complete_after_log_visible",
        ),
        hooks=IncidentLifecycleCommitHooks(
            build_commit_request=build_life_incident_complete_commit_request,
            life_action_from_commit_request=_life_action_from_commit_request,
            read_active_incident=lambda event, source: _read_active_incident_for_complete(
                event,
                active_incident_source=source,
            ),
            build_transition_snapshot=build_completed_life_incident_snapshot,
            build_success_log_entry=build_life_incident_completed_log_entry,
            build_finalize_request=build_life_incident_complete_finalize_request,
            require_finalizer_raw_event_log=_require_finalizer_raw_event_log,
            finalize=lambda finalizer, request: finalizer.finalize_life_incident_complete(request),
            validate_finalize_result=validate_life_incident_complete_finalize_result,
            complete_after_visible=lambda finalizer, request: (
                finalizer.complete_life_incident_complete_after_log_visible(request)
            ),
            build_rejected_log_entry=build_life_incident_complete_rejected_log_entry,
            build_failure=_build_failure,
            build_rejected_result=_build_rejected_result,
            commit_validation_error_type=LifeIncidentCompleteCommitValidationError,
            finalizer_error_type=LifeIncidentCompleteFinalizerError,
            commit_validation_error_factory=_commit_validation_error,
            finalizer_error_factory=_finalizer_error,
        ),
    )


def build_life_incident_completion_event_commit_request(
    source_event: RuntimeEvent,
) -> LifeIncidentCompletionEventCommitRequest:
    event = _validate_incident_completion_event(source_event)
    payload = event["payload"]
    request: LifeIncidentCompletionEventCommitRequest = {
        "schema_version": SCHEMA_VERSION,
        "trace_id": event["trace_id"],
        "event_id": event["event_id"],
        "event_type": event["type"],
        "incident_id": payload["incident_id"],
    }
    for field_name in ("user_id", "conversation_id"):
        if field_name in payload:
            request[field_name] = payload[field_name]
    return _validate_complete_commit_request(request, require_commit_time=False)


def commit_life_incident_completion_event(
    source_event: RuntimeEvent,
    *,
    active_incident_source: ActiveIncidentSource,
    life_incident_complete_finalizer: LifeIncidentCompleteFinalizer,
    raw_event_log: RawEventLog,
    id_generator: IdGenerator,
    clock: Clock,
) -> LifeIncidentCompleteCommitResult:
    source_identity = _extract_rejectable_incident_completion_source_identity(source_event)
    event: RuntimeEvent | None = None
    request: LifeIncidentCompletionEventCommitRequest | None = None
    active_incident: Mapping[str, Any] | None = None
    completed_incident: Mapping[str, Any] | None = None
    committed_log_entry: RawEventLogEntry | None = None
    finalize_request: LifeIncidentCompleteFinalizeRequest | None = None
    validated_finalize_result: Mapping[str, Any] | None = None

    try:
        event = _validate_incident_completion_event(source_event)
        request = build_life_incident_completion_event_commit_request(event)
        active_incident = _read_active_incident_for_completion_event(
            event,
            active_incident_source=active_incident_source,
        )
        if active_incident["incident_id"] != request["incident_id"]:
            raise _commit_validation_error(
                "payload.incident_id must match the current active incident.",
                "incident_id_mismatch",
            )

        commit_time = clock_timestamp(clock)
        request["commit_time"] = commit_time
        completed_incident = build_completed_life_incident_snapshot(active_incident, request)
        committed_log_entry = build_life_incident_completion_event_completed_log_entry(
            event,
            active_incident,
            completed_incident,
            id_generator=id_generator,
            clock=_clock_at(commit_time),
        )
        finalize_request = build_life_incident_complete_finalize_request(
            request,
            active_incident=active_incident,
            completed_incident=completed_incident,
            committed_log_entry=committed_log_entry,
        )
        validated_finalize_result = _stage_completion_event_success(
            life_incident_complete_finalizer,
            finalize_request,
            raw_event_log=raw_event_log,
        )
        try:
            confirm_committed_success_entry_visibility(raw_event_log, committed_log_entry)
        except RawEventLogQueryValidationError as error:
            raise _finalizer_error(str(error), "malformed_finalize_result") from error
        _complete_completion_event_success_after_visible(
            life_incident_complete_finalizer,
            finalize_request,
        )
    except Exception as error:
        if isinstance(error, LifeIncidentCompleteFinalizerError):
            discard_committed_success_entry_visibility(raw_event_log, committed_log_entry)
            failure = _build_event_failure(
                INCIDENT_COMPLETION_EVENT_FINALIZE_STAGE,
                _error_code(error, "finalize_rejected"),
                str(error),
            )
            _append_completion_event_rejected_entry(
                source_event,
                active_incident_snapshot=active_incident,
                completed_incident_snapshot=completed_incident,
                failure=failure,
                raw_event_log=raw_event_log,
                id_generator=id_generator,
                clock=clock,
            )
            return _build_rejected_result(source_identity, failure)

        if isinstance(error, LifeIncidentCompleteCommitValidationError):
            failure = _build_event_failure(
                INCIDENT_COMPLETION_EVENT_COMMIT_VALIDATION_STAGE,
                _error_code(error, "malformed_commit_input"),
                str(error),
            )
            _append_completion_event_rejected_entry(
                source_event,
                active_incident_snapshot=active_incident,
                completed_incident_snapshot=completed_incident,
                failure=failure,
                raw_event_log=raw_event_log,
                id_generator=id_generator,
                clock=clock,
            )
            return _build_rejected_result(source_identity, failure)

        raise

    assert completed_incident is not None
    assert validated_finalize_result is not None
    assert event is not None
    return {
        "schema_version": SCHEMA_VERSION,
        "trace_id": source_identity["trace_id"],
        "event_id": source_identity["event_id"],
        "event_type": source_identity["event_type"],
        "status": LIFE_INCIDENT_COMPLETED_STATUS,
        "completed_incident": deepcopy(dict(completed_incident)),
        "committed_log_entry_id": validated_finalize_result["committed_log_entry_id"],
    }


def build_completed_life_incident_snapshot(
    active_incident: Mapping[str, Any],
    commit_request: Mapping[str, Any],
) -> dict[str, Any]:
    validated_active_incident = _validate_active_incident_for_commit(active_incident)
    validated_request = _validate_complete_commit_request(commit_request)
    source_event_ids = _append_source_event_id_once(
        validated_active_incident["source_event_ids"],
        validated_request["event_id"],
    )
    snapshot: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "incident_id": validated_active_incident["incident_id"],
        "type": validated_active_incident["type"],
        "status": "completed",
        "title": validated_active_incident["title"],
        "interrupt_policy": validated_active_incident["interrupt_policy"],
        "resume_policy": validated_active_incident["resume_policy"],
        "actual_end_at": validated_request["commit_time"],
        "source_event_ids": source_event_ids,
    }
    for field_name in ("started_at", "expected_end_at", "remaining_seconds"):
        if field_name in validated_active_incident:
            snapshot[field_name] = validated_active_incident[field_name]
    return validate_completed_life_incident_snapshot(
        snapshot,
        active_incident=validated_active_incident,
        commit_request=validated_request,
    )


def build_life_incident_completion_event_completed_log_entry(
    source_event: RuntimeEvent,
    active_incident: Mapping[str, Any],
    completed_incident: Mapping[str, Any],
    *,
    id_generator: IdGenerator,
    clock: Clock,
) -> RawEventLogEntry:
    event = _validate_incident_completion_event(source_event)
    validated_active_incident = _validate_active_incident_for_commit(active_incident)
    commit_request = build_life_incident_completion_event_commit_request(event)
    commit_request["commit_time"] = (
        completed_incident.get("actual_end_at") if isinstance(completed_incident, Mapping) else None
    )
    validated_completed_incident = validate_completed_life_incident_snapshot(
        completed_incident,
        active_incident=validated_active_incident,
        commit_request=commit_request,
    )

    return build_raw_log_entry(
        trace_id=event["trace_id"],
        event_id=event["event_id"],
        kind=LIFE_INCIDENT_COMPLETED_KIND,
        data={
            "source_event": event,
            "completion_source": INCIDENT_COMPLETION_EVENT_SOURCE,
            "active_incident": validated_active_incident,
            "completed_incident": validated_completed_incident,
        },
        id_generator=id_generator,
        clock=clock,
    )


def build_life_incident_completed_log_entry(
    source_event: RuntimeEvent,
    role_model_result: RoleModelTurnResult,
    life_action: Mapping[str, Any],
    active_incident: Mapping[str, Any],
    completed_incident: Mapping[str, Any],
    *,
    id_generator: IdGenerator,
    clock: Clock,
) -> RawEventLogEntry:
    event = _validate_source_event(source_event)
    result = _validate_role_model_result(role_model_result, source_event=event)
    normalized_life_action = _normalize_complete_life_action(life_action)
    validated_active_incident = _validate_active_incident_for_commit(active_incident)
    commit_request = {
        "schema_version": SCHEMA_VERSION,
        "trace_id": event["trace_id"],
        "event_id": event["event_id"],
        "event_type": event["type"],
        "decision_action": VISIBLE_REPLY_ACTION,
        "life_action_type": COMPLETE_INCIDENT_ACTION,
        "incident_id": normalized_life_action["incident_id"],
        "commit_time": completed_incident.get("actual_end_at")
        if isinstance(completed_incident, Mapping)
        else None,
    }
    validated_completed_incident = validate_completed_life_incident_snapshot(
        completed_incident,
        active_incident=validated_active_incident,
        commit_request=commit_request,
    )

    return build_raw_log_entry(
        trace_id=event["trace_id"],
        event_id=event["event_id"],
        kind=LIFE_INCIDENT_COMPLETED_KIND,
        data={
            "source_event": event,
            "role_model_result": result,
            "life_action": normalized_life_action,
            "active_incident": validated_active_incident,
            "completed_incident": validated_completed_incident,
        },
        id_generator=id_generator,
        clock=clock,
    )


def build_life_incident_complete_finalize_request(
    commit_request: Mapping[str, Any],
    *,
    active_incident: Mapping[str, Any],
    completed_incident: Mapping[str, Any],
    committed_log_entry: Mapping[str, Any],
) -> LifeIncidentCompleteFinalizeRequest:
    validated_request = _validate_complete_commit_request(commit_request)
    validated_active_incident = _validate_active_incident_for_commit(active_incident)
    validated_completed_incident = validate_completed_life_incident_snapshot(
        completed_incident,
        active_incident=validated_active_incident,
        commit_request=validated_request,
    )
    validated_committed_log_entry = _validate_committed_log_entry(
        committed_log_entry,
        source_identity=validated_request,
    )
    finalized_request = deepcopy(dict(validated_request))
    finalized_request["active_incident"] = validated_active_incident
    finalized_request["completed_incident"] = validated_completed_incident
    finalized_request["committed_log_entry"] = validated_committed_log_entry
    return finalized_request


def validate_life_incident_complete_finalize_result(
    finalize_result: Any,
    *,
    source_identity: Mapping[str, str],
    committed_log_entry: Mapping[str, Any],
) -> LifeIncidentCompleteFinalizeResult:
    return validate_lifecycle_finalize_result(
        finalize_result,
        source_identity=source_identity,
        committed_log_entry=committed_log_entry,
        result_name="LifeIncidentCompleteFinalizeResult",
        finalizer_error_factory=_finalizer_error,
    )


def build_life_incident_complete_rejected_log_entry(
    source_event: RuntimeEvent,
    *,
    role_model_result_snapshot: Any,
    life_action_snapshot: Any | None,
    active_incident_snapshot: Any | None,
    completed_incident_snapshot: Any | None,
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
    if completed_incident_snapshot is not None:
        data["completed_incident_snapshot"] = _snapshot(completed_incident_snapshot)

    return build_raw_log_entry(
        trace_id=source_identity["trace_id"],
        event_id=source_identity["event_id"],
        kind=LIFE_INCIDENT_COMPLETE_REJECTED_KIND,
        data=data,
        id_generator=id_generator,
        clock=clock,
    )


def build_life_incident_completion_event_rejected_log_entry(
    source_event: RuntimeEvent,
    *,
    active_incident_snapshot: Any | None,
    completed_incident_snapshot: Any | None,
    failure: Mapping[str, Any],
    id_generator: IdGenerator,
    clock: Clock,
) -> RawEventLogEntry:
    source_identity = _extract_rejectable_incident_completion_source_identity(source_event)
    validated_failure = _validate_event_failure(failure)
    data: dict[str, Any] = {
        "source_event": _snapshot(source_event),
        "completion_source": INCIDENT_COMPLETION_EVENT_SOURCE,
        "failure": validated_failure,
    }
    if active_incident_snapshot is not None:
        data["active_incident_snapshot"] = _snapshot(active_incident_snapshot)
    if completed_incident_snapshot is not None:
        data["completed_incident_snapshot"] = _snapshot(completed_incident_snapshot)

    return build_raw_log_entry(
        trace_id=source_identity["trace_id"],
        event_id=source_identity["event_id"],
        kind=LIFE_INCIDENT_COMPLETE_REJECTED_KIND,
        data=data,
        id_generator=id_generator,
        clock=clock,
    )


def validate_completed_life_incident_snapshot(
    snapshot: Any,
    *,
    active_incident: Mapping[str, Any],
    commit_request: Mapping[str, Any],
) -> dict[str, Any]:
    if not isinstance(snapshot, Mapping):
        raise LifeIncidentCompleteCommitValidationError(
            "CompletedLifeIncidentSnapshot must be a mapping."
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
                "actual_end_at",
                "source_event_ids",
            },
            "CompletedLifeIncidentSnapshot",
        )
        schema_version = require_equal(
            snapshot.get("schema_version"),
            SCHEMA_VERSION,
            "CompletedLifeIncidentSnapshot.schema_version",
        )
        incident_id = require_string(
            snapshot.get("incident_id"),
            "CompletedLifeIncidentSnapshot.incident_id",
        )
        status = require_equal(
            snapshot.get("status"),
            "completed",
            "CompletedLifeIncidentSnapshot.status",
        )
        actual_end_at = validate_iso8601_timestamp(
            snapshot.get("actual_end_at"),
            "CompletedLifeIncidentSnapshot.actual_end_at",
        )
    except SharedContractValidationError as error:
        raise LifeIncidentCompleteCommitValidationError(str(error), code=error.code) from error

    validated_active_incident = _validate_active_incident_for_commit(active_incident)
    validated_request = _validate_complete_commit_request(commit_request)
    if incident_id != validated_active_incident["incident_id"]:
        raise LifeIncidentCompleteCommitValidationError(
            "completed_incident.incident_id must match active_incident.incident_id."
        )
    if incident_id != validated_request["incident_id"]:
        raise LifeIncidentCompleteCommitValidationError(
            "completed_incident.incident_id must match "
            "LifeIncidentCompleteCommitRequest.incident_id."
        )
    if actual_end_at != validated_request["commit_time"]:
        raise LifeIncidentCompleteCommitValidationError(
            "completed_incident.actual_end_at must match commit_time."
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
        "actual_end_at": actual_end_at,
        "source_event_ids": _validate_completed_source_event_ids(
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
            raise LifeIncidentCompleteCommitValidationError(
                f"completed_incident.{field_name} must be omitted when active_incident omits it."
            )
    return normalized_snapshot


def _validate_source_event(source_event: Any) -> RuntimeEvent:
    return validate_lifecycle_source_event(
        source_event,
        commit_validation_error_factory=_commit_validation_error,
    )


def _validate_incident_completion_event(source_event: Any) -> RuntimeEvent:
    return _wrap_validation_contract_error(
        lambda: validate_normalized_incident_completion_event(
            source_event,
            source_name="source_event",
        )
    )


def _validate_role_model_result(
    role_model_result: Any,
    *,
    source_event: RuntimeEvent,
) -> RoleModelTurnResult:
    return normalize_lifecycle_role_model_result(
        role_model_result,
        source_event=source_event,
        allowed_life_action_type=COMPLETE_INCIDENT_ACTION,
        commit_validation_error_factory=_commit_validation_error,
    )


def _read_active_incident_for_complete(
    source_event: RuntimeEvent,
    *,
    active_incident_source: ActiveIncidentSource,
) -> dict[str, Any]:
    return read_active_lifecycle_incident(
        source_event,
        active_incident_source=active_incident_source,
        commit_validation_error_factory=_commit_validation_error,
    )


def _read_active_incident_for_completion_event(
    source_event: RuntimeEvent,
    *,
    active_incident_source: ActiveIncidentSource,
) -> dict[str, Any]:
    event = _validate_incident_completion_event(source_event)
    request = build_active_incident_request(event)
    try:
        active_incident = active_incident_source.read_active_incident(deepcopy(request))
    except Exception as error:
        raise _commit_validation_error(
            f"active_incident_source.read_active_incident failed unexpectedly: {error}",
            "active_incident_source_error",
        ) from error
    if active_incident is None:
        raise _commit_validation_error(
            "No active incident exists for this source-event scope.",
            "no_active_incident",
        )
    return _validate_active_incident_for_commit(active_incident)


def _validate_active_incident_for_commit(active_incident: Any) -> dict[str, Any]:
    return validate_lifecycle_active_incident_for_commit(
        active_incident,
        commit_validation_error_factory=_commit_validation_error,
    )


def _normalize_complete_life_action(life_action: Any) -> dict[str, str]:
    return _wrap_validation_contract_error(
        lambda: normalize_complete_incident_life_action(
            life_action,
            source_name="life_action",
        )
    )


def _life_action_from_commit_request(
    request: Mapping[str, Any],
) -> dict[str, str]:
    return _normalize_complete_life_action(
        {
            "type": COMPLETE_INCIDENT_ACTION,
            "incident_id": request.get("incident_id") if isinstance(request, Mapping) else None,
        }
    )


def _validate_complete_commit_request(
    commit_request: Mapping[str, Any],
    *,
    require_commit_time: bool = True,
) -> LifeIncidentCompleteCommitRequest:
    if not isinstance(commit_request, Mapping):
        raise LifeIncidentCompleteCommitValidationError("commit_request must be a mapping.")
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
                "commit_time",
                "user_id",
                "conversation_id",
            },
            "LifeIncidentCompleteCommitRequest",
        )
        schema_version = require_equal(
            commit_request.get("schema_version"),
            SCHEMA_VERSION,
            "LifeIncidentCompleteCommitRequest.schema_version",
        )
        trace_id = require_string(
            commit_request.get("trace_id"),
            "LifeIncidentCompleteCommitRequest.trace_id",
        )
        event_id = require_string(
            commit_request.get("event_id"),
            "LifeIncidentCompleteCommitRequest.event_id",
        )
        event_type = require_supported_value(
            commit_request.get("event_type"),
            {USER_MESSAGE, INCIDENT_COMPLETION},
            "LifeIncidentCompleteCommitRequest.event_type",
        )
        incident_id = require_string(
            commit_request.get("incident_id"),
            "LifeIncidentCompleteCommitRequest.incident_id",
        )
        commit_time = None
        if require_commit_time or "commit_time" in commit_request:
            commit_time = validate_iso8601_timestamp(
                commit_request.get("commit_time"),
                "LifeIncidentCompleteCommitRequest.commit_time",
            )
    except SharedContractValidationError as error:
        raise LifeIncidentCompleteCommitValidationError(str(error), code=error.code) from error

    validated_request: LifeIncidentCompleteCommitRequest = {
        "schema_version": schema_version,
        "trace_id": trace_id,
        "event_id": event_id,
        "event_type": event_type,
        "incident_id": incident_id.strip(),
    }
    if commit_time is not None:
        validated_request["commit_time"] = commit_time
    if event_type == USER_MESSAGE:
        try:
            validated_request["decision_action"] = require_equal(
                commit_request.get("decision_action"),
                VISIBLE_REPLY_ACTION,
                "LifeIncidentCompleteCommitRequest.decision_action",
            )
            validated_request["life_action_type"] = require_equal(
                commit_request.get("life_action_type"),
                COMPLETE_INCIDENT_ACTION,
                "LifeIncidentCompleteCommitRequest.life_action_type",
            )
        except SharedContractValidationError as error:
            raise LifeIncidentCompleteCommitValidationError(str(error), code=error.code) from error
    else:
        if "decision_action" in commit_request or "life_action_type" in commit_request:
            raise LifeIncidentCompleteCommitValidationError(
                "Incident completion event requests must not include model decision fields.",
                code="malformed_commit_input",
            )
    for field_name in ("user_id", "conversation_id"):
        if field_name in commit_request:
            value = commit_request[field_name]
            if value is not None:
                validated_request[field_name] = require_optional_string(
                    value,
                    f"LifeIncidentCompleteCommitRequest.{field_name}",
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
        success_kind=LIFE_INCIDENT_COMPLETED_KIND,
        commit_validation_error_factory=_commit_validation_error,
    )


def _extract_trusted_source_identity(source_event: Any) -> dict[str, str]:
    return extract_trusted_lifecycle_source_identity(
        source_event,
        commit_validation_error_factory=_commit_validation_error,
    )


def _extract_rejectable_incident_completion_source_identity(source_event: Any) -> dict[str, str]:
    if not isinstance(source_event, Mapping):
        raise _commit_validation_error("source_event must be a mapping.", "malformed_commit_input")
    trace_id = _wrap_validation_contract_error(
        lambda: require_string(source_event.get("trace_id"), "source_event.trace_id")
    )
    event_id = _wrap_validation_contract_error(
        lambda: require_string(source_event.get("event_id"), "source_event.event_id")
    )
    _wrap_validation_contract_error(
        lambda: require_equal(source_event.get("type"), INCIDENT_COMPLETION, "source_event.type")
    )
    return {
        "trace_id": trace_id,
        "event_id": event_id,
        "event_type": INCIDENT_COMPLETION,
    }


def _build_rejected_result(
    source_identity: Mapping[str, str],
    failure: Mapping[str, str],
) -> LifeIncidentCompleteCommitResult:
    return build_lifecycle_rejected_result(
        source_identity,
        failure,
        rejected_status=LIFE_INCIDENT_COMPLETE_REJECTED_STATUS,
    )


def _validate_failure(failure: Mapping[str, Any]) -> dict[str, str]:
    return validate_lifecycle_failure(
        failure,
        supported_failure_codes_by_stage=SUPPORTED_FAILURE_CODES_BY_STAGE,
        lifecycle_label="incident-complete",
        commit_validation_error_factory=_commit_validation_error,
    )


def _validate_event_failure(failure: Mapping[str, Any]) -> dict[str, str]:
    return validate_lifecycle_failure(
        failure,
        supported_failure_codes_by_stage=SUPPORTED_EVENT_FAILURE_CODES_BY_STAGE,
        lifecycle_label="incident-completion-event",
        commit_validation_error_factory=_commit_validation_error,
    )


def _build_failure(stage: str, code: str, message: str) -> dict[str, str]:
    return build_lifecycle_failure(
        stage,
        code,
        message,
        supported_failure_codes_by_stage=SUPPORTED_FAILURE_CODES_BY_STAGE,
        finalize_stage=LIFE_INCIDENT_COMPLETE_FINALIZE_STAGE,
    )


def _build_event_failure(stage: str, code: str, message: str) -> dict[str, str]:
    return build_lifecycle_failure(
        stage,
        code,
        message,
        supported_failure_codes_by_stage=SUPPORTED_EVENT_FAILURE_CODES_BY_STAGE,
        finalize_stage=INCIDENT_COMPLETION_EVENT_FINALIZE_STAGE,
    )


def _append_completion_event_rejected_entry(
    source_event: RuntimeEvent,
    *,
    active_incident_snapshot: Any | None,
    completed_incident_snapshot: Any | None,
    failure: Mapping[str, str],
    raw_event_log: RawEventLog,
    id_generator: IdGenerator,
    clock: Clock,
) -> None:
    raw_event_log.append(
        build_life_incident_completion_event_rejected_log_entry(
            source_event,
            active_incident_snapshot=active_incident_snapshot,
            completed_incident_snapshot=completed_incident_snapshot,
            failure=failure,
            id_generator=id_generator,
            clock=clock,
        )
    )


def _stage_completion_event_success(
    finalizer: LifeIncidentCompleteFinalizer,
    finalize_request: Mapping[str, Any],
    *,
    raw_event_log: RawEventLog,
) -> Mapping[str, Any]:
    try:
        _require_finalizer_raw_event_log(finalizer, raw_event_log)
        finalize_result = finalizer.finalize_life_incident_complete(
            deepcopy(dict(finalize_request))
        )
    except RawEventLogQueryValidationError as error:
        raise _finalizer_error(str(error), "malformed_finalize_result") from error
    except Exception as error:
        if isinstance(error, LifeIncidentCompleteFinalizerError):
            raise
        raise _finalizer_error(
            f"finalize_life_incident_complete failed unexpectedly: {error}",
            "finalize_rejected",
        ) from error

    return validate_life_incident_complete_finalize_result(
        finalize_result,
        source_identity=finalize_request,
        committed_log_entry=finalize_request["committed_log_entry"],
    )


def _complete_completion_event_success_after_visible(
    finalizer: LifeIncidentCompleteFinalizer,
    finalize_request: Mapping[str, Any],
) -> None:
    try:
        finalizer.complete_life_incident_complete_after_log_visible(
            deepcopy(dict(finalize_request))
        )
    except RawEventLogQueryValidationError as error:
        raise _finalizer_error(str(error), "malformed_finalize_result") from error
    except Exception as error:
        if isinstance(error, LifeIncidentCompleteFinalizerError):
            raise
        raise _finalizer_error(
            f"complete_life_incident_complete_after_log_visible failed unexpectedly: {error}",
            "finalize_rejected",
        ) from error


def _require_finalizer_raw_event_log(
    finalizer: LifeIncidentCompleteFinalizer,
    raw_event_log: RawEventLog,
) -> None:
    require_lifecycle_finalizer_raw_event_log(
        finalizer,
        raw_event_log,
        specific_method_name="require_life_incident_complete_raw_event_log",
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
        snapshot_name="completed_incident",
        commit_validation_error_factory=_commit_validation_error,
    )


def _append_source_event_id_once(source_event_ids: list[str], event_id: str) -> list[str]:
    return append_lifecycle_source_event_id_once(source_event_ids, event_id)


def _validate_completed_source_event_ids(
    value: Any,
    *,
    active_source_event_ids: list[str],
    event_id: str,
) -> list[str]:
    return validate_lifecycle_source_event_ids(
        value,
        active_source_event_ids=active_source_event_ids,
        event_id=event_id,
        snapshot_name="completed_incident",
        commit_validation_error_factory=_commit_validation_error,
    )


def _wrap_validation_contract_error[T](callback: Callable[[], T]) -> T:
    return wrap_lifecycle_contract_error(
        callback,
        commit_validation_error_factory=_commit_validation_error,
    )


def _snapshot(value: Any) -> Any:
    return snapshot_lifecycle_value(value)


def _error_code(error: Exception, fallback: str) -> str:
    code = getattr(error, "code", fallback)
    return code if isinstance(code, str) else fallback


def _parse_iso8601_timestamp(value: str) -> datetime:
    timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if timestamp.tzinfo is None:
        return timestamp.replace(tzinfo=UTC)
    return timestamp


def _clock_at(timestamp: str) -> Clock:
    parsed_timestamp = _parse_iso8601_timestamp(timestamp)
    return lambda: parsed_timestamp
