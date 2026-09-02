import {chmodSync} from 'node:fs';
import {join} from 'node:path';
import {PassThrough, Readable} from 'node:stream';

import {describe, expect, it, vi} from 'vitest';

import {runChatCliFromArgs} from '../../src/cli/chat/main.ts';
import {createGateway} from '../../src/gateway/index.ts';
import {createRuntimePluginHost} from '../../src/plugins/index.ts';
import type {RoleModelAdapter} from '../../src/role-model/index.ts';
import {characterDataDirPath} from '../../src/runtime/storage/index.ts';
import {writeTestCharacterPackage} from '../support/character-fixtures.ts';
import {createGatewayTestHome} from '../support/gateway-fixtures.ts';
import {
  startTestGatewayServer,
  testGatewayToken,
} from '../support/gateway-http.ts';
import {collect} from '../support/streams.ts';

function replyAdapter(rawOutputText?: string): RoleModelAdapter {
  return {
    invoke() {
      return {
        rawOutputText:
          rawOutputText ??
          JSON.stringify({
            toolCalls: [{name: 'visible_reply', input: {text: 'noted'}}],
          }),
      };
    },
  };
}

/** A daemon the way serve runs it: the roster up before any client comes. */
async function startDaemon(
  adapter: RoleModelAdapter = replyAdapter(),
  arrange: (storeRoot: string) => void = () => undefined,
) {
  const storeRoot = await createGatewayTestHome('project02-chat-shim-');

  arrange(storeRoot);

  const gateway = createGateway({
    location: {storeRoot},
    env: {},
    roleModelAdapter: adapter,
    createPluginHost: () => createRuntimePluginHost({plugins: []}),
  });

  await gateway.reconcile();

  const server = await startTestGatewayServer({gateway});

  return {
    storeRoot,
    gateway,
    env: {PROJECT02_GATEWAY: `${server.baseUrl}/#token=${testGatewayToken}`},
    close: async () => {
      await server.close();
      await gateway.stop();
    },
  };
}

async function runChat(
  args: readonly string[],
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly input?: string | NodeJS.ReadableStream;
    readonly onStdout?: (stdout: string) => void;
  },
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  let stdout = '';
  let stderr = '';
  const {input} = options;

  const exitCode = await runChatCliFromArgs(args, {
    stdin:
      typeof input === 'string' || input === undefined
        ? Readable.from([input ?? 'hello there\n/exit\n'])
        : input,
    stdout: collect(chunk => {
      stdout += chunk;
      options.onStdout?.(stdout);
    }),
    stderr: collect(chunk => {
      stderr += chunk;
    }),
    env: options.env,
  });

  return {exitCode, stdout, stderr};
}

describe('chat shim', () => {
  it('chats over the socket, showing what other surfaces say, and exits cleanly', async () => {
    const daemon = await startDaemon();
    const stdin = new PassThrough();
    let seen = '';
    const run = runChat([], {
      env: daemon.env,
      input: stdin,
      onStdout: stdout => {
        seen = stdout;
      },
    });

    await vi.waitFor(() => {
      expect(seen).toContain('mira is ready.');
    });
    stdin.write('hello there\n');
    await vi.waitFor(() => {
      expect(seen).toContain('Mira: noted');
    });

    // Another surface's message rides the same stream into this terminal.
    const opened = await daemon.gateway.openDirectConversation('mira');

    if (opened.status !== 'opened') {
      expect.fail(opened.message);
    }

    await daemon.gateway.deliver({
      conversationId: opened.conversationId,
      senderId: opened.userParticipantId,
      text: 'typed on the web',
      source: 'web',
      clientMessageId: 'web-1',
    });
    await vi.waitFor(() => {
      expect(seen).toContain(': typed on the web');
    });
    stdin.write('/exit\n');

    const {exitCode, stderr} = await run;

    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    await daemon.close();
  });

  it('demands an explicit pick when several characters are enabled, then honors it', async () => {
    const daemon = await startDaemon(replyAdapter(), storeRoot => {
      writeTestCharacterPackage(storeRoot, {id: 'zeta', displayName: 'Zeta'});
    });
    const ambiguous = await runChat([], {env: daemon.env});

    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.stderr).toContain(
      'Several characters are enabled: mira, zeta.',
    );
    expect(ambiguous.stderr).toContain('--character');

    const picked = await runChat(['--character', 'zeta'], {env: daemon.env});

    expect(picked.stderr).toBe('');
    expect(picked.exitCode).toBe(0);
    expect(picked.stdout).toContain('Zeta: noted');
    await daemon.close();
  });

  it('refuses a run without the daemon address, a repeated pick, or an unknown character', async () => {
    const daemon = await startDaemon();
    const unaddressed = await runChat([], {env: {}});

    expect(unaddressed.exitCode).toBe(1);
    expect(unaddressed.stderr).toContain('PROJECT02_GATEWAY is not set');

    const repeated = await runChat(
      ['--character', 'mira', '--character', 'mira'],
      {env: daemon.env},
    );

    expect(repeated.exitCode).toBe(1);
    expect(repeated.stderr).toContain('--character can only be provided once');

    const unknown = await runChat(['--character', 'ghost'], {env: daemon.env});

    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain('ghost');
    expect(unknown.stderr).toContain('mira');
    await daemon.close();
  });

  it('exits nonzero when a turn dies fatally', async () => {
    let sessionsRoot = '';
    const daemon = await startDaemon(
      {
        invoke() {
          // Break the session store mid-turn so the commit fails.
          chmodSync(sessionsRoot, 0o000);

          return {
            rawOutputText: JSON.stringify({
              toolCalls: [{name: 'visible_reply', input: {text: 'noted'}}],
            }),
          };
        },
      },
      storeRoot => {
        sessionsRoot = join(
          characterDataDirPath(storeRoot, 'mira'),
          'sessions',
        );
      },
    );

    try {
      const {exitCode, stderr} = await runChat([], {env: daemon.env});

      expect(exitCode).toBe(1);
      expect(stderr).toContain('Error:');
    } finally {
      chmodSync(sessionsRoot, 0o755);
      await daemon.close();
    }
  });

  it('reports a rejected turn and keeps the session alive', async () => {
    const daemon = await startDaemon(replyAdapter('not json at all'));
    const {exitCode, stdout, stderr} = await runChat([], {env: daemon.env});

    expect(exitCode).toBe(0);
    expect(stdout).toContain('mira is ready.');
    expect(stderr).toContain('Error:');
    await daemon.close();
  });
});
