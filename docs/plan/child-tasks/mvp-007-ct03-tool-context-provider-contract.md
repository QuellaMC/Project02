# MVP-007 CT-03 - Capability Tool And Context Provider Contract

Parent active slice: [MVP-007 - Universal Agent Capability Contract](../active-slice.html)

Sizing note: intended as one month-scale child thread after CT-01 exports are stable.

## Goal

Make capability-provided context and tools usable by the role-model path without bypassing existing runtime validation. This task turns the contract from metadata into model-facing input and routed tool-call behavior.

## Current Scope

- Extend the role-model input envelope or DecisionContext with bounded capability-contributed context items from CT-01.
- Preserve the existing `livingStateBrief`, recent visible messages, and runtime notes behavior.
- Add capability-provided tool definitions to the allowed-tool render path only when the capability host policy allows them.
- Route capability tool calls through host-owned validation and `handleToolCall` rather than direct model mutation.
- Add or reserve a read-only current-turn capability discovery tool, such as `capability.list`, that returns only safe summaries of currently available capabilities and tools.
- Keep built-in `visible_reply` required for user turns and keep `character_state.patch` validation owned by Character State.
- Define how capability tool results appear to commit validation and evidence without creating a second role-model loop.
- Add tests for context budget enforcement, source refs, disallowed tools, malformed capability tool calls, handler rejection, and accepted fake tool output.
- Prove a fake memory search tool and a fake context-only recall provider can both use the same contract.

## Explicit Non-Goals

- No production memory retrieval or indexing.
- No live TencentDB gateway calls.
- No external side-effect tools such as files, calendars, documents, accounts, outgoing messages, money, or browser actions.
- No permission prompt UI.
- No model-facing plugin management tools for install, uninstall, enable, disable, config mutation, package update, or secrets inspection.
- No broad replacement of `src/model-tools.ts`; reuse or adapt existing tool-validation seams.
- No streaming model/provider changes.

## Likely Files

- `src/role-model-contracts.ts`
- `src/role-model-loop.ts`
- `src/role-model-prompt.ts`
- `src/model-tools.ts`
- `src/agent-capability-host.ts`
- `src/local-runtime.ts`
- `tests/role-model-contracts.test.ts`
- `tests/role-model-loop.test.ts`
- `tests/local-runtime.test.ts`

## Dependencies

Depends on CT-01 contracts. Integrates with CT-02 host wiring when available, but pure role-model/contract tests can start with fake host objects.

Before implementation, read:

- [MVP-007 OpenClaw Contract Research](../research/mvp-007-openclaw-contract-research.md)
- [MVP-007 Hermes/Tencent Memory Contract Research](../research/mvp-007-hermes-tencent-memory-contract-research.md)

## Acceptance Criteria

- Capability context items appear in the model input as compact, immutable context with source refs and budget metadata.
- Existing recent-message and `livingStateBrief` fields still appear exactly as MVP-006 expects.
- Capability-provided tools are visible only when declared, allowed, and enabled by host policy.
- Capability discovery returns only enabled/current-turn-safe summaries and redacts secrets, private config, disabled capability internals, and host filesystem details.
- Model decisions requesting disallowed, unknown, duplicate, malformed, or unsupported capability tools reject before commit.
- Accepted fake capability tool calls route through `handleToolCall` and produce structured evidence.
- Rejected fake capability tool calls do not fabricate visible conversation messages or mutate state.
- Built-in tool validation remains shared; no duplicate `visible_reply` or `character_state.patch` validator stack is introduced.

## Required Checks

- `pnpm lint`
- `pnpm typecheck`
- Focused Vitest files touched by this task
- `pnpm test` before handoff if dependencies are installed

## Handoff Expectations

Summarize the final model-facing context shape, capability tool routing rules, validation behavior, fixture coverage, files changed, checks run, and any policy/evidence assumptions CT-04 must inspect.
