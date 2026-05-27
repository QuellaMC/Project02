from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any, Protocol

from character.state.current import (
    ActiveIncidentSource,
    validate_interrupted_incident_snapshot,
)
from commit_effects.incident_lifecycle import (
    append_lifecycle_source_event_id_once,
    build_lifecycle_failure,
    build_lifecycle_rejected_result,
    extract_trusted_lifecycle_source_identity,
    require_lifecycle_finalizer_raw_event_log,
    require_matching_lifecycle_field,
    snapshot_lifecycle_value,
    validate_lifecycle_active_incident_for_commit,
    validate_lifecycle_committed_log_entry,
    validate_lifecycle_failure,
    validate_lifecycle_finalize_result,
    validate_lifecycle_source_event,
    validate_lifecycle_source_event_ids,
)
from runtime.contracts import (
    USER_MESSAGE,
    RuntimeEvent,
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
    RawEventLogQueryValidationError,
    build_raw_log_entry,
    clock_timestamp,
    confirm_committed_success_entry_visibility,
    discard_committed_success_entry_visibility,
)

LIFE_INCIDENT_INTERRUPTED_STATUS = "life_incident_interrupted"
LIFE_INCIDENT_CONTINUED_IN_BACKGROUND_STATUS = "life_incident_continued_in_background"
LIFE_INCIDENT_PROTECTED_FROM_INTERRUPTION_STATUS = "life_incident_protected_from_interruption"
LIFE_INCIDENT_INTERRUPT_SKIPPED_STATUS = "life_incident_interrupt_skipped"
LIFE_INCIDENT_INTERRUPT_REJECTED_STATUS = "life_incident_interrupt_rejected"
LIFE_INCIDENT_INTERRUPTED_KIND = "life_incident_interrupted"
LIFE_INCIDENT_CONTINUED_IN_BACKGROUND_KIND = "life_incident_continued_in_background"
LIFE_INCIDENT_PROTECTED_FROM_INTERRUPTION_KIND = "life_incident_protected_from_interruption"
LIFE_INCIDENT_INTERRUPT_REJECTED_KIND = "life_incident_interrupt_rejected"
LIFE_INCIDENT_INTERRUPT_COMMIT_VALIDATION_STAGE = "life_incident_interrupt_commit_validation"
LIFE_INCIDENT_INTERRUPT_FINALIZE_STAGE = "life_incident_interrupt_finalize"
SUPPORTED_FAILURE_CODES_BY_STAGE = {
    LIFE_INCIDENT_INTERRUPT_COMMIT_VALIDATION_STAGE: {
        "malformed_commit_input",
        "active_incident_source_error",
    },
    LIFE_INCIDENT_INTERRUPT_FINALIZE_STAGE: {
        "finalize_rejected",
        "malformed_finalize_result",
    },
}

LifeIncidentInterruptCommitRequest = dict[str, Any]
LifeIncidentInterruptFinalizeRequest = dict[str, Any]
LifeIncidentInterruptFinalizeResult = dict[str, Any]
LifeIncidentInterruptCommitResult = dict[str, Any]


class LifeIncidentInterruptCommitValidationError(ValueError):
    """Raised when incident-interrupt commit input violates the active contract."""

    def __init__(self, message: str, *, code: str = "malformed_commit_input") -> None:
        super().__init__(message)
        self.code = code


class LifeIncidentInterruptFinalizerError(ValueError):
    """Raised by an injected incident-interrupt finalizer when it rejects a commit."""

    def __init__(self, message: str, *, code: str = "finalize_rejected") -> None:
        super().__init__(message)
        self.code = code


class LifeIncidentInterruptFinalizer(Protocol):
    """MVP-021 atomic incident-interrupt-plus-log finalization boundary."""

    def finalize_life_incident_interrupt(
        self,
        request: LifeIncidentInterruptFinalizeRequest,
    ) -> dict[str, Any]: ...

    def complete_life_incident_interrupt_after_log_visible(
        self,
        request: LifeIncidentInterruptFinalizeRequest,
    ) -> None: ...


def _commit_validation_error(
    message: str,
    code: str,
) -> LifeIncidentInterruptCommitValidationError:
    return LifeIncidentInterruptCommitValidationError(message, code=code)


