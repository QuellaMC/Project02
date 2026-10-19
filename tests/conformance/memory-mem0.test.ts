import {writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {startDaemon} from './harness/daemon.ts';
import {
  configJson,
  createHome,
  sessionLog,
  sessionRecords,
} from './harness/home.ts';
import {startMem0Server, type Mem0Server} from './harness/mem0-server.ts';
import {
  calling,
  messagesOf,
  reply,
  startModelServer,
  toolResults,
  type ModelRequest,
  type ModelServer,
} from './harness/model-server.ts';
import {conversationOf, converse, wireOf} from './harness/wire.ts';

/** A home's config.json: Mira on the model server, her mem0 on the stub backend with these settings. */
function mem0Config(
  model: ModelServer,
  mem0: Mem0Server,
  settings: Readonly<Record<string, string>>,
  project02: object = {},
): string {
  return configJson({
    project02: {...model.settings, ...project02},
    plugins: {
      mem0: {enabled: true, config: {baseUrl: mem0.baseUrl, ...settings}},
    },
  });
}

/** The person's message as the model received it, fences included. */
function lineOf(request: ModelRequest | undefined): string {
  return (
    messagesOf(request).findLast(message => message.role === 'user')?.content ??
    ''
  );
}

/** The items a plugin handed the round, as the round's record keeps them. */
function contextItemsOf(record: Record<string, unknown>): unknown[] {
  const found: unknown[] = [];
  const look = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const element of value) {
        look(element);
      }
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'pluginContextItems' && Array.isArray(inner)) {
          found.push(...(inner as unknown[]));
        } else {
          look(inner);
        }
      }
    }
  };

  look(record);
  return found;
}

/** What mem0 recorded about each turn it was handed after the commit. */
function capturesOf(home: string): unknown[] {
  return sessionRecords(home, 'mira', 'after_turn_committed').map(record =>
    (
      record['runtimePluginEvidence'] as readonly {readonly pluginId: string}[]
    ).find(evidence => evidence.pluginId === 'mem0'),
  );
}

