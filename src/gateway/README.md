# gateway

The daemon composition layer: everything one character _is_ at runtime,
held behind one message-shaped boundary, and the one façade clients hold.

`api/` carries the contract — the `Gateway` façade, the per-character
`CharacterRuntime` interface, and the message/event/outcome shapes that
serialize over HTTP when the transport lands. The implementation composes
existing seams only: `app` builds each character's pieces, the
conversation driver opens threads and delivers turns, and the plugin host
confirms tools through its handler seam — the gateway adds lifecycle,
ordering, and routing, never a second way to construct or persist
anything.

Clients hold the `Gateway` façade and never a `CharacterRuntime`. Nothing
below this module — app, runtime, plugins, core — may import it (arch
rule `nothing-imports-gateway`), and only the gateway imports `app`
besides the CLIs that predate it.
