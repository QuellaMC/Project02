import {readdirSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {connector, startDaemon} from './harness/daemon.ts';
import {
  frameOf,
  openEvents,
  type Events,
  type Frame,
} from './harness/events.ts';
import {
  characterJson,
  configJson,
  createHome,
  sessionLog,
} from './harness/home.ts';
import {
  calling,
  finish,
  messagesOf,
  reply,
  startModelServer,
  visibleReply,
  type Answer,
  type ChatMessage,
  type ModelRequest,
  type ModelServer,
} from './harness/model-server.ts';
import {startTelegramServer} from './harness/telegram-server.ts';
import {
  changeConfig,
  conversationOf,
  converse,
  saveConfig,
  wireOf,
  type Wire,
} from './harness/wire.ts';

/** A minute of her heartbeat, in milliseconds: a quarter of an hour passes in a second and a half. */
const minute = 100;
/** A heartbeat of a quarter of an hour, in milliseconds. */
const heartbeat = 15 * minute;
const shortened = {PROJECT02_TEST_DURATIONS: `minute=${String(minute)}`};
/** The minute shortened, and a ping each half second the stream is silent: a clock to outlast a heartbeat by. */
const pinging = {
  PROJECT02_TEST_DURATIONS: `minute=${String(minute)},ping=500`,
};
const mira = {scope: 'character', characterId: 'mira'} as const;
const nova = {scope: 'character', characterId: 'nova'} as const;
/** An answer of nothing at all: no text, no call. */
const nothing: Answer = {chunks: [finish('stop')]};

/** A home where Mira answers through the model server, the person goes by Sam, and her heartbeat is a quarter of an hour. */
function heartbeatHome(model: ModelServer): string {
  return createHome({
    'config.json': configJson({
      project02: {...model.settings, userDisplayName: 'Sam'},
    }),
    'character-data': {
      mira: {'config.json': configJson({project02: {heartbeat: '15m'}})},
    },
  });
}

function dataOf(frame: Frame | undefined): Record<string, unknown> {
  return JSON.parse(frame?.data ?? '{}') as Record<string, unknown>;
}

/** A frame of a turn of the character's own: one that carries no line's stamps. */
function own(
  event: 'turn_running' | 'turn_completed',
  characterId = 'mira',
): (frame: Frame) => boolean {
  return frame =>
    frameOf(event, {characterId})(frame) &&
    !('source' in dataOf(frame)) &&
    !('clientMessageId' in dataOf(frame));
}

/** The next turn of Mira's own as the stream tells it, from the frame that says it running to its completion, pings left out. */
async function nextMoment(events: Events): Promise<readonly Frame[]> {
  const begun = await events.next(own('turn_running'));
  const ended = await events.next(own('turn_completed'));

  return events.frames
    .slice(events.frames.indexOf(begun), events.frames.indexOf(ended) + 1)
    .filter(frame => frame.comment === undefined);
}

/** Settles once the stream has been silent long enough to ping `count` times from now on. */
async function silent(events: Events, count: number): Promise<void> {
  const from = events.frames.length;

  await events.holding(`${String(count)} pings`, frames =>
    frames.slice(from).filter(frame => frame.comment === 'ping').length >= count
      ? true
      : undefined,
  );
}

/** The request's messages after its leading system frames. */
function conversationIn(
  request: ModelRequest | undefined,
): readonly ChatMessage[] {
  const messages = messagesOf(request);

  return messages.slice(
    messages.findIndex(message => message.role !== 'system'),
  );
}

/** A moment's note as the model reads it where a line would be, telling `when` after "It is", then what the moment is hers for. */
function momentNote(when: string): RegExp {
  return new RegExp(
    `^<moment_of_your_own>\\nA moment of your own — nobody has written to you, and nothing here is something Sam said\\.\\nIt is ${when}\\nNobody is waiting for a reply\\. This time is yours: think, use your tools, or let it pass\\. If there is something you want Sam to read, send it with visible_reply; anything else you write stays your own thought\\.\\n</moment_of_your_own>$`,
    'u',
  );
}

/** An earlier moment's note as a later prompt replays it: that it was one, and when. */
const pastMoment =
  /^<moment_of_your_own>\nA moment of your own, on [^\n]+, at \d\d:\d\d — nobody had written to you\.\n<\/moment_of_your_own>$/u;

/** A host field as the target's view shows it, if the view has it. */
async function hostField(
  wire: Wire,
  target: Parameters<Wire['configView']>[0],
  name: string,
): Promise<unknown> {
  const view = (await wire.configView(target)) as {
    readonly project02: readonly {readonly name: string}[];
  };

  return view.project02.find(field => field.name === name);
}

it("heartbeat.moment: after a person's turn and a heartbeat of quiet a turn of her own runs, the model asked with the moment's note last, naming how long ago the person wrote, said running and completed with no line's stamps; another comes a heartbeat after it, and a turn of the person's sets the next one a whole heartbeat ahead", async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(heartbeatHome(model), pinging);
  const events = await openEvents(daemon);
  const say = await converse(wireOf(daemon), 'mira');

  model.answer(reply('Tea first.'), nothing, nothing);
  await say('Morning.', 'morning');

  const spoke = performance.now();

  expect(dataOf(await events.next(own('turn_running')))).toMatchObject({
    conversationId: expect.any(String) as string,
    drafts: [],
  });
  expect(performance.now() - spoke).toBeGreaterThanOrEqual(heartbeat / 2);
  expect(dataOf(await events.next(own('turn_completed')))).toMatchObject({
    status: 'completed',
    committed: true,
  });

  const first = performance.now();

  expect(messagesOf(model.requests[1]).at(-1)).toMatchObject({
    role: 'user',
    content: expect.stringMatching(
      momentNote('[^\\n]+; Sam last wrote to you just now\\.'),
    ) as string,
  });

  await events.next(own('turn_running'));
  expect(performance.now() - first).toBeGreaterThanOrEqual(heartbeat / 2);
  await events.next(own('turn_completed'));

  // The person's turn outlasts a heartbeat: four pings of a silent stream.
  const held = model.hold();
  const answered = say('Still there?', 'still');

  await held.arrived();
  await silent(events, 4);
  held.release(reply('Here.'));
  await answered;

  const spokeAgain = performance.now();

  await events.next(own('turn_running'));
  expect(performance.now() - spokeAgain).toBeGreaterThanOrEqual(heartbeat / 2);
});

