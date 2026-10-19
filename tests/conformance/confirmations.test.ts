import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents, type Frame} from './harness/events.ts';
import {characterJson, configJson, createHome} from './harness/home.ts';
import {
  calling,
  reply,
  startModelServer,
  toolResults,
  type Answer,
} from './harness/model-server.ts';
import {converse, saveConfig, wireOf, type Wire} from './harness/wire.ts';

type Parked = {
  readonly id: string;
  readonly deadlineAt: number;
  readonly turn: {readonly conversationId: string};
};

const mira = {scope: 'character', characterId: 'mira'} as const;
const fiveMinutes = 5 * 60_000;

/** Mira on the model server, beside the bundled plugin whose fields the model may ask to change. */
async function demoConfigHome(
  env: Readonly<Record<string, string>> = {},
  seed: object = {},
) {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({
      project02: model.settings,
      plugins: {'demo-config': {enabled: true}},
    }),
    ...seed,
  });
  const daemon = await startDaemon(home, env);
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');

  return {model, home, daemon, wire, say};
}

/** The model asks to set a character's tone, against the fingerprint her settings hand out now. */
async function asksForTone(
  wire: Wire,
  tone: string,
  target: Parameters<Wire['configView']>[0] = mira,
): Promise<Answer> {
  const view = (await wire.configView(target)) as {
    readonly fingerprint: string;
  };

  return calling([
    'runtime_plugin_config_update',
    {
      pluginId: 'demo-config',
      fieldName: 'tone',
      operation: 'set',
      value: tone,
      expectedFingerprint: view.fingerprint,
    },
  ]);
}

function parkedIn(frame: Frame): Parked {
  return JSON.parse(frame.data ?? '') as Parked;
}

function miraOverlay(home: string): string {
  return readFileSync(
    join(home, 'character-data', 'mira', 'config.json'),
    'utf8',
  );
}

it('confirmations.requested: a tool call that needs approval parks a confirmation, listed with its deadline and the turn that raised it, and announced to every client', async () => {
  const {model, daemon, wire, say} = await demoConfigHome();
  const clients = [await openEvents(daemon), await openEvents(daemon)];

  model.answer(await asksForTone(wire, 'pirate'), reply('Arr.'));

  const asked = Date.now();
  const turn = say('Talk like a pirate.', 'pirate');
  const announced = await Promise.all(
    clients.map(events => events.next(frameOf('confirmation_requested'))),
  );
  const pending = (await wire.pending()) as [Parked];
  const [parked] = pending;

  expect(pending).toMatchObject([
    {
      characterId: 'mira',
      request: {
        pluginId: 'runtime.plugin',
        toolName: 'runtime.plugin.config.update',
        preview: {
          targetPluginId: 'demo-config',
          fieldName: 'tone',
          after: {value: 'pirate'},
        },
      },
      turn: {source: 'web', clientMessageId: 'pirate'},
    },
  ]);
  expect(parked.deadlineAt).toBeGreaterThanOrEqual(asked + fiveMinutes);
  expect(parked.deadlineAt).toBeLessThanOrEqual(Date.now() + fiveMinutes);

  for (const frame of announced) {
    expect(JSON.parse(frame.data ?? '')).toEqual({
      kind: 'confirmation_requested',
      ...parked,
    });
  }

  await wire.answer(parked.id, 'approved');
  expect(await turn).toMatchObject({
    conversationId: parked.turn.conversationId,
  });
});

it('confirmations.answer: an approval is answered, heard settled by every client before the turn completes, and written; a denial writes nothing and the model is told so', async () => {
  const {model, home, daemon, wire, say} = await demoConfigHome();
  const first = await openEvents(daemon);
  const second = await openEvents(daemon);

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
    plugins: {'demo-config': {config: {tone: 'pirate'}}},
  });

  const written = miraOverlay(home);

  model.answer(await asksForTone(wire, 'formal'), reply('Very well.'));

  const denied = say('Be formal.', 'formal');
  const refused = parkedIn(await first.next(frameOf('confirmation_requested')));

  expect(await wire.answer(refused.id, 'denied')).toEqual({status: 'answered'});
  expect(await denied).toMatchObject({status: 'completed'});
  expect(miraOverlay(home)).toBe(written);
  expect(toolResults(model.requests.at(-1)).at(-1)).toMatchObject({
    status: 'rejected',
    reason: 'plugin_config_approval_denied',
  });
});

it('confirmations.single-answer: a confirmation settles by its id alone, and a second answer to it or an answer to an id never given is unknown', async () => {
  const {model, daemon, wire, say} = await demoConfigHome();
  const events = await openEvents(daemon);

  model.answer(await asksForTone(wire, 'pirate'), reply('Arr.'));

  const turn = say('Talk like a pirate.', 'pirate');
  const {id} = parkedIn(await events.next(frameOf('confirmation_requested')));

  // Both at once: one is answered, the other finds nothing left to answer,
  // and the one settlement is the answered one's.
  const statuses = (
    await Promise.all([wire.answer(id, 'approved'), wire.answer(id, 'denied')])
  ).map(outcome => (outcome as {readonly status: string}).status);

  expect([...statuses].sort()).toEqual(['answered', 'unknown']);
  await events.next(
    frameOf('confirmation_settled', {
      id,
      decision: statuses[0] === 'answered' ? 'approved' : 'denied',
    }),
  );
  expect(
    events.frames.filter(frameOf('confirmation_settled', {id})),
  ).toHaveLength(1);
  expect(await wire.answer('never-given', 'approved')).toEqual({
    status: 'unknown',
  });
  expect(await wire.pending()).toEqual([]);
  expect(await turn).toMatchObject({status: 'completed'});
});

