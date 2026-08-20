import {createRoleModelAdapterFromCharacterAgent} from '../../src/role-model/index.ts';
import {testCharacterProfile} from '../support/character-fixtures.ts';
import * as fs from 'node:fs';

import {afterEach, describe, expect, it, vi} from 'vitest';
import {createTestTempRoot} from '../support/temp-root.ts';

type NodeFsModule = typeof fs;

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<NodeFsModule>('node:fs');

  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
  };
});

import {
  createSession,
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
} from '../../src/core/index.ts';
import {runLocalUserMessageEvent} from '../../src/runtime/turn/local.ts';
import {createRuntimePluginHost} from '../../src/plugins/host/index.ts';
import {createFileRuntimeLogStore} from '../../src/runtime/storage/file-runtime-log-store.ts';
import {
  acquireLocalRuntimeSessionWriterLease,
  createLocalRuntimeSessionStore,
} from '../../src/runtime/storage/session-store.ts';
import {createLocalRuntimeMutationLockOwnerToken} from '../../src/runtime/storage/mutation-lock.ts';

afterEach(() => {
  vi.mocked(fs.readFileSync).mockClear();
});

describe('file runtime log store evidence cache', () => {
  it('retries one mixed generation and fails when both coherent-read attempts race', async () => {
    const storeRoot = createTestTempRoot('project02-log-race-');
    const conversationId = 'coherent-race-session';
    const sessionId = `${conversationId}.1`;
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      conversationId,
      createdAt: '2026-07-11T00:00:00.000Z',
    });
    const session = createSession({
      id: sessionId,
      character: testCharacterProfile,
    });
    const writer = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: 'mira',
      boundCharacter: testCharacterProfile,
    });
    await runTurn(session, writer, 0);
    let singleMutationCount = 0;
    const retryingReader = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: 'mira',
      boundCharacter: testCharacterProfile,
      onEvidenceFileRead({filePath}) {
        if (!filePath.endsWith('raw-events.jsonl') || singleMutationCount > 0) {
          return;
        }

        singleMutationCount += 1;
        const changedAt = new Date(Date.now() + 5_000);
        fs.utimesSync(filePath, changedAt, changedAt);
      },
    });

    expect(
      retryingReader.readSessionEvidence().rawEvents.length,
    ).toBeGreaterThan(0);
    expect(singleMutationCount).toBe(1);

    let repeatedMutationCount = 0;
    const racingReader = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: 'mira',
      boundCharacter: testCharacterProfile,
      onEvidenceFileRead({filePath}) {
        if (!filePath.endsWith('raw-events.jsonl')) {
          return;
        }

        repeatedMutationCount += 1;
        const changedAt = new Date(
          Date.now() + 10_000 + repeatedMutationCount * 1_000,
        );
        fs.utimesSync(filePath, changedAt, changedAt);
      },
    });

    expect(() => racingReader.readSessionEvidence()).toThrow(
      expect.objectContaining({code: 'concurrent_write'}),
    );
    expect(repeatedMutationCount).toBe(2);
  });

  it('loads a coherent snapshot once and performs no historical reads on 750 warm appends', async () => {
    const storeRoot = createTestTempRoot('project02-log-cache-');
    const conversationId = 'cache-session';
    const sessionId = `${conversationId}.1`;
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      conversationId,
      createdAt: '2026-07-11T00:00:00.000Z',
    });
    const session = createSession({
      id: sessionId,
      character: testCharacterProfile,
    });
    const validationCounts = {cold: 0, incremental: 0};
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: 'mira',
      boundCharacter: testCharacterProfile,
      onEvidenceValidation(mode) {
        if (mode === 'cold_snapshot') {
          validationCounts.cold += 1;
        } else {
          validationCounts.incremental += 1;
        }
      },
    });

    await runTurn(session, logStore, 0);

    let reopenedColdValidations = 0;
    const reopened = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: 'mira',
      boundCharacter: testCharacterProfile,
      onEvidenceValidation(mode) {
        if (mode === 'cold_snapshot') {
          reopenedColdValidations += 1;
        }
      },
    });
    vi.mocked(fs.readFileSync).mockClear();
    reopened.readSessionEvidence();

    expect(evidenceFileReads()).toEqual(['raw-events.jsonl']);

    vi.mocked(fs.readFileSync).mockClear();
    reopened.traceEntries();
    reopened.rawEvents();
    reopened.conversationMessages();
    expect(evidenceFileReads()).toEqual([]);
    expect(reopenedColdValidations).toBe(1);

    vi.mocked(fs.readFileSync).mockClear();
    const warmValidationStart = validationCounts.incremental;
    let turn = 1;

    while (validationCounts.incremental - warmValidationStart < 750) {
      await runTurn(session, logStore, turn);
      turn += 1;
    }
    expect(evidenceFileReads()).toEqual([]);
    expect(validationCounts.cold).toBe(1);
    expect(
      validationCounts.incremental - warmValidationStart,
    ).toBeGreaterThanOrEqual(750);
  }, 15_000);

  it('reloads exactly once after one external mutation and then remains warm', async () => {
    const storeRoot = createTestTempRoot('project02-log-external-change-');
    const conversationId = 'external-change-session';
    const sessionId = `${conversationId}.1`;
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      conversationId,
      createdAt: '2026-07-11T00:00:00.000Z',
    });
    const session = createSession({
      id: sessionId,
      character: testCharacterProfile,
    });
    const writer = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: 'mira',
      boundCharacter: testCharacterProfile,
    });
    await runTurn(session, writer, 0);
    let coldValidations = 0;
    const reader = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: 'mira',
      boundCharacter: testCharacterProfile,
      onEvidenceValidation(mode) {
        if (mode === 'cold_snapshot') {
          coldValidations += 1;
        }
      },
    });

    vi.mocked(fs.readFileSync).mockClear();
    reader.readSessionEvidence();
    expect(evidenceFileReads()).toEqual(['raw-events.jsonl']);
    expect(coldValidations).toBe(1);

    vi.mocked(fs.readFileSync).mockClear();
    reader.readSessionEvidence();
    expect(evidenceFileReads()).toEqual([]);

    await runTurn(session, writer, 1);
    vi.mocked(fs.readFileSync).mockClear();
    reader.readSessionEvidence();
    expect(evidenceFileReads()).toEqual(['raw-events.jsonl']);
    expect(coldValidations).toBe(2);

    vi.mocked(fs.readFileSync).mockClear();
    reader.readSessionEvidence();
    expect(evidenceFileReads()).toEqual([]);
    expect(coldValidations).toBe(2);
  });

  it('does not authorize another store cache under a different owner lease', async () => {
    const storeRoot = createTestTempRoot('project02-log-stale-writer-cache-');
    const conversationId = 'stale-writer-cache-session';
    const sessionId = `${conversationId}.1`;
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      conversationId,
      createdAt: '2026-07-11T00:00:00.000Z',
    });
    const writerOwnerToken = createLocalRuntimeMutationLockOwnerToken();
    const writerStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: 'mira',
      boundCharacter: testCharacterProfile,
      writerLockOwnerToken: writerOwnerToken,
    });
    const staleStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: 'mira',
      boundCharacter: testCharacterProfile,
    });
    const writerLease = await acquireLocalRuntimeSessionWriterLease({
      storeRoot,
      sessionId,
      ownerToken: writerOwnerToken,
    });

    try {
      staleStore.readSessionEvidence();
      await runTurn(
        createSession({
          id: sessionId,
          character: testCharacterProfile,
        }),
        writerStore,
        0,
      );
      const firstRawEvent = writerStore.rawEvents()[0];

      if (firstRawEvent === undefined) {
        throw new Error('Expected the writer to persist raw evidence.');
      }

      expect(() => staleStore.appendRawEvent(firstRawEvent)).toThrow(
        expect.objectContaining({code: 'session_busy'}),
      );
      expect(
        createFileRuntimeLogStore({
          storeRoot,
          sessionId,
          characterId: 'mira',
          boundCharacter: testCharacterProfile,
        }).traceEntries(),
      ).toEqual(writerStore.traceEntries());
    } finally {
      await writerLease.release();
    }
  });

  it('refreshes cached evidence when the store reacquires a later writer lease', async () => {
    const storeRoot = createTestTempRoot('project02-log-writer-generation-');
    const conversationId = 'writer-generation-session';
    const sessionId = `${conversationId}.1`;
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      conversationId,
      createdAt: '2026-07-11T00:00:00.000Z',
    });
    const staleStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: 'mira',
      boundCharacter: testCharacterProfile,
    });
    const firstLease = await acquireLocalRuntimeSessionWriterLease({
      storeRoot,
      sessionId,
      ownerToken: fileLogStoreWriterOwnerToken(staleStore),
    });

    try {
      staleStore.readSessionEvidence();
    } finally {
      await firstLease.release();
    }

    const currentStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: 'mira',
      boundCharacter: testCharacterProfile,
    });
    await runTurn(
      createSession({
        id: sessionId,
        character: testCharacterProfile,
      }),
      currentStore,
      0,
    );
    const firstRawEvent = currentStore.rawEvents()[0];

    if (firstRawEvent === undefined) {
      throw new Error('Expected the writer to persist raw evidence.');
    }

    const secondLease = await acquireLocalRuntimeSessionWriterLease({
      storeRoot,
      sessionId,
      ownerToken: fileLogStoreWriterOwnerToken(staleStore),
    });

    try {
      expect(() => staleStore.appendRawEvent(firstRawEvent)).toThrow(
        expect.objectContaining({code: 'malformed_record'}),
      );
    } finally {
      await secondLease.release();
    }
  });
});

async function runTurn(
  session: ReturnType<typeof createSession>,
  logStore: ReturnType<typeof createFileRuntimeLogStore>,
  turn: number,
): Promise<void> {
  await runLocalUserMessageEvent({
    event: createUserMessageRuntimeEvent(
      `message ${String(turn)}`,
      createRuntimeEventIdentity(),
    ),
    session,
    logStore,
    pluginHost: createRuntimePluginHost({plugins: []}),
    roleModelAdapter: createRoleModelAdapterFromCharacterAgent({
      reply: () => ({text: `reply ${String(turn)}`}),
    }),
  });
}

function evidenceFileReads(): readonly string[] {
  const evidenceFileNames = new Set(['raw-events.jsonl']);

  return vi
    .mocked(fs.readFileSync)
    .mock.calls.map(call => String(call[0]).split('/').at(-1) ?? '')
    .filter(fileName => evidenceFileNames.has(fileName));
}

function fileLogStoreWriterOwnerToken(
  logStore: ReturnType<typeof createFileRuntimeLogStore>,
) {
  const ownerToken = logStore.localRuntimeWriterLockOwnerToken;

  if (ownerToken === undefined) {
    throw new Error('Expected file runtime log store writer owner token.');
  }

  return ownerToken;
}
