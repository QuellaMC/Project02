# MVP-007 Research - Hermes And TencentDB Memory Contract

Research owner: Agent B / Hermes-Tencent memory-provider pass
Date captured: 2026-06-12
Purpose: reusable local source note for MVP-007 child threads

## Scope

This note captures Hermes-style memory-provider behavior as represented by TencentDB-Agent-Memory and its gateway. It is a research artifact for project02 MVP-007. It should inform the universal capability contract without committing the repo to a production TencentDB integration in this slice.

## Sources Examined

The research agent examined primary sources from `TencentCloud/TencentDB-Agent-Memory` on `main`.

- Repository README: https://github.com/TencentCloud/TencentDB-Agent-Memory
- Hermes provider README: https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/hermes-plugin/memory/memory_tencentdb/README.md
- Hermes provider implementation: https://raw.githubusercontent.com/TencentCloud/TencentDB-Agent-Memory/main/hermes-plugin/memory/memory_tencentdb/__init__.py
- Hermes client implementation: https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/hermes-plugin/memory/memory_tencentdb/client.py
- Hermes supervisor implementation: https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/hermes-plugin/memory/memory_tencentdb/supervisor.py
- Hermes plugin metadata: https://raw.githubusercontent.com/TencentCloud/TencentDB-Agent-Memory/main/hermes-plugin/memory/memory_tencentdb/plugin.yaml
- Gateway server/types/config directory: https://github.com/TencentCloud/TencentDB-Agent-Memory/tree/main/src/gateway
- Core facade: https://raw.githubusercontent.com/TencentCloud/TencentDB-Agent-Memory/main/src/core/tdai-core.ts
- Core types and standalone host adapter were also examined under the repository's `src/core` and `src/adapters/standalone` paths.

## Contract Shape

Hermes provider metadata observed:

- provider name: `memory_tencentdb`
- display name: `memory-tencentdb`
- version: `1.0.0`
- hooks: `on_memory_write`, `on_session_end`
- aliases: `tdai`, `memory-tencentdb`

Config fields that project02 should be able to represent:

- `gateway_cmd`
- `gateway_host`
- `gateway_port`
- `gateway_api_key` secret
- `llm_api_key` secret
- `llm_base_url`
- `llm_model`

Gateway-owned fields should stay gateway-side for MVP-007:

- data directory
- storage backend
- recall strategy and budgets
- extraction cadence
- embedding setup
- BM25/vector details
- CORS/auth management

## Lifecycle Behavior

Before prompt:

- Hermes `prefetch(query)` calls `POST /recall` synchronously.
- The result is returned as a memory context block for prompt injection.
- Project02 should map this to `beforeRoleModelCall` context contribution.

After committed turn:

- `sync_turn(user, assistant)` calls `POST /capture`.
- Capture runs on daemon background threads and is intentionally non-blocking.
- Project02 should map this to `afterTurnCommitted`, never to direct model-output handling.

Session end:

- `shutdown()` and `on_session_end` call `POST /session/end`.
- This should be treated as a scoped session flush, not as process teardown.

Initialization:

- The provider can optimistically register tools before the gateway is fully available.
- Gateway startup can run in the background.

## Tools And Search

The provider exposes two search tools:

- `memory_tencentdb_memory_search`
  - args: `query`, `limit`, optional `type`
  - `type` values: `persona`, `episodic`, `instruction`
  - gateway endpoint: `POST /search/memories`
- `memory_tencentdb_conversation_search`
  - args: `query`, `limit`
  - gateway endpoint: `POST /search/conversations`

Observed argument behavior:

- `limit` is defensively coerced.
- Boolean `limit` values are rejected.
- Numeric strings and floats are accepted.
- `limit` is clamped to `1..20`.
- Tool failures return JSON error strings to the model instead of throwing through the host.

## Gateway Endpoints

Relevant gateway endpoints:

- `GET /health`
  - returns `{ status, version, uptime, stores: { vectorStore, embeddingService } }`
- `POST /recall`
  - body `{ query, session_key, user_id? }`
  - returns `{ context, strategy?, memory_count? }`
- `POST /capture`
  - body `{ user_content, assistant_content, session_key, session_id?, user_id?, messages? }`
  - returns `{ l0_recorded, scheduler_notified }`
- `POST /search/memories`
  - body `{ query, limit?, type?, scene? }`
  - returns `{ results, total, strategy }`
- `POST /search/conversations`
  - body `{ query, limit?, session_key? }`
  - returns `{ results, total }`
- `POST /session/end`
  - body `{ session_key, user_id? }`
  - returns `{ flushed: true }`
- `POST /seed`
  - exists, but should remain future work for MVP-007 fixtures.

## Health And Failure Behavior

Project02 should map this provider as optional/degraded by default.

Observed reliability behavior:

- Circuit breaker: 5 consecutive gateway failures pause calls for 60 seconds.
- Capture back-pressure: up to 4 in-flight sync threads; a fifth waits up to 5 seconds for the oldest.
- Startup health waits up to 30 seconds.
- Watchdog probes every 10 seconds and can resurrect the sidecar.
- Gateway auth is optional: all routes except `GET /health` require Bearer auth only when `TDAI_GATEWAY_API_KEY` / `server.apiKey` is configured.

## Project02 Mapping Recommendations

- `manifest`
  - `id: memory_tencentdb`
  - `kind: memory-provider`
  - `trustLevel: static-first-party-or-fixture`
  - `compatibility.externalContract: hermes-memory-provider + tdai-gateway-http`
- `contextProviders.beforeRoleModelCall`
  - call or fixture `recall`
  - normalize `context` into bounded `ContextItem` values with source refs/evidence and recall metadata
- `lifecycleHooks.afterTurnCommitted`
  - call or fixture `capture`
  - run only after durable visible reply and raw-event commit
  - failure should log evidence and never roll back the committed turn
- `providedTools`
  - register the two search tools through existing allowed-tool validation
  - treat search results as tool outputs, not direct state mutations
- `lifecycleHooks.onSessionEnd`
  - scoped flush
  - do not conflate with provider shutdown or sidecar lifecycle
- `health`
  - represent `ok`, `degraded`, or `unavailable`
  - include store readiness, timeout/circuit-breaker state, and startup/recovery evidence
- `runtimePolicy`
  - optional before-model recall degradation
  - optional search-tool degradation
  - after-commit failure logged
  - secrets redacted
  - capture side effect labeled as local memory write

## Unknowns And Future Work

- Do not model `on_memory_write` beyond metadata yet; the provider marks it reserved/TODO.
- Do not include production sidecar supervision in MVP-007.
- Do not include seed import, Tencent VectorDB setup, embeddings, CORS/auth management, or actual memory indexing in MVP-007.
- Gateway search responses are formatted text rather than structured memory records; richer source refs may need a future extension if project02 requires inspectable per-memory provenance.
- A future production decision is needed on whether project02 owns process supervision or treats memory as an externally managed sidecar.
