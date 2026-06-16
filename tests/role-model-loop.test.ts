import { describe, expect, it } from 'vitest';

import {
  createDecisionContext,
  isRoleModelRawOutputReplayableDecisionEvidence,
  roleModelDuplicateToolCallRejectionReason,
  roleModelMalformedOutputRejectionReason,
  roleModelPluginToolRejectedRejectionReason,
  roleModelTerminalEmptyOutputRejectionDetails,
  type RoleModelPluginToolDefinition,
  type RoleModelProviderMetadata
} from '../src/role-model/contracts.ts';
import {
  createRuntimePlugin,
  createRuntimePluginContext,
  createRuntimePluginEvidenceSnapshot,
  runtimePluginContractVersion,
  type RuntimePluginContext,
  type RuntimePlugin,
  type RuntimePluginToolCall,
  type RuntimePluginToolCallResult
} from '../src/plugins/types.ts';
import {
  createRuntimePluginHost
} from '../src/plugins/host.ts';
import {
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent
} from '../src/runtime/event.ts';
import {
  runRoleModelLoop,
  type RoleModelAdapter,
  type RoleModelPluginToolHost
} from '../src/role-model/loop.ts';
import type { RoleModelChatMessage } from '../src/role-model/prompt.ts';

describe('role-model loop plugin tool routing', () => {
  it('rejects non-degrading plugin tool failures before a later visible reply can commit', async () => {
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
              text: 'continued after rejected tool'
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

        return createRejectedToolCallResult({
          call,
          context,
          evidenceStatus: 'rejected',
          policyOutcome: 'handler_rejected'
        });
      }
    });

    const result = await runRoleModelLoop({
      event: createTestEvent('search memory', 'evt_rejected_plugin_tool'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: [memorySearchToolDefinition],
      pluginToolHost,
      runtimePluginContext: createTestPluginContext('evt_rejected_plugin_tool')
    });

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelPluginToolRejectedRejectionReason
      }
    });
    expect(invocations).toBe(1);
    expect(handledCalls).toBe(1);
    expect(result.pluginToolResults).toHaveLength(1);
    expect(result.pluginToolResults[0]).toMatchObject({
      callId: 'evt_rejected_plugin_tool.round-1.1.memory.search',
      call: {
        pluginId: 'memory.search.fixture',
        toolName: 'memory.search'
      },
      result: {
        status: 'rejected',
        reason: 'handler_failed'
      }
    });
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]?.pluginToolResults).toHaveLength(1);
  });

  it('rejects required plugin tool failures despite misleading degraded evidence', async () => {
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
              text: 'continued after required tool failed'
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
      event: createTestEvent('search memory', 'evt_required_plugin_tool'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: [requiredMemorySearchToolDefinition],
      pluginToolHost,
      runtimePluginContext: createTestPluginContext('evt_required_plugin_tool')
    });

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelPluginToolRejectedRejectionReason
      }
    });
    expect(invocations).toBe(1);
    expect(result.pluginToolResults[0]?.result.evidence).toMatchObject([
      {
        status: 'degraded',
        policyOutcome: 'optional_degraded'
      }
    ]);
  });

  it('rejects handler failures when rejected evidence accompanies degraded evidence', async () => {
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
              text: 'continued after handler rejected'
            }
          }
        ]
      }
    ], () => {
      invocations += 1;
    });
    const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
      handleToolCall(call, context) {
        return createRejectedToolCallResultWithEvidence({
          call,
          context,
          evidence: [
            {
              status: 'degraded',
              policyOutcome: 'optional_degraded'
            },
            {
              status: 'rejected',
              policyOutcome: 'handler_rejected'
            }
          ]
        });
      }
    });

    const result = await runRoleModelLoop({
      event: createTestEvent('search memory', 'evt_handler_rejected_plugin_tool'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: [memorySearchToolDefinition],
      pluginToolHost,
      runtimePluginContext: createTestPluginContext(
        'evt_handler_rejected_plugin_tool'
      )
    });

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelPluginToolRejectedRejectionReason
      }
    });
    expect(invocations).toBe(1);
    expect(result.pluginToolResults[0]?.result.evidence).toMatchObject([
      {
        status: 'degraded',
        policyOutcome: 'optional_degraded'
      },
      {
        status: 'rejected',
        policyOutcome: 'handler_rejected'
      }
    ]);
  });

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
      pluginToolDefinitions: [memorySearchToolDefinition],
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
    const pluginToolHost = createRuntimePluginHost({
      plugins: [createDegradingRejectedMemorySearchPlugin()]
    });

    const result = await runRoleModelLoop({
      event: createTestEvent('search memory', 'evt_host_degraded_plugin_tool'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: pluginToolHost.pluginToolDefinitions(),
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
        pluginToolDefinitions: [memorySearchToolDefinition],
        pluginToolHost,
        runtimePluginContext: createTestPluginContext(eventId)
      });

      expect(result).toMatchObject({
        status: 'rejected',
        rejection: {
          reason: roleModelPluginToolRejectedRejectionReason
        }
      });
      expect(invocations).toBe(1);
      expect(handledCalls).toBe(1);
      expect(result.pluginToolResults).toHaveLength(1);
      expect(result.pluginToolResults[0]).toMatchObject({
        callId: `${eventId}.round-1.1.memory.search`,
        result: {
          status: 'rejected',
          reason: 'invalid_tool_output',
          message: 'Plugin tool output must be finite JSON.'
        }
      });
      expect(result.rounds).toHaveLength(1);
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
      pluginToolDefinitions: [memorySearchToolDefinition],
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
          reason: 'handler_failed',
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
      pluginToolDefinitions: [memorySearchToolDefinition],
      pluginToolHost,
      runtimePluginContext: createTestPluginContext(
        'evt_custom_host_secret_reject'
      ),
      onPluginToolCallCompleted(event) {
        completedResults.push(event.result);
      }
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') {
      throw new Error('Expected custom host rejection to reject the loop.');
    }

    expect(result.rejection).toMatchObject({
      reason: roleModelPluginToolRejectedRejectionReason,
      details:
        'Plugin tool "memory.search" rejected the tool call: search backend failed api_key=[redacted] Bearer [redacted]'
    });
    expect(result.pluginToolResults).toMatchObject([
      {
        result: {
          status: 'rejected',
          reason: 'handler_failed',
          message:
            'search backend failed api_key=[redacted] Bearer [redacted]'
        }
      }
    ]);
    expect(invocations).toBe(1);
    expect(completedResults).toMatchObject([
      {
        status: 'rejected',
        message: 'search backend failed api_key=[redacted] Bearer [redacted]'
      }
    ]);

    const serializedSurfaces = JSON.stringify({
      completedResults,
      pluginToolResults: result.pluginToolResults,
      rejection: result.rejection
    });

    expect(serializedSurfaces).not.toContain('super-secret');
    expect(serializedSurfaces).not.toContain('secret-token');
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
      pluginToolDefinitions: [requiredMemorySearchToolDefinition],
      pluginToolHost,
      runtimePluginContext: createTestPluginContext('evt_required_observed')
    });

    expect(result.status).toBe('accepted');
    expect(invocations).toBe(2);
    expect(handledCalls).toBe(1);
    expect(result.pluginToolResults).toHaveLength(1);
    expect(result.rounds).toHaveLength(2);
  });

  it('rejects plugin tool repeats across rounds against maxCallsPerUserTurn', async () => {
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
      pluginToolDefinitions: [memorySearchToolDefinition],
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

    expect(result.rejection.details).toContain('maxCallsPerUserTurn is 1');
    expect(invocations).toBe(2);
    expect(handledCalls).toBe(1);
    expect(result.pluginToolResults).toHaveLength(1);
    expect(result.rounds).toHaveLength(2);
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
});

