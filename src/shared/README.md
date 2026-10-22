# shared

What more than one client module executes and none of them owns: the
sentence a failed fetch is reported as, which the reference client and the
Telegram connector's Bot API both say. This module owns cross-cutting
primitives with at least two consumer modules, plus the plumbing those
primitives are built on — additions require a reviewed entry in
`consumers.json` naming exactly the modules that import the file (arch
rule 6). It imports nothing from other src modules (`shared-is-leaf`).
