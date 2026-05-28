from __future__ import annotations

from collections.abc import Callable, Mapping
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any, Protocol

from character.state.current import validate_active_incident_snapshot
from runtime.contracts import (
    START_INCIDENT_ACTION,
    USER_MESSAGE,
    VISIBLE_REPLY_ACTION,
    RuntimeEvent,
    normalize_role_model_turn_result,
    normalize_start_incident_life_action,
    normalize_visible_reply_decision_with_optional_life_action,
    reject_extra_keys,
    require_equal,
    require_string,
    validate_iso8601_timestamp,
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
    RawEventLogQueryValidationError,
    build_raw_log_entry,
    clock_timestamp,
    confirm_committed_success_entry_visibility,
    discard_committed_success_entry_visibility,
    generate_id,
)

LIFE_INCIDENT_STARTED_STATUS = "life_incident_started"
LIFE_INCIDENT_START_SKIPPED_STATUS = "life_incident_start_skipped"
LIFE_INCIDENT_START_REJECTED_STATUS = "life_incident_start_rejected"
LIFE_INCIDENT_STARTED_KIND = "life_incident_started"
LIFE_INCIDENT_START_REJECTED_KIND = "life_incident_start_rejected"
LIFE_INCIDENT_START_COMMIT_VALIDATION_STAGE = "life_incident_start_commit_validation"
LIFE_INCIDENT_START_FINALIZE_STAGE = "life_incident_start_finalize"
SUPPORTED_FAILURE_CODES_BY_STAGE = {
    LIFE_INCIDENT_START_COMMIT_VALIDATION_STAGE: {
        "malformed_commit_input",
        "identity_mismatch",
        "unsupported_result_status",
        "unsupported_action",
        "empty_reply_text",
    },
    LIFE_INCIDENT_START_FINALIZE_STAGE: {
        "finalize_rejected",
        "malformed_finalize_result",
    },
}

RoleModelTurnResult = dict[str, Any]
LifeIncidentStartCommitRequest = dict[str, Any]
LifeIncidentStartFinalizeRequest = dict[str, Any]
LifeIncidentStartFinalizeResult = dict[str, Any]
LifeIncidentStartCommitResult = dict[str, Any]


class LifeIncidentStartCommitValidationError(ValueError):
    """Raised when incident-start commit input violates the active contract."""

    def __init__(self, message: str, *, code: str = "malformed_commit_input") -> None:
        super().__init__(message)
        self.code = code


class LifeIncidentStartFinalizerError(ValueError):
    """Raised by an injected incident-start finalizer when it rejects a commit."""

    def __init__(self, message: str, *, code: str = "finalize_rejected") -> None:
        super().__init__(message)
        self.code = code


class LifeIncidentStartFinalizer(Protocol):
    """MVP-012 atomic incident-plus-log finalization boundary.

    A successful return means this boundary has durably exposed both the started
    active incident and matching life_incident_started RawEventLogEntry. The
    ordinary raw_event_log.append() path is not used for this success log; the
    finalizer is the Raw Event Log visibility boundary for the success record.
    If it cannot expose both artifacts together, it must raise before exposing
    either artifact.

    In-memory finalizers that stage mutable state before raw-log confirmation
    may optionally expose complete_life_incident_start_after_log_visible() and
    discard_life_incident_start_after_log_not_visible() hooks.
    """

    def finalize_life_incident_start(
        self,
        request: LifeIncidentStartFinalizeRequest,
    ) -> dict[str, Any]: ...


