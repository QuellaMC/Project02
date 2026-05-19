import sys
import unittest
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from runtime.logging import (  # noqa: E402
    InMemoryRawEventLog,
    RawEventLogQueryValidationError,
    build_raw_log_entry,
)


def fixed_clock():
    return datetime(2026, 5, 19, 10, 0, 0, tzinfo=UTC)


class SequenceIdGenerator:
    def __init__(self):
        self.calls = []

    def __call__(self, kind):
        self.calls.append(kind)
        return f"{kind}-generated-{len(self.calls)}"


def raw_entry(id_generator, *, trace_id="trace-1", event_id="event-1", kind="kind-1", data=None):
    return build_raw_log_entry(
        trace_id=trace_id,
        event_id=event_id,
        kind=kind,
        data=deepcopy(data or {"payload": {"value": "original"}}),
        id_generator=id_generator,
        clock=fixed_clock,
    )


class RawEventLogQueryTests(unittest.TestCase):
    def test_query_returns_append_path_entries_as_deep_copies(self):
        ids = SequenceIdGenerator()
        store = InMemoryRawEventLog()
        stored_entry = raw_entry(ids, kind="runtime_event_received")
        other_trace_entry = raw_entry(ids, trace_id="trace-2", kind="runtime_event_received")

        store.append(stored_entry)
        store.append(other_trace_entry)
        stored_entry["data"]["payload"]["value"] = "mutated input"

        result = store.query({"trace_id": "trace-1"})
        result["entries"][0]["data"]["payload"]["value"] = "mutated result"
        second_result = store.query({"trace_id": "trace-1"})

        self.assertEqual(result["schema_version"], "0.1")
        self.assertEqual(result["trace_id"], "trace-1")
        self.assertEqual(len(result["entries"]), 1)
        self.assertEqual(second_result["entries"][0]["data"]["payload"]["value"], "original")

    def test_event_id_and_kind_filters_apply_to_appended_and_finalizer_entries(self):
        ids = SequenceIdGenerator()
        store = InMemoryRawEventLog()
        store.append(raw_entry(ids, kind="runtime_event_received"))
        success_entry = raw_entry(ids, kind="living_state_patch_committed")
        store.expose_committed_success_entry(success_entry)
        store.confirm_committed_success_entry(success_entry)
        store.append(
            raw_entry(
                ids,
                event_id="event-2",
                kind="visible_reply_committed",
            )
        )

        event_result = store.query(
            {
                "trace_id": "trace-1",
                "event_id": "event-1",
                "kinds": ["runtime_event_received", "living_state_patch_committed"],
            }
        )
        success_result = store.query(
            {"trace_id": "trace-1", "kinds": ["living_state_patch_committed"]}
        )

        self.assertEqual(
            [entry["kind"] for entry in event_result["entries"]],
            ["runtime_event_received", "living_state_patch_committed"],
        )
        self.assertEqual(
            [entry["kind"] for entry in success_result["entries"]],
            ["living_state_patch_committed"],
        )

    def test_finalizer_exposed_success_entries_are_duplicate_free(self):
        ids = SequenceIdGenerator()
        store = InMemoryRawEventLog()
        patch_entry = raw_entry(ids, kind="living_state_patch_committed")
        incident_entry = raw_entry(ids, kind="life_incident_started")

        store.expose_committed_success_entry(patch_entry)
        store.confirm_committed_success_entry(patch_entry)
        store.expose_committed_success_entry(patch_entry)
        store.confirm_committed_success_entry(patch_entry)
        store.append(patch_entry)
        store.expose_committed_success_entry(incident_entry)
        store.confirm_committed_success_entry(incident_entry)

        result = store.query(
            {
                "trace_id": "trace-1",
                "kinds": ["living_state_patch_committed", "life_incident_started"],
            }
        )

        self.assertEqual(
            [entry["kind"] for entry in result["entries"]],
            ["living_state_patch_committed", "life_incident_started"],
        )

    def test_unconfirmed_success_entries_are_not_queryable_and_can_be_discarded(self):
        ids = SequenceIdGenerator()
        store = InMemoryRawEventLog()
        success_entry = raw_entry(ids, kind="living_state_patch_committed")

        store.expose_committed_success_entry(success_entry)
        staged_result = store.query({"trace_id": "trace-1"})

        store.discard_committed_success_entry(success_entry)
        discarded_result = store.query({"trace_id": "trace-1"})

        self.assertEqual(staged_result["entries"], [])
        self.assertEqual(discarded_result["entries"], [])

    def test_rejects_malformed_queries_without_mutating_entries(self):
        ids = SequenceIdGenerator()
        store = InMemoryRawEventLog()
        store.append(raw_entry(ids, kind="runtime_event_received"))

        bad_queries = [
            {},
            {"trace_id": "trace-1", "kind": "runtime_event_received"},
            {"trace_id": "trace-1", "kinds": "runtime_event_received"},
            {"trace_id": "trace-1", "kinds": []},
            {"trace_id": "trace-1", "kinds": [123]},
            {"trace_id": " "},
            {"trace_id": "trace-1", "event_id": ""},
        ]
        for query in bad_queries:
            with self.subTest(query=query):
                with self.assertRaises(RawEventLogQueryValidationError):
                    store.query(query)
                self.assertEqual(len(store.query({"trace_id": "trace-1"})["entries"]), 1)

    def test_rejects_conflicting_duplicate_log_id_without_mutating_entries(self):
        ids = SequenceIdGenerator()
        store = InMemoryRawEventLog()
        entry = raw_entry(ids, kind="runtime_event_received")
        conflicting_entry = deepcopy(entry)
        conflicting_entry["kind"] = "role_model_turn_completed"

        store.append(entry)
        with self.assertRaises(RawEventLogQueryValidationError):
            store.expose_committed_success_entry(conflicting_entry)

        result = store.query({"trace_id": "trace-1"})
        self.assertEqual(len(result["entries"]), 1)
        self.assertEqual(result["entries"][0]["kind"], "runtime_event_received")


if __name__ == "__main__":
    unittest.main()
