import { describe, expect, it } from 'vitest';

import {
  createRuntimePluginAfterTurnCommittedContext,
  createRuntimePluginContext,
  createRuntimePluginEvidenceSnapshot,
  createRuntimePluginHealthSnapshot,
  createRuntimePluginToolInvocationSnapshot,
  createRuntimePluginTurnEvidenceSnapshot,
  runtimePluginContractVersion
} from '../src/plugins/types.ts';
import {
  createDecisionContext,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot
} from '../src/role-model/contracts.ts';
import {
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent
} from '../src/runtime/event.ts';
import {
  createLocalRuntimeSessionMetadata,
  createLocalRuntimeStorageSchemaMarker
} from '../src/runtime/storage/layout.ts';
import {
  runtimeEventIdentityKey
} from '../src/runtime/storage/runtime-evidence-validation.ts';

const nonCanonicalTimestamp = '2026-07-11T08:00:00+08:00';
const canonicalTimestamp = '2026-07-11T00:00:00.000Z';

describe('canonical timestamp boundaries', () => {
  it('includes createdAt in durable runtime identity keys', () => {
    expect(
      runtimeEventIdentityKey({
        eventId: 'evt_same',
        traceId: 'trace_same',
        createdAt: canonicalTimestamp
      })
    ).not.toBe(
      runtimeEventIdentityKey({
        eventId: 'evt_same',
        traceId: 'trace_same',
        createdAt: '2026-07-11T00:00:01.000Z'
      })
    );
  });

  it.each([
    [
      'plugin context',
      () =>
        createRuntimePluginContext({
          ...identity(nonCanonicalTimestamp),
          sessionId: 'session-canonical-time',
          eventType: 'USER_MESSAGE',
          currentUserMessage: 'hello',
          character: { id: 'mira', displayName: 'Mira' }
        })
    ],
    [
      'plugin after-turn commit',
      () =>
        createRuntimePluginAfterTurnCommittedContext({
          ...identity(canonicalTimestamp),
          sessionId: 'session-canonical-time',
          eventType: 'USER_MESSAGE',
          currentUserMessage: 'hello',
          character: { id: 'mira', displayName: 'Mira' },
          committedAt: nonCanonicalTimestamp,
          visibleMessages: []
        })
    ],
    [
      'plugin evidence',
      () =>
        createRuntimePluginEvidenceSnapshot({
          ...identity(nonCanonicalTimestamp),
          kind: 'runtime_plugin_evidence_snapshot',
          pluginId: 'memory.fixture',
          evidenceKind: 'before_role_model_call',
          status: 'accepted',
          summary: 'safe',
          redactionLabels: []
        })
    ],
    [
      'plugin health',
      () =>
        createRuntimePluginHealthSnapshot({
          pluginId: 'memory.fixture',
          status: 'ok',
          checkedAt: nonCanonicalTimestamp,
          summary: 'safe',
          redactionLabels: []
        })
    ],
    [
      'plugin tool invocation',
      () =>
        createRuntimePluginToolInvocationSnapshot({
          ...identity(nonCanonicalTimestamp),
          kind: 'runtime_plugin_tool_invocation_snapshot',
          pluginId: 'memory.fixture',
          toolName: 'memory.search',
          input: {},
          result: { status: 'accepted', output: null, evidence: [] }
        })
    ],
    [
      'plugin turn evidence',
      () =>
        createRuntimePluginTurnEvidenceSnapshot({
          ...identity(nonCanonicalTimestamp),
          kind: 'runtime_plugin_turn_evidence_snapshot',
          contractVersion: runtimePluginContractVersion,
          plugins: [],
          contextItems: [],
          toolInvocations: [],
          evidence: [],
          health: []
        })
    ],
    [
      'role-model IO evidence',
      () =>
        createRoleModelIOSnapshot({
          ...identity(nonCanonicalTimestamp),
          sessionId: 'session-canonical-time',
          inputEnvelope: canonicalInputEnvelope(),
          rawOutputText: '{"toolCalls":[]}'
        })
    ],
    [
      'session metadata',
      () =>
        createLocalRuntimeSessionMetadata({
          sessionId: 'session-canonical-time',
          createdAt: nonCanonicalTimestamp,
          updatedAt: canonicalTimestamp
        })
    ],
    [
      'session metadata update',
      () =>
        createLocalRuntimeSessionMetadata({
          sessionId: 'session-canonical-time',
          createdAt: canonicalTimestamp,
          updatedAt: nonCanonicalTimestamp
        })
    ],
    [
      'storage schema marker',
      () =>
        createLocalRuntimeStorageSchemaMarker({
          createdAt: nonCanonicalTimestamp
        })
    ]
  ])('rejects non-canonical timestamps at the %s boundary', (_label, run) => {
    expect(run).toThrow('must be a canonical UTC ISO timestamp');
  });
});

function identity(createdAt: string) {
  return {
    eventId: 'evt_canonical_timestamp_boundary',
    traceId: 'trace_canonical_timestamp_boundary',
    createdAt
  } as const;
}

function canonicalInputEnvelope() {
  const runtimeIdentity = createRuntimeEventIdentity({
    ...identity(canonicalTimestamp)
  });

  return createRoleModelInputEnvelope({
    event: createUserMessageRuntimeEvent('hello', runtimeIdentity),
    decisionContext: createDecisionContext({
      sessionId: 'session-canonical-time',
      characterSnapshot: { id: 'mira', displayName: 'Mira' }
    })
  });
}
