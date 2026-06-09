# MVP-004 CT-05 - Inspection, Integration Review, And Docs

Parent active slice: [MVP-004 - Durable Local Runtime Continuity](../completed/mvp-004-durable-local-runtime-continuity.html)

Assigned subthread: `mvp-004-inspection-integration-docs`

## Goal

Add a narrow read-only `pnpm inspect` path for durable runtime sessions, then perform cross-thread
integration review and documentation alignment for MVP-004.

## Current Scope

- Implement `src/inspect-cli.ts` and the package script `pnpm inspect`.
- Support `pnpm inspect -- --store <path> --sessions` for listing sessions with stable IDs and useful timestamps.
- Support `pnpm inspect -- --store <path> --session <session-id>` for selected-session turn evidence: event IDs, trace IDs, statuses, ordered trace step names, and visible message text.
- Verify inspect output works after the original chat process exits.
- Review CT-01 through CT-04 handoffs for shared-contract reuse, compatibility, and scope discipline.
- Update durable docs and the dated journal after implementation details are known.
- Prepare the final PR-readiness checklist for the main thread.

## Explicit Non-Goals

- Do not create a competing active slice.
- Do not implement replay that mutates state or re-executes model calls.
- Do not widen MVP-004 into memory, retrieval, scheduler, provider support, tools, Live2D, accounts, cloud sync, or a full Runtime Kernel.
- Do not rewrite sibling implementations unless review evidence shows a concrete actionable problem.
- Do not add broad docs pages that the current slice does not need.

## Expected Files Or Areas

- `src/inspect-cli.ts`
- `tests/inspect-cli.contract.test.ts`
- `package.json` for the `pnpm inspect` script.
- `docs/plan/active-slice.html`
- `docs/plan/child-tasks/`
- `docs/develop-journal/2026-06-04/journal.html`

## Dependencies

- Can begin read-only against this draft and CT-01's contract.
- Inspect implementation depends on CT-02 durable log reads and CT-03 session catalog reads.
- Final implementation review depends on CT-01 through CT-04 handoffs.

## Coordination Notes

- Findings should lead the handoff, ordered by severity or integration risk.
- Inspect output should be stable enough for tests but not pretend to be a replay UI.
- This task owns the `pnpm inspect` package script; CT-04 should touch `package.json`
  only for chat-specific needs.
- Keep docs factual: durable local runtime truth exists; semantic memory and retrieval do not.
- If implementation reveals a product decision not settled by the active slice, escalate it to the main thread before changing scope.
- Stage this task in three passes when practical: early read-only integration review, inspect implementation after CT-02/CT-03, and final PR-readiness review after CT-04.

## Acceptance Criteria

- Tests prove `pnpm inspect -- --store <path> --sessions` can list sessions after process restart.
- Tests prove `pnpm inspect -- --store <path> --session <session-id>` can show selected-session runtime evidence after process restart.
- Tests prove inspect is read-only and does not append runtime records or mutate session metadata unexpectedly.
- Handoff confirms whether the final code satisfies each active-slice acceptance criterion.
- Handoff confirms no sibling task introduced a parallel event/log/session/storage contract.
- Journal/docs updates match actual behavior and do not imply memory, retrieval, providers, schedulers, model calls, or full runtime work.
- Final checks pass or skipped checks are explicitly justified.

## Required Checks

- Focused inspect command tests.
- Review-determined focused tests.
- Final integrated `pnpm check`.
- `pnpm exec tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`
- `git diff --check`
- HTML parse or equivalent sanity check for edited HTML docs.

## Handoff Expectations

Return a handoff with:

- findings first;
- inspect behavior summary;
- acceptance-criteria checklist;
- compatibility checklist;
- docs/journal changes made;
- commands run and results;
- unresolved questions or conflicts;
- confirmation of any files changed.
