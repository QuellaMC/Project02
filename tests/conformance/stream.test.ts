import {join} from 'node:path';

import {expect, it} from 'vitest';

import {startDaemon} from './harness/daemon.ts';
import {type Frame, frameOf, openEvents} from './harness/events.ts';
import {chmod, configJson, createHome} from './harness/home.ts';
import {
  calling,
  finish,
  reply,
  startModelServer,
  toolCall,
  undecided,
  visibleReply,
  type Answer,
} from './harness/model-server.ts';
import {bearer, exchange} from './harness/http.ts';
import {
  conversationOf,
  converse,
  saveConfig,
  sender,
  wireOf,
} from './harness/wire.ts';

const fixedReplies = {PROJECT02_TEST_PROVIDER: 'deterministic'};
const mira = {scope: 'character', characterId: 'mira'} as const;
/** When a message was sent, by its shape. */
const sentAt = expect.stringMatching(
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u,
) as string;

function dataOf(frame: Frame | undefined): unknown {
  return JSON.parse(frame?.data ?? 'null');
}

it('stream.ready-snapshot: a stream without a Last-Event-ID opens with ready, the daemon snapshot of health, waiting confirmations and pairings and running turns', async () => {
  const daemon = await startDaemon(createHome(), fixedReplies);
  const wire = wireOf(daemon);

  await wire.start('mira');
  await wire.pairingRequest('telegram', {
    subject: {id: 'friend', label: 'A friend'},
    source: 'telegram:mira_bot',
  });

  const events = await openEvents(daemon);

  expect(dataOf(await events.next(() => true))).toEqual({
    protocolVersion: 18,
    health: await wire.health(),
    confirmations: await wire.pending(),
    pairings: await wire.pendingPairings(),
    turns: [],
  });
  expect(events.frames[0]?.event).toBe('ready');
});

it('stream.resume-last-event-id: a stream that returns with a Last-Event-ID the tail holds is resumed with exactly the frames after it, byte for byte, then the live ones under the same numbers, and with none after the newest', async () => {
  const daemon = await startDaemon(createHome(), fixedReplies);
  const say = await converse(wireOf(daemon), 'mira');
  const stream = (lastEventId?: string) =>
    exchange(daemon, {
      path: '/api/events',
      headers: {
        ...bearer(daemon),
        ...(lastEventId === undefined ? {} : {'last-event-id': lastEventId}),
      },
    });
  /** The whole frames of a stream's text so far, each with its blank line. */
  const framesOf = (text: string) =>
    text
      .slice(0, text.lastIndexOf('\n\n') + 2)
      .split(/(?<=\n\n)/u)
      .filter(frame => frame !== '');
  const idOf = (frame: string) => /^id: (.*)$/mu.exec(frame)?.[1];
  const first = await stream();

  await say('One.', 'one');
  await say('Two.', 'two');
  // The frames of the first turn are whole once the second turn's end came.
  await first.received('"clientMessageId":"two"');

  const frames = framesOf(first.body());
  const cursor = frames.findIndex(frame =>
    frame.includes('"clientMessageId":"one"'),
  );
  const resumed = 'event: resumed\ndata: {}\n\n';
  const back = await stream(idOf(frames[cursor] ?? ''));

  await back.received(frames.at(-1) ?? '');
  expect(
    back
      .body()
      .slice(0, resumed.length + frames.slice(cursor + 1).join('').length),
  ).toBe(resumed + frames.slice(cursor + 1).join(''));

  const newest = await stream(idOf(frames.at(-1) ?? ''));

  await say('Three.', 'three');
  await first.received('"clientMessageId":"three","status":"completed"');

  // The turn's frames as the first stream has them, once the resumed one
  // has caught up with the last of them.
  const live = framesOf(first.body()).slice(frames.length);

  await newest.received(live.at(-1) ?? '');
  expect(newest.body().startsWith(resumed)).toBe(true);
  expect(framesOf(newest.body().slice(resumed.length)).map(idOf)).toEqual(
    live.map(idOf),
  );
});

