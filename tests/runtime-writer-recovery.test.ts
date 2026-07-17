import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  createConversationSession,
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent
} from '../src/core/index.ts';
import { createRuntimePluginHost } from '../src/plugins/host/index.ts';
import { runLocalUserMessageEvent } from '../src/runtime/turn/local.ts';
import { createFileRuntimeLogStore } from '../src/runtime/storage/file-runtime-log-store.ts';
import { createLocalRuntimeSessionStore } from '../src/runtime/storage/session-store.ts';
import { createTestTempRoot } from './support/temp-root.ts';

describe('abandoned durable runtime writer recovery', () => {
  it('durably repairs the latest terminal raw turn only when the next writer acquires the session', async () => {
    const storeRoot = createTestTempRoot('project02-terminal-trace-recovery-');
    const sessionId = 'recover-latest-terminal-trace';
    const completedIdentity = {
      eventId: 'evt_completed_before_trace_crash',
      traceId: 'trace_completed_before_trace_crash',
      createdAt: '2026-07-11T00:00:00.000Z'
    } as const;
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: completedIdentity.createdAt
    });
    const session = createConversationSession({ id: sessionId });
    const initialLogStore = createFileRuntimeLogStore({ storeRoot, sessionId });

    await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent('first input', completedIdentity),
      session,
      logStore: initialLogStore,
      pluginHost: createRuntimePluginHost(),
      agent: { reply: () => ({ text: 'first reply' }) }
    });

    const paths = initialLogStore.localRuntimeSessionPaths;

    if (paths === undefined) {
      throw new Error('Expected durable runtime paths.');
    }

    writeJsonLines(
      paths.tracePath,
      readJsonLines(paths.tracePath).filter(
        (record) =>
          record['eventId'] !== completedIdentity.eventId ||
          (record['step'] !== 'raw_event_log_appended' &&
            record['step'] !== 'runtime_turn_completed')
      )
    );
    const traceBeforeReadOnlyInspection = readFileSync(paths.tracePath, 'utf8');
    const reopenedLogStore = createFileRuntimeLogStore({ storeRoot, sessionId });

    expect(
      reopenedLogStore.readSessionEvidence().derived.traceEntries.map(
        (entry) => entry.step
      )
    ).toEqual(['raw_event_log_appended', 'runtime_turn_completed']);
    expect(readFileSync(paths.tracePath, 'utf8')).toBe(
      traceBeforeReadOnlyInspection
    );

    await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent('second input', {
        eventId: 'evt_after_terminal_trace_recovery',
        traceId: 'trace_after_terminal_trace_recovery',
        createdAt: '2026-07-11T00:00:01.000Z'
      }),
      session,
      logStore: reopenedLogStore,
      pluginHost: createRuntimePluginHost(),
      agent: { reply: () => ({ text: 'second reply' }) }
    });

    expect(
      reopenedLogStore
        .readSessionEvidence()
        .stored.traceEntries.filter(
          (entry) => entry.eventId === completedIdentity.eventId
        )
        .map((entry) => entry.step)
    ).toEqual([
      'runtime_event_received',
      'runtime_event_normalized',
      'runtime_turn_started',
      'visible_reply_committed',
      'raw_event_log_appended',
      'runtime_turn_completed'
    ]);
  });

  it('rolls back one coherent final open turn and records writer termination before the next turn', async () => {
    const storeRoot = createTestTempRoot('project02-writer-recovery-');
    const sessionId = 'recover-open-turn';
    const abandonedIdentity = {
      eventId: 'evt_abandoned',
      traceId: 'trace_abandoned',
      createdAt: '2026-07-11T00:00:00.000Z'
    } as const;
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: abandonedIdentity.createdAt
    });
    const logStore = createFileRuntimeLogStore({ storeRoot, sessionId });
    const paths = logStore.localRuntimeSessionPaths;

    if (paths === undefined) {
      throw new Error('Expected durable runtime paths.');
    }

    writeJsonLines(paths.tracePath, [
      { ...abandonedIdentity, step: 'runtime_event_received' }
    ]);
    writeJsonLines(paths.rawEventsPath, [
      {
        ...abandonedIdentity,
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE'
      },
      {
        ...abandonedIdentity,
        kind: 'runtime_event_normalized',
        eventType: 'USER_MESSAGE'
      }
    ]);
    writeJsonLines(paths.conversationPath, [
      {
        ...abandonedIdentity,
        id: `${sessionId}:message-1`,
        role: 'user',
        speakerId: 'local-user',
        speakerName: 'You',
        text: 'abandoned input',
        committedAt: abandonedIdentity.createdAt
      }
    ]);
    const abandonedTempPath = `${paths.sessionRoot}/.conversation.jsonl.2147483647.123e4567-e89b-42d3-a456-426614174000.tmp`;
    writeFileSync(abandonedTempPath, 'secret partial content', 'utf8');
    const session = createConversationSession({ id: sessionId });

    await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent('next input', createRuntimeEventIdentity()),
      session,
      logStore,
      pluginHost: createRuntimePluginHost(),
      agent: { reply: () => ({ text: 'next reply' }) }
    });

    const evidence = logStore.readSessionEvidence().stored;
    expect(evidence.rawEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventId: abandonedIdentity.eventId,
          kind: 'runtime_turn_rejected',
          reason: 'writer_process_terminated'
        })
      ])
    );
    expect(
      evidence.traceEntries
        .filter((entry) => entry.eventId === abandonedIdentity.eventId)
        .map((entry) => entry.step)
    ).toEqual([
      'runtime_event_received',
      'raw_event_log_appended',
      'runtime_turn_rejected'
    ]);
    expect(evidence.conversationMessages.map((message) => message.text)).toEqual([
      'next input',
      'next reply'
    ]);
    expect(existsSync(abandonedTempPath)).toBe(false);
  });

  it('fails partial_write instead of guessing how to recover trace-only evidence', async () => {
    const storeRoot = createTestTempRoot('project02-writer-trace-only-');
    const sessionId = 'trace-only-turn';
    const identity = {
      eventId: 'evt_trace_only',
      traceId: 'trace_trace_only',
      createdAt: '2026-07-11T00:00:00.000Z'
    } as const;
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: identity.createdAt
    });
    const logStore = createFileRuntimeLogStore({ storeRoot, sessionId });
    const paths = logStore.localRuntimeSessionPaths;

    if (paths === undefined) {
      throw new Error('Expected durable runtime paths.');
    }

    writeJsonLines(paths.tracePath, [
      { ...identity, step: 'runtime_event_received' }
    ]);

    await expect(
      runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent('next input'),
        session: createConversationSession({ id: sessionId }),
        logStore,
        pluginHost: createRuntimePluginHost(),
        agent: { reply: () => ({ text: 'next reply' }) }
      })
    ).rejects.toMatchObject({ code: 'partial_write' });
  });
});

function writeJsonLines(filePath: string, records: readonly object[]): void {
  writeFileSync(
    filePath,
    records.map((record) => `${JSON.stringify(record)}\n`).join(''),
    'utf8'
  );
}

function readJsonLines(filePath: string): Record<string, unknown>[] {
  return readFileSync(filePath, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
