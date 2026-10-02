# tests/browser

The built page in Chromium, driven by Playwright against a real daemon.
Each test spawns `daemon-entry.ts` — `serve` on a temporary home, or on
one the test owns given as `--home <dir>` so a restart can share it, with
a model scripted by the line it reads; character ids on its command line
are installed off, and `--fresh` leaves the provider unchosen — through
`tests/support/spawn-daemon.ts`, reads the address it prints, and opens
it; nothing here enters the daemon's module graph through Playwright's own
loader. `pnpm check` builds the page before this suite runs. Locally, run
`pnpm exec playwright install chromium` once.
