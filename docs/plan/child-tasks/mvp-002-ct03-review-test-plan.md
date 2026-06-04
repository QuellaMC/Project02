# MVP-002 CT-03 - Contract Review And Test Plan

Parent active slice: [MVP-002 - Local Character Conversation Core](../active-slice.html)

Assigned subthread: `mvp-002-review-test-plan`

## Goal

Provide an independent read-only review of the MVP-002 active slice and current MVP-001 code,
then produce a concrete test and integration checklist for the main thread and implementation subthreads.

## Current Scope

- Review `docs/plan/active-slice.html`.
- Review `src/relay.ts`, `src/relay-cli.ts`, `tests/relay.test.ts`, and `tests/relay-cli.test.ts`.
- Identify the exact behavior that must remain compatible from MVP-001.
- Identify the minimum test matrix for MVP-002 conversation core and chat CLI.
- Identify likely integration conflicts between CT-01 and CT-02.
- Recommend any small contract clarifications needed before implementation.

## Explicit Non-Goals

- Do not edit files unless the main thread explicitly asks for a follow-up patch.
- Do not implement code.
- Do not create a competing active slice or redefine MVP-002 scope.
- Do not pull old runtime architecture forward from `legacy/typescript`.

## Expected Files Or Areas To Inspect

- `docs/plan/active-slice.html`
- `AGENTS.md`
- `AGENTS.repo.md`
- `docs/wiki/parallel-agent-development-protocol.md`
- `src/relay.ts`
- `src/relay-cli.ts`
- `tests/relay.test.ts`
- `tests/relay-cli.test.ts`
- `package.json`

## Dependencies

- None. This task can run immediately.

## Acceptance Criteria

- Handoff lists MVP-001 compatibility constraints that must be preserved.
- Handoff lists MVP-002 test cases grouped by core, CLI, compatibility, and failure behavior.
- Handoff identifies any ambiguity or risk in the active slice.
- Handoff calls out likely shared-file or contract conflicts between CT-01 and CT-02.
- Handoff is evidence-based and cites local files or active-slice sections.

## Required Checks

- Read-only task. No test run is required unless the subthread chooses to run the current baseline for evidence.
- If any command is run, report it and its result.

## Handoff Expectations

Return a handoff with:

- findings first, ordered by severity or integration risk;
- concrete test checklist;
- MVP-001 compatibility checklist;
- suggested clarifications, if any;
- commands run, if any;
- confirmation that no files changed.
