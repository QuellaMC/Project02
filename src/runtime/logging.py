from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any

SCHEMA_VERSION = "0.1"
ATOMIC_FINALIZER_SUCCESS_KINDS = frozenset(
    {
        "living_state_patch_committed",
        "life_incident_started",
        "life_incident_cancelled",
        "life_incident_completed",
        "life_incident_interrupted",
    }
)

RawEventLogEntry = dict[str, Any]
RawEventLogQuery = dict[str, Any]
RawEventLogQueryResult = dict[str, Any]
IdGenerator = Callable[[str], str]
Clock = Callable[[], datetime]


class RawEventLogQueryValidationError(ValueError):
    """Raised when a Raw Event Log query or entry violates the read contract."""


class InMemoryRawEventLog:
    """Small queryable Raw Event Log helper for tests and debug visibility.

    Commit finalizers can stage already-built success entries through
    expose_committed_success_entry(). The commit caller confirms visibility only
    after validating the finalizer result, so malformed finalizer output cannot
    leave a rejected success entry queryable.
    """

    def __init__(self) -> None:
        self._entry_order: list[str] = []
        self._entries_by_log_id: dict[str, RawEventLogEntry] = {}
        self._pending_success_by_log_id: dict[str, RawEventLogEntry] = {}

    def append(self, entry: RawEventLogEntry) -> None:
        normalized_entry = validate_raw_event_log_entry(entry)
        if normalized_entry["kind"] in ATOMIC_FINALIZER_SUCCESS_KINDS:
            committed_entry = self._entries_by_log_id.get(normalized_entry["log_id"])
            if committed_entry is not None:
                if committed_entry != normalized_entry:
                    raise RawEventLogQueryValidationError(
                        "RawEventLogEntry.log_id already exists with different data."
                    )
                return
            raise RawEventLogQueryValidationError(
                "Atomic finalizer success entries must be exposed and confirmed before append."
            )
        self._record_entry(normalized_entry)

    def expose_committed_success_entry(self, entry: RawEventLogEntry) -> None:
        normalized_entry = _validate_atomic_finalizer_success_entry(entry)
        log_id = normalized_entry["log_id"]
        committed_entry = self._entries_by_log_id.get(log_id)
        if committed_entry is not None:
            if committed_entry != normalized_entry:
                raise RawEventLogQueryValidationError(
                    "RawEventLogEntry.log_id already exists with different data."
                )
            return
        existing_entry = self._pending_success_by_log_id.get(log_id)
        if existing_entry is not None and existing_entry != normalized_entry:
            raise RawEventLogQueryValidationError(
                "Pending RawEventLogEntry.log_id already exists with different data."
            )
        self._pending_success_by_log_id[log_id] = normalized_entry

    def confirm_committed_success_entry(self, entry: RawEventLogEntry) -> None:
        normalized_entry = _validate_atomic_finalizer_success_entry(entry)
        log_id = normalized_entry["log_id"]

        committed_entry = self._entries_by_log_id.get(log_id)
        if committed_entry is not None:
            if committed_entry != normalized_entry:
                raise RawEventLogQueryValidationError(
                    "Confirmed RawEventLogEntry.log_id already exists with different data."
                )
            return

        pending_entry = self._pending_success_by_log_id.get(log_id)
        if pending_entry is None:
            raise RawEventLogQueryValidationError(
                "Confirmed RawEventLogEntry was not staged by finalizer visibility."
            )
        if pending_entry != normalized_entry:
            raise RawEventLogQueryValidationError(
                "Confirmed RawEventLogEntry does not match pending success data."
            )
        self._pending_success_by_log_id.pop(log_id)
        self._record_entry(normalized_entry)

    def discard_committed_success_entry(self, entry: RawEventLogEntry) -> None:
        normalized_entry = _validate_atomic_finalizer_success_entry(entry)
        self._pending_success_by_log_id.pop(normalized_entry["log_id"], None)

    def query(self, query: Mapping[str, Any]) -> RawEventLogQueryResult:
        return query_raw_event_log_entries(self._entries(), query)

    def _entries(self) -> list[RawEventLogEntry]:
        return [self._entries_by_log_id[log_id] for log_id in self._entry_order]

    def _record_entry(self, entry: Mapping[str, Any]) -> None:
        normalized_entry = validate_raw_event_log_entry(entry)
        log_id = normalized_entry["log_id"]
        existing_entry = self._entries_by_log_id.get(log_id)
        if existing_entry is not None:
            if existing_entry != normalized_entry:
                raise RawEventLogQueryValidationError(
                    "RawEventLogEntry.log_id already exists with different data."
                )
            return
        self._entry_order.append(log_id)
        self._entries_by_log_id[log_id] = normalized_entry


def build_raw_log_entry(
    *,
    trace_id: str,
    event_id: str,
    kind: str,
    data: dict[str, Any],
    id_generator: IdGenerator,
    clock: Clock,
) -> RawEventLogEntry:
    return {
        "log_id": generate_id("log", id_generator),
        "trace_id": trace_id,
        "event_id": event_id,
        "kind": kind,
        "created_at": clock_timestamp(clock),
        "schema_version": SCHEMA_VERSION,
        "data": deepcopy(data),
    }


