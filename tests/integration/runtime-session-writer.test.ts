import {createRoleModelAdapterFromCharacterAgent} from '../../src/role-model/index.ts';
import {testCharacterProfile} from '../support/character-fixtures.ts';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {
  createSession,
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
} from '../../src/core/index.ts';
import {createRuntimePluginHost} from '../../src/plugins/host/index.ts';
import {runLocalUserMessageEvent} from '../../src/runtime/turn/local.ts';
import {createFileRuntimeLogStore} from '../../src/runtime/storage/file-runtime-log-store.ts';
import {
  characterDataDirPath,
  LocalRuntimeStorageContractError,
} from '../../src/runtime/storage/layout-contract.ts';
import {createLocalRuntimeSessionStore} from '../../src/runtime/storage/session-store.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async root => {
      await rm(root, {force: true, recursive: true});
    }),
  );
});

describe('durable runtime session writer ownership', () => {
  it('rejects a second active writer before it appends evidence', async () => {
    const storeRoot = await createTempStoreRoot();
    const conversationId = 'shared-writer-session';
    const sessionId = `${conversationId}.1`;
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      characterId: 'mira',
    }).createSession({
      conversationId,
      createdAt: '2026-07-11T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      sessionId,
      characterId: 'mira',
      boundCharacter: testCharacterProfile,
    });
    const secondLogStore = createFileRuntimeLogStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      sessionId,
      characterId: 'mira',
      boundCharacter: testCharacterProfile,
    });
    const rawEventsPath = logStore.localRuntimeSessionPaths?.rawEventsPath;

    if (rawEventsPath === undefined) {
      throw new Error('Expected durable runtime session paths.');
    }
    const firstSession = createSession({
      id: sessionId,
      character: testCharacterProfile,
    });
    const secondSession = createSession({
      id: sessionId,
      character: testCharacterProfile,
    });
    let releaseReply: (() => void) | undefined;
    const replyStarted = new Promise<void>(resolveStarted => {
      releaseReply = resolveStarted;
    });
    let markReplyStarted: (() => void) | undefined;
    const providerEntered = new Promise<void>(resolveEntered => {
      markReplyStarted = resolveEntered;
    });
    const firstTurn = runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'first',
        createRuntimeEventIdentity(),
      ),
      session: firstSession,
      logStore,
      pluginHost: createRuntimePluginHost(),
      roleModelAdapter: createRoleModelAdapterFromCharacterAgent({
        async reply() {
          markReplyStarted?.();
          await replyStarted;
          return {text: 'first reply'};
        },
      }),
    });

    await providerEntered;
    const rawEventsBeforeSecondWriter = await readFile(rawEventsPath, 'utf8');
    let secondError: unknown;

    try {
      await runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent(
          'second',
          createRuntimeEventIdentity(),
        ),
        session: secondSession,
        logStore: secondLogStore,
        pluginHost: createRuntimePluginHost(),
        roleModelAdapter: createRoleModelAdapterFromCharacterAgent({
          reply: () => ({text: 'second reply'}),
        }),
      });
    } catch (error: unknown) {
      secondError = error;
    }

    expect(secondError).toBeInstanceOf(LocalRuntimeStorageContractError);
    expect((secondError as LocalRuntimeStorageContractError).code).toBe(
      'session_busy',
    );
    expect(await readFile(rawEventsPath, 'utf8')).toBe(
      rawEventsBeforeSecondWriter,
    );

    releaseReply?.();
    await firstTurn;
  });

  it('refuses a second session writing over an existing transcript', async () => {
    const storeRoot = await createTempStoreRoot();
    const conversationId = 'stale-writer-session';
    const sessionId = `${conversationId}.1`;
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      characterId: 'mira',
    }).createSession({
      conversationId,
      createdAt: '2026-07-11T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      sessionId,
      characterId: 'mira',
      boundCharacter: testCharacterProfile,
    });
    const currentSession = createSession({
      id: sessionId,
      character: testCharacterProfile,
    });
    const staleSession = createSession({
      id: sessionId,
      character: testCharacterProfile,
    });

    await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'first',
        createRuntimeEventIdentity(),
      ),
      session: currentSession,
      logStore,
      pluginHost: createRuntimePluginHost(),
      roleModelAdapter: createRoleModelAdapterFromCharacterAgent({
        reply: () => ({text: 'first reply'}),
      }),
    });
    const rawEventCountBeforeStaleWriter = logStore.rawEvents().length;

    await expect(
      runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent(
          'stale',
          createRuntimeEventIdentity(),
        ),
        session: staleSession,
        logStore,
        pluginHost: createRuntimePluginHost(),
        roleModelAdapter: createRoleModelAdapterFromCharacterAgent({
          reply: () => ({text: 'stale reply'}),
        }),
      }),
    ).rejects.toMatchObject({code: 'malformed_record'});
    expect(
      logStore
        .rawEvents()
        .slice(rawEventCountBeforeStaleWriter)
        .map(rawEvent => rawEvent.kind),
    ).toEqual([
      'runtime_event_received',
      'runtime_event_normalized',
      'runtime_turn_rejected',
    ]);
  });

  it('holds the conversation writer lease for the full interactive chat process', async () => {
    const storeRoot = await createTempStoreRoot();
    const first = spawnChatProcess(storeRoot, '--init');

    try {
      await waitForOutput(first, 'is ready.');
      const durableFilesBeforeSecondWriter =
        await snapshotDurableFiles(storeRoot);
      const second = spawnChatProcess(storeRoot);
      const secondResult = await collectChildExit(second);

      expect(secondResult.code).toBe(1);
      expect(secondResult.stderr).toContain(
        'Local runtime mutation resource is busy: conversation-writer:',
      );
      expect(await snapshotDurableFiles(storeRoot)).toEqual(
        durableFilesBeforeSecondWriter,
      );

      first.stdin.write('/exit\n');
      const firstResult = await collectChildExit(first);
      expect(firstResult.code).toBe(0);
    } finally {
      if (first.exitCode === null) {
        first.kill();
      }
    }
  }, 40_000);
});

