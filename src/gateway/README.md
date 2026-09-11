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
config owner's two verbs — the view a settings page renders, and the
change that goes through the one control transaction the console uses,
applied by reconcile behind the answer; `submissions.ts` is the turn ledger that makes a resubmitted message join
its turn instead of starting another; a line an earlier run of the daemon
already put on the segment the character is on, or the one before it, is
refused by the runtime itself, from those segments' records, before
anything runs.

`http/` is the transport, on Hono: the app (auth, origin, body limits, the
error envelope), the API router (one route per verb, each
answering its outcome verbatim), the event streams (SSE), the built web
page's files at the root (public, uncached, behind the API router so no
file answers for an API path), and the server whose close order loses
nothing. `client/` is the reference client, one
module for Node and for a browser tab — the web page and future
connectors use it; it speaks the platform's fetch, each request under a
signal of its own. It may value-import only `api/`, itself, `core`, and
`shared` (arch rule `clients-see-only-the-wire`), so no client grows a
private path into the daemon.

Four wire rules, stated once in `docs/wiki/gateway-api.html`: status codes
describe the transport and domain outcomes are 200; the stream is a hint
whose `ready` frame carries the daemon's snapshot, and the verbs are the
truth; one way in (loopback, bearer token, `Host` and `Origin` checks, no
CORS); every submission has an identity (`clientMessageId`), which is what
makes a repeat safe. The sync rule: every committed message rides the
stream after it reached disk, stamped with its `source`, and surfaces
render from the stream — so every platform shows the same thread. The
stream also carries the reply's draft ahead of its commit, marked as a
draft by its kind (`reply_delta`, `reply_withdrawn`), and the commit
names the draft it replaces; drafts never touch the log. The
daemon keeps the hard parts on its side, once: a delivery holds a thread
the runtime's recovery let go of, a reconnect gets its world in `ready`,
and a confirmation names the turn that raised it — so every surface stays
small.

Nothing below this module — app, runtime, plugins, core — may import it
(arch rule `nothing-imports-gateway`), and only the gateway imports `app`
besides the CLIs that predate it.
