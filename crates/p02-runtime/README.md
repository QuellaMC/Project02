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
  person renames no thread. An open that fails after the conversation's
  lease was taken releases it. Closing the thread runs the segment's end
  hooks, then releases the segment's lease and then the conversation's.
- **One line at a time.** The thread takes a line only once the one before
  it ended. A line its client submitted under an id a run before this one
  took, in the current segment or a closed one, is answered with the
  message it was committed as: nothing runs twice for one id, and nothing
  is written. The closed segments' lines come from the conversation's
  record of them, completed when the thread opens from every segment the
  record does not cover; the segment just before the current one must read
  whole, and an older one that cannot be read gives up its lines.
- **The turn.** Its records land in the order the store's gate admits
  them: the event as it came in; the person's line, committed once the
  history the model is shown was read; the plugins' preparation of the
  model's call, which may refuse the turn and keeps the line; each model
  round, recorded before anything it decided happens, each reply committed
  in the round's order and each tool call started and finished in the
  model's; the health gate, which may refuse a reply already shown and
  keeps it; and the record that ends the turn, before the plugins' work
  after its commit, which can change nothing about it. A text that is no
  line is refused with its event, and nothing is committed.
- **What the turn says.** The person's line, each reply, the pieces of a
  reply the model is still writing and their withdrawal, and the tool
  calls requested and completed, in order, on the turn's own task. A
  message is announced once its record is on disk; a draft is the one
  exception and says so by its kind, and every draft ends exactly once.
- **Failure.** When the runtime itself fails, a store write or a record
  the gate refuses, the turn is fatal and its caller restarts the
  character. The turn first records its own rejection, if it still can,
  naming what it committed, so the log reads back whole. A delivery its
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
  the person last said there and which tools were used. The continuation
  record is the commit point: a failure before it lands discards the new
  segment, or leaves it empty for the next open to discard, and the thread
  stays where it was, to plan again after the next turn; after it the old
  segment's lines are recorded, its end hooks run and its lease is
  released, and what of that fails is reported, never undone. Every length
  is counted in characters.
