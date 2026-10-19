import {expect, it} from 'vitest';

import {startDaemon} from './harness/daemon.ts';
import {type Frame, frameOf, framesOf, openEvents} from './harness/events.ts';
import {configJson, createHome} from './harness/home.ts';
import {
  finish,
  reply,
  startModelServer,
  toolCall,
  undecided,
  visibleReply,
  type Answer,
} from './harness/model-server.ts';
import {bearer, exchange} from './harness/http.ts';
import {conversationOf, converse, wireOf} from './harness/wire.ts';

const fixedReplies = {PROJECT02_TEST_PROVIDER: 'deterministic'};

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
 * More draft than the sockets' buffers between the daemon and a client
 * hold, which the model then breaks off: frames enough to stall a client
 * that stops reading, of which the daemon keeps nothing.
 */
function overflowingDraft(): Answer {
  return {chunks: longReply(8 * 1024 * 1024), end: 'cut'};
}

it('stream.ready-snapshot: a stream without a Last-Event-ID opens with ready, the daemon snapshot of health, waiting confirmations and pairings and running turns, as text/event-stream that is never cached', async () => {
  const daemon = await startDaemon(createHome(), fixedReplies);
  const wire = wireOf(daemon);

  await wire.start('mira');
  await wire.pairingRequest('telegram', {id: 'friend', label: 'A friend'});

  const stream = await exchange(daemon, {
    path: '/api/events',
    headers: bearer(daemon),
  });

  expect(stream.headers).toMatchObject({
    'content-type': expect.stringMatching(/^text\/event-stream/u) as string,
    'cache-control': 'no-store',
  });

  const events = await openEvents(daemon);

  expect(dataOf(await events.next(() => true))).toEqual({
    protocolVersion: 7,
    health: await wire.health(),
    confirmations: await wire.pending(),
    pairings: await wire.pendingPairings(),
    turns: [],
  });
  expect(events.frames[0]?.event).toBe('ready');
});

it('stream.frame-ids: frames are numbered <run>-<seq> from one under a 16-hex run id, ready carries the number it goes on from, and each frame is one data line of JSON', async () => {
  // No character starts, so nothing happens before the first stream.
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: {enabled: false}})}),
  );
  const wire = wireOf(daemon);
  const first = await openEvents(daemon);
  const {id = ''} = await first.next(frameOf('ready'));
  const run = id.slice(0, 16);

  expect(id).toMatch(/^[0-9a-f]{16}-0$/u);
  await wire.pairingRequest('telegram', {id: 'one', label: 'One'});
  await wire.pairingRequest('telegram', {id: 'two', label: 'Two'});
  await first.next(frameOf('pairing_requested', {subject: {id: 'two'}}));

  const second = await openEvents(daemon);

  await second.next(frameOf('ready'));
  expect(first.frames.map(frame => frame.id)).toEqual(
    [0, 1, 2].map(seq => `${run}-${String(seq)}`),
  );
  expect(second.frames.map(frame => frame.id)).toEqual([`${run}-2`]);

  for (const frame of [...first.frames, ...second.frames]) {
    // The client joins a frame's data lines with a line feed.
    expect(frame.data).not.toContain('\n');
    expect(dataOf(frame)).toBeTypeOf('object');
  }
});

it('stream.ping: an idle stream carries a ": ping" comment each heartbeat', async () => {
  const events = await openEvents(
    await startDaemon(createHome(), {
      PROJECT02_TEST_DURATIONS: 'heartbeat=100',
    }),
  );
  const ping = (frame: Frame): boolean => frame.comment === 'ping';

  expect(await events.next(ping)).toEqual({comment: 'ping'});

  const first = performance.now();

  expect(await events.next(ping)).toEqual({comment: 'ping'});

  const interval = performance.now() - first;

  // One heartbeat apart: neither a steady stream of them nor one in a while.
  expect(interval).toBeGreaterThanOrEqual(90);
  expect(interval).toBeLessThan(2_000);
});

