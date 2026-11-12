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
  comes due by the wall clock, which she reads again at least every half
  minute, begins a moment of her own that tells every ring due by then:
  after a waiting line, and before her heartbeat's moment. Her rings are
  read whenever she is built, at her start and when a settings change
  builds her anew, and after each turn of hers. Once that moment
  completes, what rang goes to its apps; when it does not, its rings wait
  for her next turn that completes, or her next start, so a ring is never
  lost and a model out of reach is not asked again and again.
- **The stream** hears each turn as it goes: its messages once they are
  on disk, the turn as it runs now, her drafts whole, whenever that
  changes, and then its completion, which says whether its line is in the
  log. A turn of her own carries no line's stamps, and is said running as
  it begins.
- **Settings** change one way, a client's change or her own plugin's,
  through p02-config; health then goes to every surface, and a reconcile
  pass starts or stops whom the change switched and brings every other
  running character up to date at once, built again when what she runs
  on changed. A turn in flight meets it before its next request to her
  model, where her settings are read again in any case. Whether they give
  her a model is one judgement, which her settings' view asks too.
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
