import {readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {startDaemon, type Daemon} from './harness/daemon.ts';
import {frameOf, openEvents} from './harness/events.ts';
import {
  characterJson,
  chmod,
  configJson,
  createHome,
  sessionLog,
} from './harness/home.ts';
import {
  finish,
  messagesOf,
  reply,
  startModelServer,
  toolCall,
  undecided,
  visibleReply,
} from './harness/model-server.ts';
import {exchange, jsonFrom} from './harness/http.ts';
import {conversationOf, converse, wireOf} from './harness/wire.ts';

const fixedReplies = {PROJECT02_TEST_PROVIDER: 'deterministic'};
// A window this small rotates the segment after every turn.
const rotatingEveryTurn = configJson({project02: {contextWindowTokens: 1}});

async function stop(daemon: Daemon): Promise<void> {
  daemon.signal('SIGINT');
  await daemon.exit();
}

function segmentDirectory(home: string, conversationId: string): string {
  return join(
    home,
    'character-data',
    'mira',
    'sessions',
    `${conversationId}.1`,
  );
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

it("turns.deliver-completed: a turn answers once it has ended, completed with the committed user line and the reply under the character's display name", async () => {
  const wire = wireOf(await startDaemon(createHome(), fixedReplies));
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');

  expect(await say('Hello there.', 'hello')).toEqual({
    status: 'completed',
    characterId: 'mira',
    conversationId,
    messages: [
      {
        messageId: expect.any(String) as string,
        speakerId: 'local-user',
        speakerName: 'You',
        text: 'Hello there.',
      },
      {
        messageId: expect.any(String) as string,
        speakerId: 'mira',
        speakerName: 'Mira',
        text: "I'm here. Tell me what you need.",
      },
    ],
  });
});

it('turns.open-refusals: an open on an installed character that is not running is refused character_unavailable, and on an unknown id unknown_character naming the installed ones', async () => {
  const wire = wireOf(
    await startDaemon(
      createHome({
        'config.json': configJson({project02: {enabled: false}}),
        characters: {
          zeta: {'project02.character.json': characterJson('zeta', 'Zeta')},
        },
      }),
      fixedReplies,
    ),
  );

  await expect(wire.open('mira')).resolves.toMatchObject({
    status: 'refused',
    reason: 'character_unavailable',
  });

  const unknown = await wire.open('zed');

  expect(unknown).toMatchObject({
    status: 'refused',
    reason: 'unknown_character',
  });
  expect(unknown.status === 'refused' && unknown.message).toMatch(
    /mira.*zeta|zeta.*mira/u,
  );
});

it('turns.unknown-conversation: a turn on a conversation the home does not hold is refused unknown_conversation', async () => {
  const wire = wireOf(await startDaemon(createHome(), fixedReplies));

  await expect(
    wire.turn({
      conversationId: 'conv_missing',
      senderId: 'local-user',
      text: 'Anyone there?',
      source: 'web',
      clientMessageId: 'missing',
    }),
  ).resolves.toMatchObject({
    status: 'refused',
    reason: 'unknown_conversation',
  });
});

it('turns.stamp-pattern: a turn whose source stamp breaks the pattern is a 400 before any turn runs, and nothing of it reaches the stream', async () => {
  const daemon = await startDaemon(createHome(), fixedReplies);
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId, userParticipantId} = await conversationOf(
    wire,
    'mira',
  );
  const events = await openEvents(daemon);

  for (const source of ['we b', '-web', 'w'.repeat(65)]) {
    const refused = await exchange(daemon, {
      method: 'POST',
      path: '/api/turns',
      headers: jsonFrom(daemon),
      body: JSON.stringify({
        conversationId,
        senderId: userParticipantId,
        text: 'Hello?',
        source,
        clientMessageId: 'stamped',
      }),
    });

    expect(refused.status, source).toBe(400);
    expect(JSON.parse(await refused.whole()), source).toMatchObject({
      error: {code: 'invalid_request'},
    });
  }

  await say('Hello?', 'valid');
  await events.next(frameOf('turn_completed', {clientMessageId: 'valid'}));
  expect(events.frames[1]).toSatisfy(
    frameOf('turn_progress', {
      progress: {kind: 'user_message', clientMessageId: 'valid'},
    }),
  );
});

it('turns.multi-line-message: a message of several lines is taken with its line breaks, CRLF and CR made LF and both ends trimmed, and reaches the model, the history and the stream as written; a blank one is rejected input_validation_rejected with nothing committed and nothing asked of the model', async () => {
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

  expect(await say(' \r\n\t ', 'blank')).toEqual({
    status: 'rejected',
    characterId: 'mira',
    conversationId,
    reason: 'input_validation_rejected',
    message: 'Provide a non-empty message.',
    committed: false,
  });

  model.answer(reply('Both noted.'));
  expect(await say(sent, 'lines')).toMatchObject({
    status: 'completed',
    messages: [{text: taken}, {}],
  });
  expect(
    model.requests.map(request => messagesOf(request).at(-1)?.content),
  ).toEqual([taken]);
  await expect(wire.history(conversationId)).resolves.toMatchObject({
    messages: [{text: taken}, {text: 'Both noted.'}],
  });

  const announced = await events.next(
    frameOf('turn_progress', {progress: {kind: 'user_message'}}),
  );

  expect(JSON.parse(announced.data ?? '')).toMatchObject({
    progress: {clientMessageId: 'lines', text: taken},
  });
});

it('turns.message-ids: committed messages are numbered <sessionId>:message-N in one sequence, whatever their role', async () => {
  const wire = wireOf(await startDaemon(createHome(), fixedReplies));
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');

  await say('One.', 'one');
  await say('Two.', 'two');
  await expect(wire.history(conversationId)).resolves.toMatchObject({
    messages: ['user', 'character', 'user', 'character'].map((role, index) => ({
      role,
      messageId: `${conversationId}.1:message-${String(index + 1)}`,
    })),
  });
});

it('turns.client-message-id-join: a repeat of a submission, while it runs or after, gets its outcome without a second model request; only a new id runs a new turn, and the same id on another conversation is another turn', async () => {
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
  const say = await converse(wire, 'mira');
  const held = model.hold();
  const first = say('Hello?', 'hello');

  await held.arrived();

  const repeat = say('Hello?', 'hello');

  // Nothing outside the daemon shows whether the repeat is in before the
  // turn ends or after; either way it gets the outcome and the model is
  // not asked again. The round trip makes the first the likelier.
  await wire.health();
  held.release(reply('Hello.'));

  const outcome = await first;

  expect(outcome).toMatchObject({status: 'completed'});
  expect(await repeat).toEqual(outcome);
  expect(await say('Hello?', 'hello')).toEqual(outcome);
  expect(model.requests).toHaveLength(1);
  model.answer(reply('Hello again.'));
  expect(await say('Hello?', 'hello-again')).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'Hello again.'}],
  });
  expect(model.requests).toHaveLength(2);

  const sayZeta = await converse(wire, 'zeta');

  model.answer(reply('Zeta here.'));
  expect(await sayZeta('Hello?', 'hello')).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'Zeta here.'}],
  });
  expect(model.requests).toHaveLength(3);
});

