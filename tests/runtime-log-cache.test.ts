import * as fs from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestTempRoot } from './support/temp-root.ts';

type NodeFsModule = typeof fs;

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<NodeFsModule>('node:fs');

  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync)
  };
});

import {
  createConversationSession,
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent
} from '../src/core/index.ts';
import { runLocalUserMessageEvent } from '../src/runtime/turn/local.ts';
import { createRuntimePluginHost } from '../src/plugins/host/index.ts';
import { createFileRuntimeLogStore } from '../src/runtime/storage/file-runtime-log-store.ts';
import {
  acquireLocalRuntimeSessionWriterLease,
  createLocalRuntimeSessionStore
} from '../src/runtime/storage/session-store.ts';
import { createLocalRuntimeMutationLockOwnerToken } from '../src/runtime/storage/mutation-lock.ts';

afterEach(() => {
  vi.mocked(fs.readFileSync).mockClear();
});

describe('file runtime log store evidence cache', () => {
  it('retries one mixed generation and fails when both coherent-read attempts race', async () => {
    const storeRoot = createTestTempRoot('project02-log-race-');
    const sessionId = 'coherent-race-session';
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-07-11T00:00:00.000Z'
    });
    const session = createConversationSession({ id: sessionId });
    const writer = createFileRuntimeLogStore({ storeRoot, sessionId });
    await runTurn(session, writer, 0);
    let singleMutationCount = 0;
    const retryingReader = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      onEvidenceFileRead({ filePath }) {
        if (!filePath.endsWith('trace.jsonl') || singleMutationCount > 0) {
          return;
        }

        singleMutationCount += 1;
        const changedAt = new Date(Date.now() + 5_000);
        fs.utimesSync(filePath, changedAt, changedAt);
      }
    });

    expect(retryingReader.readSessionEvidence().stored.rawEvents.length).toBeGreaterThan(0);
    expect(singleMutationCount).toBe(1);

    let repeatedMutationCount = 0;
    const racingReader = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      onEvidenceFileRead({ filePath }) {
        if (!filePath.endsWith('trace.jsonl')) {
          return;
        }

        repeatedMutationCount += 1;
        const changedAt = new Date(Date.now() + 10_000 + repeatedMutationCount * 1_000);
        fs.utimesSync(filePath, changedAt, changedAt);
      }
    });

    expect(() => racingReader.readSessionEvidence()).toThrow(
      expect.objectContaining({ code: 'concurrent_write' })
    );
    expect(repeatedMutationCount).toBe(2);
  });

  it('loads a coherent snapshot once and performs no historical reads on 750 warm appends', async () => {
    const storeRoot = createTestTempRoot('project02-log-cache-');
    const sessionId = 'cache-session';
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-07-11T00:00:00.000Z'
    });
    const session = createConversationSession({ id: sessionId });
    const validationCounts = { cold: 0, incremental: 0 };
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      onEvidenceValidation(mode) {
        if (mode === 'cold_snapshot') {
          validationCounts.cold += 1;
        } else {
          validationCounts.incremental += 1;
        }
      }
    });

    await runTurn(session, logStore, 0);

    let reopenedColdValidations = 0;
    const reopened = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      onEvidenceValidation(mode) {
        if (mode === 'cold_snapshot') {
          reopenedColdValidations += 1;
        }
      }
    });
    vi.mocked(fs.readFileSync).mockClear();
    reopened.readSessionEvidence();

    expect(evidenceFileReads()).toEqual([
      'trace.jsonl',
      'raw-events.jsonl',
      'conversation.jsonl'
    ]);

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
    expect(validationCounts.incremental - warmValidationStart).toBeGreaterThanOrEqual(
      750
    );
  }, 15_000);

  it('reloads exactly once after one external mutation and then remains warm', async () => {
    const storeRoot = createTestTempRoot('project02-log-external-change-');
    const sessionId = 'external-change-session';
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-07-11T00:00:00.000Z'
    });
    const session = createConversationSession({ id: sessionId });
    const writer = createFileRuntimeLogStore({ storeRoot, sessionId });
    await runTurn(session, writer, 0);
    let coldValidations = 0;
    const reader = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      onEvidenceValidation(mode) {
        if (mode === 'cold_snapshot') {
          coldValidations += 1;
        }
      }
    });

    vi.mocked(fs.readFileSync).mockClear();
    reader.readSessionEvidence();
    expect(evidenceFileReads()).toEqual([
      'trace.jsonl',
      'raw-events.jsonl',
      'conversation.jsonl'
    ]);
    expect(coldValidations).toBe(1);

    vi.mocked(fs.readFileSync).mockClear();
    reader.readSessionEvidence();
    expect(evidenceFileReads()).toEqual([]);

    await runTurn(session, writer, 1);
    vi.mocked(fs.readFileSync).mockClear();
    reader.readSessionEvidence();
    expect(evidenceFileReads()).toEqual([
      'trace.jsonl',
      'raw-events.jsonl',
      'conversation.jsonl'
    ]);
    expect(coldValidations).toBe(2);

    vi.mocked(fs.readFileSync).mockClear();
    reader.readSessionEvidence();
    expect(evidenceFileReads()).toEqual([]);
    expect(coldValidations).toBe(2);
  });

  it('does not authorize another store cache under a different owner lease', async () => {
    const storeRoot = createTestTempRoot('project02-log-stale-writer-cache-');
    const sessionId = 'stale-writer-cache-session';
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-07-11T00:00:00.000Z'
    });
    const writerOwnerToken = createLocalRuntimeMutationLockOwnerToken();
    const writerStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      writerLockOwnerToken: writerOwnerToken
    });
    const staleStore = createFileRuntimeLogStore({ storeRoot, sessionId });
    const writerLease = await acquireLocalRuntimeSessionWriterLease({
      storeRoot,
      sessionId,
      ownerToken: writerOwnerToken
    });

    try {
      staleStore.readSessionEvidence();
      await runTurn(
        createConversationSession({ id: sessionId }),
        writerStore,
        0
      );
      const firstTraceEntry = writerStore.traceEntries()[0];

      if (firstTraceEntry === undefined) {
        throw new Error('Expected the writer to persist trace evidence.');
      }

      expect(() => staleStore.appendTrace(firstTraceEntry)).toThrow(
        expect.objectContaining({ code: 'session_busy' })
      );
      expect(
        createFileRuntimeLogStore({ storeRoot, sessionId }).traceEntries()
      ).toEqual(writerStore.traceEntries());
    } finally {
      await writerLease.release();
    }
  });

  it('refreshes cached evidence when the store reacquires a later writer lease', async () => {
    const storeRoot = createTestTempRoot('project02-log-writer-generation-');
    const sessionId = 'writer-generation-session';
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-07-11T00:00:00.000Z'
    });
    const staleStore = createFileRuntimeLogStore({ storeRoot, sessionId });
    const firstLease = await acquireLocalRuntimeSessionWriterLease({
      storeRoot,
      sessionId,
      ownerToken: fileLogStoreWriterOwnerToken(staleStore)
    });

    try {
      staleStore.readSessionEvidence();
    } finally {
      await firstLease.release();
    }

    const currentStore = createFileRuntimeLogStore({ storeRoot, sessionId });
    await runTurn(
      createConversationSession({ id: sessionId }),
      currentStore,
      0
    );
    const firstTraceEntry = currentStore.traceEntries()[0];

    if (firstTraceEntry === undefined) {
      throw new Error('Expected the writer to persist trace evidence.');
    }

    const secondLease = await acquireLocalRuntimeSessionWriterLease({
      storeRoot,
      sessionId,
      ownerToken: fileLogStoreWriterOwnerToken(staleStore)
    });

    try {
      expect(() => staleStore.appendTrace(firstTraceEntry)).toThrow(
        expect.objectContaining({ code: 'malformed_record' })
      );
    } finally {
      await secondLease.release();
    }
  });
});

async function runTurn(
  session: ReturnType<typeof createConversationSession>,
  logStore: ReturnType<typeof createFileRuntimeLogStore>,
  turn: number
): Promise<void> {
  await runLocalUserMessageEvent({
    event: createUserMessageRuntimeEvent(
      `message ${String(turn)}`,
      createRuntimeEventIdentity()
    ),
    session,
    logStore,
    pluginHost: createRuntimePluginHost({ plugins: [] }),
    agent: { reply: () => ({ text: `reply ${String(turn)}` }) }
  });
}

function evidenceFileReads(): readonly string[] {
  const evidenceFileNames = new Set([
    'trace.jsonl',
    'raw-events.jsonl',
    'conversation.jsonl'
  ]);

  return vi
    .mocked(fs.readFileSync)
    .mock.calls.map((call) => String(call[0]).split('/').at(-1) ?? '')
    .filter((fileName) => evidenceFileNames.has(fileName));
}

function fileLogStoreWriterOwnerToken(
  logStore: ReturnType<typeof createFileRuntimeLogStore>
) {
  const ownerToken = logStore.localRuntimeWriterLockOwnerToken;

  if (ownerToken === undefined) {
    throw new Error('Expected file runtime log store writer owner token.');
  }

  return ownerToken;
}
