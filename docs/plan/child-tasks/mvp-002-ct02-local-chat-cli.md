# MVP-002 CT-02 - Local Chat CLI

Parent active slice: [MVP-002 - Local Character Conversation Core](../active-slice.html)

Assigned subthread: `mvp-002-local-chat-cli`

## Goal

Wire a local multi-turn chat command to the MVP-002 conversation core so a user can talk
to the built-in character in a short terminal session.

## Current Scope

- Add a local chat command, expected as `pnpm chat`.
- Implement terminal input/output for a short session:
  - startup line naming the built-in character;
  - `You:` prompt;
  - character reply lines using the character display name;
  - a clear exit command such as `/exit`.
- Use the conversation core for validation, turn execution, transcript mutation, and reply generation.
- Map validation and unexpected core failures to clear terminal errors without pretending a character reply happened.
- Preserve the MVP-001 `pnpm relay` behavior unless the main thread accepts a documented compatibility change.
- Add CLI boundary tests for a short two-turn session and exit behavior.

## Explicit Non-Goals

- Do not implement the conversation core independently of CT-01.
- Do not duplicate validation or transcript mutation logic in the CLI layer.
- Do not add provider, webhook, browser, persistence, model, or network behavior.
- Do not change the active slice document except for coordinated journal or implementation notes requested by the main thread.

## Expected Files Or Areas

- `src/`
- `tests/`
- `package.json`
- Possibly `docs/develop-journal/2026-06-04/journal.html` for final implementation notes if coordinated by the main thread.

## Dependencies

- Depends on CT-01's exported conversation core contract.
- If CT-01 is not available yet, start by writing the intended CLI contract tests against the active slice and clearly mark them as pending integration work in the handoff.

## Coordination Notes

- Package script edits affect shared tooling and must preserve existing scripts.
- CLI tests should avoid brittle package-manager banner output when checking exact stdout; prefer direct Node execution for exact contracts and `pnpm --silent` only for package-script smoke checks.
- If the CLI needs different wording from the active slice examples, explain why in the handoff and keep product behavior stable.

## Acceptance Criteria

- A local command can complete at least two user-message turns with the built-in character.
- The second turn uses the same session and can see recent visible context through the core.
- The exit command ends the session cleanly.
- Invalid user input is reported without committing a partial turn.
- The existing `pnpm relay` smoke path still works.

## Required Checks

- Focused CLI boundary tests.
- Relevant core tests from CT-01 once integrated.
- `pnpm check`
- `pnpm exec tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`
- `git diff --check`

## Handoff Expectations

Return a handoff with:

- summary of CLI behavior and tests changed;
- exact files changed;
- checks run and results;
- accepted assumptions;
- any dependency on CT-01 not yet integrated;
- unresolved questions or conflicts.
