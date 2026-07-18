# cli

Terminal entrypoints (`chat/`, `inspect/`, `config/`, `relay/`) and
their shared flag/error helpers (`shared/`). CLIs are presentation
shells over app/runtime surfaces; nothing may import them (arch rule 4).
App logic discovered here gets extracted downward, not grown here.
