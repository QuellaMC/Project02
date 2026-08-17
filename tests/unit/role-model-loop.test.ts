import {describe, expect, it} from 'vitest';
import {toolProtocolText} from '../../src/role-model/prompt/prompt-text.ts';
import {
  createRoleModelProviderToolNameMappings,
  defaultRoleModelProviderCapabilities,
  type RoleModelAdapter,
  type RoleModelAssistantChatMessage,
  type RoleModelChatMessage,
  type RoleModelPluginToolHost,
  type RoleModelProviderExchangeSnapshot,
  runRoleModelLoop,
  visibleReplyModelToolName,
} from '../../src/role-model/index.ts';
import {
  acceptingPluginToolHost,
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
  toolWithConcurrency,
  visibleDotReplyToolDefinition,
} from '../support/role-model-loop-fixtures.ts';

describe('role-model loop routing and policy', () => {
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid maxToolRounds %s before invoking the adapter',
    async maxToolRounds => {
      let invocations = 0;

      await expect(
        runRoleModelLoop({
          onVisibleReply: () => {},
          event: createTestEvent('hello', 'evt_invalid_max_tool_rounds'),
          decisionContext: createTestDecisionContext(),
          pluginToolDefinitions: [],
          pluginToolHost: acceptingPluginToolHost,
          runtimePluginContext: createTestPluginContext(
            'evt_invalid_max_tool_rounds',
          ),
          maxToolRounds,
          adapter: Object.freeze({
            invoke() {
              invocations += 1;
              return {rawOutputText: ''};
            },
          }),
        }),
      ).rejects.toThrow('maxToolRounds must be a non-negative safe integer.');
      expect(invocations).toBe(0);
    },
  );

  it('offers visible_reply even when no plugin provides a tool', async () => {
    let renderedToolNames: readonly string[] = [];
    let protocol = '';
    const replies: string[] = [];
    const adapter: RoleModelAdapter = Object.freeze({
      invoke(_inputEnvelope, invocation) {
        renderedToolNames = invocation.turnContext.tools.map(
          tool => tool.function.name,
        );
        protocol =
          invocation.turnContext.frames.find(
            frame => frame.kind === 'developer_protocol',
          )?.content ?? '';

        return {
          rawOutputText: JSON.stringify({
            toolCalls: [{name: 'visible_reply', input: {text: 'hello there'}}],
          }),
        };
      },
    });

    const result = await runRoleModelLoop({
      onVisibleReply: event => {
        replies.push(event.text);
      },
      event: createTestEvent('hello', 'evt_no_plugin_tools'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: [],
      pluginToolHost: acceptingPluginToolHost,
      runtimePluginContext: createTestPluginContext('evt_no_plugin_tools'),
    });

    expect(renderedToolNames).toEqual([visibleReplyModelToolName]);
    expect(protocol).toBe(toolProtocolText({supportsParallelToolCalls: true}));
    expect(result.status).toBe('accepted');
    expect(replies).toEqual(['hello there']);
  });

  it('hands a refused reply back to the model for exactly its next round, and records the refused round', async () => {
    const seenMessages: (readonly RoleModelChatMessage[])[] = [];
    let invocations = 0;
    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('hello', 'evt_refused_round_handed_back'),
      decisionContext: createTestDecisionContext(),
      pluginToolDefinitions: [memorySearchToolDefinition],
      pluginToolHost: acceptingPluginToolHost,
      runtimePluginContext: createTestPluginContext(
        'evt_refused_round_handed_back',
      ),
      adapter: createSequencedAdapter(
        [
          {toolCalls: [{name: 'not.a.tool.field', input: 'oops'}]},
          {toolCalls: [{name: 'memory.search', input: {query: 'first'}}]},
          {toolCalls: [{name: visibleReplyModelToolName, input: {text: 'ok'}}]},
        ],
        invocation => {
          invocations += 1;
          seenMessages.push(invocation.turnContext.messages);
        },
      ),
    });

    expect(result.status).toBe('accepted');
    expect(invocations).toBe(3);
    expect(
      result.rounds.map(round => round.parsedDecisionSnapshot.result.status),
    ).toEqual(['rejected', 'accepted', 'accepted']);
    const notesIn = (round: number) =>
      seenMessages[round]?.filter(
        message =>
          message.role === 'system' &&
          message.content.startsWith('Your last reply could not be used.'),
      ) ?? [];

    // The error is simply there in the next round, quoted as data, with
    // nothing about what to do; the round after that no longer carries it.
    expect(notesIn(0)).toHaveLength(0);
    expect(notesIn(1)).toHaveLength(1);
    expect(notesIn(1)[0]?.content).toContain('The runtime said: "');
    expect(notesIn(1)[0]?.content).not.toMatch(/again|correct|retry/iu);
    expect(notesIn(2)).toHaveLength(0);
  });

  it('ends the turn when the rounds run out, or when no usable output arrived at all', async () => {
    let invocations = 0;
    const spent = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('hello', 'evt_rounds_spent'),
      decisionContext: createTestDecisionContext(),
      pluginToolDefinitions: [],
      pluginToolHost: acceptingPluginToolHost,
      runtimePluginContext: createTestPluginContext('evt_rounds_spent'),
      maxToolRounds: 2,
      adapter: Object.freeze({
        invoke() {
          invocations += 1;
          return {rawOutputText: 'still not a decision object'};
        },
      } satisfies RoleModelAdapter),
    });

    expect(spent).toMatchObject({
      status: 'rejected',
      rejection: {reason: 'malformed_output'},
    });
    expect(invocations).toBe(3);
    expect(spent.rounds).toHaveLength(3);

    invocations = 0;
    const providerFailure = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('hello', 'evt_provider_failure'),
      decisionContext: createTestDecisionContext(),
      pluginToolDefinitions: [],
      pluginToolHost: acceptingPluginToolHost,
      runtimePluginContext: createTestPluginContext('evt_provider_failure'),
      adapter: Object.freeze({
        invoke() {
          invocations += 1;
          return {
            rawOutputText: '',
            providerMetadata: {
              provider: 'nvidia',
              error: {code: 'http_error', message: 'upstream 503'},
            },
            rejection: {reason: 'provider_error', details: 'upstream 503'},
          };
        },
      } satisfies RoleModelAdapter),
    });

    // Nothing to hand back: the model wrote nothing.
    expect(providerFailure).toMatchObject({
      status: 'rejected',
      rejection: {reason: 'provider_error', details: 'upstream 503'},
    });
    expect(invocations).toBe(1);
  });

  it('overlaps shared tool calls and keeps observations in call order', async () => {
    const events: string[] = [];
    const searchTool = toolWithConcurrency(
      memorySearchToolDefinition,
      'shared',
    );
    const recallTool = toolWithConcurrency(
      memoryRecallToolDefinition,
      'shared',
    );
    const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
      async handleToolCall(call) {
        events.push(`start:${call.toolName}`);
        await Promise.resolve();
        await Promise.resolve();
        events.push(`end:${call.toolName}`);
        return createAcceptedToolCallResult();
      },
    });

    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('search memory', 'evt_shared_tool_overlap'),
      decisionContext: createTestDecisionContext(),
      pluginToolDefinitions: [searchTool, recallTool],
      pluginToolHost,
      runtimePluginContext: createTestPluginContext('evt_shared_tool_overlap'),
      adapter: createSequencedAdapter(
        [
          {
            toolCalls: [
              {name: 'memory.search', input: {query: 'first'}},
              {name: 'memory.recall', input: {query: 'second'}},
            ],
          },
          {
            toolCalls: [
              {name: visibleReplyModelToolName, input: {text: 'done'}},
            ],
          },
        ],
        () => undefined,
      ),
    });

    expect(result.status).toBe('accepted');
    expect(events.indexOf('start:memory.recall')).toBeLessThan(
      events.indexOf('end:memory.search'),
    );
    // Observations follow the model's call order, not completion order.
    expect(
      result.rounds[0]?.pluginToolResults.map(entry => entry.call.toolName),
    ).toEqual(['memory.search', 'memory.recall']);
  });

  it('reports a finished tool call before its slower sibling settles', async () => {
    // A tool's write is durable when its call returns, so waiting for the batch
    // widens the crash window between the effect and its record.
    const events: string[] = [];
    const fastTool = toolWithConcurrency(memorySearchToolDefinition, 'shared');
    const slowTool = toolWithConcurrency(memoryRecallToolDefinition, 'shared');
    const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
      async handleToolCall(call) {
        if (call.toolName === 'memory.recall') {
          for (let tick = 0; tick < 8; tick += 1) {
            await Promise.resolve();
          }
        }

        events.push(`settled:${call.toolName}`);
        return createAcceptedToolCallResult();
      },
    });

    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('search memory', 'evt_completion_timing'),
      decisionContext: createTestDecisionContext(),
      pluginToolDefinitions: [slowTool, fastTool],
      pluginToolHost,
      runtimePluginContext: createTestPluginContext('evt_completion_timing'),
      onPluginToolCallCompleted: event => {
        events.push(`reported:${event.toolName}`);
      },
      adapter: createSequencedAdapter(
        [
          {
            toolCalls: [
              {name: 'memory.recall', input: {query: 'slow'}},
              {name: 'memory.search', input: {query: 'fast'}},
            ],
          },
          {
            toolCalls: [
              {name: visibleReplyModelToolName, input: {text: 'done'}},
            ],
          },
        ],
        () => undefined,
      ),
    });

    expect(result.status).toBe('accepted');
    expect(events.indexOf('reported:memory.search')).toBeLessThan(
      events.indexOf('settled:memory.recall'),
    );
    expect(
      result.rounds[0]?.pluginToolResults.map(entry => entry.call.toolName),
    ).toEqual(['memory.recall', 'memory.search']);
  });

  it('lets every call finish before a failed report propagates', async () => {
    const events: string[] = [];
    const fastTool = toolWithConcurrency(memorySearchToolDefinition, 'shared');
    const slowTool = toolWithConcurrency(memoryRecallToolDefinition, 'shared');
    const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
      async handleToolCall(call) {
        if (call.toolName === 'memory.recall') {
          await new Promise(resolve => {
            setTimeout(resolve, 25);
          });
        }

        events.push(`settled:${call.toolName}`);
        return createAcceptedToolCallResult();
      },
    });

    await expect(
      runRoleModelLoop({
        onVisibleReply: () => {},
        event: createTestEvent('search memory', 'evt_report_failure'),
        decisionContext: createTestDecisionContext(),
        pluginToolDefinitions: [fastTool, slowTool],
        pluginToolHost,
        runtimePluginContext: createTestPluginContext('evt_report_failure'),
        onPluginToolCallCompleted: event => {
          if (event.toolName === 'memory.search') {
            throw new Error('could not append finish evidence');
          }
        },
        adapter: createSequencedAdapter(
          [
            {
              toolCalls: [
                {name: 'memory.search', input: {query: 'fast'}},
                {name: 'memory.recall', input: {query: 'slow'}},
              ],
            },
          ],
          () => undefined,
        ),
      }),
    ).rejects.toThrow(/could not append finish evidence/iu);

    // No tool call outlives the turn that owns it.
    expect(events).toContain('settled:memory.recall');
  });

  it('runs an exclusive tool call alone within its batch', async () => {
    const events: string[] = [];
    const searchTool = toolWithConcurrency(
      memorySearchToolDefinition,
      'shared',
    );
    const recallTool = toolWithConcurrency(
      memoryRecallToolDefinition,
      'exclusive',
    );
    const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
      async handleToolCall(call) {
        events.push(`start:${call.toolName}`);
        await Promise.resolve();
        await Promise.resolve();
        events.push(`end:${call.toolName}`);
        return createAcceptedToolCallResult();
      },
    });

    await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('mixed batch', 'evt_exclusive_tool_alone'),
      decisionContext: createTestDecisionContext(),
      pluginToolDefinitions: [searchTool, recallTool],
      pluginToolHost,
      runtimePluginContext: createTestPluginContext('evt_exclusive_tool_alone'),
      adapter: createSequencedAdapter(
        [
          {
            toolCalls: [
              {name: 'memory.search', input: {query: 'first'}},
              {name: 'memory.recall', input: {query: 'second'}},
            ],
          },
          {
            toolCalls: [
              {name: visibleReplyModelToolName, input: {text: 'done'}},
            ],
          },
        ],
        () => undefined,
      ),
    });

    expect(events).toEqual([
      'start:memory.search',
      'end:memory.search',
      'start:memory.recall',
      'end:memory.recall',
    ]);
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
                    query: 'Mira',
                  },
                },
              ],
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
                    arguments: '{"query":"Another character"}',
                  },
                },
              ],
            },
          };
        }

        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {
                name: 'visible_reply',
                input: {
                  text: 'memory checked',
                },
              },
            ],
          }),
        };
      },
    });
    const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
      handleToolCall() {
        handledCalls += 1;
        return createAcceptedToolCallResult();
      },
    });

    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('search memory', 'evt_native_argument_mismatch'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: [memorySearchToolDefinition],
      pluginToolHost,
      runtimePluginContext: createTestPluginContext(
        'evt_native_argument_mismatch',
      ),
    });

    expect(result.status).toBe('accepted');
    expect(handledCalls).toBe(1);
    expect(messagesByRound).toHaveLength(2);
    expect(
      messagesByRound[1]?.some(
        message => message.role === 'assistant' || message.role === 'tool',
      ),
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
                  arguments: '{"query":"Mira"}',
                },
              },
            ]),
          } satisfies RoleModelAssistantChatMessage);
          const providerExchange: RoleModelProviderExchangeSnapshot = {
            provider: {
              name: 'nvidia',
            },
            capabilities: defaultRoleModelProviderCapabilities,
            reasoning: {
              mode: 'enabled',
              params: {},
            },
            renderedMessages: invocation.turnContext.messages,
            renderedTools: invocation.turnContext.tools,
            toolNameMappings: [
              {
                runtimeName: 'memory.search',
                providerName: 'memory_search',
              },
            ],
            requestBody: {},
            nativeAssistantMessage,
            nativeToolResultMessages: [],
          };

          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'memory.search',
                  input: {
                    query: 'Mira',
                  },
                },
              ],
            }),
            nativeAssistantMessage,
            providerExchange,
          };
        }

        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {
                name: 'visible_reply',
                input: {
                  text: 'memory checked',
                },
              },
            ],
          }),
        };
      },
    });

    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('search memory', 'evt_provider_name_mapping'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: [memorySearchToolDefinition],
      pluginToolHost: Object.freeze({
        handleToolCall() {
          return createAcceptedToolCallResult();
        },
      }),
      runtimePluginContext: createTestPluginContext(
        'evt_provider_name_mapping',
      ),
    });

    expect(result.status).toBe('accepted');
    const assistantHistoryMessage = messagesByRound[1]?.find(
      message => message.role === 'assistant',
    );
    const toolHistoryMessage = messagesByRound[1]?.find(
      message => message.role === 'tool',
    );

    expect(assistantHistoryMessage).toMatchObject({
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_provider_memory_search',
          function: {
            name: 'memory_search',
          },
        },
      ],
    });
    expect(toolHistoryMessage).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_provider_memory_search',
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
            invocation.turnContext.tools.map(tool => tool.function.name),
          );
          const nativeAssistantMessage = Object.freeze({
            role: 'assistant',
            content: 'Checking the mapped tool.',
            tool_calls: Object.freeze([
              {
                id: 'call_executable_visible_reply',
                type: 'function',
                function: {
                  name: 'visible_reply_2',
                  arguments: '{"query":"Mira"}',
                },
              },
              {
                id: 'call_terminal_visible_reply',
                type: 'function',
                function: {
                  name: 'visible_reply',
                  arguments: '{"text":"Checking."}',
                },
              },
            ]),
          } satisfies RoleModelAssistantChatMessage);
          const providerExchange: RoleModelProviderExchangeSnapshot = {
            provider: {
              name: 'nvidia',
            },
            capabilities: defaultRoleModelProviderCapabilities,
            reasoning: {
              mode: 'enabled',
              params: {},
            },
            renderedMessages: invocation.turnContext.messages,
            renderedTools: invocation.turnContext.tools,
            toolNameMappings,
            requestBody: {},
            nativeAssistantMessage,
            nativeToolResultMessages: [],
          };

          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'visible.reply',
                  input: {
                    query: 'Mira',
                  },
                },
                {
                  name: visibleReplyModelToolName,
                  input: {
                    text: 'Checking.',
                  },
                },
              ],
            }),
            nativeAssistantMessage,
            providerExchange,
          };
        }

        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {
                name: visibleReplyModelToolName,
                input: {
                  text: 'Finished.',
                },
              },
            ],
          }),
        };
      },
    });

    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent(
        'use colliding tools',
        'evt_provider_name_collision',
      ),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: Object.freeze([visibleDotReplyToolDefinition]),
      pluginToolHost: Object.freeze({
        handleToolCall() {
          return Object.freeze({
            status: 'accepted',
            output: Object.freeze({
              kind: 'plugin_output',
            }),
            evidence: Object.freeze([]),
          });
        },
      }),
      runtimePluginContext: createTestPluginContext(
        'evt_provider_name_collision',
      ),
    });

    expect(result.status).toBe('accepted');
    const executableResultMessage = messagesByRound[1]?.find(
      message =>
        message.role === 'tool' &&
        message.tool_call_id === 'call_executable_visible_reply',
    );
    const visibleReplyResultMessage = messagesByRound[1]?.find(
      message =>
        message.role === 'tool' &&
        message.tool_call_id === 'call_terminal_visible_reply',
    );

    expect(
      executableResultMessage?.role === 'tool'
        ? parseTestJson(executableResultMessage.content)
        : undefined,
    ).toMatchObject({
      status: 'accepted',
      toolName: 'visible.reply',
      output: {
        kind: 'plugin_output',
      },
    });
    expect(
      visibleReplyResultMessage?.role === 'tool'
        ? parseTestJson(visibleReplyResultMessage.content)
        : undefined,
    ).toMatchObject({
      status: 'accepted',
      toolName: visibleReplyModelToolName,
      output: {
        kind: 'visible_reply_delivered',
      },
    });
  });

  it.each([
    {
      label: 'the tool name differs',
      rawToolCalls: [
        {
          name: 'memory.search',
          input: {
            query: 'Mira',
          },
        },
      ],
      nativeToolCalls: [
        {
          id: 'call_wrong_name',
          type: 'function' as const,
          function: {
            name: 'memory.recall',
            arguments: '{"query":"Mira"}',
          },
        },
      ],
    },
    {
      label: 'the executable order differs',
      rawToolCalls: [
        {
          name: 'memory.search',
          input: {
            query: 'Mira',
          },
        },
        {
          name: 'memory.recall',
          input: {
            query: 'Mira',
          },
        },
      ],
      nativeToolCalls: [
        {
          id: 'call_memory_recall_first',
          type: 'function' as const,
          function: {
            name: 'memory.recall',
            arguments: '{"query":"Mira"}',
          },
        },
        {
          id: 'call_memory_search_second',
          type: 'function' as const,
          function: {
            name: 'memory.search',
            arguments: '{"query":"Mira"}',
          },
        },
      ],
    },
    {
      label: 'tool-call IDs are duplicated',
      rawToolCalls: [
        {
          name: 'memory.search',
          input: {
            query: 'Mira',
          },
        },
        {
          name: 'memory.recall',
          input: {
            query: 'Mira',
          },
        },
      ],
      nativeToolCalls: [
        {
          id: 'call_duplicate',
          type: 'function' as const,
          function: {
            name: 'memory.search',
            arguments: '{"query":"Mira"}',
          },
        },
        {
          id: 'call_duplicate',
          type: 'function' as const,
          function: {
            name: 'memory.recall',
            arguments: '{"query":"Mira"}',
          },
        },
      ],
    },
  ])(
    'drops native tool history when $label',
    async ({rawToolCalls, nativeToolCalls}) => {
      let invocationCount = 0;
      let handledCalls = 0;
      const messagesByRound: RoleModelChatMessage[][] = [];
      const adapter: RoleModelAdapter = Object.freeze({
        invoke(_inputEnvelope, invocation) {
          invocationCount += 1;
          messagesByRound.push([...invocation.turnContext.messages]);

          return invocationCount === 1
            ? {
                rawOutputText: JSON.stringify({toolCalls: rawToolCalls}),
                nativeAssistantMessage: {
                  role: 'assistant',
                  content: 'Using tools.',
                  tool_calls: nativeToolCalls,
                },
              }
            : {
                rawOutputText: JSON.stringify({
                  toolCalls: [
                    {
                      name: 'visible_reply',
                      input: {
                        text: 'tools checked',
                      },
                    },
                  ],
                }),
              };
        },
      });
      const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
        handleToolCall() {
          handledCalls += 1;
          return createAcceptedToolCallResult();
        },
      });

      const result = await runRoleModelLoop({
        onVisibleReply: () => {},
        event: createTestEvent('use tools', 'evt_native_history_mismatch'),
        decisionContext: createTestDecisionContext(),
        adapter,
        pluginToolDefinitions: Object.freeze([
          ...[memorySearchToolDefinition],
          memoryRecallToolDefinition,
        ]),
        pluginToolHost,
        runtimePluginContext: createTestPluginContext(
          'evt_native_history_mismatch',
        ),
      });

      expect(result.status).toBe('accepted');
      expect(handledCalls).toBe(rawToolCalls.length);
      expect(
        messagesByRound[1]?.some(
          message => message.role === 'assistant' || message.role === 'tool',
        ),
      ).toBe(false);
    },
  );

  it('continues after non-degrading plugin tool failures', async () => {
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
                text: 'continued after rejected tool',
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
        handledCalls += 1;

        return createRejectedToolCallResult({
          call,
          context,
          evidenceStatus: 'rejected',
          policyOutcome: 'handler_rejected',
        });
      },
    });

    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent('search memory', 'evt_rejected_plugin_tool'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: [memorySearchToolDefinition],
      pluginToolHost,
      runtimePluginContext: createTestPluginContext('evt_rejected_plugin_tool'),
    });

    expect(result).toMatchObject({
      status: 'accepted',
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
        toolName: 'memory.search',
      },
      result: {
        status: 'rejected',
        reason: 'handler_failed',
      },
    });
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]?.pluginToolResults).toHaveLength(1);
  });

  it('routes executable tools through the immutable definition owner', async () => {
    const routedPluginIds: string[] = [];
    const options = {
      onVisibleReply: () => {},
      event: createTestEvent('search memory', 'evt_definition_owned_routing'),
      decisionContext: createTestDecisionContext(),
      adapter: createSequencedAdapter(
        [
          {
            toolCalls: [
              {
                name: 'memory.search',
                input: {query: 'Mira'},
              },
            ],
          },
          {
            toolCalls: [
              {
                name: visibleReplyModelToolName,
                input: {text: 'done'},
              },
            ],
          },
        ],
        () => undefined,
      ),
      pluginToolDefinitions: [memorySearchToolDefinition],
      pluginToolHost: Object.freeze({
        handleToolCall(call) {
          routedPluginIds.push(call.pluginId);
          return createAcceptedToolCallResult();
        },
      } satisfies RoleModelPluginToolHost),
      runtimePluginContext: createTestPluginContext(
        'evt_definition_owned_routing',
      ),
    };

    const result = await runRoleModelLoop(options);

    expect(result.status).toBe('accepted');
    expect(routedPluginIds).toEqual(['memory.search.fixture']);
  });

  it('scopes plugin tool call IDs by trace identity when eventId is reused', async () => {
    async function runWithTrace(traceId: string): Promise<string | undefined> {
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
        () => undefined,
      );
      const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
        handleToolCall() {
          return createAcceptedToolCallResult();
        },
      });

      const result = await runRoleModelLoop({
        onVisibleReply: () => {},
        event: createTestEvent(
          'search memory',
          'evt_replayed_tool_call',
          traceId,
        ),
        decisionContext: createTestDecisionContext(),
        adapter,
        pluginToolDefinitions: [memorySearchToolDefinition],
        pluginToolHost,
        runtimePluginContext: createTestPluginContext(
          'evt_replayed_tool_call',
          traceId,
        ),
      });

      expect(result.status).toBe('accepted');

      return result.pluginToolResults[0]?.callId;
    }

    const firstCallId = await runWithTrace('trace_retry_first');
    const secondCallId = await runWithTrace('trace_retry_second');

    expect(firstCallId).toBe(
      'evt_replayed_tool_call.trace_retry_first.round-1.1.memory.search',
    );
    expect(secondCallId).toBe(
      'evt_replayed_tool_call.trace_retry_second.round-1.1.memory.search',
    );
    expect(firstCallId).not.toBe(secondCallId);
  });

  it('continues after handler failures with rejected evidence', async () => {
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
                text: 'continued after handler rejected',
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
        return createRejectedToolCallResultWithEvidence({
          call,
          context,
          evidence: [
            {
              status: 'degraded',
              policyOutcome: 'optional_degraded',
            },
            {
              status: 'rejected',
              policyOutcome: 'handler_rejected',
            },
          ],
        });
      },
    });

    const result = await runRoleModelLoop({
      onVisibleReply: () => {},
      event: createTestEvent(
        'search memory',
        'evt_handler_rejected_plugin_tool',
      ),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: [memorySearchToolDefinition],
      pluginToolHost,
      runtimePluginContext: createTestPluginContext(
        'evt_handler_rejected_plugin_tool',
      ),
    });

    expect(result).toMatchObject({
      status: 'accepted',
    });
    expect(invocations).toBe(2);
    expect(result.pluginToolResults[0]?.result.evidence).toMatchObject([
      {
        status: 'degraded',
        policyOutcome: 'optional_degraded',
      },
      {
        status: 'rejected',
        policyOutcome: 'handler_rejected',
      },
    ]);
  });
});
