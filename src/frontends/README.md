# frontends

Every platform a person talks to a character on is a client of the
daemon's wire and nothing more: the web page here, and the Telegram
connector, which is the binary's `project02 telegram`
(`crates/p02-telegram`). A frontend imports only the contract,
`gateway/api`, and the reference client, `gateway/client` (arch rule
`clients-see-only-the-wire`), and nothing else imports a frontend
(`nothing-imports-frontends`): whatever a frontend cannot do through the
API, nobody can. Each platform here is one directory with its own entry
and tests.

## web

The page a person opens at the address `serve` prints. Vite builds `web/`
into `dist/web`, which the binary embeds when it is built and serves at
its root — one origin, so no CORS; the token rides the fragment of the
address. `pnpm build:web` builds it once, and `pnpm serve` builds it and
then the binary before it runs, so a change to the page shows once `serve`
runs again. The page's own `tsconfig.json` gives it the DOM and the JSX
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
