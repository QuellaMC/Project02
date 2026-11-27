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
  tint, whom it is from, the world itself, the person or a character, and
  when it came, and a thing the person left with their note, when they
  wrote one, and the characters who have seen it; and `journal.jsonl`, what
  happened, a line each: when, who, what, and the place and the thing it
  was about, each by id and by the name it had then, with the person's
  form of that name it had then, and the language of the person's words it
  keeps. It is made from the definition its caller hands it the first time
  it is read, the places in their order and their things the world's own,
  and from then on stands by itself: a later definition changes nothing of
  it. A character with no place there yet is at its first place from the
  moment her world is first read for her, she told of it or the person
  looking at it.
- **What she does there.** She goes to a place by its id or its name, in
  any case; a name that is no place of the world's is somewhere new, which
  it then holds, with an id it makes of the name and the page's plainest
  icon and tint. She makes a thing where she is, of a kind, `gift`, `food`,
  `drink`, `flower`, `book`, `clothing`, `letter` or `other`, each standing
  for an icon and a tint and named for a person by its word, `other` the
  plainest; and she uses a thing that is where she is, named in any case,
  which changes nothing of it. Each is a line of the journal. A name is one
  line of 1 to 128 characters; a world holds 64 places and a place 64
  things, and one more is refused in a sentence, as is a thing that is not
  there, with what is.
- **The person's hand.** The person leaves a thing in a place by the
  place's id: a name by the same rule, one of the kinds, and a note when
  they write one, kept with its line endings `\n` and its ends trimmed,
  not blank and 280 characters at most. They remove a thing by its id,
  whoever it is from. Each is a line of the journal, and a place that is
  not there, a kind that is none, a name or a note that breaks its rule, a
  full place and a thing that is not there are refused in a sentence they
  read.
- **Her language.** Her world's words are hers. What the person leaves
  may be put into her language before it is left: her words for its name
  and its note take their place, each by the rule of a name or a note,
  and what the person wrote is kept beside each that is not what they
  wrote. Beside each name the person did not write, the world's, a
  place's and a thing's from the world itself or a character's hand, the
  world keeps the person's words for it once they are made, by the name
  each is for, and which language the person's setting said when they
  were made, none for Automatic. They are given while the person reads
  that language, its capitals aside, and on Automatic whatever was kept;
  once the person chooses another, every one is made again. Her calls,
  and what she is told, never read them.
- **What is new to her.** A thing the person left is new to a character
  until she is told what is where it is: told where she is, or arriving
  there. What she is told says each thing as it stood, so a new one says
  so once, and from then she has seen it. What the world itself brought
  and what she made never are new.
- **The view** is everything a person sees of a world, read in one lease:
  its name, its places in their order, each with its things in the order
  they came, where each character living there is and since when, and the
  newest 200 lines of the journal, newest first; with the person's words
  kept for its names in the language they read, and the names that have
  none, each once, in its order.
- **Reading.** Documents are written whole and the journal only appended
  to. A place, a thing, a line of the journal or where a character is that
  does not read is passed over and said, and the rest of the world works; a
  world whose own file does not read is made again from its definition,
  each place keeping the things it keeps.
