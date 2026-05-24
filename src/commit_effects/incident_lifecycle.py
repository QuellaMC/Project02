from __future__ import annotations

from collections.abc import Callable, Mapping
from copy import deepcopy
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from character.state.current import (
    ActiveIncidentSource,
    build_active_incident_request,
    validate_active_incident_snapshot,
)
from runtime.contracts import (
    USER_MESSAGE,
    RuntimeEvent,
    normalize_role_model_turn_result,
    normalize_visible_reply_decision_with_optional_life_action,
    reject_extra_keys,
    require_equal,
    require_string,
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
    clock_timestamp,
    confirm_committed_success_entry_visibility,
    discard_committed_success_entry_visibility,
    validate_raw_event_log_entry,
)

RoleModelTurnResult = dict[str, Any]
IncidentLifecycleCommitRequest = dict[str, Any]
IncidentLifecycleCommitResult = dict[str, Any]
IncidentLifecycleErrorFactory = Callable[[str, str], Exception]


@dataclass(frozen=True)
class IncidentLifecycleCommitConfig:
    skipped_status: str
    success_status: str
    success_snapshot_key: str
    commit_validation_stage: str
    finalize_stage: str
    finalize_method_name: str
    complete_after_visible_method_name: str


@dataclass(frozen=True)
class IncidentLifecycleCommitHooks:
    build_commit_request: Callable[
        [RuntimeEvent, RoleModelTurnResult],
        IncidentLifecycleCommitRequest | None,
    ]
    life_action_from_commit_request: Callable[[Mapping[str, Any]], Mapping[str, Any]]
    read_active_incident: Callable[[RuntimeEvent, ActiveIncidentSource], Mapping[str, Any]]
    build_transition_snapshot: Callable[[Mapping[str, Any], Mapping[str, Any]], Mapping[str, Any]]
    build_success_log_entry: Callable[..., RawEventLogEntry]
    build_finalize_request: Callable[..., IncidentLifecycleCommitRequest]
    require_finalizer_raw_event_log: Callable[[Any, RawEventLog], None]
    finalize: Callable[[Any, Mapping[str, Any]], Mapping[str, Any]]
    validate_finalize_result: Callable[..., Mapping[str, Any]]
    complete_after_visible: Callable[[Any, Mapping[str, Any]], None]
    build_rejected_log_entry: Callable[..., RawEventLogEntry]
    build_failure: Callable[[str, str, str], Mapping[str, str]]
    build_rejected_result: Callable[[Mapping[str, str], Mapping[str, str]], dict[str, Any]]
    commit_validation_error_type: type[Exception]
    finalizer_error_type: type[Exception]
    commit_validation_error_factory: Callable[[str, str], Exception]
    finalizer_error_factory: Callable[[str, str], Exception]


