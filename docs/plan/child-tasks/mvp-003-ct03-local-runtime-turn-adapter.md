# MVP-003 CT-03 - Local Runtime Turn Adapter

Parent active slice: [MVP-003 - Runtime Event Trace For Local Chat](../active-slice.html)

Assigned subthread: `mvp-003-local-runtime-turn-adapter`

## Goal

Implement the narrow local runtime entry point that accepts one `USER_MESSAGE` event, reuses the
existing conversation core, and records trace/log outcomes.

## Current Scope

- Add a local runtime turn adapter, expected as a small function such as `runLocalUserMessageEvent()`.
- Accept a validated `USER_MESSAGE` runtime event and an existing conversation session.
- Call `runCharacterTurn()` for reply generation and transcript mutation.
- Append trace and raw log records for received, started, committed, rejected, and completed outcomes.
- Append visible conversation log records only after the conversation core successfully commits user and character messages.
- Preserve conversation-core validation, atomicity, and recent-visible-context behavior.
- Return a structured runtime result that CT-04 can use without inspecting internals.

## Explicit Non-Goals

- Do not add a full Runtime Kernel or generic event router.
- Do not implement provider events, persistence, model calls, memory, tools, scheduler, or replay.
- Do not duplicate transcript mutation or deterministic character reply logic from the conversation core.
- Do not change terminal input/output in this task.

## Expected Files Or Areas

- `src/`
- `tests/`
- `src/index.ts`
- Existing conversation tests only if integration regressions require small additions.

## Dependencies

- Depends on CT-01 event contracts and CT-02 trace/log store contracts.
- Can begin with local stubs matching the active-slice contract if those tasks are not merged yet, but the handoff must flag any assumptions.

## Coordination Notes

- This task is the main reuse seam: runtime handling must call the conversation core rather than reimplementing message validation, reply validation, IDs, or transcript updates.
- Keep the adapter local-chat specific. Future provider and scheduler events are out of scope.
- Coordinate the returned result shape with CT-04.

## Acceptance Criteria

- Integration tests prove a successful `USER_MESSAGE` event returns the same character reply as the conversation core and records trace, raw log, and visible conversation log entries.
- Integration tests prove the second runtime turn can still see recent visible context from the first turn.
- Rejection tests prove invalid input and invalid agent replies create raw rejection traces without committing visible conversation log records for the failed turn.
- Existing MVP-002 conversation tests continue to pass.

## Required Checks

- Focused local runtime adapter tests.
- Relevant conversation and log tests.
- `pnpm check`
- `pnpm exec tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`
- `git diff --check`

## Handoff Expectations

Return a handoff with:

- summary of runtime adapter behavior;
- exact files changed;
- checks run and results;
- exported function and result names;
- accepted assumptions;
- unresolved questions or conflicts;
- any API details CT-04 must follow.
