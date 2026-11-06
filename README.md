# Project02

A character of your own to talk to, in a window and in Telegram. Project02
is an app for Windows, macOS and Linux: a window to talk to the characters
in, and an icon in the tray that keeps them answering in Telegram while the
window is closed. The daemon that runs the characters is written in Rust,
and the page the window shows in TypeScript.

## Layout

- `crates/` — the Rust workspace: the daemon, the Telegram connector, the
  `project02` binary that runs both, and the app a person installs.
- `packages/page/` — the web page the daemon serves and the window shows.
- `packages/wire/` — the daemon's wire as its clients meet it: the contract
  and the reference client.
- `tests/` — the conformance suite and the browser suite, both driving the
  binary from outside.
- `scripts/` — the checks the gates run, and the smoke each bundle passes.
- `docs/` — reference pages under `docs/wiki/`.
- `.github/` — the gates CI runs, and the workflow that makes the bundles.

## Running it

With Node 24.12 or later, pnpm, and the Rust toolchain `rust-toolchain.toml`
names:

```text
pnpm install
pnpm serve
```

`pnpm serve` builds the page and the binary, then serves the home
`.project02` in the checkout, asking once before it makes one, and prints
the address to open. A change goes in through three gates: `pnpm check`, the
clients' gate; `pnpm check:rust`, the daemon's gate; and
`pnpm test:conformance`, the conformance suite against the binary.

## Installing

`docs/wiki/install.html` says how a person gets the app and opens it the
first time. `THIRD-PARTY-NOTICES.txt` is the notice every bundle carries:
what the app is built from, with the text of each license.

Copyright 2026 Jiaying Wang, all rights reserved.