def _finalizer_error(message: str, code: str) -> LifeIncidentInterruptFinalizerError:
    return LifeIncidentInterruptFinalizerError(message, code=code)


def build_life_incident_interrupt_commit_request(
    source_event: RuntimeEvent,
    active_incident: Mapping[str, Any],
) -> LifeIncidentInterruptCommitRequest:
    event = _validate_source_event(source_event)
    validated_active_incident = _validate_active_incident_for_commit(active_incident)
    payload = event["payload"]
    request: LifeIncidentInterruptCommitRequest = {
        "schema_version": SCHEMA_VERSION,
        "trace_id": event["trace_id"],
        "event_id": event["event_id"],
        "event_type": event["type"],
        "incident_id": validated_active_incident["incident_id"],
    }
    for field_name in ("user_id", "conversation_id"):
        if field_name in payload:
            request[field_name] = payload[field_name]
    return _validate_interrupt_commit_request(request, require_commit_time=False)


def commit_life_incident_interruption(
    source_event: RuntimeEvent,
    *,
    active_incident_source: ActiveIncidentSource,
    life_incident_interrupt_finalizer: LifeIncidentInterruptFinalizer,
    raw_event_log: RawEventLog,
    id_generator: IdGenerator,
    clock: Clock,
) -> LifeIncidentInterruptCommitResult:
    source_identity = _extract_trusted_source_identity(source_event)
    active_incident: Mapping[str, Any] | None = None
    interrupted_incident: Mapping[str, Any] | None = None
    committed_log_entry: RawEventLogEntry | None = None
    finalize_request: LifeIncidentInterruptFinalizeRequest | None = None
    validated_finalize_result: Mapping[str, Any] | None = None

    try:
        event = _validate_source_event(source_event)
        active_incident = _read_active_incident_for_interruption(
            event,
            active_incident_source=active_incident_source,
        )
        if active_incident is None:
            return _build_status_result(source_identity, LIFE_INCIDENT_INTERRUPT_SKIPPED_STATUS)

        interrupt_policy = active_incident["interrupt_policy"]
        if interrupt_policy == "interruptible":
            request = build_life_incident_interrupt_commit_request(event, active_incident)
            commit_time = clock_timestamp(clock)
            request["commit_time"] = commit_time
            interrupted_incident = build_interrupted_life_incident_snapshot(
                active_incident,
                request,
            )
            committed_log_entry = build_life_incident_interrupted_log_entry(
                event,
                active_incident,
                interrupted_incident,
                id_generator=id_generator,
                clock=_clock_at(commit_time),
            )
            finalize_request = build_life_incident_interrupt_finalize_request(
                request,
                active_incident=active_incident,
                interrupted_incident=interrupted_incident,
                committed_log_entry=committed_log_entry,
            )
            validated_finalize_result = _stage_interrupt_success(
                life_incident_interrupt_finalizer,
                finalize_request,
                raw_event_log=raw_event_log,
            )
            try:
                confirm_committed_success_entry_visibility(raw_event_log, committed_log_entry)
            except RawEventLogQueryValidationError as error:
                raise _finalizer_error(str(error), "malformed_finalize_result") from error
            _complete_interrupt_success_after_visible(
                life_incident_interrupt_finalizer,
                finalize_request,
            )
            result = _build_status_result(source_identity, LIFE_INCIDENT_INTERRUPTED_STATUS)
            result["interrupted_incident"] = deepcopy(dict(interrupted_incident))
            result["committed_log_entry_id"] = validated_finalize_result["committed_log_entry_id"]
            return result

        if interrupt_policy == "background":
            return _append_policy_outcome_log(
                event,
                active_incident,
                raw_event_log=raw_event_log,
                id_generator=id_generator,
                clock=clock,
                status=LIFE_INCIDENT_CONTINUED_IN_BACKGROUND_STATUS,
                kind=LIFE_INCIDENT_CONTINUED_IN_BACKGROUND_KIND,
                outcome="continued_in_background",
            )

        if interrupt_policy == "protected":
            return _append_policy_outcome_log(
                event,
                active_incident,
                raw_event_log=raw_event_log,
                id_generator=id_generator,
                clock=clock,
                status=LIFE_INCIDENT_PROTECTED_FROM_INTERRUPTION_STATUS,
                kind=LIFE_INCIDENT_PROTECTED_FROM_INTERRUPTION_KIND,
                outcome="protected_from_interruption",
            )

        raise _commit_validation_error(
            "active_incident.interrupt_policy must be supported.",
            "malformed_commit_input",
        )
    except Exception as error:
        if isinstance(error, LifeIncidentInterruptFinalizerError):
            discard_committed_success_entry_visibility(raw_event_log, committed_log_entry)
            failure = _build_failure(
                LIFE_INCIDENT_INTERRUPT_FINALIZE_STAGE,
                _error_code(error, "finalize_rejected"),
                str(error),
            )
            _append_rejected_entry(
                source_event,
                active_incident_snapshot=active_incident,
                interrupted_incident_snapshot=interrupted_incident,
                failure=failure,
                raw_event_log=raw_event_log,
                id_generator=id_generator,
                clock=clock,
            )
            return _build_rejected_result(source_identity, failure)

        if isinstance(error, LifeIncidentInterruptCommitValidationError):
            failure = _build_failure(
                LIFE_INCIDENT_INTERRUPT_COMMIT_VALIDATION_STAGE,
                _error_code(error, "malformed_commit_input"),
                str(error),
            )
            _append_rejected_entry(
                source_event,
                active_incident_snapshot=active_incident,
                interrupted_incident_snapshot=interrupted_incident,
                failure=failure,
                raw_event_log=raw_event_log,
                id_generator=id_generator,
                clock=clock,
            )
            return _build_rejected_result(source_identity, failure)

        raise


