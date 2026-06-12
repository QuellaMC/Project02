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
  roleModelCapabilityListToolName,
  runtimeCapabilityBeforeRoleModelCallRejectionReason,
  runtimeCapabilityDiscoveryCapabilityId,
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
      .toEqual([
        runtimeCapabilityDiscoveryCapabilityId,
        firstPartyModelToolsCapabilityId,
        'memory.host_fixture'
      ]);
    expect(host.enabledCapabilityIds()).toEqual([
      runtimeCapabilityDiscoveryCapabilityId,
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
        capabilityId: runtimeCapabilityDiscoveryCapabilityId,
        name: roleModelCapabilityListToolName
      },
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
      roleModelCapabilityListToolName,
      'memory.search'
    ]);
  });

  it('routes capability.list through bounded current-turn safe summaries', async () => {
    const host = createRuntimeCapabilityHost({
      capabilities: [
        createSearchToolCapability('memory.enabled_search', 'Enabled memory'),
        createHostTestCapability({
          id: 'memory.disabled_secret',
          displayName: 'Disabled memory /Users/mike secret-token',
          providedTools: [
            createHostTestTool({
              name: 'memory.disabled_search',
              validationOwner: 'capability_host',
              sideEffectLevel: 'runtime_read'
            })
          ],
          handleToolCall() {
            return {
              status: 'accepted',
              output: {
                results: []
              },
              evidence: []
            };
          }
        })
      ],
      enabledCapabilityIds: ['memory.enabled_search']
    });
    const context = createHostTestContext();
    const result = await host.handleToolCall(
      {
        eventId: context.eventId,
        traceId: context.traceId,
        createdAt: context.timestamp,
        capabilityId: runtimeCapabilityDiscoveryCapabilityId,
        toolName: roleModelCapabilityListToolName,
        input: {}
      },
      context
    );

    expect(result.status).toBe('accepted');

    if (result.status !== 'accepted') {
      throw new Error('Expected accepted capability discovery result.');
    }

    expect(result.output).toMatchObject({
      capabilities: [
        {
          id: runtimeCapabilityDiscoveryCapabilityId,
          displayName: 'Runtime capability discovery',
          kind: 'first_party',
          availableForTurn: true,
          providedTools: [
            {
              name: roleModelCapabilityListToolName,
              sideEffectLevel: 'runtime_read',
              requiredForUserTurn: false,
              maxCallsPerUserTurn: 1
            }
          ],
          toolsTruncated: false
        },
        {
          id: 'memory.enabled_search',
          displayName: 'Enabled memory',
          kind: 'memory_provider',
          availableForTurn: true,
          providedTools: [
            {
              name: 'memory.search',
              sideEffectLevel: 'runtime_read',
              requiredForUserTurn: false,
              maxCallsPerUserTurn: 1
            }
          ],
          toolsTruncated: false
        }
      ],
      truncated: false
    });
    expect(result.evidence).toMatchObject([
      {
        capabilityId: runtimeCapabilityDiscoveryCapabilityId,
        evidenceKind: 'tool_invocation',
        status: 'accepted'
      }
    ]);

    const serializedOutput = JSON.stringify(result.output);

    expect(serializedOutput).not.toContain('memory.disabled_secret');
    expect(serializedOutput).not.toContain('secret-token');
    expect(serializedOutput).not.toContain('/Users/mike');
    expect(serializedOutput).not.toContain('configFingerprint');
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

  it('bounds before-model context by estimated tokens and priority', async () => {
    const host = createRuntimeCapabilityHost({
      capabilities: [
        createHostTestCapability({
          id: 'memory.low_priority_context',
          displayName: 'Low priority context',
          beforeRoleModelCall() {
            return {
              contextItems: [
                createHostTestContextItem({
                  capabilityId: 'memory.low_priority_context',
                  id: 'memory.low_priority_context.large',
                  estimatedTokens: 220,
                  priority: 2
                })
              ],
              runtimeNotes: [],
              evidence: []
            };
          }
        }),
        createHostTestCapability({
          id: 'memory.high_priority_context',
          displayName: 'High priority context',
          beforeRoleModelCall() {
            return {
              contextItems: [
                createHostTestContextItem({
                  capabilityId: 'memory.high_priority_context',
                  id: 'memory.high_priority_context.urgent',
                  estimatedTokens: 60,
                  priority: 1
                }),
                createHostTestContextItem({
                  capabilityId: 'memory.high_priority_context',
                  id: 'memory.high_priority_context.compact',
                  estimatedTokens: 20,
                  priority: 3
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
      throw new Error('Expected budgeted context to complete.');
    }

    expect(result.contextItems.map((contextItem) => contextItem.id)).toEqual([
      'memory.high_priority_context.urgent',
      'memory.high_priority_context.compact'
    ]);
    expect(
      result.contextItems.reduce(
        (total, contextItem) => total + contextItem.budget.estimatedTokens,
        0
      )
    ).toBe(80);
    expect(result.evidence).toMatchObject([
      {
        capabilityId: 'memory.low_priority_context',
        evidenceKind: 'before_role_model_call',
        status: 'degraded',
        policyOutcome: 'optional_degraded'
      }
    ]);
    expect(result.evidence[0]?.summary).toContain(
      'memory.low_priority_context.large'
    );
    expect(result.evidence[0]?.summary).toContain('kept 80/256 estimated tokens');
    expect(result.evidence[0]?.summary).toContain(
      'dropped 1 item(s) from 300 estimated tokens'
    );
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

  it('persists failed hook results when supplied evidence is not failed', async () => {
    const host = createRuntimeCapabilityHost({
      capabilities: [
        createHostTestCapability({
          id: 'memory.failed_after_with_note',
          displayName: 'Failed after hook with note evidence',
          afterTurnCommitted(context) {
            return {
              status: 'failed',
              evidence: [
                createAcceptedHostEvidence({
                  context,
                  capabilityId: 'memory.failed_after_with_note',
                  evidenceKind: 'after_turn_committed'
                })
              ]
            };
          }
        })
      ]
    });

    const result = await host.afterTurnCommitted(createHostTestAfterContext());

    expect(result).toMatchObject({
      status: 'completed_with_failures',
      evidence: [
        {
          capabilityId: 'memory.failed_after_with_note',
          evidenceKind: 'after_turn_committed',
          status: 'accepted'
        },
        {
          capabilityId: 'memory.failed_after_with_note',
          evidenceKind: 'after_turn_committed',
          status: 'failed',
          policyOutcome: 'after_commit_failed'
        }
      ]
    });
  });

  it('does not duplicate failed hook evidence when supplied evidence records failure', async () => {
    const host = createRuntimeCapabilityHost({
      capabilities: [
        createHostTestCapability({
          id: 'memory.failed_session_with_evidence',
          displayName: 'Failed session hook with failed evidence',
          onSessionEnd(context) {
            return {
              status: 'failed',
              evidence: [
                createAgentCapabilityEvidenceSnapshot({
                  eventId: context.eventId,
                  traceId: context.traceId,
                  createdAt: context.timestamp,
                  kind: 'agent_capability_evidence_snapshot',
                  capabilityId: 'memory.failed_session_with_evidence',
                  evidenceKind: 'session_end',
                  status: 'failed',
                  summary: 'session cleanup failed',
                  redactionLabels: []
                })
              ]
            };
          }
        })
      ]
    });

    const result = await host.onSessionEnd(createHostTestContext());

    expect(result.status).toBe('completed_with_failures');
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence).toMatchObject([
      {
        capabilityId: 'memory.failed_session_with_evidence',
        evidenceKind: 'session_end',
        status: 'failed',
        summary: 'session cleanup failed'
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
            status: 'degraded',
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

  it('degrades optional hook evidence when runtime identity is stale', async () => {
    const host = createRuntimeCapabilityHost({
      capabilities: [
        createHostTestCapability({
          id: 'memory.stale_event_evidence',
          displayName: 'Stale event evidence fixture',
          beforeRoleModelCall(context) {
            return {
              contextItems: [],
              runtimeNotes: ['stale event note'],
              evidence: [
                createAcceptedHostEvidence({
                  context,
                  capabilityId: 'memory.stale_event_evidence',
                  evidenceKind: 'before_role_model_call',
                  eventId: 'evt_previous'
                })
              ]
            };
          }
        }),
        createHostTestCapability({
          id: 'memory.stale_trace_evidence',
          displayName: 'Stale trace evidence fixture',
          beforeRoleModelCall(context) {
            return {
              contextItems: [],
              runtimeNotes: ['stale trace note'],
              evidence: [
                createAcceptedHostEvidence({
                  context,
                  capabilityId: 'memory.stale_trace_evidence',
                  evidenceKind: 'before_role_model_call',
                  traceId: 'trace_previous'
                })
              ]
            };
          }
        }),
        createHostTestCapability({
          id: 'memory.stale_created_at_evidence',
          displayName: 'Stale createdAt evidence fixture',
          beforeRoleModelCall(context) {
            return {
              contextItems: [],
              runtimeNotes: ['stale createdAt note'],
              evidence: [
                createAcceptedHostEvidence({
                  context,
                  capabilityId: 'memory.stale_created_at_evidence',
                  evidenceKind: 'before_role_model_call',
                  createdAt: '2026-06-11T00:00:00.000Z'
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
      throw new Error('Expected stale optional evidence identity to degrade.');
    }

    expect(result.runtimeNotes).toEqual([]);
    expect(result.evidence).toMatchObject([
      {
        capabilityId: 'memory.stale_event_evidence',
        status: 'degraded',
        policyOutcome: 'optional_degraded'
      },
      {
        capabilityId: 'memory.stale_trace_evidence',
        status: 'degraded',
        policyOutcome: 'optional_degraded'
      },
      {
        capabilityId: 'memory.stale_created_at_evidence',
        status: 'degraded',
        policyOutcome: 'optional_degraded'
      }
    ]);
  });

  it('preserves rejecting evidence for required and non-degrading tool handler failures', async () => {
    const host = createRuntimeCapabilityHost({
      capabilities: [
        createHostTestCapability({
          id: 'memory.rejecting_tool',
          displayName: 'Rejecting tool fixture',
          handleToolCallFailureBehavior: 'reject_tool_call',
          providedTools: [
            createHostTestTool({
              name: 'memory.rejecting_search',
              validationOwner: 'capability_host',
              sideEffectLevel: 'runtime_read'
            })
          ],
          handleToolCall() {
            throw new Error('search unavailable');
          }
        }),
        createHostTestCapability({
          id: 'memory.required_tool',
          displayName: 'Required tool fixture',
          providedTools: [
            createHostTestTool({
              name: 'memory.required_search',
              validationOwner: 'capability_host',
              sideEffectLevel: 'runtime_read',
              requiredForUserTurn: true
            })
          ],
          handleToolCall() {
            throw new Error('required search unavailable');
          }
        })
      ]
    });
    const context = createHostTestContext();

    const rejectingResult = await host.handleToolCall(
      {
        eventId: 'evt_host',
        traceId: 'trace_host',
        createdAt: '2026-06-12T00:00:00.000Z',
        capabilityId: 'memory.rejecting_tool',
        toolName: 'memory.rejecting_search',
        input: {}
      },
      context
    );
    const requiredResult = await host.handleToolCall(
      {
        eventId: 'evt_host',
        traceId: 'trace_host',
        createdAt: '2026-06-12T00:00:00.000Z',
        capabilityId: 'memory.required_tool',
        toolName: 'memory.required_search',
        input: {}
      },
      context
    );

    expect(rejectingResult).toMatchObject({
      status: 'rejected',
      reason: 'handler_failed',
      evidence: [
        {
          evidenceKind: 'tool_invocation',
          status: 'rejected',
          policyOutcome: 'handler_rejected'
        }
      ]
    });
    expect(requiredResult).toMatchObject({
      status: 'rejected',
      reason: 'handler_failed',
      evidence: [
        {
          evidenceKind: 'tool_invocation',
          status: 'rejected',
          policyOutcome: 'handler_rejected'
        }
      ]
    });
  });

  it('degrades or rejects accepted tool results with stale evidence identity', async () => {
    const host = createRuntimeCapabilityHost({
      capabilities: [
        createHostTestCapability({
          id: 'memory.optional_stale_tool_evidence',
          displayName: 'Optional stale tool evidence fixture',
          providedTools: [
            createHostTestTool({
              name: 'memory.optional_stale_search',
              validationOwner: 'capability_host',
              sideEffectLevel: 'runtime_read'
            })
          ],
          handleToolCall(_call, context) {
            return {
              status: 'accepted',
              output: {},
              evidence: [
                createAcceptedHostEvidence({
                  context,
                  capabilityId: 'memory.optional_stale_tool_evidence',
                  evidenceKind: 'tool_invocation',
                  createdAt: '2026-06-11T00:00:00.000Z'
                })
              ]
            };
          }
        }),
        createHostTestCapability({
          id: 'memory.required_stale_tool_evidence',
          displayName: 'Required stale tool evidence fixture',
          requiredForTurn: true,
          providedTools: [
            createHostTestTool({
              name: 'memory.required_stale_search',
              validationOwner: 'capability_host',
              sideEffectLevel: 'runtime_read'
            })
          ],
          handleToolCall(_call, context) {
            return {
              status: 'accepted',
              output: {},
              evidence: [
                createAcceptedHostEvidence({
                  context,
                  capabilityId: 'memory.required_stale_tool_evidence',
                  evidenceKind: 'tool_invocation',
                  traceId: 'trace_previous'
                })
              ]
            };
          }
        })
      ]
    });
    const context = createHostTestContext();

    const optionalResult = await host.handleToolCall(
      {
        eventId: 'evt_host',
        traceId: 'trace_host',
        createdAt: '2026-06-12T00:00:00.000Z',
        capabilityId: 'memory.optional_stale_tool_evidence',
        toolName: 'memory.optional_stale_search',
        input: {}
      },
      context
    );
    const requiredResult = await host.handleToolCall(
      {
        eventId: 'evt_host',
        traceId: 'trace_host',
        createdAt: '2026-06-12T00:00:00.000Z',
        capabilityId: 'memory.required_stale_tool_evidence',
        toolName: 'memory.required_stale_search',
        input: {}
      },
      context
    );

    expect(optionalResult).toMatchObject({
      status: 'rejected',
      reason: 'handler_failed',
      evidence: [
        {
          capabilityId: 'memory.optional_stale_tool_evidence',
          evidenceKind: 'tool_invocation',
          status: 'degraded',
          policyOutcome: 'optional_degraded'
        }
      ]
    });
    expect(requiredResult).toMatchObject({
      status: 'rejected',
      reason: 'handler_failed',
      evidence: [
        {
          capabilityId: 'memory.required_stale_tool_evidence',
          evidenceKind: 'tool_invocation',
          status: 'rejected',
          policyOutcome: 'handler_rejected'
        }
      ]
    });
  });

  it('accepts grounded tool results when source references are required', async () => {
    const host = createRuntimeCapabilityHost({
      capabilities: [
        createHostTestCapability({
          id: 'memory.grounded_tool',
          displayName: 'Grounded tool fixture',
          providedTools: [
            createHostTestTool({
              name: 'memory.grounded_search',
              validationOwner: 'capability_host',
              sideEffectLevel: 'runtime_read',
              sourceReferencesRequired: true
            })
          ],
          handleToolCall(_call, context) {
            return {
              status: 'accepted',
              output: {
                answer: 'remembered detail'
              },
              evidence: [
                createAgentCapabilityEvidenceSnapshot({
                  eventId: context.eventId,
                  traceId: context.traceId,
                  createdAt: context.timestamp,
                  kind: 'agent_capability_evidence_snapshot',
                  capabilityId: 'memory.grounded_tool',
                  evidenceKind: 'tool_invocation',
                  status: 'accepted',
                  summary: 'memory search returned grounded evidence',
                  policyOutcome: 'available_for_turn',
                  sourceReferences: [
                    {
                      kind: 'memory',
                      id: 'mem_1',
                      title: 'Memory 1'
                    }
                  ],
                  redactionLabels: []
                })
              ]
            };
          }
        })
      ]
    });

    const result = await host.handleToolCall(
      {
        eventId: 'evt_host',
        traceId: 'trace_host',
        createdAt: '2026-06-12T00:00:00.000Z',
        capabilityId: 'memory.grounded_tool',
        toolName: 'memory.grounded_search',
        input: {}
      },
      createHostTestContext()
    );

    expect(result).toMatchObject({
      status: 'accepted',
      evidence: [
        {
          capabilityId: 'memory.grounded_tool',
          evidenceKind: 'tool_invocation',
          status: 'accepted',
          sourceReferences: [
            {
              kind: 'memory',
              id: 'mem_1'
            }
          ]
        }
      ]
    });
  });

  it('degrades optional accepted tool results missing required source references', async () => {
    const host = createRuntimeCapabilityHost({
      capabilities: [
        createHostTestCapability({
          id: 'memory.optional_tool_refs',
          displayName: 'Optional tool refs fixture',
          providedTools: [
            createHostTestTool({
              name: 'memory.optional_ref_search',
              validationOwner: 'capability_host',
              sideEffectLevel: 'runtime_read',
              sourceReferencesRequired: true
            })
          ],
          handleToolCall() {
            return {
              status: 'accepted',
              output: {
                answer: 'ungrounded detail'
              },
              evidence: []
            };
          }
        })
      ]
    });

    const result = await host.handleToolCall(
      {
        eventId: 'evt_host',
        traceId: 'trace_host',
        createdAt: '2026-06-12T00:00:00.000Z',
        capabilityId: 'memory.optional_tool_refs',
        toolName: 'memory.optional_ref_search',
        input: {}
      },
      createHostTestContext()
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'handler_failed',
      evidence: [
        {
          evidenceKind: 'tool_invocation',
          status: 'degraded',
          policyOutcome: 'optional_degraded'
        }
      ]
    });
  });

  it('degrades optional accepted tool results containing non-finite output', async () => {
    const host = createRuntimeCapabilityHost({
      capabilities: [
        createHostTestCapability({
          id: 'memory.optional_non_finite_tool',
          displayName: 'Optional non-finite tool fixture',
          providedTools: [
            createHostTestTool({
              name: 'memory.optional_non_finite_search',
              validationOwner: 'capability_host',
              sideEffectLevel: 'runtime_read'
            })
          ],
          handleToolCall() {
            return {
              status: 'accepted',
              output: {
                answerScore: Infinity
              },
              evidence: []
            };
          }
        })
      ]
    });

    const result = await host.handleToolCall(
      {
        eventId: 'evt_host',
        traceId: 'trace_host',
        createdAt: '2026-06-12T00:00:00.000Z',
        capabilityId: 'memory.optional_non_finite_tool',
        toolName: 'memory.optional_non_finite_search',
        input: {}
      },
      createHostTestContext()
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'handler_failed',
      message: 'Capability tool output must be finite JSON.',
      evidence: [
        {
          evidenceKind: 'tool_invocation',
          status: 'degraded',
          policyOutcome: 'optional_degraded'
        }
      ]
    });
  });

  it('rejects required and non-degrading accepted tool results containing non-finite output', async () => {
    const host = createRuntimeCapabilityHost({
      capabilities: [
        createHostTestCapability({
          id: 'memory.required_non_finite_tool',
          displayName: 'Required non-finite tool fixture',
          requiredForTurn: true,
          providedTools: [
            createHostTestTool({
              name: 'memory.required_non_finite_search',
              validationOwner: 'capability_host',
              sideEffectLevel: 'runtime_read'
            })
          ],
          handleToolCall() {
            return {
              status: 'accepted',
              output: {
                scores: [Number.NaN]
              },
              evidence: []
            };
          }
        }),
        createHostTestCapability({
          id: 'memory.rejecting_non_finite_tool',
          displayName: 'Rejecting non-finite tool fixture',
          handleToolCallFailureBehavior: 'reject_tool_call',
          providedTools: [
            createHostTestTool({
              name: 'memory.rejecting_non_finite_search',
              validationOwner: 'capability_host',
              sideEffectLevel: 'runtime_read'
            })
          ],
          handleToolCall() {
            return {
              status: 'accepted',
              output: {
                confidence: Number.NaN
              },
              evidence: []
            };
          }
        })
      ]
    });
    const context = createHostTestContext();

    const requiredResult = await host.handleToolCall(
      {
        eventId: 'evt_host',
        traceId: 'trace_host',
        createdAt: '2026-06-12T00:00:00.000Z',
        capabilityId: 'memory.required_non_finite_tool',
        toolName: 'memory.required_non_finite_search',
        input: {}
      },
      context
    );
    const rejectingResult = await host.handleToolCall(
      {
        eventId: 'evt_host',
        traceId: 'trace_host',
        createdAt: '2026-06-12T00:00:00.000Z',
        capabilityId: 'memory.rejecting_non_finite_tool',
        toolName: 'memory.rejecting_non_finite_search',
        input: {}
      },
      context
    );

    expect(requiredResult).toMatchObject({
      status: 'rejected',
      reason: 'handler_failed',
      message: 'Capability tool output must be finite JSON.',
      evidence: [
        {
          evidenceKind: 'tool_invocation',
          status: 'rejected',
          policyOutcome: 'handler_rejected'
        }
      ]
    });
    expect(rejectingResult).toMatchObject({
      status: 'rejected',
      reason: 'handler_failed',
      message: 'Capability tool output must be finite JSON.',
      evidence: [
        {
          evidenceKind: 'tool_invocation',
          status: 'rejected',
          policyOutcome: 'handler_rejected'
        }
      ]
    });
  });

  it('rejects required and non-degrading accepted tool results missing source references', async () => {
    const host = createRuntimeCapabilityHost({
      capabilities: [
        createHostTestCapability({
          id: 'memory.required_tool_refs',
          displayName: 'Required tool refs fixture',
          requiredForTurn: true,
          providedTools: [
            createHostTestTool({
              name: 'memory.required_ref_search',
              validationOwner: 'capability_host',
              sideEffectLevel: 'runtime_read',
              sourceReferencesRequired: true
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
          id: 'memory.rejecting_tool_refs',
          displayName: 'Rejecting tool refs fixture',
          handleToolCallFailureBehavior: 'reject_tool_call',
          providedTools: [
            createHostTestTool({
              name: 'memory.rejecting_ref_search',
              validationOwner: 'capability_host',
              sideEffectLevel: 'runtime_read',
              sourceReferencesRequired: true
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
    const context = createHostTestContext();

    const requiredResult = await host.handleToolCall(
      {
        eventId: 'evt_host',
        traceId: 'trace_host',
        createdAt: '2026-06-12T00:00:00.000Z',
        capabilityId: 'memory.required_tool_refs',
        toolName: 'memory.required_ref_search',
        input: {}
      },
      context
    );
    const rejectingResult = await host.handleToolCall(
      {
        eventId: 'evt_host',
        traceId: 'trace_host',
        createdAt: '2026-06-12T00:00:00.000Z',
        capabilityId: 'memory.rejecting_tool_refs',
        toolName: 'memory.rejecting_ref_search',
        input: {}
      },
      context
    );

    expect(requiredResult).toMatchObject({
      status: 'rejected',
      reason: 'handler_failed',
      evidence: [
        {
          evidenceKind: 'tool_invocation',
          status: 'rejected',
          policyOutcome: 'handler_rejected'
        }
      ]
    });
    expect(rejectingResult).toMatchObject({
      status: 'rejected',
      reason: 'handler_failed',
      evidence: [
        {
          evidenceKind: 'tool_invocation',
          status: 'rejected',
          policyOutcome: 'handler_rejected'
        }
      ]
    });
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
  readonly handleToolCallFailureBehavior?: 'degrade' | 'reject_tool_call';
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
          handleToolCall: options.handleToolCallFailureBehavior ?? 'degrade',
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
  readonly requiredForUserTurn?: boolean;
  readonly sourceReferencesRequired?: boolean;
}): unknown {
  return Object.freeze({
    name: options.name,
    description: 'Host test tool.',
    requiredForUserTurn: options.requiredForUserTurn ?? false,
    maxCallsPerUserTurn: 1,
    inputContract: {
      type: 'object',
      additionalFields: false,
      fields: []
    },
    validationOwner: options.validationOwner,
    sideEffectLevel: options.sideEffectLevel,
    requiresConfirmation: false,
    sourceReferencesRequired: options.sourceReferencesRequired ?? false
  });
}

function createHostTestContextItem(options: {
  readonly capabilityId: string;
  readonly id?: string;
  readonly estimatedTokens?: number;
  readonly priority?: number;
  readonly sourceReferences?: AgentCapabilityContextItem['sourceReferences'];
}): AgentCapabilityContextItem {
  return {
    capabilityId: options.capabilityId,
    id: options.id ?? `${options.capabilityId}.item_1`,
    kind: 'memory',
    text: 'Remembered context.',
    budget: {
      estimatedTokens: options.estimatedTokens ?? 3,
      priority: options.priority ?? 1
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

function createAcceptedHostEvidence(options: {
  readonly context: RuntimeCapabilityContext;
  readonly capabilityId: string;
  readonly evidenceKind:
    | 'before_role_model_call'
    | 'tool_invocation'
    | 'after_turn_committed'
    | 'session_end';
  readonly eventId?: string;
  readonly traceId?: string;
  readonly createdAt?: string;
}): ReturnType<typeof createAgentCapabilityEvidenceSnapshot> {
  return createAgentCapabilityEvidenceSnapshot({
    eventId: options.eventId ?? options.context.eventId,
    traceId: options.traceId ?? options.context.traceId,
    createdAt: options.createdAt ?? options.context.timestamp,
    kind: 'agent_capability_evidence_snapshot',
    capabilityId: options.capabilityId,
    evidenceKind: options.evidenceKind,
    status: 'accepted',
    summary: 'accepted host evidence',
    policyOutcome: 'available_for_turn',
    redactionLabels: []
  });
}
