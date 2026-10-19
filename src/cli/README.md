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

A test harness shortens the daemon's waits, so expiry and pings run in
seconds, with `PROJECT02_TEST_DURATIONS`: `key=milliseconds` pairs
separated by commas, read once at start. The keys are `confirmation` (a
tool confirmation's wait for its answer, 5 minutes), `pairing` (a pairing
request's, an hour), `silence` (how long the model provider may say
nothing, 30 s), `heartbeat` (the stream's ping, 15 s), `grace` (how long a
client has to take what it was sent — a frame, or an answer at a stop —
2 s), `hold` (a second `serve`'s wait for a holder that does not
answer, 30 s) and `probe` (how long one question to that holder waits
for its answer, 5 s). A key it does not read (the connector's `edit` among
them), a key given twice, or a value that is not a whole number of
milliseconds above 0 refuses the start, on stderr with exit code 1,
before anything is bound or written. It is a hidden switch, not a
setting: neither `config.json` nor the settings page knows it.

`inspect/` reports on a home and writes nothing. Every report opens with
the character's resolved config, its plugins, and each built-in
connector's settings, secrets redacted, before the sessions or
conversations it was asked for.
