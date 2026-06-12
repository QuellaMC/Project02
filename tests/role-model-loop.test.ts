import { describe, expect, it } from 'vitest';

import {
  CharacterReplyValidationError,
  localCharacterProfile,
  type CharacterAgent,
  type CharacterAgentReply,
  type VisibleMessage
} from '../src/conversation.ts';
import {
  createDecisionContext,
  getRequiredVisibleReplyText,
  createRoleModelInputEnvelope,
  roleModelCapabilityListToolName,
  roleModelCapabilityToolRejectedRejectionReason,
  roleModelAdapterRejectionNotReplayableDetails,
  roleModelDecisionContractVersion,
  roleModelMalformedOutputRejectionReason,
  roleModelProviderErrorRejectionReason,
  roleModelUnsupportedEffectRejectionReason,
  roleModelVisibleReplyActionName
} from '../src/role-model-contracts.ts';
import {
  agentCapabilityContractVersion,
  createAgentCapability,
  createAgentCapabilityEvidenceSnapshot,
  createRuntimeCapabilityContext,
  type AgentCapability,
  type AgentCapabilityLifecycleHooks,
  type AgentCapabilityToolCallResult
} from '../src/agent-capabilities.ts';
import {
  createRuntimeCapabilityHost,
  runtimeCapabilityDiscoveryCapabilityId
} from '../src/agent-capability-host.ts';
import {
  createDeterministicLocalRoleModelAdapter,
  createRoleModelAdapterFromCharacterAgent,
  parseRoleModelDecision,
  runRoleModelLoop,
  type RoleModelAdapter,
  type RoleModelAdapterRawOutput
} from '../src/role-model-loop.ts';
import { createUserMessageRuntimeEvent } from '../src/runtime-event.ts';

