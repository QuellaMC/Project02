import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createConversationSession } from '../src/core/conversation.ts';
import { createRuntimePluginHost } from '../src/plugins/host.ts';
import {
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent
} from '../src/core/message-event.ts';
import { runLocalUserMessageEvent } from '../src/runtime/local.ts';
import { createFileRuntimeLogStore } from '../src/runtime/storage/file-runtime-log-store.ts';
import {
  LocalRuntimeStorageContractError
} from '../src/runtime/storage/layout.ts';
import { createLocalRuntimeSessionStore } from '../src/runtime/storage/session-store.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    })
  );
});

describe('durable runtime session writer ownership', () => {
  it('rejects a second active writer before it appends evidence', async () => {
    const storeRoot = await createTempStoreRoot();
    const sessionId = 'shared-writer-session';
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-07-11T00:00:00.000Z'
    });
    const logStore = createFileRuntimeLogStore({ storeRoot, sessionId });
    const secondLogStore = createFileRuntimeLogStore({ storeRoot, sessionId });
    const rawEventsPath = logStore.localRuntimeSessionPaths?.rawEventsPath;

    if (rawEventsPath === undefined) {
      throw new Error('Expected durable runtime session paths.');
    }
    const firstSession = createConversationSession({ id: sessionId });
    const secondSession = createConversationSession({ id: sessionId });
    let releaseReply: (() => void) | undefined;
    const replyStarted = new Promise<void>((resolveStarted) => {
      releaseReply = resolveStarted;
    });
    let markReplyStarted: (() => void) | undefined;
    const providerEntered = new Promise<void>((resolveEntered) => {
      markReplyStarted = resolveEntered;
    });
    const firstTurn = runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent('first', createRuntimeEventIdentity()),
      session: firstSession,
      logStore,
      pluginHost: createRuntimePluginHost(),
      agent: {
        async reply() {
          markReplyStarted?.();
          await replyStarted;
          return { text: 'first reply' };
        }
      }
    });

    await providerEntered;
    const rawEventsBeforeSecondWriter = await readFile(rawEventsPath, 'utf8');
    let secondError: unknown;

    try {
      await runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent('second', createRuntimeEventIdentity()),
        session: secondSession,
        logStore: secondLogStore,
        pluginHost: createRuntimePluginHost(),
        agent: { reply: () => ({ text: 'second reply' }) }
      });
    } catch (error: unknown) {
      secondError = error;
    }

    expect(secondError).toBeInstanceOf(LocalRuntimeStorageContractError);
    expect((secondError as LocalRuntimeStorageContractError).code).toBe(
      'session_busy'
    );
    expect(await readFile(rawEventsPath, 'utf8')).toBe(
      rawEventsBeforeSecondWriter
    );

    releaseReply?.();
    await firstTurn;
  });

  it('rejects a stale in-memory transcript before starting a new turn', async () => {
    const storeRoot = await createTempStoreRoot();
    const sessionId = 'stale-writer-session';
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-07-11T00:00:00.000Z'
    });
    const logStore = createFileRuntimeLogStore({ storeRoot, sessionId });
    const currentSession = createConversationSession({ id: sessionId });
    const staleSession = createConversationSession({ id: sessionId });

    await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent('first', createRuntimeEventIdentity()),
      session: currentSession,
      logStore,
      pluginHost: createRuntimePluginHost(),
      agent: { reply: () => ({ text: 'first reply' }) }
    });
    const rawEventCountBeforeStaleWriter = logStore.rawEvents().length;

    await expect(
      runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent('stale', createRuntimeEventIdentity()),
        session: staleSession,
        logStore,
        pluginHost: createRuntimePluginHost(),
        agent: { reply: () => ({ text: 'stale reply' }) }
      })
    ).rejects.toMatchObject({ code: 'stale_session' });
    expect(logStore.rawEvents()).toHaveLength(rawEventCountBeforeStaleWriter);
  });

  it('holds the writer lease for the full interactive chat process', async () => {
    const storeRoot = await createTempStoreRoot();
    const sessionId = 'interactive-writer-session';
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-07-11T00:00:00.000Z'
    });
    const first = spawnChatProcess(storeRoot, sessionId);

    try {
      await waitForOutput(first, 'is ready.');
      const durableFilesBeforeSecondWriter = await snapshotDurableFiles(storeRoot);
      const second = spawnChatProcess(storeRoot, sessionId);
      const secondResult = await collectChildExit(second);

      expect(secondResult.code).toBe(1);
      expect(secondResult.stderr).toContain(
        `Local runtime mutation resource is busy: session-writer:${sessionId}.`
      );
      expect(await snapshotDurableFiles(storeRoot)).toEqual(
        durableFilesBeforeSecondWriter
      );

      first.stdin.write('/exit\n');
      const firstResult = await collectChildExit(first);
      expect(firstResult.code).toBe(0);
    } finally {
      if (first.exitCode === null) {
        first.kill();
      }
    }
  }, 15_000);

  it('runs child writers for different sessions concurrently', async () => {
    const storeRoot = await createTempStoreRoot();
    const sessionIds = ['parallel-writer-alpha', 'parallel-writer-beta'] as const;
    const sessionStore = createLocalRuntimeSessionStore({ storeRoot });

    for (const sessionId of sessionIds) {
      await sessionStore.createSession({
        sessionId,
        createdAt: '2026-07-11T00:00:00.000Z'
      });
    }

    const first = spawnChatProcess(storeRoot, sessionIds[0]);
    const second = spawnChatProcess(storeRoot, sessionIds[1]);

    try {
      await Promise.all([
        waitForOutput(first, 'is ready.'),
        waitForOutput(second, 'is ready.')
      ]);
      first.stdin.write('hello alpha\n');
      second.stdin.write('hello beta\n');
      await Promise.all([
        waitForOutput(first, 'Mira:'),
        waitForOutput(second, 'Mira:')
      ]);
      first.stdin.write('/exit\n');
      second.stdin.write('/exit\n');
      const [firstResult, secondResult] = await Promise.all([
        collectChildExit(first),
        collectChildExit(second)
      ]);

      expect(firstResult.code).toBe(0);
      expect(secondResult.code).toBe(0);
    } finally {
      if (first.exitCode === null) {
        first.kill();
      }
      if (second.exitCode === null) {
        second.kill();
      }
    }
  }, 15_000);
});

