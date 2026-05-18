from __future__ import annotations

from collections.abc import Callable, Mapping
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any, Protocol

from character.state.current import validate_current_character_state_snapshot
from runtime.contracts import (
    USER_MESSAGE,
    VISIBLE_REPLY_ACTION,
    RuntimeEvent,
    normalize_living_state_patch,
    normalize_role_model_turn_result,
    normalize_visible_reply_decision_with_optional_living_state_patch,
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
    build_raw_log_entry,
    clock_timestamp,
)

LIVING_STATE_PATCH_COMMITTED_STATUS = "living_state_patch_committed"
LIVING_STATE_PATCH_SKIPPED_STATUS = "living_state_patch_skipped"
LIVING_STATE_PATCH_REJECTED_STATUS = "living_state_patch_rejected"
LIVING_STATE_PATCH_COMMITTED_KIND = "living_state_patch_committed"
LIVING_STATE_PATCH_REJECTED_KIND = "living_state_patch_rejected"
LIVING_STATE_PATCH_COMMIT_VALIDATION_STAGE = "living_state_patch_commit_validation"
LIVING_STATE_PATCH_STORE_STAGE = "living_state_patch_store"
LIVING_STATE_PATCH_FINALIZE_STAGE = "living_state_patch_finalize"
SUPPORTED_FAILURE_CODES_BY_STAGE = {
    LIVING_STATE_PATCH_COMMIT_VALIDATION_STAGE: {
        "malformed_commit_input",
        "identity_mismatch",
        "unsupported_result_status",
        "unsupported_action",
        "empty_reply_text",
    },
    LIVING_STATE_PATCH_STORE_STAGE: {
        "store_rejected",
        "malformed_store_result",
    },
    LIVING_STATE_PATCH_FINALIZE_STAGE: {
        "finalize_rejected",
        "malformed_finalize_result",
    },
}

RoleModelTurnResult = dict[str, Any]
LivingStatePatchCommitRequest = dict[str, Any]
LivingStatePatchFinalizeRequest = dict[str, Any]
LivingStatePatchFinalizeResult = dict[str, Any]
LivingStatePatchCommitResult = dict[str, Any]


class LivingStatePatchCommitValidationError(ValueError):
    """Raised when living-state patch commit input violates the active contract."""

    def __init__(self, message: str, *, code: str = "malformed_commit_input") -> None:
        super().__init__(message)
        self.code = code


class LivingStatePatchStoreError(ValueError):
    """Raised by an injected living-state patch store when it rejects a patch."""

    def __init__(self, message: str, *, code: str = "store_rejected") -> None:
        super().__init__(message)
        self.code = code


class LivingStatePatchFinalizerError(ValueError):
    """Raised by an injected atomic finalizer when it rejects a commit."""

    def __init__(self, message: str, *, code: str = "finalize_rejected") -> None:
        super().__init__(message)
        self.code = code


class LivingStatePatchStore(Protocol):
    """MVP-009 pending patch boundary.

    Implementations must not durably mutate character state here. A later concrete
    storage slice must make state mutation and raw-log append one transaction.
    """

    def prepare_living_state_patch_commit(
        self,
        request: LivingStatePatchCommitRequest,
    ) -> dict[str, Any]: ...


class LivingStatePatchFinalizer(Protocol):
    """MVP-010 atomic state-plus-log finalization boundary."""

    def finalize_living_state_patch_commit(
        self,
        request: LivingStatePatchFinalizeRequest,
    ) -> dict[str, Any]: ...


def build_living_state_patch_commit_request(
    source_event: RuntimeEvent,
    role_model_result: RoleModelTurnResult,
) -> LivingStatePatchCommitRequest | None:
    event = _validate_source_event(source_event)
    result = _validate_role_model_result(role_model_result, source_event=event)
    decision = result["decision"]
    if "state_patch" not in decision:
        return None

    payload = event["payload"]
    request: LivingStatePatchCommitRequest = {
        "schema_version": SCHEMA_VERSION,
        "trace_id": event["trace_id"],
        "event_id": event["event_id"],
        "event_type": event["type"],
        "decision_action": VISIBLE_REPLY_ACTION,
        "patch": deepcopy(decision["state_patch"]),
    }
    for field_name in ("user_id", "conversation_id"):
        if field_name in payload:
            request[field_name] = payload[field_name]
    return request