it('heartbeat.quiet: a moment answered with plain text or with nothing commits no message: the stream holds only its start and its end, her log keeps the thought, and no later prompt replays it; one whose provider fails ends rejected, leaves her ready, and her next moment comes on time', async () => {
  const model = await startModelServer();
  const home = heartbeatHome(model);
  const daemon = await startDaemon(home, shortened);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');

  model.answer(
    reply('Tea first.'),
    reply('I wonder if Sam found the keys.'),
    nothing,
    {status: 401, body: {error: {message: 'Who are you?'}}},
    nothing,
  );
  await say('Morning.', 'morning');

  for (const ended of [
    {status: 'completed', committed: true},
    {status: 'completed', committed: true},
    {
      status: 'rejected',
      reason: 'provider_error',
      message: expect.stringContaining('Who are you?') as string,
    },
  ]) {
    const moment = await nextMoment(events);

    expect(moment.map(frame => frame.event)).toEqual([
      'turn_running',
      'turn_completed',
    ]);
    expect(dataOf(moment[0])).toMatchObject({drafts: []});
    expect(dataOf(moment[1])).toMatchObject(ended);
  }

  const failed = performance.now();
  const after = events.frames.length;

  await events.next(own('turn_running'));
  expect(performance.now() - failed).toBeGreaterThanOrEqual(heartbeat / 2);
  await events.next(own('turn_completed'));
  expect(events.frames.slice(after).filter(frameOf('state_changed'))).toEqual(
    [],
  );

  model.answer(reply('Still here.'));
  await say('Still there?', 'still');
  expect(conversationIn(model.requests.at(-1))).toMatchObject([
    {role: 'user', content: 'Morning.'},
    {role: 'assistant', content: 'Tea first.'},
    {role: 'user', content: 'Still there?'},
  ]);

  const log = sessionLog(home, 'mira', `${conversationId}.1`);

  expect(log).toContainEqual(
    expect.objectContaining({
      kind: 'runtime_event_received',
      occasion: 'moment',
    }),
  );
  expect(log).toContainEqual(
    expect.objectContaining({
      kind: 'role_model_round',
      parsedRoleModelDecisionSnapshot: {
        result: {
          status: 'accepted',
          decision: {toolCalls: [], text: 'I wonder if Sam found the keys.'},
        },
      },
    }),
  );
  expect((await wire.history(conversationId)) as object).toMatchObject({
    messages: [
      {text: 'Morning.'},
      {text: 'Tea first.'},
      {text: 'Still there?'},
      {text: 'Still here.'},
    ],
  });
});

