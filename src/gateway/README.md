# gateway

The daemon's wire as its clients meet it: the contract and the reference
client. The daemon itself is the Rust binary, `crates/project02`, and its
socket `crates/p02-gateway`.

`api/` carries the contract behind its own barrel, which is what a client
imports: every shape that crosses the socket, declared by
`api/generated/contract.ts`, and the protocol's version, its loopback
hosts, the longest name a speaker goes by and whether a turn committed its
line. The Rust types the socket carries are the contract's one source:
`cargo test -p p02-gateway contract` writes the declarations from them,
and `api/generated/schema.json` beside them, the same shapes as a JSON
Schema, which the conformance suite holds every answer and every frame
to, so a shape a client and the daemon disagree on is a compile error
here or a schema failure there. Neither file is edited by hand, and
`pnpm check:rust` fails when either is stale. `api/running-turns.ts` is
the one fold that says what a running turn is, as p02-app's `RunningTurns`
says it for the daemon and the Telegram connector; the page folds its
frames with it.

`client/` is the reference client, one module for Node and for a browser
tab, which the web page uses; it calls each route from a table of its
own, typed by the contract, splits the event stream into frames, and
speaks the platform's fetch, each request under a signal of its own. It
may import only `api/` and itself, types included (arch rule
`clients-see-only-the-wire`), so no client grows a private path into the
daemon.

Four wire rules, stated once in `docs/wiki/gateway-api.html`: status codes
describe the transport and domain outcomes are 200; the stream is a hint
— a log a client can rejoin, whose `ready` frame carries the daemon's
snapshot — and the verbs are the truth; one way in (loopback, bearer token,
`Host` and `Origin` checks, no CORS); every submission has an identity
(`clientMessageId`), which is what makes a repeat safe. The sync rule:
every committed message rides the stream after it reached disk, stamped
with its `source`, and surfaces render from the stream — so every platform
shows the same thread. The stream also carries the reply's draft ahead of
its commit, marked as a draft by its kind (`reply_delta`,
`reply_withdrawn`), and the commit names the draft it replaces; drafts
never touch the log. The daemon keeps the hard parts on its side, once: a
delivery holds a thread the runtime's recovery let go of, or one this run
never opened; a reconnect gets its world in `ready` or exactly what it
missed after `resumed`; and a confirmation names the turn that raised it —
so every surface stays small.
