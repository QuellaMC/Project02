# shared

Generic, domain-free utilities: canonical JSON, bounded JSON snapshots,
credential redaction, Node error helpers, the test of whether a module is
the process's entry and the stop a terminal asks for, which the CLIs and
the Telegram connector's entry share — and the daemon record's shape,
decode and reader, because the daemon that writes `<home>/daemon.json` and
the clients that read it to find the daemon share no other module. This
module owns cross-cutting primitives with at least two consumer modules,
plus the plumbing those primitives are built on — additions require a
reviewed entry in `consumers.json` naming exactly the modules that import
the file (arch rule 6). It imports nothing from other src modules
(`shared-is-leaf`).
