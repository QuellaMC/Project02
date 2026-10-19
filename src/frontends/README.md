# frontends

Every platform a person talks to a character on — the web page and the
Telegram connector here — is a client of the daemon's wire and nothing
more. A frontend value-imports only the contract (`gateway/api`),
the reference client (`gateway/client`), `core`, and `shared` (arch rule
`clients-see-only-the-wire`), and nothing in the daemon imports a
frontend (`nothing-imports-frontends`): whatever a frontend cannot do
through the API, nobody can. Each platform is one directory here with its
own entry and tests; a connector joins as a sibling.

## web

The page a person opens at the address `serve` prints. Vite builds `web/`
into `dist/web`, which the daemon serves at its root — one origin, so no
CORS; the token rides the fragment of the address. `pnpm build:web`
builds it once, `pnpm serve` builds before it runs, and
`pnpm exec vite build --watch` is the developer's loop, with a reload in
the browser. The page's own `tsconfig.json` gives it the DOM and the JSX
transform; the root program excludes the directory.

The page follows the wire page's rules for a surface, stated once in
`store.ts`: everything a tab shows is one value, and every change to it is
a pure function of the previous value and one input — the daemon's
snapshot, an event, a history page, a send, a line's end. It is DOM-free
and unit-tested in Node. `session.ts` holds the tab's one client and one
stream and the verbs a page calls, and runs only in a browser; `app.tsx`
and `thread.tsx` render the store — the roster, every confirmation and
pairing request waiting, the thread with its draft bubbles, the one-line
composer. A pairing request is a card beside the confirmations, with its
connector, the account, the code and when it expires; the daemon's answer
to a click settles it as a confirmation's answer does — a settlement is
left to the frame, an expiry is said once whichever news of it comes
first, a request the daemon no longer knows is no longer waiting — and an
approval that could not be written keeps the card and says why. The
turns in progress are the contract's own shape, folded from frames by the
contract's one fold and installed from every `ready`; a stream the daemon
resumed is live again with nothing installed. A restart of the daemon is a
reconnect on the same address, and the next line goes through without a
click. The browser suite under `tests/browser` drives the built page in
Chromium against a real daemon.

The settings screen is the page's one writer of config, over the daemon's
two verbs. `settings.ts` holds its rules, pure and tested in Node: the
screen's target and view, what is typed and not saved, one operation per
change built from the field's shape, and how each outcome of a change
ends — applied re-reads the view and leaves the roster to the stream, a
refusal stays at its field, a conflict is said once with the person's
text kept. `settings-session.ts`
is the verbs over the tab's client, and `settings.tsx` renders one screen
for the home and for a character, every row the field shape the view
carries. The roster links to it: Settings for the home, a gear per
character, and a character that is off shows so, with its switch on its
own screen. A connector's block says from health whether its process is
on the daemon's stream, and how to start it when it is not. A change saved
on any surface reaches every screen open on it: the stream's
`health_changed` frame is a tab's cue to read its view
again, with what is typed kept. A fresh home opens on the home's screen
framed as setup until a provider is chosen; the person leaves it.

## telegram

The Telegram connector: one process beside the daemon, run as
`pnpm telegram`, with `--store <dir>` naming the home as it does for
`serve`. It finds the daemon by the home's `daemon.json`, read again
until it names a daemon that answers: a record not there yet, one it
cannot read, and a token the daemon refuses are each said once. A daemon
that speaks another protocol ends the process with exit 1, both versions
said. It opens the stream as the `telegram` connector, so health — and
the settings page with it — says it is running, and keeps its read of
the connector config by the wire page's reading rule, and one read more:
a read on every `ready` and every `health_changed`, the newest answer
applied, a failed read tried again with a backoff, and a read on a
stream's return after it was lost. Every read holds the bots until it
lands — their messages, their writes to paired accounts, and the stream's
frames, handed on in order after — and so does the stream's loss, until a
read begun after it lands, so what the bots show and admit goes by the
settings as they are. A lost
stream sends it back to the record, so a daemon that came back on
another port is found. It reaches the daemon over `node-fetch.ts`, a
fetch on `node:http` that the reference client takes as its `fetch` and
that waits as long as the daemon does: Node's own fetch gives a response
five minutes, and a turn parked on a confirmation outlives that.
Telegram it reaches by the platform's fetch, long polling. Ctrl-C,
SIGTERM and SIGHUP are one stop: every bot stops, its calls to Telegram
and to the daemon with it — a line still waiting on its turn gives up the
wait, and the turn runs on — and the process exits 0.

