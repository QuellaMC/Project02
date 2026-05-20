from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from typing import Any, Protocol

from character.state.current import (
    ActiveIncidentRequest,
    ActiveIncidentSnapshot,
    validate_active_incident_request,
    validate_active_incident_snapshot,
)
from commit_effects.incident_start import (
    LIFE_INCIDENT_STARTED_KIND,
    LifeIncidentStartFinalizerError,
)
from runtime.contracts import (
    START_INCIDENT_ACTION,
    USER_MESSAGE,
    VISIBLE_REPLY_ACTION,
    ContractValidationError,
    reject_extra_keys,
    require_equal,
    require_optional_string,
    require_string,
    validate_iso8601_timestamp,
)
from runtime.logging import SCHEMA_VERSION, RawEventLogEntry, validate_raw_event_log_entry

LifeIncidentStartFinalizeRequest = dict[str, Any]
LifeIncidentStartFinalizeResult = dict[str, Any]


class CommittedSuccessRawEventLog(Protocol):
    def expose_committed_success_entry(self, entry: RawEventLogEntry) -> None: ...


class InMemoryLifeIncidentStore:
    """In-memory LifeIncidentStore for the single active incident MVP slice."""

    def __init__(self, *, raw_event_log: CommittedSuccessRawEventLog) -> None:
        self._raw_event_log = raw_event_log
        self._active_incident: ActiveIncidentSnapshot | None = None

    def finalize_life_incident_start(
        self,
        request: LifeIncidentStartFinalizeRequest,
    ) -> LifeIncidentStartFinalizeResult:
        validated_request = _validate_life_incident_start_finalize_request(request)
        if self._active_incident is not None:
            raise LifeIncidentStartFinalizerError(
                "Active incident already exists.",
                code="finalize_rejected",
            )

        committed_log_entry = validated_request["committed_log_entry"]
        self._raw_event_log.expose_committed_success_entry(committed_log_entry)
        self._active_incident = deepcopy(validated_request["started_incident"])

        return {
            "schema_version": SCHEMA_VERSION,
            "trace_id": validated_request["trace_id"],
            "event_id": validated_request["event_id"],
            "event_type": USER_MESSAGE,
            "committed_log_entry_id": committed_log_entry["log_id"],
        }

    def read_active_incident(
        self,
        request: ActiveIncidentRequest,
    ) -> ActiveIncidentSnapshot | None:
        validate_active_incident_request(request)
        if self._active_incident is None:
            return None
        return deepcopy(self._active_incident)


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
        optional_ids = _validate_optional_ids(request)
    except ContractValidationError as error:
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
    except ContractValidationError as error:
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


def _validate_optional_ids(request: Mapping[str, Any]) -> dict[str, str]:
    optional_ids: dict[str, str] = {}
    for field_name in ("user_id", "conversation_id"):
        if field_name in request:
            optional_ids[field_name] = require_optional_string(
                request[field_name],
                f"LifeIncidentStartFinalizeRequest.{field_name}",
            )
    return optional_ids


def _require_mapping(value: Any, field_name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ContractValidationError(f"{field_name} must be a mapping.")
    return value
