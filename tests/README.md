# tests

Two suites, one intent each, both black-box against the binary — a test
lives in exactly one:

- `conformance/` — the daemon spawned as a process and met only where a
  client meets it, with nothing imported from `packages/` but the
  contract's schema (see `conformance/README.md`).
- `browser/` — the built page in Chromium, against a daemon met through
  the conformance harness (see `browser/README.md`).

The clients' unit tests sit beside their code under `packages/`, and the
daemon's own unit and integration tests are Rust tests under `crates/`,
run by `pnpm check:rust`. `pnpm test:conformance` and
`pnpm test:browser` each build the page and the binary, then run their
suite; `pnpm test` runs every package's unit tests, and coverage is
measured on the clients' alone.
