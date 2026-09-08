# core

Pure domain: the message model (`message/`), the conversation domain
(`conversation/`), and character selection (`character/`). This module
owns what a conversation _is_ — a thread between a set of participants
(`conversation.ts`) — what one character's session of it is: messages,
speakers, turn ordering, and the runtime event identity vocabulary
(`session.ts`) — and which character a person talks to when they did not
say (`selection.ts`), the one rule the daemon's startup and every client
of its socket share. It imports nothing above `src/shared` (arch rule
`core-is-pure`); nothing else may implement these concepts.
