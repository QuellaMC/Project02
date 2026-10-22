# p02-telegram

The Telegram connector: a client of the daemon's socket, run beside it as
`project02 telegram`, that answers in Telegram for the home and its
characters. It depends on p02-app, p02-config, p02-core, p02-gateway and
p02-shared, and reads every answer and frame of the daemon with the types
the daemon writes them with; its caller resolves the home, the test
switches and the signals, and prints the lines it is handed.

- **The daemon.** It is found by the home's `daemon.json`, read again
  every 2 s while it is absent or unreadable, and followed over its event
  stream as the `telegram` connector, so health says the connector is on.
  A stream that ends, breaks, or meets a daemon down or stopping (503) is
  opened again a second later from the frame last applied; a record that
  names another port or token then is followed afresh, the bots kept. A
  token the daemon refuses (401) is said once and the record read again.
  A `ready` is read for its protocol first: a daemon of another version
  ends the connector with exit 1, both versions said.
- **The settings.** The connector config is read on every `ready` and
  every `health_changed`, and once on a stream the daemon resumed; only
  the newest read's answer is applied, and a read that fails is said once
  and tried again, backing off from a second to thirty. Every read holds
  the bots until it lands, and so does a lost stream, until a read begun
  after the loss lands: no update is handled, no frame applied, not even
  one a bot was handed before, no write to a paired account made, and the
  frames since are kept and handed on in order once it does, a `ready`'s
  snapshot first. The snapshot is kept moved on by every frame, for a bot
  that catches up.
- **The bots.** One per token, by the daemon's judgment of each entry: the
  home's management bot while its entry is active and holds
  `managementBotToken`, then each character's while hers is active and
  holds `botToken`; a token an earlier bot holds is not started again, and
  that is said. A bot is one owner's: a token moved to another owner
  starts a bot of its own, and a read that keeps the owner hands the
  running bot its new settings. A bot asks Telegram who it is, then
  long-polls, fifty seconds at a time, handing each update on in order
  and asking past a batch once all of it was. A token Telegram refuses
  is named once with the settings page to replace it on, and the bot goes
  quiet; another program polling the token (409) is waited out 30 s, the
  bot writing nothing until its polls are its own again, when it catches
  up from the snapshot; a webhook left on the token is removed; a pause
  Telegram asks for is kept; and a Telegram out of reach is said once and
  backed off from, from a second to thirty, until it answers again.
- **The Bot API** is eight methods over `reqwest`, each bounded, and each
  answer read leniently out of Telegram's envelope: an update that does
  not decode still carries its id, so the next poll asks past it. Every
  outcome is a result or a failure, never an error, and no sentence it
  makes carries the token its URL holds.
- **A character's bot** opens her thread, carries a paired account's
  lines to her one at a time, stamped `telegram:<bot username>` and
  `<bot id>.<chat id>.<message id>`, and shows her conversation in every
  paired chat as the stream tells it: a reply posted with its first
  words, edited at most once an interval, 1.5 s, and ended as committed;
  another surface's turn too while Mirror is on. A confirmation a turn of
  its line raised is a card in that line's chat.
- **The management bot** answers `/status`, `/pending`, `/approve <code>`
  and `/deny <code>`, and shows every confirmation of the home, naming the
  surface it was raised on, and every pairing request as a card.
- **The gate.** An account the settings do not hold is asked for with a
  pairing request to the daemon and told its code; nothing it sends is
  carried, and it is told how its request ended.
- **The outbox** makes a bot's calls to Telegram one at a time, in the
  order decided, none while another program's polls hold the token, and
  each write to a paired account's chat only while the account is
  paired, both checked as its turn comes; a text longer than Telegram's
  4096 goes in as many messages as it takes, counted in UTF-16 units,
  stopping at one that could not be sent.
- **The stop** cancels every bot, dropping each call in flight, so the
  daemon sees a delivery and a pairing request given up while its turn
  runs on, and answers once every bot has ended.
