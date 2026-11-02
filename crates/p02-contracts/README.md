# p02-contracts

What the runtime and what it hosts agree on: the plugins compiled into
the daemon and the model providers it calls. It depends on p02-core and
p02-shared, and the runtime reaches plugins and providers only through it.

- **Plugins.** A plugin's manifest is authored once, in its
  `project02.plugin.json` (format `project02.plugin.v2`: `format`,
  `manifest`, and a `$schema` for editors), and exists only validated:
  every object in it is closed, and a refusal names the first rule the
  manifest breaks and its machine reason. Its code implements
  `RuntimePlugin`, and a `Registration` holds the code to the manifest: a
  plugin with tools declares `tool_provider` and `handle_tool_call`,
  requests `model_input: write`, and names each tool once.
- **Hooks.** The host calls only what a manifest declares, each hook under
  its plugin's one budget and its own cancellation token. Cancellation is
  cooperative: every call on a capability handle (the character store, the
  session history, the opening of a plugin database) checks the token
  before it acts, so a hook past its deadline finishes the call it is in and
  starts nothing more, and store writes end at the deadline. The host hears
  a hook it cancelled for a second more, so what it gives up with, or the
  report of what it could not finish, is the answer recorded. The
  store crate implements what the handles reach, one `CharacterStorage`
  per character, and it alone opens a database. What a plugin returns,
  the host stamps into records held to the JSON limits, so a plugin never
  writes another turn's record or another plugin's.
- **Tools.** A tool's input contract is one JSON Schema document, draft 7,
  with an object root, admitted only when every keyword in it is enforced
  as written; in a pattern, `.` keeps its JavaScript meaning. A call is
  made only with input its tool's contract admits: a refused input names
  the field and the rule, and the model is told so. A tool that asks the
  person first prepares each call, with its store read-only and no
  database, and changes nothing: a call it refuses is refused without
  asking, the person is shown what the call would do, and the host applies
  the prepared effect only on a yes.
- **The model.** A provider is a `RoleModelAdapter` over the chat wire,
  and answers with what the model wrote or with how the provider failed.
  `DecisionResult::parse` is the one judge of what a model round wrote:
  anything the decision contract does not allow is `malformed_output`,
  with details the model is told in its next round. One grammar reads the
  reasoning a model leaks into a reply, whole or as it streams. The tool
  calls a round replays and the exchange it had with its provider are kept
  with every credential-named value redacted.
- **Config.** A plugin's config section declares its fields, and a
  section declared in code, as the host's settings and the connectors'
  are, meets the same rules. One judge decides whether a value fits a
  field, a secret's being a string that is not blank, so a secret is
  declared only of a type that holds one, and a factory receives what its
  section resolves to: each field's authored value when the field accepts
  it, or else its default, with every required field set.