describe('role model loop', () => {
  it('runs a fresh local USER_MESSAGE turn through the deterministic adapter and captures snapshots', async () => {
    const event = createTestUserMessageEvent('hello', 'evt_role_fresh');
    const decisionContext = createDecisionContext({
      sessionId: 'local-session',
      characterSnapshot: localCharacterProfile
    });
    const expectedReply = "I'm here. Tell me what you need.";
    const expectedRawOutputText = JSON.stringify({
      version: roleModelDecisionContractVersion,
      toolCalls: [
        {
          name: roleModelVisibleReplyActionName,
          input: {
            text: expectedReply
          }
        }
      ]
    });

    const result = await runRoleModelLoop({
      event,
      decisionContext
    });

    expect(result.status).toBe('accepted');

    if (result.status !== 'accepted') {
      throw new Error('Expected accepted role model result.');
    }

    expect(getRequiredVisibleReplyText(result.decision)).toBe(expectedReply);
    expect(result.inputEnvelope.event).toEqual(event);
    expect(result.inputEnvelope.event.payload.currentUserMessage).toBe('hello');
    expect(result.inputEnvelope.decisionContext).toEqual(decisionContext);
    expect(
      'currentUserMessage' in
        result.inputEnvelope.decisionContext.characterSnapshot
    ).toBe(false);
    expect(result.ioSnapshot).toEqual({
      eventId: 'evt_role_fresh',
      traceId: 'trace_evt_role_fresh',
      createdAt: '2026-06-09T12:00:00.000Z',
      kind: 'role_model_io_snapshot',
      sessionId: 'local-session',
      inputEnvelope: result.inputEnvelope,
      rawOutputText: expectedRawOutputText
    });
    expect(result.parsedDecisionSnapshot).toEqual({
      eventId: 'evt_role_fresh',
      traceId: 'trace_evt_role_fresh',
      createdAt: '2026-06-09T12:00:00.000Z',
      kind: 'role_model_decision_snapshot',
      sessionId: 'local-session',
      result: result.decisionResult
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.ioSnapshot)).toBe(true);
    expect(Object.isFrozen(result.parsedDecisionSnapshot)).toBe(true);
  });

  it('preserves current context-aware deterministic reply behavior through the local adapter', async () => {
    const previousUserMessage = createVisibleMessage({
      id: 'local-session:message-1',
      role: 'user',
      speakerId: 'local-user',
      speakerName: 'You',
      text: 'are you there?'
    });
    const previousCharacterMessage = createVisibleMessage({
      id: 'local-session:message-2',
      role: 'character',
      speakerId: 'mira',
      speakerName: 'Mira',
      text: "I'm here. Tell me what you need."
    });
    const event = createTestUserMessageEvent('I am tired', 'evt_role_context');
    const decisionContext = createDecisionContext({
      sessionId: 'local-session',
      characterSnapshot: localCharacterProfile,
      recentVisibleMessages: [previousUserMessage, previousCharacterMessage]
    });

    const result = await runRoleModelLoop({
      event,
      decisionContext,
      adapter: createDeterministicLocalRoleModelAdapter()
    });

    expect(result.status).toBe('accepted');

    if (result.status !== 'accepted') {
      throw new Error('Expected accepted role model result.');
    }

    expect(getRequiredVisibleReplyText(result.decision)).toBe(
      'I remember you said "are you there?" Stay with me for a minute.'
    );
    expect(JSON.parse(result.ioSnapshot.rawOutputText)).toEqual({
      version: roleModelDecisionContractVersion,
      toolCalls: result.decision.toolCalls
    });
  });

  it('rejects malformed custom character-agent replies before JSON wrapping', async () => {
    const malformedReplies: readonly unknown[] = [null, {}, { text: 42 }];

    for (const [index, malformedReply] of malformedReplies.entries()) {
      const agent: CharacterAgent = {
        reply() {
          // Bypass the static agent contract to exercise runtime boundary validation.
          return malformedReply as CharacterAgentReply;
        }
      };
      const adapter = createRoleModelAdapterFromCharacterAgent(agent);
      const inputEnvelope = createRoleModelInputEnvelope({
        event: createTestUserMessageEvent(
          'hello',
          `evt_role_malformed_agent_${String(index)}`
        ),
        decisionContext: createDecisionContext({
          sessionId: 'local-session',
          characterSnapshot: localCharacterProfile
        })
      });
      const invokePromise = adapter.invoke(inputEnvelope);

      await expect(invokePromise).rejects.toThrow(CharacterReplyValidationError);
      await expect(invokePromise).rejects.toThrow(
        'Character agent returned an invalid reply.'
      );
    }
  });

  it('rejects malformed raw output before commit while keeping model I/O evidence', async () => {
    const event = createTestUserMessageEvent('hello', 'evt_role_malformed');
    const result = await runRoleModelLoop({
      event,
      decisionContext: createDecisionContext({
        sessionId: 'local-session',
        characterSnapshot: localCharacterProfile
      }),
      adapter: createRawOutputAdapter('not json')
    });

    expect(result.status).toBe('rejected');

    if (result.status !== 'rejected') {
      throw new Error('Expected rejected role model result.');
    }

    expect(result.rejection.reason).toBe(roleModelMalformedOutputRejectionReason);
    expect(result.ioSnapshot.rawOutputText).toBe('not json');
    expect(result.parsedDecisionSnapshot.result).toEqual(result.decisionResult);
    expect(result.parsedDecisionSnapshot.result).toEqual({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details: 'Adapter output must be valid JSON.'
      }
    });
  });

  it('rejects adapter raw outputs without string rawOutputText before snapshotting evidence', async () => {
    const malformedRawOutputs: readonly unknown[] = [
      {},
      {
        rawOutputText: undefined
      }
    ];

    for (const [index, rawOutput] of malformedRawOutputs.entries()) {
      const result = await runRoleModelLoop({
        event: createTestUserMessageEvent(
          'hello',
          `evt_role_malformed_adapter_${String(index)}`
        ),
        decisionContext: createDecisionContext({
          sessionId: 'local-session',
          characterSnapshot: localCharacterProfile
        }),
        adapter: createMalformedRawOutputAdapter(rawOutput)
      });

      expect(result.status).toBe('rejected');

      if (result.status !== 'rejected') {
        throw new Error('Expected rejected role model result.');
      }

      expect(result.rejection).toEqual({
        reason: roleModelMalformedOutputRejectionReason,
        details: 'Adapter raw output must include string rawOutputText.'
      });
      expect(result.ioSnapshot.rawOutputText).toBe('');
      expect(result.parsedDecisionSnapshot.result).toEqual(result.decisionResult);
      expect(result.parsedDecisionSnapshot.result).toEqual({
        status: 'rejected',
        rejection: {
          reason: roleModelMalformedOutputRejectionReason,
          details: 'Adapter raw output must include string rawOutputText.'
        }
      });
    }
  });

  it('rejects explicit adapter rejections when raw output cannot replay to the same rejection', async () => {
    const result = await runRoleModelLoop({
      event: createTestUserMessageEvent(
        'hello',
        'evt_role_unreplayable_rejection'
      ),
      decisionContext: createDecisionContext({
        sessionId: 'local-session',
        characterSnapshot: localCharacterProfile
      }),
      adapter: createMalformedRawOutputAdapter({
        rawOutputText: 'rate limit',
        rejection: {
          reason: roleModelProviderErrorRejectionReason,
          details: 'rate limit'
        }
      })
    });

    expect(result.status).toBe('rejected');

    if (result.status !== 'rejected') {
      throw new Error('Expected rejected role model result.');
    }

    expect(result.rejection).toEqual({
      reason: roleModelMalformedOutputRejectionReason,
      details: roleModelAdapterRejectionNotReplayableDetails
    });
    expect(result.ioSnapshot.rawOutputText).toBe('');
    expect(result.ioSnapshot.providerMetadata).toBeUndefined();
    expect(result.parsedDecisionSnapshot.result).toEqual(result.decisionResult);
  });

  it('preserves explicit adapter rejections when raw output replays to the same rejection', async () => {
    const result = await runRoleModelLoop({
      event: createTestUserMessageEvent(
        'hello',
        'evt_role_replayable_rejection'
      ),
      decisionContext: createDecisionContext({
        sessionId: 'local-session',
        characterSnapshot: localCharacterProfile
      }),
      adapter: createMalformedRawOutputAdapter({
        rawOutputText: 'not json',
        rejection: {
          reason: roleModelMalformedOutputRejectionReason,
          details: 'Adapter output must be valid JSON.'
        }
      })
    });

    expect(result.status).toBe('rejected');

    if (result.status !== 'rejected') {
      throw new Error('Expected rejected role model result.');
    }

    expect(result.rejection).toEqual({
      reason: roleModelMalformedOutputRejectionReason,
      details: 'Adapter output must be valid JSON.'
    });
    expect(result.ioSnapshot.rawOutputText).toBe('not json');
    expect(result.parsedDecisionSnapshot.result).toEqual(result.decisionResult);
  });

  it('rejects empty provider-error adapter outputs without matching provider error metadata', async () => {
    const malformedProviderErrorOutputs: readonly unknown[] = [
      {
        rawOutputText: '',
        rejection: {
          reason: roleModelProviderErrorRejectionReason,
          details: 'Provider request failed.'
        }
      },
      {
        rawOutputText: '',
        providerMetadata: {
          provider: 'nvidia',
          error: {
            code: 'provider_error'
          }
        },
        rejection: {
          reason: roleModelProviderErrorRejectionReason,
          details: 'Provider request failed.'
        }
      },
      {
        rawOutputText: '',
        providerMetadata: {
          provider: 'nvidia',
          error: {
            code: 'provider_error',
            message: 'Different provider details.'
          }
        },
        rejection: {
          reason: roleModelProviderErrorRejectionReason,
          details: 'Provider request failed.'
        }
      }
    ];

    for (const [index, rawOutput] of malformedProviderErrorOutputs.entries()) {
      const result = await runRoleModelLoop({
        event: createTestUserMessageEvent(
          'hello',
          `evt_role_malformed_provider_error_${String(index)}`
        ),
        decisionContext: createDecisionContext({
          sessionId: 'local-session',
          characterSnapshot: localCharacterProfile
        }),
        adapter: createMalformedRawOutputAdapter(rawOutput)
      });

      expect(result.status).toBe('rejected');

      if (result.status !== 'rejected') {
        throw new Error('Expected rejected role model result.');
      }

      expect(result.rejection).toEqual({
        reason: roleModelMalformedOutputRejectionReason,
        details: roleModelAdapterRejectionNotReplayableDetails
      });
      expect(result.ioSnapshot.rawOutputText).toBe('');
      expect(result.ioSnapshot.providerMetadata).toBeUndefined();
      expect(result.parsedDecisionSnapshot.result).toEqual(result.decisionResult);
    }
  });

  it('preserves empty provider-error adapter outputs with matching provider error metadata', async () => {
    const result = await runRoleModelLoop({
      event: createTestUserMessageEvent('hello', 'evt_role_provider_error'),
      decisionContext: createDecisionContext({
        sessionId: 'local-session',
        characterSnapshot: localCharacterProfile
      }),
      adapter: createMalformedRawOutputAdapter({
        rawOutputText: '',
        providerMetadata: {
          provider: 'nvidia',
          model: 'nvidia/test-model',
          request: {
            endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
            stream: false
          },
          error: {
            code: 'provider_error',
            message: 'Provider request failed.'
          }
        },
        rejection: {
          reason: roleModelProviderErrorRejectionReason,
          details: 'Provider request failed.'
        }
      })
    });

    expect(result.status).toBe('rejected');

    if (result.status !== 'rejected') {
      throw new Error('Expected rejected role model result.');
    }

    expect(result.rejection).toEqual({
      reason: roleModelProviderErrorRejectionReason,
      details: 'Provider request failed.'
    });
    expect(result.ioSnapshot.rawOutputText).toBe('');
    expect(result.ioSnapshot.providerMetadata).toMatchObject({
      provider: 'nvidia',
      error: {
        code: 'provider_error',
        message: 'Provider request failed.'
      }
    });
    expect(result.parsedDecisionSnapshot.result).toEqual(result.decisionResult);
  });

  it('rejects unsupported action and effect shapes with the CT-01 unsupported reason', async () => {
    const unsupportedOutputs = [
      JSON.stringify({
        action: {
          type: 'tool_call',
          name: 'search'
        }
      }),
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
    ];

    for (const rawOutputText of unsupportedOutputs) {
      const result = await runRoleModelLoop({
        event: createTestUserMessageEvent(
          'hello',
          `evt_${String(rawOutputText.length)}`
        ),
        decisionContext: createDecisionContext({
          sessionId: 'local-session',
          characterSnapshot: localCharacterProfile
        }),
        adapter: createRawOutputAdapter(rawOutputText)
      });

      expect(result.status).toBe('rejected');

      if (result.status !== 'rejected') {
        throw new Error('Expected rejected role model result.');
      }

      expect(result.rejection.reason).toBe(
        roleModelUnsupportedEffectRejectionReason
      );
      expect(result.parsedDecisionSnapshot.result).toEqual(result.decisionResult);
    }
  });

  it('parses empty and multiline visible_reply text as shape-valid for CT-04 validation', () => {
    const emptyReplyResult = parseRoleModelDecision(
      JSON.stringify({
        action: {
          type: roleModelVisibleReplyActionName,
          text: ''
        }
      })
    );
    const multilineReplyResult = parseRoleModelDecision(
      JSON.stringify({
        action: {
          type: roleModelVisibleReplyActionName,
          text: 'line one\nline two'
        }
      })
    );

    expect(emptyReplyResult).toEqual({
      status: 'accepted',
      decision: {
        version: roleModelDecisionContractVersion,
        toolCalls: [
          {
            name: roleModelVisibleReplyActionName,
            input: {
              text: ''
            }
          }
        ]
      }
    });
    expect(multilineReplyResult).toEqual({
      status: 'accepted',
      decision: {
        version: roleModelDecisionContractVersion,
        toolCalls: [
          {
            name: roleModelVisibleReplyActionName,
            input: {
              text: 'line one\nline two'
            }
          }
        ]
      }
    });
  });

  it('routes accepted capability tool calls through the runtime capability host', async () => {
    const event = createTestUserMessageEvent(
      'search memory',
      'evt_role_capability_tool'
    );
    const runtimeCapabilityContext = createRuntimeCapabilityContext({
      eventId: event.eventId,
      traceId: event.traceId,
      createdAt: event.createdAt,
      sessionId: 'local-session',
      eventType: event.type,
      currentUserMessage: event.payload.currentUserMessage,
      character: localCharacterProfile
    });
    const capability = createRoutingCapability({
      result: {
        status: 'accepted',
        output: {
          results: ['Mira prefers concise answers.']
        },
        evidence: [
          createAgentCapabilityEvidenceSnapshot({
            eventId: event.eventId,
            traceId: event.traceId,
            createdAt: event.createdAt,
            kind: 'agent_capability_evidence_snapshot',
            capabilityId: 'memory.fixture',
            evidenceKind: 'tool_invocation',
            status: 'accepted',
            summary: 'memory search accepted',
            sourceReferences: [
              {
                kind: 'memory',
                id: 'mem_1',
                title: 'preference'
              }
            ],
            redactionLabels: []
          })
        ]
      }
    });
    const host = createRuntimeCapabilityHost({
      capabilities: [capability],
      enabledCapabilityIds: ['memory.fixture']
    });
    const result = await runRoleModelLoop({
      event,
      decisionContext: createDecisionContext({
        sessionId: 'local-session',
        characterSnapshot: localCharacterProfile
      }),
      adapter: createRawOutputAdapter(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            {
              name: roleModelVisibleReplyActionName,
              input: {
                text: 'I found one memory.'
              }
            },
            {
              name: 'memory.search',
              input: {
                query: 'preference'
              }
            }
          ]
        })
      ),
      capabilityToolDefinitions: host.capabilityToolDefinitions(),
      capabilityToolHost: host,
      runtimeCapabilityContext
    });

    expect(result.status).toBe('accepted');

    if (result.status !== 'accepted') {
      throw new Error('Expected accepted role model result.');
    }

    expect(getRequiredVisibleReplyText(result.decision)).toBe(
      'I found one memory.'
    );
    expect(result.capabilityToolResults).toHaveLength(1);
    expect(result.capabilityToolResults[0]?.call).toMatchObject({
      eventId: event.eventId,
      traceId: event.traceId,
      createdAt: event.createdAt,
      capabilityId: 'memory.fixture',
      toolName: 'memory.search',
      input: {
        query: 'preference'
      }
    });
    expect(result.capabilityToolResults[0]?.result).toMatchObject({
      status: 'accepted',
      output: {
        results: ['Mira prefers concise answers.']
      },
      evidence: [
        {
          capabilityId: 'memory.fixture',
          evidenceKind: 'tool_invocation',
          status: 'accepted',
          summary: 'memory search accepted'
        }
      ]
    });
  });

  it('routes capability.list through the runtime capability host', async () => {
    const event = createTestUserMessageEvent(
      'list capabilities',
      'evt_role_capability_list'
    );
    const runtimeCapabilityContext = createRuntimeCapabilityContext({
      eventId: event.eventId,
      traceId: event.traceId,
      createdAt: event.createdAt,
      sessionId: 'local-session',
      eventType: event.type,
      currentUserMessage: event.payload.currentUserMessage,
      character: localCharacterProfile
    });
    const host = createRuntimeCapabilityHost({
      capabilities: [
        createRoutingCapability({
          result: {
            status: 'accepted',
            output: {
              results: ['Mira prefers concise answers.']
            },
            evidence: []
          }
        }),
        createDisabledSecretCapability()
      ],
      enabledCapabilityIds: ['memory.fixture']
    });
    const result = await runRoleModelLoop({
      event,
      decisionContext: createDecisionContext({
        sessionId: 'local-session',
        characterSnapshot: localCharacterProfile
      }),
      adapter: createRawOutputAdapter(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            {
              name: roleModelVisibleReplyActionName,
              input: {
                text: 'Here is what I can use.'
              }
            },
            {
              name: roleModelCapabilityListToolName,
              input: {}
            }
          ]
        })
      ),
      capabilityToolDefinitions: host.capabilityToolDefinitions(),
      capabilityToolHost: host,
      runtimeCapabilityContext
    });

    expect(result.status).toBe('accepted');

    if (result.status !== 'accepted') {
      throw new Error('Expected accepted capability list result.');
    }

    const routedList = result.capabilityToolResults.find(
      (routing) => routing.call.toolName === roleModelCapabilityListToolName
    );

    expect(routedList?.call).toMatchObject({
      capabilityId: runtimeCapabilityDiscoveryCapabilityId,
      toolName: roleModelCapabilityListToolName,
      input: {}
    });
    expect(routedList?.result).toMatchObject({
      status: 'accepted',
      output: {
        capabilities: [
          {
            id: runtimeCapabilityDiscoveryCapabilityId,
            availableForTurn: true,
            providedTools: [
              {
                name: roleModelCapabilityListToolName,
                sideEffectLevel: 'runtime_read'
              }
            ]
          },
          {
            id: 'memory.fixture',
            availableForTurn: true,
            providedTools: [
              {
                name: 'memory.search',
                sideEffectLevel: 'runtime_read'
              }
            ]
          }
        ],
        truncated: false
      }
    });

    if (routedList?.result.status !== 'accepted') {
      throw new Error('Expected accepted capability list routing result.');
    }

    const outputText = JSON.stringify(routedList.result.output);

    expect(outputText).not.toContain('memory.disabled_secret');
    expect(outputText).not.toContain('secret-token');
    expect(outputText).not.toContain('/Users/mike');
  });

  it('rejects host-rejected capability tool calls before returning an accepted loop result', async () => {
    const event = createTestUserMessageEvent(
      'search memory',
      'evt_role_capability_tool_rejected'
    );
    const runtimeCapabilityContext = createRuntimeCapabilityContext({
      eventId: event.eventId,
      traceId: event.traceId,
      createdAt: event.createdAt,
      sessionId: 'local-session',
      eventType: event.type,
      currentUserMessage: event.payload.currentUserMessage,
      character: localCharacterProfile
    });
    const host = createRuntimeCapabilityHost({
      capabilities: [
        createRoutingCapability({
          result: {
            status: 'rejected',
            reason: 'memory_unavailable',
            message: 'memory fixture unavailable',
            evidence: [
              createAgentCapabilityEvidenceSnapshot({
                eventId: event.eventId,
                traceId: event.traceId,
                createdAt: event.createdAt,
                kind: 'agent_capability_evidence_snapshot',
                capabilityId: 'memory.fixture',
                evidenceKind: 'tool_invocation',
                status: 'rejected',
                summary: 'memory fixture unavailable',
                redactionLabels: []
              })
            ]
          }
        })
      ],
      enabledCapabilityIds: ['memory.fixture']
    });
    const result = await runRoleModelLoop({
      event,
      decisionContext: createDecisionContext({
        sessionId: 'local-session',
        characterSnapshot: localCharacterProfile
      }),
      adapter: createRawOutputAdapter(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            {
              name: roleModelVisibleReplyActionName,
              input: {
                text: 'I will check.'
              }
            },
            {
              name: 'memory.search',
              input: {
                query: 'preference'
              }
            }
          ]
        })
      ),
      capabilityToolDefinitions: host.capabilityToolDefinitions(),
      capabilityToolHost: host,
      runtimeCapabilityContext
    });

    expect(result.status).toBe('rejected');

    if (result.status !== 'rejected') {
      throw new Error('Expected rejected role model result.');
    }

    expect(result.rejection).toEqual({
      reason: roleModelCapabilityToolRejectedRejectionReason,
      details: 'memory fixture unavailable'
    });
    expect(result.decisionResult).toEqual({
      status: 'rejected',
      rejection: result.rejection
    });
    expect(result.parsedDecisionSnapshot.result.status).toBe('accepted');
    expect(result.capabilityToolResults).toHaveLength(1);
    expect(result.capabilityToolResults[0]?.result).toMatchObject({
      status: 'rejected',
      reason: 'memory_unavailable',
      message: 'memory fixture unavailable'
    });
  });

  it('continues when an optional degrading capability tool handler fails after visible_reply', async () => {
    const event = createTestUserMessageEvent(
      'search memory',
      'evt_role_capability_tool_degraded'
    );
    const runtimeCapabilityContext = createRuntimeCapabilityContext({
      eventId: event.eventId,
      traceId: event.traceId,
      createdAt: event.createdAt,
      sessionId: 'local-session',
      eventType: event.type,
      currentUserMessage: event.payload.currentUserMessage,
      character: localCharacterProfile
    });
    const host = createRuntimeCapabilityHost({
      capabilities: [
        createRoutingCapability({
          handleToolCall() {
            throw new Error('memory search unavailable');
          }
        })
      ],
      enabledCapabilityIds: ['memory.fixture']
    });

    const result = await runRoleModelLoop({
      event,
      decisionContext: createDecisionContext({
        sessionId: 'local-session',
        characterSnapshot: localCharacterProfile
      }),
      adapter: createRawOutputAdapter(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            {
              name: roleModelVisibleReplyActionName,
              input: {
                text: 'I can answer without memory.'
              }
            },
            {
              name: 'memory.search',
              input: {
                query: 'preference'
              }
            }
          ]
        })
      ),
      capabilityToolDefinitions: host.capabilityToolDefinitions(),
      capabilityToolHost: host,
      runtimeCapabilityContext
    });

    expect(result.status).toBe('accepted');

    if (result.status !== 'accepted') {
      throw new Error('Expected degraded capability failure to continue.');
    }

    expect(getRequiredVisibleReplyText(result.decision)).toBe(
      'I can answer without memory.'
    );
    expect(result.capabilityToolResults).toHaveLength(1);
    expect(result.capabilityToolResults[0]?.result).toMatchObject({
      status: 'rejected',
      reason: 'handler_failed',
      message: 'memory search unavailable',
      evidence: [
        {
          capabilityId: 'memory.fixture',
          evidenceKind: 'tool_invocation',
          status: 'degraded',
          policyOutcome: 'optional_degraded'
        }
      ]
    });
  });

  it('rejects required and non-degrading capability tool handler failures', async () => {
    const cases = [
      {
        eventId: 'evt_role_capability_tool_non_degrading',
        capability: createRoutingCapability({
          handleToolCallFailureBehavior: 'reject_tool_call',
          handleToolCall() {
            throw new Error('non-degrading search unavailable');
          }
        }),
        expectedDetails: 'non-degrading search unavailable'
      },
      {
        eventId: 'evt_role_capability_tool_required',
        capability: createRoutingCapability({
          requiredForUserTurn: true,
          handleToolCall() {
            throw new Error('required search unavailable');
          }
        }),
        expectedDetails: 'required search unavailable'
      }
    ] as const;

    for (const testCase of cases) {
      const event = createTestUserMessageEvent('search memory', testCase.eventId);
      const runtimeCapabilityContext = createRuntimeCapabilityContext({
        eventId: event.eventId,
        traceId: event.traceId,
        createdAt: event.createdAt,
        sessionId: 'local-session',
        eventType: event.type,
        currentUserMessage: event.payload.currentUserMessage,
        character: localCharacterProfile
      });
      const host = createRuntimeCapabilityHost({
        capabilities: [testCase.capability],
        enabledCapabilityIds: ['memory.fixture']
      });

      const result = await runRoleModelLoop({
        event,
        decisionContext: createDecisionContext({
          sessionId: 'local-session',
          characterSnapshot: localCharacterProfile
        }),
        adapter: createRawOutputAdapter(
          JSON.stringify({
            version: roleModelDecisionContractVersion,
            toolCalls: [
              {
                name: roleModelVisibleReplyActionName,
                input: {
                  text: 'I will check.'
                }
              },
              {
                name: 'memory.search',
                input: {
                  query: 'preference'
                }
              }
            ]
          })
        ),
        capabilityToolDefinitions: host.capabilityToolDefinitions(),
        capabilityToolHost: host,
        runtimeCapabilityContext
      });

      expect(result.status).toBe('rejected');

      if (result.status !== 'rejected') {
        throw new Error('Expected capability failure to reject.');
      }

      expect(result.rejection).toEqual({
        reason: roleModelCapabilityToolRejectedRejectionReason,
        details: testCase.expectedDetails
      });
      expect(result.capabilityToolResults[0]?.result).toMatchObject({
        status: 'rejected',
        reason: 'handler_failed',
        message: testCase.expectedDetails,
        evidence: [
          {
            capabilityId: 'memory.fixture',
            evidenceKind: 'tool_invocation',
            status: 'rejected',
            policyOutcome: 'handler_rejected'
          }
        ]
      });
    }
  });
});

