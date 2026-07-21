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
lives in plugins; a character package only selects and parameterizes it
in later contract revisions.

## Descriptor

`project02.character.json` is the single authored source of the
definition, validated by one shared implementation
(`src/characters/api/package-descriptor.ts`) at discovery. Point your
editor at the schema for autocomplete and inline validation:

```json
{"$schema": "../../../../schemas/project02.character.schema.json"}
```

Fields (`project02.character.v1`):

- `identity.id` — stable id; must equal the package folder name. A store
  binds permanently to this id at first activation.
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

Rules the loader enforces beyond the schema: the directory name must
equal `identity.id`, and the same id must not be defined in more than one
discovery root (bundled and operator) — duplicates are an activation
error, not a precedence contest.

## Testing a package

1. `pnpm character:new <id>`, then shape the identity and persona.
2. `pnpm check` — discovery picks the package up automatically; the
   schema parity suite validates your descriptor.
3. Select it for a fresh store (a store is bound to one character
   permanently once activated).
