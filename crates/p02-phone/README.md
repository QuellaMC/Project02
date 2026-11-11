# p02-phone

Her phone: the apps on it, the engine that runs one, the screens they show,
what they keep and the rings they set, and what she has in front. It
depends on p02-contracts, p02-core and p02-shared, and on p02-wire for the
screen it reads an app's into. It reads no file itself: a call that
touches the phone's files is handed a plugin store's files under its
lease. It is synchronous, and its callers run it on the blocking pool.

- **An app is two files.** `app.json`, its manifest: `format`
  (`project02.app.v1`), `id`, `name`, a one-line `summary`, the `icon` and
  the `tint` of its tile, names of the page's own set, which falls back for
  one it does not know, its `views`, each with an `icon` too, the view it
  `opensOn`, and its `actions`, each with a `description`, what her window
  says she `did` in one line of the past tense, the `view` shown after it
  and the JSON Schema its `input` is held to, as a tool's is. `app.js`, one
  ES module that imports nothing, exports `screen(view)`, a function per
  action taking its input, and `rang(ring)` if the app hears its rings.
  Making an app checks both and runs the script once, on an empty phone
  that only reads, so a broken app is refused when it is added. An app
  refuses a call by throwing an `Error`, whose message is what its reader
  is told; anything else it throws is the app failing.
- **A script reaches** the language and `phone`, nothing else:
  `storage.get`, `set` and `remove`, a JSON value under each key;
  `rings.set({id, at, title, body})`, `rings.cancel(id)` and `rings.list()`,
  its own rings, `at` in milliseconds since the epoch, the title one line of
  40 characters at most, as a notification's, and the body one line of 120;
  and `time.now()`, `time.local(at, zone)` and
  `time.next({hour, minute, weekdays})`, read from the moment and the zone
  each call is given. A clock time the clocks skip
  comes as much later as they jumped, and one they pass twice comes the
  first time. A screen only reads, and is held to the pieces and fields the
  wire's screen knows.
- **Each call runs fresh**: its own QuickJS runtime and context, dropped when
  it returns, under limits of 1 second for the whole call, 16 MiB of memory
  and 256 KiB of stack. The time limit holds after an `await` too, and a
  script cannot catch it; a promise with nothing left to settle it fails at
  once.
- **All or nothing.** An app keeps one file, `apps/<app-id>.json`, holding
  `{"storage", "rings"}`. It is read forgivingly before a call and written
  whole only when the call returned, answered JSON within the limits, and
  changed something that still keeps within them. A call the phone refuses
  or the app fails saves nothing.
- **What she has in front.** `phone.json`, beside the apps' files, holds the
  app and the view she has in front, none her home screen, and what she
  last did: the app, its words and the moment. Her `open` of an app, and
  her action, write it with the call; a person's `look` at a view only
  reads, and puts nothing in front. It is read forgivingly: no file, or a
  part that names an app or a view no longer on the phone, is her home
  screen with nothing done.
- **Rings.** The phone lists every app's rings, soonest first. For a ring
  told to her and still set for its time, the app's `rang` runs as a call of
  its own, and the ring leaves unless `rang` set it for another time; a
  `rang` that fails lets it go too.
- **What a phone comes with**: the apps in `apps/`, compiled in, today the
  Clock: alarms, timers, a stopwatch and a world clock. A bundled app that
  is refused fails the bundled phone at its first use, as a build that must
  not ship.