def build_life_incident_start_commit_request(
    source_event: RuntimeEvent,
    role_model_result: RoleModelTurnResult,
) -> LifeIncidentStartCommitRequest | None:
    event = _validate_source_event(source_event)
    result = _validate_role_model_result(role_model_result, source_event=event)
    decision = result["decision"]
    if "life_action" not in decision:
        return None

    payload = event["payload"]
    request: LifeIncidentStartCommitRequest = {
        "schema_version": SCHEMA_VERSION,
        "trace_id": event["trace_id"],
        "event_id": event["event_id"],
        "event_type": event["type"],
        "decision_action": VISIBLE_REPLY_ACTION,
        "life_action_type": START_INCIDENT_ACTION,
        "draft": deepcopy(decision["life_action"]["incident"]),
    }
    for field_name in ("user_id", "conversation_id"):
        if field_name in payload:
            request[field_name] = payload[field_name]
    return request


def commit_life_incident_start(
    source_event: RuntimeEvent,
    role_model_result: RoleModelTurnResult,
    *,
    life_incident_start_finalizer: LifeIncidentStartFinalizer,
    raw_event_log: RawEventLog,
    id_generator: IdGenerator,
    clock: Clock,
) -> LifeIncidentStartCommitResult:
    source_identity = _extract_trusted_source_identity(source_event)
    request: LifeIncidentStartCommitRequest | None = None
    started_incident: Mapping[str, Any] | None = None
    committed_log_entry: RawEventLogEntry | None = None
    finalize_request: LifeIncidentStartFinalizeRequest | None = None
    success_visibility_confirmed = False

    try:
        request = build_life_incident_start_commit_request(source_event, role_model_result)
        if request is None:
            return {
                "schema_version": SCHEMA_VERSION,
                "trace_id": source_identity["trace_id"],
                "event_id": source_identity["event_id"],
                "event_type": USER_MESSAGE,
                "status": LIFE_INCIDENT_START_SKIPPED_STATUS,
            }
        commit_time = clock_timestamp(clock)
        request["commit_time"] = commit_time
        started_incident = build_started_life_incident_snapshot(
            source_event,
            request["draft"],
            commit_time=commit_time,
            id_generator=id_generator,
        )
        committed_log_entry = build_life_incident_started_log_entry(
            source_event,
            role_model_result,
            request["draft"],
            started_incident,
            id_generator=id_generator,
            clock=_clock_at(commit_time),
        )
        finalize_request = build_life_incident_start_finalize_request(
            request,
            started_incident=started_incident,
            committed_log_entry=committed_log_entry,
        )
        try:
            _require_finalizer_raw_event_log(
                life_incident_start_finalizer,
                raw_event_log,
            )
            finalize_result = life_incident_start_finalizer.finalize_life_incident_start(
                deepcopy(finalize_request)
            )
        except RawEventLogQueryValidationError as error:
            raise LifeIncidentStartFinalizerError(
                str(error),
                code="malformed_finalize_result",
            ) from error
        validated_finalize_result = validate_life_incident_start_finalize_result(
            finalize_result,
            source_identity=source_identity,
            committed_log_entry=committed_log_entry,
        )
        try:
            confirm_committed_success_entry_visibility(raw_event_log, committed_log_entry)
        except RawEventLogQueryValidationError as error:
            raise LifeIncidentStartFinalizerError(
                str(error),
                code="malformed_finalize_result",
            ) from error
        success_visibility_confirmed = True
        _complete_start_after_log_visible(
            life_incident_start_finalizer,
            finalize_request,
        )
    except LifeIncidentStartFinalizerError as error:
        failure_error = error
        if not success_visibility_confirmed:
            discard_committed_success_entry_visibility(raw_event_log, committed_log_entry)
            try:
                _discard_start_after_log_not_visible(
                    life_incident_start_finalizer,
                    finalize_request,
                )
            except LifeIncidentStartFinalizerError as discard_error:
                failure_error = discard_error
        failure = _build_failure(
            LIFE_INCIDENT_START_FINALIZE_STAGE,
            failure_error.code,
            str(failure_error),
        )
        raw_event_log.append(
            build_life_incident_start_rejected_log_entry(
                source_event,
                role_model_result_snapshot=role_model_result,
                draft_snapshot=request["draft"] if request is not None else None,
                started_incident_snapshot=started_incident,
                failure=failure,
                id_generator=id_generator,
                clock=clock,
            )
        )
        return _build_rejected_result(source_identity, failure)
    except LifeIncidentStartCommitValidationError as error:
        failure = _build_failure(
            LIFE_INCIDENT_START_COMMIT_VALIDATION_STAGE,
            error.code,
            str(error),
        )
        raw_event_log.append(
            build_life_incident_start_rejected_log_entry(
                source_event,
                role_model_result_snapshot=role_model_result,
                draft_snapshot=request["draft"] if request is not None else None,
                started_incident_snapshot=started_incident,
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
        "status": LIFE_INCIDENT_STARTED_STATUS,
        "started_incident": deepcopy(dict(started_incident)),
        "committed_log_entry_id": validated_finalize_result["committed_log_entry_id"],
    }


def build_started_life_incident_snapshot(
    source_event: RuntimeEvent,
    draft: Mapping[str, Any],
    *,
    commit_time: str,
    id_generator: IdGenerator,
) -> dict[str, Any]:
    event = _validate_source_event(source_event)
    normalized_draft = _normalize_start_incident_draft(draft)
    validated_commit_time = _wrap_validation_contract_error(
        lambda: validate_iso8601_timestamp(commit_time, "commit_time")
    )
    snapshot: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "incident_id": generate_id("incident", id_generator),
        "type": normalized_draft["type"],
        "status": "active",
        "title": normalized_draft["title"],
        "started_at": validated_commit_time,
        "interrupt_policy": normalized_draft["interrupt_policy"],
        "resume_policy": normalized_draft["resume_policy"],
        "source_event_ids": [event["event_id"]],
    }
    if "remaining_seconds" in normalized_draft:
        snapshot["remaining_seconds"] = normalized_draft["remaining_seconds"]
    return _validate_started_incident_snapshot(
        snapshot,
        event=event,
        draft=normalized_draft,
        commit_time=validated_commit_time,
    )