it('memory.mem0-wire: the server backend asks POST /search and hands the whole turn, under its session and with its provenance, to POST /memories at the baseUrl, an m0sk_ key as X-API-Key; the platform backend speaks v3 under Token auth; a redirect, an unreadable body or row, or an answer shaped for the other backend is an error, never an empty result, and no error carries the key', async () => {
  const model = await startModelServer();
  const server = await startMem0Server();
  const serverKey = 'm0sk_server-secret';
  const home = createHome({
    'config.json': mem0Config(model, server, {
      backend: 'server',
      apiKey: serverKey,
    }),
  });
  const wire = wireOf(await startDaemon(home));
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const capture = server.hold('/memories');

  model.answer(reply('I will.'));
  await say('Remember the lighthouse.', 'lighthouse');

  const captured = await capture.arrived();
  const [{eventId} = {}] = sessionRecords(
    home,
    'mira',
    'runtime_event_received',
  );

  capture.release({status: 200, body: {results: [{id: 'mem-1'}]}});
  expect(server.requests[0]).toMatchObject({
    method: 'POST',
    path: '/search',
    headers: {'x-api-key': serverKey},
    body: {
      query: 'Remember the lighthouse.',
      user_id: 'project02-user',
      agent_id: 'mira',
      limit: 5,
    },
  });
  expect(captured).toMatchObject({
    method: 'POST',
    path: '/memories',
    headers: {'x-api-key': serverKey},
    body: {
      messages: [
        {role: 'user', content: 'You: Remember the lighthouse.'},
        {role: 'assistant', content: 'Mira: I will.'},
      ],
      user_id: 'project02-user',
      agent_id: 'mira',
      run_id: `${conversationId}.1`,
      infer: true,
      metadata: {project02_sources: [eventId]},
    },
  });
  expect(server.requests.map(request => request.headers.authorization)).toEqual(
    server.requests.map(() => undefined),
  );

  server.answer(
    '/search',
    {status: 200, body: {results: []}},
    {status: 302, headers: {location: `${server.baseUrl}/elsewhere`}},
    {status: 401, body: {detail: `The key ${serverKey} was rejected.`}},
    {status: 200, body: 'not json'},
    {status: 200, body: {results: [{memory: 'A row without an id.'}]}},
  );
  server.answer('/memories', {
    status: 200,
    body: {event_id: 'evt-queued', status: 'PENDING'},
  });
  model.answer(
    calling(['mem0_search', {query: 'one'}]),
    calling(['mem0_search', {query: 'two'}]),
    calling(['mem0_search', {query: 'three'}]),
    calling(['mem0_search', {query: 'four'}]),
    calling(['mem0_add', {text: 'The lighthouse is red.'}]),
    reply('Nothing came back.'),
  );
  await say('What do you remember?', 'errors');

  const platform = await startMem0Server();
  const platformKey = 'platform-secret';
  const sayToPlatform = await converse(
    wireOf(
      await startDaemon(
        createHome({
          'config.json': mem0Config(model, platform, {
            backend: 'platform',
            apiKey: platformKey,
          }),
        }),
      ),
    ),
    'mira',
  );
  const queued = platform.hold('/v3/memories/add/');

  model.answer(reply('Noted.'));
  await sayToPlatform('Remember the harbor.', 'harbor');
  expect(await queued.arrived()).toMatchObject({
    method: 'POST',
    headers: {authorization: `Token ${platformKey}`},
    body: {
      messages: [
        {role: 'user', content: 'You: Remember the harbor.'},
        {role: 'assistant', content: 'Mira: Noted.'},
      ],
      user_id: 'project02-user',
      agent_id: 'mira',
      infer: true,
    },
  });
  queued.release({status: 200, body: {event_id: 'evt-1', status: 'PENDING'}});
  expect(platform.requests[0]).toMatchObject({
    method: 'POST',
    path: '/v3/memories/search/',
    headers: {authorization: `Token ${platformKey}`},
    body: {
      query: 'Remember the harbor.',
      filters: {user_id: 'project02-user', agent_id: 'mira'},
      top_k: 5,
    },
  });
  platform.answer('/v3/memories/add/', {
    status: 200,
    body: {results: [{id: 'mem-9'}]},
  });
  model.answer(
    calling(['mem0_add', {text: 'The harbor is quiet.'}]),
    reply('Hm.'),
  );
  await sayToPlatform('Keep that.', 'keep');

  const errors = [
    ...toolResults(
      model.requests.findLast(request =>
        lineOf(request).startsWith('What do you remember?'),
      ),
    ),
    ...toolResults(model.requests.at(-1)),
  ];

  expect(errors).toEqual(
    [
      ['mem0.search', 'HTTP 302'],
      ['mem0.search', 'HTTP 401'],
      ['mem0.search', 'unreadable'],
      ['mem0.search', 'unreadable'],
      ['mem0.add', 'unreadable'],
      ['mem0.add', 'unreadable'],
    ].map(([toolName = '', problem = '']) => ({
      status: 'rejected',
      pluginId: 'mem0',
      toolName,
      reason: 'handler_failed',
      message: expect.stringContaining(problem) as string,
    })),
  );

  for (const key of [serverKey, platformKey]) {
    expect(JSON.stringify(errors)).not.toContain(key);
  }

  // The redirect was never followed, and the key the backend echoed is in
  // no record the turn left.
  expect(server.requests.map(request => request.path)).not.toContain(
    '/elsewhere',
  );
  expect(
    JSON.stringify(sessionLog(home, 'mira', `${conversationId}.1`)),
  ).not.toContain(serverKey);
});