function createTestUserMessageEvent(message: string, eventId: string) {
  return createUserMessageRuntimeEvent(message, {
    eventId,
    traceId: `trace_${eventId}`,
    createdAt: '2026-06-09T12:00:00.000Z'
  });
}

function createVisibleMessage(message: VisibleMessage): VisibleMessage {
  return Object.freeze(message);
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

function createDisabledSecretCapability(): AgentCapability {
  return createAgentCapability({
    manifest: {
      id: 'memory.disabled_secret',
      displayName: 'Disabled memory /Users/mike secret-token',
      version: '1.0.0',
      kind: 'memory_provider',
      description: 'Disabled memory fixture with private implementation details.',
      contractVersion: agentCapabilityContractVersion,
      compatibility: {
        hostContractVersions: [agentCapabilityContractVersion],
        sourceSystem: 'project02'
      },
      declaredCapabilities: ['tool_provider', 'handle_tool_call'],
      config: {
        fields: [],
        fingerprint: 'gateway_api_key=secret-token'
      },
      localTrustLevel: 'test_fixture',
      runtimePolicy: {
        requiredForTurn: false,
        sideEffectLevel: 'runtime_read',
        confirmation: 'not_required',
        timeoutMs: 1000,
        sourceReferencesRequired: false,
        redactionLabels: ['secret'],
        failureBehavior: {
          beforeRoleModelCall: 'degrade',
          handleToolCall: 'degrade',
          afterTurnCommitted: 'log_failure',
          health: 'degrade'
        }
      },
      activation: {
        defaultEnabled: false,
        reasons: ['role_model_loop_test_disabled']
      }
    },
    providedTools: [
      {
        name: 'memory.disabled_search',
        description: 'Disabled search with private implementation details.',
        requiredForUserTurn: false,
        maxCallsPerUserTurn: 1,
        inputContract: {
          type: 'object',
          additionalFields: false,
          fields: []
        },
        validationOwner: 'capability_host',
        sideEffectLevel: 'runtime_read',
        requiresConfirmation: false,
        sourceReferencesRequired: false
      }
    ],
    lifecycleHooks: {
      handleToolCall() {
        return {
          status: 'accepted',
          output: {
            results: []
          },
          evidence: []
        };
      }
    }
  });
}

function createRoutingCapability(options: {
  readonly result?: AgentCapabilityToolCallResult;
  readonly requiredForTurn?: boolean;
  readonly requiredForUserTurn?: boolean;
  readonly handleToolCallFailureBehavior?: 'degrade' | 'reject_tool_call';
  readonly handleToolCall?: AgentCapabilityLifecycleHooks['handleToolCall'];
}): AgentCapability {
  const handleToolCall: AgentCapabilityLifecycleHooks['handleToolCall'] =
    options.handleToolCall ??
    (() => {
      if (options.result === undefined) {
        throw new Error('Routing capability test result is missing.');
      }

      return options.result;
    });

  return createAgentCapability({
    manifest: {
      id: 'memory.fixture',
      displayName: 'Memory fixture',
      version: '1.0.0',
      kind: 'memory_provider',
      description: 'In-process memory fixture for role-model loop tests.',
      contractVersion: agentCapabilityContractVersion,
      compatibility: {
        hostContractVersions: [agentCapabilityContractVersion],
        sourceSystem: 'project02'
      },
      declaredCapabilities: ['tool_provider', 'handle_tool_call'],
      config: {
        fields: []
      },
      localTrustLevel: 'test_fixture',
      runtimePolicy: {
        requiredForTurn: options.requiredForTurn ?? false,
        sideEffectLevel: 'runtime_read',
        confirmation: 'not_required',
        timeoutMs: 1000,
        sourceReferencesRequired: false,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall: 'degrade',
          handleToolCall: options.handleToolCallFailureBehavior ?? 'degrade',
          afterTurnCommitted: 'log_failure',
          health: 'degrade'
        }
      },
      activation: {
        defaultEnabled: true,
        reasons: ['role_model_loop_test']
      }
    },
    providedTools: [
      {
        name: 'memory.search',
        description: 'Search fake memory.',
        requiredForUserTurn: options.requiredForUserTurn ?? false,
        maxCallsPerUserTurn: 1,
        inputContract: {
          type: 'object',
          additionalFields: false,
          fields: [
            {
              name: 'query',
              description: 'Search query.',
              required: true
            }
          ]
        },
        validationOwner: 'capability_host',
        sideEffectLevel: 'runtime_read',
        requiresConfirmation: false,
        sourceReferencesRequired: true
      }
    ],
    lifecycleHooks: {
      handleToolCall
    }
  });
}
