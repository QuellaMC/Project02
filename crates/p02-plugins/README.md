# p02-plugins

The plugin host and the plugins compiled into the daemon. It depends on
p02-contracts, p02-core, p02-memory, p02-phone and p02-shared.

Each plugin keeps its descriptor, `project02.plugin.json`, beside its
code: the manifest of its hooks, its tools, its settings, the access it
requests and how a settings page draws it. `list::plugins` holds every
plugin compiled in, the host's own `runtime.plugin` first and the rest in
id order, each with its factory and the check of whether its settings are
enough to build it, made by the code the factory builds it with. A
character's host is built from the plugins her settings switch on and that
check finds set up, each by its factory from the values her settings give
it and checked against its manifest, but for two the host builds itself:
its own, linked to it, and her phone, handed the App Store's catalog and
the internet her apps reach. When her settings change, she gets a host
built anew.

The host's rules:

- A plugin reaches what its manifest requests and nothing else, and a
  tool name belongs to one plugin.
- Each hook runs under its plugin's budget and failure policy: one
  before the model's call degrades or refuses the turn, a tool call is
  refused with a reason the model reads, and the hooks after a commit and
  at shutdown are reported, never thrown.
- Nothing a plugin returns reaches the model, the person or the log
  unless it fits the record and JSON limits, credential-named values
  redacted; a breach fails the plugin.
- A round's calls run in the model's order, and a call of a tool the
  model was not offered is refused. A tool that asks first is prepared
  only reading, and applied only on the person's yes.

The plugins: `runtime.plugin`, which lists the plugins she runs, shows one
plugin's settings and, on the person's yes, changes a field the model may
change in her own settings; session history; mem0, whose account is the
home's to set up; character state; character memory; her phone, whose
apps, those it comes with and those installed on it, the App Store last,
she is told of before each call as her phone's store lists them, each the
person said may not wake her saying so beside its name, with the person's
name as her notes say it; she opens and acts in them through two tools,
and, while her settings' Ask to Install Apps is on, asks the person to
install from the App Store through a third, which is prepared reading the
catalog and fetching and judging the app, its preview saying whether the
app wakes her, whether it reaches the internet and the name of the
person's account it uses, and installs the text judged on their yes; and
reply-style, the tone she writes in and a signoff, each character's own.

`AppCatalog` is the one reader of the App Store's catalog, which the daemon
makes from the base the binary resolved: `catalog.json`, and one entry's
app at `apps/<id>/<version>.js`, each request within 8 seconds, through the
client every service is reached with, taking at most 256 KiB of the
catalog and what a text file holds of an app. `installable` is the one path
by which an app of the App Store is installed, her ask's preparation and
the person's own hand alike: what it refuses, what it replaces, and the
text it judged. It takes the phone's one rule of how an app of the store
stands on her phone, so it never puts an older version over hers. Nothing
is fetched under a lease: her opening the App Store reads its catalog
before her phone's store is leased, and `installable` reads her phone
between its requests.

`AppInternet` is the one seam that makes her apps' requests, built as the
catalog's reader is: through the same client, made at its first request,
which follows no redirect; any status is an answer, its body read as text
up to 256 KiB, and the requests of one call share 20 seconds. What is no
answer is said to the app in a plain sentence naming no address. Under the
test switch every request goes below the stand-in's base by its host.
`phone.use` runs the action under her phone's lease, and while the action
asks for a request or a question, makes the request, or answers the
question that her phone cannot ask yet, with no lease held, and runs the
action again at the same moment with what came of it. A request for an
account of the person's carries `Authorization: Bearer` and the key the
home's settings hold for it, `tavilyApiKey`, a secret of the home's alone
that she cannot change; with none set the request is not made, and the
app is told so in a sentence naming the person. `keyed_accounts` says which accounts have a
key her phone sends, by the rule her phone takes one by, so what a client
is told of an account is what her phone does. The key reaches no log,
record or app, and an answer that echoes it has it redacted. The phone's
budget, 30 seconds, is the room a call that fetches has.
