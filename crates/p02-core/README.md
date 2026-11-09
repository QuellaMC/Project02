# p02-core

The domain every layer above it is written in: conversations, the
sessions characters keep in them, the messages those hold, and the
identities of each. It depends on p02-shared alone.

- **Conversations.** A conversation is a thread between participants,
  the person and characters, by kind and id: two at least, each listed
  once, kept in one order whatever order they came in. The person is the
  speaker `local-user` in every conversation, and goes by `You` until
  they choose a name, which the prompt reads as none. A conversation id
  is a token without a `.`, and each of its sessions is
  `<conversation id>.<segment>`, numbered from 1.
- **Sessions.** A session is one character's part in one segment of a
  conversation: its messages in the order they were committed, each
  numbered after the last and said by the session's character or by the
  person. Numbers climb but may skip, since a message whose write failed
  spent its number. Every message joins through one gate, whether it is
  said now or read back, and one that breaks a rule is refused.
- **Messages.** A `VisibleMessage` is what a person and a character said
  to each other: who spoke, under the name they had then, and the text as
  shown. A name is no part of a thread, so a rename reaches every thread
  from the next message on and changes no message. Visible text is
  normalized once, line endings to `\n` and the ends trimmed, and a
  stored text that is not already normalized is refused, never silently
  rewritten. What a person says in a turn is their line, which may span
  several lines of text: normalized the same way, and refused when blank.
  A client stamps the line it carries with its surface and the id it
  submitted the line under, each one token.
- **Identities.** A runtime event is named by an `EventIdentity`, its
  event and trace ids and the canonical UTC time it was created at, in
  the one spelling `toISOString` gives: `2026-06-15T00:00:00.000Z`, which
  reads as milliseconds since the Unix epoch, as a client's clock reads a
  deadline. A moment is minted in one place, from the clock, to the
  millisecond, an event in one place, `evt_` and `trace_` each with a random
  UUID, and a conversation in one, `conv_` and a random UUID.
- **Selection.** When the person does not say which character to talk
  to, it is the one character enabled; none, or several, is refused,
  naming them.