it('stream.running-turns: a stream opened while she writes finds her turn in ready, writing, and one opened after the turn ends none', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
  );
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const held = model.hold();
  const turn = say('Hello?', 'running');

  await held.arrived();
  expect(
    dataOf(await (await openEvents(daemon)).next(frameOf('ready'))),
  ).toMatchObject({
    turns: [
      {
        conversationId,
        source: 'web',
        clientMessageId: 'running',
        characterId: 'mira',
        writing: true,
      },
    ],
  });
  held.release(reply('Hello there, friend.'));
  await expect(turn).resolves.toMatchObject({status: 'completed'});
  expect(
    dataOf(await (await openEvents(daemon)).next(frameOf('ready'))),
  ).toMatchObject({turns: []});
});

it("stream.sync-rule: the person's line rides the stream as user_message, stamped, with when it was sent, when she read it and the app it came in, once it is on disk, where the history holds it read at that very moment, and the reply follows", async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);

  await wire.start('mira');

  const send = await sender(wire);
  const {conversationId} = await conversationOf(wire, 'mira');
  const events = await openEvents(daemon);

  model.hold();

  // Answered by the kill, so its handler is on from the start.
  const turn = send({
    conversationId,
    text: 'Hello there.',
    source: 'telegram:mira_bot',
    clientMessageId: 'sync',
  }).then(
    () => 'answered',
    () => 'cut off',
  );
  const line = dataOf(
    await events.next(
      frameOf('turn_progress', {progress: {kind: 'user_message'}}),
    ),
  ) as {
    readonly progress: {readonly messageId: string; readonly readAt: string};
  };

  expect(line).toEqual({
    kind: 'turn_progress',
    characterId: 'mira',
    conversationId,
    progress: {
      kind: 'user_message',
      messageId: expect.any(String) as string,
      speakerId: 'local-user',
      speakerName: 'You',
      text: 'Hello there.',
      sentAt,
      readAt: expect.any(String) as string,
      app: 'telegram',
      source: 'telegram:mira_bot',
      clientMessageId: 'sync',
    },
  });
  // The model still holds the turn, and the history already holds the
  // line, read when the stream said.
  await expect(wire.history(conversationId)).resolves.toMatchObject({
    messages: [
      {
        messageId: line.progress.messageId,
        text: 'Hello there.',
        readAt: line.progress.readAt,
      },
    ],
  });
  // And on disk: killed now, with the model still holding the turn, the
  // daemon leaves the line for the next run to read back.
  daemon.signal('SIGKILL');
  await daemon.exit();
  expect(await turn).toBe('cut off');

  const again = wireOf(await startDaemon(home));

  await converse(again, 'mira');
  await expect(again.history(conversationId)).resolves.toMatchObject({
    messages: [{messageId: line.progress.messageId, text: 'Hello there.'}],
  });
});

it("stream.writing: a line's turn reaches the stream as its line, sent in Messages, then the turn running, not writing; each round of hers says she writes as its request goes out, then each message it said, whole as it is committed, with when it was sent, then that she no longer writes, before the calls it made run; then turn_completed", async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
  );
  const say = await converse(wireOf(daemon), 'mira');
  const events = await openEvents(daemon);
  const replyCall = (index: number, text: string) =>
    toolCall({
      index,
      id: `call_${String(index)}`,
      name: 'send_message',
      arguments: JSON.stringify({text}),
    });

  model.answer(
    {
      chunks: [
        ...replyCall(0, 'First, this.'),
        ...replyCall(1, 'Then that.'),
        finish('tool_calls'),
      ],
    },
    calling(['character_state_patch', {mood: 'curious'}]),
    reply('Noted.'),
  );
  await say('Two things?', 'two');
  await say('Note my mood?', 'mood');
  await events.next(frameOf('turn_completed', {clientMessageId: 'mood'}));
  expect(
    events.frames
      .filter(frame => frame.event?.startsWith('turn_') === true)
      .map(frame => {
        const {kind, progress, writing} = dataOf(frame) as {
          readonly kind: string;
          readonly progress?: object;
          readonly writing?: boolean;
        };

        return progress ?? (writing === undefined ? {kind} : {kind, writing});
      }),
  ).toMatchObject([
    {kind: 'user_message', text: 'Two things?', sentAt, app: 'messages'},
    {kind: 'turn_running', writing: false},
    {kind: 'turn_running', writing: true},
    {kind: 'visible_reply', text: 'First, this.', sentAt},
    {kind: 'visible_reply', text: 'Then that.', sentAt},
    {kind: 'turn_running', writing: false},
    {kind: 'turn_completed'},
    {kind: 'user_message', text: 'Note my mood?'},
    {kind: 'turn_running', writing: false},
    {kind: 'turn_running', writing: true},
    {kind: 'turn_running', writing: false},
    {kind: 'tool_calls_requested', toolNames: ['character_state.patch']},
    {
      kind: 'tool_call_completed',
      status: 'accepted',
      toolName: 'character_state.patch',
    },
    {kind: 'turn_running', writing: true},
    {kind: 'visible_reply', text: 'Noted.', sentAt},
    {kind: 'turn_running', writing: false},
    {kind: 'turn_completed'},
  ]);
});