def commit_living_state_patch(
    source_event: RuntimeEvent,
    role_model_result: RoleModelTurnResult,
    *,
    living_state_patch_store: LivingStatePatchStore,
    living_state_patch_finalizer: LivingStatePatchFinalizer,
    raw_event_log: RawEventLog,
    id_generator: IdGenerator,
    clock: Clock,
) -> LivingStatePatchCommitResult:
    source_identity = _extract_trusted_source_identity(source_event)
    request: LivingStatePatchCommitRequest | None = None
    commit_time: str | None = None

    try:
        request = build_living_state_patch_commit_request(source_event, role_model_result)
        if request is None:
            return {
                "schema_version": SCHEMA_VERSION,
                "trace_id": source_identity["trace_id"],
                "event_id": source_identity["event_id"],
                "event_type": USER_MESSAGE,
                "status": LIVING_STATE_PATCH_SKIPPED_STATUS,
            }
        commit_time = clock_timestamp(clock)
        request["commit_time"] = commit_time
        try:
            committed_snapshot = living_state_patch_store.prepare_living_state_patch_commit(
                deepcopy(request)
            )
        except LivingStatePatchStoreError:
            raise

        validated_snapshot = validate_committed_living_state_patch(
            source_event=source_event,
            patch=request["patch"],
            committed_snapshot=committed_snapshot,
            commit_time=commit_time,
        )
        committed_log_entry = build_living_state_patch_committed_log_entry(
            source_event,
            role_model_result,
            request["patch"],
            validated_snapshot,
            id_generator=id_generator,
            clock=_clock_at(commit_time),
        )
        finalize_request = build_living_state_patch_finalize_request(
            request,
            committed_snapshot=validated_snapshot,
            committed_log_entry=committed_log_entry,
        )
        finalize_result = living_state_patch_finalizer.finalize_living_state_patch_commit(
            deepcopy(finalize_request)
        )
        validated_finalize_result = validate_living_state_patch_finalize_result(
            finalize_result,
            source_identity=source_identity,
            committed_log_entry=committed_log_entry,
        )
    except LivingStatePatchFinalizerError as error:
        failure = _build_failure(
            LIVING_STATE_PATCH_FINALIZE_STAGE,
            error.code,
            str(error),
        )
        raw_event_log.append(
            build_living_state_patch_rejected_log_entry(
                source_event,
                role_model_result_snapshot=role_model_result,
                patch_snapshot=request["patch"] if request is not None else None,
                failure=failure,
                id_generator=id_generator,
                clock=clock,
            )
        )
        return _build_rejected_result(source_identity, failure)
    except LivingStatePatchStoreError as error:
        failure = _build_failure(
            LIVING_STATE_PATCH_STORE_STAGE,
            error.code,
            str(error),
        )
        raw_event_log.append(
            build_living_state_patch_rejected_log_entry(
                source_event,
                role_model_result_snapshot=role_model_result,
                patch_snapshot=request["patch"] if request is not None else None,
                failure=failure,
                id_generator=id_generator,
                clock=clock,
            )
        )
        return _build_rejected_result(source_identity, failure)
    except LivingStatePatchCommitValidationError as error:
        failure = _build_failure(
            LIVING_STATE_PATCH_COMMIT_VALIDATION_STAGE,
            error.code,
            str(error),
        )
        raw_event_log.append(
            build_living_state_patch_rejected_log_entry(
                source_event,
                role_model_result_snapshot=role_model_result,
                patch_snapshot=request["patch"] if request is not None else None,
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
        "status": LIVING_STATE_PATCH_COMMITTED_STATUS,
        "committed_snapshot": deepcopy(validated_snapshot),
        "committed_log_entry_id": validated_finalize_result["committed_log_entry_id"],
    }


def validate_committed_living_state_patch(
    *,
    source_event: RuntimeEvent,
    patch: Mapping[str, Any],
    committed_snapshot: Mapping[str, Any],
    commit_time: str,
) -> dict[str, Any]:
    event = _validate_source_event(source_event)
    normalized_patch = _wrap_validation_contract_error(lambda: normalize_living_state_patch(patch))
    try:
        validated_snapshot = validate_current_character_state_snapshot(committed_snapshot)
    except SharedContractValidationError as error:
        raise LivingStatePatchStoreError(
            str(error),
            code="malformed_store_result",
        ) from error

    validated_commit_time = _wrap_validation_contract_error(
        lambda: validate_iso8601_timestamp(commit_time, "commit_time")
    )
    _validate_committed_snapshot_consistency(
        event=event,
        patch=normalized_patch,
        committed_snapshot=validated_snapshot,
        commit_time=validated_commit_time,
    )
    return validated_snapshot


def build_living_state_patch_committed_log_entry(
    source_event: RuntimeEvent,
    role_model_result: RoleModelTurnResult,
    patch: Mapping[str, Any],
    committed_snapshot: Mapping[str, Any],
    *,
    id_generator: IdGenerator,
    clock: Clock,
) -> RawEventLogEntry:
    event = _validate_source_event(source_event)
    result = _validate_role_model_result(role_model_result, source_event=event)
    normalized_patch = _wrap_validation_contract_error(lambda: normalize_living_state_patch(patch))
    validated_snapshot = _wrap_validation_contract_error(
        lambda: validate_current_character_state_snapshot(committed_snapshot)
    )

    return build_raw_log_entry(
        trace_id=event["trace_id"],
        event_id=event["event_id"],
        kind=LIVING_STATE_PATCH_COMMITTED_KIND,
        data={
            "source_event": event,
            "role_model_result": result,
            "patch": normalized_patch,
            "committed_snapshot": validated_snapshot,
        },
        id_generator=id_generator,
        clock=clock,
    )


def build_living_state_patch_finalize_request(
    commit_request: Mapping[str, Any],
    *,
    committed_snapshot: Mapping[str, Any],
    committed_log_entry: Mapping[str, Any],
) -> LivingStatePatchFinalizeRequest:
    if not isinstance(commit_request, Mapping):
        raise LivingStatePatchCommitValidationError("commit_request must be a mapping.")
    finalized_request = deepcopy(dict(commit_request))
    finalized_request["committed_snapshot"] = deepcopy(dict(committed_snapshot))
    finalized_request["committed_log_entry"] = deepcopy(dict(committed_log_entry))
    return finalized_request


def validate_living_state_patch_finalize_result(
    finalize_result: Any,
    *,
    source_identity: Mapping[str, str],
    committed_log_entry: Mapping[str, Any],
) -> LivingStatePatchFinalizeResult:
    if not isinstance(finalize_result, Mapping):
        raise LivingStatePatchFinalizerError(
            "LivingStatePatchFinalizeResult must be a mapping.",
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
            "LivingStatePatchFinalizeResult",
        )
        schema_version = require_equal(
            finalize_result.get("schema_version"),
            SCHEMA_VERSION,
            "LivingStatePatchFinalizeResult.schema_version",
        )
        trace_id = require_string(
            finalize_result.get("trace_id"),
            "LivingStatePatchFinalizeResult.trace_id",
        )
        event_id = require_string(
            finalize_result.get("event_id"),
            "LivingStatePatchFinalizeResult.event_id",
        )
        event_type = require_equal(
            finalize_result.get("event_type"),
            USER_MESSAGE,
            "LivingStatePatchFinalizeResult.event_type",
        )
        committed_log_entry_id = require_string(
            finalize_result.get("committed_log_entry_id"),
            "LivingStatePatchFinalizeResult.committed_log_entry_id",
        )
    except SharedContractValidationError as error:
        raise LivingStatePatchFinalizerError(
            str(error),
            code="malformed_finalize_result",
        ) from error

    if trace_id != source_identity["trace_id"]:
        raise LivingStatePatchFinalizerError(
            "LivingStatePatchFinalizeResult.trace_id must match source_event.trace_id.",
            code="malformed_finalize_result",
        )
    if event_id != source_identity["event_id"]:
        raise LivingStatePatchFinalizerError(
            "LivingStatePatchFinalizeResult.event_id must match source_event.event_id.",
            code="malformed_finalize_result",
        )
    if not isinstance(committed_log_entry, Mapping):
        raise LivingStatePatchFinalizerError(
            "committed_log_entry must be a mapping.",
            code="malformed_finalize_result",
        )
    try:
        expected_log_id = require_string(
            committed_log_entry.get("log_id"),
            "committed_log_entry.log_id",
        )
    except SharedContractValidationError as error:
        raise LivingStatePatchFinalizerError(
            str(error),
            code="malformed_finalize_result",
        ) from error
    if committed_log_entry_id != expected_log_id:
        raise LivingStatePatchFinalizerError(
            (
                "LivingStatePatchFinalizeResult.committed_log_entry_id must match "
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


def build_living_state_patch_rejected_log_entry(
    source_event: RuntimeEvent,
    *,
    role_model_result_snapshot: Any,
    patch_snapshot: Any | None,
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
    if patch_snapshot is not None:
        data["patch_snapshot"] = _snapshot(patch_snapshot)

    return build_raw_log_entry(
        trace_id=source_identity["trace_id"],
        event_id=source_identity["event_id"],
        kind=LIVING_STATE_PATCH_REJECTED_KIND,
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
                normalize_visible_reply_decision_with_optional_living_state_patch(
                    decision,
                    trace_id=source_event["trace_id"],
                    event_id=source_event["event_id"],
                    require_attached_ids=True,
                    allow_state_patch=True,
                    source_name="CharacterDecision",
                )
            ),
        )
    )


def _extract_trusted_source_identity(source_event: Any) -> dict[str, str]:
    if not isinstance(source_event, Mapping):
        raise LivingStatePatchCommitValidationError("source_event must be a mapping.")
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
) -> LivingStatePatchCommitResult:
    return {
        "schema_version": SCHEMA_VERSION,
        "trace_id": source_identity["trace_id"],
        "event_id": source_identity["event_id"],
        "event_type": USER_MESSAGE,
        "status": LIVING_STATE_PATCH_REJECTED_STATUS,
        "failure": deepcopy(dict(failure)),
    }


def _validate_failure(failure: Mapping[str, Any]) -> dict[str, str]:
    if not isinstance(failure, Mapping):
        raise LivingStatePatchCommitValidationError("failure must be a mapping.")
    _wrap_validation_contract_error(
        lambda: reject_extra_keys(failure, {"stage", "code", "message"}, "failure")
    )
    stage = failure.get("stage")
    if stage not in SUPPORTED_FAILURE_CODES_BY_STAGE:
        raise LivingStatePatchCommitValidationError(
            "failure.stage must be a supported living-state patch failure stage."
        )
    code = failure.get("code")
    if code not in SUPPORTED_FAILURE_CODES_BY_STAGE[stage]:
        raise LivingStatePatchCommitValidationError(
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
        if stage == LIVING_STATE_PATCH_STORE_STAGE:
            code = "malformed_store_result"
        elif stage == LIVING_STATE_PATCH_FINALIZE_STAGE:
            code = "malformed_finalize_result"
        else:
            code = "malformed_commit_input"
    return {"stage": stage, "code": code, "message": message}


def _validate_committed_snapshot_consistency(
    *,
    event: RuntimeEvent,
    patch: Mapping[str, Mapping[str, str]],
    committed_snapshot: Mapping[str, Any],
    commit_time: str,
) -> None:
    if event["event_id"] not in committed_snapshot["source_event_ids"]:
        raise LivingStatePatchStoreError(
            "committed_snapshot.source_event_ids must include source_event.event_id.",
            code="malformed_store_result",
        )

    for field_name, patch_value in patch["living_state"].items():
        if committed_snapshot["living_state"].get(field_name) != patch_value:
            raise LivingStatePatchStoreError(
                (
                    f"committed_snapshot.living_state.{field_name} must match "
                    f"patch.living_state.{field_name}."
                ),
                code="malformed_store_result",
            )

    updated_at = committed_snapshot["updated_at"]
    if _parse_iso8601_timestamp(updated_at) < _parse_iso8601_timestamp(event["created_at"]):
        raise LivingStatePatchStoreError(
            "committed_snapshot.updated_at must not be older than source_event.created_at.",
            code="malformed_store_result",
        )
    if updated_at != commit_time:
        raise LivingStatePatchStoreError(
            "committed_snapshot.updated_at must match the runtime commit timestamp.",
            code="malformed_store_result",
        )


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
        raise LivingStatePatchCommitValidationError(str(error), code=code) from error


def _snapshot(value: Any) -> Any:
    if isinstance(value, Mapping):
        return deepcopy(dict(value))
    return {"raw_value": repr(value)}