const memorySearchToolDefinition = Object.freeze({
  pluginId: 'memory.search.fixture',
  name: 'memory.search',
  description: 'Search memory.',
  requiredForUserTurn: false,
  maxCallsPerUserTurn: 1,
  inputContract: {
    type: 'object',
    fields: [
      {
        name: 'query',
        description: 'Search query.',
        required: true
      }
    ],
    additionalFields: false
  },
  validationOwner: 'plugin_host',
  sideEffectLevel: 'runtime_read',
  requiresConfirmation: false,
  sourceReferencesRequired: false
} satisfies RoleModelPluginToolDefinition);

const requiredMemorySearchToolDefinition = Object.freeze({
  ...memorySearchToolDefinition,
  requiredForUserTurn: true
} satisfies RoleModelPluginToolDefinition);

function createDegradingRejectedMemorySearchPlugin(): RuntimePlugin {
  const id = 'memory.search.fixture';

  return createRuntimePlugin({
    manifest: {
      id,
      displayName: 'Memory Search Fixture',
      version: '1.0.0',
      kind: 'memory_provider',
      description: 'Search memory.',
      contractVersion: runtimePluginContractVersion,
      compatibility: {
        hostContractVersions: [runtimePluginContractVersion],
        sourceSystem: 'test'
      },
      declaredPlugins: ['tool_provider', 'handle_tool_call'],
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
        defaultEnabled: true,
        reasons: ['test']
      },
      requestedApis: []
    },
    providedTools: [
      {
        name: 'memory.search',
        description: 'Search memory.',
        requiredForUserTurn: false,
        maxCallsPerUserTurn: 1,
        inputContract: {
          type: 'object',
          fields: [
            {
              name: 'query',
              description: 'Search query.',
              required: true
            }
          ],
          additionalFields: false
        },
        validationOwner: 'plugin_host',
        sideEffectLevel: 'runtime_read',
        requiresConfirmation: false,
        sourceReferencesRequired: false
      }
    ],
    lifecycleHooks: {
      handleToolCall() {
        return {
          status: 'rejected',
          reason: 'handler_rejected',
          message: 'search backend degraded',
          evidence: []
        };
      }
    }
  });
}

