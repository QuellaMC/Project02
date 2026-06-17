# MVP-007 CT-02 - Runtime Lifecycle Hook Host

Parent active slice: [MVP-007 - Universal Agent Capability Contract](../active-slice.html)

Sizing note: intended as one month-scale child thread after CT-01 exports are stable.

## Goal

Wire the static capability host into the existing user-message runtime path. The host should run lifecycle hooks at the right boundaries while preserving MVP-006 default chat behavior when no extra capability is enabled.

## Current Scope

- Add a static in-process `RuntimeCapabilityHost` or equivalent registry/runner using the CT-01 contracts.
- Register trusted first-party built-ins and test fakes through the host.
- Add a `beforeRoleModelCall` phase before the role-model input envelope is finalized.
- Add an `afterTurnCommitted` phase that runs only after accepted visible conversation and raw-event commit evidence exists.
- Add `onSessionEnd` and `health` host calls where local CLI/session code can invoke them safely.
- Define required vs optional capability failure behavior at hook boundaries.
- Ensure rejected input, malformed model output, invalid visible reply, invalid state patch, and commit validation rejection do not trigger after-commit capture.
- Preserve existing runtime rollback behavior for state and visible conversation.
- Add focused integration tests around hook ordering, failure policy, and default no-op behavior.

## Explicit Non-Goals

- No adapter-specific TencentDB, Hermes, OpenClaw, or MCP production implementation.
- No capability-provided tool handling beyond the hook plumbing needed by CT-03.
- No inspect rendering beyond evidence emitted for CT-04 to consume.
- No background queue, async worker process, scheduler, or sidecar supervisor.
- No dynamic plugin loading or arbitrary code execution.

## Likely Files

- `src/agent-capability-host.ts`
- `src/local-runtime.ts`
- `src/chat-cli.ts`
- `src/inspect-cli.ts`
- `src/index.ts`
- `tests/local-runtime.test.ts`
- `tests/chat-cli.contract.test.ts`
- `tests/agent-capability-host.test.ts`

## Dependencies

Depends on CT-01 contracts. It can use fake adapters while CT-03 through CT-05 continue independently.

Before implementation, read:

- [MVP-007 OpenClaw Contract Research](../research/mvp-007-openclaw-contract-research.md)
- [MVP-007 Hermes/Tencent Memory Contract Research](../research/mvp-007-hermes-tencent-memory-contract-research.md)

## Acceptance Criteria

- With no additional capabilities enabled, local chat, trace, inspect, provider selection, built-in tools, and character-state patch behavior remain compatible with MVP-006 tests.
- A fake optional `beforeRoleModelCall` capability failure degrades with evidence and does not block a visible reply.
- A fake required `beforeRoleModelCall` capability failure rejects the turn before visible conversation commit.
- A fake `afterTurnCommitted` hook observes accepted turn evidence after durable commit and never runs for rejected turns.
- A fake after-commit failure keeps the accepted turn committed and emits failure evidence.
- `onSessionEnd` and `health` can be invoked without appending visible conversation records.
- Hook execution does not expose mutable runtime/session/store objects to adapters.

## Required Checks

- `pnpm lint`
- `pnpm typecheck`
- Focused Vitest files touched by this task
- `pnpm test` before handoff if dependencies are installed

## Handoff Expectations

Summarize hook order, failure policy, rollback interactions, default compatibility behavior, files changed, checks run, and any integration points CT-03 and CT-04 must consume.
