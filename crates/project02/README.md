# project02

The binary a person runs: the daemon, `project02 serve [--store <dir>]
[--init]`, a report on a home, `project02 inspect [--store <dir>]
[--character <id>] [--sessions | --session <id> | --conversations |
--conversation <id>]`, and the Telegram connector beside the daemon,
`project02 telegram [--store <dir>]`. It depends on p02-app,
p02-characters, p02-config, p02-core, p02-gateway, p02-plugins,
p02-role-model, p02-shared, p02-store and p02-telegram, and
holds what none of them decides: where the home is, the switches of a
test harness, the plugins compiled in, the signals that stop it, and what
it prints. Any other command is a usage error. Its library is the same
daemon for a program that runs it in its own process, as the desktop shell
does: `serve` with a stop the caller cancels and a console of the caller's,
and `ADDRESS_PREFIX`, which begins the line the address is said on.

- **The command line.** `serve` owns two flags: `--store <dir>`, the
  home, else `.project02` in the working directory, bound to its real
  path; and `--init`, the consent to make a store there. A flag given
  twice takes its last value. Anything else, `--help` and `--character`
  among it, is refused, `Unknown serve option: <arg>.`, with exit code 1.
- **The store.** A directory that holds nothing yet becomes a store only
  with the person's consent: `--init`, or on a terminal a yes to
  `No Project02 store at "<dir>". Create one there? [y/N]`. Anything
  else, a terminal that goes away, or a stop while asking exits 1 and
  writes nothing, and without a terminal the refusal says to run it again
  with `--init`. The store is made as a new home holds it: its marker, its
  data directory and its settings document. A directory that holds
  anything is the store's to adopt or refuse, before anything is written.
- **The switches**, read once at start and never settings:
  `PROJECT02_TEST_PROVIDER=deterministic` runs every character on the
  test provider, and `PROJECT02_TEST_DURATIONS` shortens the waits,
  `key=milliseconds` pairs over `confirmation`, `pairing`, `silence`,
  `heartbeat` and `grace`. An unknown key, or a wait that is no whole
  number of milliseconds above 0, refuses the start, saying why, before
  anything is bound or written.
- **The run.** The home is claimed, the daemon opened on it and its
  socket bound on the home's port, or on a free one when another program
  holds that one, which is said; the record is published, and then
  `PROJECT02_GATEWAY=http://127.0.0.1:<port>/#token=<token>` is the first
  other line on stdout. A record that could not be read is replaced, with
  a new token. A package discovery could not publish is said on stderr as
  `Character package <path>: <message>`; the roster comes up behind the
  address. While it serves, a character's failure, a failure of her work
  behind the conversation, and what opening her thread skipped because it
  could not be read are said on stderr as `<character>: <message>`.
- **The stop**, for serve and the connector alike, is the first SIGINT,
  SIGTERM or SIGHUP, or on Windows the first of the console's events, and
  a second of any kind ends the process at once with exit code 1. Serve's
  says `Stopping; finishing what is in flight.`, closes the server in its
  order, then releases the claim, so the record keeps the address without
  the run, and the lease goes last; a second signal leaves the lease to
  the kernel and the record naming the run, as after a crash. The exit
  code is 0; 1 when a character's failure was said during the stop, and
  when serve fails before it serves, which says `Error: <why>` on stderr
  and nothing on stdout.
- **The second serve.** On a home another process holds, serve asks the
  daemon its record names for its health, each question given the probe
  of 5 s. When it answers as this home's, its address is handed back,
  with its pid, and the exit code is 0. A holder that is stopping, or that
  has not answered as this home's, is said once; every half second the
  lease is tried and the holder asked again, for the hold of 30 s, and the
  home is taken over once its lease goes. A wait that runs out says to run
  serve again, with exit code 1, and a stop while waiting exits 1 quietly,
  never claiming the home on the way out.
- **Inspect** is a developer's tool. It reads a home through the store's
  own readers and writes nothing, ever: no store, marker, settings
  document or overlay, whatever needs repair. Its flags are read as
  serve's are: `--store` as serve takes it, `--character` an identifier,
  and one report, the last one named. The home is checked first, as every
  way into it is, and a folder that holds nothing reports an empty store.
- **The character** is the one named, whether or not she is switched on,
  else the one character the settings switch on, a character whose
  settings cannot be read counted on so that her damage is reported; none
  or several are refused naming them, and one not installed naming the
  installed ones. A package discovery could not publish is said on stderr,
  `Warning: Character package <path>: <message>`, and the report is of the
  healthy ones.
- **The report** of `--session <id>` is that session's records as her log
  stores them, one JSON object per line, the lines the read skipped warned
  of on stderr. Every other report is one JSON document on stdout,
  indented by two with a closing line feed: her settings as they stand,
  the part p02-config renders, secrets shown only as `[redacted]`, and
  beside them the listing asked for, if any: her sessions as her catalog
  lists them, a row it skipped warned of on stderr; the home's
  conversations; or one conversation with her segments of it in the order
  they continue one another. A refusal says what the store found, with
  exit code 1 and nothing on stdout.
- **The connector** is p02-telegram's, following the daemon the record of
  its home names: `--store` as serve takes it, its one flag, anything else
  refused as `Unknown telegram option: <arg>.`; `connected to …` and its
  bots' lines on stdout, its trouble on stderr. Its switches are read by
  serve's reader: `PROJECT02_TEST_DURATIONS` with the one key `edit`, the
  shortest wait between two edits of a draft, any other refused, serve's
  among them; and `PROJECT02_TEST_TELEGRAM_API`, an absolute http or
  https address with no credentials, query or fragment, the Bot API it
  reaches in Telegram's place. A refusal says why on stderr, with exit
  code 1 and nothing on stdout. The first stop ends every bot, each saying
  on stdout that it stopped, and exits 0 with nothing on stderr; a daemon
  of another protocol ends it with exit code 1.
