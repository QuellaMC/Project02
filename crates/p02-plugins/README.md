# p02-plugins

The plugin host, its policy, and the plugins compiled into the daemon. It
depends on p02-contracts, p02-core, p02-memory and p02-shared; the host
runs whatever plugins its caller enables and hands their hooks only what
the character's storage grants through the contracts.

- **Activation.** A character's enabled plugins are built from their
  manifests, the values their settings give them, resolved against each
  plugin's own manifest, and their factories, so a plugin whose settings
  leave a required field unset is never built. The set is held to the
  host's rules: one instance per plugin, each matching its manifest, and
  each tool name offered to the model by one plugin alone. A plugin
  reaches what its manifest requests and nothing else; a disabled plugin
  is never given to the host. A reload rebuilds one plugin the same way
  for every later hook, unless the rebuild fails or would offer other
  tools, and waits for nothing.
- **Hooks.** Each hook runs as a task of its own under its plugin's one
  budget: a hook that panics fails through its policy, and a hook that
  blocks its worker holds that worker alone, so the host keeps its
  deadline; blocking work belongs on the blocking pool, where session
  history does its database work. No hook of a turn already abandoned
  starts. At the deadline the hook's writes end and its token is
  cancelled, and the host hears it for a second more, so a hook that stops
  at the token answers with what it gave up; one silent past that is
  refused as timed out and its task aborted. When the turn is abandoned
  the host stops waiting at once. A plugin that is ending
  only reads: its store is read-only and it opens no database, which has
  no read-only view. A failure goes through the hook's failure policy:
  `beforeRoleModelCall` degrades or rejects the turn; a tool call is
  refused with a reason the model reads; the hooks after a commit and at
  shutdown are collected and reported, never thrown.
- **The output boundary.** Nothing a plugin returns reaches the model,
  the person or the log until it keeps to the record limits and the JSON
  limits, each record and each answer as a whole, stamped with its turn,
  its plugin and its labels, which are held at activation to what a record
  has room for; a tool's output,
  and what the person is shown of a call, have every credential-named
  value redacted. A breach fails the plugin; nothing is cut to fit.
- **Tools.** A round's calls run in the model's order: consecutive shared
  calls overlap, an exclusive one runs alone, none overtakes another, and
  each call's report is handed on the moment it is made. A
  proposed call is made a call only through its tool's contract, so no
  plugin sees an input the contract refuses. A tool that asks first
  prepares each call only reading, as an ending plugin does: a call it
  refuses is refused without asking, otherwise the person is shown what
  the call would do, through the confirmer the caller supplies, and only
  on their yes does the host apply the prepared effect, under a budget of
  its own. A call of a tool the model is not offered is refused as
  undeclared, whichever plugin provides it.
- **The trusted frame.** Only a plugin granted `trusted_context: write`
  puts runtime notes and curated sections there, whole; its other items,
  and every item of another plugin, ride the person's turn.
- **The list.** The plugins compiled into the daemon, each with its
  manifest, read once from its descriptor, and its factory: what a home's
  settings are judged against and what a character's plugins are built
  from, the host's own first and then the packages in id order, an order
  everything that lists or runs them keeps, the model's tools among them.
  Each plugin keeps its descriptor beside its code. Whether a plugin is on
  where no settings switch it is its manifest's to say: character memory,
  session history and the host's own plugin are on and the rest off,
  character state switched on for a character whose package requires it.
  A manifest that does not parse is a build that must not ship: the list
  fails at its first use, naming the plugin.
- **The host's own plugin.** `runtime.plugin`, which the host builds
  itself, linked to it, when a character's settings run it. It lists the
  plugins the host runs, each with the access it holds, the hooks the
  host calls of it and exactly the tools the model is offered, and on
  asking every other plugin of the build, disabled or blocked as her
  settings decide. It shows one plugin's settings as her settings screen
  does, a secret redacted, and changes one field of them a plugin lets the
  model change, bound to the fingerprint the model read: prepared without
  writing, held to her settings' own rules, shown to the person, and
  written to her own settings, never the home's, only on her yes, the
  plugin rebuilt live as part of the change when its field allows.
- **Session history.** The first plugin compiled in: an index of the
  character's own conversations in its own database, caught up slice by
  slice from the session history after each committed turn and before
  each query and holding no session the history no longer lists, with a
  literal full-text search that never matches what the model already sees
  and a read that scrolls a session by message.
- **mem0.** Long-term memory kept by the hosted Mem0 platform, a
  self-hosted Mem0 server, or the embedded engine of p02-memory in the
  plugin's own database, and belonging to the person and the character,
  never to a session. Before a turn the five memories most like the
  person's line come to the model, each cut to 600 characters, sourced to
  its memory, its score a confidence from 0 to 1; after it the turn is
  queued for extraction behind the answer, one capture at a time and each
  within a minute, why the last one did not complete is recorded until
  one does, and what is queued drains at shutdown until its deadline. A
  backend that fails costs the turn its memory, never the turn. A
  redirect, an unreadable answer, or one shaped for the other backend
  fails the call, a row that names no memory is passed over, a
  platform's queued write is never called stored, an add abandoned at its
  deadline says it may have landed, and no failure carries a credential.
  A change of embedder re-embeds every memory behind the hooks, and a run
  that stopped on a failure goes on with the next recall or capture.
- **Character state.** How the character is right now, five aspects of
  her own inner state shown to her before each turn and patched by her
  through one tool whose contract enumerates every value. Each accepted
  patch is a line of her log, the state's one truth, then a checkpoint of
  what the log folds to; a read takes the checkpoint while it reads and
  nothing was written after it, and folds the log anew otherwise, passing
  over a line that is no patch and saying so. Only a checkpoint of a
  newer version fails closed, left as it is.
- **Character memory.** Two notebooks the character keeps herself, notes
  to herself and what she knows about the person, changed by her a batch
  at a time, every operation or none: an entry is trimmed text the trusted
  frame can show, an old text selects exactly one entry, and each notebook
  holds what fits its capacity in characters, its entries joined as the
  frame joins them. What the frame shows of them is taken once a session,
  so a change shows from her next one, and an empty notebook shows
  nothing.
- **Demo config.** A reply style its settings choose, a tone and a
  signoff, there for the host's own plugin to have settings to change.
