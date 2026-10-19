import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {createServer, type AddressInfo, type Server} from 'node:net';
import {join} from 'node:path';
import {Readable} from 'node:stream';

import {describe, expect, it, vi} from 'vitest';

import {runServeCliFromArgs} from '../../src/cli/serve/main.ts';
import {
  createGatewayClient,
  type GatewayClient,
} from '../../src/gateway/client/index.ts';
import {createRuntimePluginHost} from '../../src/plugins/index.ts';
import type {RoleModelAdapter} from '../../src/role-model/index.ts';
import {
  acquireLocalRuntimeDaemonLease,
  writeDaemonRecord,
} from '../../src/runtime/storage/index.ts';
import {
  awaitCharacterReady,
  createGatewayTestHome,
} from '../support/gateway-fixtures.ts';
import {createScriptedAdapter} from '../support/scripted-adapter.ts';
import {collect} from '../support/streams.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

const adapter: RoleModelAdapter = {
  invoke: () => ({
    rawOutputText: JSON.stringify({
      toolCalls: [{name: 'visible_reply', input: {text: 'served'}}],
    }),
  }),
};

/** Runs serve in-process; `url` settles on the line a client reads. */
function runServe(
  args: readonly string[],
  options: {
    readonly adapter?: RoleModelAdapter;
    readonly signal?: AbortSignal;
    readonly holdWaitMs?: number;
  } = {},
) {
  const abort = new AbortController();
  let stdout = '';
  let stderr = '';
  let announce: (url: string) => void = () => undefined;
  const url = new Promise<string>(resolve => {
    announce = resolve;
  });
  const exit = runServeCliFromArgs(args, {
    stdin: Readable.from([]),
    stdout: collect(chunk => {
      stdout += chunk;

      const line = stdout
        .split('\n')
        .find(candidate => candidate.startsWith('PROJECT02_GATEWAY='));

      if (line !== undefined) {
        announce(line.slice('PROJECT02_GATEWAY='.length));
      }
    }),
    stderr: collect(chunk => {
      stderr += chunk;
    }),
    pluginHost: createRuntimePluginHost({plugins: []}),
    roleModelAdapter: options.adapter ?? adapter,
    signal: options.signal ?? abort.signal,
    ...(options.holdWaitMs === undefined
      ? {}
      : {holdWaitMs: options.holdWaitMs}),
  });

  return {
    url,
    exit,
    stdout: () => stdout,
    stderr: () => stderr,
    stop: () => {
      abort.abort();

      return exit;
    },
  };
}

type Record = {
  readonly protocolVersion: number;
  readonly token: string;
  readonly port: number;
  readonly running?: {readonly pid: number; readonly startedAt: string};
};

function readRecord(storeRoot: string): Record {
  return JSON.parse(
    readFileSync(join(storeRoot, 'daemon.json'), 'utf8'),
  ) as Record;
}

function portOf(url: string): number {
  return Number(new URL(url).port);
}

function tokenOf(url: string): string {
  return new URLSearchParams(new URL(url).hash.slice(1)).get('token') ?? '';
}

async function chat(client: GatewayClient, text: string): Promise<void> {
  const opened = await client.openDirectConversation('mira');

  if (opened.status !== 'opened') {
    expect.fail(opened.message);
  }

  await expect(
    client.deliver({
      conversationId: opened.conversationId,
      senderId: opened.userParticipantId,
      text,
      source: 'web',
      clientMessageId: `msg-${text}`,
    }),
  ).resolves.toMatchObject({
    status: 'completed',
    messages: [
      {speakerName: 'You', text},
      {speakerName: 'Mira', text: 'served'},
    ],
  });
}

function occupy(port: number): Promise<Server> {
  return new Promise(resolve => {
    const server = createServer();

    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

function free(server: Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => {
      resolve();
    });
  });
}

/** A paced reply under way: resolves once its first piece is on the stream. */
function firstDelta(client: GatewayClient): Promise<void> {
  return new Promise<void>(resolve => {
    const abort = new AbortController();

    void client.events(
      event => {
        if (
          event.kind === 'turn_progress' &&
          event.progress.kind === 'reply_delta'
        ) {
          resolve();
          abort.abort();
        }
      },
      {signal: abort.signal},
    );
  });
}

