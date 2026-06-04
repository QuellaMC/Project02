import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createFileRuntimeLogStore,
  createLocalRuntimeSessionStore,
  createLocalRuntimeSessionPaths,
  LocalRuntimeStorageContractError,
  LocalRuntimeSessionStoreError,
  recordLocalUserMessageInputRejection,
  type ConversationLogRecordInput,
  type LocalRuntimeStorageContractErrorCode,
  type LocalRuntimeSessionStoreErrorCode,
  type RawEventLogRecordInput,
  type RuntimeTraceEntryInput
} from '../src/index.ts';

const createdAt = '2026-06-04T10:00:00.000Z';
const committedAt = '2026-06-04T10:00:01.000Z';
const tempStoreRoots: string[] = [];

const identity = {
  eventId: 'evt_file_log_001',
  traceId: 'trace_file_log_001',
  createdAt
} as const;

describe('file-backed runtime log store', () => {
  afterEach(() => {
    for (const storeRoot of tempStoreRoots.splice(0)) {
      rmSync(storeRoot, { recursive: true, force: true });
    }
  });

  it('appends trace, raw event, and conversation records in order and survives reopen', async () => {
    const storeRoot = createTempStoreRoot();
    const store = await createCatalogedFileRuntimeLogStore(storeRoot, 'mira-local');
    const receivedTrace: RuntimeTraceEntryInput = {
      ...identity,
      step: 'runtime_event_received'
    };
    const completedTrace: RuntimeTraceEntryInput = {
      ...identity,
      step: 'runtime_turn_completed'
    };
    const receivedRawEvent: RawEventLogRecordInput = {
      ...identity,
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE',
      payloadSummary: {
        rawInput: ' hello '
      }
    };
    const completedRawEvent: RawEventLogRecordInput = {
      ...identity,
      kind: 'runtime_turn_completed',
      eventType: 'USER_MESSAGE',
      status: 'completed',
      visibleMessageIds: ['mira-local:message-1', 'mira-local:message-2'],
      payloadSummary: {
        rawInput: ' hello ',
        normalizedCurrentUserMessage: 'hello'
      }
    };
    const userMessage = createConversationRecord({
      id: 'mira-local:message-1',
      role: 'user',
      speakerId: 'local-user',
      speakerName: 'You',
      text: 'hello'
    });
    const characterMessage = createConversationRecord({
      id: 'mira-local:message-2',
      role: 'character',
      speakerId: 'mira',
      speakerName: 'Mira',
      text: "I'm here. Tell me what you need."
    });

    expect(store.appendTrace(receivedTrace)).toEqual(receivedTrace);
    expect(store.appendTrace(completedTrace)).toEqual(completedTrace);
    expect(store.appendRawEvent(receivedRawEvent)).toEqual(receivedRawEvent);
    expect(store.appendRawEvent(completedRawEvent)).toEqual(completedRawEvent);
    expect(store.appendConversationMessage(userMessage)).toEqual(userMessage);
    expect(store.appendConversationMessage(characterMessage)).toEqual(characterMessage);

    const reopened = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'mira-local'
    });

    expect(reopened.traceEntries()).toEqual([receivedTrace, completedTrace]);
    expect(reopened.rawEvents()).toEqual([receivedRawEvent, completedRawEvent]);
    expect(reopened.conversationMessages()).toEqual([userMessage, characterMessage]);
  });

  it('keeps two selected sessions separate', async () => {
    const storeRoot = createTempStoreRoot();
    await createCatalogedSession(storeRoot, 'alpha');
    await createCatalogedSession(storeRoot, 'beta');
    const alpha = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'alpha'
    });
    const beta = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'beta'
    });
    const alphaTrace: RuntimeTraceEntryInput = {
      ...identity,
      eventId: 'evt_alpha',
      traceId: 'trace_alpha',
      step: 'runtime_event_received'
    };
    const betaTrace: RuntimeTraceEntryInput = {
      ...identity,
      eventId: 'evt_beta',
      traceId: 'trace_beta',
      step: 'runtime_turn_completed'
    };
    const alphaRaw: RawEventLogRecordInput = {
      ...identity,
      eventId: 'evt_alpha',
      traceId: 'trace_alpha',
      kind: 'runtime_turn_completed',
      eventType: 'USER_MESSAGE',
      status: 'completed'
    };
    const betaRaw: RawEventLogRecordInput = {
      ...identity,
      eventId: 'evt_beta',
      traceId: 'trace_beta',
      kind: 'runtime_turn_rejected',
      eventType: 'USER_MESSAGE',
      status: 'rejected',
      reason: 'Provide exactly one non-empty message.'
    };
    const alphaMessage = createConversationRecord({
      id: 'alpha:message-1',
      role: 'user',
      speakerId: 'local-user',
      speakerName: 'You',
      text: 'alpha message'
    });
    const betaMessage = createConversationRecord({
      id: 'beta:message-1',
      role: 'user',
      speakerId: 'local-user',
      speakerName: 'You',
      text: 'beta message'
    });

    alpha.appendTrace(alphaTrace);
    alpha.appendRawEvent(alphaRaw);
    alpha.appendConversationMessage(alphaMessage);
    beta.appendTrace(betaTrace);
    beta.appendRawEvent(betaRaw);
    beta.appendConversationMessage(betaMessage);

    expect(
      createFileRuntimeLogStore({
        storeRoot,
        sessionId: 'alpha'
      }).traceEntries()
    ).toEqual([alphaTrace]);
    expect(
      createFileRuntimeLogStore({
        storeRoot,
        sessionId: 'alpha'
      }).rawEvents()
    ).toEqual([alphaRaw]);
    expect(
      createFileRuntimeLogStore({
        storeRoot,
        sessionId: 'alpha'
      }).conversationMessages()
    ).toEqual([alphaMessage]);
    expect(
      createFileRuntimeLogStore({
        storeRoot,
        sessionId: 'beta'
      }).traceEntries()
    ).toEqual([betaTrace]);
    expect(
      createFileRuntimeLogStore({
        storeRoot,
        sessionId: 'beta'
      }).rawEvents()
    ).toEqual([betaRaw]);
    expect(
      createFileRuntimeLogStore({
        storeRoot,
        sessionId: 'beta'
      }).conversationMessages()
    ).toEqual([betaMessage]);
  });

  it('protects persisted records from mutable append inputs and read snapshots', async () => {
    const storeRoot = createTempStoreRoot();
    const store = await createCatalogedFileRuntimeLogStore(storeRoot, 'mira-local');
    const visibleMessageIds = ['mira-local:message-1', 'mira-local:message-2'];
    const payloadSummary = {
      normalizedCurrentUserMessage: 'hello'
    };
    const rawEvent: RawEventLogRecordInput = {
      ...identity,
      kind: 'runtime_turn_completed',
      eventType: 'USER_MESSAGE',
      status: 'completed',
      visibleMessageIds,
      payloadSummary
    };

    const appended = store.appendRawEvent(rawEvent);

    visibleMessageIds.push('mira-local:message-3');
    payloadSummary.normalizedCurrentUserMessage = 'mutated after append';

    const rawSnapshot = store.rawEvents();
    const firstRawSnapshot = rawSnapshot.at(0);

    if (firstRawSnapshot === undefined) {
      throw new Error('Expected raw event snapshot to contain one record.');
    }

    expect(Object.isFrozen(rawSnapshot)).toBe(true);
    expect(Object.isFrozen(firstRawSnapshot)).toBe(true);
    expect(Object.isFrozen(firstRawSnapshot.visibleMessageIds)).toBe(true);
    expect(Object.isFrozen(firstRawSnapshot.payloadSummary)).toBe(true);
    expect(Reflect.set(rawSnapshot, '0', {
      ...identity,
      kind: 'runtime_turn_rejected',
      eventType: 'USER_MESSAGE',
      status: 'rejected'
    } satisfies RawEventLogRecordInput)).toBe(false);
    expect(Reflect.set(firstRawSnapshot, 'eventId', 'evt_mutated')).toBe(false);
    expect(store.rawEvents()).toEqual([
      {
        ...appended,
        visibleMessageIds: ['mira-local:message-1', 'mira-local:message-2'],
        payloadSummary: {
          normalizedCurrentUserMessage: 'hello'
        }
      }
    ]);

    const reopened = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'mira-local'
    });

    expect(reopened.rawEvents()).toEqual([
      {
        ...identity,
        kind: 'runtime_turn_completed',
        eventType: 'USER_MESSAGE',
        status: 'completed',
        visibleMessageIds: ['mira-local:message-1', 'mira-local:message-2'],
        payloadSummary: {
          normalizedCurrentUserMessage: 'hello'
        }
      }
    ]);
  });

  it('persists rejected runtime outcomes without adding visible conversation records', async () => {
    const storeRoot = createTempStoreRoot();
    const store = await createCatalogedFileRuntimeLogStore(storeRoot, 'mira-local');

    recordLocalUserMessageInputRejection({
      identity,
      logStore: store,
      message: 'Provide exactly one non-empty message.',
      rawInput: ''
    });

    const reopened = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'mira-local'
    });

    expect(reopened.rawEvents()).toContainEqual({
      ...identity,
      kind: 'runtime_turn_rejected',
      eventType: 'USER_MESSAGE',
      status: 'rejected',
      reason: 'Provide exactly one non-empty message.',
      payloadSummary: {
        rawInput: ''
      }
    });
    expect(reopened.traceEntries().map((entry) => entry.step)).toEqual([
      'runtime_event_received',
      'input_validation_rejected',
      'raw_event_log_appended',
      'runtime_turn_rejected'
    ]);
    expect(reopened.conversationMessages()).toEqual([]);
  });

  it('does not create orphan log files for uncataloged sessions', async () => {
    const storeRoot = createTempStoreRoot();
    await createCatalogedSession(storeRoot, 'existing');
    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'orphan'
    });
    const store = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'orphan'
    });

    expectSessionStoreErrorCode(
      () =>
        store.appendTrace({
          ...identity,
          step: 'runtime_event_received'
        }),
      'session_not_found'
    );
    expectSessionStoreErrorCode(() => store.traceEntries(), 'session_not_found');
    expect(existsSync(paths.tracePath)).toBe(false);
  });

  it('fails partial JSONL records with CT-01 partial-write errors', async () => {
    const storeRoot = createTempStoreRoot();
    await createCatalogedSession(storeRoot, 'mira-local');
    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'mira-local'
    });

    writeFileSync(
      paths.tracePath,
      JSON.stringify({
        ...identity,
        step: 'runtime_event_received'
      }),
      'utf8'
    );

    const store = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'mira-local'
    });

    expectStorageErrorCode(() => store.traceEntries(), 'partial_write');
    expectStorageErrorCode(
      () =>
        store.appendTrace({
          ...identity,
          step: 'runtime_turn_completed'
        }),
      'partial_write'
    );
  });

  it('wraps filesystem read failures with CT-01 read-failed errors', async () => {
    const storeRoot = createTempStoreRoot();
    await createCatalogedSession(storeRoot, 'mira-local');
    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'mira-local'
    });

    mkdirSync(paths.tracePath, { recursive: true });

    const store = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'mira-local'
    });

    expectStorageErrorCode(() => store.traceEntries(), 'read_failed');
  });

  it('wraps filesystem write failures with CT-01 write-failed errors', async () => {
    const storeRoot = createTempStoreRoot();
    await createCatalogedSession(storeRoot, 'mira-local');
    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'mira-local'
    });

    const store = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'mira-local'
    });

    chmodSync(paths.sessionRoot, 0o500);

    try {
      expectStorageErrorCode(
        () =>
          store.appendTrace({
            ...identity,
            step: 'runtime_event_received'
          }),
        'write_failed'
      );
    } finally {
      chmodSync(paths.sessionRoot, 0o700);
    }
  });

  it('fails corrupt or malformed JSONL records with CT-01 typed errors', async () => {
    const storeRoot = createTempStoreRoot();
    await createCatalogedSession(storeRoot, 'mira-local');
    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'mira-local'
    });

    writeFileSync(paths.tracePath, '{"eventId":"evt_missing_fields"}\n', 'utf8');
    writeFileSync(paths.rawEventsPath, '{not json}\n', 'utf8');
    writeFileSync(
      paths.conversationPath,
      [
        JSON.stringify(createConversationRecord({
          id: 'mira-local:message-1',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'hello'
        })),
        '',
        JSON.stringify(createConversationRecord({
          id: 'mira-local:message-2',
          role: 'character',
          speakerId: 'mira',
          speakerName: 'Mira',
          text: 'reply'
        }))
      ].join('\n'),
      'utf8'
    );

    const store = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'mira-local'
    });

    expect(() => store.traceEntries()).toThrow(LocalRuntimeStorageContractError);
    expect(() => store.rawEvents()).toThrow(LocalRuntimeStorageContractError);
    expect(() => store.conversationMessages()).toThrow(
      LocalRuntimeStorageContractError
    );

    try {
      store.rawEvents();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(LocalRuntimeStorageContractError);

      if (!(error instanceof LocalRuntimeStorageContractError)) {
        throw new Error('Expected LocalRuntimeStorageContractError.', {
          cause: error
        });
      }

      expect(error.code).toBe('malformed_record');
      return;
    }

    throw new Error('Expected malformed raw event log to be rejected.');
  });
});