it("heartbeat.writes-first: a moment that calls visible_reply commits her message, told as the reply of a turn with no line's stamps, in the scrollback with no line before it, and replayed in the next prompt after the moment's note", async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(heartbeatHome(model), shortened);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');

  model.answer(reply('Tea first.'), {
    chunks: [...visibleReply('Found your keys yet?'), finish('tool_calls')],
  });
  await say('Morning.', 'morning');

  const moment = await nextMoment(events);

  expect(
    moment.filter(frameOf('turn_progress')).map(frame => dataOf(frame)),
  ).toMatchObject([
    {
      characterId: 'mira',
      conversationId,
      progress: {
        kind: 'visible_reply',
        speakerName: 'Mira',
        text: 'Found your keys yet?',
      },
    },
  ]);
  expect(dataOf(moment.at(-1))).toMatchObject({status: 'completed'});

  const {messages} = (await wire.history(conversationId)) as {
    readonly messages: readonly Record<string, unknown>[];
  };

  expect(messages).toMatchObject([
    {role: 'user', text: 'Morning.'},
    {role: 'character', text: 'Tea first.'},
    {role: 'character', text: 'Found your keys yet?'},
  ]);
  expect(messages[2]).not.toHaveProperty('clientMessageId');

  model.answer(reply('Good.'));
  await say('Yes!', 'yes');
  expect(conversationIn(model.requests.at(-1))).toMatchObject([
    {role: 'user', content: 'Morning.'},
    {role: 'assistant', content: 'Tea first.'},
    {
      role: 'user',
      content: expect.stringMatching(pastMoment) as string,
    },
    {role: 'assistant', content: 'Found your keys yet?'},
    {role: 'user', content: 'Yes!'},
  ]);
});

it("heartbeat.tools: a moment in which she uses a tool and says nothing ends without a message, the tool's effect stands, and the next prompt shows the moment and its tool work", async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(heartbeatHome(model), shortened);
  const events = await openEvents(daemon);
  const say = await converse(wireOf(daemon), 'mira');

  model.answer(
    reply('Tea first.'),
    calling(['character_state_patch', {mood: 'curious'}]),
    nothing,
  );
  await say('Morning.', 'morning');

  const moment = await nextMoment(events);

  expect(
    moment
      .filter(frameOf('turn_progress'))
      .map(frame => dataOf(frame)['progress']),
  ).toMatchObject([
    {kind: 'tool_calls_requested', toolNames: ['character_state.patch']},
    {
      kind: 'tool_call_completed',
      status: 'accepted',
      toolName: 'character_state.patch',
    },
  ]);
  expect(dataOf(moment.at(-1))).toMatchObject({status: 'completed'});

  model.answer(reply('Curious.'));
  await say('How are you?', 'how');

  const prompt = model.requests.at(-1);

  expect(
    messagesOf(prompt).some(
      message =>
        message.role === 'system' &&
        message.content?.includes('mood=curious') === true,
    ),
  ).toBe(true);
  expect(conversationIn(prompt)).toMatchObject([
    {role: 'user', content: 'Morning.'},
    {role: 'assistant', content: 'Tea first.'},
    {
      role: 'user',
      content: expect.stringMatching(pastMoment) as string,
    },
    {
      role: 'assistant',
      tool_calls: [{function: {name: 'character_state_patch'}}],
    },
    {role: 'tool'},
    {role: 'user', content: 'How are you?'},
  ]);
});

it('heartbeat.person-first: a line that comes while a moment of hers runs is answered as soon as the moment ends, and one that comes while that turn runs, past a heartbeat, is taken before any moment', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(heartbeatHome(model), pinging);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const line = (text: string, clientMessageId: string) =>
    wire.turn({conversationId, text, source: 'web', clientMessageId});

  model.answer(reply('Tea first.'));
  await say('Morning.', 'morning');

  const moment = model.hold();

  await moment.arrived();
  expect(await line('Are you there?', 'there')).toEqual({status: 'queued'});

  const answering = model.hold();

  moment.release(nothing);
  await answering.arrived();
  expect(await line('And now?', 'now')).toEqual({status: 'queued'});
  await silent(events, 4);
  model.answer(reply('Now, too.'));
  answering.release(reply('I am.'));
  await events.next(frameOf('turn_completed', {clientMessageId: 'now'}));

  const next = await events.next(own('turn_running'));

  expect(
    events.frames
      .slice(0, events.frames.indexOf(next))
      .filter(frameOf('turn_completed'))
      .map(frame => dataOf(frame)['clientMessageId'] ?? 'her own'),
  ).toEqual(['morning', 'her own', 'there', 'now']);
});

