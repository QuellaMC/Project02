# shared

Generic, domain-free utilities: canonical JSON, bounded JSON snapshots,
credential redaction, Node error helpers. This module owns cross-cutting
primitives with at least two consumer modules — additions require a
reviewed entry in `consumers.json` (arch rule 6). It imports nothing
from other src modules (`shared-is-leaf`).
