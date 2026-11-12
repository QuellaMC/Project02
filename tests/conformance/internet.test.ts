import {expect, it} from 'vitest';

import {fileOf, lookup} from './harness/apps.ts';
import {inspect, startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents} from './harness/events.ts';
import {configJson, createHome} from './harness/home.ts';
import {startInternetServer} from './harness/internet-server.ts';
import {
  calling,
  reply,
  startModelServer,
  toolResults,
  type ModelServer,
} from './harness/model-server.ts';
import {conversationOf, converse, saveConfig, wireOf} from './harness/wire.ts';

/** The person's key for their Tavily account, which nothing a client reads may hold. */
const key = 'tvly-test-secret-0123456789';

/** What a screen's look says when it tries to reach the internet. */
const unreached =
  'TypeError: phone.net.fetch reaches nothing here: only an action reaches the internet';

/** A home where Mira answers through `model`, the person goes by Sam, her heartbeat is off, and the home's settings hold `tavilyKey` when given one. */
function internetHome(model: ModelServer, tavilyKey?: string): string {
  return createHome({
    'config.json': configJson({
      project02: {...model.settings, userDisplayName: 'Sam'},
      ...(tavilyKey === undefined
        ? {}
        : {plugins: {phone: {config: {tavilyApiKey: tavilyKey}}}}),
    }),
    'character-data': {
      mira: {'config.json': configJson({project02: {heartbeat: 'off'}})},
    },
  });
}

/** The person's Tavily account as health says it, its key set or not. */
function tavily(hasKey: boolean): object {
  return {
    id: 'tavily',
    name: 'Tavily',
    hasKey,
    keyFrom: 'Get a free key at tavily.com.',
  };
}

/** Lookup as a client reads it among her apps: what it may do, and the person's Tavily account, its key set or not. */
function lookupUsing(hasKey: boolean): object {
  return {
    id: 'lookup',
    itMay: [
      'Keep its own data',
      'Reach the internet at api.tavily.com and api.open-meteo.com',
      'Use your Tavily account',
    ],
    account: {id: 'tavily', name: 'Tavily', hasKey},
  };
}

/** Her taking Lookup's fetch_all on these requests. */
function fetching(...requests: readonly object[]): readonly [string, object] {
  return ['phone_use', {app: 'lookup', action: 'fetch_all', input: {requests}}];
}

