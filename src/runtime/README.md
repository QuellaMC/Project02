# runtime

The committing runtime: turn orchestration (`turn/`), the conversation
driver (`conversation/`), durable storage engines and codecs
(`storage/`), durable-evidence validation and projection (`evidence/`),
and configuration (`config/`). This module owns everything that persists
or replays a conversation. It may depend on the plugin _contract_
(`plugins/api`) but never on host, policy, or package behavior (arch
rules `runtime-plugins-*`).

A conversation is a thread between a set of contacts, held once at
`conversations/<id>/conversation.json` in the home — identity and
participants, at most one thread per participant set. A direct message
is the two-participant case; groups and character-to-character threads
are the same shape with another set. Each character participant keeps
its own record of the thread as sessions named
`<conversationId>.<segment>` under its own data directory — what that
character saw and said, never shared. `conversation/` drives the
user-and-character case: open the thread (one process at a time, under
the conversation writer lease), deliver a user message through the turn,
and end sessions.

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
`conversation/segment.ts` opens the next segment, whose first record is
`session_continued`. `conversation/deliver.ts` sequences plan → open the
next segment → end the current one, so a failure leaves the current
segment in place — and the person sees nothing of it: rotation is the
character's memory management, not a conversation event. The segment it
closes leaves its user lines in the conversation's record of taken lines
(`storage/taken-lines.ts`), written whole at each rotation; the open of a
later run completes what it reads from any segment the record does not
cover, so a line an earlier run took is refused wherever it sits, and a
store older than the record grows one at its first rotation.

`config/` resolves the home's config document and each character's overlay
over it, and is the one path that writes them. Every setting but the
host's own belongs to a declared section, which lives under a namespace —
`plugins`, or `connectors`, whose sections are built in, declared in
`config/connectors.ts` — and is keyed by namespace, then id, in every
map the module keeps; one function, `runtimeConfigSectionPath`, spells the
path of a section and of each of its fields. Another,
`runtimeSectionValueLayers`, says which layer may supply a value, by a
field's own scope or else its section's; the merge, the views and the
refusal of a write are all built on it, and where no permitted layer
authored a field, the resolver applies its declared default.