def commit_life_incident_lifecycle_transition(
    source_event: RuntimeEvent,
    role_model_result: RoleModelTurnResult,
    *,
    source_identity: Mapping[str, str],
    active_incident_source: ActiveIncidentSource,
    finalizer: Any,
    raw_event_log: RawEventLog,
    id_generator: IdGenerator,
    clock: Clock,
    config: IncidentLifecycleCommitConfig,
    hooks: IncidentLifecycleCommitHooks,
) -> IncidentLifecycleCommitResult:
    request: IncidentLifecycleCommitRequest | None = None
    life_action: Mapping[str, Any] | None = None
    active_incident: Mapping[str, Any] | None = None
    transition_snapshot: Mapping[str, Any] | None = None
    committed_log_entry: RawEventLogEntry | None = None
    finalize_request: IncidentLifecycleCommitRequest | None = None
    validated_finalize_result: Mapping[str, Any] | None = None

    try:
        request = hooks.build_commit_request(source_event, role_model_result)
        if request is None:
            return _build_status_result(source_identity, config.skipped_status)

        life_action = hooks.life_action_from_commit_request(request)
        active_incident = hooks.read_active_incident(source_event, active_incident_source)
        if active_incident["incident_id"] != request["incident_id"]:
            raise hooks.commit_validation_error_factory(
                "life_action.incident_id must match the current active incident.",
                "incident_id_mismatch",
            )

        commit_time = clock_timestamp(clock)
        request["commit_time"] = commit_time
        transition_snapshot = hooks.build_transition_snapshot(active_incident, request)
        committed_log_entry = hooks.build_success_log_entry(
            source_event,
            role_model_result,
            life_action,
            active_incident,
            transition_snapshot,
            id_generator=id_generator,
            clock=_clock_at(commit_time),
        )
        finalize_request_kwargs = {
            "active_incident": active_incident,
            config.success_snapshot_key: transition_snapshot,
            "committed_log_entry": committed_log_entry,
        }
        finalize_request = hooks.build_finalize_request(
            request,
            **finalize_request_kwargs,
        )

        validated_finalize_result = _stage_lifecycle_success(
            finalizer,
            finalize_request,
            raw_event_log=raw_event_log,
            config=config,
            hooks=hooks,
        )
        try:
            confirm_committed_success_entry_visibility(raw_event_log, committed_log_entry)
        except RawEventLogQueryValidationError as error:
            raise hooks.finalizer_error_factory(
                str(error),
                "malformed_finalize_result",
            ) from error
        _complete_lifecycle_success_after_visible(
            finalizer,
            finalize_request,
            config=config,
            hooks=hooks,
        )
    except Exception as error:
        if isinstance(error, hooks.finalizer_error_type):
            discard_committed_success_entry_visibility(raw_event_log, committed_log_entry)
            failure = hooks.build_failure(
                config.finalize_stage,
                _error_code(error, "finalize_rejected"),
                str(error),
            )
            _append_rejected_entry(
                source_event,
                role_model_result,
                life_action=life_action,
                active_incident=active_incident,
                transition_snapshot=transition_snapshot,
                failure=failure,
                raw_event_log=raw_event_log,
                id_generator=id_generator,
                clock=clock,
                config=config,
                hooks=hooks,
            )
            return hooks.build_rejected_result(source_identity, failure)

        if isinstance(error, hooks.commit_validation_error_type):
            failure = hooks.build_failure(
                config.commit_validation_stage,
                _error_code(error, "malformed_commit_input"),
                str(error),
            )
            _append_rejected_entry(
                source_event,
                role_model_result,
                life_action=life_action,
                active_incident=active_incident,
                transition_snapshot=transition_snapshot,
                failure=failure,
                raw_event_log=raw_event_log,
                id_generator=id_generator,
                clock=clock,
                config=config,
                hooks=hooks,
            )
            return hooks.build_rejected_result(source_identity, failure)

        raise

    assert transition_snapshot is not None
    assert validated_finalize_result is not None
    result = _build_status_result(source_identity, config.success_status)
    result[config.success_snapshot_key] = deepcopy(dict(transition_snapshot))
    result["committed_log_entry_id"] = validated_finalize_result["committed_log_entry_id"]
    return result


def validate_lifecycle_source_event(
    source_event: Any,
    *,
    commit_validation_error_factory: IncidentLifecycleErrorFactory,
) -> RuntimeEvent:
    return wrap_lifecycle_contract_error(
        lambda: validate_normalized_user_message_event(
            source_event,
            source_name="source_event",
        ),
        commit_validation_error_factory=commit_validation_error_factory,
    )


def normalize_lifecycle_role_model_result(
    role_model_result: Any,
    *,
    source_event: RuntimeEvent,
    allowed_life_action_type: str,
    commit_validation_error_factory: IncidentLifecycleErrorFactory,
) -> RoleModelTurnResult:
    return wrap_lifecycle_contract_error(
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
                    allowed_life_action_type=allowed_life_action_type,
                    source_name="CharacterDecision",
                )
            ),
        ),
        commit_validation_error_factory=commit_validation_error_factory,
    )


def read_active_lifecycle_incident(
    source_event: RuntimeEvent,
    *,
    active_incident_source: ActiveIncidentSource,
    commit_validation_error_factory: IncidentLifecycleErrorFactory,
) -> dict[str, Any]:
    event = validate_lifecycle_source_event(
        source_event,
        commit_validation_error_factory=commit_validation_error_factory,
    )
    request = build_active_incident_request(event)
    try:
        active_incident = active_incident_source.read_active_incident(deepcopy(request))
    except Exception as error:
        raise commit_validation_error_factory(
            f"active_incident_source.read_active_incident failed unexpectedly: {error}",
            "active_incident_source_error",
        ) from error
    if active_incident is None:
        raise commit_validation_error_factory(
            "No active incident exists for this source-event scope.",
            "no_active_incident",
        )
    return validate_lifecycle_active_incident_for_commit(
        active_incident,
        commit_validation_error_factory=commit_validation_error_factory,
    )


