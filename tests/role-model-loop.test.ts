import { describe, expect, it } from 'vitest';

import {
  createDefaultRoleModelPluginToolDefinitions,
  createDecisionContext,
  createRoleModelInputEnvelope,
  isRoleModelRawOutputReplayableDecisionEvidence,
  roleModelDisallowedToolRejectionReason,
  roleModelDuplicateToolCallRejectionReason,
  roleModelMalformedOutputRejectionReason,
  roleModelTerminalEmptyOutputRejectionDetails,
  type RoleModelPluginToolDefinition,
  type RoleModelProviderExchangeSnapshot,
  type RoleModelProviderMetadata
} from '../src/role-model/contracts.ts';
import {
  createRuntimePlugin,
  createRuntimePluginContext,
  createRuntimePluginEvidenceSnapshot,
  type RuntimePluginContext,
  type RuntimePlugin,
  type RuntimePluginToolCall,
  type RuntimePluginToolCallResult
} from '../src/plugins/validation.ts';
import { runtimePluginContractVersion } from '../src/plugins/contract.ts';
import {
  createRuntimePluginHost
} from '../src/plugins/host.ts';
import {
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent
} from '../src/runtime/event.ts';
import {
  createRoleModelAdapterFromCharacterAgent,
  runRoleModelLoop,
  type RoleModelAdapter,
  type RoleModelPluginToolHost
} from '../src/role-model/loop.ts';
import {
  createRoleModelProviderToolNameMappings,
  defaultRoleModelProviderCapabilities,
  renderRoleModelTurnContext,
  type RoleModelAssistantChatMessage,
  type RoleModelChatMessage
} from '../src/role-model/prompt.ts';
import { visibleReplyModelToolName } from '../src/role-model/model-tools.ts';

