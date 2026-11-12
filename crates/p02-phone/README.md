# p02-phone

Her phone: the apps it comes with and those installed on it, the engine
that runs one, the screens they show, what they keep and the rings they
set, and what she has in front. It depends on p02-contracts, p02-core and
p02-shared, and on p02-wire for the screen it reads an app's into. It reads
no file itself: a call that touches the phone's files is handed a plugin
store's files under its lease. It is synchronous, and its callers run it on
the blocking pool.

- **An app is one file**, an ES module that imports nothing. It exports
  its `manifest`, plain data that survives as JSON: `format`
  (`project02.app.v1`), `id`, in lowercase since it names the app's files,
  `name`, a one-line `summary`, its own
  `version`, three numbers with dots, the `icon` and the `tint` of its
  tile, names of the page's own set, which falls back for one it does not
  know, whether it `wakes` her, its `views`, each with an `icon` too, the
  view it `opensOn`, and its `actions`, each with a `description`, what her
  window says she `did` in one line of the past tense, the `view` shown
  after it and the JSON Schema its `input` is held to, as a tool's is.
  Beside it, `screen(view)`, a function per action taking its input, and
  `rang(ring)` if the app hears its rings. Making an app runs the module
  once, on an empty phone that only reads, and checks what it exports, so
  a broken app is refused when it is added. An app refuses a call by
  throwing an `Error`, whose message is what its reader is told; anything
  else it throws is the app failing.
- **What an app asks for.** Keeping its own data is every app's. Only an
  app that says it `wakes` her sets a ring: another's `phone.rings.set`
  throws, and cancelling and listing stay harmless.
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
- **All or nothing.** What an app keeps is one file, `apps/<app-id>.json`,
  holding `{"storage", "rings"}`. It is read forgivingly before a call and
  written whole only when the call returned, answered JSON within the
  limits, and changed something that still keeps within them. A call the
  phone refuses or the app fails saves nothing.
- **What she has in front.** `phone.json`, beside the apps' files, holds the
  app and the view she has in front, none her home screen, and what she
  last did: the app, its words and the moment. Her `open` of an app, and
  her action, write it once the call stood, and a call whose writing of it
  failed still stands and says why; a person's `look` at a view only
  reads, and puts nothing in front. It is read forgivingly: no file, or a
  part that names an app or a view no longer on the phone, is her home
  screen with nothing done.
- **Rings.** The phone lists the rings that may wake her, soonest first:
  an app's while it says it `wakes` her and the person did not say it may
  not. Any other app's rings stay set, and nothing tells them to her. For a
  ring told to her and still set for its time, the app's `rang` runs as a
  call of its own, and the ring leaves unless `rang` set it for another
  time; a `rang` that fails, or an app that cannot run, lets it go too.
- **Whether an app may wake her** is the person's say, kept with her phone
  in `muted.json`, the apps they said may not: every other may. It is said
  only of an app that says it wakes her, an update keeps it, and it goes
  when the app is removed. A list that does not read is passed over and
  said, and every app may wake her.
- **Her apps** are the apps her phone comes with, then those installed on
  it by name, then the App Store, each character her own. An installed app
  is its one file, kept as text in `apps/<app-id>.txt`, and
  `installed.json` lists each with what her phone shows of it without
  running it: its id, name, summary, version, icon, tint, whether it wakes
  her, its views and the view it opens on, and where it came from, the
  catalog or a file.
  Installing makes the app first, so a broken one is refused and writes
  nothing; an id the phone comes with is refused; an id already installed
  is replaced, whatever its version or source, keeping what it keeps, and
  installing says the version it replaced. A preview judges a file as
  installing it does, and neither writes it nor keeps the app it makes.
  Removing an app takes what it keeps, with its rings, what the person said
  of it, its file and its place on the list, and closes it when it is in
  front; an app the phone comes with cannot be removed. A list, or an entry
  of it, that does not read is passed over and said. An app is made from
  its file at the first call that runs it and kept while the file is
  unchanged; one whose file is gone or no longer makes it cannot run, which
  each call that runs it says, while the rest of her phone works.
- **What a phone comes with**: the apps in `apps/`, compiled in, today the
  Clock, `apps/clock.js`: alarms, timers, a stopwatch and a world clock. A
  bundled app that is refused fails the bundled phone at its first use, as
  a build that must not ship. And the App Store, last on her home screen.
- **The catalog** is one document, `project02.catalog.v1`, listing at most
  100 apps, each by what the store shows of it without fetching it: its id,
  name, summary, icon, tint, version and whether it wakes her, under the
  names and rules of a manifest, one line on what `changes` in this
  version, and the `sha256` of its one file. An entry that breaks a rule
  is passed over. An app's text is taken only as the file of that SHA-256,
  making an app, of the id and the version listed. How an app of the
  catalog stands on her phone is one rule, `CatalogApp::status`, which
  everything that reads the catalog takes: not on it; on it in an older
  version than the catalog's, versions ordered as their three numbers,
  which the catalog's updates; or on it in the catalog's version or a
  newer one, which nothing of the catalog's replaces. Reaching the catalog
  is the caller's; what goes wrong is said in plain words naming no
  address.
- **The App Store** is the phone's own app, written here with no script,
  since it needs what no app is given. Its id is taken as a bundled app's
  is: nothing installs over it or removes it, and it sets no ring. In
  `apps/store.json`, as its own data, it keeps the catalog it last read,
  which its caller reads anew as she opens it, and which app's page is
  open. Its one view shows that page, or else the catalog's apps under
  "Reviewed by Project02", each with its tile, name and summary and how it
  stands on her phone ("Update", "Installed", or nothing when it is not on
  it), read from her phone whenever the screen is made. `show_app {app}`
  answers what the app is and may do and opens its page, a screen whose
  `page` is the app's id, where the list's names none: its header, its
  summary, what it may do ("Keep its own data", and "Wake her when
  something is due" for one that wakes her, the lines `it_may` makes for
  the person too), and under "What's New" its version with what changed.
  Opened again, it shows its list; before it read anything, a line says
  so.