def build_life_incident_started_log_entry(
    source_event: RuntimeEvent,
    role_model_result: RoleModelTurnResult,
    draft: Mapping[str, Any],
    started_incident: Mapping[str, Any],
    *,
    id_generator: IdGenerator,
    clock: Clock,
) -> RawEventLogEntry:
    event = _validate_source_event(source_event)
    result = _validate_role_model_result(role_model_result, source_event=event)
    normalized_draft = _normalize_start_incident_draft(draft)
    validated_started_incident = _validate_started_incident_snapshot(
        started_incident,
        event=event,
        draft=normalized_draft,
        commit_time=started_incident.get("started_at")
        if isinstance(started_incident, Mapping)
        else None,
    )

    return build_raw_log_entry(
        trace_id=event["trace_id"],
        event_id=event["event_id"],
        kind=LIFE_INCIDENT_STARTED_KIND,
        data={
            "source_event": event,
            "role_model_result": result,
            "draft": normalized_draft,
            "started_incident": validated_started_incident,
        },
        id_generator=id_generator,
        clock=clock,
    )


def build_life_incident_start_finalize_request(
    commit_request: Mapping[str, Any],
    *,
    started_incident: Mapping[str, Any],
    committed_log_entry: Mapping[str, Any],
) -> LifeIncidentStartFinalizeRequest:
    if not isinstance(commit_request, Mapping):
        raise LifeIncidentStartCommitValidationError("commit_request must be a mapping.")
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
                "commit_time",
                "draft",
                "user_id",
                "conversation_id",
            },
            "LifeIncidentStartCommitRequest",
        )
        require_equal(
            commit_request.get("schema_version"),
            SCHEMA_VERSION,
            "LifeIncidentStartCommitRequest.schema_version",
        )
        require_equal(
            commit_request.get("event_type"),
            USER_MESSAGE,
            "LifeIncidentStartCommitRequest.event_type",
        )
        require_equal(
            commit_request.get("decision_action"),
            VISIBLE_REPLY_ACTION,
            "LifeIncidentStartCommitRequest.decision_action",
        )
        require_equal(
            commit_request.get("life_action_type"),
            START_INCIDENT_ACTION,
            "LifeIncidentStartCommitRequest.life_action_type",
        )
        validate_iso8601_timestamp(
            commit_request.get("commit_time"),
            "LifeIncidentStartCommitRequest.commit_time",
        )
        require_string(commit_request.get("trace_id"), "LifeIncidentStartCommitRequest.trace_id")
        require_string(commit_request.get("event_id"), "LifeIncidentStartCommitRequest.event_id")
    except SharedContractValidationError as error:
        raise LifeIncidentStartCommitValidationError(str(error), code=error.code) from error

    finalized_request = deepcopy(dict(commit_request))
    finalized_request["draft"] = _normalize_start_incident_draft(commit_request.get("draft"))
    finalized_request["started_incident"] = _validate_started_incident_snapshot(
        started_incident,
        event={
            "event_id": finalized_request["event_id"],
        },
        draft=finalized_request["draft"],
        commit_time=finalized_request["commit_time"],
    )
    finalized_request["committed_log_entry"] = _validate_committed_log_entry(
        committed_log_entry,
        source_identity=finalized_request,
    )
    return finalized_request


