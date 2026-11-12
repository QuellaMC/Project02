import {expect, it} from 'vitest';

import {inspect, startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents} from './harness/events.ts';
import {characterJson, configJson, createHome} from './harness/home.ts';
import {
  declined,
  messaged,
  messageErred,
  messageEvents,
  replyUse,
  textBlock,
  thinkingBlock,
  toolUse,
  turnsOf,
  type MessageBlock,
} from './harness/messages.ts';
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

/** Where a request went, under which key, for which model: a bearer, or the Claude API's own header. */
function asked(request: ModelRequest): object {
  return {
    path: request.path,
    authorization: request.authorization,
    key: request.headers['x-api-key'],
    model: (request.body as {readonly model?: unknown} | undefined)?.model,
  };
}

/** What a request to the Claude API went with: where, its key, the protocol's version, the beta it names, the model, and the fallback it asks for. */
function claudeAsked(request: ModelRequest): object {
  const body = request.body as
    {readonly model?: unknown; readonly fallbacks?: unknown} | undefined;

  return {
    path: request.path,
    key: request.headers['x-api-key'],
    version: request.headers['anthropic-version'],
    beta: request.headers['anthropic-beta'],
    model: body?.model,
    fallbacks: body?.fallbacks,
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

it("services.claude-turn: a home on the Claude API answers through Anthropic's Messages protocol: its key and the protocol's version in its headers at the service's address; Claude Opus 5.5 until another is chosen; the system's lines as its system prompt and the person's line as the conversation, streamed, with the room the other services give and each tool streaming its arguments as they are written, and no sampling, thinking, effort or forced tool choice asked for; Anthropic's own fallback asked for a model the setting offers and not for one typed in; her note never said, and her thought read past and never sent back", async () => {
  const model = await startModelServer();
  const {anthropicApiKey} = model.anthropic.settings;
  const wire = wireOf(
    await startDaemon(
      createHome({
        'config.json': configJson({project02: model.anthropic.settings}),
      }),
      model.anthropic.env,
    ),
  );
  const say = await converse(wire, 'mira');
  const choose = (value: string) =>
    saveConfig(
      wire,
      {scope: 'global'},
      {kind: 'set', path: 'project02.anthropicModel', value},
    );
  const atClaude = {
    path: '/anthropic/v1/messages',
    key: anthropicApiKey,
    version: '2026-10-21',
  };
  const withFallback = {
    beta: 'server-side-fallback-2026-07-01',
    fallbacks: 'default',
  };

  model.answer(
    messaged(
      thinkingBlock('They want to know how I am.'),
      textBlock('A note to myself.'),
      replyUse('Through Claude.'),
    ),
    messaged(replyUse('Through Haiku.')),
    messaged(replyUse('Through another.')),
  );
  expect(await say('Hello?', 'default')).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'Through Claude.'}],
  });
  await choose('claude-haiku-5-5');
  expect(await say('Again?', 'offered')).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'Through Haiku.'}],
  });
  await choose('claude-opus-4-7');
  expect(await say('Once more?', 'typed')).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'Through another.'}],
  });
  expect(model.requests.map(claudeAsked)).toEqual([
    {...atClaude, ...withFallback, model: 'claude-opus-5-5'},
    {...atClaude, ...withFallback, model: 'claude-haiku-5-5'},
    {...atClaude, model: 'claude-opus-4-7'},
  ]);

  const [first, second] = model.requests;
  const body = first?.body as Readonly<Record<string, unknown>>;

  expect(Object.keys(body).sort()).toEqual([
    'fallbacks',
    'max_tokens',
    'messages',
    'model',
    'stream',
    'system',
    'tools',
  ]);
  expect(body).toMatchObject({
    max_tokens: 32768,
    stream: true,
    system: expect.stringContaining('visible_reply') as string,
  });
  expect(turnsOf(first)).toEqual([{role: 'user', content: 'Hello?'}]);
  expect((body['tools'] as readonly unknown[] | undefined)?.[0]).toEqual({
    name: 'visible_reply',
    description: expect.any(String) as string,
    input_schema: expect.objectContaining({type: 'object'}) as object,
    eager_input_streaming: true,
  });
  expect(second?.text).not.toContain('They want to know how I am.');
});

