from __future__ import annotations

from collections.abc import Callable, Mapping
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any, Protocol

from character.state.current import (
    ActiveIncidentSource,
    build_active_incident_request,
    validate_active_incident_snapshot,
)
from runtime.contracts import (
    COMPLETE_INCIDENT_ACTION,
    USER_MESSAGE,
    VISIBLE_REPLY_ACTION,
    RuntimeEvent,
    normalize_complete_incident_life_action,
    normalize_role_model_turn_result,
    normalize_visible_reply_decision_with_optional_life_action,
    reject_extra_keys,
    require_equal,
    require_optional_string,
    require_string,
    validate_iso8601_timestamp,
    validate_normalized_user_message_event,
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
    validate_raw_event_log_entry,
)

LIFE_INCIDENT_COMPLETED_STATUS = "life_incident_completed"
LIFE_INCIDENT_COMPLETE_SKIPPED_STATUS = "life_incident_complete_skipped"
LIFE_INCIDENT_COMPLETE_REJECTED_STATUS = "life_incident_complete_rejected"
LIFE_INCIDENT_COMPLETED_KIND = "life_incident_completed"
LIFE_INCIDENT_COMPLETE_REJECTED_KIND = "life_incident_complete_rejected"
LIFE_INCIDENT_COMPLETE_COMMIT_VALIDATION_STAGE = "life_incident_complete_commit_validation"
LIFE_INCIDENT_COMPLETE_FINALIZE_STAGE = "life_incident_complete_finalize"
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

