# cli

Terminal entrypoints (`serve/`, `inspect/`) and their shared
flag/error helpers (`shared/`). CLIs are presentation shells over
app/runtime surfaces; nothing may import them (arch rule 4). App logic
discovered here gets extracted downward, not grown here.

`serve/` is the daemon: it claims its home (one daemon per home, a lease
held for its lifetime), binds the home's port, holds the gateway and its
loopback socket for every client, serves the built web page (`dist/web`,
which `pnpm serve` builds first) at its root, and prints the
`PROJECT02_GATEWAY=` line a client reads — the address a person opens —
the moment the socket is bound, while the roster comes up on the stream.
The token and the port belong to the home — the port is whatever free one
the system hands its first run — and are kept in `<home>/daemon.json`, so
a restart is the same address. A second `serve`
on a held home prints the running daemon's address and exits, keeps trying
for a while one that does not answer — stopping, or not yet bound — and
takes the home over when its lease goes, or says so when the wait is up. Ctrl-C, SIGTERM and SIGHUP
are one stop: it finishes what was accepted, then lets the home go.

`PROJECT02_TEST_PROVIDER=deterministic` in `serve`'s environment runs
every character on the deterministic test provider — fixed replies, no
model, no network — whatever its config chooses, so a test can drive a
real daemon on a home with no provider; any other value refuses to start.
It is a test's switch, not a setting, and nothing but the entry reads it.

`inspect/` reports on a home and writes nothing. Every report opens with
the character's resolved config, its plugins, and each built-in
connector's settings, secrets redacted, before the sessions or
conversations it was asked for.