it("memory.mem0-capture: mem0 takes each turn behind its answer, as the character's own under the speakers' names the session recorded; what is queued is sent before a stop ends the process, and once eight wait the next turns are not queued, which health then says", async () => {
  const model = await startModelServer();
  const mem0 = await startMem0Server();
  const named = (userDisplayName: string) =>
    mem0Config(model, mem0, {backend: 'server'}, {userDisplayName});
  const home = createHome({'config.json': named('Sam')});
  const first = await startDaemon(home);
  const say = await converse(wireOf(first), 'mira');
  const held = mem0.hold('/memories');
  const captures = () =>
    mem0.requests.filter(request => request.path === '/memories');

  model.answer(reply('Reply 1.'));

  // The turn answers first; its capture reaches the backend behind it.
  const answered = say('Line 1.', 'line-1');
  const captured = held.arrived();

  expect(
    await Promise.race([
      answered.then(() => 'answered'),
      captured.then(() => 'captured'),
    ]),
  ).toBe('answered');
  expect(await answered).toMatchObject({status: 'completed'});
  expect(await captured).toMatchObject({
    body: {
      agent_id: 'mira',
      messages: [
        {role: 'user', content: 'Sam: Line 1.'},
        {role: 'assistant', content: 'Mira: Reply 1.'},
      ],
    },
  });

  for (let turn = 2; turn <= 10; turn += 1) {
    model.answer(reply(`Reply ${String(turn)}.`));
    await say(`Line ${String(turn)}.`, `line-${String(turn)}`);
  }

  expect(captures()).toHaveLength(1);
  expect(capturesOf(home)).toMatchObject([
    ...Array.from({length: 8}, () => ({status: 'accepted'})),
    {
      status: 'degraded',
      summary: expect.stringContaining('not queued') as string,
    },
    {status: 'degraded'},
  ]);
  expect(
    sessionRecords(home, 'mira', 'runtime_turn_completed').map(record =>
      (
        record['runtimePluginTurnEvidence'] as {
          readonly health: readonly {readonly pluginId: string}[];
        }
      ).health.find(health => health.pluginId === 'mem0'),
    )[9],
  ).toMatchObject({
    status: 'degraded',
    summary: expect.stringContaining('backlog is full') as string,
  });

  first.signal('SIGINT');
  await first.printed('Stopping; finishing what is in flight.');
  held.release({status: 200, body: {results: [{id: 'mem-1'}]}});
  await first.exit();
  expect(
    captures().map(
      request =>
        (
          request.body as {
            readonly messages: readonly {readonly content: string}[];
          }
        ).messages[0]?.content,
    ),
  ).toEqual(Array.from({length: 8}, (_, at) => `Sam: Line ${String(at + 1)}.`));

  writeFileSync(join(home, 'config.json'), named('Samuel'));

  const again = await converse(wireOf(await startDaemon(home)), 'mira');
  const renamed = mem0.hold('/memories');

  model.answer(reply('Reply 11.'));
  await again('Line 11.', 'line-11');
  expect(await renamed.arrived()).toMatchObject({
    body: {
      messages: [
        {role: 'user', content: 'Sam: Line 11.'},
        {role: 'assistant', content: 'Mira: Reply 11.'},
      ],
    },
  });
  renamed.release({status: 200, body: {results: [{id: 'mem-11'}]}});
});