describe('role-model loop plugin tool routing', () => {
  it('keeps character-agent replies non-committed when visible_reply is unavailable', async () => {
    const adapter = createRoleModelAdapterFromCharacterAgent({
      reply() {
        return {
          text: 'Character agent reply.'
        };
      }
    });
    const event = createTestEvent(
      'hello',
      'evt_character_agent_no_visible_reply'
    );
    const inputEnvelope = createRoleModelInputEnvelope({
      event,
      decisionContext: createTestDecisionContext(),
      pluginToolDefinitions: []
    });
    const output = await adapter.invoke(inputEnvelope, {
      turnContext: renderRoleModelTurnContext(inputEnvelope)
    });

    expect(JSON.parse(output.rawOutputText)).toEqual({
      toolCalls: [],
      text: 'Character agent reply.'
    });
  });

  it('keeps an explicit empty tool set authoritative through prompt and output validation', async () => {
    let renderedToolNames: readonly string[] = [];
    let protocol = '';
    const adapter: RoleModelAdapter = Object.freeze({
      invoke(_inputEnvelope, invocation) {
        renderedToolNames = invocation.turnContext.tools.map(
          (tool) => tool.function.name
        );
        protocol =
          invocation.turnContext.frames.find(
            (frame) => frame.kind === 'developer_protocol'
          )?.content ?? '';

        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {
                name: 'visible_reply',
                input: {
                  text: 'should not be accepted'
                }
              }
            ]
          })
        };
      }
    });

    const result = await runRoleModelLoop({
      event: createTestEvent('hello', 'evt_explicit_empty_tools'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: []
    });

    expect(renderedToolNames).toEqual([]);
    expect(protocol).not.toContain(
      'Commit user-visible text by calling visible_reply.'
    );
    expect(protocol).not.toContain(
      'call visible_reply with the final response'
    );
    expect(protocol).toContain(
      'Terminal assistant content is non-committed model text and is not shown to the user.'
    );
    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: 'disallowed_tool'
      }
    });
  });

  it('derives requested tool names for a replayable live adapter rejection', async () => {
    const details = 'Decision requested disallowed tool visible_reply.';
    const result = await runRoleModelLoop({
      event: createTestEvent('hello', 'evt_live_replayable_rejection'),
      decisionContext: createTestDecisionContext(),
      pluginToolDefinitions: [],
      adapter: Object.freeze({
        invoke() {
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: visibleReplyModelToolName,
                  input: {
                    text: 'not allowed'
                  }
                }
              ]
            }),
            rejection: {
              reason: roleModelDisallowedToolRejectionReason,
              details
            }
          };
        }
      } satisfies RoleModelAdapter)
    });

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelDisallowedToolRejectionReason,
        details
      },
      decisionResult: {
        status: 'rejected',
        requestedToolNames: [visibleReplyModelToolName]
      }
    });
    expect(
      isRoleModelRawOutputReplayableDecisionEvidence({
        rawOutputText: result.ioSnapshot.rawOutputText,
        providerMetadata: result.ioSnapshot.providerMetadata,
        decisionResult: result.decisionResult,
        allowedTools: result.inputEnvelope.allowedTools,
        pluginToolDefinitions: result.inputEnvelope.pluginToolDefinitions,
        toolObservations: result.inputEnvelope.toolObservations
      })
    ).toBe(true);
  });

  it('accepts terminal content as non-committed text when visible_reply is unavailable', async () => {
    const result = await runRoleModelLoop({
      event: createTestEvent('hello', 'evt_no_visible_terminal_text'),
      decisionContext: createTestDecisionContext(),
      pluginToolDefinitions: [],
      adapter: Object.freeze({
        invoke() {
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [],
              text: 'Internal terminal model text.'
            })
          };
        }
      })
    });

    expect(result).toMatchObject({
      status: 'accepted',
      decisionResult: {
        status: 'accepted',
        nonCommittedText: 'Internal terminal model text.',
        decision: {
          toolCalls: []
        }
      }
    });
  });

  it('does not route a defined plugin tool omitted from allowedTools', async () => {
    let handledCalls = 0;
    const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
      handleToolCall() {
        handledCalls += 1;
        return createAcceptedToolCallResult();
      }
    });

    const result = await runRoleModelLoop({
      event: createTestEvent('search memory', 'evt_disallowed_memory_search'),
      decisionContext: createTestDecisionContext(),
      allowedTools: [visibleReplyModelToolName],
      pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
      pluginToolHost,
      runtimePluginContext: createTestPluginContext(
        'evt_disallowed_memory_search'
      ),
      adapter: createSequencedAdapter([
        {
          toolCalls: [
            {
              name: 'memory.search',
              input: {
                query: 'Mira'
              }
            }
          ]
        }
      ], () => undefined)
    });

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: 'disallowed_tool',
        details: 'Decision requested disallowed tool memory.search.'
      }
    });
    expect(handledCalls).toBe(0);
    expect(result.pluginToolResults).toEqual([]);
  });

  it('drops native tool history when its arguments differ from the accepted decision', async () => {
    let invocationCount = 0;
    let handledCalls = 0;
    const messagesByRound: RoleModelChatMessage[][] = [];
    const adapter: RoleModelAdapter = Object.freeze({
      invoke(_inputEnvelope, invocation) {
        invocationCount += 1;
        messagesByRound.push([...invocation.turnContext.messages]);

        if (invocationCount === 1) {
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
                  id: 'call_memory_search',
                  type: 'function',
                  function: {
                    name: 'memory.search',
                    arguments: '{"query":"Another character"}'
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
    });
    const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
      handleToolCall() {
        handledCalls += 1;
        return createAcceptedToolCallResult();
      }
    });

    const result = await runRoleModelLoop({
      event: createTestEvent('search memory', 'evt_native_argument_mismatch'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
      pluginToolHost,
      runtimePluginContext: createTestPluginContext(
        'evt_native_argument_mismatch'
      )
    });

    expect(result.status).toBe('accepted');
    expect(handledCalls).toBe(1);
    expect(messagesByRound).toHaveLength(2);
    expect(
      messagesByRound[1]?.some(
        (message) => message.role === 'assistant' || message.role === 'tool'
      )
    ).toBe(false);
  });

  it('retains aligned native history after provider tool-name normalization', async () => {
    let invocationCount = 0;
    const messagesByRound: RoleModelChatMessage[][] = [];
    const adapter: RoleModelAdapter = Object.freeze({
      invoke(_inputEnvelope, invocation) {
        invocationCount += 1;
        messagesByRound.push([...invocation.turnContext.messages]);

        if (invocationCount === 1) {
          const nativeAssistantMessage = Object.freeze({
            role: 'assistant',
            content: 'Searching memory.',
            tool_calls: Object.freeze([
              {
                id: 'call_provider_memory_search',
                type: 'function',
                function: {
                  name: 'memory_search',
                  arguments: '{"query":"Mira"}'
                }
              }
            ])
          } satisfies RoleModelAssistantChatMessage);
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
            toolNameMappings: [
              {
                runtimeName: 'memory.search',
                providerName: 'memory_search'
              }
            ],
            requestBody: {},
            nativeAssistantMessage,
            nativeToolResultMessages: []
          };

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
            nativeAssistantMessage,
            providerExchange
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
    });

    const result = await runRoleModelLoop({
      event: createTestEvent('search memory', 'evt_provider_name_mapping'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
      pluginToolHost: Object.freeze({
        handleToolCall() {
          return createAcceptedToolCallResult();
        }
      }),
      runtimePluginContext: createTestPluginContext(
        'evt_provider_name_mapping'
      )
    });

    expect(result.status).toBe('accepted');
    const assistantHistoryMessage = messagesByRound[1]?.find(
      (message) => message.role === 'assistant'
    );
    const toolHistoryMessage = messagesByRound[1]?.find(
      (message) => message.role === 'tool'
    );

    expect(assistantHistoryMessage).toMatchObject({
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_provider_memory_search',
          function: {
            name: 'memory_search'
          }
        }
      ]
    });
    expect(toolHistoryMessage).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_provider_memory_search'
    });
  });

  it('classifies colliding provider tool names by their runtime mappings', async () => {
    let invocationCount = 0;
    const messagesByRound: RoleModelChatMessage[][] = [];
    const adapter: RoleModelAdapter = Object.freeze({
      invoke(_inputEnvelope, invocation) {
        invocationCount += 1;
        messagesByRound.push([...invocation.turnContext.messages]);

        if (invocationCount === 1) {
          const toolNameMappings = createRoleModelProviderToolNameMappings(
            invocation.turnContext.tools.map((tool) => tool.function.name)
          );
          const nativeAssistantMessage = Object.freeze({
            role: 'assistant',
            content: 'Checking the mapped tool.',
            tool_calls: Object.freeze([
              {
                id: 'call_executable_visible_reply',
                type: 'function',
                function: {
                  name: 'visible_reply',
                  arguments: '{"query":"Mira"}'
                }
              },
              {
                id: 'call_terminal_visible_reply',
                type: 'function',
                function: {
                  name: 'visible_reply_2',
                  arguments: '{"text":"Checking."}'
                }
              }
            ])
          } satisfies RoleModelAssistantChatMessage);
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
            toolNameMappings,
            requestBody: {},
            nativeAssistantMessage,
            nativeToolResultMessages: []
          };

          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'visible.reply',
                  input: {
                    query: 'Mira'
                  }
                },
                {
                  name: visibleReplyModelToolName,
                  input: {
                    text: 'Checking.'
                  }
                }
              ]
            }),
            nativeAssistantMessage,
            providerExchange
          };
        }

        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {
                name: visibleReplyModelToolName,
                input: {
                  text: 'Finished.'
                }
              }
            ]
          })
        };
      }
    });

    const result = await runRoleModelLoop({
      event: createTestEvent('use colliding tools', 'evt_provider_name_collision'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: Object.freeze([
        visibleDotReplyToolDefinition,
        ...createDefaultRoleModelPluginToolDefinitions()
      ]),
      pluginToolHost: Object.freeze({
        handleToolCall() {
          return Object.freeze({
            status: 'accepted',
            output: Object.freeze({
              kind: 'plugin_output'
            }),
            evidence: Object.freeze([])
          });
        }
      }),
      runtimePluginContext: createTestPluginContext(
        'evt_provider_name_collision'
      )
    });

    expect(result.status).toBe('accepted');
    const executableResultMessage = messagesByRound[1]?.find(
      (message) =>
        message.role === 'tool' &&
        message.tool_call_id === 'call_executable_visible_reply'
    );
    const visibleReplyResultMessage = messagesByRound[1]?.find(
      (message) =>
        message.role === 'tool' &&
        message.tool_call_id === 'call_terminal_visible_reply'
    );

    expect(
      executableResultMessage?.role === 'tool'
        ? parseTestJson(executableResultMessage.content)
        : undefined
    ).toMatchObject({
      status: 'accepted',
      toolName: 'visible.reply',
      output: {
        kind: 'plugin_output'
      }
    });
    expect(
      visibleReplyResultMessage?.role === 'tool'
        ? parseTestJson(visibleReplyResultMessage.content)
        : undefined
    ).toMatchObject({
      status: 'accepted',
      toolName: visibleReplyModelToolName,
      output: {
        kind: 'interim_visible_reply'
      }
    });
  });

  it.each([
    {
      label: 'the tool name differs',
      rawToolCalls: [
        {
          name: 'memory.search',
          input: {
            query: 'Mira'
          }
        }
      ],
      nativeToolCalls: [
        {
          id: 'call_wrong_name',
          type: 'function' as const,
          function: {
            name: 'memory.recall',
            arguments: '{"query":"Mira"}'
          }
        }
      ]
    },
    {
      label: 'the executable order differs',
      rawToolCalls: [
        {
          name: 'memory.search',
          input: {
            query: 'Mira'
          }
        },
        {
          name: 'memory.recall',
          input: {
            query: 'Mira'
          }
        }
      ],
      nativeToolCalls: [
        {
          id: 'call_memory_recall_first',
          type: 'function' as const,
          function: {
            name: 'memory.recall',
            arguments: '{"query":"Mira"}'
          }
        },
        {
          id: 'call_memory_search_second',
          type: 'function' as const,
          function: {
            name: 'memory.search',
            arguments: '{"query":"Mira"}'
          }
        }
      ]
    },
    {
      label: 'tool-call IDs are duplicated',
      rawToolCalls: [
        {
          name: 'memory.search',
          input: {
            query: 'Mira'
          }
        },
        {
          name: 'memory.recall',
          input: {
            query: 'Mira'
          }
        }
      ],
      nativeToolCalls: [
        {
          id: 'call_duplicate',
          type: 'function' as const,
          function: {
            name: 'memory.search',
            arguments: '{"query":"Mira"}'
          }
        },
        {
          id: 'call_duplicate',
          type: 'function' as const,
          function: {
            name: 'memory.recall',
            arguments: '{"query":"Mira"}'
          }
        }
      ]
    }
  ])('drops native tool history when $label', async ({
    rawToolCalls,
    nativeToolCalls
  }) => {
    let invocationCount = 0;
    let handledCalls = 0;
    const messagesByRound: RoleModelChatMessage[][] = [];
    const adapter: RoleModelAdapter = Object.freeze({
      invoke(_inputEnvelope, invocation) {
        invocationCount += 1;
        messagesByRound.push([...invocation.turnContext.messages]);

        return invocationCount === 1
          ? {
              rawOutputText: JSON.stringify({ toolCalls: rawToolCalls }),
              nativeAssistantMessage: {
                role: 'assistant',
                content: 'Using tools.',
                tool_calls: nativeToolCalls
              }
            }
          : {
              rawOutputText: JSON.stringify({
                toolCalls: [
                  {
                    name: 'visible_reply',
                    input: {
                      text: 'tools checked'
                    }
                  }
                ]
              })
            };
      }
    });
    const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
      handleToolCall() {
        handledCalls += 1;
        return createAcceptedToolCallResult();
      }
    });

    const result = await runRoleModelLoop({
      event: createTestEvent('use tools', 'evt_native_history_mismatch'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: Object.freeze([
        ...withVisibleReplyTool(memorySearchToolDefinition),
        memoryRecallToolDefinition
      ]),
      pluginToolHost,
      runtimePluginContext: createTestPluginContext(
        'evt_native_history_mismatch'
      )
    });

    expect(result.status).toBe('accepted');
    expect(handledCalls).toBe(rawToolCalls.length);
    expect(
      messagesByRound[1]?.some(
        (message) => message.role === 'assistant' || message.role === 'tool'
      )
    ).toBe(false);
  });

  it('continues after non-degrading plugin tool failures', async () => {
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
      pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
      pluginToolHost,
      runtimePluginContext: createTestPluginContext('evt_rejected_plugin_tool')
    });

    expect(result).toMatchObject({
      status: 'accepted'
    });
    expect(invocations).toBe(2);
    expect(handledCalls).toBe(1);
    expect(result.pluginToolResults).toHaveLength(1);
    expect(result.pluginToolResults[0]).toMatchObject({
      callId:
        'evt_rejected_plugin_tool.trace_evt_rejected_plugin_tool.round-1.1.memory.search',
      dispatchedToHost: true,
      call: {
        pluginId: 'memory.search.fixture',
        toolName: 'memory.search'
      },
      result: {
        status: 'rejected',
        reason: 'handler_failed'
      }
    });
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]?.pluginToolResults).toHaveLength(1);
  });

  it('marks missing-host routing as not dispatched to the host', async () => {
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
              text: 'continued without a tool host'
            }
          }
        ]
      }
    ], () => undefined);

    const result = await runRoleModelLoop({
      event: createTestEvent('search memory', 'evt_missing_plugin_tool_host'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
      runtimePluginContext: createTestPluginContext(
        'evt_missing_plugin_tool_host'
      ),
      onPluginToolCallCompleted(event) {
        completedDispatchSignals.push(event.dispatchedToHost);
      }
    });

    expect(result.status).toBe('accepted');
    expect(result.pluginToolResults).toMatchObject([
      {
        dispatchedToHost: false,
        result: {
          status: 'rejected',
          reason: 'tool_host_missing'
        }
      }
    ]);
    expect(completedDispatchSignals).toEqual([false]);
  });

  it('scopes plugin tool call IDs by trace identity when eventId is reused', async () => {
    async function runWithTrace(traceId: string): Promise<string | undefined> {
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
      ], () => undefined);
      const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
        handleToolCall() {
          return createAcceptedToolCallResult();
        }
      });

      const result = await runRoleModelLoop({
        event: createTestEvent(
          'search memory',
          'evt_replayed_tool_call',
          traceId
        ),
        decisionContext: createTestDecisionContext(),
        adapter,
        pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
        pluginToolHost,
        runtimePluginContext: createTestPluginContext(
          'evt_replayed_tool_call',
          traceId
        )
      });

      expect(result.status).toBe('accepted');

      return result.pluginToolResults[0]?.callId;
    }

    const firstCallId = await runWithTrace('trace_retry_first');
    const secondCallId = await runWithTrace('trace_retry_second');

    expect(firstCallId).toBe(
      'evt_replayed_tool_call.trace_retry_first.round-1.1.memory.search'
    );
    expect(secondCallId).toBe(
      'evt_replayed_tool_call.trace_retry_second.round-1.1.memory.search'
    );
    expect(firstCallId).not.toBe(secondCallId);
  });

  it('requires a successful required plugin tool result before final output', async () => {
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
      pluginToolDefinitions: withVisibleReplyTool(requiredMemorySearchToolDefinition),
      pluginToolHost,
      runtimePluginContext: createTestPluginContext('evt_required_plugin_tool')
    });

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: 'missing_required_tool_call'
      }
    });
    expect(invocations).toBe(2);
    expect(result.pluginToolResults[0]?.result.evidence).toMatchObject([
      {
        status: 'degraded',
        policyOutcome: 'optional_degraded'
      }
    ]);
  });

  it('continues after handler failures with rejected evidence', async () => {
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
      pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
      pluginToolHost,
      runtimePluginContext: createTestPluginContext(
        'evt_handler_rejected_plugin_tool'
      )
    });

    expect(result).toMatchObject({
      status: 'accepted'
    });
    expect(invocations).toBe(2);
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
          reason: 'handler_failed',
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
});

