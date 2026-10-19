import {expect, it} from 'vitest';

import {startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents, type Frame} from './harness/events.ts';
import {
  characterJson,
  configJson,
  createHome,
  sessionRecords,
} from './harness/home.ts';
import {
  calling,
  content,
  eventStream,
  finish,
  reply,
  startModelServer,
  toolCall,
  usage,
  visibleReply,
  type Answer,
  type ModelRequest,
} from './harness/model-server.ts';
import {within} from './harness/wait.ts';
import {conversationOf, converse, wireOf} from './harness/wire.ts';

type Message = {
  readonly role: string;
  readonly content: string | null;
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly function: {readonly name: string; readonly arguments: string};
  }[];
  readonly tool_call_id?: string;
};

/** A record of Mira's session log, as far as these tests read it. */
type LogRecord = {
  readonly kind: string;
  readonly toolCallId?: string;
  readonly roleModelIOSnapshot?: {
    readonly rawOutputText: string;
    readonly providerMetadata: unknown;
    readonly providerExchange?: {
      readonly renderedMessages: readonly Message[];
    };
  };
  readonly parsedRoleModelDecisionSnapshot?: {
    readonly result: {
      readonly decision?: {readonly text?: string};
      readonly rejection?: {readonly reason: string};
    };
  };
};

function messagesOf(request: ModelRequest | undefined): readonly Message[] {
  return (request?.body as {readonly messages: readonly Message[]}).messages;
}

function recordsOf(home: string, kind: string): LogRecord[] {
  return sessionRecords(home, 'mira', kind) as LogRecord[];
}

function progressOf(frames: readonly Frame[]): {readonly kind: string}[] {
  return frames
    .filter(frameOf('turn_progress'))
    .map(
      frame =>
        (JSON.parse(frame.data ?? '') as {progress: {kind: string}}).progress,
    );
}

it('model.provider-request-body: a round asks the model for a streamed completion with usage, automatic and parallel tool calls, and thinking on', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({
      'config.json': configJson({
        project02: {...model.settings, nvidiaModel: 'conformance-model'},
      }),
    }),
  );
  const say = await converse(wireOf(daemon), 'mira');

  model.answer(reply('Hello from the model.'));
  expect(await say('Hello?', 'hello')).toMatchObject({
    status: 'completed',
    messages: [
      {speakerName: 'You', text: 'Hello?'},
      {speakerName: 'Mira', text: 'Hello from the model.'},
    ],
  });
  expect(model.requests[0]?.body).toMatchObject({
    model: 'conformance-model',
    stream: true,
    stream_options: {include_usage: true},
    tool_choice: 'auto',
    parallel_tool_calls: true,
    reasoning_budget: expect.any(Number) as number,
    chat_template_kwargs: {enable_thinking: true},
  });
});

it('model.reply-drafts: a visible_reply is drafted as its arguments stream, escapes decoded and a possible tag held to the end, while plain content and the words beside a call never are', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
  );
  const say = await converse(wireOf(daemon), 'mira');
  const events = await openEvents(daemon);
  const delta = frameOf('turn_progress', {progress: {kind: 'reply_delta'}});
  const drafts = (draftId: string) =>
    frameOf('turn_progress', {progress: {kind: 'reply_delta', draftId}});

  model.answer({chunks: [...content('Plain words.', 6), finish('stop')]});
  expect(await say('One.', 'plain')).toMatchObject({
    messages: [{}, {text: 'Plain words.'}],
  });

  // Two cuts fall inside an escaped quote, and `<thin` could open a tag
  // until the call is whole: the last cut leaves only the call's closing.
  const call = visibleReply('Say "hi"\nthen <thin', 10, 14, 18, 24, 31);
  // A second reply beside it, cut after its first word.
  const beside = toolCall(
    {
      index: 1,
      id: 'call_beside',
      name: 'visible_reply',
      arguments: JSON.stringify({text: 'And more.'}),
    },
    14,
  );
  const drafted = () =>
    events.frames
      .filter(drafts('1.0'))
      .map(
        frame =>
          (JSON.parse(frame.data ?? '') as {progress: {text: string}}).progress
            .text,
      );
  const streaming = model.stream();
  const turn = say('Two.', 'drafted');

  await streaming.arrived();
  streaming.write([...content('A note to myself.'), ...call.slice(0, 2)]);
  // Drafted while the rest of the call is still held.
  await events.next(delta);
  streaming.write(call.slice(2, 5));

  // Everything but the possible tag, which waits for the call to close.
  await within(
    'the drafts to spell the reply so far',
    (async () => {
      while (drafted().join('') !== 'Say "hi"\nthen ') {
        await events.next(delta);
      }
    })(),
  );

  // The second reply's first piece, written after the possible tag: its
  // draft shows the daemon has taken the tag in, and is holding it.
  streaming.write(beside.slice(0, 1));
  await events.next(drafts('1.1'));
  expect(drafted()).toEqual(['S', 'ay ', '"hi', '"\nthe', 'n ']);
  streaming.write([...call.slice(5), ...beside.slice(1), finish('tool_calls')]);
  streaming.end();
  expect(await turn).toMatchObject({
    messages: [{}, {text: 'Say "hi"\nthen <thin'}, {text: 'And more.'}],
  });
  await events.next(frameOf('turn_completed', {clientMessageId: 'drafted'}));
  expect(drafted()).toEqual(['S', 'ay ', '"hi', '"\nthe', 'n ', '<thin']);
});

