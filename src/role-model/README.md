# role-model

The character decision layer: decision/wire contracts (`api/`), the
tool-call loop and decision parser (`loop/`), prompt rendering
(`prompt/`), and provider adapters (`providers/`). This module owns how
a model turn is prepared, parsed, and validated. `api/index.ts` is the
plugin-independent surface; the top barrel carries everything else.

`prompt/prompt-text.ts` is the one home of every sentence the runtime
writes to the model; it speaks to the character in the second person, and
`prompt/render.ts` only decides frames, roles, and fences.