def validate_lifecycle_active_incident_for_commit(
    active_incident: Any,
    *,
    commit_validation_error_factory: IncidentLifecycleErrorFactory,
) -> dict[str, Any]:
    try:
        return validate_active_incident_snapshot(active_incident)
    except SharedContractValidationError as error:
        raise commit_validation_error_factory(str(error), error.code) from error


def validate_lifecycle_finalize_result(
    finalize_result: Any,
    *,
    source_identity: Mapping[str, str],
    committed_log_entry: Mapping[str, Any],
    result_name: str,
    finalizer_error_factory: IncidentLifecycleErrorFactory,
) -> dict[str, Any]:
    if not isinstance(finalize_result, Mapping):
        raise finalizer_error_factory(
            f"{result_name} must be a mapping.",
            "malformed_finalize_result",
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
            result_name,
        )
        schema_version = require_equal(
            finalize_result.get("schema_version"),
            SCHEMA_VERSION,
            f"{result_name}.schema_version",
        )
        trace_id = require_string(
            finalize_result.get("trace_id"),
            f"{result_name}.trace_id",
        )
        event_id = require_string(
            finalize_result.get("event_id"),
            f"{result_name}.event_id",
        )
        event_type = require_equal(
            require_string(
                finalize_result.get("event_type"),
                f"{result_name}.event_type",
            ),
            source_identity["event_type"],
            f"{result_name}.event_type",
        )
        committed_log_entry_id = require_string(
            finalize_result.get("committed_log_entry_id"),
            f"{result_name}.committed_log_entry_id",
        )
    except SharedContractValidationError as error:
        raise finalizer_error_factory(
            str(error),
            "malformed_finalize_result",
        ) from error

    if trace_id != source_identity["trace_id"]:
        raise finalizer_error_factory(
            f"{result_name}.trace_id must match source_event.trace_id.",
            "malformed_finalize_result",
        )
    if event_id != source_identity["event_id"]:
        raise finalizer_error_factory(
            f"{result_name}.event_id must match source_event.event_id.",
            "malformed_finalize_result",
        )
    if not isinstance(committed_log_entry, Mapping):
        raise finalizer_error_factory(
            "committed_log_entry must be a mapping.",
            "malformed_finalize_result",
        )
    try:
        expected_log_id = require_string(
            committed_log_entry.get("log_id"),
            "committed_log_entry.log_id",
        )
    except SharedContractValidationError as error:
        raise finalizer_error_factory(
            str(error),
            "malformed_finalize_result",
        ) from error
    if committed_log_entry_id != expected_log_id:
        raise finalizer_error_factory(
            f"{result_name}.committed_log_entry_id must match committed_log_entry.log_id.",
            "malformed_finalize_result",
        )

    return {
        "schema_version": schema_version,
        "trace_id": trace_id,
        "event_id": event_id,
        "event_type": event_type,
        "committed_log_entry_id": committed_log_entry_id,
    }


def validate_lifecycle_committed_log_entry(
    committed_log_entry: Any,
    *,
    source_identity: Mapping[str, str],
    success_kind: str,
    commit_validation_error_factory: IncidentLifecycleErrorFactory,
) -> dict[str, Any]:
    try:
        entry = validate_raw_event_log_entry(committed_log_entry)
        require_equal(
            entry["trace_id"], source_identity["trace_id"], "committed_log_entry.trace_id"
        )
        require_equal(
            entry["event_id"], source_identity["event_id"], "committed_log_entry.event_id"
        )
        require_equal(entry["kind"], success_kind, "committed_log_entry.kind")
    except (SharedContractValidationError, RawEventLogQueryValidationError) as error:
        raise commit_validation_error_factory(str(error), "malformed_commit_input") from error
    return entry


def extract_trusted_lifecycle_source_identity(
    source_event: Any,
    *,
    commit_validation_error_factory: IncidentLifecycleErrorFactory,
) -> dict[str, str]:
    if not isinstance(source_event, Mapping):
        raise commit_validation_error_factory(
            "source_event must be a mapping.",
            "malformed_commit_input",
        )
    trace_id = wrap_lifecycle_contract_error(
        lambda: require_string(source_event.get("trace_id"), "trace_id"),
        commit_validation_error_factory=commit_validation_error_factory,
    )
    event_id = wrap_lifecycle_contract_error(
        lambda: require_string(source_event.get("event_id"), "event_id"),
        commit_validation_error_factory=commit_validation_error_factory,
    )
    return {
        "trace_id": trace_id,
        "event_id": event_id,
        "event_type": USER_MESSAGE,
    }


