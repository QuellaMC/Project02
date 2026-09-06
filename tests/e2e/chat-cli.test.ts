import {chmodSync} from 'node:fs';
import {join} from 'node:path';
import {PassThrough, Readable} from 'node:stream';

import {describe, expect, it, vi} from 'vitest';

import {runChatCliFromArgs} from '../../src/cli/chat/main.ts';
import {createGateway, type Gateway} from '../../src/gateway/index.ts';
import {createRuntimePluginHost} from '../../src/plugins/index.ts';
import type {RoleModelAdapter} from '../../src/role-model/index.ts';
import {
  acquireLocalRuntimeSessionWriterLease,
  characterDataDirPath,
} from '../../src/runtime/storage/index.ts';
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
import {writeRuntimeConfig} from '../support/runtime-config.ts';
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

async function runChat(
  args: readonly string[],
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly input?: string | NodeJS.ReadableStream;
    readonly onStdout?: (stdout: string) => void;
    readonly onStderr?: (stderr: string) => void;
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
      options.onStderr?.(stderr);
    }),
    env: options.env,
  });

  return {exitCode, stdout, stderr};
}

/** A shim on a live stdin, with a view of everything it printed so far. */
function openShim(args: readonly string[], env: NodeJS.ProcessEnv) {
  const stdin = new PassThrough();
  let seen = '';
  let errors = '';
  const run = runChat(args, {
    env,
    input: stdin,
    onStdout: stdout => {
      seen = stdout;
    },
    onStderr: stderr => {
      errors = stderr;
    },
  });
  const printed = (text: string) =>
    vi.waitFor(
      () => {
        expect(seen, `stderr so far:\n${errors}`).toContain(text);
      },
      {timeout: 10_000},
    );

  return {
    stdin,
    run,
    printed,
    seen: () => seen,
    errors: () => errors,
    async exit() {
      stdin.write('/exit\n');

      return run;
    },
  };
}

/** The DM's id, from an open that sends nothing. */
async function conversationOf(gateway: Gateway): Promise<string> {
  const opened = await gateway.openDirectConversation('mira');

  if (opened.status !== 'opened') {
    expect.fail(opened.message);
  }

  return opened.conversationId;
}

async function deliverFromWeb(
  gateway: Gateway,
  characterId: string,
  text: string,
  clientMessageId = `web-${text.replaceAll(/[^A-Za-z0-9]/gu, '-')}`,
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
      clientMessageId,
    }),
  };
}

