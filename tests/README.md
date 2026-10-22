# tests

Three suites, one intent each — a test lives in exactly one:

- `unit/` — a module of the clients, or a script of the repository,
  exercised in memory with fakes for everything outside it.
- `conformance/` — the daemon spawned as a process and met only where a
  client meets it, with nothing imported from `src/` but the contract's
  schema (see `conformance/README.md`).
- `browser/` — the built page in Chromium, against a daemon met through
  the conformance harness (see `browser/README.md`).

`support/` holds what more than one unit test uses. The daemon's own unit
and integration tests are Rust tests under `crates/`, run by
`pnpm check:rust`. Run the unit suite with `pnpm test`, the conformance
suite with `pnpm test:conformance` and the browser suite with
`pnpm test:browser`, each of the last two after building the page and the
binary; coverage is measured on the unit suite alone.
