import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
    expect(store.appendConversationMessage(userMessage)).toEqual(userMessage);
    expect(store.appendConversationMessage(characterMessage)).toEqual(characterMessage);
    expect(store.appendRawEvent(completedRawEvent)).toEqual(completedRawEvent);

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
      status: 'completed',
      visibleMessageIds: ['alpha:message-1', 'alpha:message-2']
    };
    const betaRaw: RawEventLogRecordInput = {
      ...identity,
      eventId: 'evt_beta',
      traceId: 'trace_beta',
      kind: 'runtime_turn_completed',
      eventType: 'USER_MESSAGE',
      status: 'completed',
      visibleMessageIds: ['beta:message-1', 'beta:message-2']
    };
    const alphaMessage = createConversationRecord({
      eventId: 'evt_alpha',
      traceId: 'trace_alpha',
      id: 'alpha:message-1',
      role: 'user',
      speakerId: 'local-user',
      speakerName: 'You',
      text: 'alpha message'
    });
    const alphaReply = createConversationRecord({
      eventId: 'evt_alpha',
      traceId: 'trace_alpha',
      id: 'alpha:message-2',
      role: 'character',
      speakerId: 'mira',
      speakerName: 'Mira',
      text: 'alpha reply'
    });
    const betaMessage = createConversationRecord({
      eventId: 'evt_beta',
      traceId: 'trace_beta',
      id: 'beta:message-1',
      role: 'user',
      speakerId: 'local-user',
      speakerName: 'You',
      text: 'beta message'
    });
    const betaReply = createConversationRecord({
      eventId: 'evt_beta',
      traceId: 'trace_beta',
      id: 'beta:message-2',
      role: 'character',
      speakerId: 'mira',
      speakerName: 'Mira',
      text: 'beta reply'
    });

    alpha.appendTrace(alphaTrace);
    alpha.appendConversationMessage(alphaMessage);
    alpha.appendConversationMessage(alphaReply);
    alpha.appendRawEvent(alphaRaw);
    beta.appendTrace(betaTrace);
    beta.appendConversationMessage(betaMessage);
    beta.appendConversationMessage(betaReply);
    beta.appendRawEvent(betaRaw);

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
    ).toEqual([alphaMessage, alphaReply]);
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
    ).toEqual([betaMessage, betaReply]);
  });

  it('protects persisted records from mutable append inputs and read snapshots', async () => {
    const storeRoot = createTempStoreRoot();
    const store = await createCatalogedFileRuntimeLogStore(storeRoot, 'mira-local');
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

    store.appendConversationMessage(userMessage);
    store.appendConversationMessage(characterMessage);

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

  it('fails missing conversation logs when prior raw events reference visible messages', async () => {
    const storeRoot = createTempStoreRoot();
    await createCatalogedSession(storeRoot, 'mira-local');
    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'mira-local'
    });

    writeVisibleRawEvidence(paths);

    const store = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'mira-local'
    });

    expectStorageErrorCode(() => store.rawEvents(), 'missing_file');
    expectStorageErrorCode(() => store.conversationMessages(), 'missing_file');
    expectStorageErrorCode(
      () =>
        store.appendConversationMessage(createConversationRecord({
          id: 'mira-local:message-3',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'next'
        })),
      'missing_file'
    );
  });

  it('fails empty or incomplete conversation logs when raw events reference visible messages', async () => {
    const emptyStoreRoot = createTempStoreRoot();
    await createCatalogedSession(emptyStoreRoot, 'mira-local');
    const emptyPaths = createLocalRuntimeSessionPaths({
      storeRoot: emptyStoreRoot,
      sessionId: 'mira-local'
    });

    writeVisibleRawEvidence(emptyPaths);
    writeFileSync(emptyPaths.conversationPath, '', 'utf8');

    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot: emptyStoreRoot,
          sessionId: 'mira-local'
        }).conversationMessages(),
      'malformed_record'
    );

    const incompleteStoreRoot = createTempStoreRoot();
    await createCatalogedSession(incompleteStoreRoot, 'mira-local');
    const incompletePaths = createLocalRuntimeSessionPaths({
      storeRoot: incompleteStoreRoot,
      sessionId: 'mira-local'
    });

    writeVisibleRawEvidence(incompletePaths);
    writeFileSync(
      incompletePaths.conversationPath,
      `${JSON.stringify(createConversationRecord({
        id: 'mira-local:message-1',
        role: 'user',
        speakerId: 'local-user',
        speakerName: 'You',
        text: 'hello'
      }))}\n`,
      'utf8'
    );

    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot: incompleteStoreRoot,
          sessionId: 'mira-local'
        }).conversationMessages(),
      'malformed_record'
    );
  });

  it('fails missing raw or trace logs when a session has other durable evidence', async () => {
    const missingRawStoreRoot = createTempStoreRoot();
    await createCatalogedSession(missingRawStoreRoot, 'mira-local');
    const missingRawPaths = createLocalRuntimeSessionPaths({
      storeRoot: missingRawStoreRoot,
      sessionId: 'mira-local'
    });

    writeConversationPair(missingRawPaths);

    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot: missingRawStoreRoot,
          sessionId: 'mira-local'
        }).rawEvents(),
      'missing_file'
    );

    const missingTraceStoreRoot = createTempStoreRoot();
    await createCatalogedSession(missingTraceStoreRoot, 'mira-local');
    const missingTracePaths = createLocalRuntimeSessionPaths({
      storeRoot: missingTraceStoreRoot,
      sessionId: 'mira-local'
    });

    writeRawEventOnly(missingTracePaths);

    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot: missingTraceStoreRoot,
          sessionId: 'mira-local'
        }).traceEntries(),
      'missing_file'
    );
  });

  it('fails conversation records that only have nonterminal raw-event evidence', async () => {
    const storeRoot = createTempStoreRoot();
    await createCatalogedSession(storeRoot, 'mira-local');
    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'mira-local'
    });

    writeConversationPair(paths);
    writeFileSync(
      paths.rawEventsPath,
      `${JSON.stringify({
        ...identity,
        kind: 'visible_reply_committed',
        eventType: 'USER_MESSAGE',
        visibleMessageIds: ['mira-local:message-1', 'mira-local:message-2']
      })}\n`,
      'utf8'
    );

    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot,
          sessionId: 'mira-local'
        }).conversationMessages(),
      'malformed_record'
    );
  });

  it('rejects a new append after an incomplete conversation pair', async () => {
    const storeRoot = createTempStoreRoot();
    await createCatalogedSession(storeRoot, 'mira-local');
    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'mira-local'
    });

    writeFileSync(
      paths.conversationPath,
      `${JSON.stringify(createConversationRecord({
        id: 'mira-local:message-1',
        role: 'user',
        speakerId: 'local-user',
        speakerName: 'You',
        text: 'hello'
      }))}\n`,
      'utf8'
    );

    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot,
          sessionId: 'mira-local'
        }).appendConversationMessage(createConversationRecord({
          id: 'mira-local:message-3',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'next'
        })),
      'malformed_record'
    );
  });

  it('rejects starting another visible turn before existing messages have terminal evidence', async () => {
    const storeRoot = createTempStoreRoot();
    await createCatalogedSession(storeRoot, 'mira-local');
    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'mira-local'
    });

    writeConversationPair(paths);

    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot,
          sessionId: 'mira-local'
        }).appendConversationMessage(createConversationRecord({
          id: 'mira-local:message-3',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'next'
        })),
      'malformed_record'
    );
  });

  it('validates appended conversation records against session transcript invariants before writing', async () => {
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
    const firstUser = createConversationRecord({
      id: 'mira-local:message-1',
      role: 'user',
      speakerId: 'local-user',
      speakerName: 'You',
      text: 'hello'
    });

    expectStorageErrorCode(
      () =>
        store.appendConversationMessage(createConversationRecord({
          id: 'mira-local:message-2',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'bad first message id'
        })),
      'malformed_record'
    );
    expect(existsSync(paths.conversationPath)).toBe(false);

    expect(store.appendConversationMessage(firstUser)).toEqual(firstUser);
    expectStorageErrorCode(
      () =>
        store.appendConversationMessage(createConversationRecord({
          id: 'mira-local:message-3',
          role: 'character',
          speakerId: 'mira',
          speakerName: 'Mira',
          text: 'bad paired message id'
        })),
      'malformed_record'
    );
    expect(readConversationFile(paths)).toEqual([firstUser]);
  });

  it('rejects malformed restored visible-message order before exposing records', async () => {
    const storeRoot = createTempStoreRoot();
    await createCatalogedSession(storeRoot, 'mira-local');
    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'mira-local'
    });

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
        JSON.stringify(createConversationRecord({
          id: 'mira-local:message-2',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'second user'
        })),
        ''
      ].join('\n'),
      'utf8'
    );
    writeFileSync(
      paths.rawEventsPath,
      `${JSON.stringify({
        ...identity,
        kind: 'runtime_turn_completed',
        eventType: 'USER_MESSAGE',
        status: 'completed',
        visibleMessageIds: ['mira-local:message-1', 'mira-local:message-2']
      })}\n`,
      'utf8'
    );

    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot,
          sessionId: 'mira-local'
        }).conversationMessages(),
      'malformed_record'
    );
  });

  it('rejects terminal raw evidence that references visible messages from another event identity', async () => {
    const appendStoreRoot = createTempStoreRoot();
    const appendStore = await createCatalogedFileRuntimeLogStore(appendStoreRoot, 'mira-local');
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

    appendStore.appendConversationMessage(userMessage);
    appendStore.appendConversationMessage(characterMessage);
    expectStorageErrorCode(
      () =>
        appendStore.appendRawEvent({
          ...identity,
          eventId: 'evt_other_turn',
          traceId: 'trace_other_turn',
          kind: 'runtime_turn_completed',
          eventType: 'USER_MESSAGE',
          status: 'completed',
          visibleMessageIds: ['mira-local:message-1', 'mira-local:message-2']
        }),
      'malformed_record'
    );

    const readStoreRoot = createTempStoreRoot();
    await createCatalogedSession(readStoreRoot, 'mira-local');
    const readPaths = createLocalRuntimeSessionPaths({
      storeRoot: readStoreRoot,
      sessionId: 'mira-local'
    });

    writeConversationPair(readPaths);
    writeFileSync(
      readPaths.rawEventsPath,
      `${JSON.stringify({
        ...identity,
        eventId: 'evt_other_turn',
        traceId: 'trace_other_turn',
        kind: 'runtime_turn_completed',
        eventType: 'USER_MESSAGE',
        status: 'completed',
        visibleMessageIds: ['mira-local:message-1', 'mira-local:message-2']
      })}\n`,
      'utf8'
    );
    const readStore = createFileRuntimeLogStore({
      storeRoot: readStoreRoot,
      sessionId: 'mira-local'
    });

    expectStorageErrorCode(() => readStore.rawEvents(), 'malformed_record');
    expectStorageErrorCode(
      () => readStore.conversationMessages(),
      'malformed_record'
    );
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

function writeVisibleRawEvidence(
  paths: ReturnType<typeof createLocalRuntimeSessionPaths>
): void {
  writeFileSync(
    paths.tracePath,
    `${JSON.stringify({
      ...identity,
      step: 'visible_reply_committed'
    })}\n`,
    'utf8'
  );
  writeFileSync(
    paths.rawEventsPath,
    `${JSON.stringify({
      ...identity,
      kind: 'runtime_turn_completed',
      eventType: 'USER_MESSAGE',
      status: 'completed',
      visibleMessageIds: ['mira-local:message-1', 'mira-local:message-2']
    })}\n`,
    'utf8'
  );
}

function writeConversationPair(
  paths: ReturnType<typeof createLocalRuntimeSessionPaths>
): void {
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
      JSON.stringify(createConversationRecord({
        id: 'mira-local:message-2',
        role: 'character',
        speakerId: 'mira',
        speakerName: 'Mira',
        text: "I'm here. Tell me what you need."
      })),
      ''
    ].join('\n'),
    'utf8'
  );
}

function writeRawEventOnly(
  paths: ReturnType<typeof createLocalRuntimeSessionPaths>
): void {
  writeFileSync(
    paths.rawEventsPath,
    `${JSON.stringify({
      ...identity,
      kind: 'runtime_turn_completed',
      eventType: 'USER_MESSAGE',
      status: 'completed',
      visibleMessageIds: ['mira-local:message-1', 'mira-local:message-2']
    })}\n`,
    'utf8'
  );
}

function readConversationFile(
  paths: ReturnType<typeof createLocalRuntimeSessionPaths>
): readonly unknown[] {
  return readFileSync(paths.conversationPath, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
}

function createConversationRecord(options: {
  readonly eventId?: string;
  readonly traceId?: string;
  readonly id: string;
  readonly role: 'user' | 'character';
  readonly speakerId: string;
  readonly speakerName: string;
  readonly text: string;
}): ConversationLogRecordInput {
  return {
    ...identity,
    ...(options.eventId === undefined ? {} : { eventId: options.eventId }),
    ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
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
