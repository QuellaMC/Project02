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

An adapter speaks one protocol. The NVIDIA adapter streams a chat
completion from NVIDIA's cloud or a server of the person's own. The
Responses adapter speaks OpenAI's Responses protocol to a service of it,
which says where it is, how a request proves who sends it, what of the
protocol it takes and its name in what the person reads: the OpenAI API,
on the person's key, and a ChatGPT plan, on the home's sign-in. It stores
nothing with the service and passes back no reasoning, offers every tool
unstrict, and replays her earlier calls and their results as function
calls and their outputs, under ids numbered within each request, since
the runtime's own are longer than the protocol takes. A response ends at
the event that says so, completed, incomplete or failed, or at
`response.done` or a `[DONE]` line, and its output is the one that event
carries, or, when it carries none, each item as its own last event gave
it whole.

A plan's requests go as OpenAI's Codex app makes them, each in a session
of its own: the access token fresh from the sign-in and the ChatGPT
account, Codex's originator, empty instructions with the system's lines
as the developer's and each text as a part, a little reasoning handed
back encrypted, no bound on the output, and every one streamed, plain
completions too. A 401 is asked once more on the sign-in refreshed, and
a second is the sign-in turned down. A plan whose usage is used up is
said so and asked no more until the next turn; too many requests at once
are tried again and then said as the service busy.

The Anthropic adapter speaks Anthropic's Messages protocol to the Claude
API, on the person's key, in the protocol's version, every request
streamed, plain completions too. The system's lines before the
conversation are its system prompt, and a later one goes as the
protocol's own system message, which the runtime puts only after the
person's line or a round's results; her earlier calls go as tool uses
and each round's results as one message of the person's, under ids
numbered within each request, and each tool's arguments stream as the
model writes them. It asks for no sampling, thinking, effort or
forced tool choice, sends no thinking back, and gives an answer the room
the OpenAI API gives. For a model the setting offers, a request asks for
Anthropic's own fallback for a decline; where it takes a message over,
the calls before it are let go, and the replies drafted of them with
them. A message is judged at its stop: a decline, said with its category,
and a message cut short fail the round.

An adapter is built only with a key, or for NVIDIA a server of the
person's own, which may ask for none, or for the plan the home signed
in; building one does no I/O, its HTTP client made at its first request.
Each hands back the model's calls and text as written, and hears her
reply as its arguments stream. The exchange is one for all three: it
retries a busy provider or a broken connection but never a timeout,
bounds the provider's silence, reads an error under `error`, beside it or
as its `detail`, and no failure repeats a key, a token or the account it
went with, each said as its service's own. The test provider answers in
fixed sentences, behind a test switch alone.
