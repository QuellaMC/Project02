# cli

Terminal entrypoints (`serve/`, `chat/`, `inspect/`, `config/`) and their
shared flag/error helpers (`shared/`). CLIs are presentation shells over
app/runtime surfaces; nothing may import them (arch rule 4). App logic
discovered here gets extracted downward, not grown here.

`serve/` is the daemon: it holds the gateway and its loopback socket for
every client, and prints the `PROJECT02_GATEWAY=` line a client reads only
once the roster is up. `chat/` is the disposable dev terminal on the far
side of that line — an HTTP client like any other surface, with no store
of its own and no path into the daemon: it value-imports the reference
client, the contract, and `core` only (arch rule
`clients-see-only-the-wire`).
