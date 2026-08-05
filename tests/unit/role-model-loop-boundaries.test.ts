import {describe, expect, it} from 'vitest';
import {
  createDefaultRoleModelPluginToolDefinitions,
  defaultRoleModelProviderCapabilities,
  isRoleModelRawOutputReplayableDecisionEvidence,
  type RoleModelAdapter,
  type RoleModelChatMessage,
  roleModelMalformedOutputRejectionReason,
  type RoleModelPluginToolDefinition,
  type RoleModelPluginToolHost,
  type RoleModelProviderExchangeSnapshot,
  type RoleModelProviderMetadata,
  roleModelTerminalEmptyOutputRejectionDetails,
  runRoleModelLoop,
  visibleReplyModelToolName,
} from '../../src/role-model/index.ts';
import {
  type PreparedRuntimePluginConfigEffect,
  type RuntimePluginEvidenceSnapshot,
  type RuntimePluginToolCallResult,
} from '../../src/plugins/api/index.ts';
import {createRuntimePluginHost} from '../../src/plugins/host/index.ts';
import {
  createAcceptedToolCallResult,
  createDegradingRejectedMemorySearchPlugin,
  createProviderMetadataAdapter,
  createRejectedToolCallResult,
  createSequencedAdapter,
  createTestDecisionContext,
  createTestEvent,
  createTestPluginContext,
  memorySearchToolDefinition,
  withVisibleReplyTool,
} from '../support/role-model-loop-fixtures.ts';

