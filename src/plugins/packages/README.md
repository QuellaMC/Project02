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

`project02.plugin.json` is the single authored source of the manifest. It is
validated twice with one shared implementation
(`src/plugins/api/package-descriptor.ts`): at discovery by the package
loader, and by your own module when it self-reads the manifest. Point your
editor at the schema for autocomplete and inline validation:

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

## The factory contract

`createProject02Plugin(input: RuntimePluginFactoryInput)` receives
`{pluginId, manifest, storeRoot, resolvedConfig, redactedConfig}` and
returns a `RuntimePlugin`. It runs when the configured host is constructed
at session start. The returned plugin's manifest must equal the discovered
one — build it from `input.manifest`, never a second copy.

## Config fields

Declared in `manifest.config.fields`; the same declarations drive runtime
resolution, the operator console, and the model-facing
`runtime.plugin.config` tools.

- `valueType` + `allowedValues` are enforced on every write, with the
  expectation named in rejection feedback.
- `secret: true` fields accept only `{"$env": "VAR"}` references in config;
  reads always show them redacted. Secret fields cannot be `agentMutable`.
- `agentMutable: true` lets the model propose updates through
  `runtime.plugin.config.update`; each one still requires explicit user
  approval, and enabling/disabling the plugin itself is never
  agent-mutable.
- `reloadRequired` states whether a committed change needs a runtime
  reload before it takes effect.

## Activation

`activation.defaultEnabled: true` activates the package on every store with
no configuration; use it only for product-essential plugins. Demo and
optional plugins ship `false` and are enabled per store:
`pnpm runtime-config ui` → Plugins → your plugin → Enable, or
`plugins.<id>.enabled: true` in the store's `config.json`.

## Testing a package

1. `pnpm plugin:new <id>`, then shape the manifest and behavior.
2. `pnpm check` — discovery picks the package up automatically; the schema
   parity suite validates your descriptor.
3. Enable it (above), then `pnpm chat --store <path>` and exercise it; the
   `demo-config` package is a worked example of agent-adjustable config.