it('services.claude-drafts: her reply through the Claude API is drafted as the model writes its arguments, and committed whole once the message stops', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({
      'config.json': configJson({project02: model.anthropic.settings}),
    }),
    model.anthropic.env,
  );
  const say = await converse(wireOf(daemon), 'mira');
  const events = await openEvents(daemon);
  const words = 'Hello there, you.';
  // The arguments' first piece ends inside her words: `{"text":"Hello`.
  const streamed = messageEvents(replyUse(words, 14));
  const bytes = (part: typeof streamed) =>
    new TextEncoder().encode(responseStream(part));
  const driven = model.stream();
  const turn = say('Hi?', 'drafted');

  await driven.arrived();
  // The message begun, a ping, the call's block started, its first piece.
  driven.send(bytes(streamed.slice(0, 4)));
  await events.next(
    frameOf('turn_running', {
      clientMessageId: 'drafted',
      drafts: [{text: 'Hello'}],
    }),
  );
  driven.send(bytes(streamed.slice(4)));
  driven.end();
  expect(await turn).toMatchObject({
    status: 'completed',
    messages: [{}, {text: words}],
  });
});

it("services.claude-tool-round: a tool her model calls through the Claude API goes out as a tool use, and the next request replays the call in her turn and its result in the person's next, tied to it by one id", async () => {
  const model = await startModelServer();
  const say = await converse(
    wireOf(
      await startDaemon(
        createHome({
          'config.json': configJson({project02: model.anthropic.settings}),
        }),
        model.anthropic.env,
      ),
    ),
    'mira',
  );

  model.answer(
    messaged(toolUse('runtime_plugin_list', '{}')),
    messaged(replyUse('Here they are.')),
  );
  expect(await say('What can you do?', 'listed')).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'Here they are.'}],
  });

  const turns = turnsOf(model.requests[1]);
  const blocks = (turn: number) =>
    turns[turn]?.content as readonly MessageBlock[] | undefined;
  const id = blocks(1)?.[0]?.id;

  expect(id).toEqual(expect.any(String));
  expect(turns).toEqual([
    {role: 'user', content: 'What can you do?'},
    {
      role: 'assistant',
      content: [{type: 'tool_use', id, name: 'runtime_plugin_list', input: {}}],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: expect.any(String) as string,
        },
      ],
    },
  ]);
  expect(JSON.parse(blocks(2)?.[0]?.content ?? 'null')).toMatchObject({
    status: 'accepted',
    toolName: 'runtime.plugin.list',
  });
});

it('services.claude-declined: a message the model declines to write ends her turn rejected, saying in plain words that Claude declined to answer, with the category the service names', async () => {
  const model = await startModelServer();
  const say = await converse(
    wireOf(
      await startDaemon(
        createHome({
          'config.json': configJson({project02: model.anthropic.settings}),
        }),
        model.anthropic.env,
      ),
    ),
    'mira',
  );

  model.answer(declined('cyber'));
  expect(await say('Hello?', 'declined')).toMatchObject({
    status: 'rejected',
    reason: 'provider_error',
    message: expect.stringContaining(
      'Claude declined to answer (cyber).',
    ) as string,
  });
});

it("services.own-service: a character whose own settings choose another service thinks with it, on its key and her model, while every other character keeps the home's: Nova on the OpenAI API, Vega on the Claude API", async () => {
  const model = await startModelServer();
  const wire = wireOf(
    await startDaemon(
      createHome({
        'config.json': configJson({
          project02: {
            ...model.settings,
            nvidiaModel: 'conformance-model',
            openaiApiKey: model.openai.settings.openaiApiKey,
            anthropicApiKey: model.anthropic.settings.anthropicApiKey,
          },
        }),
        characters: {
          nova: {'project02.character.json': characterJson('nova', 'Nova')},
          vega: {'project02.character.json': characterJson('vega', 'Vega')},
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
          vega: {
            'config.json': configJson({
              project02: {
                roleModelProvider: 'anthropic',
                anthropicModel: 'claude-sonnet-5-5',
              },
            }),
          },
        },
      }),
      {...model.openai.env, ...model.anthropic.env},
    ),
  );

  for (const [characterId, answer] of [
    ['mira', reply('Hello.')],
    ['nova', responded(replying('Hello.'))],
    ['vega', messaged(replyUse('Hello.'))],
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
    {
      path: '/anthropic/v1/messages',
      key: model.anthropic.settings.anthropicApiKey,
      model: 'claude-sonnet-5-5',
    },
  ]);
});

