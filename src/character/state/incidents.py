from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Protocol

from character.state.current import (
    ActiveIncidentRequest,
    ActiveIncidentSnapshot,
    InterruptedIncidentRequest,
    InterruptedIncidentSnapshot,
    validate_active_incident_request,
    validate_active_incident_snapshot,
    validate_interrupted_incident_request,
)
from commit_effects.incident_cancel import (
    LIFE_INCIDENT_CANCELLED_KIND,
    LifeIncidentCancelFinalizerError,
    validate_cancelled_life_incident_snapshot,
)
from commit_effects.incident_complete import (
    LIFE_INCIDENT_COMPLETED_KIND,
    LifeIncidentCompleteFinalizerError,
    validate_completed_life_incident_snapshot,
)
from commit_effects.incident_interrupt import (
    LIFE_INCIDENT_INTERRUPTED_KIND,
    LifeIncidentInterruptFinalizerError,
    validate_interrupted_life_incident_snapshot,
)
from commit_effects.incident_start import (
    LIFE_INCIDENT_STARTED_KIND,
    LifeIncidentStartFinalizerError,
)
from runtime.contracts import (
    CANCEL_INCIDENT_ACTION,
    COMPLETE_INCIDENT_ACTION,
    INCIDENT_COMPLETION,
    START_INCIDENT_ACTION,
    USER_MESSAGE,
    VISIBLE_REPLY_ACTION,
    ContractValidationError,
    reject_extra_keys,
    require_equal,
    require_optional_string,
    require_string,
    require_supported_value,
    validate_iso8601_timestamp,
)
from runtime.logging import (
    SCHEMA_VERSION,
    RawEventLogEntry,
    RawEventLogQueryValidationError,
    validate_raw_event_log_entry,
)

LifeIncidentStartFinalizeRequest = dict[str, Any]
LifeIncidentStartFinalizeResult = dict[str, Any]
LifeIncidentCancelFinalizeRequest = dict[str, Any]
LifeIncidentCancelFinalizeResult = dict[str, Any]
LifeIncidentCompleteFinalizeRequest = dict[str, Any]
LifeIncidentCompleteFinalizeResult = dict[str, Any]
LifeIncidentInterruptFinalizeRequest = dict[str, Any]
LifeIncidentInterruptFinalizeResult = dict[str, Any]
IDENTIFIED_SCOPE_MODE = "identified"
SINGLE_USER_SELF_USE_SCOPE_MODE = "single_user_self_use"


class CommittedSuccessRawEventLog(Protocol):
    def expose_committed_success_entry(self, entry: RawEventLogEntry) -> None: ...


@dataclass(frozen=True)
class IncidentScope:
    mode: str
    user_id: str | None = None
    conversation_id: str | None = None


SINGLE_USER_SELF_USE_SCOPE = IncidentScope(mode=SINGLE_USER_SELF_USE_SCOPE_MODE)


