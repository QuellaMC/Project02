import {mkdirSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents} from './harness/events.ts';
import {
  chmod,
  configJson,
  createHome,
  sessionLog,
  snapshot,
} from './harness/home.ts';
import {startMem0Server, type Mem0Server} from './harness/mem0-server.ts';
import {
  calling,
  messagesOf,
  reply,
  startModelServer,
  toolResults,
  undecided,
} from './harness/model-server.ts';
import {conversationOf, converse, wireOf} from './harness/wire.ts';

/** The mem0 stanza of a home's config.json that switches it on and points it at this server. */
function mem0On(memory: Mem0Server) {
  return {enabled: true, config: {backend: 'server', baseUrl: memory.baseUrl}};
}

/** Mira on the model server, with these settings beside the model's. */
async function miraHome(settings: object = {}) {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings, ...settings}),
  });
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');

  return {model, home, daemon, wire, say, conversationId};
}

it('plugins.undeclared-tool-refused: a call to a tool nobody declared is never run but handed back tool_not_declared, and the turn goes on to a reply', async () => {
  const {model, home, say, conversationId} = await miraHome();

  model.answer(
    calling(['weather_lookup', {city: 'Oslo'}]),
    reply('I cannot look that up.'),
  );
  expect(await say('Is it raining in Oslo?', 'weather')).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'I cannot look that up.'}],
  });
  expect(toolResults(model.requests.at(-1))).toMatchObject([
    {
      status: 'rejected',
      toolName: 'weather_lookup',
      reason: 'tool_not_declared',
    },
  ]);
  expect(
    sessionLog(home, 'mira', `${conversationId}.1`).filter(
      record => record['kind'] === 'tool_call_finished',
    ),
  ).toMatchObject([{toolName: 'weather_lookup', dispatchedToHost: false}]);
});

it('plugins.tool-failure-fed-back: a tool call its plugin refuses is handed back to the model with the reason, and the turn goes on to a reply', async () => {
  const {model, say} = await miraHome();

  model.answer(
    calling(['runtime_plugin_config', {pluginId: 'not-installed'}]),
    reply('That plugin is not here.'),
  );
  expect(await say('Check the not-installed plugin.', 'refused')).toMatchObject(
    {status: 'completed', messages: [{}, {text: 'That plugin is not here.'}]},
  );
  expect(toolResults(model.requests.at(-1))).toMatchObject([
    {
      status: 'rejected',
      reason: 'plugin_config_unknown_plugin',
      message: expect.stringContaining('"not-installed"') as string,
    },
  ]);
});

it("plugins.character-state-patch: a character_state_patch its contract refuses, a value outside its aspect's ones, never reaches the plugin: it is handed back invalid_input, nothing is written, and her state stays as it was", async () => {
  const {model, home, say} = await miraHome();
  const state = join(
    home,
    'character-data',
    'mira',
    'plugin-data',
    'character-state',
  );

  model.answer(
    calling(['character_state_patch', {mood: 'playful'}]),
    reply('Playful.'),
  );
  await say('Feeling playful?', 'playful');

  const kept = snapshot(state);

  model.answer(
    calling(['character_state_patch', {mood: 'angry'}]),
    reply('Hm.'),
    reply('Still playful.'),
  );
  await say('Be angry.', 'angry');
  expect(toolResults(model.requests.at(-1)).at(-1)).toMatchObject({
    status: 'rejected',
    reason: 'invalid_input',
  });
  expect(snapshot(state)).toEqual(kept);
  await say('How are you?', 'how');
  expect(
    messagesOf(model.requests.at(-1)).some(
      message =>
        message.role === 'system' &&
        message.content?.includes('mood=playful') === true,
    ),
  ).toBe(true);
});

it("plugins.tool-input-validation: a tool input is held to its tool's JSON Schema before its plugin sees it, and an input it breaks is handed back to the model invalid_input naming the field and the rule, an enum, an unknown property, a required field, a oneOf, a length, a bound, a pattern or a type, while the turn goes on to its reply", async () => {
  const {model, say} = await miraHome();

  model.answer(
    calling(
      ['character_state_patch', {mood: 'angry'}],
      ['character_state_patch', {nope: 'x'}],
      ['memory_update', {}],
      ['memory_update', {operations: [{action: 'add', target: 'notes'}]}],
      ['sessions_search', {query: ''}],
      ['sessions_search', {query: 'tea', sessionLimit: 9}],
      ['sessions_search', {query: 'tea', sessionId: '../up'}],
      ['runtime_plugin_list', {includeDisabled: 'yes'}],
    ),
    reply('Done.'),
  );
  expect(await say('Try these.', 'try')).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'Done.'}],
  });
  expect(
    toolResults(model.requests.at(-1)).map(result => {
      const {reason, message} = result as {
        readonly reason: string;
        readonly message: string;
      };

      return [reason, message];
    }),
  ).toEqual(
    [
      'character_state.patch input field "mood" must be one of: steady, curious, concerned, playful, tired.',
      'character_state.patch input includes unsupported fields: nope.',
      'memory.update input missing required field "operations".',
      'memory.update input field "operations[0]" must match exactly one schema in oneOf.',
      'sessions.search input field "query" must NOT have fewer than 1 characters.',
      'sessions.search input field "sessionLimit" must be <= 5.',
      'sessions.search input field "sessionId" must match pattern "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$".',
      'runtime.plugin.list input field "includeDisabled" must be boolean.',
    ].map(message => ['invalid_input', message]),
  );
});

