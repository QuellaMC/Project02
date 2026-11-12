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
and `thread.tsx` render the store — the roster and the thread with its
draft bubbles — and `dock-view.tsx` the foot of the column, one surface:
the one-line message box, and above it the dock, where everything waiting
for the person's answer is asked, every confirmation of whichever
character and every pairing request, one at a time in one spot.
The one that expires first is in front, with up to two more as edges
behind it, and its card says who asks and what, in words `ask-words.ts`
makes, pure and tested in Node: her ask to install an app, from its
preview, with what the app may do, a clause each, or to update one; her
ask to change one of her settings, in the words her
settings page uses, which are read for it; someone new on a connector; and
for a preview the page cannot read, the tool and what it would do behind
Details. It counts down the time left, and Allow and Don't Allow answer
it: a settlement is left to the frame, an expiry is said once whichever
news of it comes first, a request the daemon no longer knows is no longer
waiting, and an approval that could not be written keeps the card and
says why. One that ended in front says how — Allowed, Not allowed,
Expired — and keeps its room half a second, then, with nothing else
waiting, until her next line begins or her turn ends, a few seconds at
most; which ask is in front and when one gives way are `dock.ts`'s rules,
pure and tested in Node. While an ask of hers waits, her row in the
roster says she is asking. The dock opens to the card's height as the
card rises in and closes a little quicker, and a card takes no click in
its first quarter second, so a click meant for the card it replaced never
answers it. The chat follows its newest line until the person scrolls
away from it, and only their scroll says so (`thread-scroll.ts`): it
follows the dock frame by frame, and what is new at its end eases in by
the dock's closing, so a line that arrives as the dock closes settles
with it in one motion; a chat scrolled up does not move. A person who
asked for less motion gets none. Each turn in progress is the daemon's
own word on it, replaced whole by each `turn_running` frame and installed
from every `ready`; a stream the daemon resumed is live again with nothing
installed.
A turn of her own, which no line began, shows nothing until she drafts,
and its end raises no notice. A reply of hers committed to a chat that
is not on screen, whatever began her turn, puts a dot after her name in
the roster until her chat opens: one dot however many wait, the tab's
own, so a reload starts without.
Her chat's head has a Her Phone button unless the daemon says she has no
phone. It opens her phone in the one window every character's phone
shares, and closes it, and is pressed while that window shows hers: the
window says whose phone it shows when it opens, when a chat asks and when
it goes, over a channel of the page's origin (`phone-link.ts`). A browser
that blocks that window is told so in a notice; in the desktop app, which
opens the window itself and gives the page none, nothing is said. From a
call of one of her phone's tools in a turn of hers, known by the plugin
the stream names, until her next reply begins or the turn ends, she is
using her phone: the button carries a dot, and her thread says so where
it would say she is writing.
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
browser: a change to a list, such as an account unpaired, is worked out
from what the list holds when its turn comes, and closing the window
waits for the saves already asked for. A stored key is taken away by the
button its own box shows while it is in use. The `settings-*.tsx` files
draw the window, and `welcome.tsx` the first run, shown instead of the
chat while the home's settings give a character no AI model, until the
person starts chatting or sets it up later. The roster
opens the window, a gear per character opens her page, and one who needs
an AI model says so in plain words that lead to it. Her page gives her
heartbeat, how often she gets a moment of her own, a group of its own
between Mind & Body and Telegram: one row of choices, saved at the
click. The chat and the window draw from one set of tokens in
`styles.css`, light and dark.

The window adds and removes characters over three more verbs. Add
Character opens the system's file chooser. The file's text goes to the
daemon's preview unless it is larger than a character file can be, and
the window shows who she is and what adding her does, or why she cannot
be added; it holds the text only while that page is open, and Add sends
it again for the daemon to judge afresh. A character a person added has
Remove at the bottom of her page, which asks first. The roster is
health's, so a character added or removed anywhere appears or goes here,
and a page of one who is gone is left for You. The sidebar's connections
are AI Model, Telegram, each plugin whose page names its entry there, as
Long-Term Memory's does, and each account of the person's that her apps
use, once health says its key is set; one with no key is reached from an
app that uses it, and nowhere else. An account's page has the one field of
its key, pasted and never shown back, and where a key comes from, and,
opened from an app's page, goes back to it.

