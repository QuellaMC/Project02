# MVP-005 CT-04 - Commit And Effects Validation

Parent active slice: [MVP-005 - Structured Role-Model User Turn Foundation](../active-slice.html)

Assigned subthread: `mvp-005-commit-effects-validation`

## Goal

Implement the MVP-005 commit/effects boundary for local user turns so accepted structured decisions
commit visible replies through the existing runtime path and rejected decisions persist audit
evidence without fabricating visible conversation messages.

## Current Scope

- Validate CT-03 parsed `CharacterDecision` results.
- Accept only the MVP-005-supported `visible_reply` effect.
- Reuse existing one-line visible reply validation rules.
- Commit accepted visible replies through existing conversation/runtime log behavior without re-running the Role Model Loop or deterministic reply adapter.
- Persist model input/output, parsed decision, validation result, accepted commit, and rejection evidence through the existing MVP-004 durable local runtime truth layer.
- Ensure rejected decisions preserve event ID and trace ID, append rejection evidence, and leave visible conversation records unchanged for the failed turn.
- Preserve current accepted reply text and resumed-session deterministic behavior.

## Explicit Non-Goals

- Do not implement real tools, external side effects, scheduled directives, incident commits, state patches, Live2D updates, proactive messages, or provider sends.
- Do not create a second storage root, second session catalog, or private model log directory.
- Do not repair corrupt stores or replay model calls.
- Do not change relay behavior.
- Do not add broad runtime-kernel orchestration beyond the local `USER_MESSAGE` path.

## Expected Files Or Areas

- Existing `src/local-runtime.ts`.
- Existing `src/runtime-log.ts`.
- Existing `src/local-storage.ts` and `src/file-runtime-log-store.ts` if durable codecs/log records need focused extension.
- Existing `src/conversation.ts` for visible message validation, message ID allocation, transcript behavior, and any narrow commit helper extracted from the current turn path.
- Focused tests, likely `tests/local-runtime.test.ts`, `tests/runtime-log.test.ts`, `tests/file-runtime-log-store.test.ts`, and a new commit/effects test if useful.

## Dependencies

- Depends on CT-01 decision contracts.
- Depends on CT-03 Role Model Loop result shape.
- Should consume CT-02 context evidence through CT-03 or coordinator integration.

## Coordination Notes

- The model proposes; this task decides what can be committed for MVP-005.
- If storage codecs need new record kinds, extend the shared runtime log/local storage contract once and make inspect consume that same shape. Do not add a separate model log file or `ModelIOSnapshotStore` in this slice.
- Do not duplicate conversation validation, message ID allocation, or transcript mutation. Use or expose the narrow existing conversation seam when possible.
- Keep accepted and rejected evidence readable by CT-05 inspect without inventing an inspect-only parser.

## Acceptance Criteria

- Tests prove accepted `visible_reply` decisions append the expected user and character visible messages plus role-model evidence.
- Tests prove empty, multiline, malformed, and unsupported decisions append rejection evidence and no visible conversation messages.
- Tests prove rejected decisions are durable and can be read after process restart.
- Tests prove resumed durable chat still produces the MVP-004 deterministic second-turn reply.
- Existing MVP-001 through MVP-004 tests continue to pass.

## Required Checks

- Focused commit/runtime/log/storage tests.
- `pnpm check`
- `pnpm exec tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`
- `git diff --check`

## Handoff Expectations

Return a handoff with:

- accepted and rejected commit behavior;
- durable evidence record names and shapes;
- exact files changed;
- checks run and results;
- accepted assumptions;
- unresolved questions or conflicts;
- integration instructions CT-05 must follow.
