# p02-runtime

The turn, the continuation of a session that has outgrown the model's
window, and the open thread between the person and one character. It
depends on p02-characters, p02-contracts, p02-core, p02-plugins,
p02-role-model, p02-shared and p02-store; its caller resolves the settings
and hands it plain values. It reaches the disk only through the store, and
only on tokio's blocking pool, where a lock's wait blocks.

- **The thread.** Opening it makes the character's data and the one
  conversation between the person and her the first time, takes the
  conversation's writer lease, and resumes its latest segment under that
  segment's writer lease, or makes the first. A latest segment past the
  first that holds no record is what a rotation interrupted before its
  first record left: it is discarded and the one before it resumed. The
  thread keeps the names its participants had when it began, so a renamed
  person renames no thread. What the open skipped because it could not be
  read, rows of her sessions catalog or lines of the segment it resumed,
  the thread says in a sentence. An open that fails after the
  conversation's lease was taken releases it. Closing the thread releases
  the segment's lease and then the conversation's.
- **One line at a time.** The thread takes a line only once the one before
  it ended. A line its client submitted under an id a run before this one
  took, in the current segment or a closed one, is answered with the
  message it was committed as: nothing runs twice for one id, and nothing
  is written. The closed segments' lines come from the conversation's
  record of them, completed when the thread opens from every segment the
  record does not cover; the segment just before the current one must be
  read, and an older one that cannot be read gives up its lines.
- **The turn.** Its records land in this order: the event as it came in;
  the person's line, committed once the history the model is shown was
  read; the plugins' preparation of the model's call, which may refuse
  the turn and keeps the line; each model round, recorded before anything
  it decided happens, each reply committed in the round's order and each
  tool call started in the model's and finished as it finishes, so a call
  that finished outlasts a crash before the rest, while the model reads
  the results in its own order; and the record that ends the turn, before
  the plugins' work after its commit, which can change nothing about it.
  A text that is no line is refused with its event, and nothing is
  committed.
- **What she answers with.** Her model, her plugins and her model's
  window are her caller's, kept as her settings say: the caller brings
  them up to date before her turn, and the turn before each request to
  the model after its first, so every request starts from her settings as
  they are then. Once she was built again, the model's call is prepared
  again with her new plugins; a plugin refuses a turn only before its
  first round, so a refusal then leaves the call as it was prepared. The
  history the model is shown is chosen at the turn's start, and the
  continuation after it runs on what the turn ended on.
- **What the turn says.** The person's line, each reply, the pieces of a
  reply the model is still writing and their withdrawal, and the tool
  calls requested and each completed as it finishes, in order, on the
  turn's own task. A
  message is announced once its record is on disk; a draft is the one
  exception and says so by its kind, and every draft ends exactly once.
- **Failure.** When the runtime itself fails, a store write or a record
  the store refuses, or her settings change under the turn to ones that no
  longer build her, the turn is fatal and its caller restarts the
  character. The turn first records its own rejection, if it still can,
  naming what it committed, so the log says how it ended. A delivery its
  caller drops before it ends is fatal the same way, with nothing
  recorded: the thread opened again closes the turn it left open with its
  next line.
- **The day.** The day the model is told it is comes from the turn's
  moment in the machine's time zone, which no setting could know better; a
  zone that cannot be read is taken as UTC.
- **Continuation.** After a completed turn whose history the model's window
  would no longer hold whole, the session continues in a new segment: the
  newest turns that fit a quarter of the window are carried whole, and the
  rest condensed by the provider's plain completion into a summary of a
  twentieth of the window at four characters a token, 1,000 characters at
  least and 6,000 at most. A provider that cannot, a failure, or a blank
  answer leaves a mechanical summary of how many turns went by, when, what
  the person last said there and which tools were used. Both speak of the
  person by the name the conversation recorded for them, as the transcript
  they condense names them. The continuation
  record is the commit point: the store makes the new segment with its
  writer, taking it back when it cannot give it one, a record that fails to
  land discards it through that writer, or leaves it empty for the next open
  to discard when the discard fails too, and the thread stays where it was,
  to plan again after the next turn; after it the old segment's lines are
  recorded and its lease is released, and what of that fails is reported,
  never undone. Every length is counted in characters.