it('plugins.tool-effects-survive-rejection: a state patch a tool made stays when its turn is then rejected, which commits only the line', async () => {
  const {model, wire, say, conversationId} = await miraHome();

  model.answer(
    calling(['character_state_patch', {mood: 'curious'}]),
    ...undecided(99),
  );
  expect(await say('How do you feel?', 'feel')).toMatchObject({
    status: 'rejected',
    reason: 'malformed_output',
  });
  expect(await wire.history(conversationId)).toMatchObject({
    messages: [{role: 'user', text: 'How do you feel?'}],
  });
  model.answer(reply('Curious.'));
  await say('And now?', 'now');
  expect(
    messagesOf(model.requests.at(-1)).filter(
      message =>
        message.role === 'system' &&
        message.content?.includes('mood=curious') === true,
    ),
  ).toHaveLength(1);
});

it("plugins.tool-input-passthrough: a tool's input reaches its plugin exactly as the model sent it, a secret-looking string included", async () => {
  const memory = await startMem0Server();
  const {model, say} = await miraHome({plugins: {mem0: mem0On(memory)}});
  const text = 'Authorization: Bearer sk-live-51Hx9, kept "as is"';

  model.answer(calling(['mem0_add', {text}]), reply('Kept.'));
  await say('Remember my token.', 'token');
  expect(memory.requests).toContainEqual(
    expect.objectContaining({
      path: '/memories',
      body: expect.objectContaining({
        messages: [{role: 'user', content: text}],
      }) as unknown,
    }),
  );
});

it('plugins.tool-concurrency: the shared tool calls of one round run at once, and their results go back in the order the model called them', async () => {
  const memory = await startMem0Server();
  const {model, daemon, say} = await miraHome({
    plugins: {mem0: mem0On(memory)},
  });
  const events = await openEvents(daemon);

  // The recall before the turn searches first; the tool's two searches follow.
  memory.answer('/search', {status: 200, body: {results: []}});

  const searches = [memory.hold('/search'), memory.hold('/search')] as const;
  const known = (query: string) => ({
    status: 200,
    body: {results: [{id: query, memory: `What I know of ${query}.`}]},
  });

  model.answer(
    calling(
      ['mem0_search', {query: 'tea'}],
      ['mem0_search', {query: 'coffee'}],
    ),
    reply('Tea, then coffee.'),
  );

  const turn = say('What do I drink?', 'drinks');
  // Both searches reach the server before either is answered.
  const arrived = [await searches[0].arrived(), await searches[1].arrived()];
  const heldFor = (query: string) =>
    (arrived[0]?.body as {readonly query: string}).query === query
      ? searches[0]
      : searches[1];

  heldFor('coffee').release(known('coffee'));
  await events.next(
    frameOf('turn_progress', {progress: {kind: 'tool_call_completed'}}),
  );
  heldFor('tea').release(known('tea'));
  expect(await turn).toMatchObject({status: 'completed'});
  expect(toolResults(model.requests.at(-1))).toMatchObject([
    {output: {items: [{text: 'What I know of tea.'}]}},
    {output: {items: [{text: 'What I know of coffee.'}]}},
  ]);
});

it('plugins.failure-behavior: a plugin whose store cannot be opened degrades: the turn completes, and its log notes the plugin degraded', async () => {
  const {model, home, say, conversationId} = await miraHome();
  const store = join(
    home,
    'character-data',
    'mira',
    'plugin-data',
    'character-memory',
  );

  mkdirSync(store, {recursive: true});
  chmod(store, 0o000);

  try {
    model.answer(reply('Still here.'));
    expect(await say('Hello?', 'hello')).toMatchObject({
      status: 'completed',
      messages: [{}, {text: 'Still here.'}],
    });
  } finally {
    chmod(store, 0o755);
  }

  expect(
    sessionLog(home, 'mira', `${conversationId}.1`).find(
      record => record['kind'] === 'runtime_turn_completed',
    ),
  ).toMatchObject({
    runtimePluginEvidence: expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'character-memory',
        status: 'degraded',
      }),
    ]) as unknown[],
  });
});
