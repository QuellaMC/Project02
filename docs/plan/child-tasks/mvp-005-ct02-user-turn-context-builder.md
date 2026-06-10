# MVP-005 CT-02 - User-Turn Context Builder

Parent active slice: [MVP-005 - Structured Role-Model User Turn Foundation](../active-slice.html)

Assigned subthread: `mvp-005-user-turn-context-builder`

## Goal

Build the minimal user-turn context builder that turns the current local runtime session and
`USER_MESSAGE` event into the compact `DecisionContext` consumed by the MVP-005 Role Model Loop.

## Current Scope

- Build a deterministic `DecisionContext` for local `USER_MESSAGE` turns.
- Include local character identity, session identity, selected recent visible messages, and runtime notes.
- Keep current user message data in the top-level event envelope supplied by CT-01's contract.
- Preserve recent visible message selection behavior used by the existing deterministic chat path.
- Return immutable snapshots that callers cannot mutate.
- Provide tests for fresh and resumed sessions.

## Explicit Non-Goals

- Do not implement semantic memory, retrieval, embeddings, summaries, exact source expansion, active threads, or context compaction.
- Do not implement living state, virtual body, incidents, scheduled directives, tools, or Live2D status.
- Do not call a model or parse model output.
- Do not mutate durable storage while building context.
- Do not change chat CLI routing except through coordinator integration.

## Expected Files Or Areas

- New context builder module, likely `src/decision-context.ts` or equivalent.
- Focused tests, likely `tests/decision-context.test.ts`.
- Existing conversation/session types in `src/conversation.ts` and `src/session-store.ts`.
- `src/index.ts` if exports are needed by downstream tasks.

## Dependencies

- Depends on CT-01 decision contract names.
- Can write contract-facing tests first if CT-01 is not merged.

## Coordination Notes

- Reuse `VisibleMessage`, `ConversationSession`, and `CharacterProfile` from the existing conversation core.
- Do not add a second recent-message selector. CT-02 should reuse or narrowly expose the existing conversation-core behavior that selects recent visible messages, and downstream CT-03 must consume that shared seam rather than choosing its own selection rule.
- The context builder should be read-only; it must not create sessions, select sessions, append metadata, or repair stores.
- If runtime notes need durable evidence later, coordinate with CT-04/CT-05 rather than creating a private log file.

## Acceptance Criteria

- Tests prove fresh-session context includes the local character, session identity, no recent messages, and allowed runtime notes.
- Tests prove resumed-session context includes selected recent visible messages in the same order used by the existing local chat reply behavior.
- Tests prove the current user message is not duplicated inside the character snapshot.
- Tests prove returned context, messages, and nested arrays/objects are immutable from caller perspective.
- Existing MVP-001 through MVP-004 tests continue to pass.

## Required Checks

- Focused context-builder tests.
- `pnpm check`
- `pnpm exec tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`
- `git diff --check`

## Handoff Expectations

Return a handoff with:

- context fields produced and fields intentionally omitted;
- exact files changed;
- checks run and results;
- accepted assumptions;
- unresolved questions or conflicts;
- instructions CT-03 and CT-04 need for consuming the builder.