it("model.provider-base-url: with nvidiaBaseUrl set, rounds go to its /chat/completions, a slash at its end or not, under the key as a bearer or with no authorization when there is no key; without it they go to NVIDIA's cloud, where a round without a key fails provider_error missing_api_key", async () => {
  const model = await startModelServer();
  const {nvidiaBaseUrl} = model.settings;
  const turnAt = async (project02: object) => {
    const home = createHome({'config.json': configJson({project02})});
    const say = await converse(wireOf(await startDaemon(home)), 'mira');

    return {home, outcome: await say('Hello?', 'hello')};
  };

  model.answer(reply('Keyed.'), reply('Open.'));
  await turnAt(model.settings);
  await turnAt({
    roleModelProvider: 'nvidia',
    nvidiaBaseUrl: `${nvidiaBaseUrl}/`,
  });
  expect(
    model.requests.map(({path, authorization}) => ({path, authorization})),
  ).toEqual([
    {path: '/v1/chat/completions', authorization: 'Bearer model-server-key'},
    {path: '/v1/chat/completions', authorization: undefined},
  ]);

  const cloud = await turnAt({roleModelProvider: 'nvidia'});

  expect(cloud.outcome).toMatchObject({
    status: 'rejected',
    reason: 'provider_error',
  });
  expect(
    recordsOf(cloud.home, 'role_model_round').map(
      round => round.roleModelIOSnapshot?.providerMetadata,
    ),
  ).toMatchObject([
    {
      request: {
        endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
      },
      error: {code: 'missing_api_key'},
    },
  ]);
  expect(model.requests).toHaveLength(2);
});

it("model.provider-tool-names: the runtime's management tools and character_state.patch are offered, and their round replayed, under provider-safe names, each call under the id the runtime gave it", async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const say = await converse(wireOf(await startDaemon(home)), 'mira');
  const calls = [
    ['runtime_plugin_list', {}],
    ['runtime_plugin_config', {pluginId: 'character-memory'}],
    [
      'runtime_plugin_config_update',
      {
        pluginId: 'character-memory',
        fieldName: 'none',
        operation: 'set',
        value: 'x',
        expectedFingerprint: 'sha256:0',
      },
    ],
    ['character_state_patch', {mood: 'curious'}],
  ] as const;
  const names = calls.map(([name]) => name);

  model.answer(calling(...calls), reply('Done.'), reply('Again.'));
  await say('Check your plugins.', 'check');
  await say('And now?', 'again');

  const ids = recordsOf(home, 'tool_call_started').map(
    record => record.toolCallId,
  );
  const offered = (
    model.requests[0]?.body as {
      readonly tools: readonly {readonly function: {readonly name: string}}[];
    }
  ).tools.map(tool => tool.function.name);

  expect(offered).toEqual(expect.arrayContaining(names));
  expect(ids).toHaveLength(names.length);

  for (const request of model.requests.slice(1)) {
    const replayed = messagesOf(request).filter(
      message => message.role === 'assistant' || message.role === 'tool',
    );

    expect(replayed[0]?.tool_calls).toMatchObject(
      names.map((name, index) => ({id: ids[index], function: {name}})),
    );
    expect(
      replayed
        .filter(message => message.role === 'tool')
        .map(message => message.tool_call_id),
    ).toEqual(ids);
  }
});

