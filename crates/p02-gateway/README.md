# p02-gateway

The daemon's socket: the daemon of p02-app behind HTTP and an event stream
on one loopback port, its claim on its home and the record clients find
it by, and the web page built into the binary. It depends on p02-app,
p02-config, p02-core, p02-shared and p02-store; its caller resolves the
home, the waits and the plugins, prints, and turns signals into a stop.
Nothing here prints, reads an environment variable or parses a flag.

- **The claim.** A daemon takes its home's lease at once or not at all;
  a home another process serves is held, its record read when it can be.
  The token and the port belong to the home: a claim keeps the token the
  record holds and binds its port again, and a home without a record, or
  with one that cannot be read, is given a fresh token of 32 random bytes,
  spelled base64url. Publishing writes the record, owner-only and whole,
  with the protocol, the token, the port bound and the run, and says when
  the port moved from the record's. Releasing rewrites it without the
  run, best effort, and lets the lease go.
- **The socket.** `127.0.0.1` alone, on the record's port, or on a free
  one when another program holds that one or there is none. Every `/api`
  request passes, in order: the stop, `503 unavailable`; the host, which
  must be `127.0.0.1` or `localhost`, `421 misdirected_host`, and an
  origin, which when sent must be this daemon's page, `403
  forbidden_origin`; the bearer token, compared in one time whatever is
  presented, `401 unauthorized`, or `400 invalid_request` for a header
  that is no bearer; and, as its route reads its body, the cap of
  64 KiB, `413 payload_too_large`: a route that takes no body reads
  none. Every answer of the API is never cached, and every refusal of
  the transport is the one envelope `{"error":{"code","message"}}`. A
  body is read as JSON, each string value within 16,384 characters,
  the longest text a request carries, a line; then as its route's
  shape, which judges itself as it is read, so nothing validates it
  twice: no unknown field, the stamps as stamps, a line's text not
  empty, an id or a name within 128 characters; anything else is `400
  invalid_request`, saying where. A change of settings is read as
  p02-config's own change, whose character, fields and fingerprint are
  judged against the home: one the home does not hold is the change's
  own refusal, not the transport's. Each route answers its verb's
  outcome verbatim under 200: the status describes the transport, and
  `status` in the body what happened. An unknown route of the API,
  `/api` itself included, is a 404 behind the same rules. No CORS header
  is sent, and a token is taken from no cookie and no query.
- **The page.** Its files are built into the binary from `dist/web` as
  `pnpm build:web` left it when the binary was built, public and never
  cached; a path that names nothing the page holds meets the daemon's own
  404, and nothing can climb out to the disk. Built without a page, the
  root says how to build one.
- **The event stream.** One subscription to the daemon's events, taken
  with the streams, folds the turns running, numbers every event from 1
  under the run's id, eight random bytes as 16 hex digits, formats it once
  as a frame of one JSON line, keeps the newest frames up to 1 MiB of
  them, and hands each to every open stream, all in one step. A stream
  opens in a step of its own with its first frames: `resumed` and exactly
  the frames after the id the client last applied, when the tail still
  holds them; else `ready`, the snapshot of health and the confirmations
  and pairings waiting, read as it opens and read again while anything
  they show changed under the read, and of the turns running with their
  drafts, all exactly as of the frame it goes on from, so nothing it
  shows is told again and nothing after it is missed. An idle stream
  says `: ping` each heartbeat.
  A stream's frames are written one at a time, each once the one before
  it was taken: a client that has not taken one within the grace is gone,
  its connection closed and nothing more queued for it, however long its
  queue, which says nothing about a client. A connector's stream counts
  it present from before its first frame until its end.
- **The contract.** Every type a route answers, a route reads or a frame
  carries derives ts-rs's `TS` and schemars' `JsonSchema` beside serde, in
  the crate that owns it, its TypeScript name the one the clients know.
  A test of this crate, `cargo test -p p02-gateway contract`, walks them
  from the wire's roots and writes `src/gateway/api/generated/contract.ts`,
  the declarations the page, the client and the connector compile against,
  and `schema.json`, the schema the conformance suite holds every answer
  and frame to, both generated files the repository's formatter and
  linter leave alone; another test holds one value of each type, as
  serde writes it or a route reads it, to its schema.
- **The stop.** New API requests answer 503 at once; the daemon stops,
  its turns draining with the socket and the streams open, so an accepted
  turn still receives its answer and the stream its reply; then each
  stream ends once everything announced before the stop reached it and
  the frames queued for it are written; an answer still
  being written gets the grace to finish, while a request that never fully
  arrived is waited for not at all; and only then does the listener close
  and whatever remains is cut.
