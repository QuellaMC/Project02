# p02-world

Her world: what a character's package says of the world she comes from,
the living world the home keeps of it, and everything that changes it. It
depends on p02-contracts, p02-core and p02-shared. It reads no file itself:
a call that touches a world's files is handed them under their lease, and
its callers run it on the blocking pool.

- **What a package says of a world**, a descriptor's `world`: its `id`, an
  identifier in lowercase, since it names the world's folder, its `name`,
  one line, and its `places`, 1 to 32, the first where a character who
  comes to live there is at first. A place has an `id` in lowercase, each
  once, a `name`, and optionally an `icon` and a `tint`, names of the
  page's own set, not blank and judged no further, and its `things`, 32 at
  most, each a `name` with an optional `icon` and `tint`. What it holds that
  a world does not know is not read; a refusal names the first rule it
  breaks, and says it in plain words for a person who chose the file.
- **The living world** is `world.json`, its name, its places and where each
  character living there is and since when; `places/<place id>.json`, the
  things in a place, each with the id the world gave it, its name, icon and
  tint, whom it is from, the world itself or a character, and when it came;
  and `journal.jsonl`, what happened, a line each: when, who, what, and the
  place and the thing it was about, each by id and by the name it had then.
  It is made from the definition its caller hands it the first time it is
  read, the places in their order and their things the world's own, and
  from then on stands by itself: a later definition changes nothing of it.
  A character with no place there yet is at its first place from the moment
  she is first told of it.
- **What she does there.** She goes to a place by its id or its name, in
  any case; a name that is no place of the world's is somewhere new, which
  it then holds, with an id it makes of the name and the page's plainest
  icon and tint. She makes a thing where she is, of a kind, `gift`, `food`,
  `drink`, `flower`, `book`, `clothing`, `letter` or `other`, each standing
  for an icon and a tint, `other` the plainest; and she uses a thing that is
  where she is, named in any case, which changes nothing of it. Each is a
  line of the journal. A name is one line of 1 to 128 characters; a world
  holds 64 places and a place 64 things, and one more is refused in a
  sentence, as is a thing that is not there, with what is.
- **Reading.** Documents are written whole and the journal only appended
  to. A place, a thing or where a character is that does not read is
  passed over and said, and the rest of the world works; a world whose own
  file does not read is made again from its definition, each place keeping
  the things it keeps.
