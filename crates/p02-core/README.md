# p02-core

The domain's identities and the message record every layer above it
carries. It depends on p02-shared alone.

- **Identities.** A session is named by a `SessionId`; its messages by
  a `MessageId`, the session's id and the message's place in it; a
  runtime event by an `EventIdentity`, its event and trace ids and the
  canonical UTC time it was created at, in the one spelling
  `toISOString` gives: `2026-06-15T00:00:00.000Z`.
- **Messages.** A `VisibleMessage` is what a person and a character
  said to each other: who spoke, under the name they had then, and the
  text as shown. Visible text is normalized once, line endings to `\n`
  and the ends trimmed, and a stored text that is not already
  normalized is refused, never silently rewritten.
