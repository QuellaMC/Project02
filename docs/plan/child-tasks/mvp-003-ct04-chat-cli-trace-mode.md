# MVP-003 CT-04 - Chat CLI Trace Mode

Parent active slice: [MVP-003 - Runtime Event Trace For Local Chat](../active-slice.html)

Assigned subthread: `mvp-003-chat-cli-trace-mode`

## Goal

Route local chat through the MVP-003 runtime adapter and add optional diagnostic trace output while
preserving default chat behavior.

## Current Scope

- Update `pnpm chat` / `node src/chat-cli.ts` so each user input is handled through the local runtime adapter.
- Preserve the default MVP-002 user-facing chat output unless a documented compatibility issue is accepted by the main thread.
- Add a trace mode, proposed as `pnpm chat -- --trace`.
- In trace mode, emit one JSON Line per processed user input to `stderr`.
- Keep normal chat transcript and prompts on `stdout`.
- Continue to handle `/exit` without creating a runtime event.
- Map validation and unexpected runtime failures to clear terminal errors without pretending a character reply happened.

## Explicit Non-Goals

- Do not implement the runtime adapter independently of CT-03.
- Do not duplicate validation, transcript mutation, or log-store behavior in the CLI layer.
- Do not add provider, webhook, browser, persistence, model, or network behavior.
- Do not change the relay command.

## Expected Files Or Areas

- `src/chat-cli.ts`
- `tests/chat-cli.contract.test.ts`
- `package.json` only if script arguments require a narrow change.

## Dependencies

- Depends on CT-03's runtime adapter result contract.
- If CT-03 is not available yet, start with CLI contract tests or a narrow stub and clearly mark integration assumptions in the handoff.

## Coordination Notes

- CLI tests should avoid brittle package-manager banner output when checking exact stdout; prefer direct Node execution for exact contracts and `pnpm --silent` for package-script smoke checks.
- Trace summaries should go to `stderr` so `stdout` remains suitable for normal chat assertions.
- JSONL fields should be stable and small: event ID, trace ID, status, and ordered trace step names.

## Acceptance Criteria

- Default chat CLI tests still pass for a two-turn session, first-input `/exit`, invalid input handling, and relay compatibility.
- Trace mode emits parseable JSONL to `stderr` for successful and rejected user inputs.
- Trace mode does not change normal chat `stdout`.
- `/exit` exits cleanly and does not emit a trace summary.

## Required Checks

- Focused CLI boundary tests.
- Relevant runtime adapter tests once integrated.
- `pnpm check`
- `pnpm exec tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`
- `git diff --check`

## Handoff Expectations

Return a handoff with:

- summary of CLI behavior and trace mode format;
- exact files changed;
- checks run and results;
- accepted assumptions;
- unresolved questions or conflicts;
- any compatibility change from MVP-002, if one was unavoidable.
