# p02-role-model

The character's model: the prompt a turn renders, the rounds she decides
in, and the providers that answer. The runtime drives a turn with
`run_turn` and a `TurnSink`, and picks a provider with `select_adapter`.

Every sentence the model is told lives in the prompt module; text from a
plugin or an earlier summary is fenced and never reaches a system message.

Each round is judged once and recorded before anything it decided
happens. A refused round is told to the model in the next one, a provider
failure ends the turn, and a turn spends at most 99 rounds of tool calls.

The NVIDIA adapter streams a chat completion and hands back the model's
calls and text as written. It retries a busy provider or a broken
connection but never a timeout, and no failure repeats the key. The test
provider answers in fixed sentences, behind a test switch alone.
