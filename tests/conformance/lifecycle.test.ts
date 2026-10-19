import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {serve, startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents} from './harness/events.ts';
import {configJson, createHome} from './harness/home.ts';
import {reply, startModelServer} from './harness/model-server.ts';
import {converse, wireOf} from './harness/wire.ts';

const fixedReplies = {PROJECT02_TEST_PROVIDER: 'deterministic'};

function record(home: string): unknown {
  return JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8'));
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

it('lifecycle.daemon-record: while serving, daemon.json at mode 0600 holds the protocol version, token, port and running process, and a clean stop drops only the running process', async () => {
  const home = createHome();
  const daemon = await startDaemon(home);
  const address = {
    protocolVersion: 7,
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

it('lifecycle.stop-drains-in-flight: a stop says so, finishes the turn in flight on its answer and the stream, then ends the stream and exits 0', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
  );
  const say = await converse(wireOf(daemon), 'mira');
  const events = await openEvents(daemon);
  const held = model.hold();
  const turn = say('Still there?', 'in-flight');
  // The order the answer and the stream's end settle in, as they settle.
  const settled: string[] = [];
  const ended = events.ended();

  void turn.then(
    () => settled.push('answered'),
    () => settled.push('answered'),
  );
  void ended.then(
    () => settled.push('ended'),
    () => settled.push('ended'),
  );
  await held.arrived();
  daemon.signal('SIGINT');
  await daemon.printed('Stopping; finishing what is in flight.');
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
  expect(settled).toEqual(['answered', 'ended']);
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

it('lifecycle.usage-errors: serve refuses the options a client owns with exit 1, naming the option on stderr', async () => {
  const home = createHome();

  for (const option of ['--help', '--character']) {
    const run = serve(['--store', home, option]);

    expect(await run.exit(), option).toBe(1);
    expect(run.stderr(), option).toContain(`Unknown serve option: ${option}.`);
  }
});

it('lifecycle.store-consent-no-terminal: without --init and with no terminal to ask, serve on an empty directory exits 1 naming it and --init, and writes nothing', async () => {
  const home = createHome();
  const run = serve(['--store', home]);

  expect(await run.exit()).toBe(1);
  expect(run.stderr()).toContain(`No Project02 store at "${home}"`);
  expect(run.stderr()).toContain('--init');
  expect(readdirSync(home)).toEqual([]);
});

it("lifecycle.store-init: serve --init makes a home of an empty directory, or of one holding only a home's own entries, and serves it", async () => {
  const empty = createHome();
  const served = await startDaemon(empty);

  await expect(wireOf(served).health()).resolves.toMatchObject({
    homeRoot: empty,
  });
  expect(readdirSync(empty).sort()).toEqual([
    '.locks',
    'character-data',
    'config.json',
    'daemon.json',
    'schema.json',
  ]);

  const seeded = createHome({
    characters: {},
    conversations: {},
    'config.json': configJson({}),
  });
  const daemon = await startDaemon(seeded, fixedReplies);

  await expect(wireOf(daemon).start('mira')).resolves.toMatchObject({
    character: {state: 'ready'},
  });
  expect(readdirSync(seeded)).toContain('schema.json');
});

it('lifecycle.roster-health: health lists each installed character with its display name, switch and state, and a damaged data directory hides none', async () => {
  const home = createHome({
    characters: {
      zeta: {
        'project02.character.json': JSON.stringify({
          format: 'project02.character.v1',
          identity: {id: 'zeta', displayName: 'Zeta'},
          persona: {system: ['You are Zeta.']},
          meta: {version: '1.0.0'},
        }),
      },
    },
    'character-data': {zeta: {'schema.json': 'not json'}},
  });
  const wire = wireOf(await startDaemon(home, fixedReplies));

  await wire.start('mira');
  await wire.start('zeta');

  const {characters} = (await wire.health()) as {
    readonly characters: readonly {readonly id: string}[];
  };

  expect(characters).toHaveLength(2);
  expect(characters).toEqual(
    expect.arrayContaining([
      {id: 'mira', displayName: 'Mira', enabled: true, state: 'ready'},
      expect.objectContaining({
        id: 'zeta',
        displayName: 'Zeta',
        enabled: true,
        state: 'failed',
      }),
    ]),
  );
});
