import {randomUUID} from 'node:crypto';
import {chmodSync} from 'node:fs';
import {join} from 'node:path';
import {PassThrough, Readable} from 'node:stream';

import {describe, expect, it, vi} from 'vitest';

import {runChatCliFromArgs} from '../../src/cli/chat/main.ts';
import {createGateway, type Gateway} from '../../src/gateway/index.ts';
import {createRuntimePluginHost} from '../../src/plugins/index.ts';
import type {RoleModelAdapter} from '../../src/role-model/index.ts';
import {characterDataDirPath} from '../../src/runtime/storage/index.ts';
import {writeTestCharacterPackage} from '../support/character-fixtures.ts';
import {
  authoredTone,
  createConfirmationHome,
  createGatewayTestHome,
} from '../support/gateway-fixtures.ts';
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

  return serveDaemon(gateway, storeRoot);
}

async function serveDaemon(gateway: Gateway, storeRoot = '') {
  const server = await startTestGatewayServer({gateway});

  return {
    storeRoot,
    gateway,
    server,
    env: {PROJECT02_GATEWAY: `${server.baseUrl}/#token=${testGatewayToken}`},
    close: async () => {
      await server.close();
      await gateway.stop();
    },
  };
}

/** A shim on a live stdin, with a view of everything it printed so far. */
function openShim(args: readonly string[], env: NodeJS.ProcessEnv) {
  const stdin = new PassThrough();
  let seen = '';
  const run = runChat(args, {
    env,
    input: stdin,
    onStdout: stdout => {
      seen = stdout;
    },
  });
  const printed = (text: string) =>
    vi.waitFor(
      () => {
        expect(seen).toContain(text);
      },
      {timeout: 10_000},
    );

  return {
    stdin,
    run,
    printed,
    seen: () => seen,
    async exit() {
      stdin.write('/exit\n');

      return run;
    },
  };
}

async function deliverFromWeb(
  gateway: Gateway,
  characterId: string,
  text: string,
) {
  const opened = await gateway.openDirectConversation(characterId);

  if (opened.status !== 'opened') {
    expect.fail(opened.message);
  }

  return {
    conversationId: opened.conversationId,
    outcome: gateway.deliver({
      conversationId: opened.conversationId,
      senderId: opened.userParticipantId,
      text,
      source: 'web',
      clientMessageId: randomUUID(),
    }),
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
  it('answers a confirmation raised elsewhere with the next line, which never becomes a message', async () => {
    const home = await createConfirmationHome();
    const daemon = await serveDaemon(home.gateway);
    const shim = openShim([], daemon.env);

    await shim.printed('mira is ready.');
    // The REPL is waiting at its prompt when the web asks for a tool change.
    await shim.printed('> ');

    const web = await deliverFromWeb(home.gateway, 'mira', 'please be warmer');

    await shim.printed('[y/N] ');
    shim.stdin.write('yes\n');
    await expect(web.outcome).resolves.toMatchObject({status: 'completed'});
    expect(authoredTone(home.inspectTone())).toBe('warm');
    await shim.printed('Mira: done');
    // The interrupted REPL gets its prompt back once the [y/N] is gone.
    await vi.waitFor(() => {
      expect(shim.seen().match(/> /gu)).toHaveLength(2);
    });
    await expect(shim.exit()).resolves.toMatchObject({exitCode: 0});

    // One turn on the thread: the web's. "yes" answered, it was never sent.
    const history = await home.gateway.history(web.conversationId);

    expect(
      history.status === 'ok' && history.messages.map(message => message.text),
    ).toEqual(['please be warmer', 'done']);
    await daemon.close();
  });

  it("leaves another character's confirmation to the terminal that talks to it", async () => {
    const home = await createConfirmationHome('done', 'zeta');
    const daemon = await serveDaemon(home.gateway);
    const shim = openShim(['--character', 'mira'], daemon.env);

    await shim.printed('mira is ready.');

    const web = await deliverFromWeb(home.gateway, 'zeta', 'please be warmer');

    await vi.waitFor(
      () => {
        expect(home.gateway.pendingConfirmations()).toHaveLength(1);
      },
      {timeout: 10_000},
    );
    // Time for a prompt to have appeared, had the shim taken it.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(shim.seen()).not.toContain('Confirm');

    const [pending] = home.gateway.pendingConfirmations();

    expect(pending).toMatchObject({characterId: 'zeta'});
    expect(
      home.gateway.answerConfirmation(pending?.id ?? '', 'denied'),
    ).toEqual({
      status: 'answered',
    });
    await expect(web.outcome).resolves.toMatchObject({status: 'completed'});
    await expect(shim.exit()).resolves.toMatchObject({exitCode: 0, stderr: ''});
    await daemon.close();
  });

  it('catches up on what the stream missed once it is back', async () => {
    const daemon = await startDaemon();
    const shim = openShim([], daemon.env);

    await shim.printed('mira is ready.');
    await vi.waitFor(() => {
      expect(daemon.server.events.openCount()).toBe(1);
    });

    // The daemon ends every stream; a message lands before the shim is back.
    daemon.server.events.closeAll();

    const web = await deliverFromWeb(
      daemon.gateway,
      'mira',
      'while you were away',
    );

    await expect(web.outcome).resolves.toMatchObject({status: 'completed'});
    await shim.printed('You: while you were away');
    await shim.printed('Mira: noted');
    expect(shim.seen().match(/Mira: noted/gu)).toHaveLength(1);
    await expect(shim.exit()).resolves.toMatchObject({exitCode: 0});
    await daemon.close();
  });
  it.each([
    ['while it was watching', false],
    ['while its stream was down', true],
  ])(
    "reattaches its thread after another surface's turn killed it %s",
    async (_when, streamDown) => {
      let sessionsRoot = '';
      let breakNextTurn = false;
      const daemon = await startDaemon(
        {
          invoke() {
            if (breakNextTurn) {
              breakNextTurn = false;
              // Break the session store mid-turn so the commit fails.
              chmodSync(sessionsRoot, 0o000);
            }

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
      // The store is mended the moment the failure lands, before recovery.
      const stopMending = daemon.gateway.events(event => {
        if (event.kind === 'state_changed' && event.state === 'failed') {
          chmodSync(sessionsRoot, 0o755);
        }
      });

      try {
        const shim = openShim([], daemon.env);

        await shim.printed('mira is ready.');
        await vi.waitFor(() => {
          expect(daemon.server.events.openCount()).toBe(1);
        });

        if (streamDown) {
          // The whole episode happens before the shim is back.
          daemon.server.events.closeAll();
        }

        breakNextTurn = true;

        const web = await deliverFromWeb(daemon.gateway, 'mira', 'boom');

        await expect(web.outcome).resolves.toMatchObject({status: 'failed'});
        await vi.waitFor(() => {
          expect(daemon.gateway.health().characters[0]?.state).toBe('ready');
        });

        if (streamDown) {
          // Nothing announced: the episode passed unseen, and the handshake
          // reopened the thread on its own.
          await vi.waitFor(
            () => {
              expect(daemon.server.events.openCount()).toBe(1);
            },
            {timeout: 10_000},
          );
        } else {
          await shim.printed('mira is back.');
        }

        shim.stdin.write('hello again\n');
        await shim.printed('Mira: noted');

        const {exitCode} = await shim.exit();

        expect(exitCode).toBe(0);
      } finally {
        stopMending();
        chmodSync(sessionsRoot, 0o755);
        await daemon.close();
      }
    },
    20_000,
  );
});
