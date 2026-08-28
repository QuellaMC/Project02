import {testCharacterProfile} from '../support/character-fixtures.ts';
import {describe, expect, it} from 'vitest';

import type {CharacterProfile} from '../../src/core/index.ts';
import {type RuntimeLogStore} from '../../src/runtime/evidence/contract.ts';
import type {RawEventLogRecordInput} from '../../src/runtime/evidence/records.ts';
import {createRuntimeLogStore} from '../../src/runtime/evidence/index.ts';
import {createFileRuntimeLogStore} from '../../src/runtime/storage/file-runtime-log-store.ts';
import {LocalRuntimeStorageContractError} from '../../src/runtime/storage/layout-contract.ts';
import {createLocalRuntimeMutationLockOwnerToken} from '../../src/runtime/storage/mutation-lock.ts';
import {
  acquireLocalRuntimeSessionWriterLease,
  createLocalRuntimeSessionStore,
} from '../../src/runtime/storage/session-store.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {
  appendModelRound,
  appendVisibleMessageWithCommitAnchor,
  completedTerminalRecord,
} from '../support/runtime-log-fixtures.ts';

type RuntimeLogBackend = 'memory' | 'file';

type RuntimeLogConformanceOutcome =
  'accepted' | LocalRuntimeStorageContractError['code'];

type RuntimeLogConformanceScenario = {
  readonly name: string;
  readonly expected: RuntimeLogConformanceOutcome;
  run(logStore: RuntimeLogStore, sessionId: string): void;
};

type RuntimeLogStoreFixture = {
  readonly logStore: RuntimeLogStore;
  release(): Promise<void>;
};

const conversationId = 'matrix-session';
const sessionId = `${conversationId}.1`;
const identity = {
  eventId: 'evt_runtime_log_conformance',
  traceId: 'trace_runtime_log_conformance',
  createdAt: '2026-07-16T00:00:00.000Z',
} as const;
const miraCharacter = Object.freeze(
  testCharacterProfile satisfies CharacterProfile,
);
const novaCharacter = Object.freeze({
  id: 'nova',
  displayName: 'Nova',
} satisfies CharacterProfile);

const acceptedScenarios = [
  {
    // A session end closes like this: a completed turn that ran no model round.
    name: 'accepts a completed turn that ran no model round',
    expected: 'accepted',
    run(logStore) {
      appendTurnStart(logStore);
      logStore.appendRawEvent({
        ...identity,
        kind: 'runtime_turn_completed',
        eventType: 'USER_MESSAGE',
        status: 'completed',
      });
    },
  },
  {
    name: 'accepts a canonical completed turn for the expected character',
    expected: 'accepted',
    run(logStore, currentSessionId) {
      appendTurnStart(logStore);
      appendUserMessage(logStore, currentSessionId);
      appendCharacterMessage(logStore, currentSessionId, miraCharacter);
      logStore.appendRawEvent({
        ...completedTerminal(currentSessionId, 'hi'),
        visibleMessageIds: [
          `${currentSessionId}:message-1`,
          `${currentSessionId}:message-2`,
        ],
      });
    },
  },
] as const satisfies readonly RuntimeLogConformanceScenario[];