function createTempStoreRoot(): string {
  const storeRoot = mkdtempSync(join(tmpdir(), 'project02-file-runtime-log-store-'));

  tempStoreRoots.push(storeRoot);
  return storeRoot;
}

async function createCatalogedFileRuntimeLogStore(
  storeRoot: string,
  sessionId: string
): Promise<ReturnType<typeof createFileRuntimeLogStore>> {
  await createCatalogedSession(storeRoot, sessionId);

  return createFileRuntimeLogStore({
    storeRoot,
    sessionId
  });
}

async function createCatalogedSession(
  storeRoot: string,
  sessionId: string
): Promise<void> {
  const sessionStore = createLocalRuntimeSessionStore({
    storeRoot,
    now: () => createdAt
  });

  await sessionStore.createSession({
    sessionId,
    createdAt,
    updatedAt: createdAt
  });
}

function createConversationRecord(options: {
  readonly id: string;
  readonly role: 'user' | 'character';
  readonly speakerId: string;
  readonly speakerName: string;
  readonly text: string;
}): ConversationLogRecordInput {
  return {
    ...identity,
    id: options.id,
    role: options.role,
    speakerId: options.speakerId,
    speakerName: options.speakerName,
    text: options.text,
    committedAt
  };
}

function expectStorageErrorCode(
  operation: () => unknown,
  code: LocalRuntimeStorageContractErrorCode
): void {
  try {
    operation();
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

function expectSessionStoreErrorCode(
  operation: () => unknown,
  code: LocalRuntimeSessionStoreErrorCode
): void {
  try {
    operation();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(LocalRuntimeSessionStoreError);

    if (!(error instanceof LocalRuntimeSessionStoreError)) {
      throw new Error('Expected LocalRuntimeSessionStoreError.', {
        cause: error
      });
    }

    expect(error.code).toBe(code);
    return;
  }

  throw new Error(`Expected local runtime session store error code "${code}".`);
}