def build_lifecycle_rejected_result(
    source_identity: Mapping[str, str],
    failure: Mapping[str, str],
    *,
    rejected_status: str,
) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "trace_id": source_identity["trace_id"],
        "event_id": source_identity["event_id"],
        "event_type": source_identity["event_type"],
        "status": rejected_status,
        "failure": deepcopy(dict(failure)),
    }


def validate_lifecycle_failure(
    failure: Mapping[str, Any],
    *,
    supported_failure_codes_by_stage: Mapping[str, set[str]],
    lifecycle_label: str,
    commit_validation_error_factory: IncidentLifecycleErrorFactory,
) -> dict[str, str]:
    if not isinstance(failure, Mapping):
        raise commit_validation_error_factory(
            "failure must be a mapping.",
            "malformed_commit_input",
        )
    wrap_lifecycle_contract_error(
        lambda: reject_extra_keys(failure, {"stage", "code", "message"}, "failure"),
        commit_validation_error_factory=commit_validation_error_factory,
    )
    stage = failure.get("stage")
    if not isinstance(stage, str) or stage not in supported_failure_codes_by_stage:
        raise commit_validation_error_factory(
            f"failure.stage must be a supported {lifecycle_label} failure stage.",
            "malformed_commit_input",
        )
    code = failure.get("code")
    if not isinstance(code, str) or code not in supported_failure_codes_by_stage[stage]:
        raise commit_validation_error_factory(
            "failure.code must be supported for failure.stage.",
            "malformed_commit_input",
        )
    return {
        "stage": stage,
        "code": code,
        "message": wrap_lifecycle_contract_error(
            lambda: require_string(failure.get("message"), "failure.message"),
            commit_validation_error_factory=commit_validation_error_factory,
        ),
    }


def build_lifecycle_failure(
    stage: str,
    code: str,
    message: str,
    *,
    supported_failure_codes_by_stage: Mapping[str, set[str]],
    finalize_stage: str,
) -> dict[str, str]:
    supported_codes = supported_failure_codes_by_stage[stage]
    if code not in supported_codes:
        code = "malformed_finalize_result" if stage == finalize_stage else "malformed_commit_input"
    return {"stage": stage, "code": code, "message": message}


def require_lifecycle_finalizer_raw_event_log(
    finalizer: Any,
    raw_event_log: RawEventLog,
    *,
    specific_method_name: str,
    finalizer_error_factory: IncidentLifecycleErrorFactory,
) -> None:
    require_raw_event_log = getattr(finalizer, specific_method_name, None)
    if not callable(require_raw_event_log):
        require_raw_event_log = getattr(finalizer, "require_raw_event_log", None)
    if callable(require_raw_event_log):
        try:
            require_raw_event_log(raw_event_log)
        except Exception as error:
            code = getattr(error, "code", "malformed_finalize_result")
            raise finalizer_error_factory(str(error), code) from error


def require_matching_lifecycle_field(
    snapshot: Mapping[str, Any],
    active_incident: Mapping[str, Any],
    field_name: str,
    *,
    snapshot_name: str,
    commit_validation_error_factory: IncidentLifecycleErrorFactory,
) -> Any:
    if snapshot.get(field_name) != active_incident[field_name]:
        raise commit_validation_error_factory(
            f"{snapshot_name}.{field_name} must match active_incident.{field_name}.",
            "malformed_commit_input",
        )
    return snapshot[field_name]


def append_lifecycle_source_event_id_once(source_event_ids: list[str], event_id: str) -> list[str]:
    if event_id in source_event_ids:
        return list(source_event_ids)
    return [*source_event_ids, event_id]


