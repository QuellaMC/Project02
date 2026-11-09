# p02-store

A home's state at storage schema version 15, plugins' files and databases
included. It reaches the disk only through p02-shared's fs seam, and no
other crate opens a database.

- **Layout.** `schema.json`, `config.json`, `daemon.json`, `.locks`,
  `conversations/<id>/conversation.json`, and per character
  `character-data/<id>/`: her marker, overlay and `.locks`, `inbox.jsonl`,
  `sessions.jsonl`, `sessions/<conversation>.<n>/raw-events.jsonl`,
  `taken-lines/` and `plugin-data/<plugin>/`.
- **Safety.** Logs are only appended to, and the next append cuts a line a
  crash tore; other files are replaced whole, owner-only, under their
  lock. Her inbox, the lines no turn of hers took yet, is appended to and
  rewritten under its own lock, and emptied in place once the last line
  leaves, which takes no new file, so it drains on a full disk. Kernel
  locks keep one daemon per home and one writer per conversation, session
  or plugin. A newer build's marker and a link where state lives are
  refused, credentials redacted, and a line already taken not run again.
- **Reading.** A log line or catalog row that cannot be read is skipped
  and said, and a plugin database damaged or of another version is
  rebuilt. What reading past would lose is refused: a catalog its
  directories contradict, a continued segment's missing log, a plugin's
  damaged document.
