# runtime

The committing runtime: turn orchestration (`turn/`), durable storage
engines and codecs (`storage/`), durable-evidence validation and
projection (`evidence/`), and configuration (`config/`). This module
owns everything that persists or replays a session. It may depend on the
plugin _contract_ (`plugins/api`) but never on host, policy, or package
behavior (arch rules `runtime-plugins-*`).

`evidence/conversation-history.ts` is the one projection of a session log
into the turns the model replays; a live turn and a reopened session both
run it over the same records, so the model's history never depends on how
the session was reached.
