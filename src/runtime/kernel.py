from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Any, Protocol
from uuid import uuid4

from runtime.logging import (
    SCHEMA_VERSION,
    Clock,
    IdGenerator,
    RawEventLogEntry,
    build_raw_log_entry,
    clock_timestamp,
    generate_id,
)

USER_MESSAGE = "USER_MESSAGE"
RAW_EVENT_RECEIVED_KIND = "runtime_event_received"

RuntimeEvent = dict[str, Any]
RuntimeRouteResult = dict[str, Any]
PayloadNormalizer = Callable[[Any], dict[str, Any]]
RouteBuilder = Callable[[RuntimeEvent], RuntimeRouteResult]
_MISSING = object()


class RuntimeValidationError(ValueError):
    """Raised when a RuntimeEvent input violates the active schema contract."""


class RawEventLog(Protocol):
    def append(self, entry: RawEventLogEntry) -> None: ...


def default_id_generator(kind: str) -> str:
    return f"{kind}_{uuid4().hex}"


def default_clock() -> datetime:
    return datetime.now(UTC)


class RuntimeKernel:
    def __init__(
        self,
        raw_event_log: RawEventLog,
        *,
        id_generator: IdGenerator = default_id_generator,
        clock: Clock = default_clock,
    ) -> None:
        self._raw_event_log = raw_event_log
        self._id_generator = id_generator
        self._clock = clock

    def handle_event(self, event_input: Mapping[str, Any]) -> RuntimeRouteResult:
        event = normalize_runtime_event(
            event_input,
            id_generator=self._id_generator,
            clock=self._clock,
        )
        self._raw_event_log.append(
            build_raw_event_log_entry(
                event,
                id_generator=self._id_generator,
                clock=self._clock,
            )
        )
        return route_runtime_event(event)


def normalize_runtime_event(
    event_input: Mapping[str, Any],
    *,
    id_generator: IdGenerator = default_id_generator,
    clock: Clock = default_clock,
) -> RuntimeEvent:
    if not isinstance(event_input, Mapping):
        raise RuntimeValidationError("Runtime event input must be a mapping.")

    event_type = _normalize_event_type(event_input.get("type"))
    payload = _normalize_payload_for_event_type(event_type, event_input.get("payload"))

    return {
        "event_id": _normalize_optional_id(
            event_input.get("event_id"),
            field_name="event_id",
            generated_kind="event",
            id_generator=id_generator,
        ),
        "trace_id": _normalize_optional_id(
            event_input.get("trace_id"),
            field_name="trace_id",
            generated_kind="trace",
            id_generator=id_generator,
        ),
        "type": event_type,
        "created_at": _normalize_created_at(
            event_input["created_at"] if "created_at" in event_input else _MISSING,
            clock=clock,
        ),
        "schema_version": _normalize_schema_version(event_input),
        "payload": payload,
    }


def build_raw_event_log_entry(
    event: RuntimeEvent,
    *,
    id_generator: IdGenerator = default_id_generator,
    clock: Clock = default_clock,
) -> RawEventLogEntry:
    return build_raw_log_entry(
        trace_id=event["trace_id"],
        event_id=event["event_id"],
        kind=RAW_EVENT_RECEIVED_KIND,
        data={"event": event},
        id_generator=id_generator,
        clock=clock,
    )


def route_runtime_event(event: RuntimeEvent) -> RuntimeRouteResult:
    event_type = event.get("type")
    route_builder = EVENT_ROUTE_BUILDERS.get(event_type) if isinstance(event_type, str) else None
    if route_builder is None:
        raise RuntimeValidationError(f"Unsupported event type for routing: {event_type!r}.")
    return route_builder(event)


def _route_user_message_event(event: RuntimeEvent) -> RuntimeRouteResult:
    return {
        "trace_id": event["trace_id"],
        "event_id": event["event_id"],
        "event_type": event["type"],
        "model_needed": False,
        "next_step": "logged_only",
    }


def _normalize_event_type(value: Any) -> str:
    if (
        not isinstance(value, str)
        or value not in EVENT_PAYLOAD_NORMALIZERS
        or value not in EVENT_ROUTE_BUILDERS
    ):
        raise RuntimeValidationError(f"Unsupported event type: {value!r}.")
    return value


def _normalize_payload_for_event_type(event_type: str, payload: Any) -> dict[str, Any]:
    normalizer = EVENT_PAYLOAD_NORMALIZERS[event_type]
    return normalizer(payload)


def _normalize_user_message_payload(payload: Any) -> dict[str, str]:
    if not isinstance(payload, Mapping):
        raise RuntimeValidationError("payload must be a mapping.")

    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        raise RuntimeValidationError("payload.text must be a non-empty string.")

    normalized = {"text": text}
    for field_name in ("user_id", "conversation_id"):
        if field_name in payload:
            value = payload[field_name]
            if value is None:
                continue
            if not isinstance(value, str):
                raise RuntimeValidationError(f"payload.{field_name} must be a string.")
            normalized[field_name] = value

    return normalized


def _normalize_optional_id(
    value: Any,
    *,
    field_name: str,
    generated_kind: str,
    id_generator: IdGenerator,
) -> str:
    if value is None:
        return generate_id(generated_kind, id_generator)
    if not isinstance(value, str):
        raise RuntimeValidationError(f"{field_name} must be a string when provided.")
    if not value.strip():
        return generate_id(generated_kind, id_generator)
    return value


def _normalize_created_at(value: Any, *, clock: Clock) -> str:
    if value is _MISSING:
        return clock_timestamp(clock)
    if not isinstance(value, str):
        raise RuntimeValidationError("created_at must be an ISO-8601 timestamp string.")
    _parse_iso8601_timestamp(value)
    return value


def _parse_iso8601_timestamp(value: str) -> None:
    if not value.strip():
        raise RuntimeValidationError("created_at must be an ISO-8601 timestamp string.")
    if not _has_datetime_component(value.strip()):
        raise RuntimeValidationError("created_at must be an ISO-8601 timestamp string.")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise RuntimeValidationError("created_at must be an ISO-8601 timestamp string.") from error


def _has_datetime_component(value: str) -> bool:
    return "T" in value or "t" in value or (len(value) > 10 and value[10].isspace())


def _normalize_schema_version(event_input: Mapping[str, Any]) -> str:
    if "schema_version" not in event_input:
        return SCHEMA_VERSION
    if event_input["schema_version"] != SCHEMA_VERSION:
        raise RuntimeValidationError(f"schema_version must be {SCHEMA_VERSION!r}.")
    return SCHEMA_VERSION


EVENT_PAYLOAD_NORMALIZERS: dict[str, PayloadNormalizer] = {
    USER_MESSAGE: _normalize_user_message_payload,
}

EVENT_ROUTE_BUILDERS: dict[str, RouteBuilder] = {
    USER_MESSAGE: _route_user_message_event,
}
