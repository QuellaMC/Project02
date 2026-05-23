from __future__ import annotations

from collections.abc import Callable, Mapping
from copy import deepcopy
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from character.state.current import ActiveIncidentSource
from runtime.contracts import USER_MESSAGE, RuntimeEvent
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
)

RoleModelTurnResult = dict[str, Any]
IncidentLifecycleCommitRequest = dict[str, Any]
IncidentLifecycleCommitResult = dict[str, Any]


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
        "event_type": USER_MESSAGE,
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