def validate_life_incident_start_finalize_result(
    finalize_result: Any,
    *,
    source_identity: Mapping[str, str],
    committed_log_entry: Mapping[str, Any],
) -> LifeIncidentStartFinalizeResult:
    if not isinstance(finalize_result, Mapping):
        raise LifeIncidentStartFinalizerError(
            "LifeIncidentStartFinalizeResult must be a mapping.",
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
            "LifeIncidentStartFinalizeResult",
        )
        schema_version = require_equal(
            finalize_result.get("schema_version"),
            SCHEMA_VERSION,
            "LifeIncidentStartFinalizeResult.schema_version",
        )
        trace_id = require_string(
            finalize_result.get("trace_id"),
            "LifeIncidentStartFinalizeResult.trace_id",
        )
        event_id = require_string(
            finalize_result.get("event_id"),
            "LifeIncidentStartFinalizeResult.event_id",
        )
        event_type = require_equal(
            finalize_result.get("event_type"),
            USER_MESSAGE,
            "LifeIncidentStartFinalizeResult.event_type",
        )
        committed_log_entry_id = require_string(
            finalize_result.get("committed_log_entry_id"),
            "LifeIncidentStartFinalizeResult.committed_log_entry_id",
        )
    except SharedContractValidationError as error:
        raise LifeIncidentStartFinalizerError(
            str(error),
            code="malformed_finalize_result",
        ) from error

    if trace_id != source_identity["trace_id"]:
        raise LifeIncidentStartFinalizerError(
            "LifeIncidentStartFinalizeResult.trace_id must match source_event.trace_id.",
            code="malformed_finalize_result",
        )
    if event_id != source_identity["event_id"]:
        raise LifeIncidentStartFinalizerError(
            "LifeIncidentStartFinalizeResult.event_id must match source_event.event_id.",
            code="malformed_finalize_result",
        )
    if not isinstance(committed_log_entry, Mapping):
        raise LifeIncidentStartFinalizerError(
            "committed_log_entry must be a mapping.",
            code="malformed_finalize_result",
        )
    try:
        expected_log_id = require_string(
            committed_log_entry.get("log_id"),
            "committed_log_entry.log_id",
        )
    except SharedContractValidationError as error:
        raise LifeIncidentStartFinalizerError(
            str(error),
            code="malformed_finalize_result",
        ) from error
    if committed_log_entry_id != expected_log_id:
        raise LifeIncidentStartFinalizerError(
            (
                "LifeIncidentStartFinalizeResult.committed_log_entry_id must match "
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


def build_life_incident_start_rejected_log_entry(
    source_event: RuntimeEvent,
    *,
    role_model_result_snapshot: Any,
    draft_snapshot: Any | None,
    started_incident_snapshot: Any | None,
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
    if draft_snapshot is not None:
        data["draft_snapshot"] = _snapshot(draft_snapshot)
    if started_incident_snapshot is not None:
        data["started_incident_snapshot"] = _snapshot(started_incident_snapshot)

    return build_raw_log_entry(
        trace_id=source_identity["trace_id"],
        event_id=source_identity["event_id"],
        kind=LIFE_INCIDENT_START_REJECTED_KIND,
        data=data,
        id_generator=id_generator,
        clock=clock,
    )


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
                    source_name="CharacterDecision",
                )
            ),
        )
    )


