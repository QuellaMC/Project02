import {createHash, randomUUID} from 'node:crypto';
import {
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {createServer, type AddressInfo} from 'node:net';
import {join} from 'node:path';

import {expect, it, onTestFinished} from 'vitest';

import {serve, startDaemon} from './harness/daemon.ts';
import {
  frameOf,
  openEvents,
  type Events,
  type Frame,
} from './harness/events.ts';
import {chmod, characterJson, configJson, createHome} from './harness/home.ts';
import {
  finish,
  reply,
  startModelServer,
  toolCall,
  type Answer,
} from './harness/model-server.ts';
import {connectSocket} from './harness/socket.ts';
import {converse, wireOf} from './harness/wire.ts';

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

/** Settles once the stream says the character is in this state: in its ready snapshot, or later. */
async function reached(
  events: Events,
  characterId: string,
  state: string,
): Promise<void> {
  const ready = await events.next(frame => frame.event === 'ready');

  if (snapshotState(ready, characterId) !== state) {
    await events.next(frameOf('state_changed', {characterId, state}));
  }
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

/** The model calling one tool, and nothing else in that round. */
function calling(name: string, input: object): Answer {
  return {
    chunks: [
      ...toolCall({
        index: 0,
        id: `call_${name}`,
        name,
        arguments: JSON.stringify(input),
      }),
      finish('tool_calls'),
    ],
  };
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

it('lifecycle.same-address-across-runs: a later run on the same home answers on the same address, its port and token', async () => {
  const home = createHome();
  const first = await startDaemon(home);

  first.signal('SIGINT');
  await first.exit();

  const later = await startDaemon(home);

  expect(later.url).toBe(first.url);
  await expect(wireOf(later).health()).resolves.toMatchObject({
    homeRoot: home,
  });
});

it('lifecycle.record-temp-residue: the next record write removes the daemon.json temp file a killed writer left', async () => {
  const home = createHome();
  const killed = await startDaemon(home);

  killed.signal('SIGKILL');
  await killed.exit();

  const residue = `.daemon.json.${String(killed.pid)}.${randomUUID()}.tmp`;

  writeFileSync(join(home, residue), '{"protocolVersion":7,');
  await startDaemon(home);
  expect(readdirSync(home)).not.toContain(residue);
});

it("lifecycle.port-default-and-fallback: when another program holds the home's port, serve says so before its address line, binds a free port and records it for the next run", async () => {
  const port = await occupiedPort();
  const home = createHome({
    'daemon.json': JSON.stringify({protocolVersion: 7, token: 'kept', port}),
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

it("lifecycle.second-serve-unresponsive-holder: a serve facing a holder that does not answer says so and waits, takes the home on the record's address once the lease is freed, exits 1 asking to run it again when its wait runs out, and exits 1 quietly when stopped while waiting", async () => {
  const home = createHome();
  const holder = await startDaemon(home);

  holder.signal('SIGSTOP');

  const silent = `Another daemon holds this home but did not answer at ${holder.origin}/ within 0.5 seconds`;
  const quick = {PROJECT02_TEST_DURATIONS: 'probe=500'};
  const patient = serve(['--store', home], quick);
  const impatient = serve(['--store', home], {
    PROJECT02_TEST_DURATIONS: 'hold=1,probe=500',
  });
  const stopped = serve(['--store', home], quick);

  expect(await impatient.exit()).toBe(1);
  expect(impatient.stdout()).toBe('');
  expect(impatient.stderr()).toBe(
    `${silent}, still; run this again once it has started or stopped.\n`,
  );
  await Promise.all([
    patient.printedOnStderr(`${silent}; waiting for it.`),
    stopped.printedOnStderr(`${silent}; waiting for it.`),
  ]);
  stopped.signal('SIGINT');
  expect(await stopped.exit()).toBe(1);
  expect(stopped.stdout()).toBe('');
  expect(stopped.stderr()).toBe(`${silent}; waiting for it.\n`);
  holder.signal('SIGKILL');
  expect((await patient.address()).url).toBe(holder.url);
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

it('lifecycle.unreadable-record-replaced: a daemon.json that cannot be read, truncated or without its token, is replaced with a fresh token, and stderr names it', async () => {
  for (const unreadable of [
    '{"protocolVersion":7,"token":"old-token","port":4',
    JSON.stringify({protocolVersion: 7, port: 4242}),
  ]) {
    const home = createHome({'daemon.json': unreadable});
    const daemon = await startDaemon(home);

    daemon.signal('SIGINT');
    await daemon.exit();
    expect(daemon.stderr(), unreadable).toContain(join(home, 'daemon.json'));
    expect(daemon.token, unreadable).not.toBe('old-token');
    expect(record(home), unreadable).toEqual({
      protocolVersion: 7,
      token: daemon.token,
      port: Number(new URL(daemon.origin).port),
    });
  }
});

it('lifecycle.unwritable-record: when the home refuses daemon.json, serve exits 1 saying the store could not be written, prints nothing, leaves no record and lets the home go for the next run', async () => {
  // Its lock directory is there to take the lease: the record is the first write refused.
  const home = createHome({'.locks': {}});

  chmod(home, 0o500);
  onTestFinished(() => {
    chmod(home, 0o755);
  });

  const refused = serve(['--store', home]);

  expect(await refused.exit()).toBe(1);
  expect(refused.stderr()).toContain(
    'Error: Local runtime store could not be written.',
  );
  expect(refused.stdout()).toBe('');
  expect(readdirSync(home)).toEqual(['.locks']);
  expect(readdirSync(join(home, '.locks'))).toEqual([]);
  chmod(home, 0o755);
  await startDaemon(home);
});

it('lifecycle.usage-errors: serve refuses the options a client owns with exit 1, naming the option on stderr', async () => {
  const home = createHome();

  for (const option of ['--help', '--character']) {
    const run = serve(['--store', home, option]);

    expect(await run.exit(), option).toBe(1);
    expect(run.stderr(), option).toContain(`Unknown serve option: ${option}.`);
  }
});

it('lifecycle.test-switch-refusals: serve refuses to start, with exit 1, the reason on stderr and nothing written, on a durations key it does not read or gives twice, a value that is not whole milliseconds above 0, or a test provider other than deterministic', async () => {
  const home = createHome();
  const refusals = [
    ['PROJECT02_TEST_DURATIONS', 'edit=100', '"edit"'],
    ['PROJECT02_TEST_DURATIONS', 'grace=100,grace=200', '"grace"'],
    ['PROJECT02_TEST_DURATIONS', 'grace=0', '"0"'],
    ['PROJECT02_TEST_DURATIONS', 'grace=1.5', '"1.5"'],
    ['PROJECT02_TEST_PROVIDER', 'nvidia', '"deterministic"'],
  ] as const;
  const runs = refusals.map(([variable, value, reason]) => ({
    variable,
    reason,
    run: serve(['--store', home, '--init'], {[variable]: value}),
  }));

  for (const {variable, reason, run} of runs) {
    expect(await run.exit(), reason).toBe(1);
    expect(run.stderr(), reason).toContain(variable);
    expect(run.stderr(), reason).toContain(reason);
  }

  expect(readdirSync(home)).toEqual([]);
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

it('lifecycle.store-init-foreign-dir: serve --init refuses a directory holding foreign entries and creates nothing there', async () => {
  const home = createHome({'notes.txt': 'mine'});
  const run = serve(['--store', home, '--init']);

  expect(await run.exit()).toBe(1);
  expect(run.stdout()).toBe('');
  expect(readdirSync(home)).toEqual(['notes.txt']);
});

it("lifecycle.store-init-residue: a live process's in-flight marker temp file does not stop a home's initialization, and one a dead process abandoned is refused", async () => {
  const inFlight = createHome({
    [`.schema.json.${String(process.pid)}.${randomUUID()}.tmp`]: '{',
  });
  const daemon = await startDaemon(inFlight);

  await wireOf(daemon).start('mira');
  expect(readdirSync(inFlight)).toContain('schema.json');
  daemon.signal('SIGINT');
  await daemon.exit();

  const abandoned = `.schema.json.${String(daemon.pid)}.${randomUUID()}.tmp`;
  const crashed = createHome({[abandoned]: '{'});
  const refused = serve(['--store', crashed, '--init']);

  expect(await refused.exit()).toBe(1);
  expect(readdirSync(crashed)).toEqual([abandoned]);
});

it("lifecycle.leftover-record: a leftover daemon.json beside no marker is the home's own, and one that is a symlink or a directory is refused", async () => {
  const leftover = createHome({
    'daemon.json': JSON.stringify({
      protocolVersion: 7,
      token: 'leftover-token',
      port: 41925,
    }),
  });

  expect((await startDaemon(leftover)).token).toBe('leftover-token');

  const elsewhere = join(createHome({'record.json': '{}'}), 'record.json');
  const linked = createHome();
  const directory = createHome({'daemon.json': {}});

  symlinkSync(elsewhere, join(linked, 'daemon.json'));

  for (const home of [linked, directory]) {
    const run = serve(['--store', home, '--init']);

    expect(await run.exit(), home).toBe(1);
    expect(run.stdout(), home).toBe('');
    expect(readdirSync(home), home).toEqual(['daemon.json']);
  }

  expect(readFileSync(elsewhere, 'utf8')).toBe('{}');
});

it('lifecycle.store-wrong-dir: serve refuses a character data directory, or a directory inside one, as its home and creates nothing, while a home whose path merely runs through a character-data directory serves', async () => {
  const home = join(
    createHome({'character-data': {home: {}}}),
    'character-data',
    'home',
  );
  const daemon = await startDaemon(home);

  await wireOf(daemon).start('mira');
  daemon.signal('SIGINT');
  await daemon.exit();

  const miraData = join(home, 'character-data', 'mira');
  const before = readdirSync(miraData);

  for (const store of [miraData, join(miraData, 'inner')]) {
    const run = serve(['--store', store, '--init']);

    expect(await run.exit(), store).toBe(1);
    expect(run.stdout(), store).toBe('');
  }

  expect(readdirSync(miraData)).toEqual(before);
});

it('lifecycle.foreign-host-lease: a home whose lease names a process on another host is never taken over', async () => {
  const lease = {
    version: 1,
    resourceKey: 'daemon',
    nonce: randomUUID(),
    // No process on this host can have this pid: only its host keeps the lease.
    pid: 4_194_305,
    hostname: 'elsewhere.invalid',
    acquiredAt: '2026-10-18T00:00:00.000Z',
  };
  const lock = `${createHash('sha256').update('daemon').digest('hex')}.lock`;
  const home = createHome({
    '.locks': {[lock]: {'owner.json': JSON.stringify(lease)}},
  });
  const run = serve(['--store', home, '--init'], {
    PROJECT02_TEST_DURATIONS: 'hold=500',
  });

  expect(await run.exit()).toBe(1);
  expect(run.stdout()).toBe('');
  expect(readdirSync(home)).toEqual(['.locks']);
  expect(readdirSync(join(home, '.locks'))).toEqual([lock]);
  expect(
    JSON.parse(readFileSync(join(home, '.locks', lock, 'owner.json'), 'utf8')),
  ).toEqual(lease);
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

  while (
    !['nova', 'zeta'].every(id => statesOf(events, id).includes('ready'))
  ) {
    await events.next(() => true);
  }

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

it('lifecycle.roster-health: health lists each installed character with its display name, switch and state, and a damaged data directory hides none', async () => {
  const home = createHome({
    characters: {zeta: characterPackage('zeta', 'Zeta')},
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

it("lifecycle.health-diagnostics: health carries the protocol version, the home, each config diagnostic at its path and each package diagnostic with its package's path", async () => {
  const home = createHome({
    'config.json': configJson({project02: {character: 'mira'}}),
    characters: {broken: {'project02.character.json': '{not json'}},
  });

  expect(await wireOf(await startDaemon(home)).health()).toMatchObject({
    protocolVersion: 7,
    homeRoot: home,
    config: {
      diagnostics: [{severity: 'error', path: 'project02.character'}],
    },
    packages: {
      diagnostics: [
        {
          code: 'invalid_descriptor',
          path: join(home, 'characters', 'broken', 'project02.character.json'),
        },
      ],
    },
  });
});

it('lifecycle.start-verb: starting a character that is not installed is refused unknown_character, saying it was not found', async () => {
  const wire = wireOf(await startDaemon(createHome()));

  expect(await wire.start('ghost')).toMatchObject({
    status: 'refused',
    reason: 'unknown_character',
    message: expect.stringContaining('"ghost" was not found') as string,
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

it('lifecycle.boot-failure-no-crash-loop: a boot failure stays failed with its diagnostic, never started again until the stop', async () => {
  const daemon = await startDaemon(
    createHome({
      'config.json': configJson({project02: {contextWindowTokens: -5}}),
    }),
  );
  const events = await openEvents(daemon);

  await reached(events, 'mira', 'failed');
  expect(await wireOf(daemon).health()).toMatchObject({
    characters: [
      {
        id: 'mira',
        state: 'failed',
        diagnostic: expect.stringContaining('contextWindowTokens') as string,
      },
    ],
  });
  daemon.signal('SIGINT');
  await events.ended();

  const states = statesOf(events, 'mira');

  expect(states.slice(states.indexOf('failed'))).toEqual([
    'failed',
    'stopping',
    'stopped',
  ]);
});

it('lifecycle.boot-failure-retried-by-change: a character whose boot failed on invalid config is retried by the next config change once the file is fixed, and becomes ready', async () => {
  const home = createHome({
    'config.json': configJson({project02: {contextWindowTokens: -5}}),
  });
  const daemon = await startDaemon(home, fixedReplies);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);

  await reached(events, 'mira', 'failed');
  writeFileSync(join(home, 'config.json'), configJson({}));

  const view = (await wire.configView({scope: 'global'})) as {
    fingerprint: string;
  };

  await wire.configChange({
    target: {scope: 'global'},
    expectedFingerprint: view.fingerprint,
    operation: {kind: 'set', path: 'project02.userDisplayName', value: 'Robin'},
  });
  await events.next(
    frameOf('state_changed', {characterId: 'mira', state: 'ready'}),
  );
});

it('lifecycle.startup-problems-stderr: a character package that fails discovery is named on stderr with its code while the other characters are served', async () => {
  const home = createHome({
    characters: {broken: {'project02.character.json': '{not json'}},
  });
  const daemon = await startDaemon(home, fixedReplies);

  expect(await wireOf(daemon).start('mira')).toMatchObject({
    character: {state: 'ready'},
  });
  daemon.signal('SIGINT');
  await daemon.exit();
  expect(daemon.stderr()).toContain(
    `Character package ${join(home, 'characters', 'broken', 'project02.character.json')} (invalid_descriptor)`,
  );
});

it('lifecycle.stop-cancels-parked-confirmation: a stop with a confirmation parked and a reload queued behind it ends at once instead of at the deadline, and the character ends stopped', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({
      'config.json': configJson({
        project02: model.settings,
        plugins: {'demo-config': {enabled: true}},
      }),
    }),
  );
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const events = await openEvents(daemon);

  model.answer(calling('runtime_plugin_config', {pluginId: 'demo-config'}));

  const inspected = model.hold();

  model.answer(reply('Never mind.'));

  const turn = say('Be warmer.', 'warmer');
  const {messages} = (await inspected.arrived()).body as {
    messages: {content: string}[];
  };
  const {output} = JSON.parse(messages.at(-1)?.content ?? '') as {
    output: {fingerprint: string};
  };

  inspected.release(
    calling('runtime_plugin_config_update', {
      pluginId: 'demo-config',
      fieldName: 'tone',
      operation: 'set',
      value: 'warm',
      expectedFingerprint: output.fingerprint,
    }),
  );
  await events.next(frameOf('confirmation_requested'));

  const mira = {scope: 'character', characterId: 'mira'} as const;
  const view = (await wire.configView(mira)) as {fingerprint: string};

  await wire.configChange({
    target: mira,
    expectedFingerprint: view.fingerprint,
    operation: {
      kind: 'set',
      path: 'project02.contextWindowTokens',
      value: 4096,
    },
  });
  await events.next(
    frameOf('state_changed', {characterId: 'mira', state: 'reloading'}),
  );
  const stopped = performance.now();

  daemon.signal('SIGINT');
  await turn;
  expect(await daemon.exit()).toBe(0);
  // Promptly: not the five minutes the parked confirmation had.
  expect(performance.now() - stopped).toBeLessThan(5_000);
  await events.ended();
  expect(statesOf(events, 'mira').at(-1)).toBe('stopped');
});

it('lifecycle.stop-not-held-by-stalled-client: a stop does not wait on a client that stalled halfway through its request body', async () => {
  // A minute's grace: a stop that waited on the stalled client would outlast every wait here.
  const daemon = await startDaemon(createHome(), {
    PROJECT02_TEST_DURATIONS: 'grace=60000',
  });
  const stalled = await connectSocket(daemon);

  stalled.write(
    `POST /api/turns HTTP/1.1\r\nHost: ${new URL(daemon.origin).host}\r\nAuthorization: Bearer ${daemon.token}\r\nContent-Type: application/json\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n`,
  );
  await stalled.holds('HTTP/1.1 100 Continue\r\n\r\n');
  stalled.write('{"conversationId":');

  const stopped = performance.now();

  daemon.signal('SIGINT');
  expect(await daemon.exit()).toBe(0);
  // Promptly: not the minute the stalled client had.
  expect(performance.now() - stopped).toBeLessThan(5_000);
  await stalled.closed();
});

it('lifecycle.stop-cuts-stalled-reader: a stop gives a client that stopped reading a large answer the grace, about two seconds, then cuts it and exits', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
  );
  const wire = wireOf(daemon);

  await wire.start('mira');

  const opened = await wire.open('mira');

  if (opened.status !== 'opened') {
    throw new Error(`Mira has no conversation: ${JSON.stringify(opened)}.`);
  }

  const events = await openEvents(daemon);

  // A reader that takes nothing leaves the sockets' buffers to hold what
  // they can, under three mebibytes here, and JSON writes a control
  // character as six bytes: the answer is twice that.
  model.answer(reply('\u0001'.repeat(1024 * 1024)));

  const body = JSON.stringify({
    conversationId: opened.conversationId,
    senderId: opened.userParticipantId,
    text: 'Tell me everything.',
    source: 'web',
    clientMessageId: 'everything',
  });
  const reader = await connectSocket(daemon);

  reader.pause();
  reader.write(
    `POST /api/turns HTTP/1.1\r\nHost: ${new URL(daemon.origin).host}\r\nAuthorization: Bearer ${daemon.token}\r\nContent-Type: application/json\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`,
  );
  await events.next(frameOf('turn_completed', {clientMessageId: 'everything'}));

  // The monotonic clock: the wall clock is adjusted under WSL2.
  const stopped = performance.now();

  daemon.signal('SIGINT');
  expect(await daemon.exit()).toBe(0);

  const took = performance.now() - stopped;

  // Timers fire up to a few milliseconds early.
  expect(took).toBeGreaterThanOrEqual(1_900);
  expect(took).toBeLessThan(6_000);
  reader.resume();
  await reader.closed();

  const answer = reader.received();
  const headEnd = answer.indexOf('\r\n\r\n');
  const announced = Number(
    /^content-length: (\d+)$/imu.exec(
      answer.subarray(0, headEnd).toString('latin1'),
    )?.[1],
  );

  expect(answer.length - headEnd - 4).toBeLessThan(announced);
});

it('lifecycle.first-run-port: a first run on a home binds a free port the system hands it, names it in its address line and records it', async () => {
  // Two first runs at once: a port of the daemon's own choosing would be
  // taken for one of them, whose first line would then say so.
  const runs = await Promise.all(
    [createHome(), createHome()].map(async home => ({
      home,
      daemon: await startDaemon(home),
    })),
  );

  for (const {home, daemon} of runs) {
    expect(daemon.stdout()).toBe(`PROJECT02_GATEWAY=${daemon.url}\n`);
    expect(record(home)).toMatchObject({
      port: Number(new URL(daemon.origin).port),
    });
  }

  expect(
    new Set(runs.map(({daemon}) => new URL(daemon.origin).port)).size,
  ).toBe(2);
});

it('lifecycle.second-signal-exits: a second stop signal during a stop ends the process at once, and the next start reclaims the lease it left', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const daemon = await startDaemon(home);
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
  expect(record(home)).toMatchObject({running: {pid: daemon.pid}});
  const again = await startDaemon(home);

  expect(again.url).toBe(daemon.url);
  await expect(wireOf(again).health()).resolves.toMatchObject({
    homeRoot: home,
  });
});
