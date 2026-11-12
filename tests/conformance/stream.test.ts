import {join} from 'node:path';

import {expect, it} from 'vitest';

import {startDaemon} from './harness/daemon.ts';
import {type Frame, frameOf, openEvents} from './harness/events.ts';
import {chmod, configJson, createHome} from './harness/home.ts';
import {
  finish,
  startModelServer,
  toolCall,
  undecided,
  visibleReply,
  type Answer,
} from './harness/model-server.ts';
import {bearer, exchange} from './harness/http.ts';
import {conversationOf, converse, saveConfig, wireOf} from './harness/wire.ts';

const fixedReplies = {PROJECT02_TEST_PROVIDER: 'deterministic'};
const mira = {scope: 'character', characterId: 'mira'} as const;

function dataOf(frame: Frame | undefined): unknown {
  return JSON.parse(frame?.data ?? 'null');
}

/** A visible_reply of this many characters, its arguments streamed in 64 KiB pieces. */
function longReply(characters: number): unknown[] {
  const piece = 64 * 1024;

  return visibleReply(
    'x'.repeat(characters),
    ...Array.from(
      {length: Math.floor(characters / piece)},
      (_, at) => (at + 1) * piece,
    ),
  );
}

/**
 * Several times more draft than the daemon's bounded send buffer, its
 * response's own buffer and a client's receive buffer hold together, which
 * the model then breaks off: frames enough to stall a client that stops
 * reading, of which the daemon keeps nothing.
 */
function overflowingDraft(): Answer {
  return {chunks: longReply(2 * 1024 * 1024), end: 'cut'};
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
    protocolVersion: 13,
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

it('stream.slow-client-drop: a client that stops taking frames is dropped within the grace and its stream closed', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
    {PROJECT02_TEST_DURATIONS: 'grace=1000'},
  );
  const say = await converse(wireOf(daemon), 'mira');
  const watching = await openEvents(daemon);
  const telegram = (connected: boolean) =>
    frameOf('health_changed', {
      health: {connectors: [{id: 'telegram', connected}]},
    });
  // A connector's stream: the presence it holds shows when the daemon
  // lets the stream go.
  const stalled = await exchange(daemon, {
    path: '/api/events?connector=telegram',
    headers: bearer(daemon),
  });

  await stalled.received('event: ready');
  stalled.pause();
  await watching.next(telegram(true));

  const submitted = performance.now();

  model.answer(overflowingDraft());
  await say('Talk a lot.', 'long');

  const answered = performance.now();

  await watching.next(telegram(false));

  const dropped = performance.now();

  // The grace of one second runs from the stall, which the burst brings on
  // at once, then the drop; a machine slow to turn the draft into frames
  // stalls the client later, and at the latest a grace after the turn ends.
  expect(dropped - submitted).toBeGreaterThanOrEqual(900);
  expect(dropped - answered).toBeLessThan(5_000);
  stalled.resume();
  await stalled.ended();
  expect(stalled.body()).not.toContain('event: turn_completed');
});

it('stream.running-turns: a stream opened mid-reply finds the running turn in ready with its draft so far, a later one a longer draft, and one opened after the turn ends none', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
  );
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const watching = await openEvents(daemon);
  const driven = model.stream();
  const turn = say('Hello?', 'running');
  // The arguments cut after "Hello" and after "there,".
  const [head, middle, tail] = visibleReply('Hello there, friend.', 14, 21);
  const running = (text: string) => ({
    turns: [
      {
        conversationId,
        source: 'web',
        clientMessageId: 'running',
        characterId: 'mira',
        drafts: [{draftId: '1.0', text}],
      },
    ],
  });
  const drafted = (text: string) =>
    watching.next(frameOf('turn_running', {drafts: [{text}]}));

  await driven.arrived();
  driven.write([head]);
  await drafted('Hello');
  expect(
    dataOf(await (await openEvents(daemon)).next(frameOf('ready'))),
  ).toMatchObject(running('Hello'));
  driven.write([middle]);
  await drafted('Hello there,');
  expect(
    dataOf(await (await openEvents(daemon)).next(frameOf('ready'))),
  ).toMatchObject(running('Hello there,'));
  driven.write([tail, finish('tool_calls')]);
  driven.end();
  await expect(turn).resolves.toMatchObject({status: 'completed'});
  expect(
    dataOf(await (await openEvents(daemon)).next(frameOf('ready'))),
  ).toMatchObject({turns: []});
});

