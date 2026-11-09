# p02-app

The daemon's domain without any transport: the roster, one actor per
character, the thread each character holds with the person, the
confirmations a turn parks, the ledger of submissions, the reconciler that
makes the characters running match the settings, the scrollback a client
pages, and the events every surface hears. It depends on p02-characters,
p02-config, p02-contracts, p02-core, p02-plugins, p02-role-model,
p02-runtime, p02-shared and p02-store; its caller resolves the switches of
a test harness, the waits and the plugins compiled in, and speaks HTTP. It
reaches the disk only through the store and the settings, and only on
tokio's blocking pool.

- **The daemon.** A home is checked, never made, and nothing starts until
  a reconcile or a start asks. Every condition a client can reach is
  answered with an outcome, in the field names and the vocabulary the
  page, the clients and the conformance suite read; nothing a client does
  is an error. Health is read afresh each time: the roster as the disk
  holds it, a hand-edited setting or a package dropped in included, each
  character's state as her actor last published it, and the connectors on
  the stream. One character's damaged data never hides the roster: whether
  she is switched on is read as yes, and her start says what is wrong.
- **One actor per character.** A task owns everything of hers and answers
  what it is asked in the order it was asked, so one character runs one
  turn at a time, and her health is read without asking her. A line is
  routed and put in her queue in one step, which lines take in the order
  they came, so they reach her in that order; a running character is
  reached without reading the roster, since who runs is the reconciler's
  to say. She lives from her start to her stop, and a stop is read between
  two steps: a boot, a reload or a recovery in flight is overtaken, a turn
  in flight finishes, and from then on she publishes only `stopping` and
  `stopped`. Her start reads her package, her settings, which must load
  and switch her on before anything is written for her, merges her
  package's settings into her overlay, is refused while anything in her
  settings stops her, a plugin her package recommends missing only
  warning, chooses her model, and builds her plugins with her confirmer. A
  start sent while one is in flight, a boot or a reload, joins it and is
  answered when it settles, and one that failed stays failed until the
  next start or settings change. Her thread with the person is opened the
  first time a client opens it or a line comes for it, and opened again
  after a reload or a recovery, so no client reopens it. A turn the
  runtime itself fails leaves her failed and earns one restart: the lines
  queued behind it are refused, her thread is closed and her plugins shut
  down, and she starts again. She hears what she is asked while a turn
  runs, so a reload is said the moment her package or her settings come
  to differ from those she was built from; it happens once no turn runs,
  before her next line, and lines sent meanwhile wait and land on her
  thread opened again. Her stop cancels her
  parked confirmations first, closes her thread, and shuts her plugins
  down, saying what failed of that. Her
  host is handed her settings, which its own plugin reads and changes in
  her overlay alone, by the one change of settings below.
- **Confirmations.** A question an approval-gated call raises is parked
  under a fresh UUID with its deadline and the turn that raised it, and
  announced; it settles once, by the person's answer, its deadline, or her
  stop, and its settlement is announced once. An answer at or past the
  deadline it was shown settles it cancelled, whatever the timer, on a
  clock of its own, has done: the client never judges the deadline. A
  question raised once her stop began settles cancelled at once,
  unannounced.
- **Submissions.** One turn per conversation and client message id within
  a run: a repeat while it runs joins it and one after it gets its outcome,
  an id reused for another line is refused, and a conversation remembers
  its last 32 settled submissions. Only an outcome whose line is in the log
  is remembered: a line that never reached it is its client's to send
  again under the same id. A line a run before this one took is the
  thread's to answer. The turn runs as a task of its own, which settles its
  submission however it ends, so a client that stops waiting abandons
  nothing; and every delivery that reaches a character is announced as
  completed once, however it ended.
- **Settings.** A settings screen's view and a connector's read are
  p02-config's, read as the disk holds them now. A change, a client's or
  a character's own plugin's alike, is made one way: as p02-config makes
  every change, under the documents' locks; once it lands, health goes
  out to every surface before the answer does, and a reconcile pass acts
  on it behind the answer, on a task of its own, so a caller that stops
  waiting leaves nothing undone. A change her own plugin makes rebuilds
  its plugin live as part of the change, before the change is announced
  and judged, so she runs what her settings now say by the time the pass
  looks and it reloads nothing, and the rebuilt plugin serves the rest
  of her turn; a change it could not apply live reloads her once the
  turn ends.
- **Reconcile.** One rule for boot and for every settings change: an
  enabled character who runs nothing starts, one who failed starts again,
  one who is ready and runs other than what her package and her settings
  now say reloads, and a disabled one who still runs stops, as does one
  whose package left the roster, who is then no character to reach. A
  pass judges the characters running when it was asked for: one a client
  starts while it runs is the client's. Passes never overlap: a request
  while one runs marks one more after it, so the newest roster has the
  last word.
- **Pairing.** An account a connector does not know waits for the
  person's answer under a six-digit code, drawn at random and unlike any
  waiting, until its deadline, an hour unless a test harness shortens it;
  asking again for the same account answers the same request, and an
  account the home's allowlist holds is paired, settling a request that
  waited for it, unless its approval is being written. An answer settles
  it once: denied, or approved by writing the account's name into the
  connector's pairing field in the home's document, by the one change of
  settings, bound to the fingerprint it was read under and, while other
  writes move the document, read again and merged up to three writes in
  all; an account another hand paired meanwhile keeps the name it gave.
  The daemon judges the deadline, as it does a confirmation's, and
  settles a request nobody answered expired; an approval that cannot be
  written leaves the request waiting with what is left of its time,
  announced again. No request outlives the daemon's run. A request names
  the source its account wrote to first, the stamp its lines will carry;
  asking again from another keeps it.
- **History.** A conversation's committed messages as one scrollback
  across her segments, newest page first and chronological within it, the
  cursor `v1:<segment>:<index>` naming where the next page ends; a limit is
  1 to 500, 100 unless given, and a cursor is one a page handed out.
- **Events** are announced in one order, and every subscriber hears each
  one, in that order, however far behind it reads, since the stream a
  client follows numbers every event. A turn in progress is folded from
  them by one definition: what a surface that had heard every event would
  hold.
