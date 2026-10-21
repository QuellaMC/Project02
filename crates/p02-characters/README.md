# p02-characters

Character packages: the descriptor that defines a character, and the
discovery that finds every package a home has. It depends on p02-core and
p02-shared.

- **The descriptor.** A package is a folder holding one
  `project02.character.json`, format `project02.character.v1`: her id and
  display name, a persona of 1 to 16 sections, the version of that
  content, and the plugins she expects, required or recommended, with
  values for their settings. It is read once, as UTF-8 JSON of at most
  64 KiB held to the JSON limits, with every object in it closed and
  lengths counted in characters; a refusal names the first rule it breaks
  and is reported under the code of the part that breaks it. Whether her
  plugins are installed, and whether their values fit, is judged against
  the installed plugins when she starts.
- **Discovery.** The bundled packages are compiled into the daemon, and a
  person adds a character by putting her folder in `<home>/characters/`.
  That folder may be a link; a package folder in it may not, nor a
  descriptor, and a file beside the packages is ignored. A package is
  published when its descriptor reads, its folder is named by her id, and
  no other package has that id or one differing from it only by case,
  since the two would share one data directory. The characters come in id
  order, and every package left unpublished has a diagnostic saying why
  and where.
- **The bundled packages** are read from `src/characters/packages/` when
  the crate builds: the TypeScript daemon reads the same files until it is
  retired, so the two keep one source until then.