def _normalize_start_incident_draft(draft: Any) -> dict[str, Any]:
    return _wrap_validation_contract_error(
        lambda: normalize_start_incident_life_action(
            {"type": START_INCIDENT_ACTION, "incident": draft},
            source_name="life_action",
        )
    )["incident"]


def _validate_started_incident_snapshot(
    snapshot: Any,
    *,
    event: Mapping[str, Any],
    draft: Mapping[str, Any],
    commit_time: Any,
) -> dict[str, Any]:
    try:
        validated_snapshot = validate_active_incident_snapshot(snapshot)
    except SharedContractValidationError as error:
        raise LifeIncidentStartCommitValidationError(str(error)) from error

    event_id = _wrap_validation_contract_error(
        lambda: require_string(event.get("event_id"), "event_id")
    )
    normalized_draft = _normalize_start_incident_draft(draft)
    validated_commit_time = _wrap_validation_contract_error(
        lambda: validate_iso8601_timestamp(commit_time, "commit_time")
    )

    if validated_snapshot["source_event_ids"] != [event_id]:
        raise LifeIncidentStartCommitValidationError(
            "started_incident.source_event_ids must equal [source_event.event_id]."
        )
    if "started_at" not in validated_snapshot:
        raise LifeIncidentStartCommitValidationError("started_incident.started_at is required.")
    if validated_snapshot["started_at"] != validated_commit_time:
        raise LifeIncidentStartCommitValidationError(
            "started_incident.started_at must match commit_time."
        )
    for field_name in ("type", "title", "interrupt_policy", "resume_policy"):
        if validated_snapshot[field_name] != normalized_draft[field_name]:
            raise LifeIncidentStartCommitValidationError(
                f"started_incident.{field_name} must match draft.{field_name}."
            )
    if "remaining_seconds" in normalized_draft:
        if validated_snapshot.get("remaining_seconds") != normalized_draft["remaining_seconds"]:
            raise LifeIncidentStartCommitValidationError(
                "started_incident.remaining_seconds must match draft.remaining_seconds."
            )
    elif "remaining_seconds" in validated_snapshot:
        raise LifeIncidentStartCommitValidationError(
            "started_incident.remaining_seconds must be omitted when draft omits it."
        )
    return validated_snapshot


def _validate_committed_log_entry(
    committed_log_entry: Any,
    *,
    source_identity: Mapping[str, str],
) -> dict[str, Any]:
    if not isinstance(committed_log_entry, Mapping):
        raise LifeIncidentStartCommitValidationError("committed_log_entry must be a mapping.")
    try:
        require_equal(
            committed_log_entry.get("schema_version"),
            SCHEMA_VERSION,
            "committed_log_entry.schema_version",
        )
        require_string(committed_log_entry.get("log_id"), "committed_log_entry.log_id")
        require_equal(
            committed_log_entry.get("trace_id"),
            source_identity["trace_id"],
            "committed_log_entry.trace_id",
        )
        require_equal(
            committed_log_entry.get("event_id"),
            source_identity["event_id"],
            "committed_log_entry.event_id",
        )
        require_equal(
            committed_log_entry.get("kind"),
            LIFE_INCIDENT_STARTED_KIND,
            "committed_log_entry.kind",
        )
    except SharedContractValidationError as error:
        raise LifeIncidentStartCommitValidationError(str(error), code=error.code) from error
    return deepcopy(dict(committed_log_entry))


