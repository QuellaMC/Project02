# MVP-006 CT-04 - Runtime Commit Integration

Parent active slice: [MVP-006 - Real Model Tools And Character State Patch](../active-slice.html)

## Goal

Integrate built-in model tool calls, provider/local role-model output, and Character State patch planning into the local runtime commit path without intentional partial commits or duplicated logic.

## Current Scope

- Route parsed tool-call decisions through the local user-turn runtime path.
- Preserve the existing deterministic local adapter behavior as default.
- Commit `visible_reply` only turns with existing visible conversation semantics.
- Validate all parsed tool calls before intended mutation, then commit `visible_reply` plus valid changing or no-op `character_state.patch` through existing runtime/storage boundaries.
- Reject invalid provider output, malformed tool calls, missing visible replies, invalid visible replies, and invalid state patches before visible/state mutation.
- Persist requested tool calls, accepted tool plans, state before/after snapshots, no-op patch evidence, and rejection evidence in existing runtime logs.
- Preserve durable session resume and existing trace/raw event invariants.

## Explicit Non-Goals

- No provider HTTP implementation unless required by CT-02 integration.
- No CLI flag design unless required for focused integration tests.
- No inspect formatting.
- No retrieval, scheduler, external tools, incidents, virtual body, or Live2D.
- No second storage root or parallel runtime log system.
- No broad cross-file transaction framework. Preserve validation-before-mutation ordering and fail-closed evidence instead.

## Likely Files

- `src/local-runtime.ts`
- `src/runtime-log.ts`
- `src/file-runtime-log-store.ts`
- `src/local-storage.ts`
- `src/role-model-loop.ts`
- `src/decision-context.ts`
- `src/index.ts`
- `tests/local-runtime.test.ts`
- `tests/commit-effects.test.ts`
- `tests/file-runtime-log-store.test.ts`
- `tests/local-storage.test.ts`

## Dependencies

- CT-01 for tool-call contracts and parser behavior.
- CT-03 for state validation, patch application, and state storage APIs.
- CT-02 only for provider-shaped raw output/error evidence, not for live network behavior.

## Acceptance Criteria

- `visible_reply` only decisions still produce MVP-005-compatible visible conversation and role-model evidence.
- `visible_reply` plus valid changing `character_state.patch` commits visible conversation and state patch in one accepted turn.
- `visible_reply` plus valid no-op `character_state.patch` commits the visible reply and logs no-op state evidence.
- Invalid optional state patches reject the whole turn without visible messages or state mutation.
- Runtime evidence includes enough detail for inspect to show requested tools, state before/after, accepted patch, and rejection reasons.
- Existing storage integrity checks are updated so role-model, conversation, raw-event, and state evidence cannot drift silently.
- Existing relay, chat, trace, inspect, and session-resume compatibility tests remain green.

## Required Checks

- `pnpm lint`
- `pnpm typecheck`
- Focused runtime, commit-effects, storage, and local-runtime tests
- `pnpm test` before handoff if dependencies are installed

## Handoff Expectations

Explain the validation-before-mutation ordering, rejection behavior, no-op behavior, evidence shape, compatibility handling, checks run, and any inspect/CLI data CT-05 must render. Do not duplicate Character State enum validation or merge rules in runtime code.