const rejectedScenarios = [
  {
    name: 'rejects tool metadata on a non-tool raw event',
    expected: 'malformed_record',
    run(logStore) {
      logStore.appendRawEvent({
        ...identity,
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE',
        toolName: 'memory.search',
      });
    },
  },
  {
    name: 'rejects runtime_turn_completed as the first raw record',
    expected: 'malformed_record',
    run(logStore, currentSessionId) {
      logStore.appendRawEvent(completedTerminal(currentSessionId));
    },
  },
  {
    name: 'rejects a tool finish before its matching start',
    expected: 'malformed_record',
    run(logStore) {
      appendTurnStart(logStore);
      logStore.appendRawEvent({
        ...identity,
        kind: 'tool_call_finished',
        eventType: 'USER_MESSAGE',
        status: 'completed',
        toolCallId: 'call_1',
        dispatchedToHost: true,
        round: 1,
        toolName: 'memory.search',
        toolPluginId: 'memory.fixture',
        toolResult: {
          status: 'accepted',
          output: {ok: true},
          evidence: [],
        },
      });
    },
  },
  {
    name: 'rejects a conversation speaker that differs from expectedCharacter',
    expected: 'malformed_record',
    run(logStore, currentSessionId) {
      appendTurnStart(logStore);
      appendUserMessage(logStore, currentSessionId);
      appendCharacterMessage(logStore, currentSessionId, novaCharacter);
    },
  },
  {
    name: 'rejects an empty conversation message session ID',
    expected: 'malformed_record',
    run(logStore) {
      appendTurnStart(logStore);
      appendUserMessage(logStore, '');
    },
  },
  {
    name: 'rejects a second user row committed into one turn',
    expected: 'malformed_record',
    run(logStore, currentSessionId) {
      appendTurnStart(logStore);
      appendUserMessage(logStore, currentSessionId);
      logStore.appendRawEvent({
        ...identity,
        kind: 'visible_message_committed',
        eventType: 'USER_MESSAGE',
        visibleMessageIds: [`${currentSessionId}:message-2`],
        visibleMessage: {
          id: `${currentSessionId}:message-2`,
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'hello',
        },
        committedAt: '2026-07-16T00:00:02.000Z',
      });
    },
  },
  {
    name: 'rejects persisting a prepared record made stale by a later append',
    expected: 'malformed_record',
    run(logStore, currentSessionId) {
      appendTurnStart(logStore);

      const staleTerminal = logStore.prepareRawEvent({
        ...identity,
        kind: 'runtime_turn_rejected',
        eventType: 'USER_MESSAGE',
        status: 'rejected',
        reason: 'runtime_failure',
        message: 'prepared before the user message committed',
      });

      appendUserMessage(logStore, currentSessionId);
      logStore.persistPreparedRawEvent(staleTerminal);
    },
  },
  {
    name: 'rejects a record whose model input differs from the turn user row',
    expected: 'malformed_record',
    run(logStore, currentSessionId) {
      appendTurnStart(logStore);
      appendUserMessage(logStore, currentSessionId);
      appendReplyRound(logStore, currentSessionId);
      logStore.appendRawEvent({
        ...completedTerminal(currentSessionId, 'hi'),
        visibleMessageIds: [`${currentSessionId}:message-1`],
        payloadSummary: {normalizedCurrentUserMessage: 'not what the row says'},
      });
    },
  },
  {
    name: 'rejects a user row whose text is not normalized',
    expected: 'malformed_record',
    run(logStore, currentSessionId) {
      appendTurnStart(logStore);
      logStore.appendRawEvent({
        ...identity,
        kind: 'visible_message_committed',
        eventType: 'USER_MESSAGE',
        visibleMessageIds: [`${currentSessionId}:message-1`],
        visibleMessage: {
          id: `${currentSessionId}:message-1`,
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: '  padded  ',
        },
        committedAt: '2026-07-16T00:00:01.000Z',
      });
    },
  },
] as const satisfies readonly RuntimeLogConformanceScenario[];

const readScenarios = [
  {
    // A crash ends every turn it interrupts exactly like this.
    name: 'surfaces an open turn to every read',
    expected: 'accepted',
    run(logStore, currentSessionId) {
      appendTurnStart(logStore);
      appendUserMessage(logStore, currentSessionId);
      logStore.readSessionEvidence();
      logStore.rawEvents();
      logStore.conversationMessages();
      logStore.traceEntries();
    },
  },
] as const satisfies readonly RuntimeLogConformanceScenario[];

describe('runtime log store evidence conformance', () => {
  it.each(acceptedScenarios)('$name', async scenario => {
    await expectScenarioOutcomes(scenario);
  });

  it.each(rejectedScenarios)('$name', async scenario => {
    await expectScenarioOutcomes(scenario);
  });

  it.each(readScenarios)('$name', async scenario => {
    await expectScenarioOutcomes(scenario);
  });
});

type RuntimeLogScenarioResult = {
  readonly outcome: RuntimeLogConformanceOutcome;
  readonly message: string | undefined;
};