it('turns.client-message-id-conflict: the same client message id with another line is refused, while the first runs and after it', async () => {
  const model = await startModelServer();
  const wire = wireOf(
    await startDaemon(
      createHome({'config.json': configJson({project02: model.settings})}),
    ),
  );
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const held = model.hold();
  const first = say('Hello.', 'mine');
  const refused = {status: 'refused', reason: 'invalid_message'};

  await held.arrived();
  expect(await say('Something else.', 'mine')).toMatchObject(refused);
  held.release(reply('Hi.'));
  expect(await first).toMatchObject({status: 'completed'});
  expect(await say('Something else.', 'mine')).toMatchObject(refused);
  await expect(wire.history(conversationId)).resolves.toMatchObject({
    messages: [{text: 'Hello.'}, {}],
  });
});

it('turns.duplicate-submission-across-restart: after a restart a line already committed, also one just before a rotation, is refused duplicate_submission, said committed on the stream, and is in history once', async () => {
  const home = createHome({'config.json': rotatingEveryTurn});
  const rotating = await startDaemon(home, fixedReplies);
  const sayRotating = await converse(wireOf(rotating), 'mira');

  await sayRotating('Rotated away.', 'rotated');
  await stop(rotating);
  writeFileSync(join(home, 'config.json'), configJson({}));

  const staying = await startDaemon(home, fixedReplies);
  const sayStaying = await converse(wireOf(staying), 'mira');

  await sayStaying('Still here.', 'current');
  await stop(staying);

  const daemon = await startDaemon(home, fixedReplies);
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const events = await openEvents(daemon);

  for (const [text, id] of [
    ['Rotated away.', 'rotated'],
    ['Still here.', 'current'],
  ] as const) {
    expect(await say(text, id), id).toMatchObject({
      status: 'refused',
      reason: 'duplicate_submission',
    });
    await events.next(
      frameOf('turn_completed', {
        clientMessageId: id,
        status: 'refused',
        committed: true,
      }),
    );
  }

  await expect(wire.history(conversationId)).resolves.toMatchObject({
    messages: [
      {clientMessageId: 'rotated'},
      {role: 'character'},
      {clientMessageId: 'current'},
      {role: 'character'},
    ],
  });
});

