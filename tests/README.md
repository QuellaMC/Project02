# tests

Two suites, one intent each, both black-box against the binary — a test
lives in exactly one:

- `conformance/` — the daemon spawned as a process and met only where a
  client meets it, with nothing imported from `packages/` but the
  contract's schema (see `conformance/README.md`).
- `browser/` — the built page in Chromium, against a daemon met through
  the conformance harness (see `browser/README.md`).

Beside them, `check-conformance-inventory.test.ts` is the unit test of
`scripts/check-conformance-inventory.mjs`, the check of the inventory
both suites are indexed by, on temp roots `temp-root.ts` makes. The
clients' unit tests sit beside their code under `packages/`, and the
daemon's own unit and integration tests are Rust tests under `crates/`,
run by `pnpm check:rust`. Run the conformance suite with
`pnpm test:conformance` and the browser suite with `pnpm test:browser`,
each after building the page and the binary; `pnpm test` runs every
package's unit tests, this one among them, and coverage is measured on
the clients' alone.
