import {readdirSync} from 'node:fs';
import {Readable} from 'node:stream';

import {describe, expect, it} from 'vitest';

import {runServeCliFromArgs} from '../../src/cli/serve/main.ts';
import {createGatewayClient} from '../../src/gateway/client/index.ts';
import {createGateway} from '../../src/gateway/index.ts';
import {createRuntimePluginHost} from '../../src/plugins/index.ts';
import type {RoleModelAdapter} from '../../src/role-model/index.ts';
import {createGatewayTestHome} from '../support/gateway-fixtures.ts';
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
function runServe(args: readonly string[]) {
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
    env: {},
    pluginHost: createRuntimePluginHost({plugins: []}),
    roleModelAdapter: adapter,
    signal: abort.signal,
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

describe('serve', () => {
  it('announces the socket, brings the roster up, then prints the line a client reads', async () => {
    const storeRoot = await createGatewayTestHome('project02-serve-');
    const serve = runServe(['--store', storeRoot]);
    const url = await serve.url;
    const client = createGatewayClient({url});

    // The URL line is the last thing printed, and only once mira is ready.
    expect(
      serve.stdout().indexOf('Gateway listening on http://127.0.0.1:'),
    ).toBe(0);
    expect(url.startsWith('http://127.0.0.1:')).toBe(true);
    expect(url).toContain('/#token=');
    await expect(client.health()).resolves.toMatchObject({
      characters: [{id: 'mira', state: 'ready'}],
    });

    const opened = await client.openDirectConversation('mira');

    if (opened.status !== 'opened') {
      expect.fail(opened.message);
    }

    await expect(
      client.deliver({
        conversationId: opened.conversationId,
        senderId: opened.userParticipantId,
        text: 'hello',
        source: 'web',
        clientMessageId: 'msg-1',
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      messages: [
        {speakerName: 'You', text: 'hello'},
        {speakerName: 'Mira', text: 'served'},
      ],
    });

    await expect(serve.stop()).resolves.toBe(0);
    expect(serve.stderr()).toBe('');
    await expect(client.health()).rejects.toMatchObject({code: 'unreachable'});

    // A clean stop released the leases: a fresh gateway takes the DM over.
    const fresh = createGateway({
      location: {storeRoot},
      env: {},
      roleModelAdapter: adapter,
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });

    await fresh.startCharacter('mira');
    await expect(fresh.openDirectConversation('mira')).resolves.toMatchObject({
      status: 'opened',
      conversationId: opened.conversationId,
    });
    await fresh.stop();
  });

  it('creates the store only with --init', async () => {
    const storeRoot = createTestTempRoot('project02-serve-init-');
    const serve = runServe(['--store', storeRoot, '--init']);

    await serve.url;
    expect(readdirSync(storeRoot)).toContain('schema.json');
    await expect(serve.stop()).resolves.toBe(0);
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