It runs one bot per token, by the daemon's judgment of each entry: the
management bot while the home's entry is active and holds
`managementBotToken`, and a character's bot while her entry is active
and holds `botToken`. A token two entries share runs once, and that is
said; a changed token restarts its bot, and one that moves to another
character starts a bot of its own; any other change to an entry reaches
its running bot, and the bots outlive a reconnect to the daemon. A bot
asks Telegram who it is and says so. A token Telegram refuses ends its
bot, naming the settings page to replace it on; another program polling the same token (409) and a Telegram that does
not answer are said once per change while the bot keeps trying, and
while another program holds the polls this bot writes nothing, catching
up from the snapshot when its polls are answered again; a webhook
left on the token is removed and said, since Telegram sends a bot's
messages to it or to the polls, never both; a pause Telegram asks for is
waited out, before the next poll, the next message, or the next asking
who the bot is.

Every bot keeps the pairing gate on every message and every press of a
card's button. An account not in `pairedUsers` gets a pairing code, good for an hour,
and nothing else — or, when the daemon cannot take the request, is told
the bot cannot pair it right now; the daemon's `paired` answer lets in an
account the home already holds, before this bot's next read of the
settings. An account this bot gave a code is told how its request ended.
A bot answers private chats only.

A character's bot is her chat. `/start` greets; a message without text
is told the bot reads only text; a paired account's text is carried to
her as the local user's, its `source` `telegram:<bot username>` and its
`clientMessageId` `<bot id>.<chat id>.<message id>`, so the same message carried
again joins its turn. How a line ended has one teller, heard in the chat
the line came from: the delivery's answer for a refusal before any turn
or a daemon out of reach, and the stream's `turn_completed` for a turn
that ran and did not complete, asking for the line again when the turn
did not take it. Each reply of hers is one message in each paired chat —
a chat unpaired while she writes gets no more of it — posted with its
first words, edited at most every 1.5 s and then into its committed text,
and deleted when withdrawn; whatever a bot says past Telegram's 4096
characters follows in more messages. With `mirror` on, its
default, another surface's turn is shown too, its line as
`You (<source>): …`; a line this bot carried is not repeated. A chat
that answers 403, one that never opened the bot, is skipped until it
writes. What a bot writes leaves one call at a time, in the order
decided, so no edit overtakes a commit. Nothing is read from history: on a `ready` the daemon could not resume,
the running turns are the snapshot's, a draft it still carries keeps its
message and is brought to the snapshot's words, and one it does not is
withdrawn.

A confirmation of hers that a turn of this bot's line raised is a card
in that line's chat with Approve and Deny — in every paired chat when no
turn raised it — and another surface's is left to that surface. A press
is answered with the daemon's verdict as a toast, and every card is
edited to how it ended, whichever surface answered; a card is one
message, cut to fit when its preview runs past Telegram's longest, sent
again to a chat it could not reach, and ended as settled while the bot
was away when a `ready` comes back without what it asked about. The
management bot
is roster-shaped, as the page is: every confirmation of the home, naming
the surface that raised it, and every pairing request arrive as cards in
each paired chat; `/status` says who is on, read fresh; `/pending` shows
what waits; `/approve <code>` and `/deny <code>` answer a pairing
request; any other text gets the help. A bot is handed the stream's
latest snapshot when it starts, so what already waits gets its card.

The person is told in the chat they used, the operator on stderr, and
stdout says what runs, from `Telegram connector: connected to …` to
`Telegram is off, or no token is set; waiting for a change.`

A test harness starts it with two variables, read once at start and
neither of them a setting: `PROJECT02_TEST_TELEGRAM_API`, the http or
https address of a Bot API to reach in Telegram's place, and
`PROJECT02_TEST_DURATIONS` with the one key the connector reads, `edit`,
the shortest wait between two edits of a draft. Any other key — `serve`'s
among them — or an address that is not http or https refuses the start,
on stderr with exit code 1, as `serve` refuses a key it does not read.

`main.ts` is the entry; `connector.ts` finds and follows the daemon,
keeps the reading rule, and holds the bot table; `bot.ts` runs one
token's bot; `bot-api.ts` is the Bot API as outcomes, never a throw, and
its long poll; `node-fetch.ts` is the daemon's transport; `gate.ts` is
the pairing gate; `outbox.ts` is what a bot writes in its chats;
`cards.ts` holds the cards and their presses; and `character-bot.ts` and
`management-bot.ts` are the two bots' rules. The connector suite
(`tests/integration/telegram-connector.test.ts`) runs it against a real
gateway on a loopback socket and the fake Bot API in
`tests/support/telegram-api.ts`, which answers as Telegram does — a
second poll on one token ends the first with a 409 — and the process
test (`tests/e2e/telegram-process.test.ts`) runs a real `serve` and the
connector beside it, pointed at the fake by `PROJECT02_TEST_TELEGRAM_API`.
