# MVP-004 CT-01 - Durable Storage Contract

Parent active slice: [MVP-004 - Durable Local Runtime Continuity](../completed/mvp-004-durable-local-runtime-continuity.html)

Assigned subthread: `mvp-004-durable-storage-contract`

## Goal

Define the minimal durable local storage contract for MVP-004 so all downstream work can share one
versioned file layout, session identity model, record codec, fixture set, and error policy.

## Current Scope

- Define the default dev-local store root, proposed as `.project02-runtime/`.
- Define how tests and CLI callers override the store root.
- Define a schema/version marker and unsupported-version behavior.
- Define storage-safe session identity, session metadata, created/updated timestamps, and catalog shape.
- Define per-session directories under the store root. Runtime records should not carry duplicate `sessionId` fields unless the main thread explicitly revises the storage strategy.
- Define append-only file names for runtime trace entries, raw event records, and visible conversation records inside each session directory.
- Define record codecs that preserve the MVP-003 event ID, trace ID, timestamp, status, payload summary, and visible message fields.
- Define corruption, missing-file, malformed-record, read/write failure, and partial-write
  error codes on the shared `LocalRuntimeStorageContractError` contract.
- Provide a thin module map and deterministic test fixtures downstream tasks can reuse.

## Explicit Non-Goals

- Do not implement the full file-backed runtime log store.
- Do not implement chat CLI persistence UX.
- Do not implement session rehydration beyond fixtures and contract examples.
- Do not add SQLite, database servers, cloud storage, encryption, backups, model calls, memory, retrieval, scheduler, provider edges, or account identity.
- Do not recreate old runtime modules from `legacy/typescript`.

## Expected Files Or Areas

- `src/local-storage.ts`
- `tests/local-storage.test.ts`
- `.gitignore`
- `src/index.ts`

## Coordination Notes

- This task owns the shared contract used by CT-02, CT-03, CT-04, and CT-05.
- Keep the contract small and concrete. Avoid unused extension points for future providers, memory, or schedulers.
- If `.project02-runtime/` is accepted as the default dev-local root, add it to `.gitignore`.
- Downstream tasks should not invent parallel stored record shapes.
- Downstream tasks should use the shared error codes `missing_file`, `read_failed`,
  `write_failed`, and `partial_write` instead of creating private IO error classes.
- Downstream tasks should import CT-01 exports rather than duplicating store-root, session-ID, file-layout, codec, or error helpers.

## Acceptance Criteria

- Unit tests prove `.project02-runtime/` is the default root, can be overridden for tests/CLI callers, and is ignored by Git.
- Unit tests prove schema markers, store roots, storage-safe session IDs, per-session paths, and record codecs are deterministic under injected clocks/IDs.
- Unit tests prove unsupported schema versions and malformed records fail with explicit typed errors.
- Unit tests prove encoded and decoded records preserve MVP-003 runtime identity and payload summary fields.
- Fixture helpers are exported or locally reusable in a way CT-02 through CT-05 can depend on without importing test internals.
- The handoff includes the final module map and states that CT-02 through CT-05 must not create alternate production storage contracts.
- Existing MVP-001 through MVP-003 tests continue to pass.

## Required Checks

- Focused storage-contract tests.
- `pnpm check`
- `pnpm exec tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`
- `git diff --check`

## Handoff Expectations

Return a handoff with:

- summary of the file layout, schema version, session metadata, and record codec;
- exact files changed;
- checks run and results;
- exported types, helpers, and error names;
- accepted assumptions;
- unresolved questions or conflicts;
- integration instructions CT-02 through CT-05 must follow.
