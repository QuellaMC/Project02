# p02-telegram

The Telegram connector, `project02 telegram`: a client of the daemon's
socket, as the page is. It links p02-wire, p02-core and p02-shared alone,
so it reads the daemon in the wire's own types and reaches nothing else of
it. Its caller prints the lines it is handed, none of which carries a
token.

- It finds the daemon by the home's `daemon.json` and follows its event
  stream as the `telegram` connector, picking up after the last frame it
  applied.
- It runs a bot for each token the daemon's read of its settings holds,
  the home's management bot and each character's own, and holds every
  update and frame until a read lands. An account the settings do not hold
  is asked for with a pairing request, and nothing it sends is carried.
- It tells the daemon how each bot stands, which health shows: on, under
  the username Telegram gave it, or what keeps its messages from it, its
  token refused, Telegram out of reach, another program polling the token
  or a webhook set on it. The whole table goes on every stream it opens
  and whenever a bot's standing changes, and a post that fails is made
  again while that stream is open. Health that comes back saying only
  that moved no setting: nothing is read for it, and no bot is held.
- A character's bot lets Telegram go of a message only once its line is in
  her inbox, shows her reply as she writes it, and makes a confirmation its
  line raised a card with Approve and Deny. The management bot answers
  `/status`, `/pending`, `/approve` and `/deny`, and shows every
  confirmation and pairing request as a card.
