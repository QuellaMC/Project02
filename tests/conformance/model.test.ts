import {expect, it} from 'vitest';

import {startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents, type Frame} from './harness/events.ts';
import {
  configJson,
  createHome,
  sessionLog,
  sessionRecords,
} from './harness/home.ts';
import {
  content,
  eventStream,
  finish,
  reply,
  startModelServer,
  toolCall,
  usage,
  visibleReply,
} from './harness/model-server.ts';
import {conversationOf, converse, wireOf} from './harness/wire.ts';

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
    sessionRecords(cloud.home, 'mira', 'role_model_round').map(
      round =>
        (
          round['roleModelIOSnapshot'] as
            {readonly providerMetadata: unknown} | undefined
        )?.providerMetadata,
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

it('model.provider-streaming: an answer cut anywhere, inside a frame or a character, reads back whole, its tool calls taken by their index, past reasoning chunks, comments and the usage chunk', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
  );
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
});

it("model.provider-retries: a rate limit is tried again and the turn completes, while a 401 is not tried again and fails the round provider_error in the provider's words", async () => {
  const model = await startModelServer();
  const say = await converse(
    wireOf(
      await startDaemon(
        createHome({'config.json': configJson({project02: model.settings})}),
      ),
    ),
    'mira',
  );

  model.answer(
    {status: 429, body: {error: {message: 'Slow down.'}}},
    reply('After a 429.'),
  );
  expect(await say('Hello?', 'limited')).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'After a 429.'}],
  });
  model.answer({status: 401, body: {error: {message: 'Who are you?'}}});
  expect(await say('Hello?', 'unauthorized')).toMatchObject({
    status: 'rejected',
    reason: 'provider_error',
    message: expect.stringContaining('Who are you?') as string,
  });
  expect(model.requests).toHaveLength(3);
});

it('model.provider-errors: an error the provider sends mid-stream fails the round provider_error, the reply drafted so far withdrawn and kept nowhere, the key it names redacted on the stream and on disk', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const events = await openEvents(daemon);

  model.answer({
    chunks: [
      ...visibleReply('Half a thought', 7),
      {
        error: {
          message: `The key ${model.settings.nvidiaApiKey} was refused.`,
        },
      },
    ],
  });
  expect(await say('Go on.', 'carried')).toMatchObject({
    status: 'rejected',
    reason: 'provider_error',
    committed: true,
  });

  const carried = await events.next(
    frameOf('turn_completed', {clientMessageId: 'carried'}),
  );

  expect(JSON.parse(carried.data ?? '')).toMatchObject({
    message: expect.stringContaining(
      'The key [redacted] was refused.',
    ) as string,
  });
  expect(carried.data).not.toContain(model.settings.nvidiaApiKey);
  expect(progressOf(events.frames)).toMatchObject([
    {kind: 'user_message'},
    {kind: 'reply_delta', draftId: '1.0', text: 'Half a thought'},
    {kind: 'reply_withdrawn', draftId: '1.0'},
  ]);
  await expect(wire.history(conversationId)).resolves.toMatchObject({
    messages: [{role: 'user', text: 'Go on.'}],
  });
  // Nowhere on disk either: the key is redacted in every record the turn left.
  expect(
    JSON.stringify(sessionLog(home, 'mira', `${conversationId}.1`)),
  ).not.toContain(model.settings.nvidiaApiKey);
});

it('model.provider-timeout: a provider that never answers fails the round provider_error at the silence bound, while one whose headers and chunks each come within it completes however long it takes in all', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
    {PROJECT02_TEST_DURATIONS: 'silence=2000,heartbeat=200'},
  );
  const say = await converse(wireOf(daemon), 'mira');

  model.hold();
  expect(await say('Anyone there?', 'silent')).toMatchObject({
    status: 'rejected',
    reason: 'provider_error',
    message: expect.stringContaining('timed out after 2000ms') as string,
  });

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
  // Six heartbeats before the headers and six more before the first chunk:
  // each wait well within the bound, the two together past it.
  await beats(6);
  driven.write([]);
  await beats(6);
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

it('model.reasoning-blocks: a leaked think or reasoning block is scrubbed from the reply before anything shows it, whole in plain content or split across the pieces of a streamed visible_reply: never drafted, committed or read back', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
  );
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const events = await openEvents(daemon);
  const leaked = '<think>a secret plan</think>Hello there.';
  const args = JSON.stringify({text: leaked});

  model.answer(
    {
      chunks: [
        ...content('<reasoning>a secret plan</reasoning>Plain hello.'),
        finish('stop'),
      ],
    },
    {
      chunks: [
        ...visibleReply(
          leaked,
          args.indexOf('ink>'),
          args.indexOf('cret'),
          args.indexOf('/think') + 3,
        ),
        finish('tool_calls'),
      ],
    },
  );
  expect(await say('Plain?', 'plain')).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'Plain hello.'}],
  });
  expect(await say('Split?', 'split')).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'Hello there.'}],
  });
  await events.next(frameOf('turn_completed', {clientMessageId: 'split'}));
  expect(
    events.frames
      .filter(frameOf('turn_progress', {progress: {kind: 'reply_delta'}}))
      .map(
        frame =>
          (JSON.parse(frame.data ?? '') as {progress: {text: string}}).progress
            .text,
      )
      .join(''),
  ).toBe('Hello there.');
  expect(JSON.stringify(await wire.history(conversationId))).not.toContain(
    'secret',
  );
});
