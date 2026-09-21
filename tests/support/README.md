# tests/support

Shared fixtures and harnesses for all five buckets. This directory owns
test plumbing; buckets own assertions. `spawn-daemon.ts`,
`scripted-adapter.ts`, and `demo-config-tool.ts` import no vitest, so the
browser suite's Playwright worker can use them too. Data files live in `../fixtures/`,
which must remain a sibling — `plugin-host-fixtures.ts` reaches it via
`import.meta.url`.

Known debt: `default-plugin-host.ts` performs real bundled-package
discovery with a top-level `await` at import time, so every importer —
including nominally in-memory unit suites — depends on the on-disk
bundled package layout. Next candidate: an in-memory character-state
fixture for unit-bucket consumers.
