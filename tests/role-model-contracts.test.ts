import { describe, expect, it } from 'vitest';

import {
  characterStatePatchModelToolName,
  createAgentCapabilityContextItem,
  createAcceptedRoleModelDecisionResult,
  createCharacterStatePatchModelToolCall,
  createDecisionContext,
  createParsedRoleModelDecisionSnapshot,
  createRejectedRoleModelDecisionResult,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot,
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
  createVisibleReplyCharacterDecision,
  getCharacterStatePatchToolCall,
  getRequiredVisibleReplyText,
  parseRoleModelDecision,
  roleModelAllowedToolNames,
  roleModelCapabilityListToolName,
  roleModelDecisionContractVersion,
  roleModelDecisionOutputContract,
  roleModelDecisionRejectionReasons,
  roleModelDisallowedToolRejectionReason,
  roleModelDuplicateToolCallRejectionReason,
  roleModelInvalidVisibleReplyRejectionReason,
  roleModelMalformedOutputRejectionReason,
  roleModelMalformedToolCallRejectionReason,
  roleModelMissingRequiredToolCallRejectionReason,
  roleModelUnsupportedEffectRejectionReason,
  roleModelUnknownToolRejectionReason,
  roleModelVisibleReplyActionName,
  validateModelToolInputAgainstContract,
  type RoleModelCapabilityToolDefinition,
  type RoleModelDecisionRejectionReason,
  type VisibleMessage
} from '../src/index.ts';

