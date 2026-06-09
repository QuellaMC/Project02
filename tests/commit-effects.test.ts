import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CharacterReplyValidationError,
  createConversationSession,
  createFileRuntimeLogStore,
  createLocalRuntimeSessionPaths,
  createLocalRuntimeSessionStore,
  createRuntimeLogStore,
  createUserMessageRuntimeEvent,
  LocalRuntimeStorageContractError,
  roleModelInvalidVisibleReplyRejectionReason,
  roleModelMalformedOutputRejectionReason,
  roleModelUnsupportedEffectRejectionReason,
  roleModelVisibleReplyActionName,
  runLocalUserMessageEvent,
  type CharacterAgent,
  type ConversationLogRecord,
  type RawEventLogRecord,
  type RawEventLogRecordKind,
  type RuntimeLogStore,
  type UserMessageRuntimeEvent
} from '../src/index.ts';
import type {
  RoleModelAdapter,
  RoleModelAdapterRawOutput
} from '../src/role-model-loop.ts';

const tempStoreRoots: string[] = [];

describe('MVP-005 commit/effects validation', () => {
  afterEach(() => {
    for (const storeRoot of tempStoreRoots.splice(0)) {
      rmSync(storeRoot, { recursive: true, force: true });
    }
  });

  it('commits accepted visible_reply decisions through the conversation path with role-model evidence', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const event = createTestUserMessageEvent('hello', 'evt_commit_accept');

    const result = await runLocalUserMessageEvent({
      event,
      session,
      logStore,
      rawInput: ' hello '
    });

    expect(result.status).toBe('completed');

    if (result.status !== 'completed') {
      throw new Error('Expected accepted commit result.');
    }

    const visibleReplyCommitted = findRawEvent(
      result.rawEventLogRecords,
      'visible_reply_committed'
    );

    expect(result.turn.reply.text).toBe("I'm here. Tell me what you need.");
    expect(result.conversationMessages.map((message) => message.text)).toEqual([
      'hello',
      "I'm here. Tell me what you need."
    ]);
    expect(visibleReplyCommitted.roleModelIOSnapshot).toMatchObject({
      eventId: event.eventId,
      traceId: event.traceId,
      sessionId: 'local-session',
      rawOutputText: JSON.stringify({
        action: {
          type: roleModelVisibleReplyActionName,
          text: "I'm here. Tell me what you need."
        }
      })
    });
    expect(
      visibleReplyCommitted.roleModelIOSnapshot?.inputEnvelope.allowedActions
    ).toEqual([roleModelVisibleReplyActionName]);
    expect(
      visibleReplyCommitted.roleModelIOSnapshot?.inputEnvelope.decisionContext
        .recentVisibleMessages
    ).toEqual([]);
    expect(visibleReplyCommitted.parsedRoleModelDecisionSnapshot?.result).toEqual({
      status: 'accepted',
      decision: {
        action: {
          type: roleModelVisibleReplyActionName,
          text: "I'm here. Tell me what you need."
        }
      }
    });
    expect(visibleReplyCommitted.commitValidation?.result).toEqual({
      status: 'accepted',
      acceptedVisibleReplyText: "I'm here. Tell me what you need."
    });
    expect(result.rawEvent.roleModelIOSnapshot).toEqual(
      visibleReplyCommitted.roleModelIOSnapshot
    );
    expect(result.rawEvent.parsedRoleModelDecisionSnapshot).toEqual(
      visibleReplyCommitted.parsedRoleModelDecisionSnapshot
    );
    expect(result.rawEvent.commitValidation).toEqual(
      visibleReplyCommitted.commitValidation
    );
    expect(result.rawEvent.visibleMessageIds).toEqual([
      'local-session:message-1',
      'local-session:message-2'
    ]);
  });

  it('rejects malformed role-model output with no visible conversation messages', async () => {
    const result = await runRejectedTurnWithAdapter(
      createRawOutputAdapter('not json'),
      'evt_commit_malformed'
    );

    expect(result.reason).toBe(roleModelMalformedOutputRejectionReason);
    expect(result.session.visibleTranscript).toEqual([]);
    expect(result.logStore.conversationMessages()).toEqual([]);
    expect(result.rejected.rawEvent.visibleMessageIds).toBeUndefined();
    expect(result.rejected.rawEvent.reason).toBe(
      roleModelMalformedOutputRejectionReason
    );
    expect(result.rejected.rawEvent.roleModelIOSnapshot?.rawOutputText).toBe(
      'not json'
    );
    expect(
      result.rejected.rawEvent.parsedRoleModelDecisionSnapshot?.result
    ).toEqual({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details: 'Adapter output must be valid JSON.'
      }
    });
    expect(result.rejected.rawEvent.commitValidation?.result).toEqual({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details: 'Adapter output must be valid JSON.'
      }
    });
  });

  it('rejects unsupported role-model effects with CT-01 rejection evidence and no visible messages', async () => {
    const result = await runRejectedTurnWithAdapter(
      createRawOutputAdapter(
        JSON.stringify({
          action: {
            type: roleModelVisibleReplyActionName,
            text: 'I can do that.'
          },
          effects: [
            {
              type: 'schedule_reminder'
            }
          ]
        })
      ),
      'evt_commit_unsupported'
    );

    expect(result.reason).toBe(roleModelUnsupportedEffectRejectionReason);
    expect(result.session.visibleTranscript).toEqual([]);
    expect(result.logStore.conversationMessages()).toEqual([]);
    expect(result.rejected.rawEvent.reason).toBe(
      roleModelUnsupportedEffectRejectionReason
    );
    expect(result.rejected.rawEvent.commitValidation?.result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelUnsupportedEffectRejectionReason
      }
    });
  });

  it('rejects empty and multiline visible_reply text before appending visible records', async () => {
    const invalidReplyAgents: readonly CharacterAgent[] = [
      {
        reply() {
          return {
            text: ''
          };
        }
      },
      {
        reply() {
          return {
            text: 'line one\nline two'
          };
        }
      }
    ];

    for (const [index, agent] of invalidReplyAgents.entries()) {
      const session = createConversationSession();
      const logStore = createRuntimeLogStore();
      const result = await runLocalUserMessageEvent({
        event: createTestUserMessageEvent(
          'hello',
          `evt_commit_invalid_${String(index)}`
        ),
        session,
        logStore,
        agent
      });

      expect(result.status).toBe('rejected');

      if (result.status !== 'rejected') {
        throw new Error('Expected invalid visible reply rejection.');
      }

      expect(result.reason).toBe(roleModelInvalidVisibleReplyRejectionReason);
      expect(session.visibleTranscript).toEqual([]);
      expect(logStore.conversationMessages()).toEqual([]);
      expect(result.rawEvent.visibleMessageIds).toBeUndefined();
      expect(result.rawEvent.reason).toBe(
        roleModelInvalidVisibleReplyRejectionReason
      );
      expect(result.rawEvent.parsedRoleModelDecisionSnapshot?.result).toMatchObject({
        status: 'accepted'
      });
      expect(result.rawEvent.commitValidation?.result).toMatchObject({
        status: 'rejected',
        rejection: {
          reason: roleModelInvalidVisibleReplyRejectionReason
        }
      });
    }
  });

  it('persists rejected decision evidence through a file-backed reopen', async () => {
    const storeRoot = await createDurableSession('mira-local');
    const session = createConversationSession({
      id: 'mira-local'
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'mira-local'
    });

    const result = await runLocalUserMessageEvent({
      event: createTestUserMessageEvent('hello', 'evt_commit_reopen'),
      session,
      logStore,
      roleModelAdapter: createRawOutputAdapter('not json')
    });

    expect(result.status).toBe('rejected');

    const reopened = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'mira-local'
    });
    const terminal = findRawEvent(
      reopened.rawEvents(),
      'runtime_turn_rejected'
    );

    expect(terminal).toMatchObject({
      eventId: 'evt_commit_reopen',
      traceId: 'trace_evt_commit_reopen',
      kind: 'runtime_turn_rejected',
      status: 'rejected',
      reason: roleModelMalformedOutputRejectionReason
    });
    expect(terminal.visibleMessageIds).toBeUndefined();
    expect(terminal.roleModelIOSnapshot?.rawOutputText).toBe('not json');
    expect(terminal.parsedRoleModelDecisionSnapshot?.result).toEqual({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details: 'Adapter output must be valid JSON.'
      }
    });
    expect(terminal.commitValidation?.result).toEqual({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details: 'Adapter output must be valid JSON.'
      }
    });
    expect(reopened.conversationMessages()).toEqual([]);
  });

  it('persists pre-role-model reply validation rejection without partial evidence', async () => {
    const storeRoot = await createDurableSession('mira-local');
    const session = createConversationSession({
      id: 'mira-local'
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'mira-local'
    });
    const agent: CharacterAgent = {
      reply() {
        throw new CharacterReplyValidationError(
          'Character agent returned a multi-line reply.'
        );
      }
    };

    const result = await runLocalUserMessageEvent({
      event: createTestUserMessageEvent(
        'hello',
        'evt_commit_pre_role_model_invalid_reply'
      ),
      session,
      logStore,
      agent
    });

    expect(result.status).toBe('rejected');

    if (result.status !== 'rejected') {
      throw new Error('Expected pre-role-model reply validation rejection.');
    }

    expect(result.reason).toBe(roleModelInvalidVisibleReplyRejectionReason);

    const reopened = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'mira-local'
    });
    const characterReplyRejected = findRawEvent(
      reopened.rawEvents(),
      'character_reply_rejected'
    );
    const terminal = findRawEvent(reopened.rawEvents(), 'runtime_turn_rejected');

    expect(characterReplyRejected).toMatchObject({
      eventId: 'evt_commit_pre_role_model_invalid_reply',
      traceId: 'trace_evt_commit_pre_role_model_invalid_reply',
      kind: 'character_reply_rejected',
      status: 'rejected',
      reason: roleModelInvalidVisibleReplyRejectionReason
    });
    expect(characterReplyRejected.roleModelIOSnapshot).toBeUndefined();
    expect(characterReplyRejected.parsedRoleModelDecisionSnapshot).toBeUndefined();
    expect(characterReplyRejected.commitValidation).toBeUndefined();
    expect(terminal).toEqual({
      ...characterReplyRejected,
      kind: 'runtime_turn_rejected'
    });
    expect(reopened.conversationMessages()).toEqual([]);
  });

  it('persists adapter raw-output shape rejection through a file-backed reopen', async () => {
    const storeRoot = await createDurableSession('mira-local');
    const session = createConversationSession({
      id: 'mira-local'
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'mira-local'
    });

    const result = await runLocalUserMessageEvent({
      event: createTestUserMessageEvent('hello', 'evt_commit_adapter_shape'),
      session,
      logStore,
      roleModelAdapter: createMalformedRawOutputAdapter({})
    });

    expect(result.status).toBe('rejected');

    const reopened = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'mira-local'
    });
    const terminal = findRawEvent(
      reopened.rawEvents(),
      'runtime_turn_rejected'
    );

    expect(terminal).toMatchObject({
      eventId: 'evt_commit_adapter_shape',
      traceId: 'trace_evt_commit_adapter_shape',
      kind: 'runtime_turn_rejected',
      status: 'rejected',
      reason: roleModelMalformedOutputRejectionReason
    });
    expect(terminal.visibleMessageIds).toBeUndefined();
    expect(terminal.roleModelIOSnapshot?.rawOutputText).toBe('');
    expect(terminal.parsedRoleModelDecisionSnapshot?.result).toEqual({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details: 'Adapter raw output must include string rawOutputText.'
      }
    });
    expect(terminal.commitValidation?.result).toEqual({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details: 'Adapter raw output must include string rawOutputText.'
      }
    });
    expect(reopened.conversationMessages()).toEqual([]);
  });

  it('rejects role-model evidence copied into the wrong durable session path', async () => {
    const storeRoot = await createDurableSession('mira-local');
    const session = createConversationSession({
      id: 'mira-local'
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'mira-local'
    });

    await expect(runLocalUserMessageEvent({
      event: createTestUserMessageEvent('hello', 'evt_commit_wrong_session'),
      session,
      logStore
    })).resolves.toMatchObject({
      status: 'completed'
    });

    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'mira-local'
    });
    const rawLog = readFileSync(paths.rawEventsPath, 'utf8');

    writeFileSync(
      paths.rawEventsPath,
      rewriteRoleModelEvidenceSessionIds(rawLog, 'other-session'),
      'utf8'
    );

    const reopened = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'mira-local'
    });

    expect(() => reopened.rawEvents()).toThrow(LocalRuntimeStorageContractError);
  });

  it('preserves deterministic second-turn replies after durable session rehydrate', async () => {
    const storeRoot = await createDurableSession('mira-local');
    const firstSession = createConversationSession({
      id: 'mira-local'
    });
    const firstLogStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'mira-local'
    });

    await runLocalUserMessageEvent({
      event: createTestUserMessageEvent('first', 'evt_commit_first'),
      session: firstSession,
      logStore: firstLogStore
    });

    const sessionStore = createLocalRuntimeSessionStore({
      storeRoot,
      conversationLogReader: createFileConversationLogReader(storeRoot)
    });
    const resumedSession = await sessionStore.rehydrateConversationSession(
      'mira-local'
    );
    const resumedLogStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'mira-local'
    });
    const secondResult = await runLocalUserMessageEvent({
      event: createTestUserMessageEvent('second', 'evt_commit_second'),
      session: resumedSession,
      logStore: resumedLogStore
    });

    expect(secondResult.status).toBe('completed');

    if (secondResult.status !== 'completed') {
      throw new Error('Expected resumed accepted result.');
    }

    expect(secondResult.turn.reply.text).toBe(
      'I remember you said "first" Stay with me for a minute.'
    );
    expect(resumedLogStore.conversationMessages().map((message) => message.text)).toEqual([
      'first',
      "I'm here. Tell me what you need.",
      'second',
      'I remember you said "first" Stay with me for a minute.'
    ]);
  });
});