it("services.listed: a view lists every service in a page's order with its name, what it is, where a key for it comes from and its own fields, its model's named: the ChatGPT plan first with no key, then the OpenAI API, the Claude API and NVIDIA, each connected while a credential of it is in effect, the Claude API by its key and NVIDIA by a server of the person's own; the OpenAI key set connects it and gives her a model, and cleared takes both away, saying what to add", async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({
      'config.json': configJson({
        project02: {
          roleModelProvider: 'openai',
          anthropicApiKey: model.anthropic.settings.anthropicApiKey,
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
    {id: 'chatgpt', connected: false},
    {id: 'openai', connected: openai},
    {id: 'anthropic', connected: true},
    {id: 'nvidia', connected: true},
  ];

  await wire.start('mira');
  expect(await view()).toMatchObject({
    model: {ready: false, message: needed},
    services: [
      {
        id: 'chatgpt',
        name: 'ChatGPT Plan',
        summary: 'Sign in with the plan you already pay for',
        connected: false,
        model: 'chatgptModel',
        fields: ['chatgptModel'],
      },
      {
        id: 'openai',
        name: 'OpenAI API',
        summary: 'Pay as you go, with an API key',
        keyFrom: 'Get one at platform.openai.com.',
        connected: false,
        model: 'openaiModel',
        fields: ['openaiApiKey', 'openaiModel'],
      },
      {
        id: 'anthropic',
        name: 'Claude API',
        summary: 'Pay as you go, with an API key',
        keyFrom: 'Get one in the Claude Console.',
        connected: true,
        model: 'anthropicModel',
        fields: ['anthropicApiKey', 'anthropicModel'],
      },
      {
        id: 'nvidia',
        name: 'NVIDIA',
        summary: 'An API key, or a server of your own',
        keyFrom: 'Get one at build.nvidia.com.',
        connected: true,
        model: 'nvidiaModel',
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

it("services.key-never-shown: the OpenAI API's key and the Claude API's are in nothing a client reads: the views of the home and of a character, health, the stream and inspect show each only as [redacted], even where its service repeats it in its error", async () => {
  const model = await startModelServer();
  const {openaiApiKey} = model.openai.settings;
  const {anthropicApiKey} = model.anthropic.settings;
  const home = createHome({
    'config.json': configJson({project02: {roleModelProvider: 'openai'}}),
    characters: {
      nova: {'project02.character.json': characterJson('nova', 'Nova')},
    },
    'character-data': {
      nova: {
        'config.json': configJson({
          project02: {roleModelProvider: 'anthropic'},
        }),
      },
    },
  });
  const daemon = await startDaemon(home, {
    ...model.openai.env,
    ...model.anthropic.env,
  });
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);

  for (const [name, value] of [
    ['openaiApiKey', openaiApiKey],
    ['anthropicApiKey', anthropicApiKey],
  ] as const) {
    await saveConfig(
      wire,
      {scope: 'global'},
      {kind: 'set', path: `project02.${name}`, value},
    );
  }

  for (const [characterId, answer, said] of [
    [
      'mira',
      erred(
        `The key ${openaiApiKey} was refused.`,
        replying('Half a thought', 9),
      ),
      'OpenAI provider error: The key [redacted] was refused.',
    ],
    [
      'nova',
      messageErred(
        `The key ${anthropicApiKey} was refused.`,
        replyUse('Half a thought', 9),
      ),
      'Claude provider error: The key [redacted] was refused.',
    ],
  ] as const) {
    const say = await converse(wire, characterId);

    model.answer(answer);
    expect(await say('Hello?', characterId)).toMatchObject({
      status: 'rejected',
      reason: 'provider_error',
      message: expect.stringContaining(said) as string,
    });
  }

  const report = inspect(['--store', home, '--character', 'nova']);

  expect(await report.exit(), report.stderr()).toBe(0);
  expect(JSON.parse(report.stdout())).toMatchObject({
    runtimeConfig: {
      project02: {openaiApiKey: '[redacted]', anthropicApiKey: '[redacted]'},
    },
  });

  for (const read of [
    await wire.configView({scope: 'global'}),
    await wire.configView({scope: 'character', characterId: 'mira'}),
    await wire.configView({scope: 'character', characterId: 'nova'}),
    await wire.health(),
    events.frames,
    report.stdout(),
  ]) {
    for (const key of [openaiApiKey, anthropicApiKey]) {
      expect(JSON.stringify(read)).not.toContain(key);
    }
  }
});