it('turns.damaged-segment-open: without the record of taken lines, an open fails read_failed while the segment before the current one is unreadable, and open and history fail missing_file once its transcript is gone', async () => {
  const home = createHome({'config.json': rotatingEveryTurn});
  const first = await startDaemon(home, fixedReplies);
  const firstWire = wireOf(first);
  const say = await converse(firstWire, 'mira');
  const {conversationId} = await conversationOf(firstWire, 'mira');

  await say('One.', 'one');
  const previous = segmentDirectory(home, conversationId);

  await stop(first);
  rmSync(
    join(
      home,
      'character-data',
      'mira',
      'taken-lines',
      `${conversationId}.json`,
    ),
  );

  const wire = wireOf(await startDaemon(home, fixedReplies));

  await wire.start('mira');
  chmod(previous, 0o000);

  try {
    await expect(wire.open('mira')).resolves.toMatchObject({
      status: 'failed',
      code: 'read_failed',
    });
  } finally {
    chmod(previous, 0o755);
  }

  rmSync(join(previous, 'raw-events.jsonl'));
  await expect(wire.open('mira')).resolves.toMatchObject({
    status: 'failed',
    code: 'missing_file',
  });
  await expect(wire.history(conversationId)).resolves.toMatchObject({
    status: 'failed',
    code: 'missing_file',
  });
});

it('turns.one-turn-at-a-time: a character runs its turns one at a time, in the order they arrived, so the model never sees two at once', async () => {
  const model = await startModelServer();
  const wire = wireOf(
    await startDaemon(
      createHome({'config.json': configJson({project02: model.settings})}),
    ),
  );
  const say = await converse(wire, 'mira');
  const first = model.hold();
  const turns = [say('One.', 'one')];

  await first.arrived();

  for (const [text, id] of [
    ['Two.', 'two'],
    ['Three.', 'three'],
  ] as const) {
    turns.push(say(text, id));
    // Nothing outside the daemon shows a turn waiting its turn; a round
    // trip answered since makes each the likelier to be in before the next.
    await wire.health();
  }

  // While the first is held, the model has seen no other.
  expect(model.requests).toHaveLength(1);
  model.answer(reply('Second.'), reply('Third.'));
  first.release(reply('First.'));
  await Promise.all(turns);
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

it('turns.multiline-reply: a reply of several lines is committed and read back with its line breaks', async () => {
  const model = await startModelServer();
  const wire = wireOf(
    await startDaemon(
      createHome({'config.json': configJson({project02: model.settings})}),
    ),
  );
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const poem = 'Roses are red.\n\nThe rest is lost.';

  model.answer(reply(poem));
  expect(await say('A poem?', 'poem')).toMatchObject({
    messages: [{}, {text: poem}],
  });
  await expect(wire.history(conversationId)).resolves.toMatchObject({
    messages: [{}, {text: poem}],
  });
});

it("turns.interim-reply-committed-before-tools: a reply beside a tool call is committed and announced before the round's tools run, and every message has its own commit record", async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const events = await openEvents(daemon);

  model.answer(
    {
      chunks: [
        ...visibleReply('Let me look.'),
        ...toolCall({
          index: 1,
          id: 'call_search',
          name: 'sessions_search',
          arguments: JSON.stringify({query: 'tea'}),
        }),
        finish('tool_calls'),
      ],
    },
    {chunks: [...visibleReply('Nothing about tea yet.'), finish('tool_calls')]},
  );
  await say('Did we talk about tea?', 'tea');
  await events.next(frameOf('turn_completed', {clientMessageId: 'tea'}));
  expect(
    events.frames
      .filter(frameOf('turn_progress'))
      .map(
        frame =>
          (JSON.parse(frame.data ?? '') as {progress: {kind: string}}).progress
            .kind,
      )
      .filter(kind => kind !== 'reply_delta'),
  ).toEqual([
    'user_message',
    'visible_reply',
    'tool_calls_requested',
    'tool_call_completed',
    'visible_reply',
  ]);
  expect(
    sessionLog(home, 'mira', `${conversationId}.1`)
      .filter(record =>
        ['visible_message_committed', 'tool_call_started'].includes(
          String(record['kind']),
        ),
      )
      .map(record => record['visibleMessageIds'] ?? record['kind']),
  ).toEqual([
    [`${conversationId}.1:message-1`],
    [`${conversationId}.1:message-2`],
    'tool_call_started',
    [`${conversationId}.1:message-3`],
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

it('turns.fatal-turn-restart: a turn whose reply the store cannot append fails on its answer with its line committed, the character restarts once, and the next turn completes', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const daemon = await startDaemon(home);
  const say = await converse(wireOf(daemon), 'mira');
  const events = await openEvents(daemon);
  const sessions = join(home, 'character-data', 'mira', 'sessions');
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

  for (const state of ['failed', 'starting', 'ready']) {
    await events.next(frameOf('state_changed', {characterId: 'mira', state}));
  }

  model.answer(reply('Back again.'));
  expect(await say('Next.', 'next')).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'Back again.'}],
  });
  expect(
    events.frames
      .filter(frameOf('state_changed', {characterId: 'mira'}))
      .map(frame => (JSON.parse(frame.data ?? '') as {state: string}).state),
  ).toEqual(['failed', 'starting', 'ready']);
});

