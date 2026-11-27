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
and `thread.tsx` render the store — the roster and the thread — and
`dock-view.tsx` the foot of the column, one surface:
the one-line message box, and above it the dock, where everything waiting
for the person's answer is asked, every confirmation of whichever
character and every pairing request, one at a time in one spot.
The one that expires first is in front, with up to two more as edges
behind it, and its card says who asks and what, in words `ask-words.ts`
makes, pure and tested in Node: her ask to install an app, from its
preview, with what the app may do, a clause each, or to update one; her
ask to sign an app in, on its tile, with the connection of the person's
it would sign in with and what each question then costs them; her
ask to change one of her settings, in the words her
settings page uses, which are read for it; someone new on a connector; and
for a preview the page cannot read, the tool and what it would do behind
Details. It counts down the time left, and Allow and Don't Allow answer
it: a settlement is left to the frame, an expiry is said once whichever
news of it comes first, a request the daemon no longer knows is no longer
waiting, and an approval that could not be written keeps the card and
says why. One that ended in front says how — Allowed, Not allowed,
Expired — and keeps its room half a second, then, with nothing else
waiting, until a message of hers comes or her turn ends, a few seconds at
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
asked for less motion gets none. The thread reads as a messaging app's,
by the rules of `thread-layout.ts`, pure and tested in Node: a time stands
above a message that is the first shown or was sent on another day, more
than 15 minutes after, or in another app than the one before it, with the
app's name above the time where the app changed; the day is in the page's
words and the time as the viewer's system writes one, where they are, and
each bubble says its own on hover; the person's bubbles take their app's
colour, Telegram's or the page's blue; one sender's messages in a row sit
close; and the head of the chat names her, while a bubble says whose it is
only to a reader of the screen. With a character who speaks another
language, as health says, a message shows what was written and, where it
has them, the same words in the other's language under a hairline, a size
smaller: the person's line as they wrote it over what she read, hers over
its translation. What is in her language carries her language's tag, and
what carries a tag is drawn without the system's own font, which on a
machine set to Chinese or Korean is that language's: so a Japanese line
has Japanese letterforms everywhere. Her message box asks the person to
write in their own language. A line of the
person's not yet committed is drawn as theirs sent now in Messages, and
under their newest message one line says how far it got: `Sending…`, the
bubble faint, until the daemon answers; `Delivered` once her inbox has it;
`Read` once her turn took it, with the time on that day and the day on
another. Every line that did not reach her says `Not Delivered` under it,
in red, as a notice says why; it stays in the thread and is never sent
again by itself: pressed, it goes back into its message box.
Each line keeps how far it got in what the tab keeps, so a reload shows it
as it was. While she writes in a turn a line began, three dots in a
bubble of hers stand where her next message will be, and the message
arrives whole the moment it is committed. Each turn in progress is the
daemon's own word on it, replaced whole by each `turn_running` frame and
installed from every `ready`; a stream the daemon resumed is live again
with nothing installed.
A turn of her own, which no line began, shows nothing of her writing,
and its end raises no notice. A reply of hers committed to a chat that
is not on screen, whatever began her turn, puts a dot after her name in
the roster until her chat opens: one dot however many wait, the tab's
own, so a reload starts without.
In the desktop app, a message of hers the stream commits in Messages
while the main window does not have the focus has the app show a
notification, her name over her words, or over their translation when
they have one, once for each message, by the
rule of `notifications.ts`, pure and tested in Node: none for her writing,
a page of the scrollback or a snapshot, for what she sends in Telegram,
or while the window is in front. The first asks the system's permission,
once, and a no is final and silent. Her phone's window never notifies,
and a browser tab, which has no such call, shows none.
A message of hers is read once the chat of its conversation shows it in
the main window, the desktop app's or a tab, while that window has the
focus, the chat's end is in view and the stream is live: as it arrives
there, when her chat opens, when the window comes to the front with it
open, or when the person scrolls back down to it, though not while the
settings stand in front of the chat. The daemon is then told the newest
message of hers the chat shows, by the rule of `reads.ts`, pure and
tested in Node: one read at a time, told once the daemon answered it and
again later when it could not keep it or did not answer, and nothing it
answers is said. Her phone's window never tells: it is her phone.
Her chat's head has Her World and Her Phone, each once the daemon says
she has a world or a phone, by the rules of `her-windows.ts`, pure and
tested in Node. Each opens hers in the one window every character's world,
or phone, shares, and closes it, and is pressed while that window shows
hers: a window of hers says whose it shows when it opens, when a chat asks
and when it goes, over a channel of the page's origin (`window-link.ts`). A
browser that blocks that window is told so in a notice; in the desktop app,
which opens the window itself and gives the page none, nothing is said.
From a call of one of her phone's tools in a turn of hers, known by the
plugin the stream names, until her next message or the turn's end, she is
using her phone: Her Phone carries a dot, and her thread says so in place
of her typing. Nothing of her world shows in the chat.
A restart of the daemon is a reconnect on the same address, and the next
line goes through without a click. The browser suite under `tests/browser`
drives the built page in Chromium against a real daemon.

