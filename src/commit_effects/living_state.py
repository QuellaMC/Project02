from __future__ import annotations

from collections.abc import Callable, Mapping
from copy import deepcopy
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
    require_string,
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
)

LIVING_STATE_PATCH_COMMITTED_STATUS = "living_state_patch_committed"
LIVING_STATE_PATCH_SKIPPED_STATUS = "living_state_patch_skipped"
LIVING_STATE_PATCH_REJECTED_STATUS = "living_state_patch_rejected"
LIVING_STATE_PATCH_COMMITTED_KIND = "living_state_patch_committed"
LIVING_STATE_PATCH_REJECTED_KIND = "living_state_patch_rejected"
LIVING_STATE_PATCH_COMMIT_VALIDATION_STAGE = "living_state_patch_commit_validation"
LIVING_STATE_PATCH_STORE_STAGE = "living_state_patch_store"
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
}

RoleModelTurnResult = dict[str, Any]
LivingStatePatchCommitRequest = dict[str, Any]
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


class LivingStatePatchStore(Protocol):
    def commit_living_state_patch(
        self,
        request: LivingStatePatchCommitRequest,
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
    raw_event_log: RawEventLog,
    id_generator: IdGenerator,
    clock: Clock,
) -> LivingStatePatchCommitResult:
    source_identity = _extract_trusted_source_identity(source_event)
    request: LivingStatePatchCommitRequest | None = None

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
        try:
            committed_snapshot = living_state_patch_store.commit_living_state_patch(
                deepcopy(request)
            )
        except LivingStatePatchStoreError:
            raise

        try:
            validated_snapshot = validate_current_character_state_snapshot(committed_snapshot)
        except SharedContractValidationError as error:
            raise LivingStatePatchStoreError(
                str(error),
                code="malformed_store_result",
            ) from error
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

    raw_event_log.append(
        build_living_state_patch_committed_log_entry(
            source_event,
            role_model_result,
            request["patch"],
            validated_snapshot,
            id_generator=id_generator,
            clock=clock,
        )
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "trace_id": source_identity["trace_id"],
        "event_id": source_identity["event_id"],
        "event_type": USER_MESSAGE,
        "status": LIVING_STATE_PATCH_COMMITTED_STATUS,
        "committed_snapshot": deepcopy(validated_snapshot),
    }


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
    normalized_patch = _wrap_validation_contract_error(
        lambda: normalize_living_state_patch(patch)
    )
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
        code = (
            "malformed_store_result"
            if stage == LIVING_STATE_PATCH_STORE_STAGE
            else "malformed_commit_input"
        )
    return {"stage": stage, "code": code, "message": message}


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
