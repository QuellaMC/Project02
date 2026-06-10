# MVP-006 CT-03 - Character State Core

Parent active slice: [MVP-006 - Real Model Tools And Character State Patch](../active-slice.html)

## Goal

Create the minimal Character State module that owns durable current character state and all state patch semantics.

## Current Scope

- Define `CharacterRuntimeState`, `LivingStateCurrent`, `LivingStateBrief`, `CharacterStatePatch`, and state patch result snapshots.
- Keep the v1 state shape capped to `mood`, `energy`, `attention`, `currentActivity`, and `socialOrientation`, with tight enums and no history arrays.
- Provide a default initial state for a new local session.
- Build a compact `livingStateBrief` for DecisionContext.
- Validate state patch shape and semantic values.
- Apply accepted patches immutably and produce before/after snapshots.
- Accept valid no-op patches and return explicit no-op evidence such as `appliedChanges: []`.
- Add in-memory and file-backed state storage under the existing local session storage layout.
- Fail closed on malformed state records.

## Explicit Non-Goals

- No virtual body.
- No life incidents.
- No retrieval or memory.
- No scheduler or scheduled directives.
- No Live2D status.
- No model provider logic.
- No tool registry parsing beyond the interfaces needed to consume CT-01 contracts.

## Likely Files

- `src/character-state.ts`
- `src/local-storage.ts`
- `src/file-runtime-log-store.ts`
- `src/session-store.ts`
- `src/decision-context.ts`
- `src/index.ts`
- `tests/character-state.test.ts`
- `tests/local-storage.test.ts`
- `tests/file-runtime-log-store.test.ts`
- `tests/decision-context.test.ts`

## Dependencies

- CT-01 for the final `character_state.patch` tool-call input type.

## Acceptance Criteria

- New sessions can load a default state deterministically.
- Existing sessions without state data can be handled through a deliberate compatibility/default path.
- Valid patches produce immutable before/after snapshots.
- Valid no-op patches are accepted and produce explicit no-op evidence instead of rejecting the whole turn.
- Invalid enum/value/shape patches reject with stable state-specific reasons.
- File-backed state persists and reloads across process restarts.
- Malformed state data fails closed and does not silently repair durable evidence.
- DecisionContext can include a compact `livingStateBrief` without exposing full raw state history.

## Required Checks

- `pnpm lint`
- `pnpm typecheck`
- Focused Character State, local storage, and context tests
- `pnpm test` before handoff if dependencies are installed

## Handoff Expectations

Document the final state fields, patch rules, no-op behavior, default-state behavior, single storage API/path, malformed-record behavior, and exact APIs CT-04 should call for validation and commit planning. CT-04 should call these APIs rather than duplicating state enum validation or merge rules.
