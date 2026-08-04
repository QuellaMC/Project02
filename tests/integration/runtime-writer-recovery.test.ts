import {createRoleModelAdapterFromCharacterAgent} from '../../src/role-model/index.ts';
import {testCharacterProfile} from '../support/character-fixtures.ts';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {
  createConversationSession,
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
} from '../../src/core/index.ts';
import {createRuntimePluginHost} from '../../src/plugins/host/index.ts';
import {runLocalUserMessageEvent} from '../../src/runtime/turn/local.ts';
import {createFileRuntimeLogStore} from '../../src/runtime/storage/file-runtime-log-store.ts';
import {createLocalRuntimeSessionStore} from '../../src/runtime/storage/session-store.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

describe('abandoned durable runtime writer recovery', () => {
  it('durably repairs the latest terminal raw turn only when the next writer acquires the session', async () => {
    const storeRoot = createTestTempRoot('project02-terminal-trace-recovery-');
    const sessionId = 'recover-latest-terminal-trace';
    const completedIdentity = {
      eventId: 'evt_completed_before_trace_crash',
      traceId: 'trace_completed_before_trace_crash',
      createdAt: '2026-07-11T00:00:00.000Z',
    } as const;
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      sessionId,
      createdAt: completedIdentity.createdAt,
    });
    const session = createConversationSession({
      id: sessionId,
      character: testCharacterProfile,
    });
    const initialLogStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: 'mira',
      boundCharacter: testCharacterProfile,
    });

    await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent('first input', completedIdentity),
      session,
      logStore: initialLogStore,
      pluginHost: createRuntimePluginHost(),
      roleModelAdapter: createRoleModelAdapterFromCharacterAgent({
        reply: () => ({text: 'first reply'}),
      }),
    });

    const paths = initialLogStore.localRuntimeSessionPaths;

    if (paths === undefined) {
      throw new Error('Expected durable runtime paths.');
    }

    writeJsonLines(
      paths.tracePath,
      readJsonLines(paths.tracePath).filter(
        record =>
          record['eventId'] !== completedIdentity.eventId ||
          (record['step'] !== 'raw_event_log_appended' &&
            record['step'] !== 'runtime_turn_completed'),
      ),
    );
    const traceBeforeReadOnlyInspection = readFileSync(paths.tracePath, 'utf8');
    const reopenedLogStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: 'mira',
      boundCharacter: testCharacterProfile,
    });

    expect(
      reopenedLogStore
        .readSessionEvidence()
        .derived.traceEntries.map(entry => entry.step),
    ).toEqual(['raw_event_log_appended', 'runtime_turn_completed']);
    expect(readFileSync(paths.tracePath, 'utf8')).toBe(
      traceBeforeReadOnlyInspection,
    );

    await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent('second input', {
        eventId: 'evt_after_terminal_trace_recovery',
        traceId: 'trace_after_terminal_trace_recovery',
        createdAt: '2026-07-11T00:00:01.000Z',
      }),
      session,
      logStore: reopenedLogStore,
      pluginHost: createRuntimePluginHost(),
      roleModelAdapter: createRoleModelAdapterFromCharacterAgent({
        reply: () => ({text: 'second reply'}),
      }),
    });

    expect(
      reopenedLogStore
        .readSessionEvidence()
        .stored.traceEntries.filter(
          entry => entry.eventId === completedIdentity.eventId,
        )
        .map(entry => entry.step),
    ).toEqual([
      'runtime_event_received',
      'runtime_event_normalized',
      'runtime_turn_started',
      // One commit step per visible message: the user message and the reply.
      'visible_message_committed',
      'visible_message_committed',
      'raw_event_log_appended',
      'runtime_turn_completed',
    ]);
  });

  it('rolls back one coherent final open turn when the bounded identity matches', async () => {
    const storeRoot = createTestTempRoot('project02-writer-recovery-');
    const sessionId = 'recover-open-turn';
    const abandonedIdentity = {
      eventId: 'evt_abandoned',
      traceId: 'trace_abandoned',
      createdAt: '2026-07-11T00:00:00.000Z',
    } as const;
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      sessionId,
      createdAt: abandonedIdentity.createdAt,
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: 'mira',
      boundCharacter: testCharacterProfile,
      boundUserSpeaker: {id: 'local-user', displayName: 'You'},
    });
    const paths = logStore.localRuntimeSessionPaths;

    if (paths === undefined) {
      throw new Error('Expected durable runtime paths.');
    }

    const abandonedToolCallId = `${abandonedIdentity.eventId}.${abandonedIdentity.traceId}.round-1.1.memory.search`;

    writeJsonLines(paths.tracePath, [
      {...abandonedIdentity, step: 'runtime_event_received'},
    ]);
    writeJsonLines(paths.rawEventsPath, [
      {
        ...abandonedIdentity,
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE',
      },
      {
        ...abandonedIdentity,
        kind: 'runtime_event_normalized',
        eventType: 'USER_MESSAGE',
      },
      {
        ...abandonedIdentity,
        kind: 'tool_call_started',
        eventType: 'USER_MESSAGE',
        toolCallId: abandonedToolCallId,
        toolRound: 1,
        toolName: 'memory.search',
        toolPluginId: 'memory.fixture',
        toolInput: {query: 'abandoned'},
      },
      {
        ...abandonedIdentity,
        kind: 'tool_call_finished',
        eventType: 'USER_MESSAGE',
        toolCallId: abandonedToolCallId,
        toolRound: 1,
        toolName: 'memory.search',
        toolPluginId: 'memory.fixture',
        dispatchedToHost: true,
        toolResult: {status: 'accepted', output: {}, evidence: []},
      },
      {
        ...abandonedIdentity,
        kind: 'visible_message_committed',
        eventType: 'USER_MESSAGE',
        visibleMessageIds: [`${sessionId}:message-1`],
        visibleMessage: {
          id: `${sessionId}:message-1`,
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'abandoned input',
        },
        committedAt: abandonedIdentity.createdAt,
      },
    ]);
    const abandonedTempPath = `${paths.sessionRoot}/.raw-events.jsonl.2147483647.123e4567-e89b-42d3-a456-426614174000.tmp`;
    writeFileSync(abandonedTempPath, 'secret partial content', 'utf8');
    const session = createConversationSession({
      id: sessionId,
      character: testCharacterProfile,
      // The abandoned turn's committed message survives recovery, so the
      // resumed session starts from it rather than empty.
      visibleTranscript: [
        {
          id: `${sessionId}:message-1`,
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'abandoned input',
        },
      ],
    });

    await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'next input',
        createRuntimeEventIdentity(),
      ),
      session,
      logStore,
      pluginHost: createRuntimePluginHost(),
      roleModelAdapter: createRoleModelAdapterFromCharacterAgent({
        reply: () => ({text: 'next reply'}),
      }),
    });

    const evidence = logStore.readSessionEvidence().stored;
    expect(evidence.rawEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventId: abandonedIdentity.eventId,
          kind: 'runtime_turn_rejected',
          reason: 'writer_process_terminated',
        }),
      ]),
    );
    expect(
      evidence.traceEntries
        .filter(entry => entry.eventId === abandonedIdentity.eventId)
        .map(entry => entry.step),
    ).toEqual([
      'runtime_event_received',
      'raw_event_log_appended',
      'runtime_turn_rejected',
    ]);
    // The abandoned turn committed its message before dying, so it is
    // history: the rejected terminal closes the turn around it.
    expect(evidence.conversationMessages.map(message => message.text)).toEqual([
      'abandoned input',
      'next input',
      'next reply',
    ]);
    // The tool changed durable state before the crash, so its call stays
    // on the terminal: inspect reads tool events through these IDs.
    expect(
      evidence.rawEvents.find(
        record =>
          record.eventId === abandonedIdentity.eventId &&
          record.kind === 'runtime_turn_rejected',
      )?.toolCallIds,
    ).toEqual([abandonedToolCallId]);
    expect(existsSync(abandonedTempPath)).toBe(false);
  });

  it('rejects foreign recoverable evidence before changing any evidence file', async () => {
    const storeRoot = createTestTempRoot('project02-writer-foreign-recovery-');
    const sessionId = 'reject-foreign-open-turn';
    const completedIdentity = {
      eventId: 'evt_foreign_completed',
      traceId: 'trace_foreign_completed',
      createdAt: '2026-07-11T00:00:00.000Z',
    } as const;
    const foreignCharacter = {
      id: 'nova',
      displayName: 'Nova',
    } as const;
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      sessionId,
      createdAt: completedIdentity.createdAt,
    });
    const boundedLogStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: 'mira',
      boundCharacter: testCharacterProfile,
    });
    const foreignStoreRoot = createTestTempRoot(
      'project02-writer-foreign-source-',
    );
    await createLocalRuntimeSessionStore({
      storeRoot: foreignStoreRoot,
      characterId: foreignCharacter.id,
    }).createSession({
      sessionId,
      createdAt: completedIdentity.createdAt,
    });
    const foreignLogStore = createFileRuntimeLogStore({
      storeRoot: foreignStoreRoot,
      sessionId,
      characterId: foreignCharacter.id,
      boundCharacter: foreignCharacter,
    });

    await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent('foreign input', completedIdentity),
      session: createConversationSession({
        id: sessionId,
        character: foreignCharacter,
      }),
      logStore: foreignLogStore,
      pluginHost: createRuntimePluginHost(),
      roleModelAdapter: createRoleModelAdapterFromCharacterAgent({
        reply: () => ({text: 'foreign reply'}),
      }),
    });

    const foreignPaths = foreignLogStore.localRuntimeSessionPaths;
    const paths = boundedLogStore.localRuntimeSessionPaths;

    if (foreignPaths === undefined || paths === undefined) {
      throw new Error('Expected durable runtime paths.');
    }

    const abandonedIdentity = {
      eventId: 'evt_foreign_abandoned',
      traceId: 'trace_foreign_abandoned',
      createdAt: '2026-07-11T00:00:01.000Z',
    } as const;
    writeJsonLines(paths.tracePath, [
      ...readJsonLines(foreignPaths.tracePath),
      {...abandonedIdentity, step: 'runtime_event_received'},
    ]);
    writeJsonLines(paths.rawEventsPath, [
      ...readJsonLines(foreignPaths.rawEventsPath),
      {
        ...abandonedIdentity,
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE',
      },
      {
        ...abandonedIdentity,
        kind: 'runtime_event_normalized',
        eventType: 'USER_MESSAGE',
      },
      {
        ...abandonedIdentity,
        kind: 'visible_message_committed',
        eventType: 'USER_MESSAGE',
        visibleMessageIds: [`${sessionId}:message-3`],
        visibleMessage: {
          id: `${sessionId}:message-3`,
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'abandoned input',
        },
        committedAt: abandonedIdentity.createdAt,
      },
    ]);
    const evidenceBeforeRecovery = {
      trace: readFileSync(paths.tracePath, 'utf8'),
      rawEvents: readFileSync(paths.rawEventsPath, 'utf8'),
    };

    await expect(
      runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent('next input', {
          eventId: 'evt_after_foreign_recovery',
          traceId: 'trace_after_foreign_recovery',
          createdAt: '2026-07-11T00:00:02.000Z',
        }),
        session: createConversationSession({
          id: sessionId,
          character: testCharacterProfile,
        }),
        logStore: boundedLogStore,
        pluginHost: createRuntimePluginHost(),
        roleModelAdapter: createRoleModelAdapterFromCharacterAgent({
          reply: () => ({text: 'next reply'}),
        }),
      }),
    ).rejects.toBeDefined();

    expect(readFileSync(paths.tracePath, 'utf8')).toBe(
      evidenceBeforeRecovery.trace,
    );
    expect(readFileSync(paths.rawEventsPath, 'utf8')).toBe(
      evidenceBeforeRecovery.rawEvents,
    );
  });

  it('fails partial_write instead of guessing how to recover trace-only evidence', async () => {
    const storeRoot = createTestTempRoot('project02-writer-trace-only-');
    const sessionId = 'trace-only-turn';
    const identity = {
      eventId: 'evt_trace_only',
      traceId: 'trace_trace_only',
      createdAt: '2026-07-11T00:00:00.000Z',
    } as const;
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      sessionId,
      createdAt: identity.createdAt,
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: 'mira',
      boundCharacter: testCharacterProfile,
    });
    const paths = logStore.localRuntimeSessionPaths;

    if (paths === undefined) {
      throw new Error('Expected durable runtime paths.');
    }

    writeJsonLines(paths.tracePath, [
      {...identity, step: 'runtime_event_received'},
    ]);

    await expect(
      runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent('next input'),
        session: createConversationSession({
          id: sessionId,
          character: testCharacterProfile,
        }),
        logStore,
        pluginHost: createRuntimePluginHost(),
        roleModelAdapter: createRoleModelAdapterFromCharacterAgent({
          reply: () => ({text: 'next reply'}),
        }),
      }),
    ).rejects.toMatchObject({code: 'partial_write'});
  });
});

function writeJsonLines(filePath: string, records: readonly object[]): void {
  writeFileSync(
    filePath,
    records.map(record => `${JSON.stringify(record)}\n`).join(''),
    'utf8',
  );
}

function readJsonLines(filePath: string): Record<string, unknown>[] {
  return readFileSync(filePath, 'utf8')
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}
