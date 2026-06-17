# MVP-007 Research - OpenClaw Contract

Research owner: Agent A / OpenClaw contract pass
Date captured: 2026-06-12
Purpose: reusable local source note for MVP-007 child threads

## Scope

This note captures the OpenClaw contract behavior that should inform `AgentCapability` design in MVP-007. It is a research artifact, not an implementation spec. Project02 should normalize these contracts into its own runtime-owned capability boundary instead of copying OpenClaw internals directly.

## Sources Examined

Upstream snapshot examined by the research agent: `openclaw/openclaw` commit `81c553e2fbec23d9e9e4f232b86ee6b86f8f5d53`.

- `extensions/memory-core/openclaw.plugin.json`: https://github.com/openclaw/openclaw/blob/81c553e2fbec23d9e9e4f232b86ee6b86f8f5d53/extensions/memory-core/openclaw.plugin.json
- `extensions/memory-core/package.json`: https://github.com/openclaw/openclaw/blob/81c553e2fbec23d9e9e4f232b86ee6b86f8f5d53/extensions/memory-core/package.json
- `extensions/memory-core/index.ts`: https://github.com/openclaw/openclaw/blob/81c553e2fbec23d9e9e4f232b86ee6b86f8f5d53/extensions/memory-core/index.ts#L177-L230
- `packages/plugin-package-contract/src/index.ts`: https://github.com/openclaw/openclaw/blob/81c553e2fbec23d9e9e4f232b86ee6b86f8f5d53/packages/plugin-package-contract/src/index.ts#L1-L113
- `src/plugins/manifest.ts`: https://github.com/openclaw/openclaw/blob/81c553e2fbec23d9e9e4f232b86ee6b86f8f5d53/src/plugins/manifest.ts#L317-L451
- `src/plugins/types.ts`: https://github.com/openclaw/openclaw/blob/81c553e2fbec23d9e9e4f232b86ee6b86f8f5d53/src/plugins/types.ts#L2600-L2920
- `src/plugins/registry.ts`: https://github.com/openclaw/openclaw/blob/81c553e2fbec23d9e9e4f232b86ee6b86f8f5d53/src/plugins/registry.ts#L602-L656
- `src/plugins/hook-types.ts`: https://github.com/openclaw/openclaw/blob/81c553e2fbec23d9e9e4f232b86ee6b86f8f5d53/src/plugins/hook-types.ts#L74-L119
- `src/plugins/memory-state.ts`: https://github.com/openclaw/openclaw/blob/81c553e2fbec23d9e9e4f232b86ee6b86f8f5d53/src/plugins/memory-state.ts#L130-L185
- `docs/plugins/building-plugins.md`: https://github.com/openclaw/openclaw/blob/81c553e2fbec23d9e9e4f232b86ee6b86f8f5d53/docs/plugins/building-plugins.md#L61-L117
- `docs/tools/plugin.md`: https://github.com/openclaw/openclaw/blob/81c553e2fbec23d9e9e4f232b86ee6b86f8f5d53/docs/tools/plugin.md#L161-L199
- `SECURITY.md`: https://github.com/openclaw/openclaw/blob/81c553e2fbec23d9e9e4f232b86ee6b86f8f5d53/SECURITY.md#L147-L153

## Common Contract Fields

OpenClaw separates static manifest metadata from runtime registration.

Common manifest fields observed:

- `id`
- `name`
- `description`
- `version`
- `kind`
- `configSchema`
- `uiHints`
- `activation`
- `contracts`
- `toolMetadata`
- `requiresPlugins`
- enablement defaults
- provider, channel, and model metadata
- setup metadata
- config/channel contracts

Package metadata is separate under `package.json#openclaw`, especially:

- `extensions`
- `compat`
- `install`
- build metadata

The bundled `memory-core` manifest is the most relevant minimal example. It declares `id`, `kind: "memory"`, `activation.onStartup: false`, `contracts.tools: ["memory_get", "memory_search"]`, command aliases, UI hints, and a JSON-schema-like config schema.

## Lifecycle And Activation

`activation` is planner metadata, not executable behavior by itself. OpenClaw supports activation hints such as startup, providers, commands, channels, routes, config paths, and broad capability categories.

Actual behavior comes from the plugin entry's `register(api)` function. Runtime hooks are richer than static activation metadata:

- model/prompt hooks
- tool hooks
- session hooks
- gateway start/stop hooks
- cleanup lifecycle registration

Memory is special-cased as an exclusive slot-style capability. `memory-core` registers `registerMemoryCapability(...)` plus memory tools and commands.

## Tool Declaration Behavior

Tool names are declared cold in `contracts.tools`.

Runtime registration through `api.registerTool(...)` must match declared names. Undeclared tools produce diagnostics and are skipped. Tool factories receive runtime context and may return `null`, so declaration is ownership or availability intent rather than guaranteed execution.

Optional tool behavior is represented through registration options and `toolMetadata`; user exposure is controlled separately by allow policy.

## Compatibility And Versioning

External plugin packages use `package.json#openclaw.compat.pluginApi` and build metadata such as:

- `openclaw.build.openclawVersion`
- `pluginSdkVersion`

Host-floor fields also exist, such as:

- `compat.minGatewayVersion`
- `install.minHostVersion`

`memory-core` is bundled/private, so it uses a peer dependency on OpenClaw rather than the external compatibility block.

## Policy And Security

OpenClaw treats enabled code plugins as trusted in-process code with host privileges. Controls are policy and gating, not sandbox guarantees.

Relevant controls:

- plugin allow/deny config
- explicit enablement
- install policy
- path-safety checks
- tool allowlists
- optional tool metadata
- trusted tool policies
- `before_tool_call` hooks that can block, rewrite, or require approval

The research pass did not find a universal manifest-level `permissions` schema.

## Health

The research pass did not find a universal manifest-level `health` field. Health/status appears domain-specific, for example memory manager `status()`/`probe()` surfaces and CLI inspection.

For MVP-007, health should be a project02 host-contract addition, not treated as an OpenClaw-compatible manifest field.

## Project02 Mapping Recommendations

- Model project02 `AgentCapability` as a normalized host contract, not as an OpenClaw manifest clone.
- Keep a manifest/runtime split: static declaration says what may exist; runtime registration supplies executable hooks/tools.
- Include local fields for `id`, `displayName`, `description`, `version`, `kind`, `contractVersion`, `compatibility`, `declaredCapabilities`, `config`, `activation`, `policy`, `health`, and source/provenance references.
- Treat declared tools as authoritative. Reject or diagnose any runtime tool that was not declared.
- Map memory capability to explicit project02 hooks: before role-model call/context injection, tool handling, after-turn commit, session end, and health.
- Use OpenClaw compatibility ideas as adapter evidence: source system, source version, plugin API range, SDK version, minimum host version.
- Add project02-local policy fields for MVP-007: required/optional, side-effect level, confirmation requirement, timeout, redaction labels, and failure behavior.
- Keep cold inspect and runtime inspect separate: manifest snapshot, activation reason, registered hooks/tools, tool declaration match, config fingerprint, policy state, and health result.

## Unknowns And Future Work

- Universal permission schema was not present in the OpenClaw sources reviewed.
- Universal health schema was not present in the OpenClaw sources reviewed.
- Marketplace/install provenance and ClawHub policy should stay future work.
- OpenClaw provider/channel/model catalog fields should stay adapter metadata or future work.
- Command aliases, setup runners, package installation, and dynamic code loading are outside MVP-007 core.
- TencentDB/Hermes details are intentionally omitted from this OpenClaw note.
