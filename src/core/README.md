# core

Pure domain: the message model (`message/`) and the conversation session
state machine (`conversation/`). This module owns what a character
conversation _is_ — messages, speakers, turn ordering, and the runtime
event identity vocabulary. It imports nothing above `src/shared` (arch
rule `core-is-pure`); nothing else may implement these concepts.
