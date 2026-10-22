# project02

The daemon a person runs, `project02 serve [--store <dir>] [--init]`. It
depends on p02-app, p02-config, p02-gateway, p02-plugins, p02-role-model,
p02-shared and p02-store, and holds what none of them decides: where the
home is, the switches of a test harness, the plugins compiled in, the
signals that stop it, and what it prints. `inspect` and `telegram` come
in later steps; any other command is a usage error.

- **The command line.** `serve` owns two flags, each at most once:
  `--store <dir>`, the home, else `.project02` in the working directory,
  bound to its real path; and `--init`, the consent to make a store
  there. Anything else, `--help` and `--character` among it, is refused,
  `Unknown serve option: <arg>.`, with exit code 1.
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
  `heartbeat`, `grace`, `hold` and `probe`. Any other value refuses the
  start, saying why, before anything is bound or written.
- **The run.** The home is claimed, the daemon opened on it and its
  socket bound on the home's port, or on a free one when another program
  holds that one, which is said; the record is published, and then
  `PROJECT02_GATEWAY=http://127.0.0.1:<port>/#token=<token>` is the first
  other line on stdout. A record that could not be read is said on stderr
  as it is replaced, and the startup problems follow there, a setting in
  error as `Config: <message>` and a package discovery could not publish
  as `Character package <path> (<code>): <message>`; the roster comes up
  behind the address. While it serves, a character's failure and a
  failure of her work behind the conversation are said on stderr as
  `<character>: <message>`.
- **The stop** is the first SIGINT, SIGTERM or SIGHUP, or on Windows the
  first of the console's events. It says `Stopping; finishing what is in
  flight.`, closes the server in its order, then releases the claim, so
  the record keeps the address without the run, and the lease goes last.
  A second signal of any kind ends the process at once, the lease left to
  the kernel and the record naming the run, as after a crash. The exit
  code is 0; 1 when a character's failure was said during the stop, and
  when serve fails before it serves, which says `Error: <why>` on stderr
  and nothing on stdout.
- **The second serve.** On a home another process holds, serve asks the
  daemon its record names for its health, each question given the probe
  of 5 s. When it answers as this home's, its address is handed back,
  with its pid, and the exit code is 0. A holder that is stopping, that
  does not answer, that serves another home, or that has published no
  record yet is said once; every half second the lease is tried and the
  holder asked again, for the hold of 30 s, and the home is taken over
  once its lease goes. A wait that runs out says to run serve again, with
  exit code 1, and a stop while waiting exits 1 quietly, never claiming
  the home on the way out.
