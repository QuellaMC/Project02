# packages

Bundled runtime plugin packages. Every directory here is a self-contained
plugin discovered from disk at startup; operator-installed packages use the
same layout under `<storeRoot>/plugins/`. This document is the authoring
contract — start with `pnpm plugin:new <id>`, which stamps all of it.

## Layout

```text
src/plugins/packages/<id>/
  project02.plugin.json   descriptor: format, entry, and the full manifest
  package.json            exactly {"type": "module"}
  index.ts                entry module (see the single-export rule)
  plugin.ts               behavior
```

## Descriptor

`project02.plugin.json` is the single authored source of the manifest. The
package loader captures and validates it during discovery, then passes that
same manifest to the factory. The factory must use `input.manifest`; it must
not read or validate a second manifest copy. Point your editor at the schema
for autocomplete and inline validation:

```json
{"$schema": "../../../../schemas/project02.plugin.schema.json"}
```

Rules the loader enforces beyond the schema: the directory name must equal
`manifest.id`, and `entry` must stay inside the package and use `.ts`,
`.js`, or `.mjs`.

## The single-export entry rule

The entry module must export **exactly one** named export,
`createProject02Plugin`. Anything else — an extra constant, a re-exported
type — fails the load with `must export exactly one named
createProject02Plugin factory`. Put every other export in `plugin.ts` and
keep `index.ts` to one line:

```ts
export {createProject02Plugin} from './plugin.ts';
```

Operator packages are captured as one immutable, self-contained executable
artifact. Executable modules use `.ts`, `.js`, or `.mjs`; relative imports
must stay inside the package, and Node built-ins remain available. Changing
any source file publishes new behavior only after a fresh discovery/host
construction, never inside an already discovered host.

## The factory contract

`createProject02Plugin(input: RuntimePluginFactoryInput)` receives
`{pluginId, manifest, storeRoot, characterId, userDisplayName,
resolvedConfig, redactedConfig}` and returns a `RuntimePlugin`. It runs when the configured
host is constructed at session start. The returned plugin's manifest must
equal the discovered one — build it from `input.manifest`, never a second
copy.

`characterId` is the character this host serves, and it is the identity to
namespace external state by. It is absent when no character is active, so
fall back to a constant of your own; never derive an identity from
`storeRoot`, whose layout is the runtime's to change.

`userDisplayName` is what the user is called in this store, for a package
that records or shows who spoke. It is absent until the store sets one, so
carry your own fallback rather than a second copy of the setting.

Bundled packages import host helpers directly, an installed package cannot:
its captured artifact resolves only its own files, so a memory provider
shipped by an operator builds its `RuntimePlugin` from `createRuntimePlugin`
rather than reusing the bundled memory-provider adapter. Reusing it from an
installed package needs a host-injected seam that does not exist yet.

## Tool input contracts

A tool declares `inputContract` as a JSON Schema object, and that one
declaration is what the provider is shown, what a proposed call is
validated against, and what is persisted with the turn.

```ts
inputContract: {
  type: 'object',
  properties: {
    text: {type: 'string', description: 'Memory text.'},
    tags: {type: 'array', items: {type: 'string'}},
  },
  required: ['text'],
  additionalProperties: false,
}
```

The root must declare `type: 'object'` — a tool takes named arguments,
and that root is what a provider renders. Everything else is ordinary
JSON Schema with JSON Schema's meaning: `pattern`, `minLength`, `oneOf`,
and the rest are welcome, and the same Ajv that admits a contract at
manifest validation enforces it against every proposed input. A schema
Ajv cannot compile — an unknown keyword, a duplicate `required` name —
is rejected at manifest validation with the compile reason, rather than
silently ignored on the wire.

A contract is one self-contained document. Recursion and reuse spell
themselves with `$defs` and `#/`-relative `$ref`s, which compile and
enforce as written; a registry identity — an absolute `$id` referred
back to by URI — has nothing to resolve against in a runtime that
registers no schemas, and fails at the gate with the resolution error.

