import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents, type Frame} from './harness/events.ts';
import {configJson, createHome} from './harness/home.ts';
import {
  calling,
  reply,
  startModelServer,
  toolResults,
  type Answer,
} from './harness/model-server.ts';
import {converse, wireOf, type Wire} from './harness/wire.ts';

const mira = {scope: 'character', characterId: 'mira'} as const;

/** Mira on the model server, her reply style on: the plugin whose fields the model may ask to change. */
async function replyStyleHome(env: Readonly<Record<string, string>> = {}) {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
    'character-data': {
      mira: {
        'config.json': configJson({plugins: {'reply-style': {enabled: true}}}),
      },
    },
  });
  const daemon = await startDaemon(home, env);
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');

  return {model, home, daemon, wire, say};
}

/** The model asks to set Mira's tone, against the fingerprint her settings hand out now. */
async function asksForTone(wire: Wire, tone: string): Promise<Answer> {
  const view = (await wire.configView(mira)) as {
    readonly fingerprint: string;
  };

  return calling([
    'runtime_plugin_config_update',
    {
      pluginId: 'reply-style',
      fieldName: 'tone',
      operation: 'set',
      value: tone,
      expectedFingerprint: view.fingerprint,
    },
  ]);
}

function parkedIn(frame: Frame): {readonly id: string} {
  return JSON.parse(frame.data ?? '') as {readonly id: string};
}

function miraOverlay(home: string): string {
  return readFileSync(
    join(home, 'character-data', 'mira', 'config.json'),
    'utf8',
  );
}

it("confirmations.answer: an approval is heard settled by every client before the turn completes and is written into her overlay, never the home's settings; a denial writes nothing and the model is told so", async () => {
  const {model, home, daemon, wire, say} = await replyStyleHome();
  const first = await openEvents(daemon);
  const second = await openEvents(daemon);
  const homeSettings = readFileSync(join(home, 'config.json'), 'utf8');

  model.answer(await asksForTone(wire, 'pirate'), reply('Arr.'));

  const approved = say('Talk like a pirate.', 'pirate');
  const {id} = parkedIn(await first.next(frameOf('confirmation_requested')));

  expect(await wire.answer(id, 'approved')).toEqual({status: 'answered'});
  expect(await approved).toMatchObject({status: 'completed'});

  for (const events of [first, second]) {
    await events.next(
      frameOf('confirmation_settled', {id, decision: 'approved'}),
    );
    await events.next(
      frameOf('turn_completed', {
        clientMessageId: 'pirate',
        status: 'completed',
      }),
    );
  }

  expect(JSON.parse(miraOverlay(home))).toMatchObject({
    plugins: {'reply-style': {config: {tone: 'pirate'}}},
  });
  expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe(homeSettings);

  const written = miraOverlay(home);

  model.answer(await asksForTone(wire, 'formal'), reply('Very well.'));

  const denied = say('Be formal.', 'formal');
  const refused = parkedIn(await first.next(frameOf('confirmation_requested')));

  expect(await wire.answer(refused.id, 'denied')).toEqual({status: 'answered'});
  expect(await denied).toMatchObject({status: 'completed'});
  expect(miraOverlay(home)).toBe(written);
  expect(toolResults(model.requests.at(-1)).at(-1)).toMatchObject({
    status: 'rejected',
    reason: 'approval_denied',
  });
});

it('confirmations.reconnect-finds-pending: a client that reconnects while a confirmation waits finds it in ready, answers it, and the waiting turn completes', async () => {
  const {model, daemon, wire, say} = await replyStyleHome();
  const before = await openEvents(daemon);

  model.answer(await asksForTone(wire, 'pirate'), reply('Arr.'));

  const turn = say('Talk like a pirate.', 'pirate');
  const {id} = parkedIn(await before.next(frameOf('confirmation_requested')));
  const reconnected = await openEvents(daemon);

  await reconnected.next(frameOf('ready', {confirmations: [{id}]}));
  expect(await wire.answer(id, 'approved')).toEqual({status: 'answered'});
  expect(await turn).toMatchObject({status: 'completed'});
});

it('confirmations.expire: a confirmation nobody answers by its deadline settles cancelled expired, the turn completes, nothing is written, and a later answer is unknown', async () => {
  const {model, home, daemon, wire, say} = await replyStyleHome({
    PROJECT02_TEST_DURATIONS: 'confirmation=500',
  });
  const events = await openEvents(daemon);
  const before = miraOverlay(home);

  model.answer(await asksForTone(wire, 'pirate'), reply('Arr.'));

  const sent = performance.now();
  const turn = say('Talk like a pirate.', 'pirate');
  const {id} = parkedIn(await events.next(frameOf('confirmation_requested')));

  await events.next(
    frameOf('confirmation_settled', {
      id,
      decision: 'cancelled',
      reason: 'expired',
    }),
  );
  // Not before its half-second deadline, which began after the line was sent.
  expect(performance.now() - sent).toBeGreaterThanOrEqual(450);
  expect(await turn).toMatchObject({status: 'completed'});
  expect(miraOverlay(home)).toBe(before);
  expect(await wire.answer(id, 'approved')).toEqual({status: 'unknown'});
});

it("confirmations.approval-window: an approval that comes after the tool's five-second execution timeout, inside the approval window, still applies", async () => {
  const {model, home, daemon, wire, say} = await replyStyleHome({
    PROJECT02_TEST_DURATIONS: 'ping=6000',
  });
  const events = await openEvents(daemon);

  model.answer(await asksForTone(wire, 'pirate'), reply('Arr.'));

  const turn = say('Talk like a pirate.', 'pirate');
  const {id} = parkedIn(await events.next(frameOf('confirmation_requested')));
  const asked = performance.now();
  // A stream opened after the request pings six seconds on: the clock that
  // puts the approval past the tool's execution timeout.
  const clock = await openEvents(daemon);

  await clock.next(frame => frame.comment === 'ping');
  expect(performance.now() - asked).toBeGreaterThanOrEqual(5_000);
  expect(await wire.answer(id, 'approved')).toEqual({status: 'answered'});
  expect(await turn).toMatchObject({status: 'completed'});
  expect(JSON.parse(miraOverlay(home))).toMatchObject({
    plugins: {'reply-style': {config: {tone: 'pirate'}}},
  });
});

it('confirmations.cancelled-stopped: stopping the daemon while a confirmation waits withdraws it, cancelled as stopped, lets her turn complete and exits promptly instead of waiting out its deadline', async () => {
  const {model, daemon, wire, say} = await replyStyleHome();
  const events = await openEvents(daemon);

  model.answer(await asksForTone(wire, 'pirate'), reply('Never mind.'));

  const turn = say('Talk like a pirate.', 'pirate');
  const {id} = parkedIn(await events.next(frameOf('confirmation_requested')));
  const stopped = performance.now();

  daemon.signal('SIGINT');
  await events.next(
    frameOf('confirmation_settled', {
      id,
      decision: 'cancelled',
      reason: 'stopped',
    }),
  );
  expect(await turn).toMatchObject({status: 'completed'});
  await events.ended();
  expect(await daemon.exit()).toBe(0);
  // Promptly: not the five minutes the confirmation had.
  expect(performance.now() - stopped).toBeLessThan(5_000);
});
