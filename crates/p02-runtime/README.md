# p02-runtime

A character's thread with the person: the turn each line takes, and the
session's continuation once it outgrows the model's window. It reaches
the disk only through the store, on tokio's blocking pool.

Her actor opens the thread with `Conversation::open`, hands it each line
with `deliver`, and closes it when she stops or restarts. A `Submission`
is the line and its client's two stamps, a `Mind` answers it as her
settings stand before each request to the model, and a `Delivery` says
how the turn ended.

- **One line at a time.** A line a run before this one took is answered
  with the message it was committed as; nothing runs.
- **In the order it happens.** The event, the person's line, each model
  round before anything it decided, each reply and tool call, then the
  turn's ending, before the plugins' work after it. A message is
  announced once on disk; only a draft comes sooner, and says so.
- **Failure.** A failed store write, or settings that no longer build
  her, fail the turn: its rejection is recorded if it can be, and her
  actor restarts her. The thread opened again closes a turn a crash left
  open.
- **Continuation.** After a completed turn whose history the window no
  longer holds whole, the newest turns that fit a quarter of it are
  carried into a new segment and the rest condensed, by her model or
  mechanically. That segment's first record is the commit point: until it
  lands the thread stays where it was, and what fails after it is
  reported, never undone.
