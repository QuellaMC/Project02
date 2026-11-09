# p02-core

The domain the crates above it are written in: conversations, the
sessions a character keeps in them, their messages, and their ids. It
depends on p02-shared alone.

- A conversation is between two or more participants, each once; the
  person is `local-user` in all of them. Its segments are sessions,
  `<conversation id>.<segment>`, from 1.
- A session's messages climb in number as they are committed, each with
  the name its speaker had then, and every one joins through one gate,
  said now or read back.
- Visible text is normalized once, `\n` line endings and both ends
  trimmed; stored text that is not is refused, never rewritten.
- A moment is UTC to the millisecond, `2026-06-15T00:00:00.000Z`.