def _extract_trusted_source_identity(source_event: Any) -> dict[str, str]:
    if not isinstance(source_event, Mapping):
        raise LifeIncidentStartCommitValidationError("source_event must be a mapping.")
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
) -> LifeIncidentStartCommitResult:
    return {
        "schema_version": SCHEMA_VERSION,
        "trace_id": source_identity["trace_id"],
        "event_id": source_identity["event_id"],
        "event_type": USER_MESSAGE,
        "status": LIFE_INCIDENT_START_REJECTED_STATUS,
        "failure": deepcopy(dict(failure)),
    }


def _validate_failure(failure: Mapping[str, Any]) -> dict[str, str]:
    if not isinstance(failure, Mapping):
        raise LifeIncidentStartCommitValidationError("failure must be a mapping.")
    _wrap_validation_contract_error(
        lambda: reject_extra_keys(failure, {"stage", "code", "message"}, "failure")
    )
    stage = failure.get("stage")
    if stage not in SUPPORTED_FAILURE_CODES_BY_STAGE:
        raise LifeIncidentStartCommitValidationError(
            "failure.stage must be a supported incident-start failure stage."
        )
    code = failure.get("code")
    if code not in SUPPORTED_FAILURE_CODES_BY_STAGE[stage]:
        raise LifeIncidentStartCommitValidationError(
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
            if stage == LIFE_INCIDENT_START_FINALIZE_STAGE
            else "malformed_commit_input"
        )
    return {"stage": stage, "code": code, "message": message}


def _require_finalizer_raw_event_log(
    finalizer: LifeIncidentStartFinalizer,
    raw_event_log: RawEventLog,
) -> None:
    require_raw_event_log = getattr(finalizer, "require_raw_event_log", None)
    if callable(require_raw_event_log):
        require_raw_event_log(raw_event_log)


def _complete_start_after_log_visible(
    finalizer: LifeIncidentStartFinalizer,
    finalize_request: Mapping[str, Any],
) -> None:
    complete_after_log_visible = getattr(
        finalizer,
        "complete_life_incident_start_after_log_visible",
        None,
    )
    if not callable(complete_after_log_visible):
        return
    try:
        complete_after_log_visible(deepcopy(dict(finalize_request)))
    except LifeIncidentStartFinalizerError:
        raise
    except Exception as error:
        raise LifeIncidentStartFinalizerError(
            f"complete_life_incident_start_after_log_visible failed unexpectedly: {error}",
            code="finalize_rejected",
        ) from error


def _discard_start_after_log_not_visible(
    finalizer: LifeIncidentStartFinalizer,
    finalize_request: Mapping[str, Any] | None,
) -> None:
    discard_after_log_not_visible = getattr(
        finalizer,
        "discard_life_incident_start_after_log_not_visible",
        None,
    )
    if not callable(discard_after_log_not_visible) or finalize_request is None:
        return
    try:
        discard_after_log_not_visible(deepcopy(dict(finalize_request)))
    except LifeIncidentStartFinalizerError:
        raise
    except Exception as error:
        raise LifeIncidentStartFinalizerError(
            f"discard_life_incident_start_after_log_not_visible failed unexpectedly: {error}",
            code="finalize_rejected",
        ) from error


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
        raise LifeIncidentStartCommitValidationError(str(error), code=code) from error


def _snapshot(value: Any) -> Any:
    if isinstance(value, Mapping):
        return deepcopy(dict(value))
    return {"raw_value": repr(value)}