it('model.provider-plain-content-reply: plain assistant content that finishes with stop becomes the reply as written', async () => {
  const model = await startModelServer();
  const say = await converse(
    wireOf(
      await startDaemon(
        createHome({'config.json': configJson({project02: model.settings})}),
      ),
    ),
    'mira',
  );
  const words = 'Well — "quoted", *starred* and {braced},\n\nthen a 🌱.';

  model.answer({chunks: [...content(words, 9, 30), finish('stop')]});
  expect(await say('Hello?', 'hello')).toMatchObject({
    status: 'completed',
    messages: [{}, {text: words}],
  });
});

it('model.provider-streaming: an answer cut anywhere, inside a frame or a character, reads back whole: content, tool calls by their index, the finish reason and usage, while reasoning chunks and comments are ignored', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const daemon = await startDaemon(home);
  const say = await converse(wireOf(daemon), 'mira');
  const events = await openEvents(daemon);
  const [first, firstRest] = toolCall(
    {
      index: 0,
      id: 'call_first',
      name: 'visible_reply',
      arguments: '{"text":"First 🌱."}',
    },
    12,
  );
  const [second, secondRest] = toolCall(
    {
      index: 1,
      id: 'call_second',
      name: 'visible_reply',
      arguments: '{"text":"Second."}',
    },
    13,
  );
  const text = `: ping\n\n${eventStream([
    {
      choices: [
        {
          index: 0,
          delta: {role: 'assistant', reasoning_content: 'Thinking it over.'},
          finish_reason: null,
        },
      ],
    },
    ...content('Café '),
    first,
    second,
    firstRest,
    ...content('au lait.'),
    secondRest,
    finish('tool_calls'),
    usage({prompt_tokens: 12, completion_tokens: 34}),
  ])}`;
  const bytes = new TextEncoder().encode(text);
  const byteOffset = (marker: string, past: number) =>
    new TextEncoder().encode(text.slice(0, text.indexOf(marker))).length + past;
  // Every cut falls inside a frame, the first inside the é and the third
  // inside the 🌱, and each piece after the first completes a frame of a
  // reply, whose draft shows the daemon has read that far.
  const cuts = [
    byteOffset('Café', 4),
    byteOffset('Seco', 2),
    byteOffset('🌱', 2),
    byteOffset('nd.', 1),
    bytes.length,
  ];
  const driven = model.stream();
  const turn = say('Two things?', 'split');

  await driven.arrived();

  for (const [index, end] of cuts.entries()) {
    driven.send(bytes.slice(cuts[index - 1] ?? 0, end));

    if (index > 0) {
      await events.next(
        frameOf('turn_progress', {progress: {kind: 'reply_delta'}}),
      );
    }
  }

  driven.end();
  expect(await turn).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'First 🌱.'}, {text: 'Second.'}],
  });

  const [round] = recordsOf(home, 'role_model_round');

  expect(round?.parsedRoleModelDecisionSnapshot?.result.decision?.text).toBe(
    'Café au lait.',
  );
  expect(round?.roleModelIOSnapshot?.providerExchange).toMatchObject({
    finishReason: 'tool_calls',
    usage: {prompt_tokens: 12, completion_tokens: 34, total_tokens: 46},
  });
});