it('memory.mem0-recall: before a turn, what mem0 recalls rides the line in the recalled-memory fence, five items at most and each bounded, each recorded with its source; an empty recall adds nothing, and a failing backend leaves the turn to complete without it', async () => {
  const model = await startModelServer();
  const mem0 = await startMem0Server();
  const home = createHome({
    'config.json': mem0Config(model, mem0, {backend: 'server'}),
  });
  const say = await converse(wireOf(await startDaemon(home)), 'mira');
  const memories = [
    'Sam likes tea.',
    'Sam lives by the sea.',
    'Sam has a cat.',
    'Sam reads at night.',
    'x'.repeat(700),
    'Sam hums when thinking.',
  ];

  mem0.answer(
    '/search',
    {
      status: 200,
      body: {
        results: memories.map((memory, at) => ({
          id: `mem-${String(at)}`,
          memory,
          score: 0.9,
        })),
      },
    },
    {status: 200, body: {results: []}},
    {status: 500},
  );
  model.answer(reply('Tea.'), reply('Hm.'), reply('Still here.'));

  for (const [line, id] of [
    ['What do I like?', 'recalled'],
    ['Anything else?', 'empty'],
    ['And now?', 'failing'],
  ] as const) {
    expect(await say(line, id), id).toMatchObject({status: 'completed'});
  }

  const [recalled, empty, failing] = model.requests.map(lineOf);
  const fence = recalled?.split('\n\n<recalled_memory>\n');

  expect(fence?.[0]).toBe('What do I like?');
  expect(fence?.[1]?.endsWith('\n</recalled_memory>')).toBe(true);
  expect(fence?.[1]?.split('\n').filter(row => row.startsWith('- '))).toEqual([
    ...memories.slice(0, 4).map(memory => `- ${memory}`),
    `- ${'x'.repeat(597)}...`,
  ]);
  expect([empty, failing]).toEqual(['Anything else?', 'And now?']);
  // The recall before each turn, as its record marks it: the failing backend degrades the turn, an empty recall does not.
  expect(
    sessionRecords(home, 'mira', 'runtime_turn_completed').map(record =>
      (
        record['runtimePluginEvidence'] as readonly {
          readonly pluginId: string;
          readonly evidenceKind: string;
          readonly status: string;
        }[]
      )
        .filter(
          entry =>
            entry.pluginId === 'mem0' &&
            entry.evidenceKind === 'before_role_model_call',
        )
        .map(entry => entry.status),
    ),
  ).toEqual([['accepted'], ['accepted'], ['degraded']]);

  // Each recalled item is recorded with the memory it came from.
  const [recalledRound] = sessionRecords(home, 'mira', 'role_model_round');

  expect(contextItemsOf(recalledRound ?? {})).toMatchObject(
    memories.slice(0, 5).map((_, at) => ({
      pluginId: 'mem0',
      kind: 'memory',
      sourceReferences: [{kind: 'memory', id: `mem-${String(at)}`}],
    })),
  );
});

it('memory.mem0-search-tool: mem0.search answers the model with at most five items, each bounded and sourced to its memory, and a search that finds nothing is answered all the same', async () => {
  const model = await startModelServer();
  const mem0 = await startMem0Server();
  const say = await converse(
    wireOf(
      await startDaemon(
        createHome({
          'config.json': mem0Config(model, mem0, {backend: 'server'}),
        }),
      ),
    ),
    'mira',
  );
  const memories = Array.from({length: 7}, (_, at) =>
    at === 4 ? 'y'.repeat(700) : `Memory ${String(at)}.`,
  );

  mem0.answer(
    '/search',
    {status: 200, body: {results: []}},
    {
      status: 200,
      body: {
        results: memories.map((memory, at) => ({
          id: `mem-${String(at)}`,
          memory,
          score: 0.5,
        })),
      },
    },
    {status: 200, body: {results: []}},
  );
  model.answer(
    calling(['mem0_search', {query: 'memories'}]),
    calling(['mem0_search', {query: 'nothing at all'}]),
    reply('That is all.'),
  );
  await say('What do you remember?', 'search');
  expect(toolResults(model.requests.at(-1))).toEqual([
    {
      status: 'accepted',
      pluginId: 'mem0',
      toolName: 'mem0.search',
      output: {
        items: memories.slice(0, 5).map((memory, at) => ({
          id: `mem-${String(at)}`,
          text: at === 4 ? `${'y'.repeat(597)}...` : memory,
          sourceReferences: [
            {kind: 'memory', id: `mem-${String(at)}`, title: 'Mem0 memory'},
          ],
          confidence: 0.5,
        })),
      },
    },
    {
      status: 'accepted',
      pluginId: 'mem0',
      toolName: 'mem0.search',
      output: {items: []},
    },
  ]);
});
