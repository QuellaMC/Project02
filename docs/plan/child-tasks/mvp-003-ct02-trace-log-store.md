# MVP-003 CT-02 - Trace And Log Store

Parent active slice: [MVP-003 - Runtime Event Trace For Local Chat](../active-slice.html)

Assigned subthread: `mvp-003-trace-log-store`

## Goal

Implement the in-memory trace and log store APIs for MVP-003: ordered runtime trace entries,
raw event log records, and visible conversation log records.

## Current Scope

- Define an append-only in-memory store for runtime trace entries.
- Define raw event log records for event receipt, validation success or rejection, visible commit, and final outcome.
- Define visible conversation log records for user and character messages that were actually committed.
- Include source `event_id` and `trace_id` on log records where relevant.
- Expose immutable read snapshots so callers cannot mutate stored records.
- Keep IDs and timestamps deterministic under tests through injected helpers or accepted contract types from CT-01.

## Explicit Non-Goals

- Do not persist logs to disk, database, browser storage, or external services.
- Do not implement replay, compaction, memory indexing, model I/O snapshots, or a UI.
- Do not implement chat CLI behavior or runtime turn routing.
- Do not duplicate conversation-core transcript mutation.

## Expected Files Or Areas

- `src/`
- `tests/`
- `src/index.ts`

## Dependencies

- Uses the event and trace identity contract from CT-01.
- If CT-01 is not merged yet, implement against the active-slice contract names and call out integration adjustments in the handoff.

## Coordination Notes

- Store APIs should be narrow and local-session oriented.
- Do not create a generalized logging framework with unused extension points.
- Coordinate exported type names with CT-03 before final integration.

## Acceptance Criteria

- Unit tests prove trace entries append in order and snapshots are immutable.
- Unit tests prove raw event records include source event and trace identity.
- Unit tests prove visible conversation log records are appended only through explicit committed-message inputs.
- Unit tests prove failed attempts can add raw rejection records without adding visible conversation records.

## Required Checks

- Focused trace/log store tests.
- `pnpm check`
- `pnpm exec tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`
- `git diff --check`

## Handoff Expectations

Return a handoff with:

- summary of store APIs and record shapes;
- exact files changed;
- checks run and results;
- exported types and helper names;
- accepted assumptions;
- unresolved questions or conflicts;
- any integration requirements for CT-03 and CT-04.