it("stream.sync-rule: the person's line rides the stream as user_message, stamped, once it is on disk, and the reply follows", async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const events = await openEvents(daemon);

  model.hold();

  // Answered by the kill, so its handler is on from the start.
  const turn = say('Hello there.', 'sync').then(
    () => 'answered',
    () => 'cut off',
  );
  const line = dataOf(
    await events.next(
      frameOf('turn_progress', {progress: {kind: 'user_message'}}),
    ),
  ) as {readonly progress: {readonly messageId: string}};

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
      source: 'web',
      clientMessageId: 'sync',
    },
  });
  // The model still holds the turn, and the history already holds the line.
  await expect(wire.history(conversationId)).resolves.toMatchObject({
    messages: [{messageId: line.progress.messageId, text: 'Hello there.'}],
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

it('stream.drafts: a turn reaches the stream as its line, then the turn running with each of its replies drafted in order under a draft id of its own, whole each time it grows, then each commit naming the draft it replaces and the turn without that draft, then turn_completed', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
  );
  const say = await converse(wireOf(daemon), 'mira');
  const events = await openEvents(daemon);
  const replyCall = (index: number, text: string, cut: number) =>
    toolCall(
      {
        index,
        id: `call_${String(index)}`,
        name: 'visible_reply',
        arguments: JSON.stringify({text}),
      },
      cut,
    );
  const first = {draftId: '1.0', text: 'First, this.'};
  const then = {draftId: '1.1', text: 'Then that.'};

  model.answer({
    chunks: [
      // Each cut falls after the reply's first word.
      ...replyCall(0, 'First, this.', 14),
      ...replyCall(1, 'Then that.', 13),
      finish('tool_calls'),
    ],
  });
  await say('Two things?', 'two');
  await events.next(frameOf('turn_completed', {clientMessageId: 'two'}));
  expect(
    events.frames
      .filter(frame => frame.event?.startsWith('turn_') === true)
      .map(frame => {
        const {kind, progress, drafts} = dataOf(frame) as {
          readonly kind: string;
          readonly progress?: object;
          readonly drafts?: unknown;
        };

        return progress ?? (drafts === undefined ? {kind} : {kind, drafts});
      }),
  ).toMatchObject([
    {kind: 'user_message', text: 'Two things?'},
    {kind: 'turn_running', drafts: []},
    {kind: 'turn_running', drafts: [{draftId: '1.0', text: 'First'}]},
    {kind: 'turn_running', drafts: [first]},
    {kind: 'turn_running', drafts: [first, {draftId: '1.1', text: 'Then'}]},
    {kind: 'turn_running', drafts: [first, then]},
    {kind: 'visible_reply', ...first},
    {kind: 'turn_running', drafts: [then]},
    {kind: 'visible_reply', ...then},
    {kind: 'turn_running', drafts: []},
    {kind: 'turn_completed'},
  ]);
});

it('stream.drafts-withdrawn: the drafts of a round whose answer is refused, or that the budget refuses, are withdrawn before the round moves on, and the next round drafts afresh', async () => {
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
          name: 'visible_reply',
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

  // Each state of the turn as it ran, its drafts as `<draftId> <text>`.
  const states = events.frames.filter(frameOf('turn_running')).map(frame =>
    (
      dataOf(frame) as {
        readonly drafts: readonly {
          readonly draftId: string;
          readonly text: string;
        }[];
      }
    ).drafts.map(({draftId, text}) => `${draftId} ${text}`),
  );

  expect(states.slice(0, 5)).toEqual([
    [],
    ['1.0 Let me look.'],
    [],
    ['2.0 Let me look again.'],
    ['2.0 Let me look again.', '2.1 And again.'],
  ]);
  // Both drafts of the second round go, in whichever order, before
  // anything of a later round.
  expect([['2.0 Let me look again.'], ['2.1 And again.']]).toContainEqual(
    states[5],
  );
  expect(states.slice(6)).toEqual([[], ['100.0 One last look.'], []]);
  expect(
    events.frames.filter(
      frameOf('turn_progress', {progress: {kind: 'visible_reply'}}),
    ),
  ).toEqual([]);
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