class InMemoryLifeIncidentStore:
    """Scoped in-memory LifeIncidentStore for the active incident MVP slice."""

    def __init__(self, *, raw_event_log: CommittedSuccessRawEventLog) -> None:
        self._raw_event_log = raw_event_log
        self._active_incidents_by_scope: dict[IncidentScope, ActiveIncidentSnapshot] = {}
        self._interrupted_incidents_by_scope: dict[
            IncidentScope,
            InterruptedIncidentSnapshot,
        ] = {}

    def require_raw_event_log(self, raw_event_log: object) -> None:
        if raw_event_log is not self._raw_event_log:
            _raise_raw_event_log_mismatch(LifeIncidentStartFinalizerError)

    def require_life_incident_cancel_raw_event_log(self, raw_event_log: object) -> None:
        if raw_event_log is not self._raw_event_log:
            _raise_raw_event_log_mismatch(LifeIncidentCancelFinalizerError)

    def require_life_incident_complete_raw_event_log(self, raw_event_log: object) -> None:
        if raw_event_log is not self._raw_event_log:
            _raise_raw_event_log_mismatch(LifeIncidentCompleteFinalizerError)

    def require_life_incident_interrupt_raw_event_log(self, raw_event_log: object) -> None:
        if raw_event_log is not self._raw_event_log:
            _raise_raw_event_log_mismatch(LifeIncidentInterruptFinalizerError)

    def finalize_life_incident_start(
        self,
        request: LifeIncidentStartFinalizeRequest,
    ) -> LifeIncidentStartFinalizeResult:
        validated_request = _validate_life_incident_start_finalize_request(request)
        scope = _incident_scope_from_request(validated_request)
        if scope in self._active_incidents_by_scope:
            raise LifeIncidentStartFinalizerError(
                "Active incident already exists for this scope.",
                code="finalize_rejected",
            )

        committed_log_entry = validated_request["committed_log_entry"]
        try:
            self._raw_event_log.expose_committed_success_entry(committed_log_entry)
        except RawEventLogQueryValidationError as error:
            raise LifeIncidentStartFinalizerError(
                str(error),
                code="malformed_finalize_result",
            ) from error
        self._active_incidents_by_scope[scope] = deepcopy(validated_request["started_incident"])

        return {
            "schema_version": SCHEMA_VERSION,
            "trace_id": validated_request["trace_id"],
            "event_id": validated_request["event_id"],
            "event_type": USER_MESSAGE,
            "committed_log_entry_id": committed_log_entry["log_id"],
        }

    def complete_life_incident_start_after_log_visible(
        self,
        request: LifeIncidentStartFinalizeRequest,
    ) -> None:
        validated_request = _validate_life_incident_start_finalize_request(request)
        scope = _incident_scope_from_request(validated_request)
        current_active_incident = self._active_incidents_by_scope.get(scope)
        if current_active_incident != validated_request["started_incident"]:
            raise LifeIncidentStartFinalizerError(
                "Active incident changed before start could be completed.",
                code="finalize_rejected",
            )
        self._interrupted_incidents_by_scope.pop(scope, None)

    def discard_life_incident_start_after_log_not_visible(
        self,
        request: LifeIncidentStartFinalizeRequest,
    ) -> None:
        validated_request = _validate_life_incident_start_finalize_request(request)
        scope = _incident_scope_from_request(validated_request)
        current_active_incident = self._active_incidents_by_scope.get(scope)
        if current_active_incident == validated_request["started_incident"]:
            self._active_incidents_by_scope.pop(scope, None)

    def finalize_life_incident_cancel(
        self,
        request: LifeIncidentCancelFinalizeRequest,
    ) -> LifeIncidentCancelFinalizeResult:
        validated_request = _validate_life_incident_cancel_finalize_request(request)
        scope = _incident_scope_from_request(validated_request)
        current_active_incident = self._active_incidents_by_scope.get(scope)
        if current_active_incident is None:
            raise LifeIncidentCancelFinalizerError(
                "No active incident exists for this scope.",
                code="finalize_rejected",
            )
        if current_active_incident != validated_request["active_incident"]:
            raise LifeIncidentCancelFinalizerError(
                "Active incident changed before cancellation could be finalized.",
                code="finalize_rejected",
            )

        committed_log_entry = validated_request["committed_log_entry"]
        try:
            self._raw_event_log.expose_committed_success_entry(committed_log_entry)
        except RawEventLogQueryValidationError as error:
            raise LifeIncidentCancelFinalizerError(
                str(error),
                code="malformed_finalize_result",
            ) from error

        return {
            "schema_version": SCHEMA_VERSION,
            "trace_id": validated_request["trace_id"],
            "event_id": validated_request["event_id"],
            "event_type": USER_MESSAGE,
            "committed_log_entry_id": committed_log_entry["log_id"],
        }

    def complete_life_incident_cancel_after_log_visible(
        self,
        request: LifeIncidentCancelFinalizeRequest,
    ) -> None:
        validated_request = _validate_life_incident_cancel_finalize_request(request)
        scope = _incident_scope_from_request(validated_request)
        current_active_incident = self._active_incidents_by_scope.get(scope)
        if current_active_incident != validated_request["active_incident"]:
            raise LifeIncidentCancelFinalizerError(
                "Active incident changed before cancellation could be completed.",
                code="finalize_rejected",
            )
        self._active_incidents_by_scope.pop(scope, None)
        self._interrupted_incidents_by_scope.pop(scope, None)

    def finalize_life_incident_complete(
        self,
        request: LifeIncidentCompleteFinalizeRequest,
    ) -> LifeIncidentCompleteFinalizeResult:
        validated_request = _validate_life_incident_complete_finalize_request(request)
        scope = _incident_scope_from_request(validated_request)
        current_active_incident = self._active_incidents_by_scope.get(scope)
        if current_active_incident is None:
            raise LifeIncidentCompleteFinalizerError(
                "No active incident exists for this scope.",
                code="finalize_rejected",
            )
        if current_active_incident != validated_request["active_incident"]:
            raise LifeIncidentCompleteFinalizerError(
                "Active incident changed before completion could be finalized.",
                code="finalize_rejected",
            )

        committed_log_entry = validated_request["committed_log_entry"]
        try:
            self._raw_event_log.expose_committed_success_entry(committed_log_entry)
        except RawEventLogQueryValidationError as error:
            raise LifeIncidentCompleteFinalizerError(
                str(error),
                code="malformed_finalize_result",
            ) from error

        return {
            "schema_version": SCHEMA_VERSION,
            "trace_id": validated_request["trace_id"],
            "event_id": validated_request["event_id"],
            "event_type": validated_request["event_type"],
            "committed_log_entry_id": committed_log_entry["log_id"],
        }

    def complete_life_incident_complete_after_log_visible(
        self,
        request: LifeIncidentCompleteFinalizeRequest,
    ) -> None:
        validated_request = _validate_life_incident_complete_finalize_request(request)
        scope = _incident_scope_from_request(validated_request)
        current_active_incident = self._active_incidents_by_scope.get(scope)
        if current_active_incident != validated_request["active_incident"]:
            raise LifeIncidentCompleteFinalizerError(
                "Active incident changed before completion could be completed.",
                code="finalize_rejected",
            )
        self._active_incidents_by_scope.pop(scope, None)
        self._interrupted_incidents_by_scope.pop(scope, None)

    def finalize_life_incident_interrupt(
        self,
        request: LifeIncidentInterruptFinalizeRequest,
    ) -> LifeIncidentInterruptFinalizeResult:
        validated_request = _validate_life_incident_interrupt_finalize_request(request)
        scope = _incident_scope_from_request(validated_request)
        current_active_incident = self._active_incidents_by_scope.get(scope)
        if current_active_incident is None:
            raise LifeIncidentInterruptFinalizerError(
                "No active incident exists for this scope.",
                code="finalize_rejected",
            )
        if current_active_incident != validated_request["active_incident"]:
            raise LifeIncidentInterruptFinalizerError(
                "Active incident changed before interruption could be finalized.",
                code="finalize_rejected",
            )

        committed_log_entry = validated_request["committed_log_entry"]
        try:
            self._raw_event_log.expose_committed_success_entry(committed_log_entry)
        except RawEventLogQueryValidationError as error:
            raise LifeIncidentInterruptFinalizerError(
                str(error),
                code="malformed_finalize_result",
            ) from error

        return {
            "schema_version": SCHEMA_VERSION,
            "trace_id": validated_request["trace_id"],
            "event_id": validated_request["event_id"],
            "event_type": USER_MESSAGE,
            "committed_log_entry_id": committed_log_entry["log_id"],
        }

    def complete_life_incident_interrupt_after_log_visible(
        self,
        request: LifeIncidentInterruptFinalizeRequest,
    ) -> None:
        validated_request = _validate_life_incident_interrupt_finalize_request(request)
        scope = _incident_scope_from_request(validated_request)
        current_active_incident = self._active_incidents_by_scope.get(scope)
        if current_active_incident != validated_request["active_incident"]:
            raise LifeIncidentInterruptFinalizerError(
                "Active incident changed before interruption could be completed.",
                code="finalize_rejected",
            )
        self._active_incidents_by_scope.pop(scope, None)
        self._interrupted_incidents_by_scope[scope] = deepcopy(
            validated_request["interrupted_incident"]
        )

    def read_active_incident(
        self,
        request: ActiveIncidentRequest,
    ) -> ActiveIncidentSnapshot | None:
        validated_request = validate_active_incident_request(_drop_none_identity_fields(request))
        incident = self._active_incidents_by_scope.get(
            _incident_scope_from_request(validated_request)
        )
        if incident is None:
            return None
        return deepcopy(incident)

    def read_interrupted_incident(
        self,
        request: InterruptedIncidentRequest,
    ) -> InterruptedIncidentSnapshot | None:
        validated_request = validate_interrupted_incident_request(
            _drop_none_identity_fields(request)
        )
        incident = self._interrupted_incidents_by_scope.get(
            _incident_scope_from_request(validated_request)
        )
        if incident is None:
            return None
        return deepcopy(incident)


