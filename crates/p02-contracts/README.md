# p02-contracts

What the runtime and what it hosts agree on: the plugins compiled into the
daemon, with their tools and settings, and the model providers it calls.
The runtime reaches both only through this crate.

A plugin's manifest exists only validated, and a `Registration` holds its
code, a `RuntimePlugin`, to it. Beside its factory, a plugin has a
`SetupCheck`: whether its settings are enough to build it. A manifest also
says how a settings page draws the plugin: its row, the words for each
field and the values it offers first, and the cards its fields sit in,
every field in one at least. The
host calls only the hooks a plugin declares, under its budget and a
cancellation token every capability call checks, and a hook that may only
read, or has settled, changes none of the documents, logs and text files of
its plugin's store. A tool call runs only on
input its JSON Schema admits, a tool that asks the person first changes
nothing until they say yes, and one rule decides whether a value fits a
settings field.

A provider is a `RoleModelAdapter`, answering with what the model wrote or
how it failed. The character writes to the person with the built-in
`send_message`, and leaves their message unanswered for now with the
built-in `answer_later`, which takes nothing; no plugin tool may take
either name. While she has more than one app, `send_message` lets her
name the app a message goes in. `DecisionResult::judge` is the one verdict
on a round, given what began its turn: the person's line, which she
answers or leaves for later, or a moment of her own, in which she owes
nothing; whether she has sent a message in it yet, after which a round of
nothing at all ends a line's turn too; and the apps she has now, the only
ones a message may name. What a record keeps of a round holds no
credential-named value, keeps each message she sent in it under the name
`visible_reply`, with the app she named, whatever the model is offered
the tool as, and a call of `answer_later` under its own name.