it("heartbeat.setting: off means no moment, each character's heartbeat is her own and the home has none, half an hour unless she has one, a change while she runs applies without a restart, and a value not among the choices is refused", async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
    characters: {
      nova: {'project02.character.json': characterJson('nova', 'Nova')},
    },
    'character-data': {
      mira: {'config.json': configJson({project02: {heartbeat: 'off'}})},
    },
  });
  const daemon = await startDaemon(home, shortened);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const statesSince = (from: number, characterId: string) =>
    events.frames
      .slice(from)
      .filter(frameOf('state_changed', {characterId}))
      .map(frame => dataOf(frame)['state']);

  await wire.start('nova');
  await conversationOf(wire, 'mira');
  await conversationOf(wire, 'nova');
  expect(await hostField(wire, nova, 'heartbeat')).toMatchObject({
    label: 'A Moment to Herself',
    authored: {configured: false},
    effective: {source: 'default', value: '30m'},
  });
  expect(await hostField(wire, {scope: 'global'}, 'heartbeat')).toBe(undefined);

  // Two of Nova's moments, half an hour apart, and none of Mira's.
  await events.next(own('turn_completed', 'nova'));
  await events.next(own('turn_completed', 'nova'));
  expect(events.frames.filter(own('turn_running', 'mira'))).toEqual([]);

  const changed = events.frames.length;

  await saveConfig(wire, nova, {
    kind: 'set',
    path: 'project02.heartbeat',
    value: 'off',
  });
  await saveConfig(wire, mira, {
    kind: 'set',
    path: 'project02.heartbeat',
    value: '15m',
  });
  await events.next(own('turn_completed', 'mira'));
  await events.next(own('turn_completed', 'mira'));
  expect(
    events.frames.slice(changed).filter(own('turn_running', 'nova')),
  ).toEqual([]);
  expect(statesSince(changed, 'mira')).toEqual(['ready']);
  expect(statesSince(changed, 'nova')).toEqual(['ready']);

  for (const [target, value] of [
    [mira, '10m'],
    [{scope: 'global'}, '15m'],
  ] as const) {
    expect(
      await changeConfig(wire, target, {
        kind: 'set',
        path: 'project02.heartbeat',
        value,
      }),
    ).toMatchObject({
      status: 'refused',
      message: expect.stringContaining('heartbeat') as string,
    });
  }

  expect(await hostField(wire, mira, 'heartbeat')).toMatchObject({
    authored: {configured: true, value: '15m'},
  });
});

it('heartbeat.not-before-met: a character whose thread was never opened has no moment, and after a restart with no client opening anything, one whose thread was has hers a heartbeat after her start', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
    characters: {
      nova: {'project02.character.json': characterJson('nova', 'Nova')},
    },
    'character-data': {
      mira: {'config.json': configJson({project02: {heartbeat: '15m'}})},
      nova: {'config.json': configJson({project02: {heartbeat: '15m'}})},
    },
  });
  const first = await startDaemon(home, shortened);
  const wire = wireOf(first);
  const events = await openEvents(first);

  await wire.start('nova');
  await conversationOf(wire, 'mira');
  await events.next(own('turn_completed'));
  await events.next(own('turn_completed'));
  expect(events.frames.filter(own('turn_running', 'nova'))).toEqual([]);

  first.signal('SIGINT');
  await first.exit();

  const second = await startDaemon(home, shortened);
  const started = performance.now();
  const again = await openEvents(second);

  await again.next(own('turn_running'));
  expect(performance.now() - started).toBeGreaterThanOrEqual(heartbeat / 2);
  await again.next(own('turn_completed'));
  await again.next(own('turn_completed'));
  expect(again.frames.filter(own('turn_running', 'nova'))).toEqual([]);
  expect(readdirSync(join(home, 'conversations'))).toHaveLength(1);
});

it('heartbeat.telegram: her own message shows in every paired chat of her bot with Show Other Chats off, and a moment in which she says nothing sends Telegram nothing, not even typing', async () => {
  const miraBot = {token: '987654:mira', id: 987654, username: 'mira_bot'};
  const accounts = [
    {id: 4242, first_name: 'Alice'},
    {id: 5151, first_name: 'Bob'},
  ];
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({
      project02: model.settings,
      connectors: {
        telegram: {
          config: {
            mirror: false,
            pairedUsers: Object.fromEntries(
              accounts.map(account => [String(account.id), account.first_name]),
            ),
          },
        },
      },
    }),
    'character-data': {
      mira: {
        'config.json': configJson({
          project02: {heartbeat: '15m'},
          connectors: {telegram: {config: {botToken: miraBot.token}}},
        }),
      },
    },
  });
  const daemon = await startDaemon(home, shortened);
  const events = await openEvents(daemon);
  const telegram = await startTelegramServer([miraBot]);
  const run = connector(['--store', home], telegram.env);

  // Her bot opens her thread, and her heartbeat starts: her first moment is
  // a thought of her own, her second a message.
  model.answer(reply('I wonder how they are.'), {
    chunks: [...visibleReply('Thinking of you.'), finish('tool_calls')],
  });
  await run.printed('Telegram: @mira_bot answers for Mira.');
  await events.next(own('turn_completed'));

  for (const account of accounts) {
    await telegram.shows(miraBot.token, account.id, 'Thinking of you.');
    expect(
      telegram
        .calls(miraBot.token)
        .filter(call => call.body['chat_id'] === account.id)
        .map(call => [call.method, call.body['text']]),
    ).toEqual([['sendMessage', 'Thinking of you.']]);
  }
});
