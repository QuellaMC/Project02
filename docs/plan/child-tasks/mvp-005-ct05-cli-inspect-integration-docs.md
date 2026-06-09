# MVP-005 CT-05 - CLI, Inspect, Integration Review, And Docs

Parent active slice: [MVP-005 - Structured Role-Model User Turn Foundation](../active-slice.html)

Assigned subthread: `mvp-005-cli-inspect-integration-docs`

## Goal

Route the local chat CLI through the structured role-model user-turn path, extend inspect output for
role-model evidence, perform cross-thread integration review, and keep MVP-005 docs aligned with
actual implementation behavior.

## Current Scope

- Update `pnpm chat` routing through the shared `runLocalUserMessageEvent` local-runtime seam after CT-02, CT-03, and CT-04 are integrated; do not assemble those pieces directly in `chat-cli.ts`.
- Preserve existing user-facing chat output for accepted turns unless the main thread accepts a documented compatibility change.
- Preserve `--store`, `--session`, `--new-session`, and `--trace` behavior from MVP-004.
- Extend `pnpm inspect -- --store <path> --session <session-id>` to show role-model input/output, parsed decision, validation result, accepted visible reply text, and rejection reason.
- Prove inspect remains read-only and does not mutate session metadata or runtime logs.
- Review CT-01 through CT-04 handoffs for shared-contract reuse, duplicate logic, and scope discipline.
- Update durable docs and the dated journal after implementation details are known.
- Prepare the final PR-readiness checklist for the main thread.

## Explicit Non-Goals

- Do not create a competing active slice.
- Do not implement live model providers, retrieval, scheduling, tools, Live2D, webhooks, replay mutation, or full runtime-kernel work.
- Do not rewrite sibling implementations unless review evidence shows a concrete actionable problem.
- Do not add broad docs pages that the current slice does not need.
- Do not resolve product decisions silently if the active slice does not authorize them.

## Expected Files Or Areas

- `src/chat-cli.ts`
- `src/inspect-cli.ts`
- `tests/chat-cli.contract.test.ts`
- `tests/inspect-cli.contract.test.ts`
- Review-determined focused runtime/log tests.
- `docs/plan/active-slice.html`
- `docs/plan/child-tasks/`
- `docs/develop-journal/2026-06-09/journal.html`

## Dependencies

- Can begin read-only review against this draft and CT-01's contract.
- CLI routing depends on CT-02, CT-03, and CT-04.
- Inspect extension depends on CT-04 durable evidence shape.
- Final docs updates depend on CT-01 through CT-04 handoffs.

## Coordination Notes

- Findings should lead the handoff, ordered by severity or integration risk.
- Keep inspect output stable enough for tests but do not pretend it is replay.
- Keep `chat-cli.ts` as a terminal boundary. Shared user-turn orchestration should live behind `runLocalUserMessageEvent` or a narrow local-runtime helper that `runLocalUserMessageEvent` owns.
- If implementation reveals a product decision not settled by the active slice, escalate it to the main thread before changing scope.
- Stage this task in three passes when practical: early read-only integration review, CLI/inspect implementation after dependencies, and final PR-readiness review after all task work is merged.

## Implementation Notes

- CT-04 already routes the chat CLI through `runLocalUserMessageEvent`; CT-05 did not need to
  assemble role-model pieces in `src/chat-cli.ts`.
- Inspect renders role-model evidence from existing terminal raw event records only. The decoded
  `roleModelEvidence` object includes the input envelope summary, raw adapter output text, parsed
  decision status, and commit validation status.
- Accepted turns expose `allowedActions`, parsed `visible_reply` text, accepted visible reply text,
  and the existing visible messages. Rejected role-model or commit decisions expose rejection
  reason/details and no fake visible messages.
- The evidence remains local/fake-adapter only, `visible_reply` only, and raw-event attached through
  optional `roleModelIOSnapshot`, `parsedRoleModelDecisionSnapshot`, and `commitValidation`
  snapshots. No provider, retrieval, scheduler, tools, Live2D, replay mutation, or full runtime
  module was added.

## Acceptance Criteria

- Tests prove default chat still prints accepted Mira replies as before.
- Tests prove durable session resume still preserves MVP-004 deterministic context behavior.
- Tests prove trace mode remains JSON Lines compatible.
- Tests prove inspect can show accepted and rejected role-model evidence after process restart.
- Tests prove inspect remains read-only.
- Handoff confirms whether final code satisfies each active-slice acceptance criterion.
- Handoff confirms no sibling task introduced a parallel event, decision, log, session, or storage contract.
- Journal/docs updates match actual behavior and do not imply memory, retrieval, providers, schedulers, tools, Live2D, or full runtime work.

## Required Checks

- Focused chat CLI and inspect CLI contract tests.
- Review-determined focused tests.
- Final integrated `pnpm check`.
- `pnpm exec tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`
- `git diff --check`
- HTML parse or equivalent sanity check for edited HTML docs.

## Handoff Expectations

Return a handoff with:

- findings first;
- CLI and inspect behavior summary;
- acceptance-criteria checklist;
- compatibility checklist;
- docs/journal changes made;
- commands run and results;
- unresolved questions or conflicts;
- confirmation of any files changed.
