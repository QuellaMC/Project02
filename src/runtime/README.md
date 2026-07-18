# runtime

The committing runtime: turn orchestration (`turn/`), durable storage
engines and codecs (`storage/`), durable-evidence validation, recovery,
and projection (`evidence/`), and configuration (`config/`). This module
owns everything that persists or replays a session. It may depend on the
plugin *contract* (`plugins/api`) but never on host, policy, or package
behavior (arch rules `runtime-plugins-*`).
