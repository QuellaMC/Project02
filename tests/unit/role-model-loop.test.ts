import { describe, expect, it } from 'vitest';
import {
  createDefaultRoleModelPluginToolDefinitions,
  createRoleModelAdapterFromCharacterAgent,
  createRoleModelInputEnvelope,
  createRoleModelProviderToolNameMappings,
  defaultRoleModelProviderCapabilities,
  isRoleModelRawOutputReplayableDecisionEvidence,
  renderRoleModelTurnContext,
  type RoleModelAdapter,
  type RoleModelAssistantChatMessage,
  type RoleModelChatMessage,
  roleModelDisallowedToolRejectionReason,
  type RoleModelPluginToolHost,
  type RoleModelProviderExchangeSnapshot,
  runRoleModelLoop,
  visibleReplyModelToolName
} from '../../src/role-model/index.ts';
import {
  createAcceptedToolCallResult,
  createRejectedToolCallResult,
  createRejectedToolCallResultWithEvidence,
  createSequencedAdapter,
  createTestDecisionContext,
  createTestEvent,
  createTestPluginContext,
  memoryRecallToolDefinition,
  memorySearchToolDefinition,
  parseTestJson,
  requiredMemorySearchToolDefinition,
  visibleDotReplyToolDefinition,
  withVisibleReplyTool
} from '../support/role-model-loop-fixtures.ts';

describe('role-model loop routing and policy', () => {
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid maxToolRounds %s before invoking the adapter',
    async (maxToolRounds) => {
      let invocations = 0;

      await expect(
        runRoleModelLoop({
          event: createTestEvent('hello', 'evt_invalid_max_tool_rounds'),
          decisionContext: createTestDecisionContext(),
          pluginToolDefinitions: [],
          maxToolRounds,
          adapter: Object.freeze({
            invoke() {
              invocations += 1;
              return { rawOutputText: '' };
            }
          })
        })
      ).rejects.toThrow(
        'maxToolRounds must be a non-negative safe integer.'
      );
      expect(invocations).toBe(0);
    }
  );

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

    const { publicResult: result } = await runRoleModelLoop({
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
    const { publicResult: result } = await runRoleModelLoop({
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
    const { publicResult: result } = await runRoleModelLoop({
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

    const { publicResult: result } = await runRoleModelLoop({
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

    const { publicResult: result } = await runRoleModelLoop({
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

    const { publicResult: result } = await runRoleModelLoop({
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

    const { publicResult: result } = await runRoleModelLoop({
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

    const { publicResult: result } = await runRoleModelLoop({
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

    const { publicResult: result } = await runRoleModelLoop({
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

  it('routes executable tools through the immutable definition owner', async () => {
    const routedPluginIds: string[] = [];
    const options = {
      event: createTestEvent('search memory', 'evt_definition_owned_routing'),
      decisionContext: createTestDecisionContext(),
      adapter: createSequencedAdapter([
        {
          toolCalls: [
            {
              name: 'memory.search',
              input: { query: 'Mira' }
            }
          ]
        },
        {
          toolCalls: [
            {
              name: visibleReplyModelToolName,
              input: { text: 'done' }
            }
          ]
        }
      ], () => undefined),
      pluginToolDefinitions: withVisibleReplyTool(memorySearchToolDefinition),
      pluginToolHost: Object.freeze({
        handleToolCall(call) {
          routedPluginIds.push(call.pluginId);
          return createAcceptedToolCallResult();
        }
      } satisfies RoleModelPluginToolHost),
      runtimePluginContext: createTestPluginContext(
        'evt_definition_owned_routing'
      )
    };

    const { publicResult: result } = await runRoleModelLoop(options);

    expect(result.status).toBe('accepted');
    expect(routedPluginIds).toEqual(['memory.search.fixture']);
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

    const { publicResult: result } = await runRoleModelLoop({
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

      const { publicResult: result } = await runRoleModelLoop({
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

    const { publicResult: result } = await runRoleModelLoop({
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

    const { publicResult: result } = await runRoleModelLoop({
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
});
