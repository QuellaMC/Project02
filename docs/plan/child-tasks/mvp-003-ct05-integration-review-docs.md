# MVP-003 CT-05 - Integration Review, Tests, And Docs

Parent active slice: [MVP-003 - Runtime Event Trace For Local Chat](../active-slice.html)

Assigned subthread: `mvp-003-integration-review-docs`

## Goal

Provide cross-thread integration review for MVP-003, verify the final behavior against the active
slice, and keep durable docs/journal updates aligned with the implementation.

## Current Scope

- Review the active slice and all MVP-003 child task handoffs.
- Check whether CT-01 through CT-04 preserve the intended boundaries.
- Verify that event/log contracts are shared instead of cloned.
- Verify that the runtime adapter reuses the conversation core.
- Verify that default chat and relay compatibility are preserved.
- Expand or adjust tests only when integration evidence shows a missing acceptance criterion.
- Update the development journal and any required durable docs after implementation details are known.
- Prepare a final PR-readiness checklist for the main thread.

## Explicit Non-Goals

- Do not create a competing active slice.
- Do not widen MVP-003 into persistence, provider support, memory, replay, model calls, or full runtime architecture.
- Do not rewrite sibling implementations unless review evidence shows a concrete actionable problem.
- Do not add broad docs pages that the current slice does not need.

## Expected Files Or Areas

- `docs/plan/active-slice.html`
- `docs/plan/child-tasks/`
- `docs/develop-journal/2026-06-04/journal.html`
- `src/`
- `tests/`

## Dependencies

- Can begin read-only against this draft.
- Final implementation review depends on CT-01 through CT-04 handoffs.

## Coordination Notes

- Findings should lead the handoff, ordered by severity or integration risk.
- Keep docs updates factual and current-work scoped.
- If implementation reveals a product decision not settled by the active slice, escalate it to the main thread before changing scope.

## Acceptance Criteria

- Handoff lists any concrete implementation, test, docs, or compatibility findings.
- Handoff confirms whether the final code satisfies each active-slice acceptance criterion.
- Handoff includes a focused test checklist and commands run.
- Handoff confirms no sibling task introduced a parallel event/log/runtime contract.
- Journal/docs updates match actual behavior and do not imply persistence, providers, memory, or full runtime work.

## Required Checks

- Review-determined focused tests.
- Final integrated `pnpm check`.
- `pnpm exec tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`
- `git diff --check`
- HTML parse or equivalent sanity check for edited HTML docs.

## Handoff Expectations

Return a handoff with:

- findings first;
- acceptance-criteria checklist;
- compatibility checklist;
- docs/journal changes made;
- commands run and results;
- unresolved questions or conflicts;
- confirmation of any files changed.
