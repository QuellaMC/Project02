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
  createConversationSession,
  createDefaultCharacterRuntimeState,
  createFileCharacterStateStore,
  createFileRuntimeLogStore,
  createLivingStateBrief,
  createLocalRuntimeSessionStore,
  createLocalRuntimeSessionPaths,
  createUserMessageRuntimeEvent,
  encodeCharacterRuntimeState,
  LocalRuntimeStorageContractError,
  LocalRuntimeSessionStoreError,
  recordLocalUserMessageInputRejection,
  roleModelDecisionContractVersion,
  roleModelVisibleReplyActionName,
  runLocalUserMessageEvent,
  type ConversationLogRecordInput,
  type LocalRuntimeStorageContractErrorCode,
  type LocalRuntimeSessionStoreErrorCode,
  type RawEventLogRecordInput,
  type RoleModelAdapter,
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

type TestRuntimeIdentity = {
  readonly createdAt: string;
  readonly eventId: string;
  readonly traceId: string;
};

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
    expect(store.appendRawEvent(receivedRawEvent)).toEqual(receivedRawEvent);
    expect(store.appendConversationMessage(userMessage)).toEqual(userMessage);
    expect(store.appendConversationMessage(characterMessage)).toEqual(characterMessage);
    expect(store.appendRawEvent(completedRawEvent)).toEqual(completedRawEvent);
    expect(store.appendTrace(completedTrace)).toEqual(completedTrace);

    const reopened = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'mira-local'
    });

    expect(reopened.traceEntries()).toEqual([receivedTrace, completedTrace]);
    expect(reopened.rawEvents()).toEqual([receivedRawEvent, completedRawEvent]);
    expect(reopened.conversationMessages()).toEqual([userMessage, characterMessage]);
  });

  it('rejects public reads when current character state disagrees with accepted patch evidence', async () => {
    const storeRoot = createTempStoreRoot();
    await createCatalogedSession(storeRoot, 'mira-local');
    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'mira-local'
    });
    const roleModelAdapter: RoleModelAdapter = {
      invoke() {
        return {
          rawOutputText: JSON.stringify({
            version: roleModelDecisionContractVersion,
            toolCalls: [
              {
                name: roleModelVisibleReplyActionName,
                input: {
                  text: 'stateful reply'
                }
              },
              {
                name: 'character_state.patch',
                input: {
                  mood: 'curious'
                }
              }
            ]
          })
        };
      }
    };
    const result = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent('hello', identity),
      session: createConversationSession({
        id: 'mira-local'
      }),
      logStore: createFileRuntimeLogStore({
        storeRoot,
        sessionId: 'mira-local'
      }),
      characterStateStore: createFileCharacterStateStore({
        storeRoot,
        sessionId: 'mira-local'
      }),
      roleModelAdapter
    });

    expect(result.status).toBe('completed');

    writeFileSync(
      paths.characterStatePath,
      `${encodeCharacterRuntimeState(createDefaultCharacterRuntimeState())}\n`,
      'utf8'
    );

    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot,
          sessionId: 'mira-local'
        }).rawEvents(),
      'malformed_record'
    );
  });

  it('rejects public reads when patch evidence session disagrees with session path', async () => {
    const storeRoot = createTempStoreRoot();
    await createCatalogedSession(storeRoot, 'mira-local');
    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'mira-local'
    });
    const roleModelAdapter: RoleModelAdapter = {
      invoke() {
        return {
          rawOutputText: JSON.stringify({
            version: roleModelDecisionContractVersion,
            toolCalls: [
              {
                name: roleModelVisibleReplyActionName,
                input: {
                  text: 'stateful reply'
                }
              },
              {
                name: 'character_state.patch',
                input: {
                  mood: 'curious'
                }
              }
            ]
          })
        };
      }
    };
    const result = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent('hello', identity),
      session: createConversationSession({
        id: 'mira-local'
      }),
      logStore: createFileRuntimeLogStore({
        storeRoot,
        sessionId: 'mira-local'
      }),
      characterStateStore: createFileCharacterStateStore({
        storeRoot,
        sessionId: 'mira-local'
      }),
      roleModelAdapter
    });

    expect(result.status).toBe('completed');

    const rewrittenRawEvents = readFileSync(paths.rawEventsPath, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => {
        const record = mutableJsonRecordFromLine(line);
        const snapshot = record['characterStatePatchSnapshot'];

        if (isMutableRecord(snapshot)) {
          snapshot['sessionId'] = 'other-session';
        }

        return JSON.stringify(record);
      })
      .join('\n');

    writeFileSync(paths.rawEventsPath, `${rewrittenRawEvents}\n`, 'utf8');

    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot,
          sessionId: 'mira-local'
        }).rawEvents(),
      'malformed_record'
    );
  });

  it('rejects public reads when prompted living state disagrees with prior patch evidence', async () => {
    const storeRoot = createTempStoreRoot();
    await createCatalogedSession(storeRoot, 'mira-local');
    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'mira-local'
    });
    const secondIdentity = {
      eventId: 'evt_file_log_002',
      traceId: 'trace_file_log_002',
      createdAt
    } as const;
    let invocationCount = 0;
    const roleModelAdapter: RoleModelAdapter = {
      invoke() {
        invocationCount += 1;

        return {
          rawOutputText: JSON.stringify({
            version: roleModelDecisionContractVersion,
            toolCalls: [
              {
                name: roleModelVisibleReplyActionName,
                input: {
                  text: `stateful reply ${String(invocationCount)}`
                }
              },
              {
                name: 'character_state.patch',
                input:
                  invocationCount === 1
                    ? { mood: 'curious' }
                    : { energy: 'high' }
              }
            ]
          })
        };
      }
    };
    const session = createConversationSession({
      id: 'mira-local'
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'mira-local'
    });
    const characterStateStore = createFileCharacterStateStore({
      storeRoot,
      sessionId: 'mira-local'
    });

    const firstResult = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent('hello', identity),
      session,
      logStore,
      characterStateStore,
      roleModelAdapter
    });
    const secondResult = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent('second hello', secondIdentity),
      session,
      logStore,
      characterStateStore,
      roleModelAdapter
    });

    expect(firstResult.status).toBe('completed');
    expect(secondResult.status).toBe('completed');

    const stalePromptedBrief = createLivingStateBrief(
      createDefaultCharacterRuntimeState()
    );
    const rewrittenRawEvents = readFileSync(paths.rawEventsPath, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => {
        const record = mutableJsonRecordFromLine(line);

        if (
          record['eventId'] !== secondIdentity.eventId ||
          record['roleModelIOSnapshot'] === undefined
        ) {
          return JSON.stringify(record);
        }

        const roleModelIOSnapshot = requiredMutableRecord(
          record['roleModelIOSnapshot'],
          'roleModelIOSnapshot'
        );
        const inputEnvelope = requiredMutableRecord(
          roleModelIOSnapshot['inputEnvelope'],
          'roleModelIOSnapshot.inputEnvelope'
        );
        const decisionContext = requiredMutableRecord(
          inputEnvelope['decisionContext'],
          'roleModelIOSnapshot.inputEnvelope.decisionContext'
        );

        decisionContext['livingStateBrief'] = stalePromptedBrief;

        return JSON.stringify(record);
      })
      .join('\n');

    writeFileSync(paths.rawEventsPath, `${rewrittenRawEvents}\n`, 'utf8');

    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot,
          sessionId: 'mira-local'
        }).rawEvents(),
      'malformed_record'
    );
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
    const alphaCompletedTrace: RuntimeTraceEntryInput = {
      ...identity,
      eventId: 'evt_alpha',
      traceId: 'trace_alpha',
      step: 'runtime_turn_completed'
    };
    const betaTrace: RuntimeTraceEntryInput = {
      ...identity,
      eventId: 'evt_beta',
      traceId: 'trace_beta',
      step: 'runtime_event_received'
    };
    const betaCompletedTrace: RuntimeTraceEntryInput = {
      ...identity,
      eventId: 'evt_beta',
      traceId: 'trace_beta',
      step: 'runtime_turn_completed'
    };
    const alphaRaw: RawEventLogRecordInput = {
      ...identity,
      eventId: 'evt_alpha',
      traceId: 'trace_alpha',
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE'
    };
    const alphaCompletedRaw: RawEventLogRecordInput = {
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
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE'
    };
    const betaCompletedRaw: RawEventLogRecordInput = {
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
    alpha.appendRawEvent(alphaRaw);
    alpha.appendConversationMessage(alphaMessage);
    alpha.appendConversationMessage(alphaReply);
    alpha.appendRawEvent(alphaCompletedRaw);
    alpha.appendTrace(alphaCompletedTrace);
    beta.appendTrace(betaTrace);
    beta.appendRawEvent(betaRaw);
    beta.appendConversationMessage(betaMessage);
    beta.appendConversationMessage(betaReply);
    beta.appendRawEvent(betaCompletedRaw);
    beta.appendTrace(betaCompletedTrace);

    expect(
      createFileRuntimeLogStore({
        storeRoot,
        sessionId: 'alpha'
      }).traceEntries()
    ).toEqual([alphaTrace, alphaCompletedTrace]);
    expect(
      createFileRuntimeLogStore({
        storeRoot,
        sessionId: 'alpha'
      }).rawEvents()
    ).toEqual([alphaRaw, alphaCompletedRaw]);
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
    ).toEqual([betaTrace, betaCompletedTrace]);
    expect(
      createFileRuntimeLogStore({
        storeRoot,
        sessionId: 'beta'
      }).rawEvents()
    ).toEqual([betaRaw, betaCompletedRaw]);
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
    const receivedRawEvent: RawEventLogRecordInput = {
      ...identity,
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE',
      payloadSummary
    };
    const rawEvent: RawEventLogRecordInput = {
      ...identity,
      kind: 'runtime_turn_completed',
      eventType: 'USER_MESSAGE',
      status: 'completed',
      visibleMessageIds,
      payloadSummary
    };

    store.appendTrace({
      ...identity,
      step: 'runtime_event_received'
    });
    store.appendRawEvent(receivedRawEvent);
    store.appendConversationMessage(userMessage);
    store.appendConversationMessage(characterMessage);

    const appended = store.appendRawEvent(rawEvent);
    store.appendTrace({
      ...identity,
      step: 'runtime_turn_completed'
    });

    visibleMessageIds.push('mira-local:message-3');
    payloadSummary.normalizedCurrentUserMessage = 'mutated after append';

    const rawSnapshot = store.rawEvents();
    const terminalRawSnapshot = rawSnapshot.at(1);

    if (terminalRawSnapshot === undefined) {
      throw new Error('Expected raw event snapshot to contain a terminal record.');
    }

    expect(Object.isFrozen(rawSnapshot)).toBe(true);
    expect(Object.isFrozen(terminalRawSnapshot)).toBe(true);
    expect(Object.isFrozen(terminalRawSnapshot.visibleMessageIds)).toBe(true);
    expect(Object.isFrozen(terminalRawSnapshot.payloadSummary)).toBe(true);
    expect(Reflect.set(rawSnapshot, '0', {
      ...identity,
      kind: 'runtime_turn_rejected',
      eventType: 'USER_MESSAGE',
      status: 'rejected'
    } satisfies RawEventLogRecordInput)).toBe(false);
    expect(Reflect.set(terminalRawSnapshot, 'eventId', 'evt_mutated')).toBe(false);
    expect(store.rawEvents()).toEqual([
      {
        ...receivedRawEvent,
        payloadSummary: {
          normalizedCurrentUserMessage: 'hello'
        }
      },
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
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE',
        payloadSummary: {
          normalizedCurrentUserMessage: 'hello'
        }
      },
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

    const emptyRawStoreRoot = createTempStoreRoot();
    await createCatalogedSession(emptyRawStoreRoot, 'mira-local');
    const emptyRawPaths = createLocalRuntimeSessionPaths({
      storeRoot: emptyRawStoreRoot,
      sessionId: 'mira-local'
    });

    writeConversationPair(emptyRawPaths);
    writeCompletedTraceEvidence(emptyRawPaths);
    writeFileSync(emptyRawPaths.rawEventsPath, '', 'utf8');

    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot: emptyRawStoreRoot,
          sessionId: 'mira-local'
        }).rawEvents(),
      'malformed_record'
    );
    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot: emptyRawStoreRoot,
          sessionId: 'mira-local'
        }).appendRawEvent({
          ...identity,
          eventId: 'evt_empty_raw_append',
          traceId: 'trace_empty_raw_append',
          kind: 'runtime_event_received',
          eventType: 'USER_MESSAGE'
        }),
      'malformed_record'
    );

    const emptyTraceStoreRoot = createTempStoreRoot();
    await createCatalogedSession(emptyTraceStoreRoot, 'mira-local');
    const emptyTracePaths = createLocalRuntimeSessionPaths({
      storeRoot: emptyTraceStoreRoot,
      sessionId: 'mira-local'
    });

    writeRawEventOnly(emptyTracePaths);
    writeFileSync(emptyTracePaths.tracePath, '', 'utf8');

    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot: emptyTraceStoreRoot,
          sessionId: 'mira-local'
        }).traceEntries(),
      'malformed_record'
    );
    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot: emptyTraceStoreRoot,
          sessionId: 'mira-local'
        }).appendTrace({
          ...identity,
          eventId: 'evt_empty_trace_append',
          traceId: 'trace_empty_trace_append',
          step: 'runtime_event_received'
        }),
      'malformed_record'
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
    writeStartedTraceEvidence(paths);
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

    appendStartedTurn(store);
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
    writeCompletedTraceEvidence(paths);
    writeFileSync(
      paths.rawEventsPath,
      [
        JSON.stringify({
          ...identity,
          kind: 'runtime_event_received',
          eventType: 'USER_MESSAGE'
        }),
        JSON.stringify({
          ...identity,
          kind: 'runtime_turn_completed',
          eventType: 'USER_MESSAGE',
          status: 'completed',
          visibleMessageIds: ['mira-local:message-1', 'mira-local:message-2']
        }),
        ''
      ].join('\n'),
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

    appendCompletedTurn(appendStore);
    appendStartedTurn(appendStore, {
      ...identity,
      eventId: 'evt_other_turn',
      traceId: 'trace_other_turn'
    });
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
    writeCompletedTraceEvidence(readPaths, {
      ...identity,
      eventId: 'evt_other_turn',
      traceId: 'trace_other_turn'
    });
    writeFileSync(
      readPaths.rawEventsPath,
      [
        JSON.stringify({
          ...identity,
          eventId: 'evt_other_turn',
          traceId: 'trace_other_turn',
          kind: 'runtime_event_received',
          eventType: 'USER_MESSAGE'
        }),
        JSON.stringify({
          ...identity,
          eventId: 'evt_other_turn',
          traceId: 'trace_other_turn',
          kind: 'runtime_turn_completed',
          eventType: 'USER_MESSAGE',
          status: 'completed',
          visibleMessageIds: ['mira-local:message-1', 'mira-local:message-2']
        }),
        ''
      ].join('\n'),
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

  it('rejects completed terminal evidence that does not exactly match event messages', async () => {
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

    appendStartedTurn(appendStore);
    appendStore.appendConversationMessage(userMessage);
    appendStore.appendConversationMessage(characterMessage);
    expectStorageErrorCode(
      () =>
        appendStore.appendRawEvent({
          ...identity,
          kind: 'runtime_turn_completed',
          eventType: 'USER_MESSAGE',
          status: 'completed',
          visibleMessageIds: ['mira-local:message-2', 'mira-local:message-1']
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
    writeCompletedTraceEvidence(readPaths);
    writeFileSync(
      readPaths.rawEventsPath,
      [
        JSON.stringify({
          ...identity,
          kind: 'runtime_event_received',
          eventType: 'USER_MESSAGE'
        }),
        JSON.stringify({
          ...identity,
          kind: 'runtime_turn_completed',
          eventType: 'USER_MESSAGE',
          status: 'completed',
          visibleMessageIds: ['mira-local:message-2', 'mira-local:message-1']
        }),
        ''
      ].join('\n'),
      'utf8'
    );

    const readStore = createFileRuntimeLogStore({
      storeRoot: readStoreRoot,
      sessionId: 'mira-local'
    });

    expectStorageErrorCode(() => readStore.rawEvents(), 'malformed_record');
    expectStorageErrorCode(() => readStore.conversationMessages(), 'malformed_record');
    expectStorageErrorCode(
      () =>
        readStore.appendRawEvent({
          ...identity,
          eventId: 'evt_reversed_existing_append',
          traceId: 'trace_reversed_existing_append',
          kind: 'runtime_event_received',
          eventType: 'USER_MESSAGE'
        }),
      'malformed_record'
    );
  });

  it('rejects duplicate terminal raw events for one turn identity', async () => {
    const storeRoot = createTempStoreRoot();
    await createCatalogedSession(storeRoot, 'mira-local');
    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'mira-local'
    });
    const terminalRawEvent = {
      ...identity,
      kind: 'runtime_turn_completed',
      eventType: 'USER_MESSAGE',
      status: 'completed',
      visibleMessageIds: ['mira-local:message-1', 'mira-local:message-2']
    } as const;

    writeConversationPair(paths);
    writeCompletedTraceEvidence(paths);
    writeFileSync(
      paths.rawEventsPath,
      [
        JSON.stringify({
          ...identity,
          kind: 'runtime_event_received',
          eventType: 'USER_MESSAGE'
        }),
        JSON.stringify(terminalRawEvent),
        JSON.stringify(terminalRawEvent),
        ''
      ].join('\n'),
      'utf8'
    );

    const store = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'mira-local'
    });

    expectStorageErrorCode(() => store.rawEvents(), 'malformed_record');
    expectStorageErrorCode(() => store.conversationMessages(), 'malformed_record');
    expectStorageErrorCode(
      () =>
        store.appendRawEvent({
          ...identity,
          eventId: 'evt_file_log_next',
          traceId: 'trace_file_log_next',
          kind: 'runtime_event_received',
          eventType: 'USER_MESSAGE'
        }),
      'malformed_record'
    );
    expectStorageErrorCode(
      () =>
        store.appendConversationMessage(createConversationRecord({
          id: 'mira-local:message-3',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'next'
        })),
      'malformed_record'
    );
  });

  it('rejects terminal raw events without prior nonterminal raw evidence', async () => {
    const storeRoot = createTempStoreRoot();
    await createCatalogedSession(storeRoot, 'mira-local');
    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'mira-local'
    });
    const rawLog = [
      JSON.stringify({
        ...identity,
        kind: 'runtime_turn_rejected',
        eventType: 'USER_MESSAGE',
        status: 'rejected',
        reason: 'Provide exactly one non-empty message.'
      }),
      ''
    ].join('\n');

    writeFileSync(
      paths.tracePath,
      [
        JSON.stringify({
          ...identity,
          step: 'runtime_event_received'
        }),
        JSON.stringify({
          ...identity,
          step: 'runtime_turn_rejected'
        }),
        ''
      ].join('\n'),
      'utf8'
    );
    writeFileSync(paths.rawEventsPath, rawLog, 'utf8');

    const store = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'mira-local'
    });

    expectStorageErrorCode(() => store.rawEvents(), 'malformed_record');
    expectStorageErrorCode(() => store.conversationMessages(), 'malformed_record');
    expectStorageErrorCode(
      () =>
        store.appendRawEvent({
          ...identity,
          eventId: 'evt_after_terminal_only_raw',
          traceId: 'trace_after_terminal_only_raw',
          kind: 'runtime_event_received',
          eventType: 'USER_MESSAGE'
        }),
      'malformed_record'
    );
    expectStorageErrorCode(
      () =>
        store.appendTrace({
          ...identity,
          eventId: 'evt_after_terminal_only_raw',
          traceId: 'trace_after_terminal_only_raw',
          step: 'runtime_event_received'
        }),
      'malformed_record'
    );
    expectStorageErrorCode(
      () =>
        store.appendConversationMessage(createConversationRecord({
          eventId: 'evt_after_terminal_only_raw',
          traceId: 'trace_after_terminal_only_raw',
          id: 'mira-local:message-1',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'next'
        })),
      'malformed_record'
    );
    expect(readFileSync(paths.rawEventsPath, 'utf8')).toBe(rawLog);
  });

  it('rejects terminal raw events when prior raw evidence is not the received start', async () => {
    const storeRoot = createTempStoreRoot();
    await createCatalogedSession(storeRoot, 'mira-local');
    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'mira-local'
    });

    writeFileSync(
      paths.tracePath,
      [
        JSON.stringify({
          ...identity,
          step: 'runtime_event_received'
        }),
        JSON.stringify({
          ...identity,
          step: 'input_validation_rejected'
        }),
        JSON.stringify({
          ...identity,
          step: 'runtime_turn_rejected'
        }),
        ''
      ].join('\n'),
      'utf8'
    );
    writeFileSync(
      paths.rawEventsPath,
      [
        JSON.stringify({
          ...identity,
          kind: 'input_validation_rejected',
          eventType: 'USER_MESSAGE',
          status: 'rejected',
          reason: 'Provide exactly one non-empty message.'
        }),
        JSON.stringify({
          ...identity,
          kind: 'runtime_turn_rejected',
          eventType: 'USER_MESSAGE',
          status: 'rejected',
          reason: 'Provide exactly one non-empty message.'
        }),
        ''
      ].join('\n'),
      'utf8'
    );

    const store = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'mira-local'
    });

    expectStorageErrorCode(() => store.rawEvents(), 'malformed_record');
    expectStorageErrorCode(() => store.conversationMessages(), 'malformed_record');
  });

  it('rejects raw event appends that do not start with received evidence', async () => {
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

    store.appendTrace({
      ...identity,
      step: 'runtime_event_received'
    });

    expectStorageErrorCode(
      () =>
        store.appendRawEvent({
          ...identity,
          kind: 'runtime_event_normalized',
          eventType: 'USER_MESSAGE'
        }),
      'malformed_record'
    );
    expect(existsSync(paths.rawEventsPath)).toBe(false);
  });

  it('rejects trace appends that do not start with received evidence', async () => {
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

    expectStorageErrorCode(
      () =>
        store.appendTrace({
          ...identity,
          step: 'runtime_event_normalized'
        }),
      'malformed_record'
    );
    expect(existsSync(paths.tracePath)).toBe(false);
  });

  it('rejects raw event starts before matching trace evidence', async () => {
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

    expectStorageErrorCode(
      () =>
        store.appendRawEvent({
          ...identity,
          kind: 'runtime_event_received',
          eventType: 'USER_MESSAGE'
        }),
      'malformed_record'
    );
    expect(existsSync(paths.rawEventsPath)).toBe(false);
  });

  it('rejects conversation appends before raw turn evidence exists', async () => {
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

    expectStorageErrorCode(
      () =>
        store.appendConversationMessage(createConversationRecord({
          id: 'mira-local:message-1',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'hello'
        })),
      'malformed_record'
    );
    expect(existsSync(paths.conversationPath)).toBe(false);
  });

  it('rejects raw-event turns that start without terminal evidence', async () => {
    const storeRoot = createTempStoreRoot();
    await createCatalogedSession(storeRoot, 'mira-local');
    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'mira-local'
    });

    writeStartedTraceEvidence(paths);
    writeFileSync(
      paths.rawEventsPath,
      [
        JSON.stringify({
          ...identity,
          kind: 'runtime_event_received',
          eventType: 'USER_MESSAGE',
          payloadSummary: {
            rawInput: ''
          }
        }),
        JSON.stringify({
          ...identity,
          kind: 'input_validation_rejected',
          eventType: 'USER_MESSAGE',
          status: 'rejected',
          reason: 'Provide exactly one non-empty message.',
          payloadSummary: {
            rawInput: ''
          }
        }),
        ''
      ].join('\n'),
      'utf8'
    );

    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot,
          sessionId: 'mira-local'
        }).rawEvents(),
      'malformed_record'
    );
    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot,
          sessionId: 'mira-local'
        }).appendRawEvent({
          ...identity,
          eventId: 'evt_started_second',
          traceId: 'trace_started_second',
          kind: 'runtime_event_received',
          eventType: 'USER_MESSAGE'
        }),
      'malformed_record'
    );
    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot,
          sessionId: 'mira-local'
        }).appendConversationMessage(createConversationRecord({
          eventId: 'evt_started_second',
          traceId: 'trace_started_second',
          id: 'mira-local:message-1',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'next'
        })),
      'malformed_record'
    );
  });

  it('rejects overlapping raw-event turns on public reads', async () => {
    const storeRoot = createTempStoreRoot();
    await createCatalogedSession(storeRoot, 'mira-local');
    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'mira-local'
    });
    const secondIdentity = {
      ...identity,
      eventId: 'evt_overlapped_turn',
      traceId: 'trace_overlapped_turn'
    };

    writeFileSync(
      paths.tracePath,
      [
        JSON.stringify({
          ...identity,
          step: 'runtime_event_received'
        }),
        JSON.stringify({
          ...secondIdentity,
          step: 'runtime_event_received'
        }),
        JSON.stringify({
          ...identity,
          step: 'runtime_turn_rejected'
        }),
        JSON.stringify({
          ...secondIdentity,
          step: 'runtime_turn_rejected'
        }),
        ''
      ].join('\n'),
      'utf8'
    );
    writeFileSync(
      paths.rawEventsPath,
      [
        JSON.stringify({
          ...identity,
          kind: 'runtime_event_received',
          eventType: 'USER_MESSAGE'
        }),
        JSON.stringify({
          ...secondIdentity,
          kind: 'runtime_event_received',
          eventType: 'USER_MESSAGE'
        }),
        JSON.stringify({
          ...identity,
          kind: 'runtime_turn_rejected',
          eventType: 'USER_MESSAGE',
          status: 'rejected',
          reason: 'first turn rejected'
        }),
        JSON.stringify({
          ...secondIdentity,
          kind: 'runtime_turn_rejected',
          eventType: 'USER_MESSAGE',
          status: 'rejected',
          reason: 'second turn rejected'
        }),
        ''
      ].join('\n'),
      'utf8'
    );

    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot,
          sessionId: 'mira-local'
        }).rawEvents(),
      'malformed_record'
    );
  });

  it('rejects public trace reads for trace-started turns without raw evidence', async () => {
    const storeRoot = createTempStoreRoot();
    await createCatalogedSession(storeRoot, 'mira-local');
    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'mira-local'
    });

    writeConversationPair(paths);
    writeVisibleRawEvidence(paths);
    writeFileSync(
      paths.tracePath,
      [
        JSON.stringify({
          ...identity,
          step: 'runtime_event_received'
        }),
        JSON.stringify({
          ...identity,
          step: 'visible_reply_committed'
        }),
        JSON.stringify({
          ...identity,
          step: 'runtime_turn_completed'
        }),
        JSON.stringify({
          ...identity,
          eventId: 'evt_trace_only',
          traceId: 'trace_trace_only',
          step: 'runtime_event_received'
        }),
        ''
      ].join('\n'),
      'utf8'
    );

    const store = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'mira-local'
    });

    expectStorageErrorCode(() => store.traceEntries(), 'malformed_record');
  });

  it('rejects terminal trace evidence without prior received trace evidence', async () => {
    const storeRoot = createTempStoreRoot();
    await createCatalogedSession(storeRoot, 'mira-local');
    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'mira-local'
    });

    writeConversationPair(paths);
    writeRawEventOnly(paths);
    writeFileSync(
      paths.tracePath,
      `${JSON.stringify({
        ...identity,
        step: 'runtime_turn_completed'
      })}\n`,
      'utf8'
    );

    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot,
          sessionId: 'mira-local'
        }).traceEntries(),
      'malformed_record'
    );

    const nonStartStoreRoot = createTempStoreRoot();
    await createCatalogedSession(nonStartStoreRoot, 'mira-local');
    const nonStartPaths = createLocalRuntimeSessionPaths({
      storeRoot: nonStartStoreRoot,
      sessionId: 'mira-local'
    });

    writeConversationPair(nonStartPaths);
    writeRawEventOnly(nonStartPaths);
    writeFileSync(
      nonStartPaths.tracePath,
      [
        JSON.stringify({
          ...identity,
          step: 'visible_reply_committed'
        }),
        JSON.stringify({
          ...identity,
          step: 'runtime_turn_completed'
        }),
        ''
      ].join('\n'),
      'utf8'
    );

    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot: nonStartStoreRoot,
          sessionId: 'mira-local'
        }).traceEntries(),
      'malformed_record'
    );

    const appendStoreRoot = createTempStoreRoot();
    await createCatalogedSession(appendStoreRoot, 'mira-local');
    const appendPaths = createLocalRuntimeSessionPaths({
      storeRoot: appendStoreRoot,
      sessionId: 'mira-local'
    });
    const appendStore = createFileRuntimeLogStore({
      storeRoot: appendStoreRoot,
      sessionId: 'mira-local'
    });

    expectStorageErrorCode(
      () =>
        appendStore.appendTrace({
          ...identity,
          step: 'runtime_turn_completed'
        }),
      'malformed_record'
    );
    expect(existsSync(appendPaths.tracePath)).toBe(false);
  });

  it('rejects trace steps after terminal trace evidence', async () => {
    const storeRoot = createTempStoreRoot();
    await createCatalogedSession(storeRoot, 'mira-local');
    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'mira-local'
    });

    writeFileSync(
      paths.tracePath,
      [
        JSON.stringify({
          ...identity,
          step: 'runtime_turn_completed'
        }),
        JSON.stringify({
          ...identity,
          step: 'runtime_event_received'
        }),
        ''
      ].join('\n'),
      'utf8'
    );

    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot,
          sessionId: 'mira-local'
        }).traceEntries(),
      'malformed_record'
    );

    const appendStoreRoot = createTempStoreRoot();
    const appendStore = await createCatalogedFileRuntimeLogStore(
      appendStoreRoot,
      'mira-local'
    );

    appendStore.appendTrace({
      ...identity,
      step: 'runtime_event_received'
    });
    appendStore.appendRawEvent({
      ...identity,
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE'
    });
    appendStore.appendRawEvent({
      ...identity,
      kind: 'runtime_turn_rejected',
      eventType: 'USER_MESSAGE',
      status: 'rejected',
      reason: 'Provide exactly one non-empty message.'
    });
    appendStore.appendTrace({
      ...identity,
      step: 'runtime_turn_rejected'
    });
    expectStorageErrorCode(
      () =>
        appendStore.appendTrace({
          ...identity,
          step: 'runtime_event_received'
        }),
      'malformed_record'
    );
  });

  it('rejects terminal raw evidence without matching terminal trace evidence', async () => {
    const completedStoreRoot = createTempStoreRoot();
    await createCatalogedSession(completedStoreRoot, 'mira-local');
    const completedPaths = createLocalRuntimeSessionPaths({
      storeRoot: completedStoreRoot,
      sessionId: 'mira-local'
    });

    writeConversationPair(completedPaths);
    writeFileSync(
      completedPaths.rawEventsPath,
      [
        JSON.stringify({
          ...identity,
          kind: 'runtime_event_received',
          eventType: 'USER_MESSAGE'
        }),
        JSON.stringify({
          ...identity,
          kind: 'runtime_turn_completed',
          eventType: 'USER_MESSAGE',
          status: 'completed',
          visibleMessageIds: ['mira-local:message-1', 'mira-local:message-2']
        }),
        ''
      ].join('\n'),
      'utf8'
    );
    writeFileSync(
      completedPaths.tracePath,
      [
        JSON.stringify({
          ...identity,
          step: 'runtime_event_received'
        }),
        JSON.stringify({
          ...identity,
          step: 'visible_reply_committed'
        }),
        JSON.stringify({
          ...identity,
          step: 'raw_event_log_appended'
        }),
        ''
      ].join('\n'),
      'utf8'
    );

    const completedStore = createFileRuntimeLogStore({
      storeRoot: completedStoreRoot,
      sessionId: 'mira-local'
    });

    expectStorageErrorCode(() => completedStore.rawEvents(), 'malformed_record');
    expectStorageErrorCode(
      () => completedStore.conversationMessages(),
      'malformed_record'
    );

    const rejectedStoreRoot = createTempStoreRoot();
    await createCatalogedSession(rejectedStoreRoot, 'mira-local');
    const rejectedPaths = createLocalRuntimeSessionPaths({
      storeRoot: rejectedStoreRoot,
      sessionId: 'mira-local'
    });

    writeFileSync(
      rejectedPaths.rawEventsPath,
      [
        JSON.stringify({
          ...identity,
          kind: 'runtime_event_received',
          eventType: 'USER_MESSAGE'
        }),
        JSON.stringify({
          ...identity,
          kind: 'runtime_turn_rejected',
          eventType: 'USER_MESSAGE',
          status: 'rejected',
          reason: 'Provide exactly one non-empty message.'
        }),
        ''
      ].join('\n'),
      'utf8'
    );
    writeFileSync(
      rejectedPaths.tracePath,
      [
        JSON.stringify({
          ...identity,
          step: 'runtime_event_received'
        }),
        JSON.stringify({
          ...identity,
          step: 'input_validation_rejected'
        }),
        JSON.stringify({
          ...identity,
          step: 'raw_event_log_appended'
        }),
        JSON.stringify({
          ...identity,
          step: 'runtime_turn_completed'
        }),
        ''
      ].join('\n'),
      'utf8'
    );

    const rejectedStore = createFileRuntimeLogStore({
      storeRoot: rejectedStoreRoot,
      sessionId: 'mira-local'
    });

    expectStorageErrorCode(() => rejectedStore.rawEvents(), 'malformed_record');
    expectStorageErrorCode(
      () => rejectedStore.conversationMessages(),
      'malformed_record'
    );
  });

  it('validates sibling logs before appending trace entries', async () => {
    const missingRawStoreRoot = createTempStoreRoot();
    await createCatalogedSession(missingRawStoreRoot, 'mira-local');
    const missingRawPaths = createLocalRuntimeSessionPaths({
      storeRoot: missingRawStoreRoot,
      sessionId: 'mira-local'
    });
    const missingRawTrace = [
      JSON.stringify({
        ...identity,
        eventId: 'evt_previous_trace_only',
        traceId: 'trace_previous_trace_only',
        step: 'runtime_event_received'
      }),
      JSON.stringify({
        ...identity,
        eventId: 'evt_previous_trace_only',
        traceId: 'trace_previous_trace_only',
        step: 'runtime_turn_completed'
      }),
      ''
    ].join('\n');

    writeFileSync(missingRawPaths.tracePath, missingRawTrace, 'utf8');
    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot: missingRawStoreRoot,
          sessionId: 'mira-local'
        }).appendTrace({
          ...identity,
          eventId: 'evt_after_missing_raw',
          traceId: 'trace_after_missing_raw',
          step: 'runtime_event_received'
        }),
      'missing_file'
    );
    expect(readFileSync(missingRawPaths.tracePath, 'utf8')).toBe(missingRawTrace);
    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot: missingRawStoreRoot,
          sessionId: 'mira-local'
        }).appendRawEvent({
          ...identity,
          eventId: 'evt_after_missing_raw',
          traceId: 'trace_after_missing_raw',
          kind: 'runtime_event_received',
          eventType: 'USER_MESSAGE'
        }),
      'missing_file'
    );
    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot: missingRawStoreRoot,
          sessionId: 'mira-local'
        }).appendConversationMessage(createConversationRecord({
          eventId: 'evt_after_missing_raw',
          traceId: 'trace_after_missing_raw',
          id: 'mira-local:message-1',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'next'
        })),
      'missing_file'
    );
    expect(existsSync(missingRawPaths.rawEventsPath)).toBe(false);
    expect(existsSync(missingRawPaths.conversationPath)).toBe(false);

    const partialRawStoreRoot = createTempStoreRoot();
    await createCatalogedSession(partialRawStoreRoot, 'mira-local');
    const partialRawPaths = createLocalRuntimeSessionPaths({
      storeRoot: partialRawStoreRoot,
      sessionId: 'mira-local'
    });

    writeFileSync(
      partialRawPaths.rawEventsPath,
      JSON.stringify({
        ...identity,
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE'
      }),
      'utf8'
    );
    const partialRawTrace = `${JSON.stringify({
      ...identity,
      step: 'runtime_event_received'
    })}\n`;

    writeFileSync(
      partialRawPaths.tracePath,
      partialRawTrace,
      'utf8'
    );

    const partialRawStore = createFileRuntimeLogStore({
      storeRoot: partialRawStoreRoot,
      sessionId: 'mira-local'
    });

    expectStorageErrorCode(
      () =>
        partialRawStore.appendTrace({
          ...identity,
          eventId: 'evt_after_partial_raw',
          traceId: 'trace_after_partial_raw',
          step: 'runtime_event_received'
        }),
      'partial_write'
    );
    expect(readFileSync(partialRawPaths.tracePath, 'utf8')).toBe(partialRawTrace);

    const incompleteRawStoreRoot = createTempStoreRoot();
    await createCatalogedSession(incompleteRawStoreRoot, 'mira-local');
    const incompleteRawPaths = createLocalRuntimeSessionPaths({
      storeRoot: incompleteRawStoreRoot,
      sessionId: 'mira-local'
    });

    writeFileSync(
      incompleteRawPaths.rawEventsPath,
      `${JSON.stringify({
        ...identity,
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE'
      })}\n`,
      'utf8'
    );
    const incompleteRawTrace = `${JSON.stringify({
      ...identity,
      step: 'runtime_event_received'
    })}\n`;

    writeFileSync(
      incompleteRawPaths.tracePath,
      incompleteRawTrace,
      'utf8'
    );

    expectStorageErrorCode(
      () =>
        createFileRuntimeLogStore({
          storeRoot: incompleteRawStoreRoot,
          sessionId: 'mira-local'
        }).appendTrace({
          ...identity,
          eventId: 'evt_after_incomplete_raw',
          traceId: 'trace_after_incomplete_raw',
          step: 'runtime_event_received'
      }),
      'malformed_record'
    );
    expect(readFileSync(incompleteRawPaths.tracePath, 'utf8')).toBe(
      incompleteRawTrace
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

function mutableJsonRecordFromLine(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);

  if (isMutableRecord(parsed)) {
    return parsed;
  }

  throw new Error('Expected raw event log line to be a JSON object.');
}

function isMutableRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredMutableRecord(
  value: unknown,
  field: string
): Record<string, unknown> {
  if (isMutableRecord(value)) {
    return value;
  }

  throw new Error(`Expected ${field} to be a JSON object.`);
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
    [
      JSON.stringify({
        ...identity,
        step: 'runtime_event_received'
      }),
      JSON.stringify({
        ...identity,
        step: 'visible_reply_committed'
      }),
      JSON.stringify({
        ...identity,
        step: 'runtime_turn_completed'
      }),
      ''
    ].join('\n'),
    'utf8'
  );
  writeFileSync(
    paths.rawEventsPath,
    [
      JSON.stringify({
        ...identity,
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE'
      }),
      JSON.stringify({
        ...identity,
        kind: 'runtime_turn_completed',
        eventType: 'USER_MESSAGE',
        status: 'completed',
        visibleMessageIds: ['mira-local:message-1', 'mira-local:message-2']
      }),
      ''
    ].join('\n'),
    'utf8'
  );
}

function writeCompletedTraceEvidence(
  paths: ReturnType<typeof createLocalRuntimeSessionPaths>,
  turnIdentity: TestRuntimeIdentity = identity
): void {
  writeFileSync(
    paths.tracePath,
    [
      JSON.stringify({
        ...turnIdentity,
        step: 'runtime_event_received'
      }),
      JSON.stringify({
        ...turnIdentity,
        step: 'visible_reply_committed'
      }),
      JSON.stringify({
        ...turnIdentity,
        step: 'raw_event_log_appended'
      }),
      JSON.stringify({
        ...turnIdentity,
        step: 'runtime_turn_completed'
      }),
      ''
    ].join('\n'),
    'utf8'
  );
}

