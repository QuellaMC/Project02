import {expect, it} from 'vitest';

import {inspect, startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents} from './harness/events.ts';
import {characterJson, configJson, createHome} from './harness/home.ts';
import {
  reply,
  responseStream,
  startModelServer,
  type ModelRequest,
} from './harness/model-server.ts';
import {
  erred,
  functionCall,
  inputOf,
  replying,
  responded,
  responseEvents,
} from './harness/responses.ts';
import {converse, saveConfig, wireOf} from './harness/wire.ts';

/** Where a request went, under which key, for which model. */
function asked(request: ModelRequest): object {
  return {
    path: request.path,
    authorization: request.authorization,
    model: (request.body as {readonly model?: unknown} | undefined)?.model,
  };
}

it("services.openai-turn: a home on the OpenAI API answers through its Responses protocol: its key as a bearer at the service's address, the service's default model until another is chosen, nothing stored, the reply streamed and offered as a function tool", async () => {
  const model = await startModelServer();
  const {openaiApiKey} = model.openai.settings;
  const wire = wireOf(
    await startDaemon(
      createHome({
        'config.json': configJson({project02: model.openai.settings}),
      }),
      model.openai.env,
    ),
  );
  const say = await converse(wire, 'mira');
  const atOpenai = {
    path: '/openai/v1/responses',
    authorization: `Bearer ${openaiApiKey}`,
  };

  model.answer(
    responded(replying('Through OpenAI.')),
    responded(replying('Through another.')),
  );
  expect(await say('Hello?', 'default')).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'Through OpenAI.'}],
  });
  await saveConfig(
    wire,
    {scope: 'global'},
    {kind: 'set', path: 'project02.openaiModel', value: 'gpt-6.1-sol'},
  );
  expect(await say('Again?', 'chosen')).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'Through another.'}],
  });
  expect(model.requests.map(asked)).toEqual([
    {...atOpenai, model: 'gpt-6-luna'},
    {...atOpenai, model: 'gpt-6.1-sol'},
  ]);
  const [first] = model.requests;
  const input = inputOf(first);

  expect(first?.body).toMatchObject({stream: true, store: false});
  expect(input[0]).toMatchObject({type: 'message', role: 'system'});
  expect(input.at(-1)).toEqual({
    type: 'message',
    role: 'user',
    content: 'Hello?',
  });
  expect(
    (first?.body as {readonly tools?: readonly unknown[]} | undefined)
      ?.tools?.[0],
  ).toEqual(
    expect.objectContaining({
      type: 'function',
      name: 'visible_reply',
      strict: false,
    }),
  );
});

it('services.openai-drafts: her reply through the OpenAI API is drafted as the model writes its arguments, and committed whole once the response completes', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.openai.settings})}),
    model.openai.env,
  );
  const say = await converse(wireOf(daemon), 'mira');
  const events = await openEvents(daemon);
  const words = 'Hello there, you.';
  // The arguments' first piece ends inside her words: `{"text":"Hello`.
  const streamed = responseEvents(replying(words, 14));
  const bytes = (part: typeof streamed) =>
    new TextEncoder().encode(responseStream(part));
  const driven = model.stream();
  const turn = say('Hi?', 'drafted');

  await driven.arrived();
  // The response created, the call's item added, its first piece.
  driven.send(bytes(streamed.slice(0, 3)));
  await events.next(
    frameOf('turn_running', {
      clientMessageId: 'drafted',
      drafts: [{text: 'Hello'}],
    }),
  );
  driven.send(bytes(streamed.slice(3)));
  driven.end();
  expect(await turn).toMatchObject({
    status: 'completed',
    messages: [{}, {text: words}],
  });
});

it('services.openai-tool-round: a tool her model calls through the OpenAI API goes out as a function call, and the next request carries the call and its result, tied to it by one call id', async () => {
  const model = await startModelServer();
  const say = await converse(
    wireOf(
      await startDaemon(
        createHome({
          'config.json': configJson({project02: model.openai.settings}),
        }),
        model.openai.env,
      ),
    ),
    'mira',
  );

  model.answer(
    responded(functionCall('runtime_plugin_list', '{}')),
    responded(replying('Here they are.')),
  );
  expect(await say('What can you do?', 'listed')).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'Here they are.'}],
  });

  const input = inputOf(model.requests[1]);
  const call = input.find(item => item.type === 'function_call');
  const result = input.find(item => item.type === 'function_call_output');

  expect(call).toEqual({
    type: 'function_call',
    call_id: call?.call_id,
    name: 'runtime_plugin_list',
    arguments: '{}',
  });
  expect(result).toMatchObject({
    type: 'function_call_output',
    call_id: call?.call_id,
  });
  expect(JSON.parse(result?.output ?? 'null')).toMatchObject({
    status: 'accepted',
    toolName: 'runtime.plugin.list',
  });
});

