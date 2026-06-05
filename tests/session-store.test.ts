import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ConversationRehydrationError,
  createConversationSession,
  createLocalRuntimeSessionPaths,
  createLocalRuntimeSessionStore,
  createLocalRuntimeStorageLayout,
  createLocalRuntimeStorageSchemaMarker,
  createRuntimeLogStore,
  createUserMessageRuntimeEvent,
  encodeStorageSchemaMarker,
  LocalRuntimeStorageContractError,
  LocalRuntimeSessionStoreError,
  runCharacterTurn,
  runLocalUserMessageEvent,
  type ConversationLogRecord,
  type LocalRuntimeStorageContractErrorCode,
  type LocalRuntimeSessionConversationLogReader
} from '../src/index.ts';

const tempRoots: string[] = [];

describe('local runtime session store', () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.map(async (root) => {
        await rm(root, { recursive: true, force: true });
      })
    );
    tempRoots.length = 0;
  });

  it('creates, lists, reopens, and selects sessions by storage-safe ID', async () => {
    const storeRoot = await createTempStoreRoot();
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      now: fixedClock([
        '2026-06-04T00:00:00.000Z',
        '2026-06-04T00:01:00.000Z'
      ])
    });

    const first = await store.createSession({
      sessionId: 'mira-local'
    });
    const second = await store.createSession({
      sessionId: 'evening-chat'
    });

    expect(await store.listSessions()).toEqual([first, second]);
    await expect(
      store.createSession({
        sessionId: 'mira-local'
      })
    ).rejects.toThrow(LocalRuntimeSessionStoreError);

    const reopened = createLocalRuntimeSessionStore({
      storeRoot,
      now: fixedClock(['2026-06-04T00:05:00.000Z'])
    });
    const selected = await reopened.selectSession('mira-local');

    expect(selected).toEqual({
      sessionId: 'mira-local',
      createdAt: '2026-06-04T00:00:00.000Z',
      updatedAt: '2026-06-04T00:05:00.000Z'
    });
    expect(await reopened.readSession('mira-local')).toEqual(selected);
    expect(await reopened.listSessions()).toEqual([selected, second]);
  });

  it('rehydrates persisted visible conversation messages in order through the CT-02 reader seam', async () => {
    const storeRoot = await createTempStoreRoot();
    const logStore = createRuntimeLogStore();
    const originalSession = createConversationSession({
      id: 'mira-local'
    });

    await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent('first', {
        eventId: 'evt_first',
        traceId: 'trace_first',
        createdAt: '2026-06-04T00:00:00.000Z'
      }),
      session: originalSession,
      logStore
    });

    const reader = createConversationLogReader({
      'mira-local': logStore.conversationMessages()
    });
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      conversationLogReader: reader,
      now: fixedClock(['2026-06-04T00:02:00.000Z'])
    });

    await store.createSession({
      sessionId: 'mira-local'
    });

    const rehydrated = await store.rehydrateConversationSession('mira-local');

    expect(rehydrated.visibleTranscript).toEqual([
      {
        id: 'mira-local:message-1',
        role: 'user',
        speakerId: 'local-user',
        speakerName: 'You',
        text: 'first'
      },
      {
        id: 'mira-local:message-2',
        role: 'character',
        speakerId: 'mira',
        speakerName: 'Mira',
        text: "I'm here. Tell me what you need."
      }
    ]);
  });

  it('resumes a second turn with prior visible context and appends IDs after restored records', async () => {
    const storeRoot = await createTempStoreRoot();
    const reader = createConversationLogReader({
      'mira-local': [
        createConversationRecord({
          id: 'mira-local:message-1',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'first'
        }),
        createConversationRecord({
          id: 'mira-local:message-2',
          role: 'character',
          speakerId: 'mira',
          speakerName: 'Mira',
          text: "I'm here. Tell me what you need."
        })
      ]
    });
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      conversationLogReader: reader,
      now: fixedClock(['2026-06-04T00:00:00.000Z'])
    });

    await store.createSession({
      sessionId: 'mira-local'
    });

    const rehydrated = await store.rehydrateConversationSession('mira-local');
    const result = await runCharacterTurn(rehydrated, 'second');

    expect(result.reply.text).toBe(
      'I remember you said "first" Stay with me for a minute.'
    );
    expect(result.userMessage.id).toBe('mira-local:message-3');
    expect(result.characterMessage.id).toBe('mira-local:message-4');
  });

  it('keeps separate session transcripts isolated during rehydration', async () => {
    const storeRoot = await createTempStoreRoot();
    const reader = createConversationLogReader({
      alpha: [
        createConversationRecord({
          id: 'alpha:message-1',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'alpha first'
        }),
        createConversationRecord({
          id: 'alpha:message-2',
          role: 'character',
          speakerId: 'mira',
          speakerName: 'Mira',
          text: 'alpha reply'
        })
      ],
      beta: [
        createConversationRecord({
          id: 'beta:message-1',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'beta first'
        }),
        createConversationRecord({
          id: 'beta:message-2',
          role: 'character',
          speakerId: 'mira',
          speakerName: 'Mira',
          text: 'beta reply'
        })
      ]
    });
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      conversationLogReader: reader,
      now: fixedClock([
        '2026-06-04T00:00:00.000Z',
        '2026-06-04T00:01:00.000Z'
      ])
    });

    await store.createSession({
      sessionId: 'alpha'
    });
    await store.createSession({
      sessionId: 'beta'
    });

    const alpha = await store.rehydrateConversationSession('alpha');
    const beta = await store.rehydrateConversationSession('beta');

    await expect(runCharacterTurn(alpha, 'second')).resolves.toMatchObject({
      reply: {
        text: 'I remember you said "alpha first" Stay with me for a minute.'
      }
    });
    await expect(runCharacterTurn(beta, 'second')).resolves.toMatchObject({
      reply: {
        text: 'I remember you said "beta first" Stay with me for a minute.'
      }
    });
  });

  it('fails loudly when persisted visible messages are malformed', async () => {
    const storeRoot = await createTempStoreRoot();
    const reader = createConversationLogReader({
      alpha: [
        createConversationRecord({
          id: 'other-session:message-1',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'wrong owner'
        })
      ]
    });
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      conversationLogReader: reader,
      now: fixedClock(['2026-06-04T00:00:00.000Z'])
    });

    await store.createSession({
      sessionId: 'alpha'
    });

    await expect(store.rehydrateConversationSession('alpha')).rejects.toThrow(
      ConversationRehydrationError
    );
  });

  it('fails clearly when CT-02 has not provided a conversation log reader', async () => {
    const storeRoot = await createTempStoreRoot();
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      now: fixedClock(['2026-06-04T00:00:00.000Z'])
    });

    await store.createSession({
      sessionId: 'alpha'
    });

    await expect(store.rehydrateConversationSession('alpha')).rejects.toThrow(
      LocalRuntimeSessionStoreError
    );
  });

  it('fails partial session catalog records with CT-01 partial-write errors', async () => {
    const storeRoot = await createTempStoreRoot();
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      now: fixedClock(['2026-06-04T00:00:00.000Z'])
    });

    await store.createSession({
      sessionId: 'alpha'
    });
    await writeFile(
      store.layout.sessionCatalogPath,
      JSON.stringify({
        sessionId: 'alpha',
        createdAt: '2026-06-04T00:00:00.000Z',
        updatedAt: '2026-06-04T00:00:00.000Z'
      }),
      'utf8'
    );

    await expectStorageErrorCode(
      async () => await store.listSessions(),
      'partial_write'
    );
  });

  it('tolerates empty orphan session directories when the catalog was never created', async () => {
    const storeRoot = await createTempStoreRoot();
    const layout = createLocalRuntimeStorageLayout({ storeRoot });
    const orphanPaths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'orphan'
    });

    await mkdir(orphanPaths.sessionRoot, { recursive: true });
    await writeFile(
      layout.schemaPath,
      `${encodeStorageSchemaMarker(
        createLocalRuntimeStorageSchemaMarker({
          createdAt: '2026-06-04T00:00:00.000Z'
        })
      )}\n`,
      'utf8'
    );

    const store = createLocalRuntimeSessionStore({
      storeRoot,
      now: fixedClock(['2026-06-04T00:01:00.000Z'])
    });

    await expect(store.listSessions()).resolves.toEqual([]);

    const created = await store.createSession({
      sessionId: 'fresh'
    });

    expect(created).toEqual({
      sessionId: 'fresh',
      createdAt: '2026-06-04T00:01:00.000Z',
      updatedAt: '2026-06-04T00:01:00.000Z'
    });
    await expect(readFile(layout.sessionCatalogPath, 'utf8')).resolves.toBe(
      `${JSON.stringify(created)}\n`
    );
  });

  it('tolerates an empty sessions root when the schema marker was never created', async () => {
    const storeRoot = await createTempStoreRoot();
    const layout = createLocalRuntimeStorageLayout({ storeRoot });

    await mkdir(layout.sessionsRoot, { recursive: true });

    const store = createLocalRuntimeSessionStore({
      storeRoot,
      now: fixedClock(['2026-06-04T00:02:00.000Z'])
    });
    const created = await store.createSession({
      sessionId: 'fresh'
    });

    expect(created).toEqual({
      sessionId: 'fresh',
      createdAt: '2026-06-04T00:02:00.000Z',
      updatedAt: '2026-06-04T00:02:00.000Z'
    });
    await expect(readFile(layout.sessionCatalogPath, 'utf8')).resolves.toBe(
      `${JSON.stringify(created)}\n`
    );
  });
});

