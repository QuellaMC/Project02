# tests/conformance

The daemon's behavior, proved from outside. Each test starts `serve` as a
process and meets it only where a user or a client would: the address
line it prints, HTTP and the event stream, the files in its home, its
stdout, stderr and exit code. Nothing here depends on how the daemon is
built, so the same suite runs against today's TypeScript daemon and
against any other build of it.

## Rules

- Nothing is imported from `src/` or `tests/support/`. Reading them to
  learn the wire is expected; the suite keeps its own small client so a
  client bug and a daemon bug stay apart.
- A test's title is its row id in `inventory.csv`, a colon, a space, then
  the behavior as a sentence:
  `lifecycle.address-line: serve prints its address as its first stdout line once it answers there`.
  `pnpm arch:check` runs `scripts/check-conformance-inventory.mjs`, which
  fails when a title names no row and when a row marked done has no test.
- A test waits only on what it can observe: a printed line, a frame, a
  request reaching the model server, an exit, a file. Never a sleep.
- Every wait has a ceiling of ten seconds, counted for a printed line from
  the process's last output, and a wait that runs out fails showing every
  process's stdout and stderr, every stream's frames and the model
  server's count of requests.
- Before asserting that something did not happen, a test waits for
  something that must happen after it.
- Each test owns its home, daemon, model server and ports. Teardown kills
  each process group the test started, and a process still there after
  the ceiling fails the test.

## The harness

| File                      | Job                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `harness/home.ts`         | A canonical temp home, empty for `serve --init` or seeded with the files a test names.                                              |
| `harness/daemon.ts`       | Spawns `serve` in its own process group: its address, signals, output and exit code.                                                |
| `harness/wire.ts`         | One method per verb of `docs/wiki/gateway-api.html`, answering the outcome as JSON.                                                 |
| `harness/events.ts`       | The event stream: frames as they came, awaited by predicate, resumed by `Last-Event-ID`.                                            |
| `harness/model-server.ts` | An OpenAI-compatible model on loopback that answers as the test scripts it, holds a request open on demand and keeps every request. |
| `harness/wait.ts`         | The ceiling, and what a failed wait shows.                                                                                          |

## Environment

`PROJECT02_SERVE_CMD` is the command line that starts the daemon, split on
whitespace and run from the repository root: `node src/cli/serve/main.ts`
when unset. A test adds its own arguments, and the switches of
`src/cli/README.md` it needs: `PROJECT02_TEST_PROVIDER=deterministic` for
the fixed-reply voice, `PROJECT02_TEST_DURATIONS` for shortened waits. A
test that needs the model server writes its settings into the home's
`config.json` before the start.

Against another build of the daemon:

```sh
PROJECT02_SERVE_CMD='path/to/project02 serve' pnpm exec vitest run --project conformance
```