async function createTempStoreRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'project02-session-writer-'));
  tempRoots.push(root);
  return root;
}

function spawnChatProcess(
  storeRoot: string,
  sessionId: string
): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    ['src/cli/chat.ts', '--store', storeRoot, '--session', sessionId],
    { cwd: process.cwd(), stdio: 'pipe' }
  );
}

async function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  expected: string
): Promise<void> {
  await new Promise<void>((resolveOutput, rejectOutput) => {
    let stdout = '';
    const timeout = setTimeout(() => {
      rejectOutput(new Error(`Timed out waiting for chat output: ${stdout}`));
    }, 5_000);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;

      if (stdout.includes(expected)) {
        clearTimeout(timeout);
        resolveOutput();
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectOutput(error);
    });
    child.once('exit', (code) => {
      if (!stdout.includes(expected)) {
        clearTimeout(timeout);
        rejectOutput(
          new Error(`Chat exited before readiness (${String(code)}): ${stdout}`)
        );
      }
    });
  });
}

async function collectChildExit(
  child: ChildProcessWithoutNullStreams
): Promise<{ readonly code: number | null; readonly stderr: string }> {
  return await new Promise((resolveExit, rejectExit) => {
    let stderr = '';

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', rejectExit);
    child.once('exit', (code) => {
      resolveExit({ code, stderr });
    });
  });
}

async function snapshotDurableFiles(
  root: string,
  relativeRoot = ''
): Promise<Readonly<Record<string, string>>> {
  const directoryPath = relativeRoot.length === 0 ? root : join(root, relativeRoot);
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const snapshot: Record<string, string> = {};

  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  )) {
    const relativePath =
      relativeRoot.length === 0 ? entry.name : join(relativeRoot, entry.name);

    if (relativePath === '.locks' || relativePath.startsWith('.locks/')) {
      continue;
    }

    if (entry.isDirectory()) {
      Object.assign(snapshot, await snapshotDurableFiles(root, relativePath));
      continue;
    }

    if (entry.isFile()) {
      snapshot[relativePath] = await readFile(join(root, relativePath), 'utf8');
    }
  }

  return Object.freeze(snapshot);
}
