import {readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {type AddressInfo, createServer} from 'node:net';
import {join} from 'node:path';

import {expect, it, onTestFinished} from 'vitest';

import {
  connector,
  inspect,
  serve,
  startDaemon,
  terminal,
} from './harness/daemon.ts';
import {
  frameOf,
  openEvents,
  type Events,
  type Frame,
} from './harness/events.ts';
import {characterJson, configJson, createHome} from './harness/home.ts';
import {exchange, jsonFrom} from './harness/http.ts';
import {reply, startModelServer} from './harness/model-server.ts';
import {within} from './harness/wait.ts';
import {conversationOf, converse, wireOf} from './harness/wire.ts';

const fixedReplies = {PROJECT02_TEST_PROVIDER: 'deterministic'};

function record(home: string): unknown {
  return JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8'));
}

/** A character package as a home's `characters/<id>` directory holds it. */
function characterPackage(id: string, displayName: string) {
  return {'project02.character.json': characterJson(id, displayName)};
}

/** The character's state in a ready frame's snapshot. */
function snapshotState(ready: Frame, characterId: string): string | undefined {
  const {health} = JSON.parse(ready.data ?? '') as {
    health: {characters: {id: string; state: string}[]};
  };

  return health.characters.find(character => character.id === characterId)
    ?.state;
}

/** The character's states as the stream told them: its ready snapshot, then each change. */
function statesOf(events: Events, characterId: string): string[] {
  return events.frames.flatMap(frame => {
    if (frame.event === 'ready') {
      const state = snapshotState(frame, characterId);

      return state === undefined ? [] : [state];
    }

    if (frame.event !== 'state_changed') {
      return [];
    }

    const change = JSON.parse(frame.data ?? '') as {
      characterId: string;
      state: string;
    };

    return change.characterId === characterId ? [change.state] : [];
  });
}

/** A port another program listens on until the test ends. */
async function occupiedPort(): Promise<number> {
  const server = createServer();

  onTestFinished(
    () =>
      new Promise<void>(resolve => {
        server.close(() => {
          resolve();
        });
      }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return (server.address() as AddressInfo).port;
}

it('lifecycle.address-line: serve prints its address as its first stdout line once it answers there', async () => {
  const home = createHome();
  const daemon = await startDaemon(home);

  expect(daemon.stdout().split('\n')[0]).toMatch(
    /^PROJECT02_GATEWAY=http:\/\/127\.0\.0\.1:\d+\/#token=[!-~]+$/u,
  );
  await expect(wireOf(daemon).health()).resolves.toMatchObject({
    homeRoot: home,
  });
});

it('lifecycle.help: serve, inspect and telegram each print their usage with --help and exit 0, with nothing on stderr', async () => {
  for (const [run, usage] of [
    [serve(['--help']), 'Usage: project02 serve '],
    [inspect(['--help']), 'Usage: project02 inspect '],
    [connector(['--help']), 'Usage: project02 telegram '],
  ] as const) {
    expect(await run.exit()).toBe(0);
    expect(run.stdout().startsWith(usage), run.stdout()).toBe(true);
    expect(run.stderr()).toBe('');
  }
});

it('lifecycle.daemon-record: while serving, daemon.json at mode 0600 holds the protocol version, token, port and running process, and a clean stop drops only the running process', async () => {
  const home = createHome();
  const daemon = await startDaemon(home);
  const address = {
    protocolVersion: 8,
    token: daemon.token,
    port: Number(new URL(daemon.origin).port),
  };

  expect(statSync(join(home, 'daemon.json')).mode & 0o777).toBe(0o600);
  expect(record(home)).toEqual({
    ...address,
    running: {pid: daemon.pid, startedAt: expect.any(String) as string},
  });
  daemon.signal('SIGINT');
  await daemon.exit();
  expect(record(home)).toEqual(address);
});

it("lifecycle.port-default-and-fallback: when another program holds the home's port, serve says so before its address line, binds a free port and records it for the next run", async () => {
  const port = await occupiedPort();
  const home = createHome({
    'daemon.json': JSON.stringify({protocolVersion: 8, token: 'kept', port}),
  });
  const moved = await startDaemon(home);

  expect(moved.stdout().split('\n').slice(0, 2)).toEqual([
    `Port ${String(port)} was taken by another program; the address has changed. Open tabs and bookmarks need the new one.`,
    `PROJECT02_GATEWAY=${moved.url}`,
  ]);
  expect(new URL(moved.origin).port).not.toBe(String(port));
  expect(record(home)).toMatchObject({
    port: Number(new URL(moved.origin).port),
  });
  moved.signal('SIGINT');
  await moved.exit();
  const again = await startDaemon(home);

  expect(again.url).toBe(moved.url);
  await expect(wireOf(again).health()).resolves.toMatchObject({
    homeRoot: home,
  });
});

it('lifecycle.stop-signals: SIGINT, SIGTERM and SIGHUP each stop it cleanly, with exit 0, nothing on stderr and no running process in the record', async () => {
  const home = createHome();

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const daemon = await startDaemon(home, fixedReplies);

    daemon.signal(signal);
    expect(await daemon.exit(), signal).toBe(0);
    expect(daemon.stderr(), signal).toBe('');
    expect(record(home), signal).not.toHaveProperty('running');
  }
});

it('lifecycle.stop-drains-in-flight: a stop says so, answers a line sent meanwhile 503 unavailable, finishes the turn in flight and tells it on the stream, then ends the stream and exits 0', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
  );
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const events = await openEvents(daemon);
  const held = model.hold();
  const turn = say('Still there?', 'in-flight');
  const ended = events.ended();

  await held.arrived();
  daemon.signal('SIGINT');
  await daemon.printed('Stopping; finishing what is in flight.');

  const late = await exchange(daemon, {
    method: 'POST',
    path: '/api/turns',
    headers: jsonFrom(daemon),
    body: JSON.stringify({
      conversationId,
      text: 'Too late.',
      source: 'web',
      clientMessageId: 'late',
    }),
  });

  expect(late.status).toBe(503);
  expect(JSON.parse(await late.whole())).toEqual({
    error: {code: 'unavailable', message: 'The daemon is stopping.'},
  });
  held.release(reply('Still here.'));
  expect(await turn).toMatchObject({
    status: 'completed',
    messages: [{text: 'Still there?'}, {text: 'Still here.'}],
  });
  await events.next(
    frameOf('turn_progress', {
      progress: {kind: 'visible_reply', text: 'Still here.'},
    }),
  );
  await events.next(
    frameOf('turn_completed', {
      clientMessageId: 'in-flight',
      status: 'completed',
    }),
  );
  await ended;
  expect(await daemon.exit()).toBe(0);
});