it("stream.turn-frames-order: a turn reaches the stream as its line's user_message, its reply's deltas in order, the visible_reply they join to, then turn_completed", async () => {
  const daemon = await startDaemon(createHome(), fixedReplies);
  const say = await converse(wireOf(daemon), 'mira');
  const events = await openEvents(daemon);

  await say('Hello there.', 'order');
  await events.next(frameOf('turn_completed', {clientMessageId: 'order'}));

  const progress = events.frames.slice(1).map(
    frame =>
      dataOf(frame) as {
        readonly kind: string;
        readonly progress?: {readonly kind: string; readonly text?: string};
      },
  );
  const text = (kind: string) =>
    progress
      .filter(event => event.progress?.kind === kind)
      .map(event => event.progress?.text)
      .join('');

  expect(
    progress.map(event => event.progress?.kind ?? event.kind).join(' '),
  ).toMatch(/^user_message( reply_delta){2,} visible_reply turn_completed$/u);
  expect(text('reply_delta')).toBe(text('visible_reply'));
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
  await first.received('"clientMessageId":"three"');
  await newest.received('"clientMessageId":"three"');
  expect(newest.body().startsWith(resumed)).toBe(true);
  expect(framesOf(newest.body().slice(resumed.length)).map(idOf)).toEqual(
    framesOf(first.body()).slice(frames.length).map(idOf),
  );
});

it('stream.tail-bound: a Last-Event-ID more than the 1 MiB tail behind, past the newest, from another run or malformed opens with ready, while one about 600 KiB behind is still resumed', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
  );
  const say = await converse(wireOf(daemon), 'mira');
  const watching = await openEvents(daemon);
  const before = (await watching.next(frameOf('ready'))).id ?? '';
  const opensWith = async (lastEventId: string): Promise<string | undefined> =>
    (await (await openEvents(daemon, lastEventId)).next(() => true)).event;

  model.answer({chunks: [...longReply(600 * 1024), finish('tool_calls')]});
  await say('Tell me everything.', 'long');
  await watching.next(frameOf('turn_completed', {clientMessageId: 'long'}));

  const lastDelta =
    watching.frames.findLast(
      frameOf('turn_progress', {progress: {kind: 'reply_delta'}}),
    )?.id ?? '';
  const [run = '', newest = ''] = (watching.lastEventId() ?? '').split('-');
  // The same run id with its first digit changed.
  const otherRun = `${run.startsWith('0') ? '1' : '0'}${run.slice(1)}`;

  expect(await opensWith(lastDelta)).toBe('resumed');

  for (const lastEventId of [
    before,
    `${run}-${String(Number(newest) + 1)}`,
    `${otherRun}-1`,
    'yesterday',
  ]) {
    expect(await opensWith(lastEventId), lastEventId).toBe('ready');
  }
});

it('stream.shutdown-ends-streams: a stop ends each stream only once every frame queued for it is written, a client lagging within the grace included, and a stream asked for meanwhile is refused at once', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
    // Longer than the stop takes to reach the streams.
    {PROJECT02_TEST_DURATIONS: 'grace=10000'},
  );
  const say = await converse(wireOf(daemon), 'mira');
  const keepingUp = await openEvents(daemon);
  const lagging = await exchange(daemon, {
    path: '/api/events',
    headers: bearer(daemon),
  });

  await lagging.received('event: ready');
  lagging.pause();
  model.answer(overflowingDraft());
  await say('Talk a lot.', 'long');
  daemon.signal('SIGINT');
  await daemon.printed('Stopping; finishing what is in flight.');
  await keepingUp.ended();

  const asked = performance.now();
  const late = await exchange(daemon, {
    path: '/api/events',
    headers: bearer(daemon),
  });

  expect(late.status).toBe(503);
  expect(performance.now() - asked).toBeLessThan(2_000);
  lagging.resume();

  // Whole, so ended by the daemon rather than broken off, and holding
  // every queued frame as the stream that kept up saw it.
  const queued = (frames: readonly Frame[]) =>
    frames.filter(frame => frame.id !== undefined && frame.event !== 'ready');

  expect(queued(framesOf(await lagging.whole()))).toEqual(
    queued(keepingUp.frames),
  );
  expect(await daemon.exit()).toBe(0);
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
  await watching.next(telegram(false));

  const dropped = performance.now() - submitted;

  // The grace of one second runs from the stall, then the drop: within the grace means about it.
  expect(dropped).toBeGreaterThanOrEqual(900);
  expect(dropped).toBeLessThan(5_000);
  stalled.resume();
  await stalled.ended();
  expect(stalled.body()).not.toContain('event: turn_completed');
});

