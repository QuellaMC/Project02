# p02-store

Everything the daemon keeps under a home, at storage schema version 15,
and the storage a character's plugins reach. It reaches the disk only
through the fs seam of p02-shared and opens every database through
rusqlite. Its work is synchronous: the runtime runs it on a blocking
thread.

- **The layout.** A home holds its marker `schema.json`, its settings
  `config.json`, the daemon's record `daemon.json`, its `.locks`, the
  character packages in `characters/`, one record per conversation at
  `conversations/<id>/conversation.json`, and per character
  `character-data/<id>/`: her marker, her overlay `config.json`, her
  `.locks`, her sessions catalog `sessions.jsonl`, each session's log at
  `sessions/<conversation>.<segment>/raw-events.jsonl`, the lines each
  conversation took at `taken-lines/<conversation>.json`, and each
  plugin's files and `.sqlite` databases in `plugin-data/<plugin>/`.
- **Keeping data safe.** Nothing below a home or a character's data is
  read or written until its marker vouches for it; a data directory marked
  for another character is refused, naming her, and a control entry that
  is a link is refused, so no state lives outside its directory. Logs are
  appended, never rewritten: a line counts once its newline is on disk,
  and what a crash left after the last one is cut by the next append.
  Every other file is replaced whole, owner-only, under its lock. Locks
  are the kernel's, released when their holder dies: one daemon per home,
  one holder per conversation, one writer per session, one lessee per
  plugin's files, and short waits for catalogs and settings. Every
  credential-named value a round wrote or a call carried is redacted
  before it is recorded, and again as it is read. A line a client
  submitted under an id its conversation already took is not run again.
  A plugin's writes are journaled, so the next lease finishes or takes
  back one a crash cut short. Its databases are views it builds again:
  one at another version, or one SQLite finds damaged, is made anew. This
  crate alone opens a database, as `clippy.toml` holds.
- **Reading forgivingly.** A session's log is replayed, not policed: each
  record joins the turn its event started, and the replay keeps the
  session's messages, the lines its client submitted, and the history its
  model is shown. A committed line that is no record, a record whose turn
  never started, a continuation after the first record, and a message the
  session cannot take are skipped and named, and an append the replay
  would skip is refused instead. A catalog row that is no session row, or
  lists a session again, is skipped the same way, and the next rewrite
  leaves it out. What was skipped is said: `inspect --session` shows its
  `skippedLines`, `serve` warns once as a thread opens past any, and
  plugins reading history count it as damage. A round keeps the verdict it
  recorded, and a field a record does not know is ignored.
- **What stays refused** is what reading past would lose without saying:
  a catalog and the session directories beside it that disagree, the
  missing log of a segment another continues, a damaged file of a
  plugin's, and a marker written by a newer Project02. A marker of an
  older version is read as it is.