it('lifecycle.second-serve-hands-back: a second serve on a running home hands back its address and exits 0, leaving it serving; once it stops, a third serves on the same address', async () => {
  const home = createHome();
  const first = await startDaemon(home);
  const second = serve(['--store', home]);

  expect(await second.exit()).toBe(0);
  expect(second.stdout()).toBe(
    `Already running on this home (pid ${String(first.pid)}).\nPROJECT02_GATEWAY=${first.url}\n`,
  );
  expect(second.stderr()).toBe('');
  await expect(wireOf(first).health()).resolves.toMatchObject({
    homeRoot: home,
  });
  first.signal('SIGINT');
  await first.exit();
  const again = await startDaemon(home);

  expect(again.url).toBe(first.url);
  await expect(wireOf(again).health()).resolves.toMatchObject({
    homeRoot: home,
  });
});

it('lifecycle.second-serve-waits-takeover: a serve started while the holder stops says it waits for it, then takes the home over on the same address once the holder lets go', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const holder = await startDaemon(home);
  const say = await converse(wireOf(holder), 'mira');
  const held = model.hold();
  const turn = say('Still there?', 'in-flight');

  await held.arrived();
  holder.signal('SIGINT');
  await holder.printed('Stopping; finishing what is in flight.');

  const next = serve(['--store', home]);

  await next.printedOnStderr(
    'Another daemon holds this home but is stopping; waiting for it.',
  );
  held.release(reply('Still here.'));
  await turn;
  expect((await next.address()).url).toBe(holder.url);
});

it('lifecycle.crash-lease-reclaimed: after SIGKILL the record still names the dead run, and the next serve takes the home on the same address', async () => {
  const home = createHome();
  const first = await startDaemon(home);

  first.signal('SIGKILL');
  await first.exit();
  expect(record(home)).toMatchObject({running: {pid: first.pid}});

  const next = await startDaemon(home);

  expect(next.url).toBe(first.url);
  await expect(wireOf(next).health()).resolves.toMatchObject({
    homeRoot: home,
  });
});

