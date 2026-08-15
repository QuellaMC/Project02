# role-model

The character decision layer: decision/wire contracts (`api/`), the
tool-call loop and decision parser (`loop/`), prompt rendering
(`prompt/`), and provider adapters (`providers/`). This module owns how
a model turn is prepared, parsed, and validated. `api/index.ts` is the
plugin-independent surface; the top barrel carries everything else.

`prompt/prompt-text.ts` is the one home of every sentence the runtime
writes to the model; it speaks to the character in the second person, and
`prompt/render.ts` only decides frames, roles, and fences.

The parser (`loop/decision-parser.ts`) is the only judge of what the model
wrote: the shape of the decision, the shape of each tool call, a blank
reply, a round that neither replies nor calls a tool — all of it is
`malformed_output` with the reason in details. `visible_reply` is built in
and always offered ahead of the plugin tools; the model's `text` beside its
tool calls is kept on the decision and never shown to the person.

The loop has one rule for a round the parser refused (`loop/round-outcome.ts`,
`settleRejectedRound`): the error goes back to the model as part of its next
round and the round counts like any other; what the model does with it is
its own business. When no usable output arrived at all — the provider
failed — there is nothing to hand back, and the turn ends. The loop's only
refusal of its own is the round budget (`tool_rounds_exhausted`), recorded
against the commit while the parsed round stays what the model said. The
loop keeps no table of reasons.

The conversation history the model replays is a list of whole prior turns
(`api/conversation-history.ts`); `prompt/conversation-history-wire.ts`
turns each into native chat messages, estimates its cost, and selects the
newest turns that fit half the context window. `prompt/prompt-size.ts`
measures every rendered prompt per frame kind in wire characters and the
loop records it on the round; `inspect` applies the estimator to those
characters, so the runtime's estimate can be held against the tokens a
provider reports.

Adapters may also offer `completeText`, a plain completion on the same
model with no persona or tools; the runtime uses it to condense a
session's earlier turns when the conversation continues in a new one, and
falls back to a mechanical summary when an adapter omits it.
