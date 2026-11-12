# project02

The binary a person runs: `project02 serve` runs the daemon,
`project02 inspect` reports on a home, and `project02 telegram` runs the
Telegram connector beside the daemon; each prints its usage with `--help`.
It holds what no library decides: where the home is, the test switches,
the plugins compiled in, the signals and what is printed. Its library runs
the same daemon in another program's process, as the desktop shell does.

- **serve** takes `--store <dir>`, else `.project02` in the working
  directory, and `--init`, the consent to make a store there, which a
  terminal is asked for instead. Once it answers, it prints its address
  on stdout, `PROJECT02_GATEWAY=http://127.0.0.1:<port>/#token=<token>`,
  and its trouble on stderr. A second serve on a running home hands back
  that address; one started while the holder stops waits to take over.
- **The stop** is the first SIGINT, SIGTERM or SIGHUP, and a second ends
  the process at once. Every command exits 0, or 1 when something failed,
  which it says on stderr.
- **inspect** reads a home through the store's readers and writes nothing:
  a character's settings and the home's sign-in to a ChatGPT plan, as whom
  and on which plan and never a token, and the report asked for, as JSON.
- **The test switches** are read once at start and are never settings:
  `PROJECT02_TEST_PROVIDER=deterministic` answers for every character;
  `PROJECT02_TEST_DURATIONS` shortens the waits, `key=milliseconds` over
  `confirmation`, `pairing`, `silence`, the stream's `ping`, `grace` and
  the `minute` a heartbeat counts in, and for the connector `edit`;
  `PROJECT02_TEST_TELEGRAM_API` names the Bot API the connector reaches;
  `PROJECT02_TEST_APP_CATALOG` names the App Store's catalog in place of
  the build's own, which one constant beside the switches holds;
  `PROJECT02_TEST_APP_INTERNET=<base>` takes every request of her apps,
  one for `https://<host>/<path>?<query>` made at
  `<base>/<host>/<path>?<query>`, the rest of it unchanged;
  `PROJECT02_TEST_OPENAI_API=<base>` names where the OpenAI API is, in
  place of its own address; `PROJECT02_TEST_OPENAI_AUTH=<base>` names
  where OpenAI's sign-in is, in place of `https://auth.openai.com`; and
  `PROJECT02_TEST_CHATGPT_API=<base>` names where a ChatGPT plan's service
  is, in place of `https://chatgpt.com/backend-api/codex`.
