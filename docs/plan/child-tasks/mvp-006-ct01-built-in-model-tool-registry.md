# MVP-006 CT-01 - Built-In Model Tool Registry

Parent active slice: [MVP-006 - Real Model Tools And Character State Patch](../active-slice.html)

## Goal

Define the built-in model tool contract that all MVP-006 work consumes. The registry should organize model-facing capabilities without creating an external plugin system.

## Current Scope

- Add shared model-tool types for built-in tool definitions, tool names, tool-call inputs, parsed decisions, allowed tool lists, and rejection reasons.
- Define the model-safe built-in JSON contract descriptions for `visible_reply` and `character_state.patch`; do not introduce a general JSON Schema or plugin framework.
- Define a versioned `CharacterDecision` shape based on ordered `toolCalls`.
- Preserve compatibility parsing for the MVP-005 single `action.type = "visible_reply"` shape.
- Add parser and validator coverage for malformed, unknown, disallowed, duplicate, missing-required, and unsupported tool calls.
- Freeze exported fixtures/helpers for downstream subthreads.

## Explicit Non-Goals

- No external plugin loading.
- No arbitrary tool execution.
- No provider HTTP logic.
- No Character State patch semantics beyond shared type hooks.
- No CLI or inspect integration.

## Likely Files

- `src/model-tools.ts`
- `src/role-model-contracts.ts`
- `src/role-model-loop.ts`
- `src/index.ts`
- `tests/model-tools.test.ts`
- `tests/role-model-contracts.test.ts`
- `tests/role-model-loop.test.ts`

## Dependencies

None. This task should land first or provide the stable contract that other tasks consume.

## Acceptance Criteria

- User-turn allowed tools include exactly `visible_reply` and optional `character_state.patch`.
- `visible_reply` remains required for user turns.
- `character_state.patch` is optional and may appear at most once.
- Unknown, duplicate, malformed, disallowed, and missing-required tool calls reject before commit.
- Existing MVP-005 visible-reply decision fixtures still parse through compatibility logic.
- Exports are immutable and do not use `any`, broad casts, or skipped TypeScript checks.

## Required Checks

- `pnpm lint`
- `pnpm typecheck`
- Focused Vitest files touched by this task
- `pnpm test` before handoff if dependencies are installed

## Handoff Expectations

Summarize the final tool-call shape, rejection taxonomy, compatibility behavior, files changed, checks run, and any contract decisions that CT-02 through CT-05 must follow.
