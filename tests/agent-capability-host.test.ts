import { describe, expect, it, vi } from 'vitest';

import {
  agentCapabilityContractVersion,
  createAgentCapability,
  createAgentCapabilityEvidenceSnapshot,
  createFirstPartyModelToolsCapability,
  createRuntimeCapabilityAfterTurnCommittedContext,
  createRuntimeCapabilityContext,
  createRuntimeCapabilityHost,
  firstPartyModelToolsCapabilityId,
  localCharacterProfile,
  runtimeCapabilityBeforeRoleModelCallRejectionReason,
  type AgentCapability,
  type AgentCapabilityContextItem,
  type AgentCapabilityLifecycleHooks,
  type RuntimeCapabilityAfterTurnCommittedContext,
  type RuntimeCapabilityContext
} from '../src/index.ts';

describe('runtime capability host', () => {
  it('registers first-party built-ins and enabled fakes through one static host', () => {
    const firstParty = createFirstPartyModelToolsCapability();
    const fakeMemory = createHostTestCapability({
      id: 'memory.host_fixture',
      displayName: 'Host fixture memory',
      beforeRoleModelCall() {
        return {
          contextItems: [],
          runtimeNotes: [],
          evidence: []
        };
      }
    });
    const host = createRuntimeCapabilityHost({
      capabilities: [firstParty, fakeMemory]
    });

    expect(host.registrySnapshot().capabilities.map((entry) => entry.manifest.id))
      .toEqual([firstPartyModelToolsCapabilityId, 'memory.host_fixture']);
    expect(host.enabledCapabilityIds()).toEqual([
      firstPartyModelToolsCapabilityId,
      'memory.host_fixture'
    ]);
    expect(host.registrySnapshot().contractVersion).toBe(
      agentCapabilityContractVersion
    );
  });

  it('projects only host-validated read-only handled tools to the role-model loop', () => {
    const host = createRuntimeCapabilityHost({
      capabilities: [
        createFirstPartyModelToolsCapability(),
        createHostTestCapability({
          id: 'memory.adapter_owned',
          displayName: 'Adapter-owned tool',
          providedTools: [
            createHostTestTool({
              name: 'memory.adapter_search',
              validationOwner: 'adapter',
              sideEffectLevel: 'external_read'
            })
          ],
          handleToolCall() {
            return {
              status: 'accepted',
              output: {},
              evidence: []
            };
          }
        }),
        createHostTestCapability({
          id: 'memory.write_tool',
          displayName: 'Write tool',
          providedTools: [
            createHostTestTool({
              name: 'memory.capture',
              validationOwner: 'capability_host',
              sideEffectLevel: 'local_memory_write'
            })
          ],
          handleToolCall() {
            return {
              status: 'accepted',
              output: {},
              evidence: []
            };
          }
        }),
        createHostTestCapability({
          id: 'memory.no_handler',
          displayName: 'No handler tool',
          providedTools: [
            createHostTestTool({
              name: 'memory.no_handler_search',
              validationOwner: 'capability_host',
              sideEffectLevel: 'runtime_read'
            })
          ]
        }),
        createHostTestCapability({
          id: 'memory.model_facing',
          displayName: 'Model-facing tool',
          providedTools: [
            createHostTestTool({
              name: 'memory.search',
              validationOwner: 'capability_host',
              sideEffectLevel: 'runtime_read'
            })
          ],
          handleToolCall() {
            return {
              status: 'accepted',
              output: {},
              evidence: []
            };
          }
        })
      ]
    });

    expect(
      host
        .capabilityToolDefinitions()
        .map((definition) => ({
          capabilityId: definition.capabilityId,
          name: definition.name
        }))
    ).toEqual([
      {
        capabilityId: 'memory.model_facing',
        name: 'memory.search'
      }
    ]);
  });

  it('rejects duplicate model-facing tool names across enabled capabilities at host creation', () => {
    expect(() =>
      createRuntimeCapabilityHost({
        capabilities: [
          createSearchToolCapability('memory.first_search', 'First search'),
          createSearchToolCapability('memory.second_search', 'Second search')
        ]
      })
    ).toThrow('Capability tool "memory.search" is declared more than once.');
  });

  it('allows duplicate registered tool names when only one duplicate capability is enabled', () => {
    const host = createRuntimeCapabilityHost({
      capabilities: [
        createSearchToolCapability('memory.enabled_search', 'Enabled search'),
        createSearchToolCapability('memory.disabled_search', 'Disabled search')
      ],
      enabledCapabilityIds: ['memory.enabled_search']
    });

    expect(host.capabilityToolDefinitions().map((definition) => definition.name)).toEqual([
      'memory.search'
    ]);
  });

  it('degrades optional before-model failures with evidence', async () => {
    const host = createRuntimeCapabilityHost({
      capabilities: [
        createHostTestCapability({
          id: 'memory.optional_before',
          displayName: 'Optional before hook',
          beforeRoleModelCall() {
            throw new Error('recall unavailable');
          }
        })
      ]
    });

    const result = await host.beforeRoleModelCall(createHostTestContext());

    expect(result.status).toBe('completed');

    if (result.status !== 'completed') {
      throw new Error('Expected optional failure to degrade.');
    }

    expect(result.evidence).toMatchObject([
      {
        capabilityId: 'memory.optional_before',
        evidenceKind: 'before_role_model_call',
        status: 'degraded',
        policyOutcome: 'optional_degraded'
      }
    ]);
  });

  it('rejects required before-model failures before later hooks run', async () => {
    const calls: string[] = [];
    const host = createRuntimeCapabilityHost({
      capabilities: [
        createHostTestCapability({
          id: 'memory.required_before',
          displayName: 'Required before hook',
          requiredForTurn: true,
          beforeRoleModelCall() {
            calls.push('required');
            throw new Error('required recall unavailable');
          }
        }),
        createHostTestCapability({
          id: 'memory.later_before',
          displayName: 'Later before hook',
          beforeRoleModelCall() {
            calls.push('later');

            return {
              contextItems: [],
              runtimeNotes: [],
              evidence: []
            };
          }
        })
      ]
    });

    const result = await host.beforeRoleModelCall(createHostTestContext());

    expect(result).toMatchObject({
      status: 'rejected',
      reason: runtimeCapabilityBeforeRoleModelCallRejectionReason,
      capabilityId: 'memory.required_before'
    });
    expect(calls).toEqual(['required']);
    expect(result.evidence).toMatchObject([
      {
        capabilityId: 'memory.required_before',
        evidenceKind: 'before_role_model_call',
        status: 'rejected',
        policyOutcome: 'required_rejected'
      }
    ]);
  });

  it('degrades optional before-model context without required source references', async () => {
    const host = createRuntimeCapabilityHost({
      capabilities: [
        createHostTestCapability({
          id: 'memory.optional_refs',
          displayName: 'Optional refs',
          sourceReferencesRequired: true,
          beforeRoleModelCall() {
            return {
              contextItems: [
                createHostTestContextItem({
                  capabilityId: 'memory.optional_refs',
                  sourceReferences: []
                })
              ],
              runtimeNotes: [],
              evidence: []
            };
          }
        })
      ]
    });

    const result = await host.beforeRoleModelCall(createHostTestContext());

    expect(result.status).toBe('completed');

    if (result.status !== 'completed') {
      throw new Error('Expected optional missing source references to degrade.');
    }

    expect(result.contextItems).toEqual([]);
    expect(result.evidence).toMatchObject([
      {
        capabilityId: 'memory.optional_refs',
        status: 'degraded',
        policyOutcome: 'optional_degraded'
      }
    ]);
  });

  it('rejects required before-model context without required source references', async () => {
    const host = createRuntimeCapabilityHost({
      capabilities: [
        createHostTestCapability({
          id: 'memory.required_refs',
          displayName: 'Required refs',
          requiredForTurn: true,
          sourceReferencesRequired: true,
          beforeRoleModelCall() {
            return {
              contextItems: [
                createHostTestContextItem({
                  capabilityId: 'memory.required_refs',
                  sourceReferences: []
                })
              ],
              runtimeNotes: [],
              evidence: []
            };
          }
        })
      ]
    });

    const result = await host.beforeRoleModelCall(createHostTestContext());

    expect(result).toMatchObject({
      status: 'rejected',
      reason: runtimeCapabilityBeforeRoleModelCallRejectionReason,
      capabilityId: 'memory.required_refs'
    });
    expect(result.evidence).toMatchObject([
      {
        capabilityId: 'memory.required_refs',
        status: 'rejected',
        policyOutcome: 'required_rejected'
      }
    ]);
  });

  it('applies timeout policy to before-model hooks', async () => {
    vi.useFakeTimers();

    try {
      const calls: string[] = [];
      const host = createRuntimeCapabilityHost({
        capabilities: [
          createHostTestCapability({
            id: 'memory.timeout_before',
            displayName: 'Timeout before hook',
            timeoutMs: 25,
            beforeRoleModelCall() {
              calls.push('timeout');
              return new Promise<never>(() => undefined);
            }
          }),
          createHostTestCapability({
            id: 'memory.later_after_timeout',
            displayName: 'Later after timeout',
            beforeRoleModelCall() {
              calls.push('later');

              return {
                contextItems: [],
                runtimeNotes: [],
                evidence: []
              };
            }
          })
        ]
      });

      const resultPromise = host.beforeRoleModelCall(createHostTestContext());
      await vi.advanceTimersByTimeAsync(25);
      const result = await resultPromise;

      expect(calls).toEqual(['timeout', 'later']);
      expect(result.status).toBe('completed');

      if (result.status !== 'completed') {
        throw new Error('Expected optional timeout to degrade.');
      }

      expect(result.evidence).toMatchObject([
        {
          capabilityId: 'memory.timeout_before',
          status: 'degraded',
          policyOutcome: 'timeout'
        }
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects required before-model timeout before later hooks run', async () => {
    vi.useFakeTimers();

    try {
      const calls: string[] = [];
      const host = createRuntimeCapabilityHost({
        capabilities: [
          createHostTestCapability({
            id: 'memory.required_timeout',
            displayName: 'Required timeout',
            requiredForTurn: true,
            timeoutMs: 25,
            beforeRoleModelCall() {
              calls.push('required');
              return new Promise<never>(() => undefined);
            }
          }),
          createHostTestCapability({
            id: 'memory.later_required_timeout',
            displayName: 'Later required timeout',
            beforeRoleModelCall() {
              calls.push('later');

              return {
                contextItems: [],
                runtimeNotes: [],
                evidence: []
              };
            }
          })
        ]
      });

      const resultPromise = host.beforeRoleModelCall(createHostTestContext());
      await vi.advanceTimersByTimeAsync(25);
      const result = await resultPromise;

      expect(calls).toEqual(['required']);
      expect(result).toMatchObject({
        status: 'rejected',
        capabilityId: 'memory.required_timeout'
      });
      expect(result.evidence).toMatchObject([
        {
          capabilityId: 'memory.required_timeout',
          status: 'rejected',
          policyOutcome: 'timeout'
        }
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs after-commit, session-end, and health phases without visible conversation writes', async () => {
    const calls: string[] = [];
    const host = createRuntimeCapabilityHost({
      capabilities: [
        createHostTestCapability({
          id: 'memory.lifecycle',
          displayName: 'Lifecycle fixture',
          afterTurnCommitted(context) {
            calls.push('after');
            expect(context.committedTurn.visibleMessages.map((message) => message.text))
              .toEqual(['hello', 'hi']);

            return {
              status: 'failed',
              evidence: []
            };
          },
          onSessionEnd() {
            calls.push('session_end');

            return {
              status: 'completed',
              evidence: []
            };
          },
          health(context) {
            calls.push('health');

            return {
              capabilityId: 'memory.lifecycle',
              status: 'ok',
              checkedAt: context.timestamp,
              summary: 'healthy',
              redactionLabels: []
            };
          }
        })
      ]
    });
    const context = createHostTestContext();

    const afterResult = await host.afterTurnCommitted(createHostTestAfterContext());
    const sessionEndResult = await host.onSessionEnd(context);
    const healthResult = await host.health(context);

    expect(calls).toEqual(['after', 'session_end', 'health']);
    expect(afterResult).toMatchObject({
      status: 'completed_with_failures',
      evidence: [
        {
          capabilityId: 'memory.lifecycle',
          evidenceKind: 'after_turn_committed',
          status: 'failed',
          policyOutcome: 'after_commit_failed'
        }
      ]
    });
    expect(sessionEndResult).toEqual({
      status: 'completed',
      evidence: []
    });
    expect(healthResult.snapshots).toEqual([
      {
        capabilityId: 'memory.lifecycle',
        status: 'ok',
        checkedAt: '2026-06-12T00:00:00.000Z',
        summary: 'healthy',
        redactionLabels: []
      }
    ]);
  });

  it('applies timeout policy to tool, after-commit, session-end, and health hooks', async () => {
    vi.useFakeTimers();

    try {
      const host = createRuntimeCapabilityHost({
        capabilities: [
          createHostTestCapability({
            id: 'memory.timeout_lifecycle',
            displayName: 'Timeout lifecycle',
            timeoutMs: 25,
            providedTools: [
              createHostTestTool({
                name: 'memory.timeout_search',
                validationOwner: 'capability_host',
                sideEffectLevel: 'runtime_read'
              })
            ],
            handleToolCall() {
              return new Promise<never>(() => undefined);
            },
            afterTurnCommitted() {
              return new Promise<never>(() => undefined);
            },
            onSessionEnd() {
              return new Promise<never>(() => undefined);
            },
            health() {
              return new Promise<never>(() => undefined);
            }
          })
        ]
      });

      const toolPromise = host.handleToolCall(
        {
          eventId: 'evt_host',
          traceId: 'trace_host',
          createdAt: '2026-06-12T00:00:00.000Z',
          capabilityId: 'memory.timeout_lifecycle',
          toolName: 'memory.timeout_search',
          input: {}
        },
        createHostTestContext()
      );
      await vi.advanceTimersByTimeAsync(25);
      const toolResult = await toolPromise;

      const afterPromise = host.afterTurnCommitted(createHostTestAfterContext());
      await vi.advanceTimersByTimeAsync(25);
      const afterResult = await afterPromise;

      const sessionPromise = host.onSessionEnd(createHostTestContext());
      await vi.advanceTimersByTimeAsync(25);
      const sessionResult = await sessionPromise;

      const healthPromise = host.health(createHostTestContext());
      await vi.advanceTimersByTimeAsync(25);
      const healthResult = await healthPromise;

      expect(toolResult).toMatchObject({
        status: 'rejected',
        reason: 'handler_timeout',
        evidence: [
          {
            evidenceKind: 'tool_invocation',
            status: 'failed',
            policyOutcome: 'timeout'
          }
        ]
      });
      expect(afterResult).toMatchObject({
        status: 'completed_with_failures',
        evidence: [
          {
            evidenceKind: 'after_turn_committed',
            status: 'failed',
            policyOutcome: 'timeout'
          }
        ]
      });
      expect(sessionResult).toMatchObject({
        status: 'completed_with_failures',
        evidence: [
          {
            evidenceKind: 'session_end',
            status: 'failed',
            policyOutcome: 'timeout'
          }
        ]
      });
      expect(healthResult.snapshots).toMatchObject([
        {
          capabilityId: 'memory.timeout_lifecycle',
          status: 'unavailable'
        }
      ]);
      expect(healthResult.evidence).toMatchObject([
        {
          evidenceKind: 'health',
          status: 'degraded',
          policyOutcome: 'timeout'
        }
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('normalizes successful hook evidence and rejects mismatched capability ids', async () => {
    const host = createRuntimeCapabilityHost({
      capabilities: [
        createHostTestCapability({
          id: 'memory.good_evidence',
          displayName: 'Good evidence fixture',
          beforeRoleModelCall(context) {
            return {
              contextItems: [],
              runtimeNotes: ['memory recall completed'],
              evidence: [
                createAgentCapabilityEvidenceSnapshot({
                  eventId: context.eventId,
                  traceId: context.traceId,
                  createdAt: context.timestamp,
                  kind: 'agent_capability_evidence_snapshot',
                  capabilityId: 'memory.good_evidence',
                  evidenceKind: 'before_role_model_call',
                  status: 'accepted',
                  summary: 'memory recall completed',
                  policyOutcome: 'available_for_turn',
                  redactionLabels: []
                })
              ]
            };
          }
        }),
        createHostTestCapability({
          id: 'memory.bad_evidence',
          displayName: 'Bad evidence fixture',
          beforeRoleModelCall(context) {
            return {
              contextItems: [],
              runtimeNotes: [],
              evidence: [
                createAgentCapabilityEvidenceSnapshot({
                  eventId: context.eventId,
                  traceId: context.traceId,
                  createdAt: context.timestamp,
                  kind: 'agent_capability_evidence_snapshot',
                  capabilityId: 'memory.someone_else',
                  evidenceKind: 'before_role_model_call',
                  status: 'accepted',
                  summary: 'bad evidence',
                  policyOutcome: 'available_for_turn',
                  redactionLabels: []
                })
              ]
            };
          }
        })
      ]
    });

    const result = await host.beforeRoleModelCall(createHostTestContext());

    expect(result.status).toBe('completed');

    if (result.status !== 'completed') {
      throw new Error('Expected mismatched optional evidence to degrade.');
    }

    expect(result.runtimeNotes).toEqual(['memory recall completed']);
    expect(result.evidence).toMatchObject([
      {
        capabilityId: 'memory.good_evidence',
        status: 'accepted'
      },
      {
        capabilityId: 'memory.bad_evidence',
        status: 'degraded',
        policyOutcome: 'optional_degraded'
      }
    ]);
  });
});

function createSearchToolCapability(id: string, displayName: string): AgentCapability {
  return createHostTestCapability({
    id,
    displayName,
    providedTools: [
      createHostTestTool({
        name: 'memory.search',
        validationOwner: 'capability_host',
        sideEffectLevel: 'runtime_read'
      })
    ],
    handleToolCall() {
      return {
        status: 'accepted',
        output: {},
        evidence: []
      };
    }
  });
}

function createHostTestContext(): RuntimeCapabilityContext {
  return createRuntimeCapabilityContext({
    eventId: 'evt_host',
    traceId: 'trace_host',
    createdAt: '2026-06-12T00:00:00.000Z',
    sessionId: 'session-host',
    eventType: 'USER_MESSAGE',
    currentUserMessage: 'hello',
    character: localCharacterProfile
  });
}

function createHostTestAfterContext(): RuntimeCapabilityAfterTurnCommittedContext {
  return createRuntimeCapabilityAfterTurnCommittedContext({
    eventId: 'evt_host',
    traceId: 'trace_host',
    createdAt: '2026-06-12T00:00:00.000Z',
    sessionId: 'session-host',
    eventType: 'USER_MESSAGE',
    currentUserMessage: 'hello',
    character: localCharacterProfile,
    committedAt: '2026-06-12T00:00:00.000Z',
    visibleMessages: [
      {
        id: 'evt_host-user',
        role: 'user',
        speakerId: 'local-user',
        speakerName: 'You',
        text: 'hello'
      },
      {
        id: 'evt_host-character',
        role: 'character',
        speakerId: 'mira',
        speakerName: 'Mira',
        text: 'hi'
      }
    ]
  });
}

function createHostTestCapability(options: {
  readonly id: string;
  readonly displayName: string;
  readonly requiredForTurn?: boolean;
  readonly sourceReferencesRequired?: boolean;
  readonly timeoutMs?: number;
  readonly providedTools?: readonly unknown[];
  readonly beforeRoleModelCall?: AgentCapabilityLifecycleHooks['beforeRoleModelCall'];
  readonly handleToolCall?: AgentCapabilityLifecycleHooks['handleToolCall'];
  readonly afterTurnCommitted?: AgentCapabilityLifecycleHooks['afterTurnCommitted'];
  readonly onSessionEnd?: AgentCapabilityLifecycleHooks['onSessionEnd'];
  readonly health?: AgentCapabilityLifecycleHooks['health'];
}): AgentCapability {
  return createAgentCapability({
    manifest: {
      id: options.id,
      displayName: options.displayName,
      version: '1.0.0',
      kind: 'memory_provider',
      description: 'Runtime host test capability.',
      contractVersion: agentCapabilityContractVersion,
      compatibility: {
        hostContractVersions: [agentCapabilityContractVersion],
        sourceSystem: 'project02'
      },
      declaredCapabilities: declarationsForLifecycleHooks(options),
      config: {
        fields: []
      },
      localTrustLevel: 'test_fixture',
      runtimePolicy: {
        requiredForTurn: options.requiredForTurn ?? false,
        sideEffectLevel: 'local_memory_write',
        confirmation: 'not_required',
        timeoutMs: options.timeoutMs ?? 1000,
        sourceReferencesRequired: options.sourceReferencesRequired ?? false,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall:
            options.requiredForTurn === true ? 'reject_turn' : 'degrade',
          handleToolCall: 'degrade',
          afterTurnCommitted: 'log_failure',
          health: 'degrade'
        }
      },
      activation: {
        defaultEnabled: true,
        reasons: ['host_test']
      }
    },
    providedTools: options.providedTools ?? [],
    lifecycleHooks: {
      ...(options.beforeRoleModelCall === undefined
        ? {}
        : { beforeRoleModelCall: options.beforeRoleModelCall }),
      ...(options.handleToolCall === undefined
        ? {}
        : { handleToolCall: options.handleToolCall }),
      ...(options.afterTurnCommitted === undefined
        ? {}
        : { afterTurnCommitted: options.afterTurnCommitted }),
      ...(options.onSessionEnd === undefined
        ? {}
        : { onSessionEnd: options.onSessionEnd }),
      ...(options.health === undefined ? {} : { health: options.health })
    }
  });
}

function declarationsForLifecycleHooks(options: {
  readonly providedTools?: readonly unknown[];
  readonly beforeRoleModelCall?: AgentCapabilityLifecycleHooks['beforeRoleModelCall'];
  readonly handleToolCall?: AgentCapabilityLifecycleHooks['handleToolCall'];
  readonly afterTurnCommitted?: AgentCapabilityLifecycleHooks['afterTurnCommitted'];
  readonly onSessionEnd?: AgentCapabilityLifecycleHooks['onSessionEnd'];
  readonly health?: AgentCapabilityLifecycleHooks['health'];
}): readonly string[] {
  const declarations: string[] = [];

  if ((options.providedTools ?? []).length > 0) {
    declarations.push('tool_provider', 'handle_tool_call');
  }

  if (options.beforeRoleModelCall !== undefined) {
    declarations.push('context_provider', 'before_role_model_call');
  }

  if (options.afterTurnCommitted !== undefined) {
    declarations.push('after_turn_committed');
  }

  if (options.onSessionEnd !== undefined) {
    declarations.push('on_session_end');
  }

  if (options.health !== undefined) {
    declarations.push('health');
  }

  return Object.freeze(declarations);
}

function createHostTestTool(options: {
  readonly name: string;
  readonly validationOwner: 'adapter' | 'built_in_model_tools' | 'capability_host';
  readonly sideEffectLevel:
    | 'none'
    | 'runtime_read'
    | 'external_read'
    | 'local_memory_write';
}): unknown {
  return Object.freeze({
    name: options.name,
    description: 'Host test tool.',
    requiredForUserTurn: false,
    maxCallsPerUserTurn: 1,
    inputContract: {
      type: 'object',
      additionalFields: false,
      fields: []
    },
    validationOwner: options.validationOwner,
    sideEffectLevel: options.sideEffectLevel,
    requiresConfirmation: false,
    sourceReferencesRequired: false
  });
}

function createHostTestContextItem(options: {
  readonly capabilityId: string;
  readonly sourceReferences?: AgentCapabilityContextItem['sourceReferences'];
}): AgentCapabilityContextItem {
  return {
    capabilityId: options.capabilityId,
    id: `${options.capabilityId}.item_1`,
    kind: 'memory',
    text: 'Remembered context.',
    budget: {
      estimatedTokens: 3,
      priority: 1
    },
    sourceReferences: options.sourceReferences ?? [
      {
        kind: 'memory',
        id: 'mem_1'
      }
    ],
    redactionLabels: []
  };
}
