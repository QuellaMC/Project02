# p02-runtime

A character's thread with the person: the turn each line of theirs
takes, or each moment of her own, and the session's continuation once it
outgrows the model's window. It reaches the disk only through the store,
on tokio's blocking pool.

`Conversation::find` finds the thread's record and makes nothing: her
actor asks it whether the thread was ever made, and the daemon which
thread her phone shows. Her actor opens the thread with
`Conversation::open`, hands it each line with `deliver`, starts a moment
of hers with `moment`, giving it what
rang on her phone when its ringing began it, and closes it when she stops
or restarts. A `Submission` is the line, its client's two stamps and when
it was sent, a `Mind` answers the turn as her settings and the apps she
has stand before each request to the model, and a `Delivery` says how the
turn ended.

- **One turn at a time.** A line a turn took already is answered with the
  message it was committed as; nothing runs.
- **One path, two occasions.** A moment runs the turn a line does, but it
  commits no line and may end without a word: plain text with no call is
  a thought she keeps, never shown, and an answer of nothing ends it. In
  a turn the person began, plain text is her message, and an answer of
  nothing ends the turn only once she has sent one; or she leaves the line
  for later, and the turn completes with no message of hers. A moment
  tells her how long since the person last wrote and, while no message of
  hers stands after that line, that she has not answered. A moment may
  carry what rang, which its event keeps and her replay of it tells
  again. She replays a moment later only when she said something in it or
  a call of hers came back.
- **In the order it happens.** The event, the person's line when one
  began the turn, each model round before anything it decided, each reply
  and tool call, then the turn's ending, before the plugins' work after
  it. A message is announced once on disk. Each round is announced as its
  request goes out and as it ends, once what it said is committed and
  before the calls it made run. The person's line keeps the time it was
  sent, however long it waited, and is announced with when she read it,
  the turn's own moment; each reply of hers is sent as it is committed,
  its commit keeping the app it went in.
- **Her language.** When her `Mind` hands out a translator, the person's
  line reaches her in her language: its event keeps what they wrote, and
  it is committed as she reads it, what they wrote beside it. Each
  message of hers is put into the person's language before its commit,
  while she is seen writing, and committed with it beside her words. The
  translator is handed the conversation's newest six messages before the
  one it puts into the other language, each as its author wrote it, and
  for hers the person's newest message as they wrote it. One already in
  the other's language is committed alone, as is a message of hers that
  could not be put into theirs. A line that could not be put into hers is
  refused before anything of it is committed, as a blank text is: its
  event and the refusal are in the log, and she is never asked.
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
