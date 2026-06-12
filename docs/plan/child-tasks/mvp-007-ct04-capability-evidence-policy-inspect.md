# MVP-007 CT-04 - Capability Evidence, Policy, And Inspect

Parent active slice: [MVP-007 - Universal Agent Capability Contract](../active-slice.html)

Sizing note: intended as one month-scale child thread after CT-01 snapshot shapes are stable.

## Goal

Make capability behavior auditable. This task defines durable evidence, policy outcomes, redaction, and inspect output for capability registration, contributions, invocations, hook results, health, and failures.

## Current Scope

- Define evidence snapshots for capability registration/selection, before-model contributions, tool invocation results, hook failures, timeouts, health checks, session-end hooks, config fingerprints, and redactions.
- Add policy outcome types for optional degradation, required rejection, disallowed tool, timeout, handler rejection, after-commit failure, and health degradation.
- Store capability evidence through existing raw-event/log paths rather than creating a parallel log store.
- Add inspect rendering for capability manifests, installed/registered/enabled/available-for-turn status, context contribution summaries, provided tools, tool invocations, hook outcomes, health status, source references, and redacted config fingerprints.
- Ensure evidence is read-only and inspect does not re-run capability hooks or repair stored state.
- Add redaction tests so secrets, bearer tokens, API keys, endpoint credentials, and private config values are not exposed in raw provider/capability evidence.
- Add HTML/doc parse coverage if planning docs are changed during integration.

## Explicit Non-Goals

- No new replay UI.
- No live provider diagnostics.
- No secret store or credential manager.
- No full permission matrix UI.
- No inspect or model-facing command that installs, uninstalls, enables, disables, updates, or mutates capability configuration.
- No separate database or logging root.
- No mutation from inspect.

## Likely Files

- `src/runtime-log.ts`
- `src/local-storage.ts`
- `src/inspect-cli.ts`
- `src/agent-capabilities.ts`
- `src/agent-capability-host.ts`
- `tests/local-storage.test.ts`
- `tests/inspect-cli.contract.test.ts`
- `tests/file-runtime-log-store.test.ts`
- `tests/agent-capability-host.test.ts`

## Dependencies

Depends on CT-01 snapshot types. Can begin with fake evidence factories, then wire to CT-02 hook execution and CT-03 tool/context routing.

Before implementation, read:

- [MVP-007 OpenClaw Contract Research](../research/mvp-007-openclaw-contract-research.md)
- [MVP-007 Hermes/Tencent Memory Contract Research](../research/mvp-007-hermes-tencent-memory-contract-research.md)

## Acceptance Criteria

- Capability evidence is attached to existing turn/raw-event records or existing inspectable stores.
- Inspect shows capability evidence and capability listing state for a stored turn without re-running model calls, capability hooks, side effects, or state writes.
- Required failures, optional degradation, disallowed tool calls, handler rejections, timeouts, health degradation, and after-commit failures each have distinct evidence.
- Redaction removes secrets and private config values from raw evidence and inspect output while preserving useful diagnostics.
- Source refs for context items survive durable storage and inspect decoding.
- Existing MVP-006 role-model, provider, tool-call, state-patch, trace, and inspect outputs remain compatible.

## Required Checks

- `pnpm lint`
- `pnpm typecheck`
- Focused Vitest files touched by this task
- `pnpm test` before handoff if dependencies are installed
- HTML parse for changed `docs/**/*.html`
- `git diff --check`

## Handoff Expectations

Summarize evidence kinds, policy outcomes, redaction behavior, inspect fields, files changed, checks run, and any unresolved compatibility risk with existing durable logs.
