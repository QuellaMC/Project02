# MVP-006 CT-02 - NVIDIA Provider Adapter

Parent active slice: [MVP-006 - Real Model Tools And Character State Patch](../active-slice.html)

## Goal

Add the first real role-model provider adapter so the framework can be tested against real model behavior while keeping automated tests deterministic and secret-free.

## Current Scope

- Add an NVIDIA-compatible chat-completions adapter behind the existing role-model adapter seam.
- Use non-streaming responses first.
- Read credentials only from an environment variable such as `NVIDIA_API_KEY`.
- Support provider selection through injected options and environment config such as `PROJECT02_ROLE_MODEL_PROVIDER=nvidia`; final chat CLI flag parsing belongs to CT-05.
- Render a provider request that asks the model to return one JSON `CharacterDecision` object with supported tool calls.
- Parse provider response text into raw role-model output for the existing Role Model Loop.
- Map missing config, HTTP failures, provider error payloads, malformed response shape, and empty output to clear runtime/provider errors.
- Redact secrets from request summaries, logs, errors, test snapshots, and docs.

## Explicit Non-Goals

- No committed API keys or sample bearer tokens.
- No live provider calls in automated tests.
- No streaming support.
- No multi-provider abstraction beyond the one narrow adapter interface required here.
- No external tools or provider webhooks.
- No state patch validation logic.
- No final `chat-cli` flag parsing or terminal UX ownership.

## Likely Files

- `src/nvidia-role-model-provider.ts`
- `src/role-model-loop.ts`
- `src/index.ts`
- `tests/nvidia-role-model-provider.test.ts`
- `tests/role-model-loop.test.ts`

## Dependencies

- CT-01 for final tool-call output contract wording and fixtures.
- CT-05 for final CLI flag shape if CLI wiring is not completed inside this task.

## Acceptance Criteria

- Missing `NVIDIA_API_KEY` fails with a clear provider config error when the provider is selected through injected options or environment config.
- Provider request bodies include model name, non-streaming mode, messages, and the rendered tool-call output contract.
- Provider adapter tests use a fake fetch/client and do not access the network.
- Provider response parsing returns raw output text suitable for the Role Model Loop.
- Provider errors preserve useful diagnostics without logging secrets.
- Default local adapter behavior is unchanged when no provider is selected.

## Required Checks

- `pnpm lint`
- `pnpm typecheck`
- Focused provider and role-model tests
- `pnpm test` before handoff if dependencies are installed

## Handoff Expectations

Report the provider config contract, model defaults, request/response shape, fake-client test coverage, skipped live smoke details, and the injected APIs plus evidence fields that CT-05 must expose through CLI and inspect.