The settings window is the page's one writer of config, over the
daemon's two verbs, and every value it shows is a view's: the home's and
each character's, read when the window opens and again on every
`health_changed` frame, with what is typed kept. `settings.ts` holds its
rules, pure and tested in Node: where the window is, the views, what is
typed and not saved, what a box sends, trimmed, and when, one operation
per change, and how each change ends — applied shows a check, a refusal or a write
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

Every character's page has, after her heartbeat, what she speaks: a
menu of Any Language, which unsets it, and the languages its field
suggests, with one it holds that it does not suggest under that
language's own name. While a character speaks a language of her own, as
health says, the window has the translator, by the rules of
`translator.ts`, pure and tested in Node, and none of it while none
does: the person's page has Your Language, a menu as hers is, of
Automatic and the languages; AI Model has what translates, under
Helpers; and her page has her Translation Notes. Their page holds her words
and phrases, a pair of boxes each, her words in her language, each pair
removable, and Add a Note while she has fewer than a hundred; they are
saved as any box is, her settings holding the pairs both of whose boxes
are filled, and a pair with a box still empty stays on the page until
it is filled. Under them how she sounds, a box of several lines. The
translator's page is drawn as her own AI model's is: Same AI Model as
Hers, which takes away its service and model, or a service connected
with its model, picked from that service's models; another service takes
away the model chosen for the one before.

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

AI Model lists the services a character can think with as the home's view
says them, holding no list of its own: by a service's id it keeps only its
tile, and which one is the ChatGPT plan. Once one is connected, the page
offers what every character thinks with, a service among those connected
and its model, picked from the models its field suggests or typed in
through Other…, and lists the services connected, In Use on that one;
under them, the services that can be added. Each opens a page of its own
with its key, pasted and never shown back, where a key comes from, Remove
Key once one is saved, and the service's other fields but its model under
Advanced, as NVIDIA's server address. The ChatGPT plan has no key: its row
says the account and plan it is signed in as, and its page is the home's
sign-in over the daemon's three verbs for it, drawn from health, so it
moves on by itself: Sign In; the code with Copy Code, Open OpenAI, which
opens OpenAI's page in the person's browser, and Cancel; then the account,
its plan and Sign Out; and until then the warning that this is no official
way to use a plan. A sign-in that failed or a code that ran out is said at
Sign In in the daemon's words. `chatgpt-plan.ts`, pure and tested in Node,
says what it shows. A character's
own AI model, from her page, is Same as Everyone or a service connected
with its model; Same as Everyone takes away her service and every model of
hers. Whatever else of it she holds of her own, a key, a server or a
context size, shows under them, each to be seen and taken away. The
welcome asks for the key of the service chosen, or for the plan shows its
sign-in, the same block, and goes on once the home's settings give a
character a model.

