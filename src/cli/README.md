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
The token and the port belong to the home and are kept in
`<home>/daemon.json`, so a restart is the same address. A second `serve`
on a held home prints the running daemon's address and exits, waits for one
that is stopping, or says that nothing answered. Ctrl-C, SIGTERM and SIGHUP
are one stop: it finishes what was accepted, then lets the home go.