function createTestUserMessageEvent(
  message: string,
  eventId: string
): UserMessageRuntimeEvent {
  return createUserMessageRuntimeEvent(message, {
    eventId,
    traceId: `trace_${eventId}`,
    createdAt: '2026-06-09T12:00:00.000Z'
  });
}

function createRawOutputAdapter(rawOutputText: string): RoleModelAdapter {
  return {
    invoke() {
      return Object.freeze({
        rawOutputText
      });
    }
  };
}

function createMalformedRawOutputAdapter(rawOutput: unknown): RoleModelAdapter {
  return {
    invoke() {
      // Bypass the static adapter contract to exercise runtime boundary validation.
      return rawOutput as RoleModelAdapterRawOutput;
    }
  };
}

async function runRejectedTurnWithAdapter(
  roleModelAdapter: RoleModelAdapter,
  eventId: string
): Promise<{
  readonly logStore: RuntimeLogStore;
  readonly reason: string;
  readonly rejected: Extract<
    Awaited<ReturnType<typeof runLocalUserMessageEvent>>,
    { readonly status: 'rejected' }
  >;
  readonly session: ReturnType<typeof createConversationSession>;
}> {
  const session = createConversationSession();
  const logStore = createRuntimeLogStore();
  const result = await runLocalUserMessageEvent({
    event: createTestUserMessageEvent('hello', eventId),
    session,
    logStore,
    roleModelAdapter
  });

  expect(result.status).toBe('rejected');

  if (result.status !== 'rejected') {
    throw new Error('Expected rejected commit result.');
  }

  return {
    logStore,
    reason: result.reason,
    rejected: result,
    session
  };
}

