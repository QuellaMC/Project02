import {writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {startDaemon, type Daemon} from './harness/daemon.ts';
import {frameOf, openEvents, type Frame} from './harness/events.ts';
import {characterJson, chmod, configJson, createHome} from './harness/home.ts';
import {
  messagesOf,
  reply,
  startModelServer,
  undecided,
} from './harness/model-server.ts';
import {
  conversationOf,
  converse,
  saveConfig,
  wireOf,
  type Wire,
} from './harness/wire.ts';

const fixedReplies = {PROJECT02_TEST_PROVIDER: 'deterministic'};
// A window this small rotates the segment after every turn.
const rotatingEveryTurn = configJson({project02: {contextWindowTokens: 1}});

async function stop(daemon: Daemon): Promise<void> {
  daemon.signal('SIGINT');
  await daemon.exit();
}

function dataOf(frame: Frame): unknown {
  return JSON.parse(frame.data ?? '');
}

/** Lines from the local user on the web, onto the character's conversation. */
async function linesTo(wire: Wire, characterId: string) {
  const {conversationId} = await conversationOf(wire, characterId);

  return (text: string, clientMessageId: string) => ({
    conversationId,
    text,
    source: 'web',
    clientMessageId,
  });
}

it('turns.open-direct: an open on a running character answers its direct conversation, the same one on every open, after a restart too', async () => {
  const home = createHome();
  const first = await startDaemon(home, fixedReplies);
  const wire = wireOf(first);

  await wire.start('mira');

  const opened = await wire.open('mira');

  expect(opened).toMatchObject({status: 'opened', characterId: 'mira'});
  await expect(wire.open('mira')).resolves.toEqual(opened);
  await stop(first);

  const again = wireOf(await startDaemon(home, fixedReplies));

  await again.start('mira');
  await expect(again.open('mira')).resolves.toEqual(opened);
});

it("turns.deliver-queued: a line is answered queued at once, and the stream tells its turn: the reply under the character's display name, then the turn completed with its line in the log", async () => {
  const daemon = await startDaemon(createHome(), fixedReplies);
  const wire = wireOf(daemon);

  await wire.start('mira');

  const line = await linesTo(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const events = await openEvents(daemon);

  await expect(wire.turn(line('Hello there.', 'hello'))).resolves.toEqual({
    status: 'queued',
  });
  expect(
    dataOf(
      await events.next(
        frameOf('turn_progress', {progress: {kind: 'visible_reply'}}),
      ),
    ),
  ).toMatchObject({
    characterId: 'mira',
    conversationId,
    progress: {
      speakerId: 'mira',
      speakerName: 'Mira',
      text: "I'm here. Tell me what you need.",
    },
  });
  expect(dataOf(await events.next(frameOf('turn_completed')))).toEqual({
    kind: 'turn_completed',
    characterId: 'mira',
    conversationId,
    source: 'web',
    clientMessageId: 'hello',
    status: 'completed',
    committed: true,
  });
});

it('turns.multi-line-message: a line of several lines, CRLF and CR made LF and both ends trimmed, reaches the model, the history and the stream as written, and a reply of several lines reads back with its line breaks', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
  );
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const events = await openEvents(daemon);
  const sent = ' Two things:\r\nthe tea,\rand the rain.\r\n\r\nThat is all.\n';
  const taken = 'Two things:\nthe tea,\nand the rain.\n\nThat is all.';
  const poem = 'Roses are red.\n\nThe rest is lost.';

  model.answer(reply(poem));
  expect(await say(sent, 'lines')).toMatchObject({
    status: 'completed',
    messages: [{text: taken}, {text: poem}],
  });
  expect(
    model.requests.map(request => messagesOf(request).at(-1)?.content),
  ).toEqual([taken]);
  await expect(wire.history(conversationId)).resolves.toMatchObject({
    messages: [{text: taken}, {text: poem}],
  });

  const announced = await events.next(
    frameOf('turn_progress', {progress: {kind: 'user_message'}}),
  );

  expect(JSON.parse(announced.data ?? '')).toMatchObject({
    progress: {clientMessageId: 'lines', text: taken},
  });
});

