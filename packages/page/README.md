# page

The page a person opens at the address `serve` prints. Every platform a
person talks to a character on is a client of the daemon's wire and
nothing more: this page, and the Telegram connector, which is the
binary's `project02 telegram` (`crates/p02-telegram`). The page imports
only the contract, `@project02/wire/contract`, and the reference client,
`@project02/wire/client` (arch rule `clients-see-only-the-wire`), and
nothing imports the page (`nothing-imports-the-page`): whatever the page
cannot do through the API, nobody can.

Vite builds `src/` into `dist/`, which the binary embeds when it is built
and serves at its root — one origin, so no CORS; the token rides the
fragment of the address. `pnpm build:web` builds it once, and `pnpm serve`
builds it and then the binary before it runs, so a change to the page
shows once `serve` runs again. The package's `tsconfig.json` gives it the
DOM and the JSX transform.

The page follows the wire page's rules for a surface, stated once in
`store.ts`: everything a tab shows is one value, and every change to it is
a pure function of the previous value and one input — the daemon's
snapshot, an event, a history page, a send, a line's end. It is DOM-free
and unit-tested in Node. `session.ts` holds the tab's one client and one
stream and the verbs a page calls, and runs only in a browser; `app.tsx`
and `thread.tsx` render the store — the roster, every confirmation and
pairing request waiting, the thread with its draft bubbles, the one-line
composer. A pairing request is a card beside the confirmations, with its
connector, the account, the source it wrote to, the code and when it
expires; the daemon's answer to a click settles it as a confirmation's
answer does — a settlement is left to the frame, an expiry is said once
whichever news of it comes first, a request the daemon no longer knows is
no longer waiting — and an approval that could not be written keeps the
card and says why. Each turn in progress is the daemon's own word on it,
replaced whole by each `turn_running` frame and installed from every
`ready`; a stream the daemon resumed is live again with nothing installed.
A restart of the daemon is a reconnect on the same address, and the next
line goes through without a click. The browser suite under `tests/browser`
drives the built page in Chromium against a real daemon.

The settings window is the page's one writer of config, over the
daemon's two verbs, and every value it shows is a view's: the home's and
each character's, read when the window opens and again on every
`health_changed` frame, with what is typed kept. `settings.ts` holds its
rules, pure and tested in Node: where the window is, the views, what is
typed and not saved, what a box sends and when, one operation per change,
and how each change ends — applied shows a check, a refusal or a write
that failed stays at its row with the person's text, and someone saving
first sends the same change again once while its row still holds what it
held. `settings-model.ts` works out what each page shows: which rows a
card draws (a value in effect is never hidden), which control a field
takes, the sidebar's values and dots, how a character and a bot stand,
and where each finding is said; `look.ts` holds the icons, tints and
avatar colours. `settings-session.ts` is the verbs over the tab's client,
one change at a time, and remembers the window's Advanced switch in the
browser. The `settings-*.tsx` files draw the window, and `welcome.tsx`
the first run, shown instead of the chat while the home's settings give
a character no AI model, until the person starts chatting. The roster
opens the window, a gear per character opens her page, and one who needs
an AI model says so in plain words that lead to it. The chat and the
window draw from one set of tokens in `styles.css`, light and dark.

The window adds and removes characters over three more verbs. Add
Character opens the system's file chooser. The file's text goes to the
daemon's preview unless it is larger than a character file can be, and
the window shows who she is and what adding her does, or why she cannot
be added; it holds the text only while that page is open, and Add sends
it again for the daemon to judge afresh. A character a person added has
Remove at the bottom of her page, which asks first. The roster is
health's, so a character added or removed anywhere appears or goes here,
and a page of one who is gone is left for You.