it('model.provider-retries: a 503, a 429 or a dropped connection is tried again and the turn completes; a 429 to the last attempt ends with that last error, and a 401 is not tried again and fails the round provider_error', async () => {
  const model = await startModelServer();
  const say = await converse(
    wireOf(
      await startDaemon(
        createHome({'config.json': configJson({project02: model.settings})}),
      ),
    ),
    'mira',
  );
  const slowDown = (attempt: number): Answer => ({
    status: 429,
    body: {error: {message: `Slow down (${String(attempt)}).`}},
  });

  model.answer(
    {status: 503},
    reply('After a 503.'),
    slowDown(1),
    reply('After a 429.'),
    {drop: true},
    reply('After a drop.'),
  );

  for (const [text, id] of [
    ['After a 503.', 'unavailable'],
    ['After a 429.', 'limited'],
    ['After a drop.', 'dropped'],
  ] as const) {
    expect(await say('Hello?', id), id).toMatchObject({
      status: 'completed',
      messages: [{}, {text}],
    });
  }

  expect(model.requests).toHaveLength(6);
  expect(model.requests[1]?.body).toEqual(model.requests[0]?.body);
  model.answer(slowDown(1), slowDown(2), slowDown(3));
  expect(await say('Once more?', 'exhausted')).toMatchObject({
    status: 'rejected',
    reason: 'provider_error',
    message: expect.stringContaining('Slow down (3).') as string,
  });
  expect(model.requests).toHaveLength(9);
  model.answer({status: 401, body: {error: {message: 'Who are you?'}}});
  expect(await say('Hello?', 'unauthorized')).toMatchObject({
    status: 'rejected',
    reason: 'provider_error',
    message: expect.stringContaining('Who are you?') as string,
  });
  expect(model.requests).toHaveLength(10);
});

it('model.provider-errors: finish_reason length, a stream ending without a finish reason or cut before one, a chunk that is no JSON and an error carried in the stream each fail the round provider_error, the reply drafted so far withdrawn and kept nowhere, the key redacted', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
  );
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const events = await openEvents(daemon);
  const drafted = visibleReply('Half a thought', 7);
  const cases = ['length', 'unfinished', 'cut', 'malformed', 'carried'];

  model.answer(
    {chunks: [...drafted, finish('length')]},
    {chunks: drafted},
    {chunks: drafted, end: 'cut'},
    {chunks: [...drafted, '{"choices": [']},
    {
      chunks: [
        ...drafted,
        {
          error: {
            message: `The key ${model.settings.nvidiaApiKey} was refused.`,
          },
        },
      ],
    },
  );

  for (const id of cases) {
    expect(await say(`Try ${id}.`, id), id).toMatchObject({
      status: 'rejected',
      reason: 'provider_error',
      committed: true,
    });
  }

  const carried = await events.next(
    frameOf('turn_completed', {clientMessageId: 'carried'}),
  );

  expect(JSON.parse(carried.data ?? '')).toMatchObject({
    message: expect.stringContaining(
      'The key [redacted] was refused.',
    ) as string,
  });
  expect(carried.data).not.toContain(model.settings.nvidiaApiKey);
  expect(progressOf(events.frames)).toMatchObject(
    cases.flatMap(() => [
      {kind: 'user_message'},
      {kind: 'reply_delta', draftId: '1.0', text: 'Half a thought'},
      {kind: 'reply_withdrawn', draftId: '1.0'},
    ]),
  );
  await expect(wire.history(conversationId)).resolves.toMatchObject({
    messages: cases.map(id => ({role: 'user', text: `Try ${id}.`})),
  });
});

it('model.provider-timeout: provider silence is bounded: a provider that never answers, or stops between chunks, fails the round provider_error at the bound, while an answer whose headers and chunks each come within it completes however long it takes in all', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
    {PROJECT02_TEST_DURATIONS: 'silence=2000,heartbeat=200'},
  );
  const say = await converse(wireOf(daemon), 'mira');
  const timedOut = {
    status: 'rejected',
    reason: 'provider_error',
    message: expect.stringContaining('timed out after 2000ms') as string,
  };

  model.hold();
  expect(await say('Anyone there?', 'silent')).toMatchObject(timedOut);
  model.answer({chunks: visibleReply('Let me', 5), end: 'hang'});
  expect(await say('Go on?', 'stalled')).toMatchObject(timedOut);

  // Opened now, so every heartbeat it carries is one that comes from here on.
  const events = await openEvents(daemon);
  const beats = async (count: number): Promise<void> => {
    for (let beat = 0; beat < count; beat += 1) {
      await events.next(frame => frame.comment === 'ping');
    }
  };
  const [head, ...rest] = [
    ...visibleReply('Slow and steady.', 6, 12),
    finish('tool_calls'),
  ];
  const driven = model.stream();
  const turn = say('Take your time.', 'slow');

  await driven.arrived();
  // Seven heartbeats before the headers and seven more before the first
  // chunk: each wait within the bound, the two together past it.
  await beats(7);
  driven.write([]);
  await beats(7);
  driven.write([head]);

  for (const chunk of rest) {
    await beats(3);
    driven.write([chunk]);
  }

  driven.end();
  await expect(turn).resolves.toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'Slow and steady.'}],
  });
});