it('turns.repeat-answers: a line sent again while it is queued or running answers already_queued and runs nothing more; once she took it, a repeat answers duplicate_submission naming the message it became, the same after a restart, and it is in history once; the same id to another character is another line', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
    characters: {
      zeta: {'project02.character.json': characterJson('zeta', 'Zeta')},
    },
  });
  const first = await startDaemon(home);
  const wire = wireOf(first);
  const say = await converse(wire, 'mira');
  const line = await linesTo(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const events = await openEvents(first);
  const held = model.hold();
  const one = say('One.', 'one');

  await held.arrived();
  await expect(wire.turn(line('Two.', 'two'))).resolves.toEqual({
    status: 'queued',
  });

  for (const [text, id] of [
    ['One.', 'one'],
    ['Two.', 'two'],
  ] as const) {
    await expect(wire.turn(line(text, id)), id).resolves.toEqual({
      status: 'already_queued',
    });
  }

  model.answer(reply('Second.'));
  held.release(reply('First.'));
  await expect(one).resolves.toMatchObject({status: 'completed'});

  const two = dataOf(
    await events.next(
      frameOf('turn_progress', {
        progress: {kind: 'user_message', clientMessageId: 'two'},
      }),
    ),
  ) as {readonly progress: {readonly messageId: string}};

  await events.next(
    frameOf('turn_completed', {clientMessageId: 'two', status: 'completed'}),
  );

  const taken = await wire.turn(line('Two.', 'two'));

  expect(taken).toEqual({
    status: 'refused',
    reason: 'duplicate_submission',
    message: expect.stringContaining(two.progress.messageId) as string,
  });

  const sayZeta = await converse(wire, 'zeta');

  model.answer(reply('Zeta here.'));
  await expect(sayZeta('Two.', 'two')).resolves.toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'Zeta here.'}],
  });
  await stop(first);

  const again = wireOf(await startDaemon(home));

  await again.start('mira');
  await expect(again.turn(line('Two.', 'two'))).resolves.toEqual(taken);
  expect(model.requests).toHaveLength(3);
  await expect(again.history(conversationId)).resolves.toMatchObject({
    messages: [
      {clientMessageId: 'one'},
      {text: 'First.'},
      {clientMessageId: 'two'},
      {text: 'Second.'},
    ],
  });
});

it('turns.inbox-survives-kill: a line sent while her turn is held at the model is queued at once, survives the daemon killed, and runs once she is back; the line the kill cut short is not run again, and while she cannot start, a line sent again is answered as her inbox has it', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const killed = await startDaemon(home);
  const wire = wireOf(killed);

  await wire.start('mira');

  const line = await linesTo(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const cut = model.hold();

  await expect(wire.turn(line('One.', 'one'))).resolves.toEqual({
    status: 'queued',
  });
  await cut.arrived();
  await expect(wire.turn(line('Two.', 'two'))).resolves.toEqual({
    status: 'queued',
  });
  killed.signal('SIGKILL');
  await killed.exit();
  writeFileSync(
    join(home, 'config.json'),
    configJson({project02: {...model.settings, contextWindowTokens: -5}}),
  );

  const back = await startDaemon(home);
  const again = wireOf(back);
  const events = await openEvents(back);

  await again.start('mira');

  for (const [text, id] of [
    ['One.', 'one'],
    ['Two.', 'two'],
  ] as const) {
    await expect(again.turn(line(text, id)), id).resolves.toEqual({
      status: 'already_queued',
    });
  }

  writeFileSync(
    join(home, 'config.json'),
    configJson({project02: model.settings}),
  );

  const held = model.hold();

  await again.start('mira');
  await held.arrived();
  expect(messagesOf(model.requests[1]).at(-1)?.content).toBe('Two.');
  held.release(reply('Two, at last.'));
  await events.next(
    frameOf('turn_completed', {clientMessageId: 'two', status: 'completed'}),
  );
  expect(model.requests).toHaveLength(2);
  await expect(again.history(conversationId)).resolves.toMatchObject({
    messages: [{text: 'One.'}, {text: 'Two.'}, {text: 'Two, at last.'}],
  });
});

it('turns.one-turn-at-a-time: a character runs her turns one at a time, in the order they arrived, so the model never sees two at once', async () => {
  const model = await startModelServer();
  const wire = wireOf(
    await startDaemon(
      createHome({'config.json': configJson({project02: model.settings})}),
    ),
  );
  const say = await converse(wire, 'mira');
  const first = model.hold();
  const one = say('One.', 'one');

  await first.arrived();

  // Sent while the model holds the first turn.
  const second = model.hold();
  const two = say('Two.', 'two');

  await wire.health();
  expect(model.requests).toHaveLength(1);
  first.release(reply('First.'));
  await second.arrived();

  // Sent once the model has the second turn, so it comes after it.
  model.answer(reply('Third.'));

  const three = say('Three.', 'three');

  await wire.health();
  expect(model.requests).toHaveLength(2);
  second.release(reply('Second.'));
  await Promise.all([one, two, three]);
  // Each round was asked for only once the turn before it had its reply.
  expect(
    model.requests.map(request =>
      messagesOf(request)
        .filter(message => message.role !== 'system')
        .map(message => message.content),
    ),
  ).toEqual([
    ['One.'],
    ['One.', 'First.', 'Two.'],
    ['One.', 'First.', 'Two.', 'Second.', 'Three.'],
  ]);
});