function createSequencedAdapter(
  decisions: readonly Readonly<Record<string, unknown>>[],
  onInvoke: () => void
): RoleModelAdapter {
  let index = 0;

  return Object.freeze({
    invoke() {
      const decision = decisions[index] ?? decisions.at(-1);

      if (decision === undefined) {
        throw new Error('Sequenced adapter needs at least one decision.');
      }

      index += 1;
      onInvoke();

      return {
        rawOutputText: JSON.stringify(decision)
      };
    }
  } satisfies RoleModelAdapter);
}

function createProviderMetadataAdapter(
  providerMetadata: RoleModelProviderMetadata
): RoleModelAdapter {
  return Object.freeze({
    invoke() {
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
        providerMetadata
      };
    }
  } satisfies RoleModelAdapter);
}

function createAcceptedToolCallResult(): RuntimePluginToolCallResult {
  return Object.freeze({
    status: 'accepted',
    output: Object.freeze({
      ok: true
    }),
    evidence: Object.freeze([])
  } satisfies RuntimePluginToolCallResult);
}

function createRejectedToolCallResult(options: {
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly evidenceStatus: 'rejected' | 'degraded';
  readonly policyOutcome: 'handler_rejected' | 'optional_degraded';
}): RuntimePluginToolCallResult {
  return createRejectedToolCallResultWithEvidence({
    call: options.call,
    context: options.context,
    evidence: [
      {
        status: options.evidenceStatus,
        policyOutcome: options.policyOutcome
      }
    ]
  });
}

function createRejectedToolCallResultWithEvidence(options: {
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly evidence: readonly {
    readonly status: 'rejected' | 'degraded';
    readonly policyOutcome: 'handler_rejected' | 'optional_degraded';
  }[];
}): RuntimePluginToolCallResult {
  return Object.freeze({
    status: 'rejected',
    reason: 'handler_failed',
    message: 'search backend failed',
    evidence: options.evidence.map((evidence) =>
      createRuntimePluginEvidenceSnapshot({
        eventId: options.context.eventId,
        traceId: options.context.traceId,
        createdAt: options.context.timestamp,
        kind: 'runtime_plugin_evidence_snapshot',
        pluginId: options.call.pluginId,
        evidenceKind: 'tool_invocation',
        status: evidence.status,
        summary: 'search backend failed',
        policyOutcome: evidence.policyOutcome,
        redactionLabels: []
      })
    )
  } satisfies RuntimePluginToolCallResult);
}

function createTestDecisionContext() {
  return createDecisionContext({
    sessionId: 'session-loop',
    characterSnapshot: {
      id: 'mira',
      displayName: 'Mira'
    }
  });
}

function createTestPluginContext(eventId: string): RuntimePluginContext {
  return createRuntimePluginContext({
    ...createRuntimeEventIdentity({
      eventId,
      traceId: `trace_${eventId}`,
      createdAt: '2026-06-15T00:00:00.000Z'
    }),
    sessionId: 'session-loop',
    eventType: 'USER_MESSAGE',
    currentUserMessage: 'search memory',
    character: {
      id: 'mira',
      displayName: 'Mira'
    }
  });
}

function createTestEvent(message: string, eventId: string) {
  return createUserMessageRuntimeEvent(
    message,
    createRuntimeEventIdentity({
      eventId,
      traceId: `trace_${eventId}`,
      createdAt: '2026-06-15T00:00:00.000Z'
    })
  );
}
