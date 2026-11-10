import {readdirSync, statSync} from 'node:fs';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {text} from 'node:stream/consumers';

import {expect, it} from 'vitest';

import {startDaemon} from './harness/daemon.ts';
import {configJson, createHome, sessionLog} from './harness/home.ts';
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
import {servedOnLoopback} from './harness/server.ts';
import {observed} from './harness/wait.ts';
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

it("memory.mem0-wire: the server backend recalls and captures under its X-API-Key and the platform backend under Token auth; a failing backend reaches the model without the key, and no record holds the key or a baseUrl's credentials", async () => {
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

  capture.release({status: 200, body: {results: [{id: 'mem-1'}]}});
  expect(server.requests[0]).toMatchObject({
    method: 'POST',
    path: '/search',
    headers: {'x-api-key': serverKey},
    body: {
      query: 'Remember the lighthouse.',
      user_id: 'project02-user',
      agent_id: 'mira',
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
    },
  });

  // The recall before the turn finds nothing; the search the model asks
  // for is refused by a backend that echoes the key.
  server.answer(
    '/search',
    {status: 200, body: {results: []}},
    {status: 401, body: {detail: `The key ${serverKey} was rejected.`}},
  );
  model.answer(
    calling(['mem0_search', {query: 'lighthouse'}]),
    reply('Nothing came back.'),
  );
  await say('What do you remember?', 'refused');

  const refused = toolResults(model.requests.at(-1));

  expect(refused).toMatchObject([
    {
      status: 'rejected',
      pluginId: 'mem0',
      toolName: 'mem0.search',
      message: expect.stringContaining('HTTP 401') as string,
    },
  ]);
  expect(JSON.stringify(refused)).not.toContain(serverKey);
  expect(
    JSON.stringify(sessionLog(home, 'mira', `${conversationId}.1`)),
  ).not.toContain(serverKey);

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
    },
  });

  const credentialed = createHome({
    'config.json': configJson({
      project02: model.settings,
      plugins: {
        mem0: {
          enabled: true,
          config: {
            backend: 'server',
            baseUrl: 'https://operator:hunter2@mem0.example',
          },
        },
      },
    }),
  });
  const credentialedWire = wireOf(await startDaemon(credentialed));
  const sayWithCredentials = await converse(credentialedWire, 'mira');
  const thread = await conversationOf(credentialedWire, 'mira');

  model.answer(reply('Hello.'));
  await sayWithCredentials('Hello?', 'credentials');

  // Judged not set up: she answers without it, and neither what she says
  // of it nor what she records holds the credentials it carries.
  expect(JSON.stringify(await credentialedWire.health())).not.toContain(
    'hunter2',
  );
  expect(
    JSON.stringify(
      sessionLog(credentialed, 'mira', `${thread.conversationId}.1`),
    ),
  ).not.toContain('hunter2');
});

it("memory.mem0-capture: mem0 takes each turn behind its answer, as the character's under its speakers' names, and what is still queued is sent before a stop ends the process", async () => {
  const model = await startModelServer();
  const mem0 = await startMem0Server();
  const daemon = await startDaemon(
    createHome({
      'config.json': mem0Config(
        model,
        mem0,
        {backend: 'server'},
        {userDisplayName: 'Sam'},
      ),
    }),
  );
  const say = await converse(wireOf(daemon), 'mira');
  const held = mem0.hold('/memories');
  const captures = () =>
    mem0.requests.filter(request => request.path === '/memories');

  model.answer(reply('Reply 1.'), reply('Reply 2.'));

  // The turn answers while its capture is still held at the backend: the
  // capture runs behind the answer and never holds it up.
  const answered = say('Line 1.', 'line-1');
  const captured = held.arrived();

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

  // Captures run one at a time: the next waits behind the held one.
  await say('Line 2.', 'line-2');
  expect(captures()).toHaveLength(1);
  daemon.signal('SIGINT');
  await daemon.printed('Stopping; finishing what is in flight.');
  held.release({status: 200, body: {results: [{id: 'mem-1'}]}});
  await daemon.exit();
  expect(
    captures().map(
      request =>
        (
          request.body as {
            readonly messages: readonly {readonly content: string}[];
          }
        ).messages[0]?.content,
    ),
  ).toEqual(['Sam: Line 1.', 'Sam: Line 2.']);
});

it("memory.mem0-recall: before a turn, what mem0 recalls rides the person's line to the model, and a failing backend leaves the turn to complete without it", async () => {
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

  mem0.answer(
    '/search',
    {
      status: 200,
      body: {results: [{id: 'mem-1', memory: 'Sam likes tea.', score: 0.9}]},
    },
    {status: 500},
  );
  model.answer(reply('Tea.'), reply('Still here.'));
  expect(await say('What do I like?', 'recalled')).toMatchObject({
    status: 'completed',
  });
  expect(await say('And now?', 'failing')).toMatchObject({
    status: 'completed',
  });

  const [recalled, failing] = model.requests.map(lineOf);

  expect(recalled).toContain('Sam likes tea.');
  expect(failing).toBe('And now?');
});

