# tests/conformance

The daemon's behavior, and the Telegram connector's beside it, proved
from outside. Each test starts `serve`, `inspect` or the connector as a
process and meets it only where a user or a client would: the address
line it prints, HTTP and the event stream, the files in its home, its
stdout, stderr and exit code, and for the connector what it asks of
Telegram and of the daemon. Nothing here depends on how either is built,
so the same suite runs against today's TypeScript programs and against
any other build of them.

## Rules

- Nothing is imported from `src/` or `tests/support/`. Reading them to
  learn the wire is expected; the suite keeps its own small client so a
  client bug and a daemon bug stay apart.
- A test's title is its row id in `inventory.csv`, a colon, a space, then
  the behavior as a sentence:
  `lifecycle.address-line: serve prints its address as its first stdout line once it answers there`.
  `pnpm arch:check` runs `scripts/check-conformance-inventory.mjs`, which
  fails when a title names no row and when a row marked done has no test,
  here or, for a page row, in `tests/browser`.
- A test waits only on what it can observe: a printed line, a frame, a
  request reaching a stand-in server, an exit, a file. Never a sleep.
- Every wait has a ceiling of ten seconds, counted for a printed line from
  the process's last output, and a wait that runs out fails showing every
  process's stdout and stderr, every stream's frames and what each
  stand-in server was asked.
- Before asserting that something did not happen, a test waits for
  something that must happen after it.
- Each test owns its home, daemon, connector, stand-in servers and ports.
  Teardown kills each process group the test started, and a process still
  there after the ceiling fails the test. The suite runs on POSIX:
  process groups are how signals reach a daemon and what it started.

## The harness

| File                         | Job                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `harness/home.ts`            | A canonical temp home, empty for `serve --init` or seeded with the files a test names; a session log's records, the records of one kind across a character's sessions, and every file under a directory.                                                                                               |
| `harness/daemon.ts`          | Spawns `serve`, `inspect` or the Telegram connector in its own process group, `serve` on a pseudo-terminal too: its address, signals, output and exit code.                                                                                                                                            |
| `harness/wire.ts`            | One method per verb of `docs/wiki/gateway-api.html`, answering the outcome as JSON.                                                                                                                                                                                                                    |
| `harness/events.ts`          | The event stream: frames as they came, awaited by predicate, resumed by `Last-Event-ID`.                                                                                                                                                                                                               |
| `harness/http.ts`            | One request exactly as the test writes it, nothing added: the answer's status, headers and body as it comes, and a client that stops reading or hangs up.                                                                                                                                              |
| `harness/socket.ts`          | A bare TCP connection, for a request stopped halfway or an answer left unread.                                                                                                                                                                                                                         |
| `harness/model-server.ts`    | An OpenAI-compatible model on loopback that answers as the test scripts it, streams at the test's pace, holds a request open on demand and keeps every request, with what each showed the model.                                                                                                       |
| `harness/mem0-server.ts`     | A Mem0 backend on loopback, a self-hosted server or the platform, that answers each path as the test scripts it, holds a request open on demand and keeps every request.                                                                                                                               |
| `harness/telegram-server.ts` | Telegram's Bot API on loopback, answering by Telegram's envelope and its server's rules, a newer poll ending a waiting one with a 409: it keeps every call with its moment, answers one with a 429, keeps a webhook or revokes a token on demand, and drops every call while Telegram is out of reach. |
| `harness/relay.ts`           | The daemon's wire relayed for the connector, through a home whose record names the relay: every request kept with its headers, an answer held back until released, a request refused, and the daemon out of reach, its stream cut, until it is back.                                                   |
| `harness/server.ts`          | Binds a stand-in server to a loopback port of its own under the ceiling, and closes it with the test.                                                                                                                                                                                                  |
| `harness/build-page.ts`      | Builds the page the daemon serves, once before the suite, when the checkout has none.                                                                                                                                                                                                                  |
| `harness/terminal.py`        | A pseudo-terminal for `serve`, kept in the suite's process group and relayed to the harness.                                                                                                                                                                                                           |
| `harness/wait.ts`            | The ceiling, what a failed wait shows, and a wait on what a stand-in server keeps.                                                                                                                                                                                                                     |
| `harness/runner.ts`          | The runner the harness serves: work for the end of the test running now, supplied by Vitest in `setup.ts` and by Playwright in the browser suite's `fixture.ts`. No other harness file imports a runner.                                                   |

## Environment

`PROJECT02_SERVE_CMD` is the command line that starts the daemon, split on
whitespace and run from the repository root: `node src/cli/serve/main.ts`
when unset. `PROJECT02_INSPECT_CMD` is the one that runs `inspect`, read
the same way: `node src/cli/inspect/main.ts` when unset, and
`PROJECT02_CONNECTOR_CMD` the one that starts the Telegram connector:
`node src/frontends/telegram/main.ts` when unset. A test adds its own
arguments, and the switches of `src/cli/README.md` it needs:
`PROJECT02_TEST_PROVIDER=deterministic` for the fixed-reply voice,
`PROJECT02_TEST_DURATIONS` for shortened waits. The connector takes the
two of `src/frontends/README.md`: `PROJECT02_TEST_TELEGRAM_API`, naming
the test's Bot API, and `edit` in `PROJECT02_TEST_DURATIONS` for its
draft edits. A test that needs the model server or the mem0 server
writes its settings into the home's `config.json` before the start.

`python3` must be on `PATH`: the consent-prompt test gives `serve` a terminal
through its `pty` module (`harness/terminal.py`).

Against another build of the daemon and the connector, this suite and
the browser suite, which starts `serve` through the same harness:

```sh
PROJECT02_SERVE_CMD='path/to/project02 serve' \
PROJECT02_INSPECT_CMD='path/to/project02 inspect' \
PROJECT02_CONNECTOR_CMD='path/to/project02 telegram' \
  pnpm exec vitest run --project conformance
PROJECT02_SERVE_CMD='path/to/project02 serve' pnpm test:browser
```
