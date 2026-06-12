import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  agentCapabilityContractVersion,
  characterStatePatchModelToolName,
  createAgentCapability,
  createAgentCapabilityContextItem,
  createAgentCapabilityEvidenceSnapshot,
  createAgentCapabilityHealthSnapshot,
  createAgentCapabilityListingSnapshot,
  createAgentCapabilityManifest,
  createAgentCapabilityProvidedTool,
  createAgentCapabilityRegistrySnapshot,
  createAgentCapabilityTurnEvidenceSnapshot,
  createFirstPartyModelToolsCapability,
  createRuntimeCapabilityAfterTurnCommittedContext,
  createRuntimeCapabilityContext,
  firstPartyModelToolsCapabilityId,
  validateAgentCapabilityManifest,
  visibleReplyModelToolName,
  type AgentCapabilityManifest,
  type AgentCapabilityProvidedTool
} from '../src/index.ts';

describe('agent capability contract gate', () => {
  it('registers first-party model tools and a fake memory provider through one static contract', () => {
    const firstParty = createFirstPartyModelToolsCapability();
    const fakeMemory = createFakeMemoryCapability();

    const registry = createAgentCapabilityRegistrySnapshot([
      firstParty,
      fakeMemory
    ]);

    expect(registry.contractVersion).toBe(agentCapabilityContractVersion);
    expect(registry.capabilities.map((entry) => entry.manifest.id)).toEqual([
      firstPartyModelToolsCapabilityId,
      'memory.fixture'
    ]);
    expect(firstParty.providedTools.map((tool) => tool.name)).toEqual([
      visibleReplyModelToolName,
      characterStatePatchModelToolName
    ]);
    expect(
      firstParty.providedTools.map((tool) => tool.validationOwner)
    ).toEqual(['built_in_model_tools', 'built_in_model_tools']);
    expect(registry.capabilities[0]?.registeredLifecycleHooks).toEqual([
      'tool_provider'
    ]);
    expect(fakeMemory.manifest.declaredCapabilities).toEqual([
      'context_provider',
      'before_role_model_call',
      'tool_provider',
      'handle_tool_call',
      'after_turn_committed',
      'on_session_end',
      'health'
    ]);
    expect(fakeMemory.providedTools[0]?.name).toBe('memory.search');
    expect(registry.capabilities[1]?.registeredLifecycleHooks).toEqual([
      'tool_provider',
      'before_role_model_call',
      'after_turn_committed',
      'on_session_end',
      'health'
    ]);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.capabilities)).toBe(true);
    expect(Object.isFrozen(registry.capabilities[0]?.manifest)).toBe(true);
  });

  it('reports handle_tool_call only when a tool handler is installed', () => {
    const toolProvider = createAgentCapability({
      manifest: {
        ...createBaseManifest(),
        id: 'tool.provider.fixture',
        declaredCapabilities: ['tool_provider', 'handle_tool_call']
      },
      providedTools: [createFakeSearchTool()]
    });
    const toolHandler = createAgentCapability({
      manifest: {
        ...createBaseManifest(),
        id: 'tool.handler.fixture',
        declaredCapabilities: ['tool_provider', 'handle_tool_call']
      },
      providedTools: [createFakeSearchTool()],
      lifecycleHooks: {
        handleToolCall() {
          return {
            status: 'accepted',
            output: { results: [] },
            evidence: []
          };
        }
      }
    });

    const registry = createAgentCapabilityRegistrySnapshot([
      toolProvider,
      toolHandler
    ]);

    expect(registry.capabilities[0]?.registeredLifecycleHooks).toEqual([
      'tool_provider'
    ]);
    expect(registry.capabilities[1]?.registeredLifecycleHooks).toEqual([
      'tool_provider',
      'handle_tool_call'
    ]);
  });

  it('accepts normalized OpenClaw, TencentDB, Hermes, and MCP fixture manifests', () => {
    const fixtureNames = [
      'openclaw-memory-manifest.json',
      'tencentdb-memory-manifest.json',
      'hermes-memory-manifest.json',
      'mcp-tools-resources-manifest.json'
    ];

    const manifests = fixtureNames.map((name) =>
      createAgentCapabilityManifest(readJsonFixture(name))
    );

    expect(manifests.map((manifest) => manifest.compatibility.sourceSystem)).toEqual([
      'openclaw',
      'TencentDB-Agent-Memory',
      'hermes',
      'model-context-protocol'
    ]);
    expect(manifests.map((manifest) => manifest.contractVersion)).toEqual([
      agentCapabilityContractVersion,
      agentCapabilityContractVersion,
      agentCapabilityContractVersion,
      agentCapabilityContractVersion
    ]);
    expect(manifests[1]?.config.fields.some((field) => field.secret)).toBe(true);
    expect(manifests[3]?.declaredCapabilities).toContain('context_provider');
  });

  it('rejects unsupported versions, unsupported kinds, duplicate declarations, duplicate ids, and malformed tools', () => {
    expect(
      validateAgentCapabilityManifest({
        ...createBaseManifest(),
        contractVersion: 'mvp-999.agent_capability.v9'
      })
    ).toMatchObject({
      status: 'rejected',
      reason: 'unsupported_contract_version'
    });
    expect(
      validateAgentCapabilityManifest({
        ...createBaseManifest(),
        kind: 'external_plugin'
      })
    ).toMatchObject({
      status: 'rejected',
      reason: 'unsupported_capability_kind'
    });
    expect(
      validateAgentCapabilityManifest({
        ...createBaseManifest(),
        declaredCapabilities: ['health', 'health']
      })
    ).toMatchObject({
      status: 'rejected',
      reason: 'duplicate_declaration'
    });
    expect(() =>
      createAgentCapability({
        manifest: {
          ...createBaseManifest(),
          id: 'tool.missing_declaration',
          declaredCapabilities: ['health']
        },
        providedTools: [createFakeSearchTool()]
      })
    ).toThrow('must declare tool_provider');
    expect(() =>
      createAgentCapabilityRegistrySnapshot([
        createAgentCapability({ manifest: createBaseManifest() }),
        createAgentCapability({ manifest: createBaseManifest() })
      ])
    ).toThrow('Duplicate capability id');
    expect(() =>
      createAgentCapabilityProvidedTool({
        ...createFakeSearchTool(),
        inputContract: {
          type: 'object',
          additionalFields: false,
          fields: [
            {
              name: 'query',
              description: 'Search query.',
              required: true
            },
            {
              name: 'query',
              description: 'Duplicate query.',
              required: false
            }
          ]
        }
      })
    ).toThrow('declared more than once');
  });

  it('creates immutable runtime context and context item snapshots without exposing mutable internals', () => {
    const mutableCharacter = {
      id: 'mira',
      displayName: 'Mira'
    };
    const runtimeContext = createRuntimeCapabilityContext({
      eventId: 'evt_capability_context',
      traceId: 'trace_capability_context',
      createdAt: '2026-06-12T00:00:00.000Z',
      sessionId: 'session-capability',
      eventType: 'USER_MESSAGE',
      currentUserMessage: 'remember this',
      character: mutableCharacter,
      redactionLabels: ['private']
    });
    const contextItemInput: MutableContextItemInput = {
      capabilityId: 'memory.fixture',
      id: 'memory.fixture.item_1',
      kind: 'memory',
      text: 'Mira prefers concise answers.',
      budget: {
        estimatedTokens: 8,
        priority: 1
      },
      sourceReferences: [
        {
          kind: 'memory',
          id: 'mem_1',
          title: 'preference'
        }
      ],
      confidence: 0.8,
      redactionLabels: ['memory']
    };
    const contextItem = createAgentCapabilityContextItem(contextItemInput);
    const visibleMessages: MutableVisibleMessageInput[] = [
      {
        id: 'evt_capability_context-user',
        role: 'user',
        speakerId: 'local-user',
        speakerName: 'You',
        text: 'remember this'
      },
      {
        id: 'evt_capability_context-character',
        role: 'character',
        speakerId: 'mira',
        speakerName: 'Mira',
        text: 'noted'
      }
    ];
    const afterContext = createRuntimeCapabilityAfterTurnCommittedContext({
      eventId: 'evt_capability_context',
      traceId: 'trace_capability_context',
      createdAt: '2026-06-12T00:00:00.000Z',
      sessionId: 'session-capability',
      eventType: 'USER_MESSAGE',
      currentUserMessage: 'remember this',
      character: mutableCharacter,
      redactionLabels: ['private'],
      committedAt: '2026-06-12T00:00:01.000Z',
      visibleMessages
    });

    mutableCharacter.displayName = 'Mutated Mira';
    contextItemInput.text = 'mutated context';
    contextItemInput.sourceReferences[0] = {
      kind: 'memory',
      id: 'mem_mutated'
    };
    const visibleCharacterMessage = visibleMessages[1];

    if (visibleCharacterMessage === undefined) {
      throw new Error('Expected visible character message input.');
    }

    visibleCharacterMessage.text = 'mutated';

    expect(runtimeContext.character).toEqual({
      id: 'mira',
      displayName: 'Mira'
    });
    expect(runtimeContext.turnId).toBe('evt_capability_context');
    expect(runtimeContext.privacy.exposePrivateConfig).toBe(false);
    expect(afterContext.committedTurn.visibleMessageIds).toEqual([
      'evt_capability_context-user',
      'evt_capability_context-character'
    ]);
    expect(afterContext.committedTurn.visibleMessages.map((message) => message.text))
      .toEqual(['remember this', 'noted']);
    expect(contextItem.text).toBe('Mira prefers concise answers.');
    expect(contextItem.sourceReferences).toEqual([
      {
        kind: 'memory',
        id: 'mem_1',
        title: 'preference'
      }
    ]);
    expect(Object.isFrozen(runtimeContext)).toBe(true);
    expect(Object.isFrozen(runtimeContext.character)).toBe(true);
    expect(Object.isFrozen(afterContext.committedTurn)).toBe(true);
    expect(Object.isFrozen(afterContext.committedTurn.visibleMessages)).toBe(true);
    expect(Object.isFrozen(contextItem)).toBe(true);
    expect(Object.isFrozen(contextItem.sourceReferences)).toBe(true);
  });

  it('rejects non-finite context item confidence at the capability contract boundary', () => {
    const contextItem = {
      capabilityId: 'memory.fixture',
      id: 'memory.fixture.item_1',
      kind: 'memory',
      text: 'Mira prefers concise answers.',
      budget: {
        estimatedTokens: 8,
        priority: 1
      },
      sourceReferences: [
        {
          kind: 'memory',
          id: 'mem_1',
          title: 'preference'
        }
      ],
      redactionLabels: ['memory']
    };

    expect(() =>
      createAgentCapabilityContextItem({
        ...contextItem,
        confidence: Number.NaN
      })
    ).toThrow(
      'Capability context item confidence must be a finite number between 0 and 1.'
    );
    expect(() =>
      createAgentCapabilityContextItem({
        ...contextItem,
        confidence: Number.POSITIVE_INFINITY
      })
    ).toThrow(
      'Capability context item confidence must be a finite number between 0 and 1.'
    );
    expect(
      createAgentCapabilityContextItem({
        ...contextItem,
        confidence: 1
      }).confidence
    ).toBe(1);
  });

  it('creates redacted capability turn evidence with distinct policy outcomes', () => {
    const identity = {
      eventId: 'evt_capability_evidence',
      traceId: 'trace_capability_evidence',
      createdAt: '2026-06-12T00:05:00.000Z'
    } as const;
    const listing = createAgentCapabilityListingSnapshot({
      capabilityId: 'memory.fixture',
      manifest: {
        ...createBaseManifest(),
        id: 'memory.fixture',
        displayName: 'Memory fixture',
        kind: 'memory_provider',
        declaredCapabilities: ['before_role_model_call', 'health'],
        config: {
          fields: [
            {
              name: 'gateway_api_key',
              description: 'Gateway API key.',
              required: true,
              secret: true,
              redactionLabels: ['secret']
            }
          ],
          fingerprint: 'gateway_api_key=plain-secret'
        }
      },
      providedTools: [],
      registeredLifecycleHooks: ['before_role_model_call', 'health'],
      installed: true,
      registered: true,
      enabled: true,
      availableForTurn: false,
      redactionLabels: ['secret'],
      configFingerprint: 'gateway_api_key=plain-secret',
      healthStatus: 'degraded'
    });
    const health = createAgentCapabilityHealthSnapshot({
      capabilityId: 'memory.fixture',
      status: 'degraded',
      checkedAt: identity.createdAt,
      summary: 'health token=secret-token degraded',
      redactionLabels: ['secret']
    });
    const evidence = [
      createAgentCapabilityEvidenceSnapshot({
        ...identity,
        kind: 'agent_capability_evidence_snapshot',
        capabilityId: 'memory.fixture',
        evidenceKind: 'before_role_model_call',
        status: 'rejected',
        summary: 'required Bearer secret-token rejected',
        policyOutcome: 'required_rejected',
        redactionLabels: ['secret']
      }),
      createAgentCapabilityEvidenceSnapshot({
        ...identity,
        kind: 'agent_capability_evidence_snapshot',
        capabilityId: 'memory.fixture',
        evidenceKind: 'before_role_model_call',
        status: 'degraded',
        summary: 'optional degraded',
        policyOutcome: 'optional_degraded',
        redactionLabels: ['secret']
      }),
      createAgentCapabilityEvidenceSnapshot({
        ...identity,
        kind: 'agent_capability_evidence_snapshot',
        capabilityId: 'memory.fixture',
        evidenceKind: 'tool_invocation',
        status: 'rejected',
        summary: 'tool disallowed',
        policyOutcome: 'disallowed_tool_call',
        redactionLabels: []
      }),
      createAgentCapabilityEvidenceSnapshot({
        ...identity,
        kind: 'agent_capability_evidence_snapshot',
        capabilityId: 'memory.fixture',
        evidenceKind: 'tool_invocation',
        status: 'rejected',
        summary: 'handler rejected',
        policyOutcome: 'handler_rejected',
        redactionLabels: []
      }),
      createAgentCapabilityEvidenceSnapshot({
        ...identity,
        kind: 'agent_capability_evidence_snapshot',
        capabilityId: 'memory.fixture',
        evidenceKind: 'tool_invocation',
        status: 'failed',
        summary: 'timed out',
        policyOutcome: 'timeout',
        redactionLabels: []
      }),
      createAgentCapabilityEvidenceSnapshot({
        ...identity,
        kind: 'agent_capability_evidence_snapshot',
        capabilityId: 'memory.fixture',
        evidenceKind: 'health',
        status: 'degraded',
        summary: 'health degraded',
        policyOutcome: 'health_degraded',
        redactionLabels: []
      }),
      createAgentCapabilityEvidenceSnapshot({
        ...identity,
        kind: 'agent_capability_evidence_snapshot',
        capabilityId: 'memory.fixture',
        evidenceKind: 'after_turn_committed',
        status: 'failed',
        summary: 'after commit failed',
        policyOutcome: 'after_commit_failed',
        redactionLabels: []
      })
    ];
    const turnEvidence = createAgentCapabilityTurnEvidenceSnapshot({
      ...identity,
      kind: 'agent_capability_turn_evidence_snapshot',
      contractVersion: agentCapabilityContractVersion,
      capabilities: [listing],
      contextItems: [
        {
          capabilityId: 'memory.fixture',
          id: 'memory.item_1',
          kind: 'memory',
          text: 'endpoint api_key=secret-token',
          budget: {
            estimatedTokens: 5,
            priority: 1
          },
          sourceReferences: [
            {
              kind: 'memory',
              id: 'mem_1',
              uri: 'https://user:plain-secret@example.test/path?token=secret-token'
            }
          ],
          redactionLabels: ['secret']
        }
      ],
      evidence,
      health: [health]
    });

    expect(turnEvidence.capabilities[0]?.configFingerprint).toBe(
      'gateway_api_key=[redacted]'
    );
    expect(turnEvidence.contextItems[0]?.text).toBe(
      'endpoint api_key=[redacted]'
    );
    expect(turnEvidence.contextItems[0]?.sourceReferences[0]?.uri).toBe(
      'https://[redacted]@example.test/path?token=[redacted]'
    );
    expect(turnEvidence.evidence.map((snapshot) => snapshot.policyOutcome)).toEqual([
      'required_rejected',
      'optional_degraded',
      'disallowed_tool_call',
      'handler_rejected',
      'timeout',
      'health_degraded',
      'after_commit_failed'
    ]);
    expect(turnEvidence.health[0]?.summary).toBe(
      'health token=[redacted] degraded'
    );
    expect(JSON.stringify(turnEvidence)).not.toContain('secret-token');
    expect(Object.isFrozen(turnEvidence)).toBe(true);
    expect(Object.isFrozen(turnEvidence.capabilities)).toBe(true);
  });

  it('rejects non-finite context confidence while building turn evidence snapshots', () => {
    const identity = {
      eventId: 'evt_capability_evidence',
      traceId: 'trace_capability_evidence',
      createdAt: '2026-06-12T00:00:00.000Z'
    };
    const listing = createAgentCapabilityListingSnapshot({
      capabilityId: 'capability.fixture',
      manifest: createBaseManifest(),
      providedTools: [],
      registeredLifecycleHooks: [],
      installed: true,
      registered: true,
      enabled: true,
      availableForTurn: true,
      redactionLabels: []
    });

    expect(() =>
      createAgentCapabilityTurnEvidenceSnapshot({
        ...identity,
        kind: 'agent_capability_turn_evidence_snapshot',
        contractVersion: agentCapabilityContractVersion,
        capabilities: [listing],
        contextItems: [
          {
            capabilityId: 'capability.fixture',
            id: 'memory.item_1',
            kind: 'memory',
            text: 'Recovered memory.',
            budget: {
              estimatedTokens: 5,
              priority: 1
            },
            sourceReferences: [
              {
                kind: 'memory',
                id: 'mem_1'
              }
            ],
            confidence: Number.NaN,
            redactionLabels: ['memory']
          }
        ],
        evidence: [],
        health: []
      })
    ).toThrow(
      'Capability context item confidence must be a finite number between 0 and 1.'
    );
  });
});

