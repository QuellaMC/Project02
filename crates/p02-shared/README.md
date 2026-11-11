# p02-shared

Domain-free primitives every other crate uses; it depends on none of them.

- **Files.** The fs seam is the one place the disk is reached
  (`clippy.toml` refuses `std::fs` elsewhere): files read whole and
  replaced whole, owner-only, under their lock; lines appended so a crash
  tears none; a file emptied in place; a file removed, which succeeds when
  nothing is there; locks the system lets go when their holder dies; and
  canonical paths.
- **JSON**: canonical JSON, fingerprints, and the limits a value from
  elsewhere is held to.
- The **daemon record**, `daemon.json`, and its token; HTTP clients and
  base URLs behind the `http` feature; identifiers; the server-sent event
  splitter; error sentences, what broke and then why; and `vocabulary!`,
  which spells each value of a closed vocabulary once.