function findRawEvent(
  records: readonly RawEventLogRecord[],
  kind: RawEventLogRecordKind
): RawEventLogRecord {
  const record = records.find((candidate) => candidate.kind === kind);

  if (record === undefined) {
    throw new Error(`Expected raw event kind: ${kind}.`);
  }

  return record;
}

async function createDurableSession(sessionId: string): Promise<string> {
  const storeRoot = mkdtempSync(join(tmpdir(), 'project02-ct04-'));
  const sessionStore = createLocalRuntimeSessionStore({
    storeRoot,
    now: () => '2026-06-09T12:00:00.000Z'
  });

  tempStoreRoots.push(storeRoot);
  await sessionStore.createSession({
    sessionId
  });

  return storeRoot;
}

function createFileConversationLogReader(storeRoot: string): {
  readonly readConversationMessages: (
    sessionId: string
  ) => Promise<readonly ConversationLogRecord[]>;
} {
  return Object.freeze({
    readConversationMessages(sessionId) {
      return Promise.resolve(createFileRuntimeLogStore({
        storeRoot,
        sessionId
      }).conversationMessages());
    }
  });
}

function rewriteRoleModelEvidenceSessionIds(
  rawLog: string,
  sessionId: string
): string {
  const records = rawLog
    .trimEnd()
    .split('\n')
    .filter((line) => line.length > 0)
    .map(parseJsonRecord);

  for (const record of records) {
    rewriteRoleModelEvidenceSessionId(record, sessionId);
  }

  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function rewriteRoleModelEvidenceSessionId(
  record: Record<string, unknown>,
  sessionId: string
): void {
  const ioSnapshot = optionalMutableRecord(record['roleModelIOSnapshot']);

  if (ioSnapshot !== undefined) {
    ioSnapshot['sessionId'] = sessionId;

    const inputEnvelope = optionalMutableRecord(ioSnapshot['inputEnvelope']);
    const decisionContext = optionalMutableRecord(
      inputEnvelope?.['decisionContext']
    );

    if (decisionContext !== undefined) {
      decisionContext['sessionId'] = sessionId;
    }
  }

  const parsedSnapshot = optionalMutableRecord(
    record['parsedRoleModelDecisionSnapshot']
  );

  if (parsedSnapshot !== undefined) {
    parsedSnapshot['sessionId'] = sessionId;
  }

  const commitValidation = optionalMutableRecord(record['commitValidation']);

  if (commitValidation !== undefined) {
    commitValidation['sessionId'] = sessionId;
  }
}

function parseJsonRecord(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);
  const record = optionalMutableRecord(parsed);

  if (record === undefined) {
    throw new Error('Expected raw event JSON line to decode to an object.');
  }

  return record;
}

function optionalMutableRecord(
  value: unknown
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (isMutableRecord(value)) {
    return value;
  }

  throw new Error('Expected mutable JSON object.');
}

function isMutableRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
