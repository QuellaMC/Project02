# p02-characters

Character packages: the descriptor that defines a character, and the
discovery that finds every package a home has. It depends on p02-core and
p02-shared.

- **The descriptor.** A package is a folder holding one
  `project02.character.json`, format `project02.character.v1`: her id and
  display name, a persona of one section or more, the version of that
  content, and the plugins she expects, required or recommended, each
  listed once, with values for their settings. It is read once, as UTF-8
  JSON of at most 64 KiB, and what it holds that a descriptor does not
  know is not read; a refusal names the first rule it breaks. Whether her
  plugins are installed, and whether their values fit, is judged against
  the installed plugins when she starts.
- **Discovery.** The bundled packages are compiled into the daemon, and a
  person adds a character by putting her folder in `<home>/characters/`.
  That folder may be a link; a package folder in it may not, nor a
  descriptor, so nothing outside it is read into a persona, and a file
  beside the packages is ignored. A package is published when its
  descriptor reads, its folder is named by her id, and no package before
  it, the bundled ones and then the home's in name order, has that id or
  one differing from it only by case, since the two would share one data
  directory. The characters come in id order, and every package left
  unpublished has a diagnostic saying why and where. A character asked
  for by id is one discovery published, or a refusal saying why: no
  package is meant to be her, a package meant to be her was not
  published, or the folder that might hold her could not be read.
- **The bundled packages** are the folders of `packages/`, each read when
  the crate builds.