it('turns.recovery-after-fatal-turn: after a turn whose line could not be appended, failed and uncommitted on its answer and the stream, the character recovers by itself; the next turn needs no reopen, and an open sent right after succeeds with the same id', async () => {
  const home = createHome();
  const daemon = await startDaemon(home, fixedReplies);
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const events = await openEvents(daemon);
  const sessions = join(home, 'character-data', 'mira', 'sessions');
  const failOnce = async (id: string): Promise<void> => {
    chmod(sessions, 0o000);

    try {
      expect(await say('Lost?', id)).toMatchObject({
        status: 'failed',
        committed: false,
      });
    } finally {
      chmod(sessions, 0o755);
    }
  };

  await failOnce('lost');
  await events.next(
    frameOf('turn_completed', {
      clientMessageId: 'lost',
      status: 'failed',
      committed: false,
    }),
  );
  expect(await say('Still there?', 'after')).toMatchObject({
    status: 'completed',
    conversationId,
  });
  await failOnce('lost-again');
  await expect(wire.open('mira')).resolves.toMatchObject({
    status: 'opened',
    conversationId,
  });
});

it('turns.storage-failure-outcome: an open answers failed read_failed while the conversations directory is unreadable and write_failed while it cannot be written, and opens once it can', async () => {
  const home = createHome({conversations: {}});
  const wire = wireOf(await startDaemon(home, fixedReplies));
  const conversations = join(home, 'conversations');

  await wire.start('mira');

  try {
    chmod(conversations, 0o000);
    await expect(wire.open('mira')).resolves.toMatchObject({
      status: 'failed',
      code: 'read_failed',
    });
    chmod(conversations, 0o555);
    await expect(wire.open('mira')).resolves.toMatchObject({
      status: 'failed',
      code: 'write_failed',
    });
  } finally {
    chmod(conversations, 0o755);
  }

  await expect(wire.open('mira')).resolves.toMatchObject({status: 'opened'});
});

it('turns.route-unopened-conversation: after a restart a turn on a conversation the earlier run opened is routed by its record, refused character_unavailable until the character runs, then completed there, and history spans both runs', async () => {
  const home = createHome();
  const earlier = await startDaemon(home, fixedReplies);
  const earlierWire = wireOf(earlier);
  const say = await converse(earlierWire, 'mira');
  const {conversationId, userParticipantId} = await conversationOf(
    earlierWire,
    'mira',
  );

  await say('Before the restart.', 'before');
  await stop(earlier);
  writeFileSync(
    join(home, 'config.json'),
    configJson({project02: {enabled: false}}),
  );

  const wire = wireOf(await startDaemon(home, fixedReplies));
  const line = {
    conversationId,
    senderId: userParticipantId,
    text: 'After the restart.',
    source: 'web',
    clientMessageId: 'after',
  };

  await expect(wire.turn(line)).resolves.toMatchObject({
    status: 'refused',
    reason: 'character_unavailable',
  });
  writeFileSync(join(home, 'config.json'), configJson({}));
  await wire.start('mira');
  await expect(wire.turn(line)).resolves.toMatchObject({
    status: 'completed',
    conversationId,
  });
  await expect(wire.history(conversationId)).resolves.toMatchObject({
    messages: [
      {text: 'Before the restart.'},
      {},
      {text: 'After the restart.'},
      {},
    ],
  });
});