The one deliberate keyword exclusion is `format`: no format registry
ships, so a `format` constraint would be a promise nothing enforces, and
the gate rejects it the same way — loudly, with the compile reason.
Express the constraint as a `pattern`, which is enforced.

`additionalProperties: false` at every level is also what qualifies a
tool for provider strict mode, so prefer it unless a tool genuinely takes
open-ended input.

## Config fields

Declared in `manifest.config.fields`; the same declarations drive runtime
resolution, the operator console, and the model-facing
`runtime.plugin.config` tools.

- `config.scope: "global_with_character_overrides"` allows global
  settings with per-character overrides; `"character_only"` keeps the
  plugin's settings wholly per character (its `activation.defaultEnabled`
  must be `false`).
- `valueType` + `allowedValues` are enforced on every write, with the
  expectation named in rejection feedback.
- `secret: true` fields hold credentials. The preferred home is an env
  file — the manifest's `envVar` or an authored `{"$env": "VAR"}` ref —
  and each character's own env file (set with `runtime-config --character
<id> secret set`) merges over the home `.env`, so two characters can
  hold different accounts for one plugin. A plain string typed into
  config also works; the env wins whenever it holds the variable. Reads
  always show secret fields redacted, and they cannot be `agentMutable`.
- `agentMutable: true` lets the model propose updates through
  `runtime.plugin.config.update` (each still requires explicit user
  approval). Every other field is out of the model's reach — that is what
  keeps the agent away from credentials and from the settings that decide
  where they go.
- `reloadRequired` states whether a committed change needs a runtime
  reload before it takes effect.

## Model input

A `beforeRoleModelCall` hook returns typed `contextItems`; the host, not
the plugin, decides where each one renders. Every item needs
`model_input: write`.

- `kind: "runtime_note"` from a bundled package that holds
  `trusted_context: write` renders in the trusted per-turn frame (system
  role) as a bullet under "Right now"; capped at 4 notes and 2048 chars
  per plugin, never truncated — over the cap the plugin degrades or
  rejects per its `failureBehavior`. From any other plugin the same item
  is untrusted.
- `kind: "memory"` renders inside a `<recalled_memory>` fence appended to
  the current user message.
- Every other kind renders inside an `<untrusted_plugin_context>` fence
  on the same message as `## <pluginId> · <id>` plus text. Only `text`
  reaches the model; `sourceReferences`, `confidence`, and
  `redactionLabels` are evidence.
- Neither fence has a token budget: items are shown whole, in the order
  plugins returned them. The bounds are structural — an item's text
  stays under 16 KB and a hook returns at most 64 records — so keep items
  short because the model reads every one, not because a cap will trim
  them.
- `curatedContext` sections (also gated by `trusted_context`) render in
  the curated frame between the persona and the runtime notes.

Write item text and tool descriptions to the character in the second
person ("your notes", "how you are right now", "they") — the runtime
speaks that way everywhere and names the person only when configured.

## Activation

`activation.defaultEnabled: true` activates the package on every store with
no configuration; use it only for product-essential
`global_with_character_overrides` plugins.

A character package may request enablement (`required`/`recommended`) and
ship config values, so its character works right after install with no
setup. Materialization only fills what is missing: a field the operator
has set keeps the operator's value, on first install and on every package
update. Character-only, demo, and
optional plugins ship `false` and are enabled per store:
`pnpm runtime-config ui` → Plugins → your plugin → Enable. A
character-only plugin is enabled with `--character <id>` or by that
character's package; it is rejected from the home `config.json`.

## Testing a package

1. `pnpm plugin:new <id>`, then shape the manifest and behavior.
2. `pnpm check` — discovery picks the package up automatically; the schema
   parity suite validates your descriptor.
3. Enable it (above), then `pnpm chat --store <path>` and exercise it; the
   `demo-config` package is a worked example of agent-adjustable config.