def build_interrupted_life_incident_snapshot(
    active_incident: Mapping[str, Any],
    commit_request: Mapping[str, Any],
) -> dict[str, Any]:
    validated_active_incident = _validate_active_incident_for_commit(active_incident)
    validated_request = _validate_interrupt_commit_request(commit_request)
    if validated_active_incident["interrupt_policy"] != "interruptible":
        raise _commit_validation_error(
            "active_incident.interrupt_policy must be 'interruptible'.",
            "malformed_commit_input",
        )
    source_event_ids = append_lifecycle_source_event_id_once(
        validated_active_incident["source_event_ids"],
        validated_request["event_id"],
    )
    snapshot: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "incident_id": validated_active_incident["incident_id"],
        "type": validated_active_incident["type"],
        "status": "interrupted",
        "title": validated_active_incident["title"],
        "interrupt_policy": "interruptible",
        "resume_policy": validated_active_incident["resume_policy"],
        "interrupted_at": validated_request["commit_time"],
        "source_event_ids": source_event_ids,
    }
    for field_name in ("started_at", "expected_end_at", "remaining_seconds"):
        if field_name in validated_active_incident:
            snapshot[field_name] = validated_active_incident[field_name]
    return validate_interrupted_life_incident_snapshot(
        snapshot,
        active_incident=validated_active_incident,
        commit_request=validated_request,
    )


def build_life_incident_interrupted_log_entry(
    source_event: RuntimeEvent,
    active_incident: Mapping[str, Any],
    interrupted_incident: Mapping[str, Any],
    *,
    id_generator: IdGenerator,
    clock: Clock,
) -> RawEventLogEntry:
    event = _validate_source_event(source_event)
    validated_active_incident = _validate_active_incident_for_commit(active_incident)
    commit_request = {
        "schema_version": SCHEMA_VERSION,
        "trace_id": event["trace_id"],
        "event_id": event["event_id"],
        "event_type": event["type"],
        "incident_id": validated_active_incident["incident_id"],
        "commit_time": interrupted_incident.get("interrupted_at")
        if isinstance(interrupted_incident, Mapping)
        else None,
    }
    validated_interrupted_incident = validate_interrupted_life_incident_snapshot(
        interrupted_incident,
        active_incident=validated_active_incident,
        commit_request=commit_request,
    )

    return build_raw_log_entry(
        trace_id=event["trace_id"],
        event_id=event["event_id"],
        kind=LIFE_INCIDENT_INTERRUPTED_KIND,
        data={
            "source_event": event,
            "active_incident": validated_active_incident,
            "interrupted_incident": validated_interrupted_incident,
        },
        id_generator=id_generator,
        clock=clock,
    )


