# MVP-004 CT-02 - File-Backed Runtime Log Store

Parent active slice: [MVP-004 - Durable Local Runtime Continuity](../completed/mvp-004-durable-local-runtime-continuity.html)

Assigned subthread: `mvp-004-file-backed-runtime-log-store`

## Goal

Implement the durable runtime log store that persists MVP-003 trace entries, raw event records, and
visible conversation log records to per-session local files while preserving the existing in-memory
store contract where practical.

## Current Scope

- Implement file-backed append/read APIs for runtime trace entries inside a selected session directory.
- Implement file-backed append/read APIs for raw event records, including payload summaries, inside a selected session directory.
- Implement file-backed append/read APIs for visible conversation records inside a selected session directory.
- Preserve source `eventId`, `traceId`, `createdAt`, status, reason, visible message IDs, and payload summary fields.
- Return immutable snapshots from read APIs.
- Use CT-01's storage contract, codecs, per-session path helpers, session identity, and error policy.
- Keep writes safe enough for the single-process local CLI path.

## Explicit Non-Goals

- Do not implement session catalog UX, chat CLI flags, or inspection command output.
- Do not rehydrate conversation sessions except through focused log-store read tests.
- Do not introduce a general logging framework, database dependency, cloud sync, encryption, backup system, replay engine, memory index, model I/O snapshots, or provider payload archive.
- Do not duplicate the conversation core's transcript mutation logic.

## Expected Files Or Areas

- `src/file-runtime-log-store.ts`
- `tests/file-runtime-log-store.test.ts`
- `src/index.ts`

## Dependencies

- Depends on CT-01's storage contract.
- If CT-01 is not merged yet, write contract-facing tests or a narrow adapter surface, then call out integration adjustments in the handoff. Do not create alternate production codecs or file-layout helpers.

## Coordination Notes

- This task should make the durable store a drop-in persistence option for the local runtime path.
- Preserve MVP-003 in-memory store behavior and tests unless the main thread accepts a compatibility change.
- Do not allow returned snapshots or caller-owned input arrays to mutate persisted records.
- Keep session scoping at the CT-01 per-session directory boundary; do not add a competing `sessionId` field to runtime records unless the active slice is revised.

## Acceptance Criteria

- Unit tests prove trace, raw event, and conversation records append in order for a selected session and survive store reopen.
- Unit tests prove two sessions keep separate trace, raw event, and conversation records.
- Unit tests prove snapshots are immutable from caller perspective after append and after read.
- Unit tests prove rejected runtime outcomes can be persisted without adding visible conversation records.
- Unit tests prove corrupt or malformed JSONL records fail with CT-01 errors instead of being silently skipped.
- Existing runtime event, runtime log, local runtime, chat CLI, and relay tests continue to pass.

## Required Checks

- Focused durable log-store tests.
- Relevant runtime-log and local-runtime tests.
- `pnpm check`
- `pnpm exec tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`
- `git diff --check`

## Handoff Expectations

Return a handoff with:

- summary of durable log APIs and append/read behavior;
- exact files changed;
- checks run and results;
- exported types and helper names;
- accepted assumptions;
- unresolved questions or conflicts;
- integration requirements for CT-03, CT-04, and CT-05.
