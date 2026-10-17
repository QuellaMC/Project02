# gateway

The daemon composition layer: everything one character _is_ at runtime,
held behind one message-shaped boundary, the one façade the daemon holds,
and the socket every client talks to.

`api/` carries the contract — the `Gateway` façade, the per-character
`CharacterRuntime` interface, and the message/event/outcome shapes that
serialize over HTTP — behind its own barrel, which is what a client
imports. `gateway.ts` implements the façade by composing
existing seams only: `app` builds each character's pieces, the
conversation driver opens threads and delivers turns, and the plugin host
confirms tools through its handler seam — the gateway adds lifecycle,
ordering, routing, and idempotency, never a second way to construct or
persist anything. `history.ts` reads one conversation's scrollback as
cursor-paged messages across its segments; `reconcile.ts` brings the
running set in line with the config on disk — boot, the enabled toggle,
and a reload of a ready character whose assembly would differ now, which
the runtime itself judges from what it was built with; `config.ts` is the
config owner's two verbs — the view a settings page renders (the host's
fields and the `sections`, one list over every namespace), and the change
that goes through the one control transaction (a section's operations name
it by namespace and id), applied by reconcile behind the answer;
`connector-config.ts` is the one read a connector makes, resolved through
the same functions as the view and handing out values, not field shapes,
and reads a connector's allowlist in the clear from the home's resolution
for the pairing seam; `pairing.ts` holds the pairing requests as the daemon
holds tool confirmations — each under a code, announced on the stream,
settled once for every surface, expired after an hour — and writes an
approval through the façade's own config change, into the field the
connector's declaration names in the home's document, so `health_changed`
is on the stream before the settlement;
`submissions.ts` is the turn ledger that makes a resubmitted message join
its turn instead of starting another; a line an earlier run of the daemon
already put on any segment of the conversation is refused by the runtime
itself, from the segments' records and the conversation's record of the
lines they hold, before anything runs. `conversations.ts` is the one lookup
of which character a conversation belongs to, from the store's record of
it — what history reads a stopped character's thread by, and what routes a
delivery on a conversation this run has not opened, so a tab that
reconnected after a restart keeps talking. `discovery.ts` is the daemon's
claim on its home: the lease that makes it the one daemon there, and the
record beside the config — `daemon.json`, the token and the port that
belong to the home and outlive a run — that says where it listens.

`http/` is the transport, on Hono: the app (auth, origin, body limits, the
error envelope), the API router (one route per verb, each
answering its outcome verbatim), the event streams (SSE: one subscription
that numbers every frame, keeps a bounded tail of the log, folds the turns
running, and opens each stream with `ready` or — for a client that returns
with the id of the last frame it applied — `resumed` and what it missed),
the built web page's files at the root (public, uncached, behind the API
router so no file answers for an API path), and the server whose close
order loses nothing. A stream opened with `?connector=<id>` holds that
connector present in the façade from before its first frame until it ends;
the façade counts each connector's open streams and emits `health_changed`
when a count crosses zero, so health says which connectors are on the
stream. `api/running-turns.ts` is the one fold that says what
a running turn is; the daemon builds the snapshot's turns with it and the
page folds its frames with it. `client/` is the reference client, one
module for Node and for a browser tab — the web page and the Telegram
connector use it; it speaks the platform's fetch unless its caller hands
it another, as the connector hands it one over `node:http` without Node's
five-minute bound, each request under a signal of its own. It may value-import only `api/`, itself, `core`, and
`shared` (arch rule `clients-see-only-the-wire`), so no client grows a
private path into the daemon.

Four wire rules, stated once in `docs/wiki/gateway-api.html`: status codes
describe the transport and domain outcomes are 200; the stream is a hint
— a log a client can rejoin, whose `ready` frame carries the daemon's
snapshot — and the verbs are the truth; one way in (loopback, bearer token,
`Host` and `Origin` checks, no CORS); every submission has an identity
(`clientMessageId`), which is what makes a repeat safe. The sync rule: every committed message rides the
stream after it reached disk, stamped with its `source`, and surfaces
render from the stream — so every platform shows the same thread. The
stream also carries the reply's draft ahead of its commit, marked as a
draft by its kind (`reply_delta`, `reply_withdrawn`), and the commit
names the draft it replaces; drafts never touch the log. The
daemon keeps the hard parts on its side, once: a delivery holds a thread
the runtime's recovery let go of, or one this run never opened; a reconnect
gets its world in `ready` or exactly what it missed after `resumed`; and a
confirmation names the turn that raised it — so every surface stays
small.

Nothing below this module — app, runtime, plugins, core — may import it
(arch rule `nothing-imports-gateway`), and only the gateway imports `app`
besides the CLIs that predate it.