def build_life_incident_policy_outcome_log_entry(
    source_event: RuntimeEvent,
    active_incident: Mapping[str, Any],
    *,
    kind: str,
    outcome: str,
    id_generator: IdGenerator,
    clock: Clock,
) -> RawEventLogEntry:
    event = _validate_source_event(source_event)
    validated_active_incident = _validate_active_incident_for_commit(active_incident)
    try:
        if kind == LIFE_INCIDENT_CONTINUED_IN_BACKGROUND_KIND:
            require_equal(
                validated_active_incident["interrupt_policy"],
                "background",
                "active_incident.interrupt_policy",
            )
            require_equal(outcome, "continued_in_background", "outcome")
        elif kind == LIFE_INCIDENT_PROTECTED_FROM_INTERRUPTION_KIND:
            require_equal(
                validated_active_incident["interrupt_policy"],
                "protected",
                "active_incident.interrupt_policy",
            )
            require_equal(outcome, "protected_from_interruption", "outcome")
        else:
            raise _commit_validation_error(
                "policy outcome kind is not supported.",
                "malformed_commit_input",
            )
    except SharedContractValidationError as error:
        raise _commit_validation_error(str(error), error.code) from error

    return build_raw_log_entry(
        trace_id=event["trace_id"],
        event_id=event["event_id"],
        kind=kind,
        data={
            "source_event": event,
            "active_incident": validated_active_incident,
            "outcome": outcome,
        },
        id_generator=id_generator,
        clock=clock,
    )


def build_life_incident_interrupt_finalize_request(
    commit_request: Mapping[str, Any],
    *,
    active_incident: Mapping[str, Any],
    interrupted_incident: Mapping[str, Any],
    committed_log_entry: Mapping[str, Any],
) -> LifeIncidentInterruptFinalizeRequest:
    validated_request = _validate_interrupt_commit_request(commit_request)
    validated_active_incident = _validate_active_incident_for_commit(active_incident)
    validated_interrupted_incident = validate_interrupted_life_incident_snapshot(
        interrupted_incident,
        active_incident=validated_active_incident,
        commit_request=validated_request,
    )
    validated_committed_log_entry = _validate_committed_log_entry(
        committed_log_entry,
        source_identity=validated_request,
        active_incident=validated_active_incident,
        interrupted_incident=validated_interrupted_incident,
    )
    finalized_request = deepcopy(dict(validated_request))
    finalized_request["active_incident"] = validated_active_incident
    finalized_request["interrupted_incident"] = validated_interrupted_incident
    finalized_request["committed_log_entry"] = validated_committed_log_entry
    return finalized_request


def validate_life_incident_interrupt_finalize_result(
    finalize_result: Any,
    *,
    source_identity: Mapping[str, str],
    committed_log_entry: Mapping[str, Any],
) -> LifeIncidentInterruptFinalizeResult:
    return validate_lifecycle_finalize_result(
        finalize_result,
        source_identity=source_identity,
        committed_log_entry=committed_log_entry,
        result_name="LifeIncidentInterruptFinalizeResult",
        finalizer_error_factory=_finalizer_error,
    )


def build_life_incident_interrupt_rejected_log_entry(
    source_event: RuntimeEvent,
    *,
    active_incident_snapshot: Any | None,
    interrupted_incident_snapshot: Any | None,
    failure: Mapping[str, Any],
    id_generator: IdGenerator,
    clock: Clock,
) -> RawEventLogEntry:
    source_identity = _extract_trusted_source_identity(source_event)
    validated_failure = _validate_failure(failure)
    data: dict[str, Any] = {
        "source_event": _snapshot(source_event),
        "failure": validated_failure,
    }
    if active_incident_snapshot is not None:
        data["active_incident_snapshot"] = _snapshot(active_incident_snapshot)
    if interrupted_incident_snapshot is not None:
        data["interrupted_incident_snapshot"] = _snapshot(interrupted_incident_snapshot)

    return build_raw_log_entry(
        trace_id=source_identity["trace_id"],
        event_id=source_identity["event_id"],
        kind=LIFE_INCIDENT_INTERRUPT_REJECTED_KIND,
        data=data,
        id_generator=id_generator,
        clock=clock,
    )


