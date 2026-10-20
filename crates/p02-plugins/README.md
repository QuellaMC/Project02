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
  starts. When the host stops waiting (an answer, the deadline, the turn
  abandoned) the hook's writes end, and a hook that did not answer in time
  has its task aborted and its token cancelled. A plugin that is ending
  only reads: its store is read-only and it opens no database, which has
  no read-only view. A failure goes through the hook's failure policy:
  `beforeRoleModelCall` degrades or rejects the turn; a tool call is
  refused with a reason the model reads; the hooks after a commit, at a
  session's end and at shutdown are collected and reported, never thrown;
  a health check that is not ok rejects the turn when its plugin's policy
  says so.
- **The output boundary.** Nothing a plugin returns reaches the model,
  the person or the log until it keeps to the record limits and the JSON
  limits, each record and each answer as a whole, stamped with its turn,
  its plugin and their labels, which are held where they enter, by the
  turn and at activation, to what a record has room for; a tool's output,
  and what the person is shown of a call, have every credential-named
  value redacted. A breach fails the plugin; nothing is cut to fit.
- **Tools.** A round's calls run in the model's order: consecutive shared
  calls overlap, an exclusive one runs alone, none overtakes another. A
  proposed call is made a call only through its tool's contract, so no
  plugin sees an input the contract refuses. A tool that asks first
  prepares each call only reading, as an ending plugin does: a call it
  refuses is refused without asking, otherwise the person is shown what
  the call would do, through the confirmer the caller supplies, and only
  on their yes does the host apply the prepared effect, under a budget of
  its own. Without a confirmer such a tool is never offered.
- **The trusted frame.** Only a plugin granted `trusted_context: write`
  puts runtime notes and curated sections there, whole and within their
  caps; its other items, and every item of another plugin, ride the
  person's turn.
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
  queued for extraction behind the answer, eight at most waiting and each
  within a minute, and what is queued drains at shutdown until its
  deadline. A backend that fails costs the turn its memory, never the
  turn. A redirect, an unreadable answer, or one shaped for the other
  backend fails the call, a platform's queued write is never called
  stored, an add abandoned at its deadline says it may have landed, and
  no failure carries a credential. Health names what the settings lack,
  says how many memories wait for a new embedder and why re-embedding
  last stopped, and leads with any capture that did not complete.