def generate_id(kind: str, id_generator: IdGenerator) -> str:
    generated = id_generator(kind)
    if not isinstance(generated, str) or not generated.strip():
        raise RuntimeError(f"ID generator returned an invalid {kind} id.")
    return generated


def clock_timestamp(clock: Clock) -> str:
    timestamp = clock()
    if not isinstance(timestamp, datetime):
        raise RuntimeError("Clock returned a non-datetime value.")
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=UTC)
    return timestamp.isoformat()


def query_raw_event_log_entries(
    entries: Iterable[Mapping[str, Any]],
    query: Mapping[str, Any],
) -> RawEventLogQueryResult:
    normalized_query = validate_raw_event_log_query(query)
    queried_entries = [
        entry
        for entry in (validate_raw_event_log_entry(entry) for entry in entries)
        if _entry_matches_query(entry, normalized_query)
    ]
    return {
        "schema_version": SCHEMA_VERSION,
        "trace_id": normalized_query["trace_id"],
        "entries": deepcopy(queried_entries),
    }


def confirm_committed_success_entry_visibility(
    raw_event_log: Any,
    entry: Mapping[str, Any],
) -> None:
    confirm = getattr(raw_event_log, "confirm_committed_success_entry", None)
    if callable(confirm):
        confirm(entry)


def discard_committed_success_entry_visibility(
    raw_event_log: Any,
    entry: Mapping[str, Any] | None,
) -> None:
    if entry is None:
        return
    discard = getattr(raw_event_log, "discard_committed_success_entry", None)
    if callable(discard):
        discard(entry)


def validate_raw_event_log_query(query: Mapping[str, Any]) -> RawEventLogQuery:
    if not isinstance(query, Mapping):
        raise RawEventLogQueryValidationError("RawEventLogQuery must be a mapping.")
    _reject_extra_keys(query, {"trace_id", "event_id", "kinds"}, "RawEventLogQuery")
    normalized_query: RawEventLogQuery = {
        "trace_id": _require_non_empty_string(query.get("trace_id"), "RawEventLogQuery.trace_id")
    }
    if "event_id" in query:
        normalized_query["event_id"] = _require_non_empty_string(
            query.get("event_id"),
            "RawEventLogQuery.event_id",
        )
    if "kinds" in query:
        kinds = query.get("kinds")
        if not isinstance(kinds, list):
            raise RawEventLogQueryValidationError("RawEventLogQuery.kinds must be a list.")
        if not kinds:
            raise RawEventLogQueryValidationError(
                "RawEventLogQuery.kinds must not be empty when provided."
            )
        normalized_query["kinds"] = [
            _require_non_empty_string(kind, "RawEventLogQuery.kinds[]") for kind in kinds
        ]
    return normalized_query


def validate_raw_event_log_entry(entry: Mapping[str, Any]) -> RawEventLogEntry:
    if not isinstance(entry, Mapping):
        raise RawEventLogQueryValidationError("RawEventLogEntry must be a mapping.")
    _reject_extra_keys(
        entry,
        {"schema_version", "log_id", "trace_id", "event_id", "kind", "created_at", "data"},
        "RawEventLogEntry",
    )
    if entry.get("schema_version") != SCHEMA_VERSION:
        raise RawEventLogQueryValidationError(
            f"RawEventLogEntry.schema_version must be {SCHEMA_VERSION!r}."
        )
    data = entry.get("data")
    if not isinstance(data, Mapping):
        raise RawEventLogQueryValidationError("RawEventLogEntry.data must be a mapping.")
    return {
        "schema_version": SCHEMA_VERSION,
        "log_id": _require_non_empty_string(entry.get("log_id"), "RawEventLogEntry.log_id"),
        "trace_id": _require_non_empty_string(entry.get("trace_id"), "RawEventLogEntry.trace_id"),
        "event_id": _require_non_empty_string(entry.get("event_id"), "RawEventLogEntry.event_id"),
        "kind": _require_non_empty_string(entry.get("kind"), "RawEventLogEntry.kind"),
        "created_at": _require_non_empty_string(
            entry.get("created_at"),
            "RawEventLogEntry.created_at",
        ),
        "data": deepcopy(dict(data)),
    }


def _validate_atomic_finalizer_success_entry(entry: Mapping[str, Any]) -> RawEventLogEntry:
    normalized_entry = validate_raw_event_log_entry(entry)
    if normalized_entry["kind"] not in ATOMIC_FINALIZER_SUCCESS_KINDS:
        raise RawEventLogQueryValidationError(
            "RawEventLogEntry.kind must be an atomic finalizer success kind."
        )
    return normalized_entry


def _entry_matches_query(
    entry: Mapping[str, Any],
    query: Mapping[str, Any],
) -> bool:
    if entry["trace_id"] != query["trace_id"]:
        return False
    if "event_id" in query and entry["event_id"] != query["event_id"]:
        return False
    if "kinds" in query and entry["kind"] not in query["kinds"]:
        return False
    return True


def _reject_extra_keys(
    value: Mapping[str, Any],
    allowed_keys: set[str],
    source_name: str,
) -> None:
    extra_keys = set(value) - allowed_keys
    if extra_keys:
        raise RawEventLogQueryValidationError(
            f"{source_name} has unsupported keys: {sorted(extra_keys)!r}."
        )


def _require_non_empty_string(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RawEventLogQueryValidationError(f"{field_name} must be a non-empty string.")
    return value
