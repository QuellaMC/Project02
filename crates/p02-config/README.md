# p02-config

A home's settings: the documents they are written in, what each field may
hold and where, the values in effect for the home and for each character,
and the one way they change. It reaches its documents through the fs seam,
under the store's locks, and its views and changes are p02-wire's types.

- **Documents.** The home's `config.json` and each character's overlay,
  `character-data/<id>/config.json`, are one format,
  `project02.config.v2`: the host's fields under `project02`, and a stanza
  `{enabled?, config?}` per section under `plugins` or `connectors`. An
  absent file is an empty document. One that cannot be read, or is no
  JSON object, refuses every view and change that reads it and is never
  written over; in any other, what the settings do not know is a warning
  and is not used.
- **Fields.** Every field is declared as a plugin's manifest declares one.
  The host's are declared in `src/host.rs`, each once, in the order the
  settings page shows them, with the rule its values meet and the typed
  value a character runs on; a plugin's come from its manifest, and a
  connector's from this build. A scope says which document may set a
  value: the home's for every character, a character's alone, or the
  home's alone. A value outside its scope is a warning and never in
  effect. A view hands a page what a declaration says of drawing it: a
  field's words and the values it offers first, a plugin's row, and a
  section's cards with the rows of the fields its target may set.
- **Services.** Each service a character can think with is described once
  beside the host's fields: its name, what it is and where a key for it
  comes from, its own fields with the one that names its model, and what
  connects it: its key, for NVIDIA a server of the person's own too, and
  for the ChatGPT plan, which takes no key, the home's sign-in. A view
  lists every service and whether it is connected for its target, the
  plan's with the account it is signed in as, so a page lists them without
  deciding anything itself. The sign-in is no setting: the view's caller
  says it, as it judges the AI model, and the plan's model then offers
  the models that plan offers, a free plan's fewer, the first in effect
  until one is set. `connection` says a service as a connection an app on
  her phone signs in with, from the same lists: its name, the models it
  offers in their words, and the one it asks until another is chosen, the
  best its plan offers for the ChatGPT plan and the least costly for the
  OpenAI API; NVIDIA, whose models no list holds, is none.
- **Reading.** For the home a value is the home's, else its default; for
  a character it is hers, else the home's, else the default. A value its
  field refuses stays in effect, refused, so no farther value stands in
  for what its author meant; it stops only what it configures, its
  section, or for a host field the characters that read it. What a
  character runs on is one value, so she is rebuilt exactly when it
  changes.
- **Setup.** Each plugin's section is judged once, switched on or off, by
  the check its plugin is listed with: whether its values in effect are
  enough to build it, or what to fill in. One switched on before they are
  does not run, and a character's findings say she runs without it. A
  view carries each section's judgement, and the judgement of the AI model
  its target's host values give, which its caller makes.
- **Changing.** A change sets or unsets one host field, switch or section
  field in the target's own document, bound to the fingerprint its author
  read. Its own rules are met first; then, holding the locks of every
  document the target reads, the documents are read again, the
  fingerprint compared, and the document written whole and owner-only.
  The answer is `applied`, `refused` or `failed`, in a sentence that never
  repeats a value.
- **Her package's settings.** At her first start, and the first after her
  package's version changes, the plugins her package expects are switched
  on in her overlay and its values filled in where she has none, never a
  credential, a server or a path. Until then her view shows them as her
  start will merge them.
- **Secrets.** Every reader but a connector sees a secret as
  `[redacted]`, and a fingerprint counts its presence, never its value.
