# MVP-007 CT-01 - Agent Capability Manifest And Contract Gate

Parent active slice: [MVP-007 - Universal Agent Capability Contract](../active-slice.html)

Sizing note: intended as one month-scale child thread and the shared contract gate for sibling tasks.

## Goal

Freeze the shared universal capability contract that all MVP-007 threads consume. This task defines the local shape for first-party modules, OpenClaw-style manifests, Hermes-style memory providers, TencentDB gateway adapters, and MCP-style tools/resources without implementing production integrations.

## Current Scope

- Define shared TypeScript contracts for `AgentCapabilityManifest`, `AgentCapability`, `RuntimeCapabilityContext`, lifecycle hooks, provided tools, context items, health, policy, configuration metadata, and evidence snapshots.
- Define the capability contract version and compatibility rules.
- Define capability kinds such as `first_party`, `memory_provider`, `tool_provider`, `context_provider`, and `bridge_adapter` if the repo needs these distinctions.
- Define manifest metadata: id, display name, version, kind, description, compatibility range, declared capabilities, config metadata, and local trust level.
- Define runtime context metadata: session id, turn id, event identity, trace id, timestamp, character identity, and privacy/redaction scope.
- Define model tool metadata that can represent the current built-in tools and future adapter-provided tools without replacing the existing built-in tool validators.
- Define context item metadata with compact text, source references, confidence/source kind if needed, token/budget hints, and redaction labels.
- Add parser/validator tests for valid and invalid manifests, duplicate declarations, unsupported contract versions, malformed tool definitions, and immutable snapshots.
- Export fixtures/helpers that CT-02 through CT-05 can reuse.

## Explicit Non-Goals

- No runtime hook wiring.
- No local-runtime behavior changes.
- No production TencentDB, Hermes, OpenClaw, MCP, or sidecar calls.
- No dynamic plugin loading, dynamic imports, package installation, sandbox, marketplace, or arbitrary code execution.
- No broad JSON Schema dependency unless this task proves the simple local contract cannot represent required fixtures.
- No memory retrieval implementation or native index.

## Likely Files

- `src/agent-capabilities.ts`
- `src/index.ts`
- `tests/agent-capabilities.test.ts`
- `tests/fixtures/agent-capabilities/`

## Dependencies

None. This task should land first or provide the stable export snapshot that all other tasks consume.

Before implementation, read:

- [MVP-007 OpenClaw Contract Research](../research/mvp-007-openclaw-contract-research.md)
- [MVP-007 Hermes/Tencent Memory Contract Research](../research/mvp-007-hermes-tencent-memory-contract-research.md)

## Acceptance Criteria

- The exported contract can represent the current built-in `visible_reply` and `character_state.patch` tools as first-party capabilities without duplicating their validators.
- The exported contract can represent memory-style recall/capture/search/session/health declarations.
- Manifest validation rejects duplicate ids, unsupported contract versions, unsupported capability kinds, missing required fields, and malformed tool/context declarations.
- Runtime context snapshots are immutable and do not expose mutable session, store, or runtime internals.
- Context item and source-reference shapes are compact enough for DecisionContext and inspect evidence.
- Tests cover valid first-party, OpenClaw-style, TencentDB-style, Hermes-style, MCP-style, and invalid fixture shapes.
- No `any`, broad casts, skipped TypeScript checks, or placeholder APIs.

## Required Checks

- `pnpm lint`
- `pnpm typecheck`
- Focused Vitest files touched by this task
- `pnpm test` before handoff if dependencies are installed

## Handoff Expectations

Summarize the final contract names, compatibility rules, validation failures, fixture coverage, exported helpers, and any decisions CT-02 through CT-05 must follow.