RoleModelTurnResult = dict[str, Any]
LifeIncidentCompleteCommitRequest = dict[str, Any]
LifeIncidentCompleteFinalizeRequest = dict[str, Any]
LifeIncidentCompleteFinalizeResult = dict[str, Any]
LifeIncidentCompleteCommitResult = dict[str, Any]


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
    request: LifeIncidentCompleteCommitRequest | None = None
    life_action: Mapping[str, Any] | None = None
    active_incident: Mapping[str, Any] | None = None
    completed_incident: Mapping[str, Any] | None = None
    committed_log_entry: RawEventLogEntry | None = None
    finalize_request: LifeIncidentCompleteFinalizeRequest | None = None

    try:
        request = build_life_incident_complete_commit_request(source_event, role_model_result)
        if request is None:
            return {
                "schema_version": SCHEMA_VERSION,
                "trace_id": source_identity["trace_id"],
                "event_id": source_identity["event_id"],
                "event_type": USER_MESSAGE,
                "status": LIFE_INCIDENT_COMPLETE_SKIPPED_STATUS,
            }
        life_action = _life_action_from_commit_request(request)
        active_incident = _read_active_incident_for_complete(
            source_event,
            active_incident_source=active_incident_source,
        )
        if active_incident["incident_id"] != request["incident_id"]:
            raise LifeIncidentCompleteCommitValidationError(
                "life_action.incident_id must match the current active incident.",
                code="incident_id_mismatch",
            )
        commit_time = clock_timestamp(clock)
        request["commit_time"] = commit_time
        completed_incident = build_completed_life_incident_snapshot(
            active_incident,
            request,
        )
        committed_log_entry = build_life_incident_completed_log_entry(
            source_event,
            role_model_result,
            life_action,
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
        try:
            _require_finalizer_raw_event_log(
                life_incident_complete_finalizer,
                raw_event_log,
            )
            finalize_result = life_incident_complete_finalizer.finalize_life_incident_complete(
                deepcopy(finalize_request)
            )
        except RawEventLogQueryValidationError as error:
            raise LifeIncidentCompleteFinalizerError(
                str(error),
                code="malformed_finalize_result",
            ) from error
        except LifeIncidentCompleteFinalizerError:
            raise
        except Exception as error:
            raise LifeIncidentCompleteFinalizerError(
                f"finalize_life_incident_complete failed unexpectedly: {error}",
                code="finalize_rejected",
            ) from error
        validated_finalize_result = validate_life_incident_complete_finalize_result(
            finalize_result,
            source_identity=source_identity,
            committed_log_entry=committed_log_entry,
        )
        try:
            confirm_committed_success_entry_visibility(raw_event_log, committed_log_entry)
        except RawEventLogQueryValidationError as error:
            raise LifeIncidentCompleteFinalizerError(
                str(error),
                code="malformed_finalize_result",
            ) from error
        try:
            life_incident_complete_finalizer.complete_life_incident_complete_after_log_visible(
                deepcopy(finalize_request)
            )
        except RawEventLogQueryValidationError as error:
            raise LifeIncidentCompleteFinalizerError(
                str(error),
                code="malformed_finalize_result",
            ) from error
        except LifeIncidentCompleteFinalizerError:
            raise
        except Exception as error:
            raise LifeIncidentCompleteFinalizerError(
                (f"complete_life_incident_complete_after_log_visible failed unexpectedly: {error}"),
                code="finalize_rejected",
            ) from error
    except LifeIncidentCompleteFinalizerError as error:
        discard_committed_success_entry_visibility(raw_event_log, committed_log_entry)
        failure = _build_failure(
            LIFE_INCIDENT_COMPLETE_FINALIZE_STAGE,
            error.code,
            str(error),
        )
        raw_event_log.append(
            build_life_incident_complete_rejected_log_entry(
                source_event,
                role_model_result_snapshot=role_model_result,
                life_action_snapshot=life_action,
                active_incident_snapshot=active_incident,
                completed_incident_snapshot=completed_incident,
                failure=failure,
                id_generator=id_generator,
                clock=clock,
            )
        )
        return _build_rejected_result(source_identity, failure)
    except LifeIncidentCompleteCommitValidationError as error:
        failure = _build_failure(
            LIFE_INCIDENT_COMPLETE_COMMIT_VALIDATION_STAGE,
            error.code,
            str(error),
        )
        raw_event_log.append(
            build_life_incident_complete_rejected_log_entry(
                source_event,
                role_model_result_snapshot=role_model_result,
                life_action_snapshot=life_action,
                active_incident_snapshot=active_incident,
                completed_incident_snapshot=completed_incident,
                failure=failure,
                id_generator=id_generator,
                clock=clock,
            )
        )
        return _build_rejected_result(source_identity, failure)

    return {
        "schema_version": SCHEMA_VERSION,
        "trace_id": source_identity["trace_id"],
        "event_id": source_identity["event_id"],
        "event_type": USER_MESSAGE,
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
    if not isinstance(finalize_result, Mapping):
        raise LifeIncidentCompleteFinalizerError(
            "LifeIncidentCompleteFinalizeResult must be a mapping.",
            code="malformed_finalize_result",
        )
    try:
        reject_extra_keys(
            finalize_result,
            {
                "schema_version",
                "trace_id",
                "event_id",
                "event_type",
                "committed_log_entry_id",
            },
            "LifeIncidentCompleteFinalizeResult",
        )
        schema_version = require_equal(
            finalize_result.get("schema_version"),
            SCHEMA_VERSION,
            "LifeIncidentCompleteFinalizeResult.schema_version",
        )
        trace_id = require_string(
            finalize_result.get("trace_id"),
            "LifeIncidentCompleteFinalizeResult.trace_id",
        )
        event_id = require_string(
            finalize_result.get("event_id"),
            "LifeIncidentCompleteFinalizeResult.event_id",
        )
        event_type = require_equal(
            finalize_result.get("event_type"),
            USER_MESSAGE,
            "LifeIncidentCompleteFinalizeResult.event_type",
        )
        committed_log_entry_id = require_string(
            finalize_result.get("committed_log_entry_id"),
            "LifeIncidentCompleteFinalizeResult.committed_log_entry_id",
        )
    except SharedContractValidationError as error:
        raise LifeIncidentCompleteFinalizerError(
            str(error),
            code="malformed_finalize_result",
        ) from error

    if trace_id != source_identity["trace_id"]:
        raise LifeIncidentCompleteFinalizerError(
            "LifeIncidentCompleteFinalizeResult.trace_id must match source_event.trace_id.",
            code="malformed_finalize_result",
        )
    if event_id != source_identity["event_id"]:
        raise LifeIncidentCompleteFinalizerError(
            "LifeIncidentCompleteFinalizeResult.event_id must match source_event.event_id.",
            code="malformed_finalize_result",
        )
    if not isinstance(committed_log_entry, Mapping):
        raise LifeIncidentCompleteFinalizerError(
            "committed_log_entry must be a mapping.",
            code="malformed_finalize_result",
        )
    try:
        expected_log_id = require_string(
            committed_log_entry.get("log_id"),
            "committed_log_entry.log_id",
        )
    except SharedContractValidationError as error:
        raise LifeIncidentCompleteFinalizerError(
            str(error),
            code="malformed_finalize_result",
        ) from error
    if committed_log_entry_id != expected_log_id:
        raise LifeIncidentCompleteFinalizerError(
            (
                "LifeIncidentCompleteFinalizeResult.committed_log_entry_id must match "
                "committed_log_entry.log_id."
            ),
            code="malformed_finalize_result",
        )

    return {
        "schema_version": schema_version,
        "trace_id": trace_id,
        "event_id": event_id,
        "event_type": event_type,
        "committed_log_entry_id": committed_log_entry_id,
    }


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
    return _wrap_validation_contract_error(
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
    return _wrap_validation_contract_error(
        lambda: normalize_role_model_turn_result(
            role_model_result,
            source_event=source_event,
            decision_normalizer=lambda decision: (
                normalize_visible_reply_decision_with_optional_life_action(
                    decision,
                    trace_id=source_event["trace_id"],
                    event_id=source_event["event_id"],
                    require_attached_ids=True,
                    allow_life_action=True,
                    allowed_life_action_type=COMPLETE_INCIDENT_ACTION,
                    source_name="CharacterDecision",
                )
            ),
        )
    )


def _read_active_incident_for_complete(
    source_event: RuntimeEvent,
    *,
    active_incident_source: ActiveIncidentSource,
) -> dict[str, Any]:
    event = _validate_source_event(source_event)
    request = build_active_incident_request(event)
    try:
        active_incident = active_incident_source.read_active_incident(deepcopy(request))
    except Exception as error:
        raise LifeIncidentCompleteCommitValidationError(
            f"active_incident_source.read_active_incident failed unexpectedly: {error}",
            code="active_incident_source_error",
        ) from error
    if active_incident is None:
        raise LifeIncidentCompleteCommitValidationError(
            "No active incident exists for this source-event scope.",
            code="no_active_incident",
        )
    return _validate_active_incident_for_commit(active_incident)


def _validate_active_incident_for_commit(active_incident: Any) -> dict[str, Any]:
    try:
        return validate_active_incident_snapshot(active_incident)
    except SharedContractValidationError as error:
        raise LifeIncidentCompleteCommitValidationError(str(error), code=error.code) from error


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
        event_type = require_equal(
            commit_request.get("event_type"),
            USER_MESSAGE,
            "LifeIncidentCompleteCommitRequest.event_type",
        )
        decision_action = require_equal(
            commit_request.get("decision_action"),
            VISIBLE_REPLY_ACTION,
            "LifeIncidentCompleteCommitRequest.decision_action",
        )
        life_action_type = require_equal(
            commit_request.get("life_action_type"),
            COMPLETE_INCIDENT_ACTION,
            "LifeIncidentCompleteCommitRequest.life_action_type",
        )
        incident_id = require_string(
            commit_request.get("incident_id"),
            "LifeIncidentCompleteCommitRequest.incident_id",
        )
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
        "decision_action": decision_action,
        "life_action_type": life_action_type,
        "incident_id": incident_id.strip(),
        "commit_time": commit_time,
    }
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
    try:
        entry = validate_raw_event_log_entry(committed_log_entry)
        require_equal(
            entry["trace_id"], source_identity["trace_id"], "committed_log_entry.trace_id"
        )
        require_equal(
            entry["event_id"], source_identity["event_id"], "committed_log_entry.event_id"
        )
        require_equal(entry["kind"], LIFE_INCIDENT_COMPLETED_KIND, "committed_log_entry.kind")
    except (SharedContractValidationError, RawEventLogQueryValidationError) as error:
        raise LifeIncidentCompleteCommitValidationError(str(error)) from error
    return entry


def _extract_trusted_source_identity(source_event: Any) -> dict[str, str]:
    if not isinstance(source_event, Mapping):
        raise LifeIncidentCompleteCommitValidationError("source_event must be a mapping.")
    trace_id = _wrap_validation_contract_error(
        lambda: require_string(source_event.get("trace_id"), "trace_id")
    )
    event_id = _wrap_validation_contract_error(
        lambda: require_string(source_event.get("event_id"), "event_id")
    )
    return {
        "trace_id": trace_id,
        "event_id": event_id,
        "event_type": USER_MESSAGE,
    }


def _build_rejected_result(
    source_identity: Mapping[str, str],
    failure: Mapping[str, str],
) -> LifeIncidentCompleteCommitResult:
    return {
        "schema_version": SCHEMA_VERSION,
        "trace_id": source_identity["trace_id"],
        "event_id": source_identity["event_id"],
        "event_type": USER_MESSAGE,
        "status": LIFE_INCIDENT_COMPLETE_REJECTED_STATUS,
        "failure": deepcopy(dict(failure)),
    }


def _validate_failure(failure: Mapping[str, Any]) -> dict[str, str]:
    if not isinstance(failure, Mapping):
        raise LifeIncidentCompleteCommitValidationError("failure must be a mapping.")
    _wrap_validation_contract_error(
        lambda: reject_extra_keys(failure, {"stage", "code", "message"}, "failure")
    )
    stage = failure.get("stage")
    if stage not in SUPPORTED_FAILURE_CODES_BY_STAGE:
        raise LifeIncidentCompleteCommitValidationError(
            "failure.stage must be a supported incident-complete failure stage."
        )
    code = failure.get("code")
    if code not in SUPPORTED_FAILURE_CODES_BY_STAGE[stage]:
        raise LifeIncidentCompleteCommitValidationError(
            "failure.code must be supported for failure.stage."
        )
    return {
        "stage": stage,
        "code": code,
        "message": _wrap_validation_contract_error(
            lambda: require_string(failure.get("message"), "failure.message")
        ),
    }


def _build_failure(stage: str, code: str, message: str) -> dict[str, str]:
    supported_codes = SUPPORTED_FAILURE_CODES_BY_STAGE[stage]
    if code not in supported_codes:
        code = (
            "malformed_finalize_result"
            if stage == LIFE_INCIDENT_COMPLETE_FINALIZE_STAGE
            else "malformed_commit_input"
        )
    return {"stage": stage, "code": code, "message": message}


def _require_finalizer_raw_event_log(
    finalizer: LifeIncidentCompleteFinalizer,
    raw_event_log: RawEventLog,
) -> None:
    require_raw_event_log = getattr(finalizer, "require_life_incident_complete_raw_event_log", None)
    if not callable(require_raw_event_log):
        require_raw_event_log = getattr(finalizer, "require_raw_event_log", None)
    if callable(require_raw_event_log):
        try:
            require_raw_event_log(raw_event_log)
        except Exception as error:
            code = getattr(error, "code", "malformed_finalize_result")
            raise LifeIncidentCompleteFinalizerError(str(error), code=code) from error


def _require_matching_field(
    snapshot: Mapping[str, Any],
    active_incident: Mapping[str, Any],
    field_name: str,
) -> Any:
    if snapshot.get(field_name) != active_incident[field_name]:
        raise LifeIncidentCompleteCommitValidationError(
            f"completed_incident.{field_name} must match active_incident.{field_name}."
        )
    return snapshot[field_name]


def _append_source_event_id_once(source_event_ids: list[str], event_id: str) -> list[str]:
    if event_id in source_event_ids:
        return list(source_event_ids)
    return [*source_event_ids, event_id]


def _validate_completed_source_event_ids(
    value: Any,
    *,
    active_source_event_ids: list[str],
    event_id: str,
) -> list[str]:
    if not isinstance(value, list):
        raise LifeIncidentCompleteCommitValidationError(
            "completed_incident.source_event_ids must be a list."
        )
    source_event_ids: list[str] = []
    for source_event_id in value:
        source_event_ids.append(
            _wrap_validation_contract_error(
                lambda: require_string(
                    source_event_id,
                    "completed_incident.source_event_ids[]",
                )
            )
        )
    expected_source_event_ids = _append_source_event_id_once(active_source_event_ids, event_id)
    if source_event_ids != expected_source_event_ids:
        raise LifeIncidentCompleteCommitValidationError(
            "completed_incident.source_event_ids must preserve active IDs and append event_id once."
        )
    return source_event_ids


def _parse_iso8601_timestamp(value: str) -> datetime:
    timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if timestamp.tzinfo is None:
        return timestamp.replace(tzinfo=UTC)
    return timestamp


def _clock_at(timestamp: str) -> Clock:
    parsed_timestamp = _parse_iso8601_timestamp(timestamp)
    return lambda: parsed_timestamp


def _wrap_validation_contract_error[T](callback: Callable[[], T]) -> T:
    try:
        return callback()
    except SharedContractValidationError as error:
        code = "malformed_commit_input" if error.code == "invalid_contract" else error.code
        raise LifeIncidentCompleteCommitValidationError(str(error), code=code) from error


def _snapshot(value: Any) -> Any:
    if isinstance(value, Mapping):
        return deepcopy(dict(value))
    return {"raw_value": repr(value)}
