# p02-app

The daemon without its transport: an actor per character, the routes to
her, the confirmations and pairing requests the person answers, the
reconciler, the scrollback and the events. p02-gateway puts it on a
socket. It reaches the disk only through the store and the settings, on
tokio's blocking pool, and answers every condition a client can reach
with an outcome of p02-wire, never an error.

- **Her actor** owns her state, her parts and her thread, and answers what
  it is asked in order. A line is routed by its conversation and queued in
  her inbox, and the answer says so; she takes the lines one at a time
  while she is ready, and each leaves her inbox once its turn ended, so a
  crash loses none and runs none twice. A turn the runtime fails earns her
  one restart. Settings that give her no AI model leave her needing one:
  her thread opens and her lines wait until a change gives her one. Her
  stop lets the turn in flight finish; the lines behind it wait for her
  next start.
- **Her heartbeat.** While she is ready and her heartbeat is not off, a
  moment of her own is due one period after she has been quiet since:
  since her thread opened in this run, her last turn ended, or her boot
  found her thread made before. A character whose thread was never made
  has none, and a moment missed is never made up. A waiting line always
  goes first, and one that comes during a moment waits for its end. The
  moment runs as a line's turn does, and nothing leaves her inbox.
- **Her rings.** While she is ready and runs her phone, a ring on it that
  may wake her and comes due by the wall clock, which she reads again at
  least every half minute, begins a moment of her own that tells every ring
  due by then: after a waiting line, and before her heartbeat's moment. Her
  rings are read whenever she is built, at her start and when a settings
  change builds her anew, after each turn of hers, and whenever the person
  changes her phone. Once that moment completes, what rang goes to its
  apps; when it does not, its rings wait for her next turn that completes,
  or her next start, so a ring is never lost and a model out of reach is
  not asked again and again.
- **Her phone** is read from her data whether she runs or not, under a
  lease of its store: her apps, those it comes with and those installed
  on it, the App Store last, each with what it may do and the person's
  account it uses, with whether the home's settings hold its key; what
  she has in front with its screen and what she last did, with what
  rings, which her actor publishes while a ring's moment runs. A view of
  an app is read on request too, and changes nothing of hers. One whose settings switch her phone off has none to
  read. The stream says her phone changed after a call of her phone's
  tools came back accepted, and as a ring's moment begins and once its
  rings went to their apps. The daemon makes the one reader of the App
  Store's catalog, from the base the binary gives it, and the one seam
  that makes her apps' requests, at a stand-in the binary names under its
  test switch, and hands both to every host it builds her.
- **Her apps in the person's hands**, each the person's own act, which
  asks nobody, made on her data whether she runs or not, as her phone is
  read: the App Store's catalog read anew for them to browse, with how
  each app stands on her phone; an app of it given to her by the one path
  her own ask takes, an older version replaced keeping what it keeps;
  an app from a file, previewed with nothing written, then given; an app
  removed; and whether an app may wake her. Each that changed her phone
  says so on the stream, and her actor, while she runs, reads its rings
  again.
- **The stream** hears each turn as it goes: its messages once they are
  on disk, the turn as it runs now, her drafts whole, whenever that
  changes, and then its completion, which says whether its line is in the
  log. A turn of her own carries no line's stamps, and is said running as
  it begins.
- **Settings** change one way, a client's change or her own plugin's,
  through p02-config; health, which says the accounts her phone knows,
  each with whether the home's settings hold its key, then goes to every
  surface, and a reconcile pass starts or stops whom the change switched
  and brings every other running character up to date at once, built
  again when what she runs on changed. A turn in flight meets it before
  its next request to her model, where her settings are read again in any
  case. Whether they give her a model is one judgement, which her
  settings' view asks too.
- **A character's package** is added from a file, updated or removed
  while the daemon runs: judged as discovery would publish it, written or
  removed under the locks of her settings, and then announced and
  reconciled as a settings change is. One updated while she runs is
  stopped, and starts again from her new package; her data outlives her
  removal.
- **Confirmations and pairing requests** wait for the person under a
  deadline the daemon judges, and each settles once.
- **A connector** is on the stream while a stream of its own is open, and
  the bots it last said it runs are kept as long; health shows both, and
  goes to every surface when either changes.
