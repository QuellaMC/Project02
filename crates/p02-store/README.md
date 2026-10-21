# p02-store

Everything the daemon keeps under a home, at storage schema version 15,
and the one gate a session's log is read and written through. It depends
on p02-characters, p02-contracts, p02-core and p02-shared, and reaches the
disk only through the fs seam of p02-shared. Its work is synchronous: the
runtime runs it on a blocking thread, where a lock's wait blocks.

- **The layout.** A home holds its marker `schema.json`, its settings
  `config.json`, the daemon's record, its `.locks`, the character packages
  its person added under `characters/`, a record per conversation at
  `conversations/<id>/conversation.json`, and `character-data/<id>/` per
  character: her marker, her overlay `config.json`, her `.locks`, her
  sessions catalog `sessions.jsonl`, a directory per session
  `sessions/<conversation>.<segment>/` holding its log `raw-events.jsonl`,
  and the record of each conversation's taken lines,
  `taken-lines/<conversation>.json`. Every name is spelled once.
- **Markers.** Nothing below a home or a character's data directory is read
  or written until its marker vouches for it: version 15, what it marks,
  and for character data the character it belongs to and the version of
  her package last merged into her overlay, which is written after the
  overlay. A marker of any other version is refused, saying which, and is
  never converted; a data directory marked for another character is
  refused, naming her. A directory with no marker is made one only while
  it holds nothing but control state, never history or anything foreign,
  and nothing at all is written for one that is refused, not even the
  home's marker. Control entries must be real files and directories: a
  link would carry their state outside the directory its marker vouches
  for.
- **Files.** A file is replaced whole, under the lock that guards it, so a
  temporary found beside it is a dead writer's and goes before the write.
  Logs are appended to, never rewritten and never flushed: a line counts
  once its newline is on disk, text after the last newline is an append a
  crash cut short and is no line, and the next append cuts it. Files are
  made owner-only.
- **Locks.** The operating system's advisory lock on
  `<locks root>/<sha256 of the key>.lock`, which the kernel releases when
  its holder dies, so no lock is ever stale and none is reclaimed. Lock
  files stay where they are; beside a held one, `<…>.owner.json` says who
  holds it (the key, a nonce, the process, since when), for a
  person, and for a waiter to see the lock change hands; whether a lock is
  held is never read from it. A lease that lasts as long as a daemon, a
  conversation or a session's writer is refused at once (`daemon`,
  `conversation-writer:<id>`, `session-writer:<id>`); a short guarded write
  is waited for while it changes hands, and given up after ten seconds
  without a change (`conversations-catalog`, `storage-schema`,
  `session-catalog`). A lock that cannot be had is reported
  `storage_busy`, a session's writer `session_busy`. Locks taken together
  are taken in the order of their files and released in reverse. A holder
  passes its lease along rather than taking it again.
- **Records.** A session's log holds one record per line: the event it
  belongs to, its kind, and exactly the fields its kind has, in the order
  they are written. A model round records what it was shown and what it
  wrote, every credential-named value in that redacted too, and its verdict
  must be what the decision parser reads that output as, or the provider's
  failure when nothing came. A tool call's input and result are kept as the
  model is shown them again, and an exchange as its provider's, so no
  credential-named value reaches the log; a call no plugin offers comes back
  as the runtime's refusal of it, never an answer. A committed line that is
  no record is damage and fails the read, never a shorter history; a read
  whose file changes beneath it is tried once more, then refused as raced.
- **The gate.** Every record enters through one gate, replayed or appended
  now, and is checked whole before anything of it is taken in. A
  continuation is a session's first record, and names it. A turn starts
  once, with its event received, under an identity of its own; while it is
  open no other turn's record comes, and once it has ended only the plugins'
  work after its commit does; a new turn closes one a crash left open. It
  commits the line its event was taken as, first and once and before any
  round, and its rounds are given that one text; a line its client submitted
  under an id the session already took is not taken again. Its rounds are
  numbered as they happen, each shown this session and its character, and
  every other record that names a round names one the turn ran. A reply
  comes only from an accepted round, in the order that round said them, and
  a call only from an accepted round, in the order it asked for them; a
  round comes only once the turn took up all the round before it gave, every
  reply committed and every call started and finished. Every message joins
  the session through the core session's gate. A call starts once and
  finishes once, as itself, in its turn. The record that ends a turn names
  exactly what it committed and what finished. A completed turn that ran the
  model ends on an accepted round that asked for no tool, having committed
  every reply that round said, and anchors the last; a rejection that judges
  a round repeats that round's refusal or is the runtime's own, and one that
  judges none comes where its reason stops a turn: a line refused before it
  is committed, a plugin's refusal before any round.
- **History.** The one projection of a log into the turns its model is
  shown: a turn once it committed the person's line, a round of tool calls
  once a call it started came back, a continued session's carried turns
  first, with its summary. A live writer and a reopened session run it over
  the same records.
- **Catalogs.** A character's sessions catalog lists each session once,
  rewritten whole under its lock, beside a directory per session; the two
  agree, so a directory holding evidence the catalog does not list is a
  session lost and never read past, while a directory an interrupted start
  or discard left, empty or holding only a torn line, is no session. A
  catalog row cut by a crash is no row; a damaged row fails a listing but
  not a read of another session. The catalog and the directories are read as
  they were at one moment, as a log is, so a session made or discarded while
  they are read is never taken for damage. A conversation's first segment is
  made once, and each next one only from the newest; only the newest, when
  it never took a record, is discarded, by its writer alone, so nothing is
  appended while it goes and the segments left run unbroken. Sessions and
  conversations list oldest first, in code-point order. A conversation is
  made once per set of participants, as `conv_` and a random UUID, and a
  directory without its record is a make a crash interrupted. A
  conversation's taken lines are read leniently and written whole by the
  holder of the conversation; the segments stay their truth.