type MutableContextItemInput = {
  capabilityId: string;
  id: string;
  kind: string;
  text: string;
  budget: {
    estimatedTokens: number;
    priority: number;
  };
  sourceReferences: {
    kind: string;
    id: string;
    title?: string;
  }[];
  confidence: number;
  redactionLabels: string[];
};

type MutableVisibleMessageInput = {
  id: string;
  role: 'user' | 'character';
  speakerId: string;
  speakerName: string;
  text: string;
};

function readJsonFixture(name: string): unknown {
  const text = readFileSync(
    new URL(`./fixtures/agent-capabilities/${name}`, import.meta.url),
    'utf8'
  );
  const parsed: unknown = JSON.parse(text);

  return parsed;
}

function createFakeMemoryCapability(): ReturnType<typeof createAgentCapability> {
  return createAgentCapability({
    manifest: {
      ...createBaseManifest(),
      id: 'memory.fixture',
      displayName: 'Fake memory provider',
      kind: 'memory_provider',
      description: 'In-process fake memory capability for contract tests.',
      declaredCapabilities: [
        'context_provider',
        'before_role_model_call',
        'tool_provider',
        'handle_tool_call',
        'after_turn_committed',
        'on_session_end',
        'health'
      ],
      runtimePolicy: {
        ...createBaseManifest().runtimePolicy,
        sideEffectLevel: 'local_memory_write',
        sourceReferencesRequired: true,
        failureBehavior: {
          beforeRoleModelCall: 'degrade',
          handleToolCall: 'degrade',
          afterTurnCommitted: 'log_failure',
          health: 'degrade'
        }
      }
    },
    providedTools: [createFakeSearchTool()],
    lifecycleHooks: {
      beforeRoleModelCall() {
        return {
          contextItems: [],
          runtimeNotes: [],
          evidence: []
        };
      },
      afterTurnCommitted() {
        return {
          status: 'completed',
          evidence: []
        };
      },
      onSessionEnd() {
        return {
          status: 'completed',
          evidence: []
        };
      },
      health(context) {
        return {
          capabilityId: 'memory.fixture',
          status: 'ok',
          checkedAt: context.timestamp,
          summary: 'fixture ok',
          redactionLabels: []
        };
      }
    }
  });
}