def _validate_life_incident_start_finalize_request(
    request: Any,
) -> LifeIncidentStartFinalizeRequest:
    if not isinstance(request, Mapping):
        raise LifeIncidentStartFinalizerError(
            "LifeIncidentStartFinalizeRequest must be a mapping.",
            code="malformed_finalize_result",
        )

    try:
        reject_extra_keys(
            request,
            {
                "schema_version",
                "trace_id",
                "event_id",
                "event_type",
                "decision_action",
                "life_action_type",
                "commit_time",
                "draft",
                "started_incident",
                "committed_log_entry",
                "user_id",
                "conversation_id",
            },
            "LifeIncidentStartFinalizeRequest",
        )
        schema_version = require_equal(
            request.get("schema_version"),
            SCHEMA_VERSION,
            "LifeIncidentStartFinalizeRequest.schema_version",
        )
        trace_id = require_string(
            request.get("trace_id"),
            "LifeIncidentStartFinalizeRequest.trace_id",
        )
        event_id = require_string(
            request.get("event_id"),
            "LifeIncidentStartFinalizeRequest.event_id",
        )
        event_type = require_equal(
            request.get("event_type"),
            USER_MESSAGE,
            "LifeIncidentStartFinalizeRequest.event_type",
        )
        decision_action = require_equal(
            request.get("decision_action"),
            VISIBLE_REPLY_ACTION,
            "LifeIncidentStartFinalizeRequest.decision_action",
        )
        life_action_type = require_equal(
            request.get("life_action_type"),
            START_INCIDENT_ACTION,
            "LifeIncidentStartFinalizeRequest.life_action_type",
        )
        commit_time = validate_iso8601_timestamp(
            request.get("commit_time"),
            "LifeIncidentStartFinalizeRequest.commit_time",
        )
        draft = _require_mapping(request.get("draft"), "LifeIncidentStartFinalizeRequest.draft")
        started_incident = validate_active_incident_snapshot(request.get("started_incident"))
        committed_log_entry = _validate_committed_log_entry(
            request.get("committed_log_entry"),
            trace_id=trace_id,
            event_id=event_id,
            started_incident=started_incident,
        )
        optional_ids = _validate_optional_ids(
            request,
            source_name="LifeIncidentStartFinalizeRequest",
        )
    except (ContractValidationError, RawEventLogQueryValidationError) as error:
        raise LifeIncidentStartFinalizerError(
            str(error),
            code="malformed_finalize_result",
        ) from error

    if started_incident["source_event_ids"] != [event_id]:
        raise LifeIncidentStartFinalizerError(
            "started_incident.source_event_ids must equal [event_id].",
            code="malformed_finalize_result",
        )
    if started_incident.get("started_at") != commit_time:
        raise LifeIncidentStartFinalizerError(
            "started_incident.started_at must match commit_time.",
            code="malformed_finalize_result",
        )

    validated_request: LifeIncidentStartFinalizeRequest = {
        "schema_version": schema_version,
        "trace_id": trace_id,
        "event_id": event_id,
        "event_type": event_type,
        "decision_action": decision_action,
        "life_action_type": life_action_type,
        "commit_time": commit_time,
        "draft": deepcopy(dict(draft)),
        "started_incident": started_incident,
        "committed_log_entry": committed_log_entry,
    }
    validated_request.update(optional_ids)
    return validated_request