it('stream.running-turns-fold: a stream opened mid-reply finds the running turn in ready with its draft so far, a later one a longer draft, and one opened after the turn ends none', async () => {
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
    watching.next(
      frameOf('turn_progress', {progress: {kind: 'reply_delta', text}}),
    );

  await driven.arrived();
  driven.write([head]);
  await drafted('Hello');
  expect(
    dataOf(await (await openEvents(daemon)).next(frameOf('ready'))),
  ).toMatchObject(running('Hello'));
  driven.write([middle]);
  await drafted(' there,');
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

it('stream.refused-submission-mid-turn: a submission refused on the spot completes at once and leaves the running turn running', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
  );
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const events = await openEvents(daemon);
  const held = model.hold();
  const running = say('Hello?', 'running');

  await held.arrived();
  await expect(
    wire.turn({
      conversationId,
      senderId: 'someone-else',
      text: 'Not mine.',
      source: 'web',
      clientMessageId: 'not-mine',
    }),
  ).resolves.toMatchObject({status: 'refused', reason: 'sender_not_supported'});
  await events.next(
    frameOf('turn_completed', {
      clientMessageId: 'not-mine',
      status: 'refused',
      committed: false,
    }),
  );

  const later = await openEvents(daemon);

  expect(dataOf(await later.next(frameOf('ready')))).toMatchObject({
    turns: [{conversationId, source: 'web', clientMessageId: 'running'}],
  });
  held.release(reply('Hello.'));
  await expect(running).resolves.toMatchObject({status: 'completed'});
});

it("stream.sync-rule: the person's line rides the stream as user_message, stamped, once it is on disk, and the reply follows", async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
  );
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const events = await openEvents(daemon);
  const held = model.hold();
  const turn = say('Hello there.', 'sync');
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
  held.release(reply('Hello.'));
  await events.next(
    frameOf('turn_progress', {
      progress: {kind: 'visible_reply', text: 'Hello.'},
    }),
  );
  await turn;
});

it('stream.drafts: a reply is drafted ahead of its commit under a draft id the commit names, each reply of a round under its own', async () => {
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
      .filter(frameOf('turn_progress'))
      .map(frame => (dataOf(frame) as {readonly progress: object}).progress)
      .filter(progress => 'draftId' in progress),
  ).toMatchObject([
    {kind: 'reply_delta', draftId: '1.0', text: 'First'},
    {kind: 'reply_delta', draftId: '1.0', text: ', this.'},
    {kind: 'reply_delta', draftId: '1.1', text: 'Then'},
    {kind: 'reply_delta', draftId: '1.1', text: ' that.'},
    {kind: 'visible_reply', draftId: '1.0', text: 'First, this.'},
    {kind: 'visible_reply', draftId: '1.1', text: 'Then that.'},
  ]);
});