it("turns.concurrent-characters: two characters' turns run at once, each on its own character and answered under its display name", async () => {
  const model = await startModelServer();
  const wire = wireOf(
    await startDaemon(
      createHome({
        'config.json': configJson({project02: model.settings}),
        characters: {
          zeta: {'project02.character.json': characterJson('zeta', 'Zeta')},
        },
      }),
    ),
  );
  const toMira = await converse(wire, 'mira');
  const toZeta = await converse(wire, 'zeta');
  const mira = model.hold();
  const miraTurn = toMira('Hello, Mira.', 'mira');

  await mira.arrived();

  const zeta = model.hold();
  const zetaTurn = toZeta('Hello, Zeta.', 'zeta');

  // Mira's turn is still waiting on the model when Zeta's reaches it.
  await zeta.arrived();
  zeta.release(reply('Zeta here.'));
  mira.release(reply('Mira here.'));
  expect(await miraTurn).toMatchObject({
    characterId: 'mira',
    messages: [
      {},
      {speakerId: 'mira', speakerName: 'Mira', text: 'Mira here.'},
    ],
  });
  expect(await zetaTurn).toMatchObject({
    characterId: 'zeta',
    messages: [
      {},
      {speakerId: 'zeta', speakerName: 'Zeta', text: 'Zeta here.'},
    ],
  });
  expect(
    model.requests.map(request => {
      const messages = messagesOf(request);

      return [messages[0]?.content, messages.at(-1)?.content];
    }),
  ).toEqual([
    [expect.stringContaining('You are Mira'), 'Hello, Mira.'],
    [expect.stringContaining('You are Zeta.'), 'Hello, Zeta.'],
  ]);
});

it("turns.rejected-turn-outcome: after a turn the model's output fails, the character stays ready and the next turn completes", async () => {
  const model = await startModelServer();
  const wire = wireOf(
    await startDaemon(
      createHome({'config.json': configJson({project02: model.settings})}),
    ),
  );
  const say = await converse(wire, 'mira');

  model.answer(...undecided(), reply('Clearer now.'));
  expect(await say('Hello?', 'undecided')).toMatchObject({
    status: 'rejected',
    reason: 'malformed_output',
  });
  await expect(wire.health()).resolves.toMatchObject({
    characters: [{id: 'mira', state: 'ready'}],
  });
  expect(await say('Hello again?', 'next')).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'Clearer now.'}],
  });
});

it('turns.fatal-turn-restart: a turn whose line or whose reply the store cannot write fails, committed only once its line is written, the character restarts by herself after each, and the next turn completes on her thread', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const events = await openEvents(daemon);
  const sessions = join(home, 'character-data', 'mira', 'sessions');
  const restarted = async (): Promise<void> => {
    for (const state of ['failed', 'starting', 'ready']) {
      await events.next(frameOf('state_changed', {characterId: 'mira', state}));
    }
  };

  chmod(sessions, 0o000);

  try {
    expect(await say('Lost?', 'lost')).toMatchObject({
      status: 'failed',
      committed: false,
    });
  } finally {
    chmod(sessions, 0o755);
  }

  await restarted();

  const held = model.hold();
  const fatal = say('First.', 'fatal');

  await held.arrived();
  chmod(sessions, 0o000);

  try {
    held.release(reply('Never written.'));
    expect(await fatal).toMatchObject({status: 'failed', committed: true});
  } finally {
    chmod(sessions, 0o755);
  }

  await restarted();
  model.answer(reply('Back again.'));
  expect(await say('Next.', 'next')).toMatchObject({
    status: 'completed',
    conversationId,
    messages: [{}, {text: 'Back again.'}],
  });
  await events.next(frameOf('turn_completed', {clientMessageId: 'next'}));
  expect(
    events.frames
      .filter(frameOf('turn_completed', {status: 'failed'}))
      .map(frame => JSON.parse(frame.data ?? '') as unknown),
  ).toMatchObject([
    {clientMessageId: 'lost', committed: false},
    {clientMessageId: 'fatal', committed: true},
  ]);
  expect(
    events.frames
      .filter(frameOf('state_changed', {characterId: 'mira'}))
      .map(frame => (JSON.parse(frame.data ?? '') as {state: string}).state),
  ).toEqual(['failed', 'starting', 'ready', 'failed', 'starting', 'ready']);
});

