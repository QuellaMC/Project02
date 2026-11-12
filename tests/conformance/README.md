# tests/conformance

The daemon's behavior, and the Telegram connector's beside it, proved
from outside. Each test starts `serve`, `inspect` or the connector as a
process and meets it only where a user or a client would: the address
line it prints, HTTP and the event stream, the files in its home, its
stdout, stderr and exit code, and for the connector what it asks of
Telegram. Nothing here depends on how either is built,
so the suite runs against the binary `pnpm build` makes, or against any
other build of the same commands.

## Rules

- Nothing is imported from `packages/` or the rest of `tests/` but the
  contract's schema, `@project02/wire/schema.json`, which the Rust types
  the socket carries generate. Reading them to learn the wire is
  expected; the suite keeps its own small client so a client bug and a
  daemon bug stay apart.
- A test's title is a short id, its area and a name, a colon, a space,
  then the behavior as a sentence:
  `lifecycle.address-line: serve prints its address as its first stdout line once it answers there`.
  Ids are unique, so a search for one finds its test.
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

| File                         | Job                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness/home.ts`            | A canonical temp home, empty for `serve --init` or seeded with the files a test names; a session log's records, the records of one kind across a character's sessions, and every file under a directory.                                                                                                                                                        |
| `harness/daemon.ts`          | Spawns `serve`, `inspect` or the Telegram connector in its own process group, `serve` on a pseudo-terminal too: its address, signals, output and exit code.                                                                                                                                                                                                     |
| `harness/wire.ts`            | One method per verb of `docs/wiki/gateway-api.html`, answering the outcome as JSON, held to the contract; and `sender`, which sends a line as a client does and answers as the stream tells its turn ended, with what it committed.                                                                                                                             |
| `harness/events.ts`          | The event stream: frames as they came, each held to the contract, awaited by predicate: `next` takes the frames in order, and `holding` looks at all of them so far; and of her own turns, a frame of one, the next one whole, and the stream gone quiet.                                                                                                       |
| `harness/schema.ts`          | The contract: an answer by its status, its route's outcome under 200 and the error envelope otherwise, and a frame by its event, `ready`, `resumed` or the event of that kind, held to the schema; a mismatch fails its test.                                                                                                                                   |
| `harness/http.ts`            | One request exactly as the test writes it, nothing added: the answer's status, headers and body as it comes, and a client that stops reading or hangs up.                                                                                                                                                                                                       |
| `harness/model-server.ts`    | A model on loopback in every protocol, chat completions as NVIDIA's server of the person's own, Responses as the OpenAI API and as a ChatGPT plan's service, and Messages as the Claude API, each under its switch, that answers as the test scripts it, streamed, whole or with an error status, at the test's pace or cut short, holds a request open on demand and keeps every request, with its headers and what it showed the model. |
| `harness/responses.ts`       | The Responses protocol as the model server speaks it: output items, a function call, her reply or a model's plain words, each streamed by its events and held whole by the event that ends the response, or, as a plan's service ends one, by its own last event alone, or whole in one body for a request that does not stream; the service's error, a plan's usage used up and a token refused; and the input a request showed the model. |
| `harness/messages.ts`        | Anthropic's Messages protocol as the model server speaks it in the Claude API's place: a message's content blocks, her reply or another tool call, plain text or a thought, each streamed by its events at its place, and the message stopped for its reason; a decline and the service's error; and the conversation a request showed the model. |
| `harness/mem0-server.ts`     | A Mem0 backend on loopback, a self-hosted server or the platform, that answers each path with the status and JSON body the test scripts, holds a request open on demand and keeps every request with its headers.                                                                                                                                               |
| `harness/telegram-server.ts` | Telegram's Bot API on loopback, answering by Telegram's envelope and its server's rules: it keeps every call with its moment, answers one with a 429, and drops every call while Telegram is out of reach.                                                                                                                                                      |
| `harness/catalog-server.ts`  | The App Store's catalog on loopback: each path answers what the test published there and any other a 404, it keeps every path asked, and out of reach it cuts every request off.                                                                                                                                                                                |
| `harness/internet-server.ts` | The internet her apps reach, on loopback for every host: a request for `https://<host>/<path>?<query>` arrives at `/<host>/<path>?<query>`, each path answers what the test scripted for it, in order, any other a 404, and it keeps every request with its headers and body.                                                                                   |
| `harness/auth-server.ts`     | OpenAI's sign-in on loopback under its switch, as OpenAI answers: a code for each start, 403 to each ask until the test approves it as the person would, as an account with a ChatGPT plan or none, the tokens it is traded for, and a refresh that takes only the newest refresh token; it keeps every request with its fields and every secret it gave, and says the newest access token. |
| `harness/apps.ts`            | Apps as the App Store serves them, for a test to publish on the catalog server: an app's one file, its entry in the catalog with the file's SHA-256, and a catalog of apps, each file where its rule puts it; with Reminders, quiet apps, Lookup, which reaches the internet, Asker, which asks a model through a connection of the person's and shows what it asked as a conversation, and Sampler, which shows one of each piece Weather and Web Search are drawn with; and ChatGPT as this repository keeps it to publish, its one file read from `crates/p02-phone/catalog/`. |
| `harness/server.ts`          | Binds a stand-in server to a loopback port of its own under the ceiling, and closes it with the test.                                                                                                                                                                                                                                                           |
| `harness/terminal.py`        | A pseudo-terminal for `serve`, kept in the suite's process group and relayed to the harness.                                                                                                                                                                                                                                                                    |
| `harness/wait.ts`            | The ceiling, what a failed wait shows, and a wait on what a stand-in server keeps.                                                                                                                                                                                                                                                                              |
| `harness/runner.ts`          | The runner the harness serves: work for the end of the test running now, supplied by Vitest in `setup.ts` and by Playwright in the browser suite's `fixture.ts`. No other harness file imports a runner.                                                                                                                                                        |

