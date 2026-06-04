# MVP-002 CT-01 - Conversation Core

Parent active slice: [MVP-002 - Local Character Conversation Core](../active-slice.html)

Assigned subthread: `mvp-002-conversation-core`

## Goal

Implement the central local character conversation core for MVP-002:
character profile, visible message records, in-memory session transcript, one-turn execution,
deterministic local character agent seam, validation, and atomic transcript commit behavior.

## Current Scope

- Define one built-in local character profile with stable ID and display name.
- Define visible message records for user and character messages.
- Define an in-memory conversation session for the built-in character.
- Implement a character turn runner that:
  - validates one user message using the existing one-line message boundary rules where practical;
  - passes recent visible transcript context to a local character agent;
  - validates one visible character reply;
  - appends exactly one user message and one character reply on success;
  - leaves the transcript unchanged on invalid user input or invalid agent reply.
- Implement a deterministic local character agent suitable for unit tests and manual local use.
- Export the core through the public package entry point if that matches existing patterns.

## Explicit Non-Goals

- Do not wire terminal input loops or interactive prompting in this task.
- Do not replace, remove, or break the MVP-001 `relay` command.
- Do not add persistence, external services, model providers, credentials, or network calls.
- Do not recreate old runtime modules from `legacy/typescript`.

## Expected Files Or Areas

- `src/`
- `tests/`
- `src/index.ts`
- Possibly `src/relay.ts` only if reuse of validation helpers requires a small shared extraction.

## Coordination Notes

- This task owns the shared core contract. Downstream CLI work should use the exported core rather than duplicate validation or transcript logic.
- If validation helpers must move out of `src/relay.ts`, keep the change small and preserve all existing relay tests.
- Coordinate any changes to package scripts or CLI entry points with CT-02.

## Acceptance Criteria

- Unit tests prove a new session has the built-in character profile and an empty visible transcript.
- Unit tests prove a successful turn appends the normalized user message and character reply in order.
- Unit tests prove the local character agent receives recent visible transcript context.
- Unit tests prove invalid input does not call the agent and leaves the transcript unchanged.
- Unit tests prove invalid agent replies leave the transcript unchanged.
- Existing MVP-001 relay tests continue to pass.

## Required Checks

- Focused tests for the conversation core.
- `pnpm check`
- `pnpm exec tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`
- `git diff --check`

## Handoff Expectations

Return a handoff with:

- summary of code and tests changed;
- exact files changed;
- checks run and results;
- exported core contract;
- accepted assumptions;
- unresolved questions or conflicts;
- any changes that CT-02 must account for.
