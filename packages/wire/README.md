# wire

The daemon's wire as its clients meet it: `@project02/wire/contract`, every
shape that crosses the socket, and `@project02/wire/client`, the reference
client the page uses, for a browser tab and Node alike.
`docs/wiki/gateway-api.html` states the wire.

`src/contract/generated/` is written from the Rust types the socket
carries, `crates/p02-wire`, by `cargo test -p p02-gateway contract`, never
by hand: the declarations a client compiles against, and `schema.json`,
which the conformance suite holds every answer and frame to. A shape the
two sides disagree on fails to compile here or fails the schema there.

The client imports only the contract (arch rule
`clients-see-only-the-wire`), and has one verb for each route, a file the
person picks, a character's or an app's, sent as the file holds it under
its own type. A client renders what the daemon says and works out
nothing: each `turn_running` frame replaces its copy of that turn whole.
