# tests/browser

The built page in Chromium, driven by Playwright against a daemon met
only from outside, as `tests/conformance` meets it: each test starts
`serve` on a home of its own through the conformance harness, opens the
address it prints, and scripts the model the page talks to on the
harness's model server. Nothing here is imported from `packages/`, so
the suite runs against whichever daemon `PROJECT02_SERVE_CMD` starts:
the binary `pnpm build` makes, unless it names another.

The rules of `tests/conformance/README.md` hold here: a test's title is a
short id, a colon, a space, then the behavior as a sentence, and a test
waits only on what it can observe.

`fixture.ts` is Playwright's `test` with the harness under it: each test
hands the harness its runner, and once the test is over runs what the
harness asked to run at its end.

`pnpm test:browser` builds the page and the binary that serves it, then
runs the suite; `pnpm check` runs it too. Locally, run
`pnpm --filter @project02/tests exec playwright install chromium` once.
