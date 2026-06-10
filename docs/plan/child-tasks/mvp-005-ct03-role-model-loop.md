# MVP-005 CT-03 - Role Model Loop

Parent active slice: [MVP-005 - Structured Role-Model User Turn Foundation](../active-slice.html)

Assigned subthread: `mvp-005-role-model-loop`

## Goal

Implement the MVP-005 Role Model Loop boundary for local user turns: render the input envelope,
invoke a local/fake role-model adapter, capture raw output, parse a `CharacterDecision`, and reject
malformed output before commit.

## Current Scope

- Define the local/fake role-model adapter interface.
- Implement a deterministic local adapter that preserves current accepted reply behavior by reusing the existing conversation-agent seam.
- Render or assemble `RoleModelInputEnvelope` from the `USER_MESSAGE` event and CT-02 context.
- Capture raw adapter output for durable evidence.
- Parse raw output into CT-01's `CharacterDecision` shape.
- Reject malformed output and unsupported action shapes with explicit CT-01 rejection reasons.
- Return a structured result that CT-04 can validate and commit or reject.

## Explicit Non-Goals

- Do not call any live model provider.
- Do not add API key handling, streaming, retries, prompt-template files, model selection, cost tracking, or provider-specific chat formatting.
- Do not commit visible messages or durable state directly.
- Do not build retrieval, tools, scheduling, Live2D, incidents, or full runtime-kernel routing.
- Do not change the CLI directly except through coordinator integration.

## Expected Files Or Areas

- New role-model loop module, likely `src/role-model-loop.ts`.
- Focused tests, likely `tests/role-model-loop.test.ts`.
- Existing deterministic agent behavior in `src/conversation.ts`; extract a narrow helper only if reusing the existing seam is otherwise impossible.
- CT-01 and CT-02 modules.
- `src/index.ts` if exports are needed by downstream tasks.

## Dependencies

- Depends on CT-01 decision contracts.
- Depends on CT-02 context builder for final integration.
- Can start with fixtures that match CT-01 if CT-02 is not merged.

## Coordination Notes

- Keep the local/fake adapter narrow and deterministic. It is not a live provider abstraction yet.
- Raw output should be captured for logging, but raw output must not mutate durable state directly.
- The Role Model Loop should parse and reject malformed output; CT-04 owns commit validation and durable mutation.
- If the local adapter needs existing reply behavior, reuse `createDeterministicCharacterAgent()` or extract a narrow conversation-core helper. Do not copy `findPreviousUserMessage`, reply text selection, or validation logic into the Role Model Loop.

## Acceptance Criteria

- Tests prove the local adapter can return a valid `visible_reply` decision matching current deterministic reply text.
- Tests prove malformed raw output is rejected before commit.
- Tests prove unsupported decision effects are rejected with explicit reasons.
- Tests prove returned loop results include enough model input/output evidence for CT-04/CT-05 durable logging and inspect output.
- Existing MVP-001 through MVP-004 tests continue to pass.

## Required Checks

- Focused role-model-loop tests.
- `pnpm check`
- `pnpm exec tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`
- `git diff --check`

## Handoff Expectations

Return a handoff with:

- adapter interface and local adapter behavior;
- parser and rejection behavior;
- exact files changed;
- checks run and results;
- accepted assumptions;
- unresolved questions or conflicts;
- integration instructions CT-04 and CT-05 must follow.