function writeStartedTraceEvidence(
  paths: ReturnType<typeof createLocalRuntimeSessionPaths>,
  turnIdentity: TestRuntimeIdentity = identity
): void {
  writeFileSync(
    paths.tracePath,
    `${JSON.stringify({
      ...turnIdentity,
      step: 'runtime_event_received'
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
    [
      JSON.stringify({
        ...identity,
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE'
      }),
      JSON.stringify({
        ...identity,
        kind: 'runtime_turn_completed',
        eventType: 'USER_MESSAGE',
        status: 'completed',
        visibleMessageIds: ['mira-local:message-1', 'mira-local:message-2']
      }),
      ''
    ].join('\n'),
    'utf8'
  );
}

function appendStartedTurn(
  store: ReturnType<typeof createFileRuntimeLogStore>,
  turnIdentity: TestRuntimeIdentity = identity
): void {
  store.appendTrace({
    ...turnIdentity,
    step: 'runtime_event_received'
  });
  store.appendRawEvent({
    ...turnIdentity,
    kind: 'runtime_event_received',
    eventType: 'USER_MESSAGE'
  });
}

function appendCompletedTurn(
  store: ReturnType<typeof createFileRuntimeLogStore>
): void {
  appendStartedTurn(store);
  store.appendConversationMessage(createConversationRecord({
    id: 'mira-local:message-1',
    role: 'user',
    speakerId: 'local-user',
    speakerName: 'You',
    text: 'hello'
  }));
  store.appendConversationMessage(createConversationRecord({
    id: 'mira-local:message-2',
    role: 'character',
    speakerId: 'mira',
    speakerName: 'Mira',
    text: "I'm here. Tell me what you need."
  }));
  store.appendRawEvent({
    ...identity,
    kind: 'runtime_turn_completed',
    eventType: 'USER_MESSAGE',
    status: 'completed',
    visibleMessageIds: ['mira-local:message-1', 'mira-local:message-2']
  });
  store.appendTrace({
    ...identity,
    step: 'raw_event_log_appended'
  });
  store.appendTrace({
    ...identity,
    step: 'runtime_turn_completed'
  });
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
