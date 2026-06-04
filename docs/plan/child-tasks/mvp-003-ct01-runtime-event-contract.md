# MVP-003 CT-01 - Runtime Event Contract

Parent active slice: [MVP-003 - Runtime Event Trace For Local Chat](../active-slice.html)

Assigned subthread: `mvp-003-runtime-event-contract`

## Goal

Define the minimal runtime event contract for MVP-003 so every local chat input can become one
validated `USER_MESSAGE` event with separate event and trace identity.

## Current Scope

- Define one runtime event type: `USER_MESSAGE`.
- Define event ID, trace ID, event type, creation time, and normalized payload fields.
- Provide deterministic ID and clock injection for tests.
- Validate local user-message payloads using the existing one-line validation rules where practical.
- Export the contract through the public package entry point if that matches existing patterns.

## Explicit Non-Goals

- Do not add provider events, timer events, tool events, or scheduled-directive events.
- Do not implement runtime turn handling, logging stores, CLI behavior, persistence, or model calls.
- Do not recreate old runtime modules from `legacy/typescript`.

## Expected Files Or Areas

- `src/`
- `tests/`
- `src/index.ts`

## Coordination Notes

- This task owns the shared event shape used by CT-02, CT-03, and CT-04.
- Keep the contract small enough that downstream tasks can depend on it without pulling in a full runtime framework.
- If validation helper behavior must change, preserve all existing relay and conversation tests.

## Acceptance Criteria

- Unit tests prove a deterministic `USER_MESSAGE` event can be created with predictable event ID, trace ID, timestamp, and normalized payload.
- Unit tests prove empty or multi-line user messages are rejected before event creation completes.
- Unit tests prove event and trace IDs are separate fields with separate meanings.
- Existing MVP-001 relay and MVP-002 conversation tests continue to pass.

## Required Checks

- Focused event contract tests.
- `pnpm check`
- `pnpm exec tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`
- `git diff --check`

## Handoff Expectations

Return a handoff with:

- summary of event contract and validation behavior;
- exact files changed;
- checks run and results;
- exported types and helper names;
- accepted assumptions;
- unresolved questions or conflicts;
- any API details CT-02, CT-03, or CT-04 must follow.