def validate_interrupted_life_incident_snapshot(
    snapshot: Any,
    *,
    active_incident: Mapping[str, Any],
    commit_request: Mapping[str, Any],
) -> dict[str, Any]:
    try:
        normalized_snapshot = validate_interrupted_incident_snapshot(snapshot)
    except SharedContractValidationError as error:
        raise LifeIncidentInterruptCommitValidationError(str(error), code=error.code) from error

    validated_active_incident = _validate_active_incident_for_commit(active_incident)
    validated_request = _validate_interrupt_commit_request(commit_request)
    incident_id = normalized_snapshot["incident_id"]
    if incident_id != validated_active_incident["incident_id"]:
        raise LifeIncidentInterruptCommitValidationError(
            "interrupted_incident.incident_id must match active_incident.incident_id."
        )
    if incident_id != validated_request["incident_id"]:
        raise LifeIncidentInterruptCommitValidationError(
            "interrupted_incident.incident_id must match "
            "LifeIncidentInterruptCommitRequest.incident_id."
        )
    if normalized_snapshot["interrupted_at"] != validated_request["commit_time"]:
        raise LifeIncidentInterruptCommitValidationError(
            "interrupted_incident.interrupted_at must match commit_time."
        )
    normalized_snapshot["type"] = _require_matching_field(
        normalized_snapshot,
        validated_active_incident,
        "type",
    )
    normalized_snapshot["title"] = _require_matching_field(
        normalized_snapshot,
        validated_active_incident,
        "title",
    )
    normalized_snapshot["interrupt_policy"] = _require_matching_field(
        normalized_snapshot,
        validated_active_incident,
        "interrupt_policy",
    )
    if normalized_snapshot["interrupt_policy"] != "interruptible":
        raise LifeIncidentInterruptCommitValidationError(
            "interrupted_incident.interrupt_policy must be 'interruptible'."
        )
    normalized_snapshot["resume_policy"] = _require_matching_field(
        normalized_snapshot,
        validated_active_incident,
        "resume_policy",
    )
    normalized_snapshot["source_event_ids"] = validate_lifecycle_source_event_ids(
        normalized_snapshot.get("source_event_ids"),
        active_source_event_ids=validated_active_incident["source_event_ids"],
        event_id=validated_request["event_id"],
        snapshot_name="interrupted_incident",
        commit_validation_error_factory=_commit_validation_error,
    )
    for field_name in ("started_at", "expected_end_at", "remaining_seconds"):
        if field_name in validated_active_incident:
            normalized_snapshot[field_name] = _require_matching_field(
                normalized_snapshot,
                validated_active_incident,
                field_name,
            )
        elif field_name in normalized_snapshot:
            raise LifeIncidentInterruptCommitValidationError(
                f"interrupted_incident.{field_name} must be omitted when active_incident omits it."
            )
    return normalized_snapshot


def _read_active_incident_for_interruption(
    source_event: RuntimeEvent,
    *,
    active_incident_source: ActiveIncidentSource,
) -> dict[str, Any] | None:
    event = _validate_source_event(source_event)
    from character.state.current import build_active_incident_request

    request = build_active_incident_request(event)
    try:
        active_incident = active_incident_source.read_active_incident(deepcopy(request))
    except Exception as error:
        raise _commit_validation_error(
            f"active_incident_source.read_active_incident failed unexpectedly: {error}",
            "active_incident_source_error",
        ) from error
    if active_incident is None:
        return None
    return _validate_active_incident_for_commit(active_incident)


def _append_policy_outcome_log(
    event: RuntimeEvent,
    active_incident: Mapping[str, Any],
    *,
    raw_event_log: RawEventLog,
    id_generator: IdGenerator,
    clock: Clock,
    status: str,
    kind: str,
    outcome: str,
) -> LifeIncidentInterruptCommitResult:
    committed_log_entry = build_life_incident_policy_outcome_log_entry(
        event,
        active_incident,
        kind=kind,
        outcome=outcome,
        id_generator=id_generator,
        clock=clock,
    )
    try:
        raw_event_log.append(committed_log_entry)
    except RawEventLogQueryValidationError as error:
        raise _commit_validation_error(str(error), "malformed_commit_input") from error
    result = _build_status_result(
        _extract_trusted_source_identity(event),
        status,
    )
    result["active_incident"] = deepcopy(dict(active_incident))
    result["committed_log_entry_id"] = committed_log_entry["log_id"]
    return result