def _validate_life_incident_cancel_finalize_request(
    request: Any,
) -> LifeIncidentCancelFinalizeRequest:
    if not isinstance(request, Mapping):
        raise LifeIncidentCancelFinalizerError(
            "LifeIncidentCancelFinalizeRequest must be a mapping.",
            code="malformed_finalize_result",
        )

    try:
        reject_extra_keys(
            request,
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
                "active_incident",
                "cancelled_incident",
                "committed_log_entry",
                "user_id",
                "conversation_id",
            },
            "LifeIncidentCancelFinalizeRequest",
        )
        schema_version = require_equal(
            request.get("schema_version"),
            SCHEMA_VERSION,
            "LifeIncidentCancelFinalizeRequest.schema_version",
        )
        trace_id = require_string(
            request.get("trace_id"),
            "LifeIncidentCancelFinalizeRequest.trace_id",
        )
        event_id = require_string(
            request.get("event_id"),
            "LifeIncidentCancelFinalizeRequest.event_id",
        )
        event_type = require_equal(
            request.get("event_type"),
            USER_MESSAGE,
            "LifeIncidentCancelFinalizeRequest.event_type",
        )
        decision_action = require_equal(
            request.get("decision_action"),
            VISIBLE_REPLY_ACTION,
            "LifeIncidentCancelFinalizeRequest.decision_action",
        )
        life_action_type = require_equal(
            request.get("life_action_type"),
            CANCEL_INCIDENT_ACTION,
            "LifeIncidentCancelFinalizeRequest.life_action_type",
        )
        incident_id = require_string(
            request.get("incident_id"),
            "LifeIncidentCancelFinalizeRequest.incident_id",
        )
        reason = require_string(
            request.get("reason"),
            "LifeIncidentCancelFinalizeRequest.reason",
        )
        commit_time = validate_iso8601_timestamp(
            request.get("commit_time"),
            "LifeIncidentCancelFinalizeRequest.commit_time",
        )
        active_incident = validate_active_incident_snapshot(request.get("active_incident"))
        cancelled_incident = validate_cancelled_life_incident_snapshot(
            request.get("cancelled_incident"),
            active_incident=active_incident,
            commit_request={
                "schema_version": schema_version,
                "trace_id": trace_id,
                "event_id": event_id,
                "event_type": event_type,
                "decision_action": decision_action,
                "life_action_type": life_action_type,
                "incident_id": incident_id,
                "reason": reason,
                "commit_time": commit_time,
            },
        )
        committed_log_entry = _validate_cancel_committed_log_entry(
            request.get("committed_log_entry"),
            trace_id=trace_id,
            event_id=event_id,
            active_incident=active_incident,
            cancelled_incident=cancelled_incident,
        )
        optional_ids = _validate_optional_ids(
            request,
            source_name="LifeIncidentCancelFinalizeRequest",
        )
    except (
        ContractValidationError,
        RawEventLogQueryValidationError,
        LifeIncidentCancelFinalizerError,
    ) as error:
        raise LifeIncidentCancelFinalizerError(
            str(error),
            code="malformed_finalize_result",
        ) from error
    except ValueError as error:
        raise LifeIncidentCancelFinalizerError(
            str(error),
            code=getattr(error, "code", "malformed_finalize_result"),
        ) from error

    if active_incident["incident_id"] != incident_id:
        raise LifeIncidentCancelFinalizerError(
            "active_incident.incident_id must match incident_id.",
            code="malformed_finalize_result",
        )

    validated_request: LifeIncidentCancelFinalizeRequest = {
        "schema_version": schema_version,
        "trace_id": trace_id,
        "event_id": event_id,
        "event_type": event_type,
        "decision_action": decision_action,
        "life_action_type": life_action_type,
        "incident_id": incident_id,
        "reason": reason,
        "commit_time": commit_time,
        "active_incident": active_incident,
        "cancelled_incident": cancelled_incident,
        "committed_log_entry": committed_log_entry,
    }
    validated_request.update(optional_ids)
    return validated_request