def validate_lifecycle_source_event_ids(
    value: Any,
    *,
    active_source_event_ids: list[str],
    event_id: str,
    snapshot_name: str,
    commit_validation_error_factory: IncidentLifecycleErrorFactory,
) -> list[str]:
    if not isinstance(value, list):
        raise commit_validation_error_factory(
            f"{snapshot_name}.source_event_ids must be a list.",
            "malformed_commit_input",
        )
    source_event_ids: list[str] = []
    for source_event_id in value:
        source_event_ids.append(
            wrap_lifecycle_contract_error(
                lambda: require_string(
                    source_event_id,
                    f"{snapshot_name}.source_event_ids[]",
                ),
                commit_validation_error_factory=commit_validation_error_factory,
            )
        )
    expected_source_event_ids = append_lifecycle_source_event_id_once(
        active_source_event_ids,
        event_id,
    )
    if source_event_ids != expected_source_event_ids:
        raise commit_validation_error_factory(
            f"{snapshot_name}.source_event_ids must preserve active IDs and append event_id once.",
            "malformed_commit_input",
        )
    return source_event_ids


def wrap_lifecycle_contract_error[T](
    callback: Callable[[], T],
    *,
    commit_validation_error_factory: IncidentLifecycleErrorFactory,
) -> T:
    try:
        return callback()
    except SharedContractValidationError as error:
        code = "malformed_commit_input" if error.code == "invalid_contract" else error.code
        raise commit_validation_error_factory(str(error), code) from error


def snapshot_lifecycle_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        return deepcopy(dict(value))
    return {"raw_value": repr(value)}


def _stage_lifecycle_success(
    finalizer: Any,
    finalize_request: Mapping[str, Any],
    *,
    raw_event_log: RawEventLog,
    config: IncidentLifecycleCommitConfig,
    hooks: IncidentLifecycleCommitHooks,
) -> Mapping[str, Any]:
    try:
        hooks.require_finalizer_raw_event_log(finalizer, raw_event_log)
        finalize_result = hooks.finalize(finalizer, deepcopy(dict(finalize_request)))
    except RawEventLogQueryValidationError as error:
        raise hooks.finalizer_error_factory(
            str(error),
            "malformed_finalize_result",
        ) from error
    except Exception as error:
        if isinstance(error, hooks.finalizer_error_type):
            raise
        raise hooks.finalizer_error_factory(
            f"{config.finalize_method_name} failed unexpectedly: {error}",
            "finalize_rejected",
        ) from error

    return hooks.validate_finalize_result(
        finalize_result,
        source_identity=finalize_request,
        committed_log_entry=finalize_request["committed_log_entry"],
    )


def _complete_lifecycle_success_after_visible(
    finalizer: Any,
    finalize_request: Mapping[str, Any],
    *,
    config: IncidentLifecycleCommitConfig,
    hooks: IncidentLifecycleCommitHooks,
) -> None:
    try:
        hooks.complete_after_visible(finalizer, deepcopy(dict(finalize_request)))
    except RawEventLogQueryValidationError as error:
        raise hooks.finalizer_error_factory(
            str(error),
            "malformed_finalize_result",
        ) from error
    except Exception as error:
        if isinstance(error, hooks.finalizer_error_type):
            raise
        raise hooks.finalizer_error_factory(
            f"{config.complete_after_visible_method_name} failed unexpectedly: {error}",
            "finalize_rejected",
        ) from error


def _append_rejected_entry(
    source_event: RuntimeEvent,
    role_model_result: RoleModelTurnResult,
    *,
    life_action: Mapping[str, Any] | None,
    active_incident: Mapping[str, Any] | None,
    transition_snapshot: Mapping[str, Any] | None,
    failure: Mapping[str, str],
    raw_event_log: RawEventLog,
    id_generator: IdGenerator,
    clock: Clock,
    config: IncidentLifecycleCommitConfig,
    hooks: IncidentLifecycleCommitHooks,
) -> None:
    rejected_kwargs = {
        "role_model_result_snapshot": role_model_result,
        "life_action_snapshot": life_action,
        "active_incident_snapshot": active_incident,
        f"{config.success_snapshot_key}_snapshot": transition_snapshot,
        "failure": failure,
        "id_generator": id_generator,
        "clock": clock,
    }
    raw_event_log.append(hooks.build_rejected_log_entry(source_event, **rejected_kwargs))


def _build_status_result(
    source_identity: Mapping[str, str],
    status: str,
) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "trace_id": source_identity["trace_id"],
        "event_id": source_identity["event_id"],
        "event_type": source_identity["event_type"],
        "status": status,
    }


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