def _stage_interrupt_success(
    finalizer: LifeIncidentInterruptFinalizer,
    finalize_request: Mapping[str, Any],
    *,
    raw_event_log: RawEventLog,
) -> Mapping[str, Any]:
    try:
        _require_finalizer_raw_event_log(finalizer, raw_event_log)
        finalize_result = finalizer.finalize_life_incident_interrupt(
            deepcopy(dict(finalize_request))
        )
    except RawEventLogQueryValidationError as error:
        raise _finalizer_error(str(error), "malformed_finalize_result") from error
    except Exception as error:
        if isinstance(error, LifeIncidentInterruptFinalizerError):
            raise
        raise _finalizer_error(
            f"finalize_life_incident_interrupt failed unexpectedly: {error}",
            "finalize_rejected",
        ) from error

    return validate_life_incident_interrupt_finalize_result(
        finalize_result,
        source_identity=finalize_request,
        committed_log_entry=finalize_request["committed_log_entry"],
    )


def _complete_interrupt_success_after_visible(
    finalizer: LifeIncidentInterruptFinalizer,
    finalize_request: Mapping[str, Any],
) -> None:
    try:
        finalizer.complete_life_incident_interrupt_after_log_visible(
            deepcopy(dict(finalize_request))
        )
    except Exception as error:
        if isinstance(error, LifeIncidentInterruptFinalizerError):
            raise
        raise _finalizer_error(
            f"complete_life_incident_interrupt_after_log_visible failed unexpectedly: {error}",
            "finalize_rejected",
        ) from error


def _append_rejected_entry(
    source_event: RuntimeEvent,
    *,
    active_incident_snapshot: Any | None,
    interrupted_incident_snapshot: Any | None,
    failure: Mapping[str, str],
    raw_event_log: RawEventLog,
    id_generator: IdGenerator,
    clock: Clock,
) -> None:
    raw_event_log.append(
        build_life_incident_interrupt_rejected_log_entry(
            source_event,
            active_incident_snapshot=active_incident_snapshot,
            interrupted_incident_snapshot=interrupted_incident_snapshot,
            failure=failure,
            id_generator=id_generator,
            clock=clock,
        )
    )


def _validate_interrupt_commit_request(
    commit_request: Mapping[str, Any],
    *,
    require_commit_time: bool = True,
) -> LifeIncidentInterruptCommitRequest:
    if not isinstance(commit_request, Mapping):
        raise LifeIncidentInterruptCommitValidationError("commit_request must be a mapping.")
    allowed_keys = {
        "schema_version",
        "trace_id",
        "event_id",
        "event_type",
        "incident_id",
        "user_id",
        "conversation_id",
    }
    if require_commit_time:
        allowed_keys.add("commit_time")
    elif "commit_time" in commit_request:
        allowed_keys.add("commit_time")
    try:
        reject_extra_keys(
            commit_request,
            allowed_keys,
            "LifeIncidentInterruptCommitRequest",
        )
        schema_version = require_equal(
            commit_request.get("schema_version"),
            SCHEMA_VERSION,
            "LifeIncidentInterruptCommitRequest.schema_version",
        )
        trace_id = require_string(
            commit_request.get("trace_id"),
            "LifeIncidentInterruptCommitRequest.trace_id",
        )
        event_id = require_string(
            commit_request.get("event_id"),
            "LifeIncidentInterruptCommitRequest.event_id",
        )
        event_type = require_equal(
            commit_request.get("event_type"),
            USER_MESSAGE,
            "LifeIncidentInterruptCommitRequest.event_type",
        )
        incident_id = require_string(
            commit_request.get("incident_id"),
            "LifeIncidentInterruptCommitRequest.incident_id",
        )
        commit_time = (
            validate_iso8601_timestamp(
                commit_request.get("commit_time"),
                "LifeIncidentInterruptCommitRequest.commit_time",
            )
            if require_commit_time or "commit_time" in commit_request
            else None
        )
    except SharedContractValidationError as error:
        raise LifeIncidentInterruptCommitValidationError(str(error), code=error.code) from error

    validated_request: LifeIncidentInterruptCommitRequest = {
        "schema_version": schema_version,
        "trace_id": trace_id,
        "event_id": event_id,
        "event_type": event_type,
        "incident_id": incident_id.strip(),
    }
    if commit_time is not None:
        validated_request["commit_time"] = commit_time
    for field_name in ("user_id", "conversation_id"):
        if field_name in commit_request:
            value = commit_request[field_name]
            if value is not None:
                validated_request[field_name] = require_optional_string(
                    value,
                    f"LifeIncidentInterruptCommitRequest.{field_name}",
                )
    return validated_request


