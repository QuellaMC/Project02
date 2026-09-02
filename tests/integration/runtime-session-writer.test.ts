import {createRoleModelAdapterFromCharacterAgent} from '../../src/role-model/index.ts';
import {testCharacterProfile} from '../support/character-fixtures.ts';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
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
});

async function createTempStoreRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'project02-session-writer-'));
  tempRoots.push(root);
  return root;
}