it('stream.drafts-withdrawn: the drafts of a round the parser refuses or the budget refuses are withdrawn before the round moves on, and the next round drafts afresh', async () => {
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

  const progress = events.frames.filter(frameOf('turn_progress')).map(
    frame =>
      (
        dataOf(frame) as {
          readonly progress: {
            readonly kind: string;
            readonly draftId?: string;
            readonly text?: string;
          };
        }
      ).progress,
  );
  const ofRound = (round: string) =>
    progress.filter(step => step.draftId?.startsWith(`${round}.`) === true);

  expect(progress[0]).toMatchObject({kind: 'user_message'});
  expect(ofRound('1')).toMatchObject([
    {kind: 'reply_delta', draftId: '1.0', text: 'Let me look.'},
    {kind: 'reply_withdrawn', draftId: '1.0'},
  ]);
  // Both drafts of the second round are withdrawn, in whichever order, before anything of a later round.
  expect(ofRound('2').slice(0, 2)).toMatchObject([
    {kind: 'reply_delta', draftId: '2.0', text: 'Let me look again.'},
    {kind: 'reply_delta', draftId: '2.1', text: 'And again.'},
  ]);
  expect(
    ofRound('2')
      .slice(2)
      .map(step => [step.kind, step.draftId])
      .sort(),
  ).toEqual([
    ['reply_withdrawn', '2.0'],
    ['reply_withdrawn', '2.1'],
  ]);
  expect(
    progress.findLastIndex(step => step.draftId?.startsWith('2.') === true),
  ).toBeLessThan(
    progress.findIndex(step => step.draftId?.startsWith('100.') === true),
  );
  expect(ofRound('100')).toMatchObject([
    {kind: 'reply_delta', draftId: '100.0', text: 'One last look.'},
    {kind: 'reply_withdrawn', draftId: '100.0'},
  ]);
});

it('stream.turn-completed: turn_completed carries the turn identity, its status, whether the line was committed, and the reason when it did not complete', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
  );
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const events = await openEvents(daemon);
  const identity = (clientMessageId: string) => ({
    kind: 'turn_completed',
    characterId: 'mira',
    conversationId,
    source: 'web',
    clientMessageId,
  });

  model.answer(reply('Hello.'), ...undecided());
  await say('Hello?', 'completed');
  await say('And now?', 'rejected');
  expect(
    dataOf(
      await events.next(
        frameOf('turn_completed', {clientMessageId: 'completed'}),
      ),
    ),
  ).toEqual({...identity('completed'), status: 'completed', committed: true});
  expect(
    dataOf(
      await events.next(
        frameOf('turn_completed', {clientMessageId: 'rejected'}),
      ),
    ),
  ).toEqual({
    ...identity('rejected'),
    status: 'rejected',
    committed: true,
    reason: 'malformed_output',
    message: expect.any(String) as string,
  });
});

it('stream.connector-presence: a stream opened with ?connector= holds its connector present from before its first frame until its last stream ends, health_changed marking only those crossings; an unknown connector is a 400 naming the known ones', async () => {
  const daemon = await startDaemon(createHome(), fixedReplies);
  const say = await converse(wireOf(daemon), 'mira');
  const watching = await openEvents(daemon);
  const telegram = (connected: boolean) => ({
    health: {connectors: [{id: 'telegram', connected}]},
  });
  const connector = async () => {
    const stream = await exchange(daemon, {
      path: '/api/events?connector=telegram',
      headers: bearer(daemon),
    });

    await stream.received('event: ready');

    return stream;
  };
  const unknown = await exchange(daemon, {
    path: '/api/events?connector=discord',
    headers: bearer(daemon),
  });

  expect(unknown.status).toBe(400);
  expect(JSON.parse(await unknown.whole())).toEqual({
    error: {
      code: 'invalid_request',
      message: expect.stringContaining('telegram') as string,
    },
  });

  const first = await connector();

  // Its own ready already counts it.
  expect(
    JSON.parse(/^data: (.*)$/mu.exec(first.body())?.[1] ?? 'null'),
  ).toMatchObject(telegram(true));
  await watching.next(frameOf('health_changed', telegram(true)));

  const second = await connector();

  first.hangUp();
  await first.ended();
  // A turn the daemon finishes after the close reached it: the close is in.
  await say('Still here?', 'after-the-first-close');
  expect(
    watching.frames.filter(frameOf('health_changed', telegram(false))),
  ).toEqual([]);

  const meanwhile = await openEvents(daemon);

  expect(dataOf(await meanwhile.next(frameOf('ready')))).toMatchObject(
    telegram(true),
  );
  second.hangUp();
  await watching.next(frameOf('health_changed', telegram(false)));
  expect(watching.frames.filter(frameOf('health_changed'))).toHaveLength(2);
});