it('stream.refused-round-unsaid: what she says in a round whose answer is refused, or that the budget refuses, is never on the stream: each round says only that she writes, then that she no longer does, and the next begins afresh', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
  );
  const say = await converse(wireOf(daemon), 'mira');
  const events = await openEvents(daemon);
  const search = (argumentsText: string) =>
    toolCall({
      index: 1,
      id: 'call_search',
      name: 'sessions_search',
      arguments: argumentsText,
    });
  // A reply beside a search whose arguments are no JSON object: refused.
  const refused = (text: string): Answer => ({
    chunks: [...visibleReply(text), ...search('tea'), finish('tool_calls')],
  });

  model.answer(
    refused('Let me look.'),
    {
      chunks: [
        ...visibleReply('Let me look again.'),
        ...toolCall({
          index: 2,
          id: 'call_second_reply',
          name: 'send_message',
          arguments: JSON.stringify({text: 'And again.'}),
        }),
        ...search('tea'),
        finish('tool_calls'),
      ],
    },
    // Rounds 3 to 99 decide nothing.
    ...undecided(97),
    // A sound round past the budget: refused, its search never run.
    {
      chunks: [
        ...visibleReply('One last look.'),
        ...search(JSON.stringify({query: 'tea'})),
        finish('tool_calls'),
      ],
    },
  );
  expect(await say('Did we talk about tea?', 'tea')).toMatchObject({
    status: 'rejected',
    reason: 'tool_rounds_exhausted',
  });
  await events.next(frameOf('turn_completed', {clientMessageId: 'tea'}));

  // Whether she writes, each time the turn changed: its line, then each of
  // its hundred rounds.
  const writing = events.frames
    .filter(frameOf('turn_running'))
    .map(frame => (dataOf(frame) as {readonly writing: boolean}).writing);

  expect(writing).toEqual([
    false,
    ...Array.from({length: 100}, () => [true, false]).flat(),
  ]);
  expect(
    events.frames.filter(
      frameOf('turn_progress', {progress: {kind: 'visible_reply'}}),
    ),
  ).toEqual([]);
  expect(JSON.stringify(events.frames)).not.toMatch(/look|again/u);
});

it('stream.maintenance-failed: a segment rotation that fails behind a completed turn leaves the turn completed and the character ready, is told on the stream as maintenance_failed and in her health entry, and switching her off and on clears it', async () => {
  const home = createHome({
    'config.json': configJson({project02: {contextWindowTokens: 1}}),
  });
  const daemon = await startDaemon(home, fixedReplies);
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const data = join(home, 'character-data', 'mira');
  const summary = async () =>
    (
      (await wire.health()) as {
        readonly characters: readonly Record<string, unknown>[];
      }
    ).characters[0];

  // The first rotation makes all the next one needs but a new catalog,
  // which her data directory, taking no new file, then refuses.
  await say('One.', 'one');

  const events = await openEvents(daemon);
  let failure: unknown;

  chmod(data, 0o555);

  try {
    expect(await say('Two.', 'two')).toMatchObject({status: 'completed'});
    failure = dataOf(
      await events.next(frameOf('maintenance_failed', {characterId: 'mira'})),
    );
  } finally {
    chmod(data, 0o755);
  }

  const {at, message} = failure as {
    readonly at: string;
    readonly message: string;
  };

  expect(message).toContain('sessions.jsonl');
  expect(await summary()).toMatchObject({
    state: 'ready',
    maintenance: {at, message},
  });
  await saveConfig(wire, mira, {
    kind: 'set',
    path: 'project02.enabled',
    value: false,
  });
  await events.next(
    frameOf('state_changed', {characterId: 'mira', state: 'stopped'}),
  );
  await saveConfig(wire, mira, {kind: 'unset', path: 'project02.enabled'});
  await events.next(
    frameOf('state_changed', {characterId: 'mira', state: 'ready'}),
  );
  expect(await summary()).not.toHaveProperty('maintenance');
});
