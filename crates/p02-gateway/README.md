# p02-gateway

The daemon's socket: p02-app behind HTTP and an event stream on one
loopback port, its claim on the home and the record clients find it by,
the page built into the binary, and the wire's generated contract.
Nothing here prints, reads the environment or parses a flag.

- **The claim.** A daemon holds its home's lease or does not start; the
  record keeps the home's token and port, owner-only.
- **The socket** answers on `127.0.0.1` alone. Every `/api` request passes
  the stop, the host and origin checks and the bearer token, and its body
  the 64 KiB cap, but for an app's file, which the person adds to her
  phone and which is held to what a text file of her phone's store holds;
  a body is read as its route's shape, which judges itself.
  A route answers its verb's outcome under 200, and every refusal of the
  transport is one envelope, `{"error":{"code","message"}}`.
- **The stream** numbers each event once under the run's id and keeps the
  newest megabyte of frames: a client back with its last id gets `resumed`
  and what it missed, any other `ready`, the snapshot of health, what waits
  and the turns running, exactly as of the frame it goes on from. A client
  that does not take a frame within the grace is dropped.
- **The contract.** `cargo test -p p02-gateway contract` writes
  `packages/wire/src/contract/generated/` from p02-wire's types: the
  TypeScript the clients compile against, and the JSON Schema the
  conformance suite holds every answer and frame to.
- **The stop** answers new requests 503, lets the daemon finish its turns
  with the streams open, ends each stream once its frames are written, and
  then closes the listener.
