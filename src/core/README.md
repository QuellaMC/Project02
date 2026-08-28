# core

Pure domain: the message model (`message/`) and the conversation domain
(`conversation/`). This module owns what a conversation _is_ — a thread
between a set of participants (`conversation.ts`) — and what one
character's session of it is: messages, speakers, turn ordering, and the
runtime event identity vocabulary (`session.ts`). It imports nothing
above `src/shared` (arch rule `core-is-pure`); nothing else may
implement these concepts.