def _validate_life_incident_complete_finalize_request(
    request: Any,
) -> LifeIncidentCompleteFinalizeRequest:
    if not isinstance(request, Mapping):
        raise LifeIncidentCompleteFinalizerError(
            "LifeIncidentCompleteFinalizeRequest must be a mapping.",
            code="malformed_finalize_result",
        )

    try:
        reject_extra_keys(
            request,
            {
                "schema_version",
                "trace_id",
                "event_id",
                "event_type",
                "decision_action",
                "life_action_type",
                "incident_id",
                "commit_time",
                "active_incident",
                "completed_incident",
                "committed_log_entry",
                "user_id",
                "conversation_id",
            },
            "LifeIncidentCompleteFinalizeRequest",
        )
        schema_version = require_equal(
            request.get("schema_version"),
            SCHEMA_VERSION,
            "LifeIncidentCompleteFinalizeRequest.schema_version",
        )
        trace_id = require_string(
            request.get("trace_id"),
            "LifeIncidentCompleteFinalizeRequest.trace_id",
        )
        event_id = require_string(
            request.get("event_id"),
            "LifeIncidentCompleteFinalizeRequest.event_id",
        )
        event_type = require_supported_value(
            request.get("event_type"),
            {USER_MESSAGE, INCIDENT_COMPLETION},
            "LifeIncidentCompleteFinalizeRequest.event_type",
        )
        if event_type == USER_MESSAGE:
            decision_action = require_equal(
                request.get("decision_action"),
                VISIBLE_REPLY_ACTION,
                "LifeIncidentCompleteFinalizeRequest.decision_action",
            )
            life_action_type = require_equal(
                request.get("life_action_type"),
                COMPLETE_INCIDENT_ACTION,
                "LifeIncidentCompleteFinalizeRequest.life_action_type",
            )
        else:
            if "decision_action" in request or "life_action_type" in request:
                raise ContractValidationError(
                    "LifeIncidentCompleteFinalizeRequest must not include model decision fields "
                    "for INCIDENT_COMPLETION."
                )
            decision_action = None
            life_action_type = None
        incident_id = require_string(
            request.get("incident_id"),
            "LifeIncidentCompleteFinalizeRequest.incident_id",
        )
        commit_time = validate_iso8601_timestamp(
            request.get("commit_time"),
            "LifeIncidentCompleteFinalizeRequest.commit_time",
        )
        active_incident = validate_active_incident_snapshot(request.get("active_incident"))
        completed_incident = validate_completed_life_incident_snapshot(
            request.get("completed_incident"),
            active_incident=active_incident,
            commit_request={
                "schema_version": schema_version,
                "trace_id": trace_id,
                "event_id": event_id,
                "event_type": event_type,
                "incident_id": incident_id,
                "commit_time": commit_time,
            }
            | (
                {
                    "decision_action": decision_action,
                    "life_action_type": life_action_type,
                }
                if event_type == USER_MESSAGE
                else {}
            ),
        )
        committed_log_entry = _validate_complete_committed_log_entry(
            request.get("committed_log_entry"),
            trace_id=trace_id,
            event_id=event_id,
            active_incident=active_incident,
            completed_incident=completed_incident,
        )
        optional_ids = _validate_optional_ids(
            request,
            source_name="LifeIncidentCompleteFinalizeRequest",
        )
    except (
        ContractValidationError,
        RawEventLogQueryValidationError,
        LifeIncidentCompleteFinalizerError,
    ) as error:
        raise LifeIncidentCompleteFinalizerError(
            str(error),
            code="malformed_finalize_result",
        ) from error
    except ValueError as error:
        raise LifeIncidentCompleteFinalizerError(
            str(error),
            code=getattr(error, "code", "malformed_finalize_result"),
        ) from error

    if active_incident["incident_id"] != incident_id:
        raise LifeIncidentCompleteFinalizerError(
            "active_incident.incident_id must match incident_id.",
            code="malformed_finalize_result",
        )

    validated_request: LifeIncidentCompleteFinalizeRequest = {
        "schema_version": schema_version,
        "trace_id": trace_id,
        "event_id": event_id,
        "event_type": event_type,
        "incident_id": incident_id,
        "commit_time": commit_time,
        "active_incident": active_incident,
        "completed_incident": completed_incident,
        "committed_log_entry": committed_log_entry,
    }
    if event_type == USER_MESSAGE:
        validated_request["decision_action"] = decision_action
        validated_request["life_action_type"] = life_action_type
    validated_request.update(optional_ids)
    return validated_request