it('confirmations.reconnect-finds-pending: a client that reconnects while a confirmation waits finds it in ready, answers it, and the waiting turn completes', async () => {
  const {model, daemon, wire, say} = await demoConfigHome();
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
  const {model, home, daemon, wire, say} = await demoConfigHome({
    PROJECT02_TEST_DURATIONS: 'confirmation=500',
  });
  const events = await openEvents(daemon);
  const before = miraOverlay(home);

  model.answer(await asksForTone(wire, 'pirate'), reply('Arr.'));

  const turn = say('Talk like a pirate.', 'pirate');
  const {id} = parkedIn(await events.next(frameOf('confirmation_requested')));
  const asked = performance.now();

  await events.next(
    frameOf('confirmation_settled', {
      id,
      decision: 'cancelled',
      reason: 'expired',
    }),
  );

  const waited = performance.now() - asked;

  // At its deadline of half a second: neither at once nor long after.
  expect(waited).toBeGreaterThanOrEqual(400);
  expect(waited).toBeLessThan(3_000);
  expect(await turn).toMatchObject({status: 'completed'});
  expect(miraOverlay(home)).toBe(before);
  expect(await wire.answer(id, 'approved')).toEqual({status: 'unknown'});
});

it("confirmations.approval-window: an approval that comes after the tool's five-second execution timeout, inside the approval window, still applies", async () => {
  const {model, home, daemon, wire, say} = await demoConfigHome({
    PROJECT02_TEST_DURATIONS: 'heartbeat=6000',
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
    plugins: {'demo-config': {config: {tone: 'pirate'}}},
  });
});

it('confirmations.cancelled-stopped: switching a character off or stopping the daemon cancels every parked confirmation as stopped, one raised while she shuts down is cancelled unannounced, and once she is back on they park again', async () => {
  const {model, daemon, wire, say, home} = await demoConfigHome(
    {},
    {
      characters: {
        zeta: {'project02.character.json': characterJson('zeta', 'Zeta')},
      },
    },
  );
  const events = await openEvents(daemon);

  model.answer(await asksForTone(wire, 'pirate'));

  const draining = model.hold();
  const pirate = say('Talk like a pirate.', 'pirate');
  const first = parkedIn(await events.next(frameOf('confirmation_requested')));

  await saveConfig(wire, mira, {
    kind: 'set',
    path: 'project02.enabled',
    value: false,
  });
  await events.next(
    frameOf('confirmation_settled', {
      id: first.id,
      decision: 'cancelled',
      reason: 'stopped',
    }),
  );
  await draining.arrived();
  draining.release(await asksForTone(wire, 'formal'));
  model.answer(reply('Arr.'));
  expect(await pirate).toMatchObject({status: 'completed'});
  expect(toolResults(model.requests.at(-1)).at(-1)).toMatchObject({
    reason: 'plugin_config_approval_cancelled',
  });
  await events.next(frameOf('turn_completed', {clientMessageId: 'pirate'}));
  expect(
    events.frames
      .filter(frame => frame.event?.startsWith('confirmation_') === true)
      .map(frame => JSON.parse(frame.data ?? '') as unknown),
  ).toMatchObject([
    {kind: 'confirmation_requested', id: first.id},
    {kind: 'confirmation_settled', id: first.id},
  ]);

  await saveConfig(wire, mira, {
    kind: 'set',
    path: 'project02.enabled',
    value: true,
  });
  await events.next(
    frameOf('state_changed', {characterId: 'mira', state: 'ready'}),
  );
  // One queue of answers for both: each character's call first, then the
  // replies their cancelled rounds take in whichever order they come.
  model.answer(await asksForTone(wire, 'warm'));

  const warm = say('Be warm.', 'warm');
  const again = parkedIn(await events.next(frameOf('confirmation_requested')));
  const sayZeta = await converse(wire, 'zeta');
  const zeta = {scope: 'character', characterId: 'zeta'} as const;

  model.answer(await asksForTone(wire, 'formal', zeta));

  const formal = sayZeta('Be formal.', 'formal');
  const zetaParked = parkedIn(
    await events.next(frameOf('confirmation_requested')),
  );

  model.answer(reply('Warmly.'), reply('Formally.'));
  const cancelled = frameOf('confirmation_settled', {
    decision: 'cancelled',
    reason: 'stopped',
  });

  daemon.signal('SIGINT');
  expect(
    new Set(
      [await events.next(cancelled), await events.next(cancelled)].map(
        frame => parkedIn(frame).id,
      ),
    ),
  ).toEqual(new Set([again.id, zetaParked.id]));
  expect(await warm).toMatchObject({status: 'completed'});
  expect(await formal).toMatchObject({status: 'completed'});
  await events.ended();
  expect(await daemon.exit()).toBe(0);

  // Park again after a restart: on the same home, a new confirmation is
  // announced and answered.
  const restarted = await startDaemon(home);
  const wireAgain = wireOf(restarted);
  const sayAgain = await converse(wireAgain, 'mira');
  const later = await openEvents(restarted);

  model.answer(await asksForTone(wireAgain, 'playful'), reply('Gladly.'));

  const playful = sayAgain('Be playful.', 'playful');
  const parkedAgain = parkedIn(
    await later.next(frameOf('confirmation_requested')),
  );

  expect(await wireAgain.answer(parkedAgain.id, 'approved')).toEqual({
    status: 'answered',
  });
  expect(await playful).toMatchObject({status: 'completed'});
});
