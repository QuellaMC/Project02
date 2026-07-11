import { describe, expect, it } from 'vitest';
import {
  createDefaultRoleModelPluginToolDefinitions,
  isRoleModelRawOutputReplayableDecisionEvidence,
  roleModelDuplicateToolCallRejectionReason,
  roleModelMalformedOutputRejectionReason,
  roleModelTerminalEmptyOutputRejectionDetails,
  type RoleModelPluginToolDefinition,
  type RoleModelProviderExchangeSnapshot,
  type RoleModelProviderMetadata
} from '../src/role-model/contracts.ts';
import {
  type RuntimePluginEvidenceSnapshot,
  type RuntimePluginToolCallResult
} from '../src/plugins/validation.ts';
import { createRuntimePluginHost } from '../src/plugins/host.ts';
import {
  runRoleModelLoop,
  type RoleModelAdapter,
  type RoleModelPluginToolHost
} from '../src/role-model/loop.ts';
import {
  defaultRoleModelProviderCapabilities,
  type RoleModelChatMessage
} from '../src/role-model/prompt.ts';
import { visibleReplyModelToolName } from '../src/role-model/model-tools.ts';
import {
  createAcceptedToolCallResult,
  createAcceptedToolCallResultWithBlockingEvidence,
  createDegradingRejectedMemorySearchPlugin,
  createProviderMetadataAdapter,
  createRejectedToolCallResult,
  createSequencedAdapter,
  createTestDecisionContext,
  createTestEvent,
  createTestPluginContext,
  memorySearchToolDefinition,
  requiredMemorySearchToolDefinition,
  withVisibleReplyTool
} from './support/role-model-loop-fixtures.ts';