async function createTempStoreRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'project02-session-writer-'));
  tempRoots.push(root);
  return root;
}

function spawnChatProcess(
  storeRoot: string,
  ...extraArgs: readonly string[]
): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    ['src/cli/chat/main.ts', '--store', storeRoot, ...extraArgs],
    {cwd: process.cwd(), stdio: 'pipe'},
  );
}

async function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  expected: string,
): Promise<void> {
  await new Promise<void>((resolveOutput, rejectOutput) => {
    let stdout = '';
    // An idle deadline, not a total one: these cases cold-start several real
    // Node processes, so any fixed budget goes flaky under runner load.
    let timeout: NodeJS.Timeout;
    const failIfIdle = (): void => {
      timeout = setTimeout(() => {
        rejectOutput(new Error(`Timed out waiting for chat output: ${stdout}`));
      }, 20_000);
    };

    failIfIdle();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;

      if (stdout.includes(expected)) {
        clearTimeout(timeout);
        resolveOutput();
        return;
      }
      clearTimeout(timeout);
      failIfIdle();
    });
    child.once('error', error => {
      clearTimeout(timeout);
      rejectOutput(error);
    });
    child.once('exit', code => {
      if (!stdout.includes(expected)) {
        clearTimeout(timeout);
        rejectOutput(
          new Error(
            `Chat exited before readiness (${String(code)}): ${stdout}`,
          ),
        );
      }
    });
  });
}

async function collectChildExit(
  child: ChildProcessWithoutNullStreams,
): Promise<{readonly code: number | null; readonly stderr: string}> {
  return await new Promise((resolveExit, rejectExit) => {
    let stderr = '';

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', rejectExit);
    child.once('exit', code => {
      resolveExit({code, stderr});
    });
  });
}

async function snapshotDurableFiles(
  root: string,
  relativeRoot = '',
): Promise<Readonly<Record<string, string>>> {
  const directoryPath =
    relativeRoot.length === 0 ? root : join(root, relativeRoot);
  const entries = await readdir(directoryPath, {withFileTypes: true});
  const snapshot: Record<string, string> = {};

  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
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
