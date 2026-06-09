# MVP-004 CT-04 - Chat CLI Persistence UX

Parent active slice: [MVP-004 - Durable Local Runtime Continuity](../active-slice.html)

Assigned subthread: `mvp-004-chat-cli-persistence-ux`

## Goal

Wire durable local sessions into the chat CLI so users can create, resume, and select local sessions
without losing the existing default chat behavior or MVP-003 trace mode.

## Current Scope

- Add `--store <path>` for explicit local store root override.
- Add `--session <session-id>` for selecting or resuming a session.
- Add `--new-session <session-id>` for creating a selected session and failing clearly if it already exists.
- Keep `pnpm chat` on the default dev-local store and default local session, creating the session if missing.
- Preserve default chat prompts, replies, `/exit`, validation errors, and trace mode JSONL behavior.
- Route each non-exit input through the existing local runtime adapter using a durable log store.
- Use CT-03 session rehydration so resumed sessions restore recent visible context.
- Produce clear terminal errors for missing sessions, corrupt stores, unsupported versions, and write failures.
- Keep exact stdout/stderr contracts testable with direct Node execution.

## Explicit Non-Goals

- Do not implement the storage contract, durable log store, or rehydration logic independently of CT-01 through CT-03.
- Do not duplicate validation, transcript mutation, runtime adapter behavior, or log-store record shaping in the CLI layer.
- Do not add provider, webhook, browser, model, memory, retrieval, scheduler, account, or network behavior.
- Do not change the relay command.

## Expected Files Or Areas

- `src/chat-cli.ts`
- `tests/chat-cli.contract.test.ts`
- `package.json` only if a narrow chat-specific script adjustment is needed; CT-05 owns
  the `pnpm inspect` script.

## Dependencies

- Depends on CT-01 storage contract.
- Depends on CT-02 durable log store.
- Depends on CT-03 session catalog and rehydration.
- If dependencies are not merged yet, start with CLI contract tests or a narrow adapter interface and clearly mark integration assumptions in the handoff. Do not implement private storage, session, or rehydration helpers in the CLI layer.

## Coordination Notes

- CLI tests should avoid brittle package-manager wrapper output when checking exact stdout/stderr. Prefer direct Node execution for exact contracts and `pnpm --silent` for package-script smoke checks.
- Trace summaries should continue to go to `stderr` so normal chat `stdout` remains stable.
- `/exit` remains a CLI command, not a runtime event.
- Default behavior should remain easy for a new user, even if advanced session flags exist.
- Session IDs must be passed through CT-01 validation before they affect file paths.

## Acceptance Criteria

- Default chat CLI tests still pass for two-turn session, first-input `/exit`, invalid input handling, trace mode, and relay compatibility.
- Tests prove `--store`, `--session`, and `--new-session` behavior with exact stdout/stderr contracts.
- Tests prove a session can be created, exited, resumed in a new process, and continue with prior visible context.
- Tests prove two selected sessions keep separate visible transcripts.
- Tests prove corrupt or unsupported stores produce clear terminal errors and non-zero exit behavior where appropriate.
- Trace mode still emits one parseable JSON Line per processed input without changing normal chat `stdout`.

## Required Checks

- Focused CLI boundary tests.
- Relevant session, durable log, local runtime, and relay tests once integrated.
- `pnpm check`
- `pnpm exec tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`
- `git diff --check`

## Handoff Expectations

Return a handoff with:

- summary of CLI behavior, flags, and default compatibility;
- exact files changed;
- checks run and results;
- accepted assumptions;
- unresolved questions or conflicts;
- any compatibility change from MVP-002 or MVP-003, if one was unavoidable.
