import { describe, expect, it } from 'vitest';

import type { CharacterProfile } from '../src/core/conversation.ts';
import {
  createRuntimeLogStore,
  type RuntimeLogStore
} from '../src/runtime/log.ts';
import { createFileRuntimeLogStore } from '../src/runtime/storage/file-runtime-log-store.ts';
import { LocalRuntimeStorageContractError } from '../src/runtime/storage/layout.ts';
import {
  runtimePluginConfigUpdateToolName,
  runtimePluginId
} from '../src/plugins/contract.ts';
import { createLocalRuntimeMutationLockOwnerToken } from '../src/runtime/storage/mutation-lock.ts';
import {
  acquireLocalRuntimeSessionWriterLease,
  createLocalRuntimeSessionStore
} from '../src/runtime/storage/session-store.ts';
import { createTestTempRoot } from './support/temp-root.ts';

type RuntimeLogBackend = 'memory' | 'file';

type RuntimeLogConformanceOutcome =
  | 'accepted'
  | LocalRuntimeStorageContractError['code'];

type RuntimeLogConformanceScenario = {
  readonly name: string;
  readonly expected: RuntimeLogConformanceOutcome;
  run(logStore: RuntimeLogStore, sessionId: string): void;
};

type RuntimeLogStoreFixture = {
  readonly logStore: RuntimeLogStore;
  release(): Promise<void>;
};

const sessionId = 'matrix-session';
const identity = {
  eventId: 'evt_runtime_log_conformance',
  traceId: 'trace_runtime_log_conformance',
  createdAt: '2026-07-16T00:00:00.000Z'
} as const;
const miraCharacter = Object.freeze({
  id: 'mira',
  displayName: 'Mira'
} satisfies CharacterProfile);
const novaCharacter = Object.freeze({
  id: 'nova',
  displayName: 'Nova'
} satisfies CharacterProfile);

const acceptedScenarios = [
  {
    name: 'accepts a canonical completed turn without visible messages',
    expected: 'accepted',
    run(logStore) {
      appendTurnStart(logStore);
      logStore.appendRawEvent({
        ...identity,
        kind: 'runtime_turn_completed',
        eventType: 'USER_MESSAGE',
        status: 'completed'
      });
    }
  },
  {
    name: 'accepts a canonical completed turn for the expected character',
    expected: 'accepted',
    run(logStore, currentSessionId) {
      appendTurnStart(logStore);
      appendUserMessage(logStore, currentSessionId);
      logStore.appendConversationMessage(
        characterMessage(currentSessionId),
        miraCharacter
      );
      logStore.appendRawEvent({
        ...identity,
        kind: 'runtime_turn_completed',
        eventType: 'USER_MESSAGE',
        status: 'completed',
        visibleMessageIds: [
          `${currentSessionId}:message-1`,
          `${currentSessionId}:message-2`
        ]
      });
    }
  }
] as const satisfies readonly RuntimeLogConformanceScenario[];

const rejectedScenarios = [
  {
    name: 'rejects tool metadata on a non-tool raw event',
    expected: 'malformed_record',
    run(logStore) {
      logStore.appendTrace({
        ...identity,
        step: 'runtime_event_received'
      });
      logStore.appendRawEvent({
        ...identity,
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE',
        toolRound: 1
      });
    }
  },
  {
    name: 'rejects runtime_turn_completed as the first raw record',
    expected: 'malformed_record',
    run(logStore) {
      logStore.appendRawEvent({
        ...identity,
        kind: 'runtime_turn_completed',
        eventType: 'USER_MESSAGE',
        status: 'completed'
      });
    }
  },
  {
    name: 'rejects runtime_turn_started as the first trace record',
    expected: 'malformed_record',
    run(logStore) {
      logStore.appendTrace({
        ...identity,
        step: 'runtime_turn_started'
      });
    }
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
        toolRound: 1,
        toolName: 'memory.search',
        toolPluginId: 'memory.fixture',
        toolResult: {
          status: 'accepted',
          output: { ok: true },
          evidence: []
        }
      });
    }
  },
  {
    name: 'rejects a config effect attached to an unrelated finished tool call',
    expected: 'malformed_record',
    run(logStore) {
      const toolCallId = 'call_unrelated_config_effect';
      const expectedFingerprint = 'sha256:expected';
      const resultFingerprint = 'sha256:result';

      appendTurnStart(logStore);
      logStore.appendRawEvent({
        ...identity,
        kind: 'tool_call_started',
        eventType: 'USER_MESSAGE',
        toolCallId,
        toolRound: 1,
        toolName: 'memory.search',
        toolPluginId: 'memory.fixture',
        toolInput: {
          pluginId: 'config-target.fixture',
          fieldName: 'tone',
          operation: 'set',
          value: 'warm',
          expectedFingerprint
        }
      });
      logStore.appendRawEvent({
        ...identity,
        kind: 'tool_call_finished',
        eventType: 'USER_MESSAGE',
        toolCallId,
        dispatchedToHost: true,
        toolRound: 1,
        toolName: runtimePluginConfigUpdateToolName,
        toolPluginId: runtimePluginId,
        toolResult: {
          status: 'accepted',
          output: {
            status: 'approved_pending_commit',
            pluginId: 'config-target.fixture',
            fieldName: 'tone',
            operation: 'set',
            fingerprint: resultFingerprint
          },
          evidence: [
            {
              ...identity,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId: runtimePluginId,
              evidenceKind: 'tool_invocation',
              status: 'accepted',
              summary: 'Approved config update.',
              redactionLabels: [],
              configFingerprint: resultFingerprint
            }
          ]
        }
      });
      logStore.appendRawEvent({
        ...identity,
        kind: 'runtime_turn_completed',
        eventType: 'USER_MESSAGE',
        status: 'completed',
        toolCallIds: [toolCallId],
        runtimeConfigEffects: [
          {
            ...identity,
            kind: 'runtime_plugin_config_effect',
            effectId: toolCallId,
            targetPluginId: 'config-target.fixture',
            targetConfigPath: '/tmp/config-target.json',
            fieldName: 'tone',
            expectedFingerprint,
            resultFingerprint,
            operation: { kind: 'set', value: 'warm' }
          }
        ]
      });
    }
  },
  {
    name: 'rejects a conversation speaker that differs from expectedCharacter',
    expected: 'malformed_record',
    run(logStore, currentSessionId) {
      appendTurnStart(logStore);
      appendUserMessage(logStore, currentSessionId);
      logStore.appendConversationMessage(
        characterMessage(currentSessionId),
        novaCharacter
      );
    }
  },
  {
    name: 'rejects an empty conversation message session ID',
    expected: 'malformed_record',
    run(logStore) {
      appendTurnStart(logStore);
      appendUserMessage(logStore, '');
    }
  }
] as const satisfies readonly RuntimeLogConformanceScenario[];

