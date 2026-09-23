# characters/packages

Bundled character packages. Every directory here is a self-contained,
**data-only** character definition discovered from disk at startup;
operator-installed characters use the same layout under
`<storeRoot>/characters/`. This document is the authoring contract — start
with `pnpm character:new <id>`, which stamps all of it.

## Layout

```text
src/characters/packages/<id>/
  project02.character.json   descriptor: format, identity, persona, meta
```

That is the whole package. Character packages carry no code — no entry
module, no factory. Behavior (style rewriting, voice synthesis, avatars)
lives in plugins. A character may declare required and recommended
plugin ids plus non-secret plugin defaults. Project02 materializes those
declarations into that character's config overlay.

## Descriptor

`project02.character.json` is the single authored source of the
definition, validated by one shared implementation
(`src/characters/api/package-descriptor.ts`) at discovery. Point your
editor at the schema for autocomplete and inline validation:

```json
{"$schema": "../../../../schemas/project02.character.schema.json"}
```

Fields (`project02.character.v1`):

- `identity.id` — stable id; must equal the package folder name. The
  character-data marker records this id at first activation.
- `identity.displayName` — the speaker name stamped on the character's
  committed messages. Renaming it later affects **new sessions only**:
  existing sessions keep appending under their historical name, because
  committed speaker names are immutable facts.
- `persona.system` — 1–16 ordered sections (each ≤ 4000 chars) rendered
  into the model's system frame. Persona only: the runtime's protocol
  text (tool rules, visible_reply rules) is not overridable.
- `meta.version` — semantic version of the character content; recorded
  in turn evidence so styled-output datasets can be filtered by character
  revision.
- `plugins.required` — optional plugin ids that must be installed and
  enabled or activation stops.
- `plugins.recommended` — optional plugin ids that warn when missing or
  disabled without stopping activation.
- `plugins.config` — optional non-secret field values keyed by plugin id.
  Config-only entries do not imply enablement.

Required and recommended ids materialize as `enabled: true`. Package
config is validated against installed manifests before any write;
unknown plugin ids are retained so a missing package can be installed
later. Host settings, `$env` references, secret fields, and plaintext
secret markers are not allowed in a character package.

The first selection creates
`<home>/character-data/<id>/config.json`, even when the package declares
no plugins. It contains package-authored values only: global values stay
in the home config and continue to be inherited. When `meta.version`
changes, Project02 adds package fields that are still missing. It never
changes or removes existing character values, including an explicit
`enabled: false`. Package authors must bump `meta.version` when plugin
declarations or defaults change.

Plugin manifests declare `config.scope`:

- `global_with_character_overrides` permits home enablement and
  settings, with per-character overrides.
- `character_only` permits enablement and settings only in a character
  package or character config -- secrets included, so such a plugin is
  wholly self-contained, and the home's config view does not list it.

A package still carries no credentials of its own: secret fields are the
operator's, written into the home's or the character's config document.

Rules the loader enforces beyond the schema: the directory name must
equal `identity.id`, and the same id must not be defined in more than one
discovery root (bundled and operator) — duplicates are an activation
error, not a precedence contest.

## Testing a package

1. `pnpm character:new <id>`, then shape the identity and persona.
2. `pnpm check` — discovery picks the package up automatically; the
   schema parity suite validates your descriptor.
3. Select it in a test home. Starting it, or reading its config view
   through the daemon, intentionally creates or upgrades its overlay.
