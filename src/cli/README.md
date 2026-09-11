# cli

Terminal entrypoints (`serve/`, `inspect/`, `config/`) and their shared
flag/error helpers (`shared/`). CLIs are presentation shells over
app/runtime surfaces; nothing may import them (arch rule 4). App logic
discovered here gets extracted downward, not grown here.

`serve/` is the daemon: it holds the gateway and its loopback socket for
every client, and prints the `PROJECT02_GATEWAY=` line a client reads only
once the roster is up.
