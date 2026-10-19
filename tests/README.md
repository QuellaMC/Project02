# tests

Five buckets, one intent each — a test lives in exactly one:

- `unit/` — one module exercised in memory; fakes for everything durable.
- `contract/` — interface obligations that every implementation of a seam
  must satisfy (store conformance, provider adapters, adapter proofs).
- `integration/` — several real modules wired together, real temp
  directories, real child processes where concurrency demands it.
- `e2e/` — drives a CLI entrypoint end to end (see `e2e/README.md`).
- `conformance/` — the daemon spawned as a process and met only where a
  client meets it, with nothing imported from `src/` (see
  `conformance/README.md`).

`support/` holds shared fixtures and harnesses; `fixtures/` holds data
files and must stay a sibling of `support/` (reached via
`import.meta.url`). Run one bucket with `vitest --project <name>`;
coverage is global and only measured on full runs.