def _validate_committed_log_entry(
    committed_log_entry: Any,
    *,
    source_identity: Mapping[str, str],
    active_incident: Mapping[str, Any],
    interrupted_incident: Mapping[str, Any],
) -> dict[str, Any]:
    entry = validate_lifecycle_committed_log_entry(
        committed_log_entry,
        source_identity=source_identity,
        success_kind=LIFE_INCIDENT_INTERRUPTED_KIND,
        commit_validation_error_factory=_commit_validation_error,
    )
    data = entry["data"]
    if data.get("active_incident") != dict(active_incident):
        raise LifeIncidentInterruptCommitValidationError(
            "committed_log_entry.data.active_incident must match active_incident."
        )
    if data.get("interrupted_incident") != dict(interrupted_incident):
        raise LifeIncidentInterruptCommitValidationError(
            "committed_log_entry.data.interrupted_incident must match interrupted_incident."
        )
    return entry


def _validate_source_event(source_event: Any) -> RuntimeEvent:
    return validate_lifecycle_source_event(
        source_event,
        commit_validation_error_factory=_commit_validation_error,
    )


def _validate_active_incident_for_commit(active_incident: Any) -> dict[str, Any]:
    return validate_lifecycle_active_incident_for_commit(
        active_incident,
        commit_validation_error_factory=_commit_validation_error,
    )


def _extract_trusted_source_identity(source_event: Any) -> dict[str, str]:
    return extract_trusted_lifecycle_source_identity(
        source_event,
        commit_validation_error_factory=_commit_validation_error,
    )


def _build_status_result(source_identity: Mapping[str, str], status: str) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "trace_id": source_identity["trace_id"],
        "event_id": source_identity["event_id"],
        "event_type": source_identity["event_type"],
        "status": status,
    }


def _build_rejected_result(
    source_identity: Mapping[str, str],
    failure: Mapping[str, str],
) -> LifeIncidentInterruptCommitResult:
    return build_lifecycle_rejected_result(
        source_identity,
        failure,
        rejected_status=LIFE_INCIDENT_INTERRUPT_REJECTED_STATUS,
    )


def _validate_failure(failure: Mapping[str, Any]) -> dict[str, str]:
    return validate_lifecycle_failure(
        failure,
        supported_failure_codes_by_stage=SUPPORTED_FAILURE_CODES_BY_STAGE,
        lifecycle_label="incident-interrupt",
        commit_validation_error_factory=_commit_validation_error,
    )


def _build_failure(stage: str, code: str, message: str) -> dict[str, str]:
    return build_lifecycle_failure(
        stage,
        code,
        message,
        supported_failure_codes_by_stage=SUPPORTED_FAILURE_CODES_BY_STAGE,
        finalize_stage=LIFE_INCIDENT_INTERRUPT_FINALIZE_STAGE,
    )


def _require_finalizer_raw_event_log(
    finalizer: LifeIncidentInterruptFinalizer,
    raw_event_log: RawEventLog,
) -> None:
    require_lifecycle_finalizer_raw_event_log(
        finalizer,
        raw_event_log,
        specific_method_name="require_life_incident_interrupt_raw_event_log",
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
        snapshot_name="interrupted_incident",
        commit_validation_error_factory=_commit_validation_error,
    )


def _error_code(error: Exception, fallback: str) -> str:
    code = getattr(error, "code", fallback)
    return code if isinstance(code, str) else fallback


def _snapshot(value: Any) -> Any:
    return snapshot_lifecycle_value(value)


def _clock_at(timestamp: str) -> Clock:
    validated_timestamp = validate_iso8601_timestamp(timestamp, "timestamp")
    parsed_timestamp = datetime.fromisoformat(validated_timestamp.replace("Z", "+00:00"))
    if parsed_timestamp.tzinfo is None:
        parsed_timestamp = parsed_timestamp.replace(tzinfo=UTC)
    return lambda: parsed_timestamp
