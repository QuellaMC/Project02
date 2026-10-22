# p02-config

A home's settings: the documents they are written in, what each value may
be and where it may be set, the values in effect for the home and for each
character, and the one way they change. It depends on p02-characters,
p02-contracts, p02-core, p02-shared and p02-store, reaches its documents
through the fs seam under the store's locks, and does its work
synchronously, as the store does. Its views, its change and the change's
outcome are the wire's own types.

- **The documents.** A home's `config.json` and each character's overlay,
  `character-data/<id>/config.json`, are one format,
  `project02.config.v2`: the host's fields under `project02`, and a stanza
  `{enabled?, config?}` per section, by id, under `plugins` or
  `connectors`. A document is read up to 256 KiB and held to the JSON
  limits. A file that is absent is an empty document, its defaults in
  effect; one that cannot be read, is no JSON object or is past a limit is
  no document, so nothing is taken from it and nothing is written over it.
  Another version, an unknown key at the top or under `project02`, a host
  value its field refuses, or a namespace that is no object leaves the
  document unusable: every view and every change of a target that reads
  it is refused, saying why, until a person repairs it. An unknown key in
  a section's stanza, a stanza or config that is no object, or a value its
  field refuses is an error of that section alone. A finding about what a
  document holds names that document: one in her overlay names her. The
  store admits the home and her data directory before either is read, so a
  linked document is refused as any linked control file is. A document is
  written indented by two spaces with a trailing newline, owner-only and
  whole, its keys in the order they were written.
- **The host's fields** are declared once, as a plugin's are, in the order
  the settings page shows them: the name a person goes by (`You` unless
  set; trimmed, one line of at most 128 characters), the model provider
  (`nvidia`, and none until a person chooses it), its key, a secret, its
  model and its server (an `http` or `https` address with no credentials,
  query or fragment), the context window (a positive whole number of
  tokens, 32768 unless set), the memory provider, and whether a character
  is switched on (she is unless set). A value meets its field's
  declaration and its rule, and a blank text is never one, since unsetting
  is its own change. Each is set at the home, and over it by a character.
- **Sections and scopes.** A plugin's section is the one its manifest
  declares, held in the order the build lists its plugins, the order her
  plugins run and are reported in. A connector's is built in, Telegram's
  alone today: her bot's token, a secret and hers alone; the home's
  management bot's token, a secret and the home's alone; whether to
  mirror, on unless set; and the accounts paired with the home, its own
  and none unless set, which an approved pairing writes into. A section's
  scope, or a field's own, which may only narrow it, says which document
  may set it: the home's for every character, a character's alone, or the
  home's alone. A value a document holds outside its scope is a warning at
  its path and is never in effect, and a change outside its scope is
  refused, in both directions. A plugin and a connector may share an id:
  their sections never meet. A stanza naming a section this build lacks is
  a warning for that id, unless the nearest document that switches it
  switches it off.
- **Resolution.** For the home a value is the home's, else its declared
  default; for a character it is hers, else the home's, else the default,
  each from a document its scope lets her read, with where it came from. A
  value its field refuses stays in effect, refused, rather than reaching
  past it, and a section's switch is a value as any other: one that is no
  boolean blocks its section. A section that is off, by a document or by
  its default, or a memory provider the settings do not choose, never
  runs, so its settings are not judged. What a character's settings make
  of her plugins is judged with them: the memory provider they choose
  must be a memory plugin she runs, and when they choose none she runs
  one at most; a plugin her package requires that she does not run is an
  error, one it recommends a warning; and an error about anything she
  runs, a connector's aside, stops her: none of her plugins but the
  host's own runs, and her start is refused saying why. What a character
  runs on is one value: the host's values, and each plugin that runs by
  her settings with its values in effect, a default among them, secrets
  in the clear, for the plugin host to resolve against its manifest. Two
  equal ones run the same character, so she is rebuilt exactly when hers
  differ from those she was built from: a home value she overrides, a
  switched-off plugin's settings or a connector's rebuild no one, and a
  re-keyed secret does.
- **Fingerprints.** A target's is `sha256:` over the canonical JSON of its
  documents as its settings are read from them, her package's settings
  merged in while they are pending, and for a character whose they are; a
  section's, over its stanzas in them. Her start writes only what was
  already read, so it leaves her fingerprint as it was. A secret, and a
  value under a name shaped like a credential's, counts by its presence
  and never its value.
- **The one transaction.** A change sets or unsets a host field, switches
  a section or leaves it to the document beneath, or sets or unsets a
  section's field, in the target's own document alone. Its own rules are
  met first: a field that exists, a target its scope lets set it, a value
  it takes. Then the locks of every document the target reads are taken,
  the home's and for a character her overlay's, in one order, waiting as
  long as the caller says while a lock changes hands; the documents are
  read again; the fingerprint presented must be the target's, or for a
  change to one section that section's; and the document made must read
  back as its file would be read, be valid and leave the section it
  changes without an error over the documents beside it. Only then is
  anything written, and nothing when the target's files already hold it.
  Her first change makes her data directory, as her first start does, and
  a refused change makes none. Her package's settings her view merges in
  are settled first, as her start settles them, and the change is written
  last, so a failure between the two leaves her settings as shown, under
  the same fingerprint. A new home is given a document naming its version
  alone, and a file already there stays as it is. The answer is `applied`
  with the new fingerprint, `refused` as a `conflict`, `invalid` or
  `unknown_character`, or `failed`, with a sentence that never repeats a
  value.
- **Her package's settings.** At her first start the plugins of this
  build her package requires or recommends are switched on in her
  overlay, above a home that switches them off, beside the values it
  gives them, in a document holding only that; a section for a plugin
  this build lacks configures nothing and is not copied. At the first
  start after her package changes version only what her overlay lacks is
  filled in, and nothing she set changes. A package carrying a
  credential, or a value its field refuses or a character may not set, is
  refused before anything is written for her. The version merged is
  recorded after her overlay, so a crash between the two merges again
  what is still missing. Until she starts, her settings are shown as her
  start will have merged them, and a change to them is made in those
  settings, merging her package's in as her start would, so her start
  finds nothing left to merge.
- **The views.** A settings screen's view of the home or of a character:
  every host field, and every section and every field of it the target
  may set, the plugins' sections by id and then the connectors', as a
  person looks one up, each with what the target's own document holds and
  what is in effect from where, the diagnostics, and the fingerprints, a
  secret only as `[redacted]`. A connector's read: an entry for the home
  and one per character switched on, each by its own switch, with the
  values in effect for it, secrets in the clear, since a token is what a
  connector exists to use. And the part of `inspect`'s report that is the
  settings': where they come from, the host's values, the findings about
  what she runs, and each plugin and connector with its switch, its
  activation and why, its findings and its values in effect, a plugin
  with the access its manifest asks for and the access running it grants,
  read from its manifest alone. A character not installed, or settings
  that cannot be resolved, is refused with the reason. Formatted for a
  log, a resolution, a change and a connector's read name what they hold
  and never show a value.
