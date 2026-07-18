# plugins

The plugin system: the contract every plugin implements (`api/` — the
only surface runtime may import), pure activation/access/tool policy
(`policy/`), the hook-running host (`host/`), first-party built-ins
(`builtin/`), and descriptor-loaded bundled packages (`packages/` —
scanned at runtime by `package-loader/`). This module owns plugin
behavior; durable persistence belongs to runtime.
