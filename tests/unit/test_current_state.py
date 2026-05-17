import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from character.state import (  # noqa: E402
    CharacterRuntimeStateSnapshot as ExportedCharacterRuntimeStateSnapshot,
)
from character.state import __all__ as character_state_public_contracts  # noqa: E402
from character.state.current import (  # noqa: E402
    build_current_character_state_request,
    build_living_state_brief,
    validate_current_character_state_request,
    validate_current_character_state_snapshot,
    validate_living_state_brief_for_event,
)
from runtime.contracts import ContractValidationError  # noqa: E402


def normalized_user_message():
    return {
        "event_id": "event-1",
        "trace_id": "trace-1",
        "type": "USER_MESSAGE",
        "created_at": "2026-05-14T11:30:00+00:00",
        "schema_version": "0.1",
        "payload": {
            "text": "hello",
            "user_id": "user-1",
            "conversation_id": "conversation-1",
        },
    }


def current_state_snapshot():
    return {
        "schema_version": "0.1",
        "character_id": "character-1",
        "living_state": {
            "current_activity": "writing notes",
            "mood": "focused",
            "toward_user": "warm",
        },
        "updated_at": "2026-05-14T11:29:00+00:00",
        "source_event_ids": ["event-prior-state"],
    }


class PublicContractExportTests(unittest.TestCase):
    def test_reexports_character_runtime_state_snapshot_contract(self):
        self.assertIn("CharacterRuntimeStateSnapshot", character_state_public_contracts)
        self.assertIsNotNone(ExportedCharacterRuntimeStateSnapshot)


class CurrentCharacterStateRequestTests(unittest.TestCase):
    def test_builds_request_from_normalized_user_message_without_character_id(self):
        request = build_current_character_state_request(normalized_user_message())

        self.assertEqual(
            request,
            {
                "schema_version": "0.1",
                "trace_id": "trace-1",
                "event_id": "event-1",
                "event_type": "USER_MESSAGE",
                "user_id": "user-1",
                "conversation_id": "conversation-1",
            },
        )
        self.assertNotIn("character_id", request)

    def test_request_preserves_empty_optional_ids_when_event_contains_them(self):
        event = normalized_user_message()
        event["payload"]["user_id"] = ""
        event["payload"]["conversation_id"] = ""

        request = build_current_character_state_request(event)

        self.assertEqual(request["user_id"], "")
        self.assertEqual(request["conversation_id"], "")

    def test_rejects_request_extra_fields_and_wrong_event_type(self):
        with self.assertRaisesRegex(ContractValidationError, "character_id"):
            validate_current_character_state_request(
                {
                    "schema_version": "0.1",
                    "trace_id": "trace-1",
                    "event_id": "event-1",
                    "event_type": "USER_MESSAGE",
                    "character_id": "character-1",
                }
            )

        with self.assertRaisesRegex(ContractValidationError, "USER_MESSAGE"):
            validate_current_character_state_request(
                {
                    "schema_version": "0.1",
                    "trace_id": "trace-1",
                    "event_id": "event-1",
                    "event_type": "TIMER",
                }
            )


class CurrentCharacterStateSnapshotTests(unittest.TestCase):
    def test_maps_valid_snapshot_to_living_state_brief(self):
        brief = build_living_state_brief(current_state_snapshot())

        self.assertEqual(
            brief,
            {
                "character_id": "character-1",
                "current_activity": "writing notes",
                "mood": "focused",
                "toward_user": "warm",
                "updated_at": "2026-05-14T11:29:00+00:00",
                "source_event_ids": ["event-prior-state"],
            },
        )

    def test_snapshot_validation_copies_source_event_ids(self):
        snapshot = current_state_snapshot()
        validated = validate_current_character_state_snapshot(snapshot)
        validated["source_event_ids"].append("mutated")

        self.assertEqual(snapshot["source_event_ids"], ["event-prior-state"])

    def test_rejects_living_state_brief_sourced_from_current_event(self):
        brief = build_living_state_brief(
            {**current_state_snapshot(), "source_event_ids": ["event-1"]}
        )

        with self.assertRaisesRegex(ContractValidationError, "current event_id"):
            validate_living_state_brief_for_event(brief, event_id="event-1")

    def test_rejects_malformed_state_snapshots(self):
        cases = [
            ({**current_state_snapshot(), "schema_version": "0.2"}, "schema_version"),
            ({**current_state_snapshot(), "character_id": ""}, "character_id"),
            (
                {
                    **current_state_snapshot(),
                    "living_state": {
                        "current_activity": "",
                        "mood": "focused",
                        "toward_user": "warm",
                    },
                },
                "current_activity",
            ),
            (
                {
                    **current_state_snapshot(),
                    "living_state": {
                        "current_activity": "writing notes",
                        "mood": "focused",
                        "toward_user": "warm",
                        "future_field": "nope",
                    },
                },
                "future_field",
            ),
            ({**current_state_snapshot(), "updated_at": "2026-05-14"}, "updated_at"),
            ({**current_state_snapshot(), "source_event_ids": "event-1"}, "source_event_ids"),
            ({**current_state_snapshot(), "source_event_ids": [""]}, "source_event_ids"),
            ({**current_state_snapshot(), "future_field": "nope"}, "future_field"),
            ("not a mapping", "CharacterRuntimeStateSnapshot"),
        ]

        for snapshot, error_pattern in cases:
            with self.subTest(error_pattern=error_pattern):
                with self.assertRaisesRegex(ContractValidationError, error_pattern):
                    validate_current_character_state_snapshot(snapshot)


if __name__ == "__main__":
    unittest.main()