/** A slow reply from the scripted adapter, started and left running: a second or so of pieces. */
async function startSlowTurn(client: GatewayClient) {
  const opened = await client.openDirectConversation('mira');

  if (opened.status !== 'opened') {
    expect.fail(opened.message);
  }

  const turn = client.deliver({
    conversationId: opened.conversationId,
    senderId: opened.userParticipantId,
    text: `slowly ${Array.from({length: 300}, (_, word) => `w${String(word)}`).join(' ')}`,
    source: 'web',
    clientMessageId: 'msg-slow',
  });

  await firstDelta(client);

  // Wrapped: an async function would otherwise await the turn itself.
  return {turn};
}

describe('serve', () => {
  it('prints the address first, records where it listens, and keeps the token and the port across a clean stop', async () => {
    const storeRoot = await createGatewayTestHome('project02-serve-');
    const serve = runServe(['--store', storeRoot]);
    const url = await serve.url;
    const client = createGatewayClient({url});

    // The address is the first thing printed, and the record says the same.
    expect(serve.stdout().indexOf('PROJECT02_GATEWAY=http://127.0.0.1:')).toBe(
      0,
    );
    expect(url).toContain('/#token=');
    expect(readRecord(storeRoot)).toMatchObject({
      protocolVersion: 7,
      token: tokenOf(url),
      port: portOf(url),
      running: {pid: process.pid},
    });
    expect(statSync(join(storeRoot, 'daemon.json')).mode & 0o777).toBe(0o600);

    // The address no longer waits for the roster; the stream says when
    // Mira is up.
    await awaitCharacterReady(client, 'mira');
    await chat(client, 'hello');
    await expect(serve.stop()).resolves.toBe(0);
    expect(serve.stderr()).toBe('');
    await expect(client.health()).rejects.toMatchObject({code: 'unreachable'});
    expect(readRecord(storeRoot)).toEqual({
      protocolVersion: 7,
      token: tokenOf(url),
      port: portOf(url),
    });

    // The next run is the same address, with the thread's lease let go.
    const again = runServe(['--store', storeRoot]);

    expect(await again.url).toBe(url);
    await awaitCharacterReady(client, 'mira');
    await chat(client, 'again');
    await expect(again.stop()).resolves.toBe(0);
  });

  it('keeps the home on its port, and when another program holds it, takes a free one and says so', async () => {
    const storeRoot = await createGatewayTestHome('project02-serve-port-');
    const first = runServe(['--store', storeRoot]);
    const port = portOf(await first.url);

    await expect(first.stop()).resolves.toBe(0);

    const blocker = await occupy(port);
    const moved = runServe(['--store', storeRoot]);
    const movedUrl = await moved.url;

    expect(portOf(movedUrl)).not.toBe(port);
    expect(
      moved
        .stdout()
        .indexOf(
          `Port ${String(port)} was taken by another program; the address has changed.`,
        ),
    ).toBe(0);
    expect(readRecord(storeRoot).port).toBe(portOf(movedUrl));
    await expect(moved.stop()).resolves.toBe(0);
    await free(blocker);

    // The new port is the home's now; the old one is not asked for again.
    const settled = runServe(['--store', storeRoot]);

    expect(await settled.url).toBe(movedUrl);
    expect(settled.stdout().startsWith('PROJECT02_GATEWAY=')).toBe(true);
    await expect(settled.stop()).resolves.toBe(0);
  });

  it('replaces a record it cannot read, with a fresh token, and says so', async () => {
    const storeRoot = await createGatewayTestHome('project02-serve-record-');

    writeFileSync(join(storeRoot, 'daemon.json'), '{not a record');

    const serve = runServe(['--store', storeRoot]);
    const url = await serve.url;

    expect(serve.stderr()).toContain('daemon.json');
    expect(serve.stderr()).toContain('replaced');
    expect(readRecord(storeRoot)).toMatchObject({
      token: tokenOf(url),
      port: portOf(url),
    });
    await expect(serve.stop()).resolves.toBe(0);
  });

  it('names a character package that failed discovery, and serves the rest', async () => {
    const storeRoot = await createGatewayTestHome('project02-serve-broken-');
    const packageRoot = join(storeRoot, 'characters', 'broken');

    mkdirSync(packageRoot, {recursive: true});
    writeFileSync(join(packageRoot, 'project02.character.json'), '{not json');

    const serve = runServe(['--store', storeRoot]);
    const client = createGatewayClient({url: await serve.url});

    expect(serve.stderr()).toContain('Character package ');
    expect(serve.stderr()).toContain('broken');
    expect(serve.stderr()).toContain('invalid_descriptor');
    await awaitCharacterReady(client, 'mira');
    await expect(client.health()).resolves.toMatchObject({
      characters: [{id: 'mira', state: 'ready'}],
    });
    await expect(serve.stop()).resolves.toBe(0);
  });

  it('creates the store only with --init', async () => {
    const storeRoot = createTestTempRoot('project02-serve-init-');
    const serve = runServe(['--store', storeRoot, '--init']);

    await serve.url;
    expect(readdirSync(storeRoot)).toContain('schema.json');
    await expect(serve.stop()).resolves.toBe(0);
  });

  it('prints the address even when stopped before the roster came up, and leaves the record saying it is not running', async () => {
    const storeRoot = await createGatewayTestHome('project02-serve-stopped-');
    const serve = runServe(['--store', storeRoot], {
      signal: AbortSignal.abort(),
    });

    await expect(serve.exit).resolves.toBe(0);
    expect(serve.stdout()).toContain('PROJECT02_GATEWAY=');
    expect(readRecord(storeRoot).running).toBeUndefined();
  });

  it('finishes a turn in flight when stopped, and says so', async () => {
    const storeRoot = await createGatewayTestHome('project02-serve-drain-');
    const serve = runServe(['--store', storeRoot], {
      adapter: createScriptedAdapter({
        homeRoot: storeRoot,
        characterId: 'mira',
      }),
    });
    const client = createGatewayClient({url: await serve.url});

    await awaitCharacterReady(client, 'mira');

    // Stopped mid-reply: the reply is finished first.
    const {turn} = await startSlowTurn(client);
    const stopped = serve.stop();

    await expect(turn).resolves.toMatchObject({status: 'completed'});
    await expect(stopped).resolves.toBe(0);
    expect(serve.stdout()).toContain('Stopping; finishing what is in flight.');
    expect(readRecord(storeRoot).running).toBeUndefined();
  });

  it("hands a second run the daemon's address and exits, and lets a later run start once the first has stopped", async () => {
    const storeRoot = await createGatewayTestHome('project02-serve-second-');
    const first = runServe(['--store', storeRoot]);
    const url = await first.url;
    const second = runServe(['--store', storeRoot]);

    await expect(second.exit).resolves.toBe(0);
    expect(second.stdout()).toBe(
      `Already running on this home (pid ${String(process.pid)}).\nPROJECT02_GATEWAY=${url}\n`,
    );
    expect(second.stderr()).toBe('');
    // The first is untouched.
    await expect(createGatewayClient({url}).health()).resolves.toMatchObject({
      protocolVersion: 7,
    });
    await expect(first.stop()).resolves.toBe(0);

    const third = runServe(['--store', storeRoot]);

    expect(await third.url).toBe(url);
    await expect(third.stop()).resolves.toBe(0);
  });

  it('waits for a daemon that is stopping, then takes the home over on the same address', async () => {
    const storeRoot = await createGatewayTestHome('project02-serve-takeover-');
    const first = runServe(['--store', storeRoot], {
      adapter: createScriptedAdapter({
        homeRoot: storeRoot,
        characterId: 'mira',
      }),
    });
    const url = await first.url;
    const client = createGatewayClient({url});

    await awaitCharacterReady(client, 'mira');

    const {turn} = await startSlowTurn(client);
    const stopping = first.stop();
    const second = runServe(['--store', storeRoot]);

    expect(await second.url).toBe(url);
    expect(second.stderr()).toContain(
      'holds this home but is stopping; waiting for it',
    );
    await expect(turn).resolves.toMatchObject({status: 'completed'});
    await expect(stopping).resolves.toBe(0);
    await expect(second.stop()).resolves.toBe(0);
  }, 20_000);

  it('keeps trying a holder that does not answer — taking the home when its lease goes, saying so when the wait is up, and stopping at once when asked', async () => {
    const storeRoot = await createGatewayTestHome('project02-serve-silent-');
    const gone = await occupy(0);
    const port = (gone.address() as AddressInfo).port;

    await free(gone);

    // Held, with a record naming a port nobody listens on: the holder's
    // socket has gone before its lease, which is what a stop looks like
    // from outside.
    writeDaemonRecord({
      homeRoot: storeRoot,
      record: {
        protocolVersion: 7,
        token: 'stale-token',
        port,
        running: {pid: 1, startedAt: '2026-01-01T00:00:00.000Z'},
      },
    });

    const lease = await acquireLocalRuntimeDaemonLease({homeRoot: storeRoot});
    const patient = runServe(['--store', storeRoot]);

    await vi.waitFor(() => {
      expect(patient.stderr()).toContain(
        `did not answer at http://127.0.0.1:${String(port)}/`,
      );
    });
    expect(patient.stderr()).toContain('waiting for it');
    await lease.release();
    // The lease went: this run is the daemon, on the home's token and port.
    expect(await patient.url).toBe(
      `http://127.0.0.1:${String(port)}/#token=stale-token`,
    );
    await expect(patient.stop()).resolves.toBe(0);

    // Held with no address yet, for longer than the wait allows.
    const held = await acquireLocalRuntimeDaemonLease({homeRoot: storeRoot});

    try {
      const expired = runServe(['--store', storeRoot], {holdWaitMs: 700});

      await expect(expired.exit).resolves.toBe(1);
      expect(expired.stderr()).toContain(
        'run this again once it has started or stopped',
      );
      expect(expired.stdout()).toBe('');

      // Asked to stop while waiting: at once, and quietly — even when the
      // holder lets go in that same moment, the home is not taken on the
      // way out.
      const abort = new AbortController();
      const cancelled = runServe(['--store', storeRoot], {
        signal: abort.signal,
      });
      const started = performance.now();

      await vi.waitFor(() => {
        expect(cancelled.stderr()).toContain('waiting for it');
      });
      abort.abort();
      await held.release();
      await expect(cancelled.exit).resolves.toBe(1);
      expect(performance.now() - started).toBeLessThan(3_000);
      expect(cancelled.stdout()).toBe('');
    } finally {
      await held.release();
    }
  }, 20_000);

  it('leaves nothing behind when it cannot record where it listens', async () => {
    const storeRoot = await createGatewayTestHome('project02-serve-readonly-');

    // The home refuses the record, while its lock directory still takes
    // the lease: the failure comes after the claim.
    chmodSync(storeRoot, 0o500);

    try {
      const unwritable = runServe(['--store', storeRoot]);

      await expect(unwritable.exit).resolves.toBe(1);
      expect(unwritable.stderr()).toContain(
        'Error: Local runtime store could not be written.',
      );
      expect(unwritable.stdout()).toBe('');
    } finally {
      chmodSync(storeRoot, 0o755);
    }

    expect(existsSync(join(storeRoot, 'daemon.json'))).toBe(false);

    // The home was let go: the next run is the daemon.
    const next = runServe(['--store', storeRoot]);

    await next.url;
    await expect(next.stop()).resolves.toBe(0);
  });

  it('refuses the options a client owns', async () => {
    for (const [args, message] of [
      [['--help'], 'Unknown serve option: --help.'],
      [['--character', 'mira'], 'Unknown serve option: --character.'],
    ] as const) {
      const serve = runServe([...args]);

      await expect(serve.exit).resolves.toBe(1);
      expect(serve.stderr()).toContain(message);
    }
  });
});