const memorySearchToolDefinition = Object.freeze({
  pluginId: 'memory.search.fixture',
  name: 'memory.search',
  description: 'Search memory.',
  requiredForUserTurn: false,
  callLimit: {
    scope: 'user_turn',
    maxCalls: 1
  },
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

const memoryRecallToolDefinition = Object.freeze({
  ...memorySearchToolDefinition,
  name: 'memory.recall',
  description: 'Recall memory.'
} satisfies RoleModelPluginToolDefinition);

const visibleDotReplyToolDefinition = Object.freeze({
  ...memorySearchToolDefinition,
  pluginId: 'visible.reply.fixture',
  name: 'visible.reply',
  description: 'Exercise a provider-name collision with visible_reply.'
} satisfies RoleModelPluginToolDefinition);

function withVisibleReplyTool(
  definition: RoleModelPluginToolDefinition
): readonly RoleModelPluginToolDefinition[] {
  return Object.freeze([
    ...createDefaultRoleModelPluginToolDefinitions(),
    definition
  ]);
}

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
      requestedAccess: { model_input: 'write' }
    },
    providedTools: [
      {
        name: 'memory.search',
        description: 'Search memory.',
        requiredForUserTurn: false,
        callLimit: {
          scope: 'user_turn',
          maxCalls: 1
        },
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

function createAcceptedToolCallResultWithBlockingEvidence(options: {
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly evidenceStatus: 'rejected' | 'failed';
}): RuntimePluginToolCallResult {
  return Object.freeze({
    status: 'accepted',
    output: Object.freeze({
      ok: true
    }),
    evidence: Object.freeze([
      createRuntimePluginEvidenceSnapshot({
        eventId: options.context.eventId,
        traceId: options.context.traceId,
        createdAt: options.context.timestamp,
        kind: 'runtime_plugin_evidence_snapshot',
        pluginId: options.call.pluginId,
        evidenceKind: 'tool_invocation',
        status: options.evidenceStatus,
        summary: 'search backend failed',
        policyOutcome:
          options.evidenceStatus === 'failed' ? 'timeout' : 'handler_rejected',
        redactionLabels: []
      })
    ])
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

function createTestPluginContext(
  eventId: string,
  traceId = `trace_${eventId}`
): RuntimePluginContext {
  return createRuntimePluginContext({
    ...createRuntimeEventIdentity({
      eventId,
      traceId,
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

function createTestEvent(
  message: string,
  eventId: string,
  traceId = `trace_${eventId}`
) {
  return createUserMessageRuntimeEvent(
    message,
    createRuntimeEventIdentity({
      eventId,
      traceId,
      createdAt: '2026-06-15T00:00:00.000Z'
    })
  );
}

function parseTestJson(value: string): unknown {
  const parsed: unknown = JSON.parse(value);

  return parsed;
}
