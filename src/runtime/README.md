# runtime

The committing runtime: turn orchestration (`turn/`), durable storage
engines and codecs (`storage/`), durable-evidence validation and
projection (`evidence/`), and configuration (`config/`). This module
owns everything that persists or replays a session. It may depend on the
plugin _contract_ (`plugins/api`) but never on host, policy, or package
behavior (arch rules `runtime-plugins-*`).

A turn's log is one record per thing that happened, each carrying its own
facts once. Every model round is a `role_model_round` record — what the
model was shown and what it wrote, accepted or refused — appended before
anything the round decided; a tool call, a character commit, and a terminal
record that judges a decision reference their round by number instead of
repeating it. A rejected turn ends in one `runtime_turn_rejected` record
whose `reason` names the seam that refused and whose `message` says why.
`storage/raw-event-round-semantics.ts` holds what one record may say about a
round; `evidence/turn-shape.ts` and `evidence/validation.ts` hold the rules
that need the round record itself: rounds are numbered as they happen, a
reference names a round the turn already ran, a character row's round said
its text, and a terminal verdict agrees with the round it judged.

`evidence/conversation-history.ts` is the one projection of a session log
into the turns the model replays; a live turn and a reopened session both
run it over the same records, so the model's history never depends on how
the session was reached.

A session is one stable-prefix segment of a conversation. When its history
outgrows the model's window, `turn/compaction-policy.ts` decides what to
condense and what to carry, `turn/session-continuation.ts` plans the
continuation (summariser first, mechanical fallback, never throwing), and
`storage/durable-session-bootstrap.ts` opens the continuing session whose
first record is `session_continued`. The chat loop sequences plan → open the
next session → close the current one, so a failure leaves the current
session in place.