it("internet.fetch: she uses an app that reaches the internet and reads what each request came to: each reached the stand-in as the script gave it, with the person's key for Tavily's host and none for a host of no account; any status is an answer and a redirect is not followed; a body past what the phone takes is said to the app in a sentence; a look at the app's screen reaches nothing; and the key is in nothing a client reads, the stream, her phone or inspect, though the service echoed it", async () => {
  const model = await startModelServer();
  const internet = await startInternetServer();
  const home = internetHome(model, key);
  const daemon = await startDaemon(home, internet.env);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);

  expect(await wire.addApp('mira', fileOf(lookup))).toMatchObject({
    status: 'ok',
  });

  const say = await converse(wire, 'mira');

  internet.answer('/api.tavily.com/search', request => ({
    status: 200,
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      answer: 'Green tea',
      seen: request.headers.authorization,
    }),
  }));
  internet.answer('/api.open-meteo.com/v1/forecast?city=London', {
    status: 503,
    body: 'Busy',
  });
  internet.answer('/api.open-meteo.com/v1/moved', {
    status: 302,
    headers: {location: 'https://api.open-meteo.com/v1/forecast'},
    body: 'Moved',
  });
  internet.answer('/api.open-meteo.com/v1/huge', {
    status: 200,
    body: 'x'.repeat(256 * 1024 + 1),
  });
  model.answer(
    calling(
      fetching(
        {
          url: 'https://api.tavily.com/search',
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: '{"query":"tea"}',
        },
        {url: 'https://api.open-meteo.com/v1/forecast?city=London'},
        {url: 'https://api.open-meteo.com/v1/moved'},
        {url: 'https://api.open-meteo.com/v1/huge'},
      ),
    ),
    reply('Green tea, and the weather is busy.'),
  );
  await say('Look up tea.', 'tea');

  const came = [
    {
      status: 200,
      body: JSON.stringify({answer: 'Green tea', seen: 'Bearer [redacted]'}),
    },
    {status: 503, body: 'Busy'},
    {status: 302, body: 'Moved'},
    {error: 'Its server answered more than the phone takes.'},
  ];

  expect(toolResults(model.requests.at(-1))).toMatchObject([
    {
      status: 'accepted',
      pluginId: 'phone',
      toolName: 'phone.use',
      output: {answer: came, view: 'found'},
    },
  ]);
  expect(internet.requests).toMatchObject([
    {
      method: 'POST',
      path: '/api.tavily.com/search',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: '{"query":"tea"}',
    },
    {method: 'GET', path: '/api.open-meteo.com/v1/forecast?city=London'},
    {method: 'GET', path: '/api.open-meteo.com/v1/moved'},
    {method: 'GET', path: '/api.open-meteo.com/v1/huge'},
  ]);
  expect(
    internet.requests.slice(1).map(request => request.headers.authorization),
  ).toEqual([undefined, undefined, undefined]);

  const screen = await wire.phoneScreen('mira', 'lookup', 'found');
  const phone = await wire.phone('mira');

  expect(screen).toEqual({
    status: 'ok',
    screen: {
      items: [
        {kind: 'text', text: JSON.stringify(came)},
        {kind: 'text', text: unreached},
      ],
    },
  });
  expect(phone).toMatchObject({
    status: 'ok',
    front: {appId: 'lookup', viewId: 'found', screen: {items: [{}, {}]}},
  });
  expect(internet.requests).toHaveLength(4);

  const {conversationId} = await conversationOf(wire, 'mira');
  const settings = inspect(['--store', home]);
  const session = inspect([
    '--store',
    home,
    '--session',
    `${conversationId}.1`,
  ]);

  expect(await settings.exit(), settings.stderr()).toBe(0);
  expect(await session.exit(), session.stderr()).toBe(0);
  expect(session.stdout()).toContain('Bearer [redacted]');

  for (const read of [
    JSON.stringify(events.frames),
    JSON.stringify(screen),
    JSON.stringify(phone),
    settings.stdout(),
    session.stdout(),
  ]) {
    expect(read).not.toContain(key);
  }
});

it("internet.no-key: health says the person's Tavily account, its key not set and where one comes from; Lookup, once the person adds it, says among her apps what it may do and that it uses that account; with no key a request on it is not made, and the app is told in a sentence naming the person, which she reads; once the person sets the key, health says so on the stream, her phone says so too, and neither holds the key", async () => {
  const model = await startModelServer();
  const internet = await startInternetServer();
  const daemon = await startDaemon(internetHome(model), internet.env);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);

  expect(await wire.health()).toMatchObject({accounts: [tavily(false)]});
  expect(await wire.addApp('mira', fileOf(lookup))).toMatchObject({
    status: 'ok',
    app: lookupUsing(false),
  });
  expect(await wire.phone('mira')).toMatchObject({
    apps: [{id: 'clock'}, lookupUsing(false), {id: 'store'}],
  });

  const say = await converse(wire, 'mira');

  model.answer(
    calling(
      fetching({
        url: 'https://api.tavily.com/search',
        method: 'POST',
        body: '{"query":"tea"}',
      }),
    ),
    reply('I cannot search yet.'),
  );
  await say('Look up tea.', 'tea');

  expect(toolResults(model.requests.at(-1))).toMatchObject([
    {
      status: 'accepted',
      toolName: 'phone.use',
      output: {
        answer: [
          {
            error:
              "This needs Sam's Tavily account, and its key is not in Settings yet.",
          },
        ],
      },
    },
  ]);
  expect(internet.requests).toEqual([]);

  await saveConfig(
    wire,
    {scope: 'global'},
    {
      kind: 'section_field_set',
      namespace: 'plugins',
      id: 'phone',
      field: 'tavilyApiKey',
      value: key,
    },
  );
  await events.next(
    frameOf('health_changed', {health: {accounts: [tavily(true)]}}),
  );

  const phone = await wire.phone('mira');

  expect(phone).toMatchObject({
    apps: [{id: 'clock'}, lookupUsing(true), {id: 'store'}],
  });
  expect(JSON.stringify([events.frames, phone])).not.toContain(key);
});