def _validate_life_incident_interrupt_finalize_request(
    request: Any,
) -> LifeIncidentInterruptFinalizeRequest:
    if not isinstance(request, Mapping):
        raise LifeIncidentInterruptFinalizerError(
            "LifeIncidentInterruptFinalizeRequest must be a mapping.",
            code="malformed_finalize_result",
        )

    try:
        reject_extra_keys(
            request,
            {
                "schema_version",
                "trace_id",
                "event_id",
                "event_type",
                "incident_id",
                "commit_time",
                "active_incident",
                "interrupted_incident",
                "committed_log_entry",
                "user_id",
                "conversation_id",
            },
            "LifeIncidentInterruptFinalizeRequest",
        )
        schema_version = require_equal(
            request.get("schema_version"),
            SCHEMA_VERSION,
            "LifeIncidentInterruptFinalizeRequest.schema_version",
        )
        trace_id = require_string(
            request.get("trace_id"),
            "LifeIncidentInterruptFinalizeRequest.trace_id",
        )
        event_id = require_string(
            request.get("event_id"),
            "LifeIncidentInterruptFinalizeRequest.event_id",
        )
        event_type = require_equal(
            request.get("event_type"),
            USER_MESSAGE,
            "LifeIncidentInterruptFinalizeRequest.event_type",
        )
        incident_id = require_string(
            request.get("incident_id"),
            "LifeIncidentInterruptFinalizeRequest.incident_id",
        )
        commit_time = validate_iso8601_timestamp(
            request.get("commit_time"),
            "LifeIncidentInterruptFinalizeRequest.commit_time",
        )
        active_incident = validate_active_incident_snapshot(request.get("active_incident"))
        interrupted_incident = validate_interrupted_life_incident_snapshot(
            request.get("interrupted_incident"),
            active_incident=active_incident,
            commit_request={
                "schema_version": schema_version,
                "trace_id": trace_id,
                "event_id": event_id,
                "event_type": event_type,
                "incident_id": incident_id,
                "commit_time": commit_time,
            },
        )
        committed_log_entry = _validate_interrupt_committed_log_entry(
            request.get("committed_log_entry"),
            trace_id=trace_id,
            event_id=event_id,
            active_incident=active_incident,
            interrupted_incident=interrupted_incident,
        )
        optional_ids = _validate_optional_ids(
            request,
            source_name="LifeIncidentInterruptFinalizeRequest",
        )
    except (
        ContractValidationError,
        RawEventLogQueryValidationError,
        LifeIncidentInterruptFinalizerError,
    ) as error:
        raise LifeIncidentInterruptFinalizerError(
            str(error),
            code="malformed_finalize_result",
        ) from error
    except ValueError as error:
        raise LifeIncidentInterruptFinalizerError(
            str(error),
            code=getattr(error, "code", "malformed_finalize_result"),
        ) from error

    if active_incident["incident_id"] != incident_id:
        raise LifeIncidentInterruptFinalizerError(
            "active_incident.incident_id must match incident_id.",
            code="malformed_finalize_result",
        )

    validated_request: LifeIncidentInterruptFinalizeRequest = {
        "schema_version": schema_version,
        "trace_id": trace_id,
        "event_id": event_id,
        "event_type": event_type,
        "incident_id": incident_id,
        "commit_time": commit_time,
        "active_incident": active_incident,
        "interrupted_incident": interrupted_incident,
        "committed_log_entry": committed_log_entry,
    }
    validated_request.update(optional_ids)
    return validated_request


