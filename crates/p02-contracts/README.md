# p02-contracts

What the runtime and what it hosts agree on: the plugins compiled into the
daemon, with their tools and settings, and the model providers it calls.
The runtime reaches both only through this crate.

A plugin's manifest exists only validated, and a `Registration` holds its
code, a `RuntimePlugin`, to it. Beside its factory, a plugin has a
`SetupCheck`: whether its settings are enough to build it. A manifest also
says how a settings page draws the plugin: its row, the words for each
field, and the cards its fields sit in, every field in one at least. The
host calls only the hooks a plugin declares, under its budget and a
cancellation token every capability call checks. A tool call runs only on
input its JSON Schema admits, a tool that asks the person first changes
nothing until they say yes, and one rule decides whether a value fits a
settings field.

A provider is a `RoleModelAdapter`, answering with what the model wrote or
how it failed. `DecisionResult::judge` is the one verdict on a round, and
what a record keeps of a round holds no credential-named value.