While her settings give her a phone, her page has her apps, over the
daemon's verbs for them: an icon for each app on her phone but the App
Store, which has nothing to set, each opening the app's page; Get More
Apps; and, among her permissions, Ask to Install Apps, her phone's own
field, saved as any field is. A page about her apps reads her phone when
the window comes to it and again on every `phone_changed` naming her, and
Get More Apps and an app's page read the App Store's apps for her; only
the newest read of each lands. An app's page says whose phone it is on,
its version and where it came from; offers Update while the App Store
says it has a newer version, since the page compares no versions; Can
Wake Her Up for an app that says it wakes her; and Remove App, which asks
first, for one her phone does not come with. It says what the app may do,
a line each, and for an app that uses an account of the person's, the
account: by its name once her phone has its key, else Set Up, either
opening the account's page. One her phone no longer lists, removed here
or anywhere, gives way to her page. Get More Apps
narrows the App Store's apps by a search of their names and summaries,
each row ending in Get, Update or Installed; Get and Update give her the
app at once, and a refusal is a notice. An app from a file is shown as
the daemon previews it, with what it may do, the version it replaces and
the warning that nobody read it, and Add sends the file again for the
daemon to judge afresh and opens the app's page. `her-apps.ts`, pure and
tested in Node, says what each of these shows and how each answer lands;
`settings-apps.tsx` draws them.

At `/?phone=<character id>`, the token in the fragment as ever, the same
bundle draws one character's phone and nothing else: her phone's window, a
second surface beside the chat's, with its own value and rules in
`phone.ts`, pure and tested in Node, and its own session in
`phone-session.ts`; what every surface is made of — its one value, the
client for the page's address, the stream it follows — is `surface.ts`.
The window reads her phone when it opens, on every `phone_changed` naming
her and when the stream comes back, and follows her: it shows what she has
in front, her home screen when nothing is. The person can open an app,
switch its views and go home, each view read on its own and nothing of hers
changed, until a read in which what she did, what she has in front or what
rings is new takes the window back to her. What rings is drawn over
everything, the soonest of several; a row that a read right after something
she did holds for the first time on the same page of the same view is
marked New until the next read, and another page of a view, as the App
Store's page of an app is to its list, marks none; the
view on screen is read again at each minute's turn, and a reading that
moves is counted on the page from the moments it carries. A glance, a
strip, ranges whose bars share one track, a field and a note are drawn as
the design draws them, each piece keeping its height while the view
scrolls; a glance at the head of a screen stands where the view's title
would; and a row that names the page it is about draws its title as a
link that opens nothing: the person watches her phone. The App Store's
rows carry an app's tile and its page an app's header, and while her ask
to install an app waits for the person, the row and the header with that
app's id say so in place of their status: "Waiting", and "Waiting for
you", since the window does not know the person's name. The window learns
of her asks from what the stream says of confirmations, those waiting
when it connects and each one raised and settled; the daemon keeps none.
A character the daemon does not know, or whose settings give her no phone,
is said in the daemon's sentence where her phone would be.
`phone-window.tsx` and `phone-device.tsx` draw it as the design draws an
iPhone, with nothing painted around it, so a window that can show what is
behind it does. `window-calls.ts` tells, from the page's `window` and
importing nothing of the app, whether a page is in the desktop app and what
its window answers. The app's window for her phone has no frame of its own
and answers four window calls: there the bar moves the window, a pin keeps
it on top of other windows as the window says it does, and closing it, from
the bar or when the chat asks, is the app's. A browser's popup, which has a
title bar of its own, answers none: it gets no pin and no moving bar, and
closes as a window a script opened.
