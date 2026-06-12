# MVP-007 CT-05 - Adapter Compatibility Proofs

Parent active slice: [MVP-007 - Universal Agent Capability Contract](../active-slice.html)

Sizing note: intended as one month-scale child thread after CT-01 exports are stable.

## Goal

Prove the universal contract can represent the common agent-project contracts the user asked about. This task uses fixtures and fake adapters for OpenClaw-style manifests, Hermes-style memory providers, TencentDB-Agent-Memory gateway endpoints, MCP-style tools/resources, and current first-party built-ins.

## Current Scope

- Add fixture data for an OpenClaw-style plugin manifest, including id, version, kind, activation, tools/contracts, config metadata, compatibility metadata, and UI/command hints where relevant.
- Add fixture data for TencentDB-Agent-Memory gateway behavior: recall before turn, capture after committed turn, memory search, conversation search, session end, and health.
- Add fixture data for Hermes-style memory-provider behavior: prefetch/recall before prompt, sync/capture after turn, search tools, session end, health, circuit-breaker/back-pressure metadata.
- Add fixture data for MCP-style tools and resources sufficient to prove mapping into local provided tools/context resources.
- Add adapter mappers that normalize each fixture family into CT-01 `AgentCapability` shapes without making those foreign contracts the runtime's internal source of truth.
- Add fake host integration tests showing each adapter can register, contribute context or tools, report health, and emit evidence through the MVP-007 host.
- Document any mismatch where the external system needs a future extension rather than forcing it into the MVP-007 contract.

## Testing Strategy

Use two kinds of test artifact:

- Fake executable capabilities that implement project02's local `AgentCapability` contract and run in-process under Vitest.
- Real-shape fixtures copied or minimized from upstream contracts, such as OpenClaw manifest data, Hermes/Tencent gateway payloads, and MCP tool/resource declarations.

Do not execute real OpenClaw plugin packages, Hermes provider code, TencentDB sidecars, MCP servers, databases, embedding pipelines, or network calls in MVP-007 automated tests.

## Explicit Non-Goals

- No live network calls.
- No installation of OpenClaw, Hermes, TencentDB-Agent-Memory, MCP servers, SQLite, sqlite-vec, or embedding dependencies.
- No real TencentDB sidecar lifecycle management.
- No production adapter configuration or secrets.
- No broad compatibility claim beyond the fixtures represented in this task.
- No changes to external repositories.

## Likely Files

- `src/agent-capability-adapters/`
- `tests/fixtures/agent-capabilities/openclaw-memory-plugin.json`
- `tests/fixtures/agent-capabilities/tencentdb-memory-gateway.json`
- `tests/fixtures/agent-capabilities/hermes-memory-provider.json`
- `tests/fixtures/agent-capabilities/mcp-tools-resources.json`
- `tests/agent-capability-adapters.test.ts`
- `docs/plan/active-slice.html`

## Dependencies

Depends on CT-01 contracts. It can use fake host calls until CT-02 through CT-04 finalize runtime wiring and evidence shapes.

Before implementation, read:

- [MVP-007 OpenClaw Contract Research](../research/mvp-007-openclaw-contract-research.md)
- [MVP-007 Hermes/Tencent Memory Contract Research](../research/mvp-007-hermes-tencent-memory-contract-research.md)

## Acceptance Criteria

- OpenClaw-style manifest metadata maps into local manifest/config/tool declarations.
- TencentDB gateway fixture maps into local memory recall, capture, search, session-end, and health hooks.
- Hermes memory-provider fixture maps into local prefetch/recall, sync/capture, search, session-end, health, and degradation metadata.
- MCP-style tools/resources fixture maps into local provided tools and context/resource declarations.
- Current first-party built-in tools map into the same local capability contract without losing their existing validation semantics.
- Adapter tests identify unsupported external fields as ignored-with-evidence or future-extension notes, not silent behavior.
- No adapter test requires external services, package installs, databases, or network access.
- Fake executable capabilities prove lifecycle, tool, context, health, failure, and evidence behavior through the project02 host; real-shape fixtures prove compatibility mapping only.

## Required Checks

- `pnpm lint`
- `pnpm typecheck`
- Focused Vitest files touched by this task
- `pnpm test` before handoff if dependencies are installed
- `git diff --check`

## Handoff Expectations

Summarize each external contract mapping, unsupported fields, fixture coverage, files changed, checks run, and whether the next production slice should target TencentDB-Agent-Memory, a read-only context provider, or another adapter first.