def _validate_committed_log_entry(
    committed_log_entry: Any,
    *,
    trace_id: str,
    event_id: str,
    started_incident: Mapping[str, Any],
) -> RawEventLogEntry:
    try:
        entry = validate_raw_event_log_entry(committed_log_entry)
        require_equal(entry["trace_id"], trace_id, "committed_log_entry.trace_id")
        require_equal(entry["event_id"], event_id, "committed_log_entry.event_id")
        require_equal(entry["kind"], LIFE_INCIDENT_STARTED_KIND, "committed_log_entry.kind")
    except (ContractValidationError, RawEventLogQueryValidationError) as error:
        raise LifeIncidentStartFinalizerError(
            str(error),
            code="malformed_finalize_result",
        ) from error

    data = entry["data"]
    if data.get("started_incident") != dict(started_incident):
        raise LifeIncidentStartFinalizerError(
            "committed_log_entry.data.started_incident must match started_incident.",
            code="malformed_finalize_result",
        )
    return entry


def _validate_cancel_committed_log_entry(
    committed_log_entry: Any,
    *,
    trace_id: str,
    event_id: str,
    active_incident: Mapping[str, Any],
    cancelled_incident: Mapping[str, Any],
) -> RawEventLogEntry:
    try:
        entry = validate_raw_event_log_entry(committed_log_entry)
        require_equal(entry["trace_id"], trace_id, "committed_log_entry.trace_id")
        require_equal(entry["event_id"], event_id, "committed_log_entry.event_id")
        require_equal(entry["kind"], LIFE_INCIDENT_CANCELLED_KIND, "committed_log_entry.kind")
    except (ContractValidationError, RawEventLogQueryValidationError) as error:
        raise LifeIncidentCancelFinalizerError(
            str(error),
            code="malformed_finalize_result",
        ) from error

    data = entry["data"]
    if data.get("active_incident") != dict(active_incident):
        raise LifeIncidentCancelFinalizerError(
            "committed_log_entry.data.active_incident must match active_incident.",
            code="malformed_finalize_result",
        )
    if data.get("cancelled_incident") != dict(cancelled_incident):
        raise LifeIncidentCancelFinalizerError(
            "committed_log_entry.data.cancelled_incident must match cancelled_incident.",
            code="malformed_finalize_result",
        )
    return entry