describe('runtime log store evidence conformance', () => {
  it.each(acceptedScenarios)('$name', async (scenario) => {
    await expectScenarioOutcomes(scenario);
  });

  it.each(rejectedScenarios)('$name', async (scenario) => {
    await expectScenarioOutcomes(scenario);
  });
});

async function expectScenarioOutcomes(
  scenario: RuntimeLogConformanceScenario
): Promise<void> {
  const outcomes: Record<RuntimeLogBackend, RuntimeLogConformanceOutcome> = {
    memory: await runScenario('memory', scenario),
    file: await runScenario('file', scenario)
  };

  expect(outcomes).toEqual({
    memory: scenario.expected,
    file: scenario.expected
  });
}

async function runScenario(
  backend: RuntimeLogBackend,
  scenario: RuntimeLogConformanceScenario
): Promise<RuntimeLogConformanceOutcome> {
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
  backend: RuntimeLogBackend
): Promise<RuntimeLogStoreFixture> {
  if (backend === 'memory') {
    return {
      logStore: createRuntimeLogStore(),
      release: () => Promise.resolve()
    };
  }

  const storeRoot = createTestTempRoot('project02-log-conformance-');
  await createLocalRuntimeSessionStore({ storeRoot }).createSession({
    sessionId,
    createdAt: identity.createdAt
  });
  const ownerToken = createLocalRuntimeMutationLockOwnerToken();
  const logStore = createFileRuntimeLogStore({
    storeRoot,
    sessionId,
    writerLockOwnerToken: ownerToken
  });
  const writerLease = await acquireLocalRuntimeSessionWriterLease({
    storeRoot,
    sessionId,
    ownerToken
  });

  return {
    logStore,
    release: async () => {
      await writerLease.release();
    }
  };
}

function captureOutcome(operation: () => void): RuntimeLogConformanceOutcome {
  try {
    operation();
    return 'accepted';
  } catch (error: unknown) {
    if (error instanceof LocalRuntimeStorageContractError) {
      return error.code;
    }

    throw error;
  }
}

function appendTurnStart(logStore: RuntimeLogStore): void {
  logStore.appendTrace({
    ...identity,
    step: 'runtime_event_received'
  });
  logStore.appendRawEvent({
    ...identity,
    kind: 'runtime_event_received',
    eventType: 'USER_MESSAGE'
  });
}

function appendUserMessage(
  logStore: RuntimeLogStore,
  currentSessionId: string
): void {
  logStore.appendConversationMessage({
    ...identity,
    id: `${currentSessionId}:message-1`,
    role: 'user',
    speakerId: 'local-user',
    speakerName: 'You',
    text: 'hello',
    committedAt: '2026-07-16T00:00:01.000Z'
  });
}

function characterMessage(currentSessionId: string) {
  return {
    ...identity,
    id: `${currentSessionId}:message-2`,
    role: 'character',
    speakerId: miraCharacter.id,
    speakerName: miraCharacter.displayName,
    text: 'hi',
    committedAt: '2026-07-16T00:00:02.000Z'
  } as const;
}