it('turns.history-paging: history reads a conversation across its segments as one scrollback, newest page first and chronological within it, back to the start by the earlier cursor, and a short one whole without a limit', async () => {
  const wire = wireOf(
    await startDaemon(
      createHome({'config.json': rotatingEveryTurn}),
      fixedReplies,
    ),
  );
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');

  for (const id of ['one', 'two', 'three']) {
    await say(`Line ${id}.`, id);
  }

  const whole = (await wire.history(conversationId)) as {
    readonly messages: readonly {readonly role: string}[];
  };

  expect(whole).toMatchObject({
    status: 'ok',
    conversationId,
    characterId: 'mira',
    messages: ['one', 'two', 'three'].flatMap(id => [
      {
        role: 'user',
        speakerName: 'You',
        text: `Line ${id}.`,
        source: 'web',
        clientMessageId: id,
      },
      {role: 'character', speakerName: 'Mira'},
    ]),
  });
  expect(whole).not.toHaveProperty('earlier');

  for (const line of whole.messages.filter(
    message => message.role === 'character',
  )) {
    expect(line).not.toHaveProperty('source');
  }

  const newest = (await wire.history(conversationId, {limit: 4})) as {
    readonly earlier: string;
  };

  expect(newest).toEqual({
    ...whole,
    messages: whole.messages.slice(2),
    earlier: newest.earlier,
  });
  await expect(
    wire.history(conversationId, {before: newest.earlier, limit: 4}),
  ).resolves.toEqual({...whole, messages: whole.messages.slice(0, 2)});
});

it("turns.rename-from-now-on: a rename reaches the thread from the next line on, the person's in the settings at once and the character's in her package from her next start: a new line carries the new name, an old line keeps its own, and the model is shown every line as written while it is told the new names", async () => {
  const model = await startModelServer();
  const zeta = join('characters', 'zeta', 'project02.character.json');
  const home = createHome({
    'config.json': configJson({
      project02: {...model.settings, userDisplayName: 'Mike'},
    }),
    characters: {
      zeta: {'project02.character.json': characterJson('zeta', 'Zeta')},
    },
  });
  const earlier = await startDaemon(home);
  const earlierWire = wireOf(earlier);
  const sayEarlier = await converse(earlierWire, 'zeta');
  const {conversationId} = await conversationOf(earlierWire, 'zeta');
  const named = (user: string, character: string) => [
    {speakerName: user},
    {speakerName: character},
  ];
  const told = (request: number) =>
    messagesOf(model.requests[request])
      .filter(message => message.role === 'system')
      .map(message => message.content)
      .join('\n');
  const shown = (request: number) =>
    messagesOf(model.requests[request])
      .filter(message => message.role !== 'system')
      .map(({role, content}) => ({role, content}));

  model.answer(reply('Hello, Mike.'), reply('Hello, Michael.'));
  await sayEarlier('I am Mike.', 'first');
  await saveConfig(
    earlierWire,
    {scope: 'global'},
    {kind: 'set', path: 'project02.userDisplayName', value: 'Michael'},
  );
  expect(await sayEarlier('Call me Michael.', 'second')).toMatchObject({
    messages: named('Michael', 'Zeta'),
  });
  expect(told(1)).toContain('Michael');
  expect(told(1)).not.toContain('Mike');
  expect(shown(1)).toEqual([
    {role: 'user', content: 'I am Mike.'},
    {role: 'assistant', content: 'Hello, Mike.'},
    {role: 'user', content: 'Call me Michael.'},
  ]);
  await stop(earlier);
  writeFileSync(join(home, zeta), characterJson('zeta', 'Zed'));

  const wire = wireOf(await startDaemon(home));
  const say = await converse(wire, 'zeta');

  model.answer(reply('I am Zed now.'));
  expect(await say('Who are you?', 'third')).toMatchObject({
    messages: named('Michael', 'Zed'),
  });
  expect(told(2)).toContain('Zed');
  expect(told(2)).not.toContain('Zeta');
  expect(shown(2)).toEqual([
    {role: 'user', content: 'I am Mike.'},
    {role: 'assistant', content: 'Hello, Mike.'},
    {role: 'user', content: 'Call me Michael.'},
    {role: 'assistant', content: 'Hello, Michael.'},
    {role: 'user', content: 'Who are you?'},
  ]);
  await expect(wire.history(conversationId)).resolves.toMatchObject({
    messages: [
      ...named('Mike', 'Zeta'),
      ...named('Michael', 'Zeta'),
      ...named('Michael', 'Zed'),
    ],
  });
});