def _validate_complete_committed_log_entry(
    committed_log_entry: Any,
    *,
    trace_id: str,
    event_id: str,
    active_incident: Mapping[str, Any],
    completed_incident: Mapping[str, Any],
) -> RawEventLogEntry:
    try:
        entry = validate_raw_event_log_entry(committed_log_entry)
        require_equal(entry["trace_id"], trace_id, "committed_log_entry.trace_id")
        require_equal(entry["event_id"], event_id, "committed_log_entry.event_id")
        require_equal(entry["kind"], LIFE_INCIDENT_COMPLETED_KIND, "committed_log_entry.kind")
    except (ContractValidationError, RawEventLogQueryValidationError) as error:
        raise LifeIncidentCompleteFinalizerError(
            str(error),
            code="malformed_finalize_result",
        ) from error

    data = entry["data"]
    if data.get("active_incident") != dict(active_incident):
        raise LifeIncidentCompleteFinalizerError(
            "committed_log_entry.data.active_incident must match active_incident.",
            code="malformed_finalize_result",
        )
    if data.get("completed_incident") != dict(completed_incident):
        raise LifeIncidentCompleteFinalizerError(
            "committed_log_entry.data.completed_incident must match completed_incident.",
            code="malformed_finalize_result",
        )
    return entry


def _validate_interrupt_committed_log_entry(
    committed_log_entry: Any,
    *,
    trace_id: str,
    event_id: str,
    active_incident: Mapping[str, Any],
    interrupted_incident: Mapping[str, Any],
) -> RawEventLogEntry:
    try:
        entry = validate_raw_event_log_entry(committed_log_entry)
        require_equal(entry["trace_id"], trace_id, "committed_log_entry.trace_id")
        require_equal(entry["event_id"], event_id, "committed_log_entry.event_id")
        require_equal(entry["kind"], LIFE_INCIDENT_INTERRUPTED_KIND, "committed_log_entry.kind")
    except (ContractValidationError, RawEventLogQueryValidationError) as error:
        raise LifeIncidentInterruptFinalizerError(
            str(error),
            code="malformed_finalize_result",
        ) from error

    data = entry["data"]
    if data.get("active_incident") != dict(active_incident):
        raise LifeIncidentInterruptFinalizerError(
            "committed_log_entry.data.active_incident must match active_incident.",
            code="malformed_finalize_result",
        )
    if data.get("interrupted_incident") != dict(interrupted_incident):
        raise LifeIncidentInterruptFinalizerError(
            "committed_log_entry.data.interrupted_incident must match interrupted_incident.",
            code="malformed_finalize_result",
        )
    return entry


def _validate_optional_ids(request: Mapping[str, Any], *, source_name: str) -> dict[str, str]:
    optional_ids: dict[str, str] = {}
    for field_name in ("user_id", "conversation_id"):
        if field_name in request and request[field_name] is not None:
            optional_ids[field_name] = require_optional_string(
                request[field_name],
                f"{source_name}.{field_name}",
            )
    return optional_ids


def _raise_raw_event_log_mismatch(
    error_cls: (
        type[LifeIncidentStartFinalizerError]
        | type[LifeIncidentCancelFinalizerError]
        | type[LifeIncidentCompleteFinalizerError]
        | type[LifeIncidentInterruptFinalizerError]
    ),
) -> None:
    raise error_cls(
        (
            "LifeIncidentStore must finalize against the same Raw Event Log "
            "instance that will confirm visibility."
        ),
        code="malformed_finalize_result",
    )


def _incident_scope_from_request(request: Mapping[str, Any]) -> IncidentScope:
    user_id = request.get("user_id")
    conversation_id = request.get("conversation_id")
    has_user_id = user_id is not None
    has_conversation_id = conversation_id is not None
    if not has_user_id and not has_conversation_id:
        return SINGLE_USER_SELF_USE_SCOPE
    return IncidentScope(
        mode=IDENTIFIED_SCOPE_MODE,
        user_id=user_id if has_user_id else None,
        conversation_id=conversation_id if has_conversation_id else None,
    )


def _drop_none_identity_fields(request: ActiveIncidentRequest) -> ActiveIncidentRequest:
    if not isinstance(request, Mapping):
        return request
    normalized_request = dict(request)
    for field_name in ("user_id", "conversation_id"):
        if normalized_request.get(field_name) is None:
            normalized_request.pop(field_name, None)
    return normalized_request


def _require_mapping(value: Any, field_name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ContractValidationError(f"{field_name} must be a mapping.")
    return value