describe('role-model loop evidence and boundary validation', () => {
  it('redacts native argument-error reasons across loop and callback surfaces', async () => {
    let round = 0;
    const completedResults: RuntimePluginToolCallResult[] = [];
    const adapter: RoleModelAdapter = Object.freeze({
      invoke() {
        round += 1;

        if (round === 1) {
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                { name: 'memory.search', input: { query: 'Mira' } }
              ]
            }),
            nativeToolCallArgumentErrors: [
              {
                executableIndex: 0,
                toolName: 'memory.search',
                reason: 'invalid token=reason-sentinel',
                message: 'Authorization: ApiKey message-sentinel'
              }
            ]
          };
        }

        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              { name: 'visible_reply', input: { text: 'Continued safely.' } }
            ]
          })
        };
      }
    });
    const result = await runRoleModelLoop({
      event: createTestEvent('search memory', 'evt_native_argument_secret'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
      runtimePluginContext: createTestPluginContext(
        'evt_native_argument_secret'
      ),
      onPluginToolCallCompleted(event) {
        completedResults.push(event.result);
      }
    });
    const serialized = JSON.stringify({ result, completedResults });

    expect(result.status).toBe('accepted');
    expect(result.pluginToolResults[0]?.result).toMatchObject({
      status: 'rejected',
      reason: 'invalid token=[redacted]',
      message: 'Authorization: [redacted]'
    });
    expect(serialized).not.toContain('reason-sentinel');
    expect(serialized).not.toContain('message-sentinel');
  });

  it('preserves credential-bearing tool input for host dispatch while redacting loop evidence', async () => {
    let dispatchedInput: Readonly<Record<string, unknown>> | undefined;
    const result = await runRoleModelLoop({
      event: createTestEvent('search memory', 'evt_secret_tool_input'),
      decisionContext: createTestDecisionContext(),
      adapter: createSequencedAdapter([
        {
          toolCalls: [
            {
              name: 'memory.search',
              input: {
                query: 'Authorization: Bearer input-secret',
                access_token: 'structured-secret'
              }
            }
          ]
        },
        {
          toolCalls: [
            { name: 'visible_reply', input: { text: 'Completed safely.' } }
          ]
        }
      ], () => undefined),
      pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
      pluginToolHost: Object.freeze({
        handleToolCall(call) {
          dispatchedInput = call.input;
          return createAcceptedToolCallResult();
        }
      }),
      runtimePluginContext: createTestPluginContext('evt_secret_tool_input')
    });
    const serializedEvidence = JSON.stringify({
      ioSnapshot: result.ioSnapshot,
      parsedDecisionSnapshot: result.parsedDecisionSnapshot,
      pluginToolResults: result.pluginToolResults,
      rounds: result.rounds
    });

    expect(result.status).toBe('accepted');
    expect(dispatchedInput).toEqual({
      query: 'Authorization: Bearer input-secret',
      access_token: 'structured-secret'
    });
    expect(result.pluginToolResults[0]?.call.input).toEqual({
      query: 'Authorization: [redacted]',
      access_token: '[redacted]'
    });
    expect(serializedEvidence).not.toContain('input-secret');
    expect(serializedEvidence).not.toContain('structured-secret');
  });

  it.each(['rejected', 'failed'] as const)(
    'converts accepted plugin tool results with %s tool invocation evidence into rejected observations',
    async (evidenceStatus) => {
      let invocations = 0;
      let handledCalls = 0;
      const adapter = createSequencedAdapter([
        {
          toolCalls: [
            {
              name: 'memory.search',
              input: {
                query: 'Mira'
              }
            }
          ]
        },
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: {
                text: 'continued after contradictory tool evidence'
              }
            }
          ]
        }
      ], () => {
        invocations += 1;
      });
      const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
        handleToolCall(call, context) {
          handledCalls += 1;

          return createAcceptedToolCallResultWithBlockingEvidence({
            call,
            context,
            evidenceStatus
          });
        }
      });

      const result = await runRoleModelLoop({
        event: createTestEvent(
          'search memory',
          `evt_accepted_${evidenceStatus}_evidence_plugin_tool`
        ),
        decisionContext: createTestDecisionContext(),
        adapter,
        pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
        pluginToolHost,
        runtimePluginContext: createTestPluginContext(
          `evt_accepted_${evidenceStatus}_evidence_plugin_tool`
        )
      });

      expect(result).toMatchObject({
        status: 'accepted'
      });
      expect(invocations).toBe(2);
      expect(handledCalls).toBe(1);
      expect(result.pluginToolResults[0]?.result).toMatchObject({
        status: 'rejected',
        reason: 'blocking_tool_invocation_evidence',
        evidence: [
          {
            evidenceKind: 'tool_invocation',
            status: evidenceStatus
          }
        ]
      });
    }
  );

  it('continues prompting after optional degraded plugin tool failures', async () => {
    let invocations = 0;
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'memory.search',
            input: {
              query: 'Mira'
            }
          }
        ]
      },
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'continued after degraded tool'
            }
          }
        ]
      }
    ], () => {
      invocations += 1;
    });
    const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
      handleToolCall(call, context) {
        return createRejectedToolCallResult({
          call,
          context,
          evidenceStatus: 'degraded',
          policyOutcome: 'optional_degraded'
        });
      }
    });

    const result = await runRoleModelLoop({
      event: createTestEvent('search memory', 'evt_degraded_plugin_tool'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
      pluginToolHost,
      runtimePluginContext: createTestPluginContext('evt_degraded_plugin_tool')
    });

    expect(result.status).toBe('accepted');
    expect(invocations).toBe(2);
    expect(result.pluginToolResults).toHaveLength(1);
    expect(result.pluginToolResults[0]?.result.status).toBe('rejected');
  });

  it('continues prompting when the real plugin host degrades optional rejected tool results', async () => {
    let invocations = 0;
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'memory.search',
            input: {
              query: 'Mira'
            }
          }
        ]
      },
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'continued after degraded host result'
            }
          }
        ]
      }
    ], () => {
      invocations += 1;
    });
    const plugin = createDegradingRejectedMemorySearchPlugin();
    const pluginToolHost = createRuntimePluginHost({
      plugins: [plugin],
      enabledPluginIds: [plugin.manifest.id]
    });

    const result = await runRoleModelLoop({
      event: createTestEvent('search memory', 'evt_host_degraded_plugin_tool'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: Object.freeze([
        ...createDefaultRoleModelPluginToolDefinitions(),
        ...pluginToolHost.pluginToolDefinitions()
      ]),
      pluginToolHost,
      runtimePluginContext: createTestPluginContext('evt_host_degraded_plugin_tool')
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
          policyOutcome: 'optional_degraded'
        }
      ]
    });
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY]
  ])(
    'rejects non-finite %s accepted plugin tool output from custom hosts',
    async (label, outputValue) => {
      let invocations = 0;
      let handledCalls = 0;
      const eventId = `evt_non_finite_${label.toLowerCase()}_plugin_output`;
      const adapter = createSequencedAdapter([
        {
          toolCalls: [
            {
              name: 'memory.search',
              input: {
                query: 'Mira'
              }
            }
          ]
        },
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: {
                text: 'continued after invalid output'
              }
            }
          ]
        }
      ], () => {
        invocations += 1;
      });
      const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
        handleToolCall() {
          handledCalls += 1;

          return Object.freeze({
            status: 'accepted',
            output: Object.freeze({
              score: outputValue
            }),
            evidence: Object.freeze([])
          } satisfies RuntimePluginToolCallResult);
        }
      });

      const result = await runRoleModelLoop({
        event: createTestEvent('search memory', eventId),
        decisionContext: createTestDecisionContext(),
        adapter,
        pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
        pluginToolHost,
        runtimePluginContext: createTestPluginContext(eventId)
      });

      expect(result).toMatchObject({
        status: 'accepted'
      });
      expect(invocations).toBe(2);
      expect(handledCalls).toBe(1);
      expect(result.pluginToolResults).toHaveLength(1);
      expect(result.pluginToolResults[0]).toMatchObject({
        callId: `${eventId}.trace_${eventId}.round-1.1.memory.search`,
        result: {
          status: 'rejected',
          reason: 'invalid_tool_output',
          message: 'Plugin tool output must be finite JSON.'
        }
      });
      expect(result.rounds).toHaveLength(2);
      expect(result.rounds[0]?.pluginToolResults).toHaveLength(1);
    }
  );

  it('redacts custom plugin host accepted string outputs before completion events and native replay', async () => {
    let invocations = 0;
    let handledCalls = 0;
    const messagesByRound: RoleModelChatMessage[][] = [];
    const completedResults: RuntimePluginToolCallResult[] = [];
    const redactedOutput = {
      matched:
        'api_key=[redacted] Bearer [redacted] https://[redacted]@example.test/?token=[redacted]',
      api_key: '[redacted]',
      nested: {
        password: '[redacted]',
        client_secret: '[redacted]'
      },
      list: [
        'credential=[redacted]',
        {
          access_token: '[redacted]',
          label: 'kept'
        }
      ]
    };
    const adapter: RoleModelAdapter = Object.freeze({
      invoke(_inputEnvelope, invocation) {
        invocations += 1;
        messagesByRound.push([...invocation.turnContext.messages]);

        if (invocations === 1) {
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'memory.search',
                  input: {
                    query: 'Mira'
                  }
                }
              ]
            }),
            nativeAssistantMessage: {
              role: 'assistant',
              content: 'Searching memory.',
              tool_calls: [
                {
                  id: 'call_memory_search_secret',
                  type: 'function',
                  function: {
                    name: 'memory.search',
                    arguments: '{"query":"Mira"}'
                  }
                }
              ]
            }
          };
        }

        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {
                name: 'visible_reply',
                input: {
                  text: 'memory checked'
                }
              }
            ]
          })
        };
      }
    } satisfies RoleModelAdapter);
    const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
      handleToolCall() {
        handledCalls += 1;

        return Object.freeze({
          status: 'accepted',
          output: Object.freeze({
            matched:
              'api_key=super-secret Bearer secret-token https://user:pass@example.test/?token=abc',
            api_key: 'key-only-secret',
            nested: Object.freeze({
              password: 'password=open-sesame',
              client_secret: 'structured-only-secret'
            }),
            list: Object.freeze([
              'credential=door-code',
              Object.freeze({
                access_token: 'list-only-secret',
                label: 'kept'
              })
            ])
          }),
          evidence: Object.freeze([])
        } satisfies RuntimePluginToolCallResult);
      }
    });

    const result = await runRoleModelLoop({
      event: createTestEvent('search memory', 'evt_custom_host_secret_output'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
      pluginToolHost,
      runtimePluginContext: createTestPluginContext(
        'evt_custom_host_secret_output'
      ),
      onPluginToolCallCompleted(event) {
        completedResults.push(event.result);
      }
    });

    expect(result.status).toBe('accepted');
    expect(invocations).toBe(2);
    expect(handledCalls).toBe(1);
    expect(completedResults).toMatchObject([
      {
        status: 'accepted',
        output: redactedOutput
      }
    ]);
    expect(result.pluginToolResults[0]?.result).toMatchObject({
      status: 'accepted',
      output: redactedOutput
    });
    expect(result.inputEnvelope.toolObservations[0]?.result).toMatchObject({
      status: 'accepted',
      output: redactedOutput
    });

    const nativeToolMessage = messagesByRound[1]?.find(
      (message) => message.role === 'tool'
    );

    expect(nativeToolMessage).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_memory_search_secret'
    });
    expect(nativeToolMessage?.content).toContain('api_key=[redacted]');
    expect(nativeToolMessage?.content).toContain('"api_key":"[redacted]"');
    expect(nativeToolMessage?.content).toContain('Bearer [redacted]');
    expect(nativeToolMessage?.content).toContain('"password":"[redacted]"');
    expect(nativeToolMessage?.content).toContain('"client_secret":"[redacted]"');
    expect(nativeToolMessage?.content).toContain('credential=[redacted]');
    expect(nativeToolMessage?.content).toContain('"access_token":"[redacted]"');

    const serializedSurfaces = JSON.stringify({
      completedResults,
      pluginToolResults: result.pluginToolResults,
      toolObservations: result.inputEnvelope.toolObservations,
      nativeToolContent: nativeToolMessage?.content
    });

    expect(serializedSurfaces).not.toContain('super-secret');
    expect(serializedSurfaces).not.toContain('key-only-secret');
    expect(serializedSurfaces).not.toContain('secret-token');
    expect(serializedSurfaces).not.toContain('open-sesame');
    expect(serializedSurfaces).not.toContain('structured-only-secret');
    expect(serializedSurfaces).not.toContain('door-code');
    expect(serializedSurfaces).not.toContain('list-only-secret');
    expect(serializedSurfaces).not.toContain('user:pass');
    expect(serializedSurfaces).not.toContain('token=abc');
  });

  it('redacts custom plugin host rejected messages before loop rejection evidence', async () => {
    let invocations = 0;
    const completedResults: RuntimePluginToolCallResult[] = [];
    const completedDispatchSignals: boolean[] = [];
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'memory.search',
            input: {
              query: 'Mira'
            }
          }
        ]
      },
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'continued after rejected tool'
            }
          }
        ]
      }
    ], () => {
      invocations += 1;
    });
    const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
      handleToolCall() {
        return Object.freeze({
          status: 'rejected',
          reason: 'handler_failed token=reason-secret',
          message:
            'search backend failed api_key=super-secret Bearer secret-token',
          evidence: Object.freeze([])
        } satisfies RuntimePluginToolCallResult);
      }
    });

    const result = await runRoleModelLoop({
      event: createTestEvent('search memory', 'evt_custom_host_secret_reject'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
      pluginToolHost,
      runtimePluginContext: createTestPluginContext(
        'evt_custom_host_secret_reject'
      ),
      onPluginToolCallCompleted(event) {
        completedDispatchSignals.push(event.dispatchedToHost);
        completedResults.push(event.result);
      }
    });

    expect(result.status).toBe('accepted');
    expect(result.pluginToolResults).toMatchObject([
      {
        result: {
          status: 'rejected',
          reason: 'handler_failed token=[redacted]',
          message:
            'search backend failed api_key=[redacted] Bearer [redacted]'
        }
      }
    ]);
    expect(invocations).toBe(2);
    expect(completedResults).toMatchObject([
      {
        status: 'rejected',
        message: 'search backend failed api_key=[redacted] Bearer [redacted]'
      }
    ]);
    expect(completedDispatchSignals).toEqual([true]);

    const serializedSurfaces = JSON.stringify({
      completedResults,
      pluginToolResults: result.pluginToolResults
    });

    expect(serializedSurfaces).not.toContain('super-secret');
    expect(serializedSurfaces).not.toContain('secret-token');
    expect(serializedSurfaces).not.toContain('reason-secret');
  });

  it('rejects custom-host evidence that does not match the routed call identity', async () => {
    const eventId = 'evt_custom_host_evidence_identity';
    const result = await runRoleModelLoop({
      event: createTestEvent('search memory', eventId),
      decisionContext: createTestDecisionContext(),
      adapter: createSequencedAdapter(
        [
          {
            toolCalls: [
              { name: 'memory.search', input: { query: 'Mira' } }
            ]
          },
          {
            toolCalls: [
              { name: 'visible_reply', input: { text: 'Continued safely.' } }
            ]
          }
        ],
        () => undefined
      ),
      pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
      pluginToolHost: Object.freeze({
        handleToolCall() {
          return Object.freeze({
            status: 'accepted',
            output: { safe: true },
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
                redactionLabels: []
              }
            ]
          } satisfies RuntimePluginToolCallResult);
        }
      }),
      runtimePluginContext: createTestPluginContext(eventId)
    });

    expect(result.pluginToolResults[0]).toMatchObject({
      result: {
        status: 'rejected',
        reason: 'invalid_tool_output',
        message: 'Plugin tool evidence identity must match the routed call.'
      }
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
      redactionLabels: []
    } satisfies RuntimePluginEvidenceSnapshot;
    Reflect.deleteProperty(malformedEvidence, 'kind');
    const result = await runRoleModelLoop({
      event: createTestEvent('search memory', eventId),
      decisionContext: createTestDecisionContext(),
      adapter: createSequencedAdapter(
        [
          {
            toolCalls: [
              { name: 'memory.search', input: { query: 'Mira' } }
            ]
          },
          {
            toolCalls: [
              { name: 'visible_reply', input: { text: 'Continued safely.' } }
            ]
          }
        ],
        () => undefined
      ),
      pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
      pluginToolHost: Object.freeze({
        handleToolCall() {
          return Object.freeze({
            status: 'accepted',
            output: { safe: true },
            evidence: [malformedEvidence]
          } satisfies RuntimePluginToolCallResult);
        }
      }),
      runtimePluginContext: context
    });

    expect(result.pluginToolResults[0]).toMatchObject({
      result: {
        status: 'rejected',
        reason: 'invalid_tool_output',
        message: 'Plugin evidence snapshot kind is not supported.'
      }
    });
  });

  it('counts successful tool observations toward required plugin tools across the turn', async () => {
    let invocations = 0;
    let handledCalls = 0;
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'memory.search',
            input: {
              query: 'Mira'
            }
          }
        ]
      },
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'memory checked'
            }
          }
        ]
      }
    ], () => {
      invocations += 1;
    });
    const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
      handleToolCall() {
        handledCalls += 1;

        return createAcceptedToolCallResult();
      }
    });

    const result = await runRoleModelLoop({
      event: createTestEvent('search memory', 'evt_required_observed'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: withVisibleReplyTool(requiredMemorySearchToolDefinition),
      pluginToolHost,
      runtimePluginContext: createTestPluginContext('evt_required_observed')
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
      ...requiredMemorySearchToolDefinition,
      name: 'memory.recall',
      description: 'Recall memory.'
    } satisfies RoleModelPluginToolDefinition);
    const adapter = createSequencedAdapter(
      [
        {
          toolCalls: [
            {
              name: requiredMemorySearchToolDefinition.name,
              input: { query: 'Mira' }
            }
          ]
        },
        {
          toolCalls: [
            {
              name: secondRequiredTool.name,
              input: { query: 'Mira' }
            }
          ]
        },
        {
          toolCalls: [
            {
              name: visibleReplyModelToolName,
              input: { text: 'Both required lookups completed.' }
            }
          ]
        }
      ],
      () => undefined
    );
    const result = await runRoleModelLoop({
      event: createTestEvent('search memory', 'evt_sequential_required_tools'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: Object.freeze([
        ...createDefaultRoleModelPluginToolDefinitions(),
        requiredMemorySearchToolDefinition,
        secondRequiredTool
      ]),
      pluginToolHost: Object.freeze({
        handleToolCall(call) {
          handledTools.push(call.toolName);
          return createAcceptedToolCallResult();
        }
      }),
      runtimePluginContext: createTestPluginContext(
        'evt_sequential_required_tools'
      )
    });

    expect(result.status).toBe('accepted');
    expect(handledTools).toEqual(['memory.search', 'memory.recall']);
    expect(result.rounds).toHaveLength(3);
  });

  it('rejects plugin tool repeats across rounds against its user-turn call limit', async () => {
    let invocations = 0;
    let handledCalls = 0;
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'memory.search',
            input: {
              query: 'Mira'
            }
          }
        ]
      },
      {
        toolCalls: [
          {
            name: 'memory.search',
            input: {
              query: 'Mira again'
            }
          }
        ]
      }
    ], () => {
      invocations += 1;
    });
    const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
      handleToolCall() {
        handledCalls += 1;

        return createAcceptedToolCallResult();
      }
    });

    const result = await runRoleModelLoop({
      event: createTestEvent('search memory', 'evt_repeated_tool'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
      pluginToolHost,
      runtimePluginContext: createTestPluginContext('evt_repeated_tool')
    });

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelDuplicateToolCallRejectionReason
      }
    });
    if (result.status !== 'rejected') {
      throw new Error('Expected repeated tool call to be rejected.');
    }

    expect(result.rejection.details).toContain('user_turn maxCalls is 1');
    expect(invocations).toBe(2);
    expect(handledCalls).toBe(1);
    expect(result.pluginToolResults).toHaveLength(1);
    expect(result.rounds).toHaveLength(2);
  });

  it('counts rejected and non-dispatched attempts toward user-turn call limits', async () => {
    const adapter = createSequencedAdapter(
      [
        {
          toolCalls: [
            { name: 'memory.search', input: { query: 'first' } }
          ]
        },
        {
          toolCalls: [
            { name: 'memory.search', input: { query: 'retry' } }
          ]
        }
      ],
      () => undefined
    );
    const result = await runRoleModelLoop({
      event: createTestEvent('search memory', 'evt_rejected_attempt_limit'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
    });

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: { reason: roleModelDuplicateToolCallRejectionReason }
    });
    expect(result.pluginToolResults[0]).toMatchObject({
      dispatchedToHost: false,
      result: { status: 'rejected', reason: 'tool_host_missing' }
    });
  });

  it.each(['rejected', 'thrown', 'invalid_output'] as const)(
    'counts %s host attempts before rejecting a retry',
    async (failureMode) => {
      let hostCalls = 0;
      const result = await runRoleModelLoop({
        event: createTestEvent(
          'search memory',
          `evt_${failureMode}_attempt_limit`
        ),
        decisionContext: createTestDecisionContext(),
        adapter: createSequencedAdapter(
          [
            {
              toolCalls: [
                { name: 'memory.search', input: { query: 'first' } }
              ]
            },
            {
              toolCalls: [
                { name: 'memory.search', input: { query: 'retry' } }
              ]
            }
          ],
          () => undefined
        ),
        pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
        pluginToolHost: Object.freeze({
          handleToolCall() {
            hostCalls += 1;

            if (failureMode === 'thrown') {
              throw new Error('handler failed');
            }
            if (failureMode === 'invalid_output') {
              return Object.freeze({
                status: 'accepted',
                output: { score: Number.NaN },
                evidence: []
              } satisfies RuntimePluginToolCallResult);
            }

            return Object.freeze({
              status: 'rejected',
              reason: 'handler_rejected',
              message: 'not available',
              evidence: []
            } satisfies RuntimePluginToolCallResult);
          }
        }),
        runtimePluginContext: createTestPluginContext(
          `evt_${failureMode}_attempt_limit`
        )
      });

      expect(result).toMatchObject({
        status: 'rejected',
        rejection: { reason: roleModelDuplicateToolCallRejectionReason }
      });
      expect(hostCalls).toBe(1);
      expect(result.pluginToolResults).toHaveLength(1);
    }
  );

  it('rejects an over-capacity batch before dispatching any member', async () => {
    let hostCalls = 0;
    const result = await runRoleModelLoop({
      event: createTestEvent('search memory', 'evt_batch_attempt_limit'),
      decisionContext: createTestDecisionContext(),
      adapter: createSequencedAdapter(
        [
          {
            toolCalls: [
              { name: 'memory.search', input: { query: 'first' } },
              { name: 'memory.search', input: { query: 'second' } }
            ]
          }
        ],
        () => undefined
      ),
      pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
      pluginToolHost: Object.freeze({
        handleToolCall() {
          hostCalls += 1;
          return createAcceptedToolCallResult();
        }
      }),
      runtimePluginContext: createTestPluginContext('evt_batch_attempt_limit')
    });

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: { reason: roleModelDuplicateToolCallRejectionReason }
    });
    expect(hostCalls).toBe(0);
    expect(result.pluginToolResults).toHaveLength(0);
  });

  it('stores a rejected parsed snapshot for terminal empty toolCalls output', async () => {
    const result = await runRoleModelLoop({
      event: createTestEvent('hello', 'evt_empty_tool_calls'),
      decisionContext: createTestDecisionContext(),
      adapter: createSequencedAdapter([
        {
          toolCalls: []
        }
      ], () => undefined)
    });

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details: roleModelTerminalEmptyOutputRejectionDetails
      },
      parsedDecisionSnapshot: {
        result: {
          status: 'rejected',
          rejection: {
            reason: roleModelMalformedOutputRejectionReason,
            details: roleModelTerminalEmptyOutputRejectionDetails
          }
        }
      }
    });
    if (result.status !== 'rejected') {
      throw new Error('Expected empty toolCalls output to reject the loop.');
    }

    expect(result.rounds).toHaveLength(1);
    expect(result.parsedDecisionSnapshot.result).toEqual(result.decisionResult);
    expect(result.rounds[0]?.parsedDecisionSnapshot.result).toEqual(
      result.decisionResult
    );
    expect(
      isRoleModelRawOutputReplayableDecisionEvidence({
        rawOutputText: result.ioSnapshot.rawOutputText,
        providerMetadata: result.ioSnapshot.providerMetadata,
        decisionResult: result.parsedDecisionSnapshot.result,
        allowedTools: result.ioSnapshot.inputEnvelope.allowedTools,
        pluginToolDefinitions:
          result.ioSnapshot.inputEnvelope.pluginToolDefinitions,
        toolObservations: result.ioSnapshot.inputEnvelope.toolObservations
      })
    ).toBe(true);
  });

  it('redacts adapter-supplied provider endpoints before IO snapshots expose them', async () => {
    const result = await runRoleModelLoop({
      event: createTestEvent('hello', 'evt_provider_endpoint_redaction'),
      decisionContext: createTestDecisionContext(),
      adapter: createProviderMetadataAdapter(
        Object.freeze({
          provider: 'local',
          request: Object.freeze({
            endpoint:
              'https://user:pass@example.test/chat?keep=ok&token=super-secret',
            messageCount: 1,
            stream: false
          })
        } satisfies RoleModelProviderMetadata)
      )
    });

    expect(result.status).toBe('accepted');
    expect(result.ioSnapshot.providerMetadata).toMatchObject({
      provider: 'local',
      request: {
        endpoint:
          'https://[redacted]@example.test/chat?keep=ok&token=[redacted]',
        messageCount: 1,
        stream: false
      }
    });

    const serializedProviderMetadata = JSON.stringify(
      result.ioSnapshot.providerMetadata
    );

    expect(serializedProviderMetadata).not.toContain('user:pass');
    expect(serializedProviderMetadata).not.toContain('super-secret');
  });

  it('rejects non-finite provider request metadata before snapshots can serialize it', async () => {
    const result = await runRoleModelLoop({
      event: createTestEvent('hello', 'evt_non_finite_provider_request'),
      decisionContext: createTestDecisionContext(),
      adapter: createProviderMetadataAdapter(
        Object.freeze({
          provider: 'local',
          request: Object.freeze({
            messageCount: Number.NaN,
            stream: false
          })
        } satisfies RoleModelProviderMetadata)
      )
    });

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details: 'providerMetadata.request.messageCount must be finite JSON.'
      }
    });
    expect(result.ioSnapshot.rawOutputText).toBe('');
    expect(result.ioSnapshot).not.toHaveProperty('providerMetadata');
  });

  it('rejects non-finite provider response metadata before snapshots can serialize it', async () => {
    const result = await runRoleModelLoop({
      event: createTestEvent('hello', 'evt_non_finite_provider_response'),
      decisionContext: createTestDecisionContext(),
      adapter: createProviderMetadataAdapter(
        Object.freeze({
          provider: 'local',
          response: Object.freeze({
            status: Number.POSITIVE_INFINITY
          })
        } satisfies RoleModelProviderMetadata)
      )
    });

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details: 'providerMetadata.response.status must be finite JSON.'
      }
    });
    expect(result.ioSnapshot.rawOutputText).toBe('');
    expect(result.ioSnapshot).not.toHaveProperty('providerMetadata');
  });

  it('rejects malformed provider exchange evidence at the adapter boundary', async () => {
    const result = await runRoleModelLoop({
      event: createTestEvent('hello', 'evt_malformed_provider_exchange'),
      decisionContext: createTestDecisionContext(),
      adapter: Object.freeze({
        invoke(_inputEnvelope, invocation) {
          const providerExchange: RoleModelProviderExchangeSnapshot = {
            provider: {
              name: 'local'
            },
            capabilities: defaultRoleModelProviderCapabilities,
            reasoning: {
              mode: 'none',
              params: {}
            },
            renderedMessages: invocation.turnContext.messages,
            renderedTools: invocation.turnContext.tools,
            toolNameMappings: [],
            requestBody: {},
            nativeToolResultMessages: []
          };
          Reflect.deleteProperty(providerExchange, 'reasoning');

          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'visible_reply',
                  input: {
                    text: 'hello'
                  }
                }
              ]
            }),
            providerExchange
          };
        }
      } satisfies RoleModelAdapter)
    });

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details: 'Role-model adapter provider exchange is malformed.'
      }
    });
    expect(result.ioSnapshot.rawOutputText).toBe('');
    expect(result.ioSnapshot).not.toHaveProperty('providerExchange');
  });

  it.each([
    ['an absent required property', ['ghost']],
    ['duplicate required properties', ['text', 'text']]
  ])(
    'rejects provider exchange tool schemas with %s',
    async (_case, required) => {
      const result = await runRoleModelLoop({
        event: createTestEvent('hello', `evt_bad_schema_${required.join('_')}`),
        decisionContext: createTestDecisionContext(),
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
                          required: Object.freeze([...required])
                        })
                      })
                    })
                  : tool
            );
            const providerExchange: RoleModelProviderExchangeSnapshot = {
              provider: { name: 'local' },
              capabilities: defaultRoleModelProviderCapabilities,
              reasoning: { mode: 'none', params: {} },
              renderedMessages: invocation.turnContext.messages,
              renderedTools,
              toolNameMappings: [],
              requestBody: {},
              nativeToolResultMessages: []
            };

            return {
              rawOutputText: JSON.stringify({
                toolCalls: [
                  { name: 'visible_reply', input: { text: 'hello' } }
                ]
              }),
              providerExchange
            };
          }
        } satisfies RoleModelAdapter)
      });

      expect(result).toMatchObject({
        status: 'rejected',
        rejection: {
          reason: roleModelMalformedOutputRejectionReason,
          details: 'Role-model adapter provider exchange is malformed.'
        }
      });
      expect(result.ioSnapshot).not.toHaveProperty('providerExchange');
    }
  );

  it('accepts a nested provider schema with an empty required array', async () => {
    const result = await runRoleModelLoop({
      event: createTestEvent('hello', 'evt_valid_nested_empty_required'),
      decisionContext: createTestDecisionContext(),
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
                            required: Object.freeze([])
                          })
                        })
                      })
                    })
                  })
                : tool
          );
          const providerExchange: RoleModelProviderExchangeSnapshot = {
            provider: { name: 'local' },
            capabilities: defaultRoleModelProviderCapabilities,
            reasoning: { mode: 'none', params: {} },
            renderedMessages: invocation.turnContext.messages,
            renderedTools,
            toolNameMappings: [],
            requestBody: {},
            nativeToolResultMessages: []
          };

          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                { name: 'visible_reply', input: { text: 'hello' } }
              ]
            }),
            providerExchange
          };
        }
      } satisfies RoleModelAdapter)
    });

    expect(result.status).toBe('accepted');
    expect(result.ioSnapshot.providerExchange).toBeDefined();
  });
});