it('lifecycle.roster-boot: at boot every enabled character starts, and a disabled one is not started: health shows it switched off and not_started', async () => {
  const daemon = await startDaemon(
    createHome({
      characters: {
        nova: characterPackage('nova', 'Nova'),
        zeta: characterPackage('zeta', 'Zeta'),
      },
      'character-data': {
        mira: {'config.json': configJson({project02: {enabled: false}})},
      },
    }),
    fixedReplies,
  );
  const events = await openEvents(daemon);

  // One deadline for both: a character that keeps changing state must
  // not keep the wait alive.
  await within(
    'nova and zeta to be ready',
    (async () => {
      while (
        !['nova', 'zeta'].every(id => statesOf(events, id).includes('ready'))
      ) {
        await events.next(() => true);
      }
    })(),
  );

  expect(await wireOf(daemon).health()).toMatchObject({
    characters: [
      {id: 'mira', enabled: false, state: 'not_started'},
      {id: 'nova', enabled: true, state: 'ready'},
      {id: 'zeta', enabled: true, state: 'ready'},
    ],
  });
});

it('lifecycle.no-provider-chosen: until a model provider is chosen no character starts: health shows each failed saying so, and an open is refused character_unavailable with that sentence', async () => {
  const noProvider =
    'No model provider is chosen. Choose one on the settings page.';
  const wire = wireOf(
    await startDaemon(
      createHome({characters: {zeta: characterPackage('zeta', 'Zeta')}}),
    ),
  );

  await wire.start('mira');
  await wire.start('zeta');
  expect(await wire.health()).toMatchObject({
    characters: [
      {id: 'mira', state: 'failed', diagnostic: noProvider},
      {id: 'zeta', state: 'failed', diagnostic: noProvider},
    ],
  });
  expect(await wire.open('mira')).toMatchObject({
    status: 'refused',
    reason: 'character_unavailable',
    message: expect.stringContaining(noProvider) as string,
  });
});

it('lifecycle.start-retry-after-fix: a character whose config is invalid fails naming the field, and once the file is fixed a start reads it again and the character is ready', async () => {
  const home = createHome({
    'config.json': configJson({project02: {contextWindowTokens: -5}}),
  });
  const wire = wireOf(await startDaemon(home, fixedReplies));

  expect(await wire.start('mira')).toMatchObject({
    character: {
      state: 'failed',
      diagnostic: expect.stringContaining('contextWindowTokens') as string,
    },
  });
  writeFileSync(join(home, 'config.json'), configJson({}));
  expect(await wire.start('mira')).toMatchObject({
    character: {state: 'ready'},
  });
});

it('lifecycle.second-signal-exits: a second stop signal during a stop ends the process at once', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
  );
  const say = await converse(wireOf(daemon), 'mira');
  const held = model.hold();
  // Never released: a stop that waited for this turn would never end. Its
  // outcome is taken as it comes: the connection dies before the test looks.
  const turn = say('Still there?', 'held').then(
    () => 'answered',
    () => 'cut off',
  );

  await held.arrived();
  daemon.signal('SIGINT');
  await daemon.printed('Stopping; finishing what is in flight.');

  const second = performance.now();

  daemon.signal('SIGTERM');
  await daemon.exit();
  // At once: the turn the stop waited on is never finished.
  expect(performance.now() - second).toBeLessThan(3_000);
  expect(await turn).toBe('cut off');
});

it('lifecycle.store-consent-prompt: serve makes a store only with consent: on a terminal a yes makes it and serves and a no exits 1, and with no terminal to ask it exits 1 naming the directory and --init, writing nothing unless told yes', async () => {
  const question = (home: string) =>
    `No Project02 store at "${home}". Create one there? [y/N]`;
  const accepted = createHome();
  const yes = terminal(['--store', accepted]);

  // Asked before anything is made.
  await yes.shows(question(accepted));
  expect(readdirSync(accepted)).toEqual([]);
  yes.type('y\n');
  await expect(wireOf(await yes.address()).health()).resolves.toMatchObject({
    homeRoot: accepted,
  });

  const declined = createHome();
  const no = terminal(['--store', declined]);

  await no.shows(question(declined));
  no.type('n\n');
  expect(await no.exit()).toBe(1);
  expect(readdirSync(declined)).toEqual([]);

  const unasked = createHome();
  const run = serve(['--store', unasked]);

  expect(await run.exit()).toBe(1);
  expect(run.stderr()).toContain(`No Project02 store at "${unasked}"`);
  expect(run.stderr()).toContain('--init');
  expect(readdirSync(unasked)).toEqual([]);
});