describe('role-model loop evidence and boundary validation', () => {
  it('keeps prepared config effects internal to bounded turn execution state', async () => {
    const eventId = 'evt_prepared_effect_boundary';
    const messagesByRound: RoleModelChatMessage[][] = [];
    const completedResults: RuntimePluginToolCallResult[] = [];
    const preparedConfigEffectsByToolCallId = new Map<
      string,
      PreparedRuntimePluginConfigEffect
    >();
    let round = 0;
    const adapter: RoleModelAdapter = Object.freeze({
      invoke(_inputEnvelope, invocation) {
        round += 1;
        messagesByRound.push([...invocation.turnContext.messages]);

        if (round === 1) {
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [{name: 'memory.search', input: {query: 'Mira'}}],
            }),
            nativeAssistantMessage: {
              role: 'assistant',
              content: 'Preparing the update.',
              tool_calls: [
                {
                  id: 'call_prepared_config_effect',
                  type: 'function',
                  function: {
                    name: 'memory.search',
                    arguments: '{"query":"Mira"}',
                  },
                },
              ],
            },
          };
        }

        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {name: 'visible_reply', input: {text: 'Update prepared.'}},
            ],
          }),
        };
      },
    });
    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('update config', eventId),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
      pluginToolHost: Object.freeze({
        handleToolCall(call) {
          return Object.freeze({
            status: 'accepted',
            output: Object.freeze({status: 'approved_pending_commit'}),
            evidence: Object.freeze([]),
            preparedConfigEffect: Object.freeze({
              eventId: call.eventId,
              traceId: call.traceId,
              createdAt: call.createdAt,
              kind: 'runtime_plugin_config_effect',
              effectId: call.toolCallId ?? 'missing-tool-call-id',
              targetPluginId: 'config.target.fixture',
              targetConfigPath: '/tmp/project02-config.json',
              fieldName: 'tone',
              expectedFingerprint: 'before-fingerprint',
              resultFingerprint: 'after-fingerprint',
              operation: Object.freeze({kind: 'set', value: 'warm'}),
            }),
          });
        },
      }),
      preparedConfigEffectsByToolCallId,
      runtimePluginContext: createTestPluginContext(eventId),
      onPluginToolCallCompleted(event) {
        completedResults.push(event.result);
      },
    });
    const nativeToolResult = messagesByRound[1]?.find(
      message => message.role === 'tool',
    );
    const publicSurfaces = JSON.stringify({
      result,
      completedResults,
      nativeToolResult,
    });
    const capturedEffects = [...preparedConfigEffectsByToolCallId.values()];

    expect(result.status).toBe('accepted');
    expect(capturedEffects).toMatchObject([
      {
        targetPluginId: 'config.target.fixture',
        fieldName: 'tone',
        operation: {kind: 'set', value: 'warm'},
      },
    ]);
    expect(completedResults).toMatchObject([
      {
        status: 'accepted',
        output: {status: 'approved_pending_commit'},
      },
    ]);
    expect(nativeToolResult).toMatchObject({role: 'tool'});
    expect(publicSurfaces).not.toContain('preparedConfigEffect');
    expect(publicSurfaces).not.toContain('runtime_plugin_config_effect');
    expect(publicSurfaces).not.toContain('before-fingerprint');
    expect(publicSurfaces).not.toContain('after-fingerprint');
  });

  it('dispatches tool input to the host exactly as the model sent it', async () => {
    let dispatchedInput: Readonly<Record<string, unknown>> | undefined;
    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('search memory', 'evt_secret_tool_input'),
      decisionContext: createTestDecisionContext(),
      adapter: createSequencedAdapter(
        [
          {
            toolCalls: [
              {
                name: 'memory.search',
                input: {
                  query: 'Authorization: Bearer input-secret',
                  access_token: 'structured-secret',
                },
              },
            ],
          },
          {
            toolCalls: [
              {name: 'visible_reply', input: {text: 'Completed safely.'}},
            ],
          },
        ],
        () => undefined,
      ),
      pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
      pluginToolHost: Object.freeze({
        handleToolCall(call) {
          dispatchedInput = call.input;
          return createAcceptedToolCallResult();
        },
      }),
      runtimePluginContext: createTestPluginContext('evt_secret_tool_input'),
    });

    expect(result.status).toBe('accepted');
    // The host receives what the model sent, byte for byte.
    expect(dispatchedInput).toEqual({
      access_token: 'structured-secret',
      query: 'Authorization: Bearer input-secret',
    });
  });

  it('continues prompting after optional degraded plugin tool failures', async () => {
    let invocations = 0;
    const adapter = createSequencedAdapter(
      [
        {
          toolCalls: [
            {
              name: 'memory.search',
              input: {
                query: 'Mira',
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: {
                text: 'continued after degraded tool',
              },
            },
          ],
        },
      ],
      () => {
        invocations += 1;
      },
    );
    const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
      handleToolCall(call, context) {
        return createRejectedToolCallResult({
          call,
          context,
          evidenceStatus: 'degraded',
          policyOutcome: 'optional_degraded',
        });
      },
    });

    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('search memory', 'evt_degraded_plugin_tool'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
      pluginToolHost,
      runtimePluginContext: createTestPluginContext('evt_degraded_plugin_tool'),
    });

    expect(result.status).toBe('accepted');
    expect(invocations).toBe(2);
    expect(result.pluginToolResults).toHaveLength(1);
    expect(result.pluginToolResults[0]?.result.status).toBe('rejected');
  });

  it('continues prompting when the real plugin host degrades optional rejected tool results', async () => {
    let invocations = 0;
    const adapter = createSequencedAdapter(
      [
        {
          toolCalls: [
            {
              name: 'memory.search',
              input: {
                query: 'Mira',
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: {
                text: 'continued after degraded host result',
              },
            },
          ],
        },
      ],
      () => {
        invocations += 1;
      },
    );
    const plugin = createDegradingRejectedMemorySearchPlugin();
    const pluginToolHost = createRuntimePluginHost({
      plugins: [plugin],
      enabledPluginIds: [plugin.manifest.id],
    });

    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('search memory', 'evt_host_degraded_plugin_tool'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: Object.freeze([
        ...createDefaultRoleModelPluginToolDefinitions(),
        ...pluginToolHost.pluginToolDefinitions(),
      ]),
      pluginToolHost,
      runtimePluginContext: createTestPluginContext(
        'evt_host_degraded_plugin_tool',
      ),
    });

    expect(result.status).toBe('accepted');
    expect(invocations).toBe(2);
    expect(result.pluginToolResults).toHaveLength(1);
    expect(result.pluginToolResults[0]?.result).toMatchObject({
      status: 'rejected',
      reason: 'handler_rejected',
      evidence: [
        {
          evidenceKind: 'tool_invocation',
          status: 'degraded',
          policyOutcome: 'optional_degraded',
        },
      ],
    });
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])(
    'rejects non-finite %s accepted plugin tool output from custom hosts',
    async (label, outputValue) => {
      let invocations = 0;
      let handledCalls = 0;
      const eventId = `evt_non_finite_${label.toLowerCase()}_plugin_output`;
      const adapter = createSequencedAdapter(
        [
          {
            toolCalls: [
              {
                name: 'memory.search',
                input: {
                  query: 'Mira',
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                name: 'visible_reply',
                input: {
                  text: 'continued after invalid output',
                },
              },
            ],
          },
        ],
        () => {
          invocations += 1;
        },
      );
      const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
        handleToolCall() {
          handledCalls += 1;

          return Object.freeze({
            status: 'accepted',
            output: Object.freeze({
              score: outputValue,
            }),
            evidence: Object.freeze([]),
          } satisfies RuntimePluginToolCallResult);
        },
      });

      const result = await runRoleModelLoop({
        onVisibleReply: () => {},
        event: createTestEvent('search memory', eventId),
        decisionContext: createTestDecisionContext(),
        adapter,
        pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
        pluginToolHost,
        runtimePluginContext: createTestPluginContext(eventId),
      });

      expect(result).toMatchObject({
        status: 'accepted',
      });
      expect(invocations).toBe(2);
      expect(handledCalls).toBe(1);
      expect(result.pluginToolResults).toHaveLength(1);
      expect(result.pluginToolResults[0]).toMatchObject({
        callId: `${eventId}.trace_${eventId}.round-1.1.memory.search`,
        result: {
          status: 'rejected',
          reason: 'invalid_tool_output',
          message: 'Plugin tool output must be finite JSON.',
        },
      });
      expect(result.rounds).toHaveLength(2);
      expect(result.rounds[0]?.pluginToolResults).toHaveLength(1);
    },
  );

  it('rejects custom-host evidence that does not match the routed call identity', async () => {
    const eventId = 'evt_custom_host_evidence_identity';
    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('search memory', eventId),
      decisionContext: createTestDecisionContext(),
      adapter: createSequencedAdapter(
        [
          {
            toolCalls: [{name: 'memory.search', input: {query: 'Mira'}}],
          },
          {
            toolCalls: [
              {name: 'visible_reply', input: {text: 'Continued safely.'}},
            ],
          },
        ],
        () => undefined,
      ),
      pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
      pluginToolHost: Object.freeze({
        handleToolCall() {
          return Object.freeze({
            status: 'accepted',
            output: {safe: true},
            evidence: [
              {
                eventId: 'wrong-event',
                traceId: 'wrong-trace',
                createdAt: '2026-06-15T00:00:00.000Z',
                kind: 'runtime_plugin_evidence_snapshot',
                pluginId: 'wrong-plugin',
                evidenceKind: 'tool_invocation',
                status: 'accepted',
                summary: 'api_key=must-not-leak',
                redactionLabels: [],
              },
            ],
          } satisfies RuntimePluginToolCallResult);
        },
      }),
      runtimePluginContext: createTestPluginContext(eventId),
    });

    expect(result.pluginToolResults[0]).toMatchObject({
      result: {
        status: 'rejected',
        reason: 'invalid_tool_output',
        message: 'Plugin tool evidence identity must match the routed call.',
      },
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });

  it('rejects custom-host evidence missing its canonical discriminator', async () => {
    const eventId = 'evt_custom_host_evidence_kind';
    const context = createTestPluginContext(eventId);
    const malformedEvidence = {
      eventId: context.eventId,
      traceId: context.traceId,
      createdAt: context.timestamp,
      kind: 'runtime_plugin_evidence_snapshot',
      pluginId: memorySearchToolDefinition.pluginId,
      evidenceKind: 'tool_invocation',
      status: 'accepted',
      summary: 'looks valid without its kind',
      redactionLabels: [],
    } satisfies RuntimePluginEvidenceSnapshot;
    Reflect.deleteProperty(malformedEvidence, 'kind');
    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('search memory', eventId),
      decisionContext: createTestDecisionContext(),
      adapter: createSequencedAdapter(
        [
          {
            toolCalls: [{name: 'memory.search', input: {query: 'Mira'}}],
          },
          {
            toolCalls: [
              {name: 'visible_reply', input: {text: 'Continued safely.'}},
            ],
          },
        ],
        () => undefined,
      ),
      pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
      pluginToolHost: Object.freeze({
        handleToolCall() {
          return Object.freeze({
            status: 'accepted',
            output: {safe: true},
            evidence: [malformedEvidence],
          } satisfies RuntimePluginToolCallResult);
        },
      }),
      runtimePluginContext: context,
    });

    expect(result.pluginToolResults[0]).toMatchObject({
      result: {
        status: 'rejected',
        reason: 'invalid_tool_output',
        message: 'Plugin evidence snapshot kind is not supported.',
      },
    });
  });

  it('counts successful tool observations toward required plugin tools across the turn', async () => {
    let invocations = 0;
    let handledCalls = 0;
    const adapter = createSequencedAdapter(
      [
        {
          toolCalls: [
            {
              name: 'memory.search',
              input: {
                query: 'Mira',
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: {
                text: 'memory checked',
              },
            },
          ],
        },
      ],
      () => {
        invocations += 1;
      },
    );
    const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
      handleToolCall() {
        handledCalls += 1;

        return createAcceptedToolCallResult();
      },
    });

    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('search memory', 'evt_required_observed'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
      pluginToolHost,
      runtimePluginContext: createTestPluginContext('evt_required_observed'),
    });

    expect(result.status).toBe('accepted');
    expect(invocations).toBe(2);
    expect(handledCalls).toBe(1);
    expect(result.pluginToolResults).toHaveLength(1);
    expect(result.rounds).toHaveLength(2);
  });

  it('allows multiple required tools to complete in sequential rounds', async () => {
    const handledTools: string[] = [];
    const secondRequiredTool = Object.freeze({
      ...memorySearchToolDefinition,
      name: 'memory.recall',
      description: 'Recall memory.',
    } satisfies RoleModelPluginToolDefinition);
    const adapter = createSequencedAdapter(
      [
        {
          toolCalls: [
            {
              name: memorySearchToolDefinition.name,
              input: {query: 'Mira'},
            },
          ],
        },
        {
          toolCalls: [
            {
              name: secondRequiredTool.name,
              input: {query: 'Mira'},
            },
          ],
        },
        {
          toolCalls: [
            {
              name: visibleReplyModelToolName,
              input: {text: 'Both required lookups completed.'},
            },
          ],
        },
      ],
      () => undefined,
    );
    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('search memory', 'evt_sequential_required_tools'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: Object.freeze([
        ...createDefaultRoleModelPluginToolDefinitions(),
        memorySearchToolDefinition,
        secondRequiredTool,
      ]),
      pluginToolHost: Object.freeze({
        handleToolCall(call) {
          handledTools.push(call.toolName);
          return createAcceptedToolCallResult();
        },
      }),
      runtimePluginContext: createTestPluginContext(
        'evt_sequential_required_tools',
      ),
    });

    expect(result.status).toBe('accepted');
    expect(handledTools).toEqual(['memory.search', 'memory.recall']);
    expect(result.rounds).toHaveLength(3);
  });

  it('returns an undeclared executable call to the model as a rejected observation', async () => {
    let handledCalls = 0;
    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('search memory', 'evt_undeclared_feedback'),
      decisionContext: createTestDecisionContext(),
      adapter: createSequencedAdapter(
        [
          {
            toolCalls: [{name: 'memory.unknown', input: {query: 'Mira'}}],
          },
          {
            toolCalls: [
              {name: visibleReplyModelToolName, input: {text: 'done'}},
            ],
          },
        ],
        () => undefined,
      ),
      pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
      pluginToolHost: Object.freeze({
        handleToolCall() {
          handledCalls += 1;
          return createAcceptedToolCallResult();
        },
      }),
      runtimePluginContext: createTestPluginContext('evt_undeclared_feedback'),
    });

    expect(result.status).toBe('accepted');
    expect(handledCalls).toBe(0);
    expect(result.rounds).toHaveLength(2);
    expect(result.pluginToolResults).toHaveLength(1);
    expect(result.pluginToolResults[0]).toMatchObject({
      dispatchedToHost: false,
      result: {status: 'rejected', reason: 'tool_not_declared'},
    });
  });

  it('rejects a declared tool outside allowedTools as not declared for the turn', async () => {
    let handledCalls = 0;
    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('search memory', 'evt_narrowed_allowlist'),
      decisionContext: createTestDecisionContext(),
      adapter: createSequencedAdapter(
        [
          {
            toolCalls: [{name: 'memory.search', input: {query: 'Mira'}}],
          },
          {
            toolCalls: [
              {name: visibleReplyModelToolName, input: {text: 'done'}},
            ],
          },
        ],
        () => undefined,
      ),
      allowedTools: [visibleReplyModelToolName],
      pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
      pluginToolHost: Object.freeze({
        handleToolCall() {
          handledCalls += 1;
          return createAcceptedToolCallResult();
        },
      }),
      runtimePluginContext: createTestPluginContext('evt_narrowed_allowlist'),
    });

    expect(result.status).toBe('accepted');
    expect(handledCalls).toBe(0);
    expect(result.pluginToolResults).toHaveLength(1);
    expect(result.pluginToolResults[0]).toMatchObject({
      dispatchedToHost: false,
      result: {status: 'rejected', reason: 'tool_not_declared'},
    });
  });

  it('sends a correction note when visible_reply text normalizes to empty', async () => {
    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('reply blank', 'evt_blank_reply_feedback'),
      decisionContext: createTestDecisionContext(),
      adapter: createSequencedAdapter(
        [
          {
            toolCalls: [
              {name: visibleReplyModelToolName, input: {text: '   '}},
            ],
          },
          {
            toolCalls: [
              {name: visibleReplyModelToolName, input: {text: 'real reply'}},
            ],
          },
        ],
        () => undefined,
      ),
      pluginToolDefinitions: createDefaultRoleModelPluginToolDefinitions(),
    });

    expect(result.status).toBe('accepted');
    expect(result.rounds).toHaveLength(2);
    if (result.status !== 'accepted') {
      throw new Error('Expected a blank visible_reply to be repaired.');
    }
    expect(executionResultVisibleReply(result)).toBe('real reply');
  });

  it('stores a rejected parsed snapshot for terminal empty toolCalls output', async () => {
    const executionResult = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('hello', 'evt_empty_tool_calls'),
      decisionContext: createTestDecisionContext(),
      pluginToolDefinitions: createDefaultRoleModelPluginToolDefinitions(),
      adapter: createSequencedAdapter(
        [
          {
            toolCalls: [],
          },
        ],
        () => undefined,
      ),
      maxToolRounds: 0,
    });
    const result = executionResult;

    expect(executionResult.status).toBe('rejected');
    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details: roleModelTerminalEmptyOutputRejectionDetails,
      },
      parsedDecisionSnapshot: {
        result: {
          status: 'rejected',
          rejection: {
            reason: roleModelMalformedOutputRejectionReason,
            details: roleModelTerminalEmptyOutputRejectionDetails,
          },
        },
      },
    });
    if (result.status !== 'rejected') {
      throw new Error('Expected empty toolCalls output to reject the loop.');
    }

    expect(result.rounds).toHaveLength(1);
    expect(result.parsedDecisionSnapshot.result).toEqual(result.decisionResult);
    expect(result.rounds[0]?.parsedDecisionSnapshot.result).toEqual(
      result.decisionResult,
    );
    expect(
      isRoleModelRawOutputReplayableDecisionEvidence({
        rawOutputText: result.ioSnapshot.rawOutputText,
        providerMetadata: result.ioSnapshot.providerMetadata,
        decisionResult: result.parsedDecisionSnapshot.result,
        allowedTools: result.ioSnapshot.inputEnvelope.allowedTools,
        pluginToolDefinitions:
          result.ioSnapshot.inputEnvelope.pluginToolDefinitions,
        toolObservations: result.ioSnapshot.inputEnvelope.toolObservations,
      }),
    ).toBe(true);
  });

  it('rejects non-finite provider request metadata before snapshots can serialize it', async () => {
    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('hello', 'evt_non_finite_provider_request'),
      decisionContext: createTestDecisionContext(),
      pluginToolDefinitions: createDefaultRoleModelPluginToolDefinitions(),
      adapter: createProviderMetadataAdapter(
        Object.freeze({
          provider: 'local',
          request: Object.freeze({
            messageCount: Number.NaN,
            stream: false,
          }),
        } satisfies RoleModelProviderMetadata),
      ),
    });

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details: 'providerMetadata.request.messageCount must be finite JSON.',
      },
    });
    expect(result.ioSnapshot.rawOutputText).toBe('');
    expect(result.ioSnapshot).not.toHaveProperty('providerMetadata');
  });

  it('rejects non-finite provider response metadata before snapshots can serialize it', async () => {
    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('hello', 'evt_non_finite_provider_response'),
      decisionContext: createTestDecisionContext(),
      pluginToolDefinitions: createDefaultRoleModelPluginToolDefinitions(),
      adapter: createProviderMetadataAdapter(
        Object.freeze({
          provider: 'local',
          response: Object.freeze({
            status: Number.POSITIVE_INFINITY,
          }),
        } satisfies RoleModelProviderMetadata),
      ),
    });

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details: 'providerMetadata.response.status must be finite JSON.',
      },
    });
    expect(result.ioSnapshot.rawOutputText).toBe('');
    expect(result.ioSnapshot).not.toHaveProperty('providerMetadata');
  });

  it('rejects malformed provider exchange evidence at the adapter boundary', async () => {
    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('hello', 'evt_malformed_provider_exchange'),
      decisionContext: createTestDecisionContext(),
      pluginToolDefinitions: createDefaultRoleModelPluginToolDefinitions(),
      adapter: Object.freeze({
        invoke(_inputEnvelope, invocation) {
          const providerExchange: RoleModelProviderExchangeSnapshot = {
            provider: {
              name: 'local',
            },
            capabilities: defaultRoleModelProviderCapabilities,
            reasoning: {
              mode: 'none',
              params: {},
            },
            renderedMessages: invocation.turnContext.messages,
            renderedTools: invocation.turnContext.tools,
            toolNameMappings: [],
            requestBody: {},
            nativeToolResultMessages: [],
          };
          Reflect.deleteProperty(providerExchange, 'reasoning');

          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'visible_reply',
                  input: {
                    text: 'hello',
                  },
                },
              ],
            }),
            providerExchange,
          };
        },
      } satisfies RoleModelAdapter),
    });

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details: 'Role-model adapter provider exchange is malformed.',
      },
    });
    expect(result.ioSnapshot.rawOutputText).toBe('');
    expect(result.ioSnapshot).not.toHaveProperty('providerExchange');
  });

  it.each([
    ['an absent required property', ['ghost']],
    ['duplicate required properties', ['text', 'text']],
  ])(
    'rejects provider exchange tool schemas with %s',
    async (_case, required) => {
      const result = await runRoleModelLoop({
        onVisibleReply: () => {},
        event: createTestEvent('hello', `evt_bad_schema_${required.join('_')}`),
        decisionContext: createTestDecisionContext(),
        pluginToolDefinitions: createDefaultRoleModelPluginToolDefinitions(),
        adapter: Object.freeze({
          invoke(_inputEnvelope, invocation) {
            const renderedTools = invocation.turnContext.tools.map(
              (tool, index) =>
                index === 0
                  ? Object.freeze({
                      type: 'function' as const,
                      function: Object.freeze({
                        ...tool.function,
                        parameters: Object.freeze({
                          ...tool.function.parameters,
                          required: Object.freeze([...required]),
                        }),
                      }),
                    })
                  : tool,
            );
            const providerExchange: RoleModelProviderExchangeSnapshot = {
              provider: {name: 'local'},
              capabilities: defaultRoleModelProviderCapabilities,
              reasoning: {mode: 'none', params: {}},
              renderedMessages: invocation.turnContext.messages,
              renderedTools,
              toolNameMappings: [],
              requestBody: {},
              nativeToolResultMessages: [],
            };

            return {
              rawOutputText: JSON.stringify({
                toolCalls: [{name: 'visible_reply', input: {text: 'hello'}}],
              }),
              providerExchange,
            };
          },
        } satisfies RoleModelAdapter),
      });

      expect(result).toMatchObject({
        status: 'rejected',
        rejection: {
          reason: roleModelMalformedOutputRejectionReason,
          details: 'Role-model adapter provider exchange is malformed.',
        },
      });
      expect(result.ioSnapshot).not.toHaveProperty('providerExchange');
    },
  );

  it('accepts a nested provider schema with an empty required array', async () => {
    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('hello', 'evt_valid_nested_empty_required'),
      decisionContext: createTestDecisionContext(),
      pluginToolDefinitions: createDefaultRoleModelPluginToolDefinitions(),
      adapter: Object.freeze({
        invoke(_inputEnvelope, invocation) {
          const renderedTools = invocation.turnContext.tools.map(
            (tool, index) =>
              index === 0
                ? Object.freeze({
                    type: 'function' as const,
                    function: Object.freeze({
                      ...tool.function,
                      parameters: Object.freeze({
                        ...tool.function.parameters,
                        properties: Object.freeze({
                          ...tool.function.parameters.properties,
                          optionalObject: Object.freeze({
                            type: 'object' as const,
                            required: Object.freeze([]),
                          }),
                        }),
                      }),
                    }),
                  })
                : tool,
          );
          const providerExchange: RoleModelProviderExchangeSnapshot = {
            provider: {name: 'local'},
            capabilities: defaultRoleModelProviderCapabilities,
            reasoning: {mode: 'none', params: {}},
            renderedMessages: invocation.turnContext.messages,
            renderedTools,
            toolNameMappings: [],
            requestBody: {},
            nativeToolResultMessages: [],
          };

          return {
            rawOutputText: JSON.stringify({
              toolCalls: [{name: 'visible_reply', input: {text: 'hello'}}],
            }),
            providerExchange,
          };
        },
      } satisfies RoleModelAdapter),
    });

    expect(result.status).toBe('accepted');
    expect(result.ioSnapshot.providerExchange).toBeDefined();
  });
});

function executionResultVisibleReply(
  result: Extract<
    Awaited<ReturnType<typeof runRoleModelLoop>>,
    {status: 'accepted'}
  >,
): string | undefined {
  const call = result.decision.toolCalls.find(
    toolCall => toolCall.name === visibleReplyModelToolName,
  );
  const text = call?.input['text'];

  return typeof text === 'string' ? text : undefined;
}
