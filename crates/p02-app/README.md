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
- **The stream** hears each turn as it goes: its messages once they are
  on disk, the turn as it runs now, her drafts whole, whenever that
  changes, and then its completion, which says whether its line is in the
  log.
- **Settings** change one way, a client's change or her own plugin's,
  through p02-config; health then goes to every surface, and a reconcile
  pass starts or stops whom the change switched and brings every other
  running character up to date at once, built again when what she runs
  on changed. A turn in flight meets it before its next request to her
  model, where her settings are read again in any case. Whether they give
  her a model is one judgement, which her settings' view asks too.
- **Confirmations and pairing requests** wait for the person under a
  deadline the daemon judges, and each settles once.
- **A connector** is on the stream while a stream of its own is open, and
  the bots it last said it runs are kept as long; health shows both, and
  goes to every surface when either changes.
