# MVP-005 CT-01 - Decision Contracts

Parent active slice: [MVP-005 - Structured Role-Model User Turn Foundation](../active-slice.html)

Assigned subthread: `mvp-005-decision-contracts`

## Goal

Define the minimal shared decision contracts for MVP-005 so all downstream work can use one
Role Model Loop vocabulary, one context shape, one decision shape, one rejection taxonomy, and one
fixture set.

## Current Scope

- Define `DecisionContext` for the local `USER_MESSAGE` path.
- Define `RoleModelInputEnvelope` with top-level event data, decision context, scoped allowed actions, and output contract text.
- Define `CharacterDecision` with the MVP-005-supported `visible_reply` shape.
- Define allowed-action names for this slice, starting with `visible_reply`.
- Define model I/O snapshot and parsed-decision evidence shapes for durable logging.
- Define decision rejection reason names for malformed output, unsupported effects, invalid visible replies, and commit validation failure.
- Provide deterministic fixtures or fixture factories for accepted and rejected user turns without exporting test-only helpers as production API.
- Export the shared contracts through `src/index.ts` only when the implementation needs public access.

## Explicit Non-Goals

- Do not implement the context builder.
- Do not implement the Role Model Loop.
- Do not implement commit/effects validation.
- Do not add real model providers, prompt templates, provider config, retrieval, scheduling, tools, Live2D, or full runtime modules.
- Do not create a parallel conversation message, runtime event, or storage contract.

## Expected Files Or Areas

- New decision contract module, likely `src/role-model-contracts.ts` or equivalent.
- Focused contract tests, likely `tests/role-model-contracts.test.ts`.
- `src/index.ts` if exports are needed by downstream tasks.

## Dependencies

- Can begin immediately from the active slice.
- CT-02 through CT-05 should depend on these exported production contract names. Test-only fixtures should stay in tests unless the production code also needs the helper.

## Coordination Notes

- Keep the contract small. Future fields are allowed only when this slice has a concrete caller.
- The current user message belongs in the top-level event envelope, not duplicated inside the character snapshot.
- Use existing `VisibleMessage`, `CharacterProfile`, `RuntimeEventIdentity`, and runtime event types instead of redefining them.
- Do not add a production `ModelIOSnapshotStore` or new storage file in this task. MVP-005 evidence contracts should be usable by the existing runtime trace/raw-event storage layer.
- Do not use `any`, broad casts, or non-null assertions to make the contract convenient.
- If a downstream task needs a new field, route that request back through this shared contract rather than adding a private shape.

## Acceptance Criteria

- Unit tests prove accepted fixtures are immutable and preserve event/session/character identity.
- Unit tests prove unsupported or malformed decision fixtures are represented by explicit rejection reasons.
- The contract names and expected module map are clear enough for CT-02 through CT-05 to consume without inventing local alternatives.
- Existing MVP-001 through MVP-004 tests continue to pass.

## Required Checks

- Focused decision-contract tests.
- `pnpm check`
- `pnpm exec tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`
- `git diff --check`

## Handoff Expectations

Return a handoff with:

- summary of the final contract names and shapes;
- exact files changed;
- exported types, helpers, fixtures, and rejection names;
- checks run and results;
- accepted assumptions;
- unresolved questions or conflicts;
- integration instructions CT-02 through CT-05 must follow.
