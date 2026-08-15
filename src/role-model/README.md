# role-model

The character decision layer: decision/wire contracts (`api/`), the
tool-call loop and decision parser (`loop/`), prompt rendering
(`prompt/`), and provider adapters (`providers/`). This module owns how
a model turn is prepared, parsed, and validated. `api/index.ts` is the
plugin-independent surface; the top barrel carries everything else.

`prompt/prompt-text.ts` is the one home of every sentence the runtime
writes to the model; it speaks to the character in the second person, and
`prompt/render.ts` only decides frames, roles, and fences.

The conversation history the model replays is a list of whole prior turns
(`api/conversation-history.ts`); `prompt/conversation-history-wire.ts`
turns each into native chat messages, estimates its cost, and selects the
newest turns that fit half the context window.

Adapters may also offer `completeText`, a plain completion on the same
model with no persona or tools; the runtime uses it to condense a
session's earlier turns when the conversation continues in a new one, and
falls back to a mechanical summary when an adapter omits it.