it('turns.conversation-unreadable: a turn on a conversation whose record cannot be read is refused conversation_unreadable, naming the conversation', async () => {
  const home = createHome();
  const earlier = await startDaemon(home, fixedReplies);
  const earlierWire = wireOf(earlier);

  await earlierWire.start('mira');

  const {conversationId, userParticipantId} = await conversationOf(
    earlierWire,
    'mira',
  );

  await stop(earlier);
  writeFileSync(
    join(home, 'conversations', conversationId, 'conversation.json'),
    '{"id": "torn',
  );

  const wire = wireOf(await startDaemon(home, fixedReplies));

  await wire.start('mira');
  await expect(
    wire.turn({
      conversationId,
      senderId: userParticipantId,
      text: 'Still there?',
      source: 'web',
      clientMessageId: 'still',
    }),
  ).resolves.toMatchObject({
    status: 'refused',
    reason: 'conversation_unreadable',
    message: expect.stringContaining(conversationId) as string,
  });
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

it('turns.history-invalid-page: history refuses an unknown or malformed conversation id unknown_conversation, and a limit outside 1..500 or a cursor it never issued invalid_page', async () => {
  const wire = wireOf(await startDaemon(createHome(), fixedReplies));
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');

  await say('Hello.', 'hello');

  for (const id of ['conv_missing', 'not.an.id']) {
    await expect(wire.history(id), id).resolves.toMatchObject({
      status: 'refused',
      reason: 'unknown_conversation',
    });
  }

  for (const page of [
    {limit: 0},
    {limit: 501},
    {before: 'nonsense'},
    {before: 'v1:9:0'},
  ]) {
    await expect(
      wire.history(conversationId, page),
      JSON.stringify(page),
    ).resolves.toMatchObject({status: 'refused', reason: 'invalid_page'});
  }
});

it("turns.history-stopped-character: history reads the thread of a stopped character, and fails missing_file once the character's data directory is gone", async () => {
  const home = createHome();
  const daemon = await startDaemon(home, fixedReplies);
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');

  await say('Hello.', 'hello');

  const events = await openEvents(daemon);
  const {fingerprint} = (await wire.configView({scope: 'global'})) as {
    readonly fingerprint: string;
  };

  await wire.configChange({
    target: {scope: 'global'},
    expectedFingerprint: fingerprint,
    operation: {kind: 'set', path: 'project02.enabled', value: false},
  });
  await events.next(
    frameOf('state_changed', {characterId: 'mira', state: 'stopped'}),
  );
  await expect(wire.history(conversationId)).resolves.toMatchObject({
    status: 'ok',
    messages: [{text: 'Hello.'}, {}],
  });
  rmSync(join(home, 'character-data', 'mira'), {recursive: true});
  await expect(wire.history(conversationId)).resolves.toMatchObject({
    status: 'failed',
    code: 'missing_file',
  });
});

it("turns.speaker-name-persisted: committed messages keep the speaker id and name of the session's character, a reopened session goes on under them, and a name edited on disk fails the open malformed_record", async () => {
  const home = createHome();
  const earlier = await startDaemon(home, fixedReplies);
  const earlierWire = wireOf(earlier);
  const say = await converse(earlierWire, 'mira');
  const {conversationId, userParticipantId} = await conversationOf(
    earlierWire,
    'mira',
  );

  await say('Hello.', 'hello');

  const transcript = join(
    segmentDirectory(home, conversationId),
    'raw-events.jsonl',
  );
  const committed = readFileSync(transcript, 'utf8');
  const records = sessionLog(home, 'mira', `${conversationId}.1`);
  const messageOf = (record: Record<string, unknown>) =>
    record['visibleMessage'] as {readonly speakerId: string} | undefined;

  expect(records.map(messageOf).filter(Boolean)).toMatchObject([
    {speakerId: 'local-user', speakerName: 'You'},
    {speakerId: 'mira', speakerName: 'Mira'},
  ]);
  await stop(earlier);
  writeFileSync(
    transcript,
    `${records
      .map(record => {
        const message = messageOf(record);

        return JSON.stringify(
          message?.speakerId === 'mira'
            ? {...record, visibleMessage: {...message, speakerName: 'Not Mira'}}
            : record,
        );
      })
      .join('\n')}\n`,
  );

  const wire = wireOf(await startDaemon(home, fixedReplies));

  await wire.start('mira');
  await expect(wire.open('mira')).resolves.toMatchObject({
    status: 'failed',
    code: 'malformed_record',
  });
  writeFileSync(transcript, committed);
  await expect(wire.open('mira')).resolves.toMatchObject({
    status: 'opened',
    conversationId,
  });
  await expect(
    wire.turn({
      conversationId,
      senderId: userParticipantId,
      text: 'Hello again.',
      source: 'web',
      clientMessageId: 'again',
    }),
  ).resolves.toMatchObject({
    messages: [
      {speakerId: 'local-user', speakerName: 'You'},
      {speakerId: 'mira', speakerName: 'Mira'},
    ],
  });
});

it('turns.user-name-per-session: a thread keeps the names it began with, even in its next segment, when the user is renamed in config and the character in its package; a thread begun after takes the new names', async () => {
  const packageOf = (id: string) =>
    join('characters', id, 'project02.character.json');
  const zeta = packageOf('zeta');
  const home = createHome({
    'config.json': configJson({
      project02: {userDisplayName: 'Mike', contextWindowTokens: 1},
    }),
    characters: {
      zeta: {'project02.character.json': characterJson('zeta', 'Zeta')},
      nova: {'project02.character.json': characterJson('nova', 'Nova')},
    },
  });
  const earlier = await startDaemon(home, fixedReplies);
  const earlierWire = wireOf(earlier);
  const sayEarlier = await converse(earlierWire, 'zeta');
  const {conversationId} = await conversationOf(earlierWire, 'zeta');

  await sayEarlier('First.', 'first');
  await stop(earlier);
  writeFileSync(
    join(home, 'config.json'),
    configJson({
      project02: {userDisplayName: 'Michael', contextWindowTokens: 1},
    }),
  );
  writeFileSync(join(home, zeta), characterJson('zeta', 'Zed'));
  // Renamed before her first thread: it begins under the new name.
  writeFileSync(join(home, packageOf('nova')), characterJson('nova', 'Nora'));

  const wire = wireOf(await startDaemon(home, fixedReplies));
  const named = (user: string, character: string) => [
    {speakerName: user},
    {speakerName: character},
  ];

  const sayToZeta = await converse(wire, 'zeta');
  const sayToMira = await converse(wire, 'mira');

  expect(await sayToZeta('Second.', 'second')).toMatchObject({
    messages: [
      {messageId: `${conversationId}.2:message-1`, speakerName: 'Mike'},
      {speakerName: 'Zeta'},
    ],
  });
  await expect(wire.history(conversationId)).resolves.toMatchObject({
    messages: [...named('Mike', 'Zeta'), ...named('Mike', 'Zeta')],
  });
  expect(await sayToMira('Hello, Mira.', 'mira')).toMatchObject({
    messages: named('Michael', 'Mira'),
  });

  const sayToNova = await converse(wire, 'nova');

  expect(await sayToNova('Hello, Nova.', 'nova')).toMatchObject({
    messages: named('Michael', 'Nora'),
  });
});

it('turns.history-default-limit: a history read without a limit answers the newest 100 messages, and a limit of up to 500 answers more', async () => {
  const model = await startModelServer();
  const wire = wireOf(
    await startDaemon(
      createHome({'config.json': configJson({project02: model.settings})}),
    ),
  );
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const replies = Array.from(
    {length: 101},
    (_, at) => `Reply ${String(at + 1)}.`,
  );

  // One round of 101 replies: with the line, 102 messages.
  model.answer({
    chunks: [
      ...replies.flatMap((text, index) =>
        toolCall({
          index,
          id: `call_${String(index)}`,
          name: 'visible_reply',
          arguments: JSON.stringify({text}),
        }),
      ),
      finish('tool_calls'),
    ],
  });
  await say('Count to 101.', 'count');

  const texts = async (page: {readonly limit?: number}) =>
    (
      (await wire.history(conversationId, page)) as {
        readonly messages: readonly {readonly text: string}[];
      }
    ).messages.map(message => message.text);

  expect(await texts({})).toEqual(replies.slice(1));
  expect(await texts({limit: 500})).toEqual(['Count to 101.', ...replies]);
  expect(await texts({limit: 1})).toEqual(['Reply 101.']);
});