describe('chat shim', () => {
  it('chats over the socket, showing what other surfaces say, and exits cleanly', async () => {
    const daemon = await startDaemon();
    const shim = openShim([], daemon.env);

    await shim.printed('mira is ready.');
    // Ready means the stream is listening: no line can run ahead of it.
    expect(daemon.server.events.openCount()).toBe(1);
    shim.stdin.write('hello there\n');
    await shim.printed('Mira: noted');

    // Another surface's message rides the same stream into this terminal.
    const web = await deliverFromWeb(
      daemon.gateway,
      'mira',
      'typed on the web',
    );

    await expect(web.outcome).resolves.toMatchObject({status: 'completed'});
    await shim.printed(': typed on the web');

    const {exitCode, stderr} = await shim.exit();

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

  it('keeps chatting through a fatal turn: the daemon recovers and holds the thread again', async () => {
    let sessionsRoot = '';
    let breakNextTurn = true;
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
      shim.stdin.write('boom\n');
      await vi.waitFor(() => {
        expect(shim.errors()).toContain('Error:');
      });
      await vi.waitFor(() => {
        expect(daemon.gateway.health().characters[0]?.state).toBe('ready');
      });

      // Nothing to reattach: the next line lands on the recovered character.
      shim.stdin.write('hello again\n');
      await shim.printed('Mira: noted');
      await expect(shim.exit()).resolves.toMatchObject({exitCode: 0});
    } finally {
      stopMending();
      chmodSync(sessionsRoot, 0o755);
      await daemon.close();
    }
  }, 20_000);

  it("reports a rejected turn once, and another surface's rejected turn from the stream", async () => {
    const daemon = await startDaemon(replyAdapter('not json at all'));
    const shim = openShim([], daemon.env);

    await shim.printed('mira is ready.');
    shim.stdin.write('hello there\n');
    await vi.waitFor(() => {
      expect(shim.errors()).toContain('Error:');
    });
    await vi.waitFor(() => {
      expect(shim.seen().match(/> /gu)).toHaveLength(2);
    });
    expect(shim.errors().match(/^Error:/gmu)).toHaveLength(1);
    expect(shim.errors()).not.toContain('Warning');

    const web = await deliverFromWeb(daemon.gateway, 'mira', 'from the web');

    await expect(web.outcome).resolves.toMatchObject({status: 'rejected'});
    await vi.waitFor(() => {
      expect(shim.errors()).toContain(
        'Warning: a turn on this thread was rejected',
      );
    });
    await expect(shim.exit()).resolves.toMatchObject({exitCode: 0});
    await daemon.close();
  });

  it("answers its own turn's confirmation with a line typed after the prompt, never one typed before", async () => {
    const home = await createConfirmationHome();
    const daemon = await serveDaemon(home.gateway);
    const shim = openShim([], daemon.env);

    await shim.printed('mira is ready.');
    // The turn asks for a tool change; a line typed before the prompt
    // appears stays a chat line.
    shim.stdin.write('please be warmer\n');
    await vi.waitFor(
      () => {
        expect(home.gateway.pendingConfirmations()).toHaveLength(1);
      },
      {timeout: 10_000},
    );
    shim.stdin.write('and one more thing\n');
    await shim.printed('[y/N] ');
    shim.stdin.write('yes\n');
    await shim.printed('Mira: done');
    expect(authoredTone(home.inspectTone())).toBe('warm');

    // The line typed under no prompt was a chat line, sent after the turn.
    await shim.printed('> ');
    await vi.waitFor(
      async () => {
        const history = await home.gateway.history(
          await conversationOf(home.gateway),
        );

        expect(
          history.status === 'ok' &&
            history.messages.map(message => message.text),
        ).toContain('and one more thing');
      },
      {timeout: 10_000},
    );
    await expect(shim.exit()).resolves.toMatchObject({exitCode: 0});
    await daemon.close();
  });

  it("leaves another surface's confirmation to the surface that sent the turn", async () => {
    const home = await createConfirmationHome();
    const daemon = await serveDaemon(home.gateway);
    const shim = openShim([], daemon.env);

    await shim.printed('mira is ready.');

    const web = await deliverFromWeb(home.gateway, 'mira', 'please be warmer');

    await vi.waitFor(
      () => {
        expect(home.gateway.pendingConfirmations()).toHaveLength(1);
      },
      {timeout: 10_000},
    );
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(shim.seen()).not.toContain('Confirm');

    const [pending] = home.gateway.pendingConfirmations();

    expect(pending?.turn).toMatchObject({source: 'web'});
    expect(
      home.gateway.answerConfirmation(pending?.id ?? '', 'denied'),
    ).toEqual({
      status: 'answered',
    });
    await expect(web.outcome).resolves.toMatchObject({status: 'completed'});
    await expect(shim.exit()).resolves.toMatchObject({exitCode: 0, stderr: ''});
    await daemon.close();
  });

  it('catches up on what the stream missed once it is back, and reports a maintenance failure from the snapshot', async () => {
    // A window this small rotates after a few turns.
    const daemon = await startDaemon(replyAdapter(), storeRoot => {
      writeRuntimeConfig(join(storeRoot, 'config.json'), {
        project02: {contextWindowTokens: 100},
      });
    });
    const shim = openShim([], daemon.env);

    await shim.printed('mira is ready.');

    const first = await deliverFromWeb(daemon.gateway, 'mira', 'one');

    await expect(first.outcome).resolves.toMatchObject({status: 'completed'});
    await shim.printed('You: one');

    // Hold the next segment's writer lease from outside, so the rotation
    // fails after planning — while this terminal's stream is down.
    const blocker = await acquireLocalRuntimeSessionWriterLease({
      storeRoot: characterDataDirPath(daemon.storeRoot, 'mira'),
      sessionId: `${first.conversationId}.2`,
    });

    try {
      await daemon.server.events.closeAll();

      for (const text of ['two', 'three', 'four']) {
        const turn = await deliverFromWeb(daemon.gateway, 'mira', text);

        await expect(turn.outcome).resolves.toMatchObject({
          status: 'completed',
        });
      }

      const failure = daemon.gateway.health().characters[0]?.maintenance;

      expect(failure).toBeDefined();
      await shim.printed('You: four');
      await vi.waitFor(
        () => {
          expect(shim.errors()).toContain(`Warning: ${failure?.message ?? ''}`);
        },
        {timeout: 10_000},
      );
      expect(shim.errors().match(/Warning:/gu)).toHaveLength(1);
      expect(shim.seen().match(/Mira: noted/gu)).toHaveLength(4);
      await expect(shim.exit()).resolves.toMatchObject({exitCode: 0});
    } finally {
      await blocker.release();
      await daemon.close();
    }
  }, 20_000);

  it('waits for a daemon that cannot be reached and sends the line again once it is back', async () => {
    const daemon = await startDaemon();
    const shim = openShim([], daemon.env);

    await shim.printed('mira is ready.');

    // The daemon's socket goes away with a line in flight: the line is
    // kept for the next handshake, and the prompt comes back at once.
    await daemon.server.close();
    shim.stdin.write('did this land?\n');
    await vi.waitFor(() => {
      expect(shim.errors()).toContain('could not take your line');
    });
    await vi.waitFor(() => {
      expect(shim.seen().match(/> /gu)).toHaveLength(2);
    });

    // It comes back on the same address: the line goes again, once.
    const returned = await startTestGatewayServer({
      gateway: daemon.gateway,
      port: daemon.server.port,
    });

    try {
      await shim.printed('Mira: noted');

      const history = await daemon.gateway.history(
        await conversationOf(daemon.gateway),
      );

      expect(
        history.status === 'ok' &&
          history.messages.filter(message => message.text === 'did this land?'),
      ).toHaveLength(1);
      await expect(shim.exit()).resolves.toMatchObject({exitCode: 0});
    } finally {
      await returned.close();
      await daemon.gateway.stop();
    }
  }, 20_000);

  it('keeps a line refused by a stopping daemon for its next handshake', async () => {
    const daemon = await startDaemon();
    const shim = openShim([], daemon.env);

    await shim.printed('mira is ready.');
    daemon.server.lifecycle.stopping = true;
    shim.stdin.write('too late\n');
    await vi.waitFor(() => {
      expect(shim.errors()).toContain('could not take your line');
    });
    daemon.server.lifecycle.stopping = false;

    // No handshake came: the line was never sent.
    await expect(shim.exit()).resolves.toMatchObject({exitCode: 0});

    const history = await daemon.gateway.history(
      await conversationOf(daemon.gateway),
    );

    expect(
      history.status === 'ok' && history.messages.map(message => message.text),
    ).not.toContain('too late');
    await daemon.close();
  });

  it('ends, nonzero, when its stream can never come back', async () => {
    const daemon = await startDaemon();
    const shim = openShim([], daemon.env);

    await shim.printed('mira is ready.');
    await daemon.server.close();

    // The daemon comes back as another run, with another token: this
    // terminal's stream is refused for good.
    const returned = await startTestGatewayServer({
      gateway: daemon.gateway,
      port: daemon.server.port,
      token: 'another-run-0123456789abcdef',
    });

    try {
      const {exitCode, stderr} = await shim.run;

      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/^Error: .*token/mu);
    } finally {
      await returned.close();
      await daemon.gateway.stop();
    }
  }, 20_000);

  it('opens on the recent tail of the thread, so a reply to a terminal that is gone is not lost', async () => {
    const daemon = await startDaemon();
    const earlier = await deliverFromWeb(daemon.gateway, 'mira', 'from before');

    await expect(earlier.outcome).resolves.toMatchObject({status: 'completed'});

    const {exitCode, stdout} = await runChat([], {env: daemon.env});

    expect(exitCode).toBe(0);
    expect(stdout.indexOf('You: from before')).toBeLessThan(
      stdout.indexOf('mira is ready.'),
    );
    expect(stdout.indexOf('Mira: noted')).toBeLessThan(
      stdout.indexOf('mira is ready.'),
    );
    await daemon.close();
  });
});