async function expectScenarioOutcomes(
  scenario: RuntimeLogConformanceScenario,
): Promise<void> {
  const memory = await runScenario('memory', scenario);
  const file = await runScenario('file', scenario);

  expect({memory: memory.outcome, file: file.outcome}).toEqual({
    memory: scenario.expected,
    file: scenario.expected,
  });
  expect(memory.message).toBe(file.message);
}

async function runScenario(
  backend: RuntimeLogBackend,
  scenario: RuntimeLogConformanceScenario,
): Promise<RuntimeLogScenarioResult> {
  const fixture = await createRuntimeLogStoreFixture(backend);

  try {
    return captureOutcome(() => {
      scenario.run(fixture.logStore, sessionId);
    });
  } finally {
    await fixture.release();
  }
}

async function createRuntimeLogStoreFixture(
  backend: RuntimeLogBackend,
): Promise<RuntimeLogStoreFixture> {
  if (backend === 'memory') {
    return {
      logStore: createRuntimeLogStore({
        sessionId,
        boundCharacter: testCharacterProfile,
      }),
      release: () => Promise.resolve(),
    };
  }

  const storeRoot = createTestTempRoot('project02-log-conformance-');
  await createLocalRuntimeSessionStore({
    storeRoot,
    characterId: testCharacterProfile.id,
  }).createSession({
    conversationId,
    createdAt: identity.createdAt,
  });
  const ownerToken = createLocalRuntimeMutationLockOwnerToken();
  const logStore = createFileRuntimeLogStore({
    storeRoot,
    sessionId,
    characterId: testCharacterProfile.id,
    writerLockOwnerToken: ownerToken,
    boundCharacter: testCharacterProfile,
  });
  const writerLease = await acquireLocalRuntimeSessionWriterLease({
    storeRoot,
    sessionId,
    ownerToken,
  });

  return {
    logStore,
    release: async () => {
      await writerLease.release();
    },
  };
}

function captureOutcome(operation: () => void): RuntimeLogScenarioResult {
  try {
    operation();
    return {outcome: 'accepted', message: undefined};
  } catch (error: unknown) {
    if (error instanceof LocalRuntimeStorageContractError) {
      return {outcome: error.code, message: error.message};
    }

    throw error;
  }
}

function appendTurnStart(logStore: RuntimeLogStore): void {
  logStore.appendRawEvent({
    ...identity,
    kind: 'runtime_event_received',
    eventType: 'USER_MESSAGE',
  });
}

function appendReplyRound(
  logStore: RuntimeLogStore,
  currentSessionId: string,
): void {
  appendModelRound(logStore, identity, {
    round: 1,
    sessionId: currentSessionId,
    decision: {toolCalls: [{name: 'visible_reply', input: {text: 'hi'}}]},
  });
}

function completedTerminal(
  currentSessionId: string,
  acceptedVisibleReplyText?: string,
): RawEventLogRecordInput {
  return completedTerminalRecord(identity, {
    sessionId: currentSessionId,
    ...(acceptedVisibleReplyText === undefined
      ? {}
      : {acceptedVisibleReplyText}),
  });
}

function appendUserMessage(
  logStore: RuntimeLogStore,
  currentSessionId: string,
): void {
  logStore.appendRawEvent({
    ...identity,
    kind: 'visible_message_committed',
    eventType: 'USER_MESSAGE',
    visibleMessageIds: [`${currentSessionId}:message-1`],
    visibleMessage: {
      id: `${currentSessionId}:message-1`,
      role: 'user',
      speakerId: 'local-user',
      speakerName: 'You',
      text: 'hello',
    },
    committedAt: '2026-07-16T00:00:01.000Z',
  });
}

function appendCharacterMessage(
  logStore: RuntimeLogStore,
  currentSessionId: string,
  character: CharacterProfile,
): void {
  appendVisibleMessageWithCommitAnchor(
    logStore,
    characterMessage(currentSessionId),
    character,
  );
}

function characterMessage(currentSessionId: string) {
  return {
    ...identity,
    id: `${currentSessionId}:message-2`,
    role: 'character',
    speakerId: miraCharacter.id,
    speakerName: miraCharacter.displayName,
    text: 'hi',
    committedAt: '2026-07-16T00:00:02.000Z',
  } as const;
}
