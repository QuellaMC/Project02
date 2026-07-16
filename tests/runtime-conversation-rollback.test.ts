import { describe, expect, it } from 'vitest';

import { createConversationSession } from '../src/core/conversation.ts';
import { createRuntimePluginHost } from '../src/plugins/host.ts';
import {
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent
} from '../src/core/message-event.ts';
import { runLocalUserMessageEvent } from '../src/runtime/local.ts';
import {
  createRuntimeLogStore,
  type RuntimeLogStore
} from '../src/runtime/log.ts';
import { createFileRuntimeLogStore } from '../src/runtime/storage/file-runtime-log-store.ts';
import { createLocalRuntimeSessionStore } from '../src/runtime/storage/session-store.ts';
import { createTestTempRoot } from './support/temp-root.ts';

describe('runtime conversation rollback failures', () => {
  it('preserves a failed user-row rollback for the next durable writer to recover', async () => {
    const storeRoot = createTestTempRoot('project02-user-row-recovery-');
    const sessionId = 'recover-failed-user-row-rollback';
    const failedIdentity = {
      eventId: 'evt_failed_user_row_rollback',
      traceId: 'trace_failed_user_row_rollback',
      createdAt: '2026-07-11T00:00:00.000Z'
    } as const;
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: failedIdentity.createdAt
    });
    const underlying = createFileRuntimeLogStore({ storeRoot, sessionId });
    const appendFailure = new Error('user row persisted before append failed');
    const cleanupFailure = new Error('durable user-row rollback failed');
    let appendCount = 0;
    const failingStore = Object.freeze({
      ...(underlying.localRuntimeSessionPaths === undefined
        ? {}
        : { localRuntimeSessionPaths: underlying.localRuntimeSessionPaths }),
      ...(underlying.localRuntimeWriterLockOwnerToken === undefined
        ? {}
        : {
            localRuntimeWriterLockOwnerToken:
              underlying.localRuntimeWriterLockOwnerToken
          }),
      appendTrace: (entry) => underlying.appendTrace(entry),
      appendRawEvent: (record) => underlying.appendRawEvent(record),
      appendConversationMessage(record) {
        appendCount += 1;
        const stored = underlying.appendConversationMessage(record);

        if (appendCount === 1) {
          throw appendFailure;
        }

        return stored;
      },
      removeConversationMessages() {
        throw cleanupFailure;
      },
      recoverAbandonedWriterEvidence: () =>
        underlying.recoverAbandonedWriterEvidence?.() ?? false,
      checkpointWriterEvidence: () =>
        underlying.checkpointWriterEvidence?.(),
      readSessionEvidence: () => underlying.readSessionEvidence(),
      traceEntries: () => underlying.traceEntries(),
      rawEvents: () => underlying.rawEvents(),
      conversationMessages: () => underlying.conversationMessages()
    } satisfies RuntimeLogStore);
    const failedSession = createConversationSession({ id: sessionId });
    let thrown: unknown;

    try {
      await runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent('failed input', failedIdentity),
        session: failedSession,
        logStore: failingStore,
        pluginHost: createRuntimePluginHost(),
        agent: { reply: () => ({ text: 'failed reply' }) }
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).cause).toBe(appendFailure);
    expect((thrown as AggregateError).errors).toEqual([cleanupFailure]);
    expect(failedSession.visibleTranscript).toEqual([]);

    const reopened = createFileRuntimeLogStore({ storeRoot, sessionId });
    const recoveredSession = createConversationSession({ id: sessionId });

    await expect(
      runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent('next input', {
          eventId: 'evt_after_failed_user_row_rollback',
          traceId: 'trace_after_failed_user_row_rollback',
          createdAt: '2026-07-11T00:00:01.000Z'
        }),
        session: recoveredSession,
        logStore: reopened,
        pluginHost: createRuntimePluginHost(),
        agent: { reply: () => ({ text: 'next reply' }) }
      })
    ).resolves.toMatchObject({ status: 'completed' });

    const recoveredEvidence = reopened.readSessionEvidence().stored;
    expect(recoveredEvidence.rawEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventId: failedIdentity.eventId,
          kind: 'runtime_turn_rejected',
          reason: 'writer_process_terminated'
        })
      ])
    );
    expect(recoveredEvidence.conversationMessages.map((message) => message.text)).toEqual([
      'next input',
      'next reply'
    ]);
  });

  it('preserves a failed character-row rollback for the next durable writer to recover', async () => {
    const storeRoot = createTestTempRoot('project02-character-row-recovery-');
    const sessionId = 'recover-failed-character-row-rollback';
    const failedIdentity = {
      eventId: 'evt_failed_character_row_rollback',
      traceId: 'trace_failed_character_row_rollback',
      createdAt: '2026-07-11T00:00:00.000Z'
    } as const;
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: failedIdentity.createdAt
    });
    const underlying = createFileRuntimeLogStore({ storeRoot, sessionId });
    const appendFailure = new Error(
      'character row persisted before append failed'
    );
    const cleanupFailure = new Error('durable character-row rollback failed');
    let appendCount = 0;
    const failingStore = Object.freeze({
      ...(underlying.localRuntimeSessionPaths === undefined
        ? {}
        : { localRuntimeSessionPaths: underlying.localRuntimeSessionPaths }),
      ...(underlying.localRuntimeWriterLockOwnerToken === undefined
        ? {}
        : {
            localRuntimeWriterLockOwnerToken:
              underlying.localRuntimeWriterLockOwnerToken
          }),
      appendTrace: (entry) => underlying.appendTrace(entry),
      appendRawEvent: (record) => underlying.appendRawEvent(record),
      appendConversationMessage(record) {
        appendCount += 1;
        const stored = underlying.appendConversationMessage(record);

        if (appendCount === 2) {
          throw appendFailure;
        }

        return stored;
      },
      removeConversationMessages() {
        throw cleanupFailure;
      },
      recoverAbandonedWriterEvidence: () =>
        underlying.recoverAbandonedWriterEvidence?.() ?? false,
      checkpointWriterEvidence: () =>
        underlying.checkpointWriterEvidence?.(),
      readSessionEvidence: () => underlying.readSessionEvidence(),
      traceEntries: () => underlying.traceEntries(),
      rawEvents: () => underlying.rawEvents(),
      conversationMessages: () => underlying.conversationMessages()
    } satisfies RuntimeLogStore);
    const failedSession = createConversationSession({ id: sessionId });
    let thrown: unknown;

    try {
      await runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent('failed input', failedIdentity),
        session: failedSession,
        logStore: failingStore,
        pluginHost: createRuntimePluginHost(),
        agent: { reply: () => ({ text: 'failed reply' }) }
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).cause).toBe(appendFailure);
    expect((thrown as AggregateError).errors).toEqual([cleanupFailure]);
    expect(failedSession.visibleTranscript).toEqual([]);

    const reopened = createFileRuntimeLogStore({ storeRoot, sessionId });
    const recoveredSession = createConversationSession({ id: sessionId });

    await expect(
      runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent('next input', {
          eventId: 'evt_after_failed_character_row_rollback',
          traceId: 'trace_after_failed_character_row_rollback',
          createdAt: '2026-07-11T00:00:01.000Z'
        }),
        session: recoveredSession,
        logStore: reopened,
        pluginHost: createRuntimePluginHost(),
        agent: { reply: () => ({ text: 'next reply' }) }
      })
    ).resolves.toMatchObject({ status: 'completed' });

    const recoveredEvidence = reopened.readSessionEvidence().stored;
    expect(recoveredEvidence.rawEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventId: failedIdentity.eventId,
          kind: 'runtime_turn_rejected',
          reason: 'writer_process_terminated'
        })
      ])
    );
    expect(
      recoveredEvidence.conversationMessages.map((message) => message.text)
    ).toEqual(['next input', 'next reply']);
  });

  it('closes durable raw evidence when the first conversation append persists before throwing', async () => {
    const storeRoot = createTestTempRoot('project02-first-append-rollback-');
    const sessionId = 'first-append-post-write-failure';
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-07-11T00:00:00.000Z'
    });
    const underlying = createFileRuntimeLogStore({ storeRoot, sessionId });
    let appendCount = 0;
    const logStore = Object.freeze({
      ...(underlying.localRuntimeSessionPaths === undefined
        ? {}
        : { localRuntimeSessionPaths: underlying.localRuntimeSessionPaths }),
      ...(underlying.localRuntimeWriterLockOwnerToken === undefined
        ? {}
        : {
            localRuntimeWriterLockOwnerToken:
              underlying.localRuntimeWriterLockOwnerToken
          }),
      appendTrace: (entry) => underlying.appendTrace(entry),
      appendRawEvent: (record) => underlying.appendRawEvent(record),
      appendConversationMessage(record) {
        appendCount += 1;
        const stored = underlying.appendConversationMessage(record);

        if (appendCount === 1) {
          throw new Error('user append persisted then failed');
        }

        return stored;
      },
      removeConversationMessages: (messageIds) => {
        underlying.removeConversationMessages(messageIds);
      },
      recoverAbandonedWriterEvidence: () =>
        underlying.recoverAbandonedWriterEvidence?.() ?? false,
      readSessionEvidence: () => underlying.readSessionEvidence(),
      traceEntries: () => underlying.traceEntries(),
      rawEvents: () => underlying.rawEvents(),
      conversationMessages: () => underlying.conversationMessages()
    } satisfies RuntimeLogStore);

    await expect(
      runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent('hello', createRuntimeEventIdentity()),
        session: createConversationSession({ id: sessionId }),
        logStore,
        pluginHost: createRuntimePluginHost(),
        agent: { reply: () => ({ text: 'hello back' }) }
      })
    ).rejects.toThrow('user append persisted then failed');

    const reopened = createFileRuntimeLogStore({ storeRoot, sessionId });
    expect(reopened.conversationMessages()).toEqual([]);
    expect(reopened.rawEvents().at(-1)).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected'
    });
  });

  it('removes both durable message IDs when an append persists before throwing', async () => {
    const session = createConversationSession();
    const underlying = createRuntimeLogStore();
    let appendCount = 0;
    const logStore = Object.freeze({
      appendTrace: (entry) => underlying.appendTrace(entry),
      appendRawEvent: (record) => underlying.appendRawEvent(record),
      appendConversationMessage(record) {
        appendCount += 1;
        const stored = underlying.appendConversationMessage(record);

        if (appendCount === 2) {
          throw new Error('character append persisted then failed');
        }

        return stored;
      },
      removeConversationMessages(messageIds) {
        underlying.removeConversationMessages(messageIds);
      },
      readSessionEvidence: () => underlying.readSessionEvidence(),
      traceEntries: () => underlying.traceEntries(),
      rawEvents: () => underlying.rawEvents(),
      conversationMessages: () => underlying.conversationMessages()
    } satisfies RuntimeLogStore);

    await expect(
      runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent('hello', createRuntimeEventIdentity()),
        session,
        logStore,
        pluginHost: createRuntimePluginHost(),
        agent: { reply: () => ({ text: 'hello back' }) }
      })
    ).rejects.toThrow('character append persisted then failed');

    expect(underlying.conversationMessages()).toEqual([]);
    expect(session.visibleTranscript).toEqual([]);
  });

  it('attempts durable and in-memory cleanup without masking the append failure', async () => {
    const session = createConversationSession();
    const underlying = createRuntimeLogStore();
    let appendCount = 0;
    const logStore = Object.freeze({
      appendTrace(entry) {
        return underlying.appendTrace(entry);
      },
      appendRawEvent(record) {
        return underlying.appendRawEvent(record);
      },
      appendConversationMessage(record) {
        appendCount += 1;

        if (appendCount === 2) {
          throw new Error('character append failed');
        }

        return underlying.appendConversationMessage(record);
      },
      removeConversationMessages() {
        throw new Error('durable rollback failed');
      },
      readSessionEvidence() {
        return underlying.readSessionEvidence();
      },
      traceEntries() {
        return underlying.traceEntries();
      },
      rawEvents() {
        return underlying.rawEvents();
      },
      conversationMessages() {
        return underlying.conversationMessages();
      }
    } satisfies RuntimeLogStore);
    let thrown: unknown;

    try {
      await runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent(
          'hello',
          createRuntimeEventIdentity()
        ),
        session,
        logStore,
        pluginHost: createRuntimePluginHost(),
        agent: { reply: () => ({ text: 'hello back' }) }
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).cause).toMatchObject({
      message: 'character append failed'
    });
    expect((thrown as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'durable rollback failed' })
    ]);
    expect(session.visibleTranscript).toEqual([]);
  });
});
