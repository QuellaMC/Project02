# p02-role-model

The character's model: the prompt a turn renders, the rounds she decides
in, and the providers that answer. The runtime runs a turn's `Rounds` one
at a time through a `TurnSink`, each round's request made with the model
the character runs on as it starts, and between two rounds may hand on
what the plugins prepared again; it picks a provider with
`select_adapter`.

Every sentence the model is told lives in the prompt module; text from a
plugin or an earlier summary is fenced and never reaches a system message.
A moment of the character's own opens where the person's line would be,
with the runtime's fenced note of the time, and of what rang when her
phone's ringing began it, and the system messages read the same
whichever began the turn.

Each round is judged once, by what began its turn, and recorded before
anything it decided happens. A round that calls no plugin tool ends the
turn: in a moment it may say nothing, its text a thought she keeps. A
refused round is told to the model in the next one, a provider failure
ends the turn, and a turn spends at most 99 rounds of tool calls.

The NVIDIA adapter is built only with a key, or for a server of the
person's own, which may ask for none; building one does no I/O, its HTTP
client made at its first request. It streams a chat completion and hands
back the model's calls and text as written. It retries a busy provider or
a broken connection but never a timeout, and no failure repeats the key.
The test provider answers in fixed sentences, behind a test switch alone.
