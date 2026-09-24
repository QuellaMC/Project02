import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {createServer, type Server} from 'node:net';
import {join} from 'node:path';
import {Readable} from 'node:stream';

import {describe, expect, it} from 'vitest';

import {runServeCliFromArgs} from '../../src/cli/serve/main.ts';
import {
  createGatewayClient,
  type GatewayClient,
} from '../../src/gateway/client/index.ts';
import {createRuntimePluginHost} from '../../src/plugins/index.ts';
import type {RoleModelAdapter} from '../../src/role-model/index.ts';
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
    port: 0,
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
      protocolVersion: 5,
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
      protocolVersion: 5,
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

    const opened = await client.openDirectConversation('mira');

    if (opened.status !== 'opened') {
      expect.fail(opened.message);
    }

    const line = `slowly ${Array.from({length: 80}, (_, word) => `w${String(word)}`).join(' ')}`;
    const turn = client.deliver({
      conversationId: opened.conversationId,
      senderId: opened.userParticipantId,
      text: line,
      source: 'web',
      clientMessageId: 'msg-slow',
    });

    // Stopped mid-reply: the reply is finished first.
    await new Promise<void>(resolve => {
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

    const stopped = serve.stop();

    await expect(turn).resolves.toMatchObject({status: 'completed'});
    await expect(stopped).resolves.toBe(0);
    expect(serve.stdout()).toContain('Stopping; finishing what is in flight.');
    expect(readRecord(storeRoot).running).toBeUndefined();
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
