# p02-role-model

The character's model: what a turn tells it, the rounds it decides in, and
the providers that answer. It depends on p02-characters, p02-contracts,
p02-core and p02-shared; the runtime drives it through `run_turn` and a
`TurnSink`, and reaches a provider through `select_adapter`.

- **The prompt.** Every sentence the runtime writes to the model is in one
  module, spoken to the character in the second person. A round is framed
  as the persona and the runtime's protocol, the curated notes and this
  turn's notes as system messages, the stable ones first; a continued
  session's recollection, which a model wrote, as a fenced user message
  where the earlier turns would be; the earlier turns replayed natively;
  the person's line, carrying recalled memories and what plugins hand over
  without trust in two fences of its own; this turn's tool rounds on the
  history's wire; and the note about an unusable last reply. Text a plugin
  or a note supplies can neither close its fence nor reach a system
  message. The bytes are the TypeScript daemon's but for the three listed
  exceptions: characters counted as code points, tool payloads spelled by
  `serde_json`, and the parser's rejection wording.
- **The history window** is the newest whole earlier turns that fit half
  the context window, at four characters a token; the same measure picks
  the newest turns within any budget, as a continuation picks what it
  carries.
- **The rounds.** A round is judged by the decision parser and recorded
  before anything it decided happens. A refused round goes back to the
  model as part of its next round and counts like any other; a provider
  that gave nothing usable ends the turn; the round budget is the loop's
  only refusal of its own. Each reply is committed under the id of its
  draft, and what a round drafted and did not commit is withdrawn before
  the round moves on. Tool calls get the runtime's ids and run through the
  plugin host, which decides which may overlap; the model's note beside its
  calls stays on the decision and is never a message.
- **NVIDIA.** A round is a streamed chat completion: the request body as
  the TypeScript daemon sends it, the tools under names the provider takes,
  the stream reassembled whatever bytes it is cut into, and a reply drafted
  only from a native `visible_reply` call's arguments as they arrive. The
  provider's silence is bounded at 30 seconds unless shortened, before the
  headers and between chunks; a transport fault, a 408, a 429 or a 5xx is
  tried again after 250 ms and after 1 s, a timeout never; no failure
  carries the key. A plain completion on the same model condenses earlier
  conversation.
- **The test provider** answers with fixed sentences, and only a test
  harness's switch reaches it: no setting names it.

## The prompt fixtures

`tests/fixtures/prompts/` holds what the TypeScript daemon of commit
`6e1e9fdc4f0a05d03233889fa08356f3360c658e` rendered and sent for four
turns, with the summarizer's two requests, the day notes and the notes about
an unusable reply; `prompt::parity` renders the same and compares the
bytes. The turns are a first turn offering the bundled tools, with curated
sections and runtime notes; a continued session that names the person, with
its summary, two earlier turns, one with a tool round, recalled memory,
untrusted context, an untrusted plugin's runtime note, and tool names that
collide once made provider-safe; a turn in its third round, with two rounds
of its own and the note about an unusable reply; and a turn offering
`visible_reply` alone. To record them again, give each fixture's `input` to
the TypeScript daemon's `renderRoleModelTurnContext`, with Mira's persona
from her bundled package, and send the result through
`createNvidiaRoleModelProviderAdapter` with the model
`nvidia/fixture-model` and a fetch client that keeps the body; the texts
come from `summarizerInstructions`, `createTodayRuntimeNote` in UTC and
`unusableReplyNote`.
