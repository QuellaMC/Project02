# p02-core

The domain the crates above it are written in: conversations, the
sessions a character keeps in them, their messages, and their ids. It
depends on p02-shared alone.

- A conversation is between two or more participants, each once; the
  person is `local-user` in all of them. Its segments are sessions,
  `<conversation id>.<segment>`, from 1.
- A session's messages climb in number as they are committed, each with
  the name its speaker had then and when it was sent, and every one joins
  through one gate, said now or read back.
- A line of the person's came in an app, which the stamp of the surface it
  came from tells: the part before its first `:`, as `telegram`, or
  `messages`, the app's own chat, which she knows as Messages. The daemon
  names the others.
- Visible text is normalized once, `\n` line endings and both ends
  trimmed; stored text that is not is refused, never rewritten.
- A language is a BCP 47 tag as written, such as `ja` or `pt-BR`: subtags
  of ASCII letters and digits joined by `-`, the first 2 to 8 letters and
  each later one 1 to 8, 35 characters at most.
- A moment is UTC to the millisecond, `2026-06-15T00:00:00.000Z`.
