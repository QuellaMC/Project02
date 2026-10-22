# tests/differential

One scenario driven through two builds of the daemon, a reference and a
candidate, and what each left compared once normalized: what reached the
stand-in model server, byte for byte but for the three differences a port
is permitted; what reached the stand-in mem0 server; the event stream's
frames, kinds and payloads; the history pages; and `inspect`'s reports,
but for what each build's store keeps its own way (plan D1).
A port is checked against the reference's recorded behavior, never against
its source. Both builds are met only through the conformance harness, as
`tests/conformance` meets one.

## Rules

- Nothing is imported from `src/` or `tests/support/`; `pnpm arch:check`
  refuses it.
- Each build runs the scenario on a home, a model server and a mem0 server
  of its own, the reference first. Every step waits on what the daemon
  shows before the next — an answer, a frame, a request reaching a
  stand-in server — so two runs of one build leave the same recording but
  for what the normalizer names.
- The scenario speaks only the Basic Multilingual Plane, where a history
  window estimated in UTF-16 units and one estimated in code points agree,
  so a window that differs is a difference, shown as the turn it holds or
  lacks.
- The comparison is one assertion: its message names the part where the
  two recordings first part, and its diff shows them.

## The scenario

Mira, on a home whose context window is small enough that the first line
alone outgrows the half of it history may use, with the bundled
demo-config plugin switched on and mem0 on the server backend:

1. A recall from mem0 rides a long line, and the reply arrives in pieces;
   the line outgrows the window, so the session continues behind the turn
   with the summarizer's recollection.
2. A round the parser refuses, which the next round is told about.
3. A change the model asks for, approved by the person on the stream.
4. A change made as the settings page makes one, and the reload it brings.
5. A search of session history that reaches back into the first segment.

mem0 captures every turn. Then the history in pages of four, the stop,
and `inspect` on the conversations, the conversation and each session.

## Files

| File                   | Job                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `differential.test.ts` | Reads the two builds from the environment, records the scenario on each, and compares the normalized recordings.                                    |
| `scenario.ts`          | The scenario, driven through one build: its recording, as it came.                                                                                  |
| `normalize.ts`         | Every rule that lets two runs be compared, each with what it takes out and why; the rest is compared as it came, byte for byte where it is spelled. |
| `normalize.test.ts`    | Each rule pinned: a difference it takes out reads the same, and a difference beside it shows.                                                       |

## Environment

The two builds are four command lines, split on whitespace and run from
the repository root, as the harness runs `PROJECT02_SERVE_CMD`:

| Variable                          | When unset                     |
| --------------------------------- | ------------------------------ |
| `PROJECT02_REFERENCE_SERVE_CMD`   | `node src/cli/serve/main.ts`   |
| `PROJECT02_REFERENCE_INSPECT_CMD` | `node src/cli/inspect/main.ts` |
| `PROJECT02_CANDIDATE_SERVE_CMD`   | `node src/cli/serve/main.ts`   |
| `PROJECT02_CANDIDATE_INSPECT_CMD` | `node src/cli/inspect/main.ts` |

Unset, both builds are this checkout's TypeScript daemon, and the run
proves that two of its runs leave the same recording. Against another
build, the Rust binary among them, built as `../conformance/README.md`
builds it:

```sh
PROJECT02_CANDIDATE_SERVE_CMD='target/debug/project02 serve' \
PROJECT02_CANDIDATE_INSPECT_CMD='target/debug/project02 inspect' \
  pnpm test:differential
```

CI runs `pnpm test:differential` as the `differential` job on every pull
request and push, and again with the Rust binary as the candidate for
both commands in the `rust-conformance` job, after the conformance suite;
`pnpm check` leaves it out.