it("services.own-service: a character whose own settings choose the other service thinks with it, on its key and her model, while every other character keeps the home's", async () => {
  const model = await startModelServer();
  const wire = wireOf(
    await startDaemon(
      createHome({
        'config.json': configJson({
          project02: {
            ...model.settings,
            nvidiaModel: 'conformance-model',
            openaiApiKey: model.openai.settings.openaiApiKey,
          },
        }),
        characters: {
          nova: {'project02.character.json': characterJson('nova', 'Nova')},
        },
        'character-data': {
          nova: {
            'config.json': configJson({
              project02: {
                roleModelProvider: 'openai',
                openaiModel: 'gpt-6.1-terra',
              },
            }),
          },
        },
      }),
      model.openai.env,
    ),
  );

  for (const [characterId, answer] of [
    ['mira', reply('Hello.')],
    ['nova', responded(replying('Hello.'))],
  ] as const) {
    const say = await converse(wire, characterId);

    model.answer(answer);
    expect(await say('Hello?', characterId)).toMatchObject({
      status: 'completed',
    });
  }

  expect(model.requests.map(asked)).toEqual([
    {
      path: '/v1/chat/completions',
      authorization: `Bearer ${model.settings.nvidiaApiKey}`,
      model: 'conformance-model',
    },
    {
      path: '/openai/v1/responses',
      authorization: `Bearer ${model.openai.settings.openaiApiKey}`,
      model: 'gpt-6.1-terra',
    },
  ]);
});

it("services.listed: a view lists every service in a page's order with its name and its own fields, each connected while a credential of it is in effect, a server of the person's own among NVIDIA's; the OpenAI key set connects it and gives her a model, and cleared takes both away, saying what to add", async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({
      'config.json': configJson({
        project02: {
          roleModelProvider: 'openai',
          nvidiaBaseUrl: model.settings.nvidiaBaseUrl,
        },
      }),
    }),
    model.openai.env,
  );
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const needed = 'Add your OpenAI API key.';
  const view = () => wire.configView({scope: 'global'});
  const key = (operation: object) =>
    saveConfig(wire, {scope: 'global'}, operation);
  const connected = (openai: boolean) => [
    {id: 'openai', connected: openai},
    {id: 'nvidia', connected: true},
  ];

  await wire.start('mira');
  expect(await view()).toMatchObject({
    model: {ready: false, message: needed},
    services: [
      {
        id: 'openai',
        name: 'OpenAI API',
        connected: false,
        fields: ['openaiApiKey', 'openaiModel'],
      },
      {
        id: 'nvidia',
        name: 'NVIDIA',
        connected: true,
        fields: ['nvidiaApiKey', 'nvidiaModel', 'nvidiaBaseUrl'],
      },
    ],
  });
  expect(await wire.health()).toMatchObject({
    characters: [{id: 'mira', state: 'needs_model', diagnostic: needed}],
  });

  await key({
    kind: 'set',
    path: 'project02.openaiApiKey',
    value: model.openai.settings.openaiApiKey,
  });
  await events.next(
    frameOf('state_changed', {characterId: 'mira', state: 'ready'}),
  );
  expect(await view()).toMatchObject({
    model: {ready: true},
    services: connected(true),
  });

  await key({kind: 'unset', path: 'project02.openaiApiKey'});
  await events.next(
    frameOf('state_changed', {
      characterId: 'mira',
      state: 'needs_model',
      message: needed,
    }),
  );
  expect(await view()).toMatchObject({
    model: {ready: false, message: needed},
    services: connected(false),
  });
});

it('services.key-never-shown: the OpenAI key is in nothing a client reads: the views of the home and of a character, health, the stream and inspect show it only as [redacted], even where the service repeats it in its error', async () => {
  const model = await startModelServer();
  const {openaiApiKey} = model.openai.settings;
  const home = createHome({
    'config.json': configJson({project02: {roleModelProvider: 'openai'}}),
  });
  const daemon = await startDaemon(home, model.openai.env);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);

  await saveConfig(
    wire,
    {scope: 'global'},
    {kind: 'set', path: 'project02.openaiApiKey', value: openaiApiKey},
  );

  const say = await converse(wire, 'mira');

  model.answer(
    erred(
      `The key ${openaiApiKey} was refused.`,
      replying('Half a thought', 9),
    ),
  );
  expect(await say('Hello?', 'refused')).toMatchObject({
    status: 'rejected',
    reason: 'provider_error',
    message: expect.stringContaining(
      'OpenAI provider error: The key [redacted] was refused.',
    ) as string,
  });

  const report = inspect(['--store', home]);

  expect(await report.exit(), report.stderr()).toBe(0);
  expect(JSON.parse(report.stdout())).toMatchObject({
    runtimeConfig: {project02: {openaiApiKey: '[redacted]'}},
  });

  for (const read of [
    await wire.configView({scope: 'global'}),
    await wire.configView({scope: 'character', characterId: 'mira'}),
    await wire.health(),
    events.frames,
    report.stdout(),
  ]) {
    expect(JSON.stringify(read)).not.toContain(openaiApiKey);
  }
});
