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
  turn at a time, and her health is read without asking her. She lives from
  her start to her stop, and a stop is read between two steps: a boot, a
  reload or a recovery in flight is overtaken, a turn in flight finishes,
  and from then on she publishes only `stopping` and `stopped`. Her start
  reads her package, her settings, which must load and switch her on before
  anything is written for her, merges her package's settings into her
  overlay, chooses her model, holds her to the plugins her package
  requires, a recommended one missing only warning, and to one memory
  provider, and builds her plugins with her confirmer. A start sent while
  one is in flight is answered when it settles, and one that failed stays
  failed until the next start or settings change. Her thread with the
  person is opened the first time a client opens it or a line comes for it,
  and opened again after a reload or a recovery, so no client reopens it. A
  turn the runtime itself fails leaves her failed and earns one restart:
  the lines queued behind it are refused, her thread is closed and her
  plugins shut down, and she starts again. A reload happens between turns,
  when what she would be built from now differs from what she was built
  from; lines sent meanwhile wait and land on her thread opened again. Her
  stop cancels her parked confirmations first, closes her thread, its end
  hooks run, and shuts her plugins down, saying what failed of that.
- **Confirmations.** A question an approval-gated call raises is parked
  under a fresh UUID with its deadline and the turn that raised it, and
  announced; it settles once, by the person's answer, its deadline, or her
  stop, and its settlement is announced once. An answer at or past the
  deadline settles it cancelled, whatever the timer has done: the client
  never judges the deadline. A question raised once her stop began settles
  cancelled at once, unannounced.
- **Submissions.** One turn per conversation and client message id within
  a run: a repeat while it runs joins it and one after it gets its outcome,
  an id reused for another line is refused, and a conversation remembers
  its last 32 settled submissions. Only an outcome whose line is in the log
  is remembered: a line that never reached it is its client's to send
  again under the same id. A line a run before this one took is the
  thread's to answer. The turn runs as a task of its own, so a client that
  stops waiting abandons nothing, and every delivery that reaches a
  character is announced as completed once, however it ended.
- **Reconcile.** One rule for boot and for every settings change: an
  enabled character who runs nothing starts, one who failed starts again,
  one who is ready and would be built from other settings now reloads, and
  a disabled one who still runs stops, as does one whose package left the
  roster. Passes never overlap: a request while one runs marks one more
  after it, so the newest roster has the last word. A settings change is
  announced at once and acted on behind its answer.
- **History.** A conversation's committed messages as one scrollback
  across her segments, newest page first and chronological within it, the
  cursor `v1:<segment>:<index>` naming where the next page ends; a limit is
  1 to 500, 100 unless given, and a cursor is one a page handed out.
- **Events** are announced in one order, and the turns in progress are
  folded from them in that order: a stream that opens with a snapshot reads
  it after it subscribes, so it misses nothing after it and holds at worst
  one event twice.