it('model.provider-empty-content: empty content, or tool arguments that are no JSON object, reach the decision parser as the model wrote them, which refuses the round and hands it back', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const say = await converse(wireOf(await startDaemon(home)), 'mira');

  model.answer(
    {chunks: [...content(''), finish('stop')]},
    {
      chunks: [
        ...toolCall({
          index: 0,
          id: 'call_list',
          name: 'runtime_plugin_list',
          arguments: '{"scope": ',
        }),
        finish('tool_calls'),
      ],
    },
    reply('There.'),
  );
  expect(await say('Hello?', 'hello')).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'There.'}],
  });
  expect(
    recordsOf(home, 'role_model_round').map(round => [
      JSON.parse(round.roleModelIOSnapshot?.rawOutputText ?? '') as unknown,
      round.parsedRoleModelDecisionSnapshot?.result.rejection?.reason,
    ]),
  ).toEqual([
    [{toolCalls: []}, 'malformed_output'],
    [
      {toolCalls: [{name: 'runtime.plugin.list', input: '{"scope": '}]},
      'malformed_output',
    ],
    [expect.anything(), undefined],
  ]);
  expect(
    model.requests.slice(1).map(request => messagesOf(request).at(-1)?.role),
  ).toEqual(['system', 'system']);
  expect(recordsOf(home, 'tool_call_started')).toEqual([]);
});

it('model.provider-large-prompt: a prompt as large as the window admits, its history past 64 KiB, is sent whole and recorded with its round', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({
      project02: {...model.settings, contextWindowTokens: 100_000},
    }),
  });
  const say = await converse(wireOf(await startDaemon(home)), 'mira');
  const long = `${'A long answer. '.repeat(6_000)}The end.`;

  model.answer(reply(long), reply('Short this time.'));
  await say('Tell me everything.', 'long');
  expect(await say('And briefly?', 'brief')).toMatchObject({
    status: 'completed',
  });

  const sent = messagesOf(model.requests[1]);

  expect(JSON.stringify(sent).length).toBeGreaterThan(64 * 1024);
  expect(sent).toContainEqual({role: 'assistant', content: long});
  expect(
    recordsOf(home, 'role_model_round')[1]?.roleModelIOSnapshot
      ?.providerExchange?.renderedMessages,
  ).toEqual(sent);
});

it("model.test-provider: with PROJECT02_TEST_PROVIDER=deterministic every character answers in the fixed test voice whatever its config chooses, asking no model: first I'm here, then the line before quoted back, each reply drafted word by word", async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({
      'config.json': configJson({project02: model.settings}),
      characters: {
        zeta: {'project02.character.json': characterJson('zeta', 'Zeta')},
      },
    }),
    {PROJECT02_TEST_PROVIDER: 'deterministic'},
  );
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const replies = [
    "I'm here. Tell me what you need.",
    'I remember you said "First line." Stay with me for a minute.',
  ];

  for (const characterId of ['mira', 'zeta']) {
    const say = await converse(wire, characterId);

    for (const [at, text] of replies.entries()) {
      const line = at === 0 ? 'First line.' : 'Second line.';

      expect(
        await say(line, `${characterId}-${String(at)}`),
        characterId,
      ).toMatchObject({status: 'completed', messages: [{}, {text}]});
    }
  }

  await events.next(frameOf('turn_completed', {clientMessageId: 'zeta-1'}));
  expect(model.requests).toEqual([]);
  expect(
    events.frames
      .filter(frameOf('turn_progress', {progress: {kind: 'reply_delta'}}))
      .map(
        frame =>
          (JSON.parse(frame.data ?? '') as {progress: {text: string}}).progress
            .text,
      ),
  ).toEqual([...replies, ...replies].flatMap(text => text.split(/(?<=\s)/u)));
});