it('memory.mem0-add-tool: mem0.add stores the text the model gives it at the backend, and mem0.search hands the model the memories the backend finds', async () => {
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

  mem0.answer('/memories', {status: 200, body: {results: [{id: 'mem-1'}]}});
  // The recall before the turn, then the search the model asks for.
  mem0.answer(
    '/search',
    {status: 200, body: {results: []}},
    {
      status: 200,
      body: {results: [{id: 'mem-1', memory: 'Sam likes tea.', score: 0.5}]},
    },
  );
  model.answer(
    calling(['mem0_add', {text: 'Sam likes tea.'}]),
    calling(['mem0_search', {query: 'tea'}]),
    reply('You like tea.'),
  );
  await say('What do I like?', 'tea');
  expect(
    mem0.requests.find(request => request.path === '/memories'),
  ).toMatchObject({
    body: {messages: [{role: 'user', content: 'Sam likes tea.'}]},
  });
  expect(toolResults(model.requests.at(-1))).toMatchObject([
    {status: 'accepted', pluginId: 'mem0', toolName: 'mem0.add'},
    {
      status: 'accepted',
      pluginId: 'mem0',
      toolName: 'mem0.search',
      output: {items: [{text: 'Sam likes tea.'}]},
    },
  ]);
});

it('memory.mem0-embedded: the embedded engine captures through its own model and embedder, keeps its database in the home readable by its owner alone, and writes nothing outside the home', async () => {
  const model = await startModelServer();
  const engine = await startEngineServer('Sam likes tea.');
  const outside = createHome();
  const home = createHome({
    'config.json': configJson({
      project02: model.settings,
      plugins: {
        mem0: {
          enabled: true,
          config: {
            backend: 'oss',
            ossLlmBaseUrl: `${engine.baseUrl}/v1`,
            ossLlmModel: 'extractor',
            ossEmbedderModel: 'embedder',
          },
        },
      },
    }),
  });
  const daemon = await startDaemon(home, {HOME: outside});
  const say = await converse(wireOf(daemon), 'mira');
  const turn = async (n: number) => {
    model.answer(reply(`Reply ${String(n)}.`));
    await say(`I like tea, ${String(n)}.`, `tea-${String(n)}`);
  };

  await turn(1);
  await turn(2);
  // Captures run one at a time: the second one's extraction says the first
  // one's model and embedder have answered.
  await engine.extracted(2);
  daemon.signal('SIGINT');
  await daemon.exit();
  expectOwnerOnly(join(home, 'character-data', 'mira', 'plugin-data', 'mem0'));
  expect(readdirSync(outside)).toEqual([]);
});

/** Every file under the directory, of which there is one at least, readable by its owner alone. */
function expectOwnerOnly(directory: string): void {
  const files = readdirSync(directory, {recursive: true, withFileTypes: true})
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name));

  expect(files).not.toEqual([]);

  for (const file of files) {
    expect(statSync(file).mode & 0o777, file).toBe(0o600);
  }
}

/**
 * An OpenAI-wire model and embedder on loopback for the embedded engine:
 * every extraction finds `memory`, and every text embeds as the counts of
 * its letters.
 */
async function startEngineServer(memory: string) {
  const paths = observed<string>();
  const server = createServer((request, response) => {
    void text(request).then(body => {
      const path = request.url ?? '';
      const answer = path.endsWith('/embeddings')
        ? {
            data: [
              {
                embedding: letterCounts(
                  (JSON.parse(body) as {readonly input: string}).input,
                ),
              },
            ],
          }
        : {
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: JSON.stringify({memory: [{id: '0', text: memory}]}),
                },
              },
            ],
          };

      paths.add(path);
      response
        .writeHead(200, {'content-type': 'application/json'})
        .end(JSON.stringify(answer));
    });
  });
  const port = await servedOnLoopback(server);

  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    /** Settles once the model was asked for `count` extractions. */
    extracted: (count: number) =>
      paths.until(`${String(count)} extractions`, asked =>
        asked.filter(path => path.endsWith('/chat/completions')).length >= count
          ? true
          : undefined,
      ),
  };
}

/** A text as the counts of its letters, a to z, and of everything else. */
function letterCounts(words: string): number[] {
  const counts = Array.from({length: 27}, () => 0);

  for (const character of words.toLowerCase()) {
    const letter = 'abcdefghijklmnopqrstuvwxyz'.indexOf(character);
    const at = letter === -1 ? 26 : letter;

    counts[at] = (counts[at] ?? 0) + 1;
  }

  return counts;
}