describe('role model decision contracts', () => {
  it('creates immutable tool-call snapshots that preserve event, session, and character identity', () => {
    const identity = createRuntimeEventIdentity({
      eventId: 'evt_role_model_001',
      traceId: 'trace_role_model_001',
      createdAt: '2026-06-09T00:00:00.000Z'
    });
    const event = createUserMessageRuntimeEvent('  hello Mira  ', identity);
    const character = {
      id: 'mira',
      displayName: 'Mira'
    };
    const previousMessage: VisibleMessage = {
      id: 'session-role-model:message-1',
      role: 'user',
      speakerId: 'local-user',
      speakerName: 'You',
      text: 'previous hello'
    };
    const runtimeNotes = ['recent visible messages only'];

    const context = createDecisionContext({
      sessionId: 'session-role-model',
      characterSnapshot: character,
      recentVisibleMessages: [previousMessage],
      runtimeNotes
    });
    const envelope = createRoleModelInputEnvelope({
      event,
      decisionContext: context
    });
    const decision = createVisibleReplyCharacterDecision('I am here.');
    const accepted = createAcceptedRoleModelDecisionResult(decision);
    const ioSnapshot = createRoleModelIOSnapshot({
      ...identity,
      sessionId: context.sessionId,
      inputEnvelope: envelope,
      rawOutputText: JSON.stringify(decision)
    });
    const parsedSnapshot = createParsedRoleModelDecisionSnapshot({
      ...identity,
      sessionId: context.sessionId,
      result: accepted
    });

    character.displayName = 'Mutated Mira';
    runtimeNotes.push('mutated after snapshot');

    expect(envelope.event).toEqual(event);
    expect(envelope.event.payload.currentUserMessage).toBe('hello Mira');
    expect(envelope.decisionContext.characterSnapshot).toEqual({
      id: 'mira',
      displayName: 'Mira'
    });
    expect(envelope.decisionContext.recentVisibleMessages).toEqual([
      previousMessage
    ]);
    expect(envelope.decisionContext.runtimeNotes).toEqual([
      'recent visible messages only'
    ]);
    expect(envelope.allowedTools).toEqual([
      roleModelVisibleReplyActionName,
      characterStatePatchModelToolName
    ]);
    expect(envelope.outputContract).toEqual(roleModelDecisionOutputContract);
    expect(accepted).toEqual({
      status: 'accepted',
      decision: {
        version: roleModelDecisionContractVersion,
        toolCalls: [
          {
            name: roleModelVisibleReplyActionName,
            input: {
              text: 'I am here.'
            }
          }
        ]
      }
    });
    expect(getRequiredVisibleReplyText(decision)).toBe('I am here.');
    expect(ioSnapshot).toEqual({
      eventId: 'evt_role_model_001',
      traceId: 'trace_role_model_001',
      createdAt: '2026-06-09T00:00:00.000Z',
      kind: 'role_model_io_snapshot',
      sessionId: 'session-role-model',
      inputEnvelope: envelope,
      rawOutputText: JSON.stringify(decision)
    });
    expect(parsedSnapshot.result).toEqual(accepted);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(envelope.allowedTools)).toBe(true);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.toolCalls)).toBe(true);
    expect(Object.isFrozen(decision.toolCalls[0])).toBe(true);
  });

  it('keeps the user-turn tool vocabulary scoped to visible_reply and character_state.patch', () => {
    expect(roleModelAllowedToolNames).toEqual([
      roleModelVisibleReplyActionName,
      characterStatePatchModelToolName
    ]);
    expect(roleModelDecisionOutputContract.text).toContain(
      '{"name":"visible_reply","input":{"text":"one visible reply line"}}'
    );
    expect(roleModelDecisionOutputContract.text).toContain('not "tool"');

    const decision = createVisibleReplyCharacterDecision('Only one reply.');

    expect(decision.toolCalls[0]?.name).toBe('visible_reply');
    expect(getRequiredVisibleReplyText(decision)).toBe('Only one reply.');
  });

  it('rejects unsupported allowed tools at input-envelope construction', () => {
    const identity = createRuntimeEventIdentity({
      eventId: 'evt_unsupported_allowed_tool',
      traceId: 'trace_unsupported_allowed_tool',
      createdAt: '2026-06-09T00:00:00.000Z'
    });
    const event = createUserMessageRuntimeEvent('hello', identity);
    const decisionContext = createDecisionContext({
      sessionId: 'session-role-model',
      characterSnapshot: {
        id: 'mira',
        displayName: 'Mira'
      }
    });

    expect(() => {
      Reflect.apply(createRoleModelInputEnvelope, undefined, [
        {
          event,
          decisionContext,
          allowedTools: ['unsupported_tool']
        }
      ]);
    }).toThrow(TypeError);
  });

  it('honors legacy allowedActions when creating input envelopes', () => {
    const identity = createRuntimeEventIdentity({
      eventId: 'evt_legacy_allowed_actions',
      traceId: 'trace_legacy_allowed_actions',
      createdAt: '2026-06-09T00:00:00.000Z'
    });
    const event = createUserMessageRuntimeEvent('hello', identity);
    const decisionContext = createDecisionContext({
      sessionId: 'session-role-model',
      characterSnapshot: {
        id: 'mira',
        displayName: 'Mira'
      }
    });
    const envelope = createRoleModelInputEnvelope({
      event,
      decisionContext,
      allowedActions: [roleModelVisibleReplyActionName]
    });

    expect(envelope.allowedTools).toEqual([roleModelVisibleReplyActionName]);
  });

  it('adds immutable capability context and host-approved tool definitions to the model envelope', () => {
    const identity = createRuntimeEventIdentity({
      eventId: 'evt_capability_context_items',
      traceId: 'trace_capability_context_items',
      createdAt: '2026-06-12T00:00:00.000Z'
    });
    const event = createUserMessageRuntimeEvent('what do you remember?', identity);
    const contextItem = createAgentCapabilityContextItem({
      capabilityId: 'memory.fixture',
      id: 'memory.fixture.recall_1',
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
      confidence: 0.9,
      redactionLabels: ['memory']
    });
    const decisionContext = createDecisionContext({
      sessionId: 'session-role-model',
      characterSnapshot: {
        id: 'mira',
        displayName: 'Mira'
      },
      runtimeNotes: ['base runtime note'],
      capabilityContextItems: [contextItem]
    });
    const envelope = createRoleModelInputEnvelope({
      event,
      decisionContext,
      capabilityToolDefinitions: [
        createFakeCapabilityToolDefinition(),
        createFakeCapabilityToolDefinition({
          name: roleModelCapabilityListToolName,
          capabilityId: 'runtime.capability_discovery',
          description: 'List safe current-turn capability summaries.',
          sourceReferencesRequired: false
        })
      ]
    });

    expect(envelope.decisionContext.runtimeNotes).toEqual([
      'base runtime note'
    ]);
    expect(envelope.decisionContext.capabilityContextItems).toEqual([
      contextItem
    ]);
    expect(envelope.decisionContext.capabilityContextItems[0]?.budget).toEqual({
      estimatedTokens: 8,
      priority: 1
    });
    expect(
      envelope.decisionContext.capabilityContextItems[0]?.sourceReferences
    ).toEqual([
      {
        kind: 'memory',
        id: 'mem_1',
        title: 'preference'
      }
    ]);
    expect(envelope.allowedTools).toEqual([
      roleModelVisibleReplyActionName,
      characterStatePatchModelToolName,
      'memory.search',
      roleModelCapabilityListToolName
    ]);
    expect(envelope.toolDefinitions.map((definition) => definition.name)).toEqual([
      roleModelVisibleReplyActionName,
      characterStatePatchModelToolName,
      'memory.search',
      roleModelCapabilityListToolName
    ]);
    expect(Object.isFrozen(envelope.decisionContext.capabilityContextItems)).toBe(
      true
    );
    expect(Object.isFrozen(envelope.capabilityToolDefinitions)).toBe(true);
  });

  it('shows capability tools only when allowed and rejects unsafe model-facing definitions', () => {
    const identity = createRuntimeEventIdentity({
      eventId: 'evt_capability_tool_visibility',
      traceId: 'trace_capability_tool_visibility',
      createdAt: '2026-06-12T00:00:00.000Z'
    });
    const event = createUserMessageRuntimeEvent('search memory', identity);
    const decisionContext = createDecisionContext({
      sessionId: 'session-role-model',
      characterSnapshot: {
        id: 'mira',
        displayName: 'Mira'
      }
    });
    const envelope = createRoleModelInputEnvelope({
      event,
      decisionContext,
      allowedTools: [roleModelVisibleReplyActionName],
      capabilityToolDefinitions: [createFakeCapabilityToolDefinition()]
    });

    expect(envelope.allowedTools).toEqual([roleModelVisibleReplyActionName]);
    expect(envelope.toolDefinitions.map((definition) => definition.name)).toEqual([
      roleModelVisibleReplyActionName
    ]);
    expect(
      parseRoleModelDecision(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            {
              name: roleModelVisibleReplyActionName,
              input: {
                text: 'I can look.'
              }
            },
            {
              name: 'memory.search',
              input: {
                query: 'preference'
              }
            }
          ]
        }),
        envelope.allowedTools,
        envelope.capabilityToolDefinitions
      )
    ).toEqual({
      status: 'rejected',
      rejection: {
        reason: roleModelDisallowedToolRejectionReason,
        details: 'Decision requested disallowed tool "memory.search".'
      }
    });
    expect(() =>
      createRoleModelInputEnvelope({
        event,
        decisionContext,
        capabilityToolDefinitions: [
          createFakeCapabilityToolDefinition({
            name: roleModelVisibleReplyActionName
          })
        ]
      })
    ).toThrow('must not duplicate a built-in model tool');
    expect(() =>
      createRoleModelInputEnvelope({
        event,
        decisionContext,
        capabilityToolDefinitions: [
          createFakeCapabilityToolDefinition({
            capabilityId: 'memory.fixture_a'
          }),
          createFakeCapabilityToolDefinition({
            capabilityId: 'memory.fixture_b'
          })
        ]
      })
    ).toThrow('Capability tool "memory.search" is declared more than once.');
    expect(() =>
      createRoleModelInputEnvelope({
        event,
        decisionContext,
        capabilityToolDefinitions: [
          createFakeCapabilityToolDefinition({
            requiresConfirmation: true
          })
        ]
      })
    ).toThrow('requires confirmation');
  });

  it('parses the new ordered toolCalls decision and the MVP-005 visible_reply action shape', () => {
    const patchCall = createCharacterStatePatchModelToolCall({
      mood: 'curious'
    });
    const toolCallResult = parseRoleModelDecision(
      JSON.stringify({
        version: roleModelDecisionContractVersion,
        toolCalls: [
          {
            name: roleModelVisibleReplyActionName,
            input: {
              text: 'I am here.'
            }
          },
          patchCall
        ]
      })
    );
    const legacyResult = parseRoleModelDecision(
      JSON.stringify({
        action: {
          type: roleModelVisibleReplyActionName,
          text: 'legacy reply'
        }
      })
    );

    expect(toolCallResult.status).toBe('accepted');
    expect(legacyResult.status).toBe('accepted');

    if (toolCallResult.status !== 'accepted' || legacyResult.status !== 'accepted') {
      throw new Error('Expected accepted role-model decisions.');
    }

    expect(getRequiredVisibleReplyText(toolCallResult.decision)).toBe('I am here.');
    expect(getCharacterStatePatchToolCall(toolCallResult.decision)?.input).toEqual({
      mood: 'curious'
    });
    expect(getRequiredVisibleReplyText(legacyResult.decision)).toBe(
      'legacy reply'
    );
  });

  it('accepts redundant top-level text as non-committed model text', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        version: roleModelDecisionContractVersion,
        text: 'non-committed model summary',
        toolCalls: [
          {
            name: roleModelVisibleReplyActionName,
            input: {
              text: 'committed visible reply'
            }
          }
        ]
      })
    );

    expect(result.status).toBe('accepted');

    if (result.status !== 'accepted') {
      throw new Error('Expected accepted role-model decision.');
    }

    expect(getRequiredVisibleReplyText(result.decision)).toBe(
      'committed visible reply'
    );
    expect(result.nonCommittedText).toBe('non-committed model summary');
  });

  it('rejects non-string top-level text on new ordered toolCalls decisions', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        version: roleModelDecisionContractVersion,
        text: {
          value: 'not accepted'
        },
        toolCalls: [
          {
            name: roleModelVisibleReplyActionName,
            input: {
              text: 'visible reply'
            }
          }
        ]
      })
    );

    expect(result).toEqual({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details: 'Decision text must be a string.'
      }
    });
  });

  it('rejects unsupported fields on new ordered toolCalls items', () => {
    for (const unsupportedKey of ['arguments', 'function', 'type']) {
      const result = parseRoleModelDecision(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            {
              name: roleModelVisibleReplyActionName,
              input: {
                text: 'visible reply'
              },
              [unsupportedKey]: {
                text: 'ignored alternate shape'
              }
            }
          ]
        })
      );

      expect(result).toEqual({
        status: 'rejected',
        rejection: {
          reason: roleModelUnsupportedEffectRejectionReason,
          details: `Decision toolCalls[0] includes unsupported fields: ${unsupportedKey}.`
        }
      });
    }

    const validResult = parseRoleModelDecision(
      JSON.stringify({
        version: roleModelDecisionContractVersion,
        toolCalls: [
          {
            name: roleModelVisibleReplyActionName,
            input: {
              text: 'visible reply'
            }
          }
        ]
      })
    );

    expect(validResult.status).toBe('accepted');
  });

  it('validates capability tool calls before commit while preserving built-in tool validation', () => {
    const capabilityToolDefinitions = [createFakeCapabilityToolDefinition()];
    const allowedTools = [
      roleModelVisibleReplyActionName,
      'memory.search'
    ] as const;
    const visibleReplyCall = {
      name: roleModelVisibleReplyActionName,
      input: {
        text: 'I can search memory.'
      }
    };

    expect(
      parseRoleModelDecision(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            visibleReplyCall,
            {
              name: 'unknown.search',
              input: {
                query: 'preference'
              }
            }
          ]
        }),
        allowedTools,
        capabilityToolDefinitions
      )
    ).toEqual({
      status: 'rejected',
      rejection: {
        reason: roleModelUnknownToolRejectionReason,
        details: 'Decision requested unknown tool "unknown.search".'
      }
    });
    expect(
      parseRoleModelDecision(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            visibleReplyCall,
            {
              name: 'memory.search',
              input: {}
            }
          ]
        }),
        allowedTools,
        capabilityToolDefinitions
      )
    ).toEqual({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedToolCallRejectionReason,
        details: 'memory.search input missing required field "query".'
      }
    });
    expect(
      parseRoleModelDecision(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            visibleReplyCall,
            {
              name: 'memory.search',
              input: {
                query: 42
              }
            }
          ]
        }),
        allowedTools,
        capabilityToolDefinitions
      )
    ).toEqual({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedToolCallRejectionReason,
        details: 'memory.search input field "query" must be a string.'
      }
    });
    expect(
      parseRoleModelDecision(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            visibleReplyCall,
            {
              name: 'memory.search',
              input: {
                query: 'preference'
              }
            },
            {
              name: 'memory.search',
              input: {
                query: 'preference again'
              }
            }
          ]
        }),
        allowedTools,
        capabilityToolDefinitions
      )
    ).toEqual({
      status: 'rejected',
      rejection: {
        reason: roleModelDuplicateToolCallRejectionReason,
        details:
          'Decision requested memory.search 2 times; maxCallsPerUserTurn is 1.'
      }
    });

    const acceptedResult = parseRoleModelDecision(
      JSON.stringify({
        version: roleModelDecisionContractVersion,
        toolCalls: [
          visibleReplyCall,
          {
            name: 'memory.search',
            input: {
              query: 'preference'
            }
          }
        ]
      }),
      allowedTools,
      capabilityToolDefinitions
    );

    expect(acceptedResult.status).toBe('accepted');

    if (acceptedResult.status !== 'accepted') {
      throw new Error('Expected accepted capability decision.');
    }

    expect(acceptedResult.decision.toolCalls.map((call) => call.name)).toEqual([
      roleModelVisibleReplyActionName,
      'memory.search'
    ]);
    expect(getRequiredVisibleReplyText(acceptedResult.decision)).toBe(
      'I can search memory.'
    );
  });

  it('rejects non-finite numeric capability tool inputs before handler routing', () => {
    const capabilityToolDefinition = createFakeCapabilityToolDefinition({
      inputContract: {
        type: 'object',
        additionalFields: false,
        fields: [
          {
            name: 'limit',
            description: 'Maximum result count.',
            required: true,
            valueType: 'number'
          }
        ]
      }
    });
    const capabilityToolDefinitions = [capabilityToolDefinition];
    const allowedTools = [
      roleModelVisibleReplyActionName,
      'memory.search'
    ] as const;

    const finiteResult = parseRoleModelDecision(
      JSON.stringify({
        version: roleModelDecisionContractVersion,
        toolCalls: [
          {
            name: roleModelVisibleReplyActionName,
            input: {
              text: 'I can search memory.'
            }
          },
          {
            name: 'memory.search',
            input: {
              limit: 3.5
            }
          }
        ]
      }),
      allowedTools,
      capabilityToolDefinitions
    );

    expect(finiteResult.status).toBe('accepted');

    if (finiteResult.status !== 'accepted') {
      throw new Error('Expected finite numeric capability decision.');
    }

    expect(finiteResult.decision.toolCalls[1]).toMatchObject({
      name: 'memory.search',
      input: {
        limit: 3.5
      }
    });

    expect(
      parseRoleModelDecision(
        `{"version":"${roleModelDecisionContractVersion}","toolCalls":[{"name":"${roleModelVisibleReplyActionName}","input":{"text":"I can search memory."}},{"name":"memory.search","input":{"limit":1e999}}]}`,
        allowedTools,
        capabilityToolDefinitions
      )
    ).toEqual({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedToolCallRejectionReason,
        details: 'memory.search input field "limit" must be a finite number.'
      }
    });

    for (const nonFiniteLimit of [Infinity, Number.NaN]) {
      expect(
        validateModelToolInputAgainstContract({
          toolName: 'memory.search',
          input: {
            limit: nonFiniteLimit
          },
          inputContract: capabilityToolDefinition.inputContract
        })
      ).toEqual({
        status: 'rejected',
        details: 'memory.search input field "limit" must be a finite number.'
      });
    }
  });

  it('rejects non-finite and non-serializable extra capability input fields before handler routing', () => {
    const capabilityToolDefinition = createFakeCapabilityToolDefinition({
      inputContract: {
        type: 'object',
        additionalFields: true,
        fields: [
          {
            name: 'query',
            description: 'Search query.',
            required: true,
            valueType: 'string'
          }
        ]
      }
    });
    const capabilityToolDefinitions = [capabilityToolDefinition];
    const allowedTools = [
      roleModelVisibleReplyActionName,
      'memory.search'
    ] as const;

    const finiteExtraResult = parseRoleModelDecision(
      JSON.stringify({
        version: roleModelDecisionContractVersion,
        toolCalls: [
          {
            name: roleModelVisibleReplyActionName,
            input: {
              text: 'I can search memory.'
            }
          },
          {
            name: 'memory.search',
            input: {
              query: 'preference',
              score: 0.75,
              filters: {
                recencyDays: [1, 7, 30]
              }
            }
          }
        ]
      }),
      allowedTools,
      capabilityToolDefinitions
    );

    expect(finiteExtraResult.status).toBe('accepted');

    if (finiteExtraResult.status !== 'accepted') {
      throw new Error('Expected finite extra capability input fields.');
    }

    expect(finiteExtraResult.decision.toolCalls[1]).toMatchObject({
      name: 'memory.search',
      input: {
        query: 'preference',
        score: 0.75,
        filters: {
          recencyDays: [1, 7, 30]
        }
      }
    });

    expect(
      parseRoleModelDecision(
        `{"version":"${roleModelDecisionContractVersion}","toolCalls":[{"name":"${roleModelVisibleReplyActionName}","input":{"text":"I can search memory."}},{"name":"memory.search","input":{"query":"preference","score":1e999}}]}`,
        allowedTools,
        capabilityToolDefinitions
      )
    ).toEqual({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedToolCallRejectionReason,
        details: 'memory.search input field "score" must be finite JSON.'
      }
    });

    expect(
      validateModelToolInputAgainstContract({
        toolName: 'memory.search',
        input: {
          query: 'preference',
          filters: {
            scores: [1, Number.NaN]
          }
        },
        inputContract: capabilityToolDefinition.inputContract
      })
    ).toEqual({
      status: 'rejected',
      details: 'memory.search input field "filters.scores[1]" must be finite JSON.'
    });

    expect(
      validateModelToolInputAgainstContract({
        toolName: 'memory.search',
        input: {
          query: 'preference',
          extra: undefined
        },
        inputContract: capabilityToolDefinition.inputContract
      })
    ).toEqual({
      status: 'rejected',
      details: 'memory.search input field "extra" must be JSON serializable.'
    });
  });

  it('ignores excluded required capability tools during required-call validation', () => {
    const capabilityToolDefinitions = [
      createFakeCapabilityToolDefinition({
        requiredForUserTurn: true
      })
    ];
    const visibleReplyOnlyDecision = JSON.stringify({
      version: roleModelDecisionContractVersion,
      toolCalls: [
        {
          name: roleModelVisibleReplyActionName,
          input: {
            text: 'I can answer without searching.'
          }
        }
      ]
    });

    const excludedResult = parseRoleModelDecision(
      visibleReplyOnlyDecision,
      [roleModelVisibleReplyActionName],
      capabilityToolDefinitions
    );

    expect(excludedResult.status).toBe('accepted');

    const includedResult = parseRoleModelDecision(
      visibleReplyOnlyDecision,
      [roleModelVisibleReplyActionName, 'memory.search'],
      capabilityToolDefinitions
    );

    expect(includedResult).toEqual({
      status: 'rejected',
      rejection: {
        reason: roleModelMissingRequiredToolCallRejectionReason,
        details: 'Decision must include required memory.search tool call.'
      }
    });
  });

  it('enforces included required capability tools for legacy visible_reply action decisions', () => {
    const capabilityToolDefinitions = [
      createFakeCapabilityToolDefinition({
        requiredForUserTurn: true
      })
    ];
    const legacyVisibleReplyDecision = JSON.stringify({
      action: {
        type: roleModelVisibleReplyActionName,
        text: 'legacy reply'
      }
    });

    const excludedResult = parseRoleModelDecision(
      legacyVisibleReplyDecision,
      [roleModelVisibleReplyActionName],
      capabilityToolDefinitions
    );

    expect(excludedResult.status).toBe('accepted');

    const includedResult = parseRoleModelDecision(
      legacyVisibleReplyDecision,
      [roleModelVisibleReplyActionName, 'memory.search'],
      capabilityToolDefinitions
    );

    expect(includedResult).toEqual({
      status: 'rejected',
      rejection: {
        reason: roleModelMissingRequiredToolCallRejectionReason,
        details: 'Decision must include required memory.search tool call.'
      }
    });
  });

  it('enforces allowed tools for legacy visible_reply action decisions', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        action: {
          type: roleModelVisibleReplyActionName,
          text: 'legacy reply'
        }
      }),
      [characterStatePatchModelToolName]
    );

    expect(result).toEqual({
      status: 'rejected',
      rejection: {
        reason: roleModelDisallowedToolRejectionReason,
        details: `Decision requested disallowed tool "${roleModelVisibleReplyActionName}".`
      }
    });
  });

  it('represents malformed and unsupported decisions with explicit rejection reasons', () => {
    const expectedReasons: readonly RoleModelDecisionRejectionReason[] = [
      roleModelMalformedOutputRejectionReason,
      roleModelMalformedToolCallRejectionReason,
      roleModelUnknownToolRejectionReason,
      roleModelMissingRequiredToolCallRejectionReason,
      roleModelDuplicateToolCallRejectionReason,
      roleModelUnsupportedEffectRejectionReason,
      roleModelInvalidVisibleReplyRejectionReason
    ];
    const rejectedResults = expectedReasons.map((reason) =>
      createRejectedRoleModelDecisionResult(reason, `${reason} detail`)
    );

    expect(roleModelDecisionRejectionReasons).toEqual(
      expect.arrayContaining([...expectedReasons])
    );
    expect(rejectedResults.map((result) => result.rejection.reason)).toEqual(
      expectedReasons
    );
  });
});

function createFakeCapabilityToolDefinition(
  overrides: Partial<RoleModelCapabilityToolDefinition> = {}
): RoleModelCapabilityToolDefinition {
  return {
    capabilityId: overrides.capabilityId ?? 'memory.fixture',
    name: overrides.name ?? 'memory.search',
    description: overrides.description ?? 'Search fake memory.',
    requiredForUserTurn: overrides.requiredForUserTurn ?? false,
    maxCallsPerUserTurn: overrides.maxCallsPerUserTurn ?? 1,
    inputContract: overrides.inputContract ?? {
      type: 'object',
      additionalFields: false,
      fields: [
        {
          name: 'query',
          description: 'Search query.',
          required: true,
          valueType: 'string'
        }
      ]
    },
    validationOwner: overrides.validationOwner ?? 'capability_host',
    sideEffectLevel: overrides.sideEffectLevel ?? 'runtime_read',
    requiresConfirmation: overrides.requiresConfirmation ?? false,
    sourceReferencesRequired: overrides.sourceReferencesRequired ?? true
  };
}