While her settings give her a phone, her page has her phone, over the
daemon's verbs for her apps: A Gift from You, a field of her phone's; an
icon for each app on her phone but the App Store and the apps messages
come in, which have nothing to set, each opening the app's page; Get More Apps; and, among her
permissions, Ask to Install Apps, her phone's other field. Each field is
saved as any field is. A page about her
apps reads her phone when the window comes to it and again on every
`phone_changed` naming her and every `health_changed`, which the person's
connections moving sends, and
Get More Apps and an app's page read the App Store's apps for her; only
the newest read of each lands. An app's page says whose phone it is on,
its version and where it came from; offers Update while the App Store
says it has a newer version, since the page compares no versions; Can
Wake Her Up for an app that says it wakes her; and Remove App, which asks
first, for one her phone does not come with. It says what the app may do,
a line each, and for an app that uses an account of the person's by a
key, the account: by its name once her phone has its key, else Set Up,
either opening the account's page. For an app that asks a model it has
Signed In With in its place, as the design draws it: Not Signed In, or one
of the person's connections it can sign in with now, and while it is
signed in, the model it asks, each saved at the choice over the daemon's
verb for it, the choice showing until her phone says it; and under them
what each question uses, or, not signed in, that she asks first, or what
it needs while nothing is connected. One signed in with a connection no
longer connected shows not signed in, as the design draws it. One her
phone no longer lists, removed here
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
strip, ranges whose bars share one track, a field, a note and a
conversation's bubbles, hers at the line's end in the accent colour and
the other's at its start on a card, are drawn as the design draws them,
each piece keeping its height while the view scrolls; a glance at the
head of a screen stands where the view's title would; a screen of
bubbles shows its end, the newest, as a chat does, as it opens and as
what it says changes; and a row that names the page it is about draws
its title as a link that opens nothing: the person watches her phone. The App Store's
rows carry an app's tile and its page an app's header, and while her ask
to install an app waits for the person, the row and the header with that
app's id say so in place of their status: "Waiting", and "Waiting for
you", since the window does not know the person's name. The window learns
of her asks from what the stream says of confirmations, those waiting
when it connects and each one raised and settled; the daemon keeps none.
An app her phone says messages come in, Messages or a connector's, is
drawn as its thread, never read as a view: once one is on screen the
window opens her conversation as the chat does and reads its newest page
by the chat's rules, `store.ts`'s, and a message the stream commits joins
it as it joins the chat; no earlier page is read. It shows what went
through that app alone, the person's lines as she read them and no
translation, each marked with her language, laid out by `thread-layout.ts`
as the chat is and
mirrored, since it is her phone: hers at the line's end in the app's
colour and the person's at its start on a card, a time where time has
passed and no app's name, one app being on screen; her typing is not
there. Under her newest message one line says whether the person read
it, as the chat says how far the person's got: in Messages `Read` and
when, once the read her phone keeps is of it or of a later message in
any app, and `Delivered` until then; in Telegram, which tells nobody,
always `Delivered`. At its head stand a way back to her home screen and
the person, by the name their newest message goes by, with the app's name
under theirs but in Messages; at its foot a message box that is only
drawn. It follows its newest message as the chat does, and a
conversation that cannot be opened or read is said in the daemon's
sentence where her messages would be.
A character the daemon does not know, or whose settings give her no phone,
is said in the daemon's sentence where her phone would be.
`phone-window.tsx` and `phone-device.tsx` draw it as the design draws an
iPhone, with nothing painted around it, so a window that can show what is
behind it does.

At `/?world=<character id>` the same bundle draws her world's window, a
third surface, with its own value and rules in `world.ts`, pure and tested
in Node, its own session in `world-session.ts`, and `world-window.tsx`
drawing it. It reads her world when it opens, when the stream says
`world_changed` for it or comes back, and as a turn of a character who
lives there begins and ends, since she is told then what is around her,
which is what makes a thing seen, and nothing says so; only the newest read
lands. Now shows each place somebody is in, who is there since when and
what is there, the things the person left that nobody living there has
seen, and the journal's newest four lines; Places, each place in its order,
who is there, its first two things, how many more, and New; a place, who
is here and its things; the Journal, its lines by day, as the chat words a
day. A thing's card says where it is, whom it is from and when, or the
world it came with, and whether she has seen it, and Remove asks again in
place before it removes. Leave Something leaves her a thing of one of the
world's kinds, Gift, its first, at first, in the place being looked at,
else where she is, with a note; what the daemon refuses is said above its
button, and what was typed stays. Each is the person's own act, over the reference
client, and her world is read again after it. A character the daemon does
not know, or who has no world, is said in the daemon's sentence on the
panel.

Both windows are drawn with the page's shared parts, the `ui-` classes of
`styles.css`: a panel and what scrolls on it, a view's top line, cards of
rows, badges, tiles, tokens, chips, capsule and round buttons, a floating
tab bar, a sheet over its veil, boxes to type in and a window's own bar,
laid out as Apple lays out words in round shapes by the rules at their
head. They share the bar itself, `window-bar.tsx`, with what each shows at
its start and who it is about, the pin and the cross at its end.
`window-calls.ts` tells, from the page's `window` and
importing nothing of the app, whether a page is in the desktop app and what
its window answers, and has the app show a notification. A window of hers
in the app has no frame of its own and answers four window calls: there
the bar moves the window, a pin keeps it on top of other windows as the
window says it does, and closing it, from the bar or when the chat asks, is
the app's. A browser's popup, which has a title bar of its own, answers
none: it gets no pin and no moving bar, and closes as a window a script
opened.
