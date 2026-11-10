# p02-plugins

The plugin host and the plugins compiled into the daemon. It depends on
p02-contracts, p02-core, p02-memory and p02-shared.

Each plugin keeps its descriptor, `project02.plugin.json`, beside its
code: the manifest of its hooks, its tools, its settings, the access it
requests and how a settings page draws it. `list::plugins` holds every
plugin compiled in, the host's own `runtime.plugin` first and the rest in
id order. A character's host is built from the plugins her settings
switch on, each by its factory from the values her settings give it and
checked against its manifest; when her settings change, she gets a host
built anew.

The host's rules:

- A plugin reaches what its manifest requests and nothing else, and a
  tool name belongs to one plugin.
- Each hook runs under its plugin's budget and failure policy: one
  before the model's call degrades or refuses the turn, a tool call is
  refused with a reason the model reads, and the hooks after a commit and
  at shutdown are reported, never thrown.
- Nothing a plugin returns reaches the model, the person or the log
  unless it fits the record and JSON limits, credential-named values
  redacted; a breach fails the plugin.
- A round's calls run in the model's order, and a call of a tool the
  model was not offered is refused. A tool that asks first is prepared
  only reading, and applied only on the person's yes.

The plugins: `runtime.plugin`, which lists the plugins she runs, shows one
plugin's settings and, on the person's yes, changes a field the model may
change in her own settings; session history; mem0, whose account is the
home's to set up; character state; character memory; and reply-style, the
tone she writes in and a signoff, each character's own.