function createBaseManifest(): AgentCapabilityManifest {
  return {
    id: 'capability.fixture',
    displayName: 'Fixture capability',
    version: '1.0.0',
    kind: 'context_provider',
    description: 'Fixture capability manifest.',
    contractVersion: agentCapabilityContractVersion,
    compatibility: {
      hostContractVersions: [agentCapabilityContractVersion],
      sourceSystem: 'project02'
    },
    declaredCapabilities: ['health'],
    config: {
      fields: []
    },
    localTrustLevel: 'test_fixture',
    runtimePolicy: {
      requiredForTurn: false,
      sideEffectLevel: 'runtime_read',
      confirmation: 'not_required',
      timeoutMs: 1000,
      sourceReferencesRequired: false,
      redactionLabels: [],
      failureBehavior: {
        beforeRoleModelCall: 'degrade',
        handleToolCall: 'degrade',
        afterTurnCommitted: 'log_failure',
        health: 'degrade'
      }
    },
    activation: {
      defaultEnabled: false,
      reasons: ['contract_test']
    }
  };
}

function createFakeSearchTool(): AgentCapabilityProvidedTool {
  return {
    name: 'memory.search',
    description: 'Search fake memory.',
    requiredForUserTurn: false,
    maxCallsPerUserTurn: 1,
    inputContract: {
      type: 'object',
      additionalFields: false,
      fields: [
        {
          name: 'query',
          description: 'Search query.',
          required: true
        },
        {
          name: 'limit',
          description: 'Maximum results.',
          required: false
        }
      ]
    },
    validationOwner: 'capability_host',
    sideEffectLevel: 'runtime_read',
    requiresConfirmation: false,
    sourceReferencesRequired: true
  };
}
