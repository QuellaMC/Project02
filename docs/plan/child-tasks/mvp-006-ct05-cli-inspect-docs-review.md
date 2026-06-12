# MVP-006 CT-05 - CLI, Inspect, Docs, And Review

Parent active slice: [MVP-006 - Real Model Tools And Character State Patch](../active-slice.html)

## Goal

Expose the MVP-006 behavior through CLI and inspect surfaces, keep docs aligned, and perform the final integration review across provider, tool, state, and runtime boundaries.

## Current Scope

- Add or finalize explicit chat CLI provider selection for the NVIDIA provider. Support both `--provider nvidia` and an environment default such as `PROJECT02_ROLE_MODEL_PROVIDER=nvidia`, with the CLI flag taking precedence.
- Keep local deterministic chat as the default path.
- Add clear missing-provider-config and provider-failure messages.
- Ensure trace mode can summarize provider/tool/state status without leaking secrets.
- Extend inspect output with allowed tools, requested tool calls, provider metadata, state before/after, accepted state patches, and rejection reasons.
- Document manual live smoke steps that require `NVIDIA_API_KEY`, without placing secrets in docs.
- Update docs and journal entries as implementation details settle.
- Run an integration review against the active slice, child task packets, repository policy, and sibling PRs.

## Explicit Non-Goals

- No new provider implementation beyond CT-02 integration.
- No live provider call in automated tests.
- No browser UI or replay UI.
- No external tool execution or plugin loading.
- No broad architecture rewrite.

## Likely Files

- `src/chat-cli.ts`
- `src/inspect-cli.ts`
- `tests/chat-cli.contract.test.ts`
- `tests/inspect-cli.contract.test.ts`
- `docs/plan/active-slice.html`
- `docs/plan/child-tasks/mvp-006-*.md`
- `docs/develop-journal/2026-06-10/journal.html`

## Dependencies

- CT-01 for tool-call evidence names and output shape.
- CT-02 for provider config and error shape.
- CT-03 for state evidence shape.
- CT-04 for runtime evidence and commit semantics.

## Acceptance Criteria

- Default local chat remains unchanged when no provider is selected.
- Provider-selected chat fails clearly when required env config is missing.
- CLI provider selection takes precedence over environment provider defaults and is covered by contract tests.
- Inspect can show accepted and rejected MVP-006 tool/state evidence after process restart.
- Inspect can show accepted no-op `character_state.patch` evidence.
- Trace output remains JSONL and does not include secrets.
- Manual live smoke instructions are clear and opt-in.
- Docs match final behavior and do not overstate retrieval, external tools, incidents, scheduler, Live2D, or replay.
- Integration review finds no unresolved scope, duplication, or shared-contract mismatch inside MVP-006.

## Required Checks

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- Strict unused-symbol TypeScript check if TypeScript-heavy files changed
- HTML sanity checks for durable docs
- Manual live smoke only when `NVIDIA_API_KEY` is intentionally present

## Handoff Expectations

Provide final user-facing summary, CLI examples, inspect evidence examples, docs changed, checks run, skipped live smoke reason if skipped, review findings fixed, and unresolved risks if any.