async function createTempStoreRoot(): Promise<string> {
  const storeRoot = await mkdtemp(join(tmpdir(), 'project02-session-store-'));

  tempRoots.push(storeRoot);
  return storeRoot;
}

function fixedClock(times: readonly string[]): () => string {
  let index = 0;

  return () => {
    const time = times[index] ?? times[times.length - 1];

    if (time === undefined) {
      throw new Error('Expected fixed clock to have at least one time.');
    }

    index += 1;
    return time;
  };
}

function createConversationLogReader(
  recordsBySessionId: Readonly<Record<string, readonly ConversationLogRecord[]>>
): LocalRuntimeSessionConversationLogReader {
  return {
    readConversationMessages(sessionId) {
      return recordsBySessionId[sessionId] ?? [];
    }
  };
}

function createConversationRecord(
  message: Pick<
    ConversationLogRecord,
    'id' | 'role' | 'speakerId' | 'speakerName' | 'text'
  >
): ConversationLogRecord {
  return Object.freeze({
    eventId: 'evt_persisted',
    traceId: 'trace_persisted',
    createdAt: '2026-06-04T00:00:00.000Z',
    committedAt: '2026-06-04T00:00:01.000Z',
    ...message
  } satisfies ConversationLogRecord);
}

async function expectStorageErrorCode(
  operation: () => Promise<unknown>,
  code: LocalRuntimeStorageContractErrorCode
): Promise<void> {
  try {
    await operation();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(LocalRuntimeStorageContractError);

    if (!(error instanceof LocalRuntimeStorageContractError)) {
      throw new Error('Expected LocalRuntimeStorageContractError.', {
        cause: error
      });
    }

    expect(error.code).toBe(code);
    return;
  }

  throw new Error(`Expected local runtime storage error code "${code}".`);
}
