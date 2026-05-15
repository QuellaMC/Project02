from __future__ import annotations

from collections.abc import Callable
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any

SCHEMA_VERSION = "0.1"

RawEventLogEntry = dict[str, Any]
IdGenerator = Callable[[str], str]
Clock = Callable[[], datetime]


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