## Environment

`PROJECT02_SERVE_CMD` is the command line that starts the daemon, split on
whitespace and run from the repository root: `target/debug/project02 serve`
when unset. `PROJECT02_INSPECT_CMD` is the one that runs `inspect`, read
the same way: `target/debug/project02 inspect` when unset, and
`PROJECT02_CONNECTOR_CMD` the one that starts the Telegram connector:
`target/debug/project02 telegram` when unset. A test adds its own
arguments, and the switches of `crates/project02/README.md` it needs:
`PROJECT02_TEST_PROVIDER=deterministic` for the fixed-reply voice,
`PROJECT02_TEST_DURATIONS` for shortened waits,
`PROJECT02_TEST_APP_CATALOG` for the catalog server,
`PROJECT02_TEST_APP_INTERNET` for the internet server,
`PROJECT02_TEST_OPENAI_API` for the model server as the OpenAI API,
`PROJECT02_TEST_CHATGPT_API` for it as a ChatGPT plan's service,
`PROJECT02_TEST_ANTHROPIC_API` for it as the Claude API and
`PROJECT02_TEST_OPENAI_AUTH` for the auth server as OpenAI's sign-in. The connector takes two:
`PROJECT02_TEST_TELEGRAM_API`, naming the test's Bot API, and `edit` in
`PROJECT02_TEST_DURATIONS` for its draft edits. A test that needs the model server or the mem0 server
writes its settings into the home's `config.json` before the start.

`python3` must be on `PATH`: the consent-prompt test gives `serve` a terminal
through its `pty` module (`harness/terminal.py`).

`pnpm test:conformance` builds the page, then the binary, which embeds
the page as it finds it, and runs the suite; the browser suite starts
`serve` through the same harness.

Every answer the wire client reads and every frame the stream reader reads
is held to the contract's schema,
`packages/wire/src/contract/generated/schema.json`, which the Rust types
the socket carries generate, so every test proves the contract against
whichever build it runs. After a change to those types,
`cargo test -p p02-gateway contract` writes the schema again, and the
TypeScript declarations beside it.
