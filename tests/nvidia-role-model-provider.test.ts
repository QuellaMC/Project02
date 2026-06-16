import { describe, expect, it } from 'vitest';

import {
  createDecisionContext,
  createRoleModelInputEnvelope,
  type RoleModelPluginToolDefinition
} from '../src/role-model/contracts.ts';
import {
  createNvidiaRoleModelProviderAdapter,
  createNvidiaRoleModelProviderConfigFromEnv,
  nvidiaModelEnvName,
  renderNvidiaMessages,
  renderNvidiaTools,
  type NvidiaFetchClient
} from '../src/role-model/providers/nvidia.ts';
import {
  renderRoleModelTurnContext,
  type RoleModelAssistantChatMessage
} from '../src/role-model/prompt.ts';
import {
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent
} from '../src/runtime/event.ts';
import {
  visibleReplyModelToolName
} from '../src/role-model/model-tools.ts';
import {
  createDefaultProject02PluginHost
} from '../src/plugins/host.ts';
import {
  createRuntimePluginContextItem
} from '../src/plugins/types.ts';

describe('NVIDIA role-model provider', () => {
  it('reads the model name from environment configuration', () => {
    expect(
      createNvidiaRoleModelProviderConfigFromEnv({
        NVIDIA_API_KEY: 'secret',
        [nvidiaModelEnvName]: 'nvidia/test-model'
      }).model
    ).toBe('nvidia/test-model');
  });

  it('redacts credential-bearing custom endpoints in successful provider metadata', async () => {
    const endpoint =
      'https://user:pass@example.test/v1/chat/completions?safe=value&token=endpoint-secret';
    let capturedUrl: string | undefined;
    const fetchClient: NvidiaFetchClient = (url) => {
      capturedUrl = url;

      return Promise.resolve({
        ok: true,
        status: 200,
        json() {
          return Promise.resolve({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: 'Hello.'
                }
              }
            ]
          });
        },
        text() {
          return Promise.resolve('');
        }
      });
    };
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret',
      endpoint,
      fetchClient
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(inputEnvelope, {
      turnContext: renderRoleModelTurnContext(inputEnvelope)
    });

    expect(capturedUrl).toBe(endpoint);
    expect(output.providerMetadata?.request?.endpoint).toBe(
      'https://[redacted]@example.test/v1/chat/completions?safe=value&token=[redacted]'
    );
    expect(JSON.stringify(output.providerMetadata)).not.toContain('user:pass');
    expect(JSON.stringify(output.providerMetadata)).not.toContain(
      'endpoint-secret'
    );
  });

  it('redacts credential-bearing custom endpoints echoed into rejected provider metadata', async () => {
    const endpoint =
      'https://user:pass@example.test/v1/chat/completions?token=endpoint-secret';
    const fetchClient: NvidiaFetchClient = () =>
      Promise.reject(new Error(`connect failed for ${endpoint}`));
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret',
      endpoint,
      fetchClient
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(inputEnvelope, {
      turnContext: renderRoleModelTurnContext(inputEnvelope)
    });
    const serializedMetadata = JSON.stringify(output.providerMetadata);

    expect(output.rejection?.reason).toBe('provider_error');
    expect(output.providerMetadata?.request?.endpoint).toBe(
      'https://[redacted]@example.test/v1/chat/completions?token=[redacted]'
    );
    expect(output.providerMetadata?.error?.message).toBe(
      'connect failed for https://[redacted]@example.test/v1/chat/completions?token=[redacted]'
    );
    expect(serializedMetadata).not.toContain('user:pass');
    expect(serializedMetadata).not.toContain('endpoint-secret');
  });

  it('renders OpenAI-compatible messages and native tools', () => {
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const messages = renderNvidiaMessages(inputEnvelope);
    const tools = renderNvidiaTools(inputEnvelope);

    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user'
    ]);
    expect(messages[0]?.content).toContain(
      'Use OpenAI-compatible chat-completions semantics'
    );
    expect(messages[0]?.content).toContain(
      'tools you, the assistant, can call through the runtime'
    );
    expect(messages[0]?.content).toContain(
      'not commands the user runs'
    );
    expect(messages[0]?.content).toContain(
      'call the plugin inventory tool and use its tool result'
    );
    expect(messages[0]?.content).toContain(
      'not as commands the user should run'
    );
    expect(messages[0]?.content).toContain('Refer to extensions as plugins');
    expect(messages[1]).toMatchObject({
      role: 'user',
      content: 'previous question'
    });
    expect(messages[2]).toMatchObject({
      role: 'assistant',
      content: 'previous answer'
    });
    expect(messages[3]?.content).toContain('hello');
    expect(messages[3]?.content).toContain(
      '<runtime_context hidden_from_user="true">'
    );
    expect(messages[3]?.content).toContain(
      'runtime context is reference data, NOT new user input'
    );
    expect(messages[3]?.content).toContain(
      'Runtime notes:\n- Use concise replies.'
    );
    expect(messages[3]?.content).toContain(
      'Runtime context:\n- Character State: steady'
    );
    expect(messages[3]?.content).toContain('Character State: steady');
    expect(messages[3]?.content).not.toContain('"event"');
    expect(messages[3]?.content).not.toContain('"toolObservations"');
    expect(messages[3]?.content).not.toContain('"version"');
    expect(messages[3]?.content).not.toContain('pluginId');
    expect(messages[3]?.content).not.toContain('sourceReferences');
    expect(messages[3]?.content).not.toContain('confidence');
    expect(messages[3]?.content).not.toContain('budget');
    expect(messages[3]?.content).not.toContain(visibleReplyModelToolName);
    expect(messages[3]?.content).not.toContain('character_state.patch');

    expect(tools.map((tool) => tool.function.name)).toEqual([
      visibleReplyModelToolName,
      'plugin_list',
      'character_state_patch'
    ]);
    expect(tools.every((tool) => /^[A-Za-z][A-Za-z0-9_-]*$/u.test(tool.function.name))).toBe(
      true
    );
    expect(
      tools.find((tool) => tool.function.name === visibleReplyModelToolName)
        ?.function.parameters.properties['text']
    ).toMatchObject({
      type: 'string',
      description: 'The reply text to show to the user.'
    });
    expect(
      tools.find((tool) => tool.function.name === visibleReplyModelToolName)
        ?.function.description
    ).toContain('from you');
    expect(
      tools.find((tool) => tool.function.name === 'plugin_list')
        ?.function.description
    ).toContain('available to you');
    expect(
      tools.find((tool) => tool.function.name === 'character_state_patch')
        ?.function.description
    ).toContain('your current Character State');
    expect(
      tools.find((tool) => tool.function.name === 'plugin_list')
        ?.function.parameters.additionalProperties
    ).toBe(false);
  });

  it('keeps provider tool aliases globally unique for sanitized runtime collisions', async () => {
    let capturedBody: unknown;
    const fetchClient: NvidiaFetchClient = (_url, request) => {
      capturedBody = JSON.parse(request.body);

      return Promise.resolve({
        ok: true,
        status: 200,
        json() {
          return Promise.resolve({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_memory_search_dot',
                      type: 'function',
                      function: {
                        name: 'memory_search',
                        arguments: '{}'
                      }
                    },
                    {
                      id: 'call_memory_search_plain',
                      type: 'function',
                      function: {
                        name: 'memory_search_2',
                        arguments: '{}'
                      }
                    },
                    {
                      id: 'call_memory_search_two',
                      type: 'function',
                      function: {
                        name: 'memory_search_2_2',
                        arguments: '{}'
                      }
                    }
                  ]
                }
              }
            ]
          });
        },
        text() {
          return Promise.resolve('');
        }
      });
    };
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret',
      fetchClient
    });
    const inputEnvelope = createNvidiaAliasCollisionInputEnvelope();
    const output = await adapter.invoke(inputEnvelope, {
      turnContext: renderRoleModelTurnContext(inputEnvelope)
    });

    expect(
      (
        capturedBody as {
          readonly tools?: readonly {
            readonly function: { readonly name: string };
          }[];
        }
      ).tools?.map((tool) => tool.function.name)
    ).toEqual([
      visibleReplyModelToolName,
      'memory_search',
      'memory_search_2',
      'memory_search_2_2'
    ]);
    expect(output.rejection).toBeUndefined();
    expect(JSON.parse(output.rawOutputText)).toEqual({
      toolCalls: [
        {
          name: 'memory.search',
          input: {}
        },
        {
          name: 'memory_search',
          input: {}
        },
        {
          name: 'memory_search_2',
          input: {}
        }
      ]
    });
  });

  it('preserves provider aliases in prior assistant tool-call history', () => {
    const inputEnvelope = createNvidiaAliasCollisionInputEnvelope();
    const priorAssistantMessage = Object.freeze({
      role: 'assistant',
      content: null,
      tool_calls: Object.freeze([
        {
          id: 'call_memory_search_dot',
          type: 'function',
          function: {
            name: 'memory_search',
            arguments: '{}'
          }
        },
        {
          id: 'call_memory_search_plain',
          type: 'function',
          function: {
            name: 'memory_search_2',
            arguments: '{}'
          }
        },
        {
          id: 'call_memory_search_two',
          type: 'function',
          function: {
            name: 'memory_search_2_2',
            arguments: '{}'
          }
        }
      ])
    } satisfies RoleModelAssistantChatMessage);
    const messages = renderNvidiaMessages(inputEnvelope, {
      turnContext: renderRoleModelTurnContext(inputEnvelope, {
        additionalMessages: [priorAssistantMessage]
      })
    });
    const assistantHistoryMessage = messages.find(
      (message): message is RoleModelAssistantChatMessage =>
        message.role === 'assistant' && message.tool_calls !== undefined
    );

    expect(
      assistantHistoryMessage?.tool_calls?.map(
        (toolCall) => toolCall.function.name
      )
    ).toEqual(['memory_search', 'memory_search_2', 'memory_search_2_2']);
  });

  it('normalizes final assistant content through visible_reply', async () => {
    let capturedBody: unknown;
    const fetchClient: NvidiaFetchClient = (_url, request) => {
      capturedBody = JSON.parse(request.body);

      return Promise.resolve({
        ok: true,
        status: 200,
        json() {
          return Promise.resolve({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: 'Hello from assistant content.\n- plugin.list'
                }
              }
            ]
          });
        },
        text() {
          return Promise.resolve('');
        }
      });
    };
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret',
      fetchClient,
      model: 'nvidia/test-model'
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(inputEnvelope, {
      turnContext: renderRoleModelTurnContext(inputEnvelope)
    });

    expect(capturedBody).toMatchObject({
      model: 'nvidia/test-model',
      stream: false,
      tool_choice: 'auto'
    });
    expect(
      (capturedBody as { readonly messages?: readonly { readonly role: string }[] })
        .messages?.map((message) => message.role)
    ).toEqual(['system', 'user', 'assistant', 'user']);
    expect(JSON.parse(output.rawOutputText)).toEqual({
      toolCalls: [
        {
          name: visibleReplyModelToolName,
          input: {
            text: 'Hello from assistant content.\n- plugin.list'
          }
        }
      ]
    });
    expect(output.nativeAssistantMessage).toMatchObject({
      role: 'assistant',
      content: 'Hello from assistant content.\n- plugin.list'
    });
  });

  it('rejects length-finished assistant content as partial output', async () => {
    const fetchClient: NvidiaFetchClient = () => Promise.resolve({
      ok: true,
      status: 200,
      json() {
        return Promise.resolve({
          choices: [
            {
              finish_reason: 'length',
              message: {
                role: 'assistant',
                content: 'This reply was truncated mid-sentence'
              }
            }
          ]
        });
      },
      text() {
        return Promise.resolve('');
      }
    });
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret',
      fetchClient
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(inputEnvelope, {
      turnContext: renderRoleModelTurnContext(inputEnvelope)
    });

    expect(output.rawOutputText).toBe('');
    expect(output.rejection).toMatchObject({
      reason: 'provider_error',
      details: 'NVIDIA response finish_reason "length" is not terminal.'
    });
    expect(output.providerMetadata?.error).toMatchObject({
      code: 'provider_error',
      message: 'NVIDIA response finish_reason "length" is not terminal.'
    });
  });

  it('normalizes native assistant tool calls and content without top-level text', async () => {
    const fetchClient: NvidiaFetchClient = () => Promise.resolve({
      ok: true,
      status: 200,
      json() {
        return Promise.resolve({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: 'Checking the available plugins.',
                tool_calls: [
                  {
                    id: 'call_plugin_list',
                    type: 'function',
                    function: {
                      name: 'plugin_list',
                      arguments: '{}'
                    }
                  },
                  {
                    id: 'call_character_state_patch',
                    type: 'function',
                    function: {
                      name: 'character_state_patch',
                      arguments: '{"mood":"curious"}'
                    }
                  }
                ]
              }
            }
          ]
        });
      },
      text() {
        return Promise.resolve('');
      }
    });
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret',
      fetchClient
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(inputEnvelope, {
      turnContext: renderRoleModelTurnContext(inputEnvelope)
    });

    const rawDecision: unknown = JSON.parse(output.rawOutputText);

    expect(rawDecision).toEqual({
      toolCalls: [
        {
          name: visibleReplyModelToolName,
          input: {
            text: 'Checking the available plugins.'
          }
        },
        {
          name: 'plugin.list',
          input: {}
        },
        {
          name: 'character_state.patch',
          input: {
            mood: 'curious'
          }
        }
      ]
    });
    expect(rawDecision).not.toHaveProperty('text');
    expect(output.nativeAssistantMessage?.tool_calls).toMatchObject([
      {
        id: 'call_plugin_list',
        function: {
          name: 'plugin_list',
          arguments: '{}'
        }
      },
      {
        id: 'call_character_state_patch',
        function: {
          name: 'character_state_patch',
          arguments: '{"mood":"curious"}'
        }
      }
    ]);
  });

  it('does not duplicate visible_reply when native tool calls already include it', async () => {
    const fetchClient: NvidiaFetchClient = () => Promise.resolve({
      ok: true,
      status: 200,
      json() {
        return Promise.resolve({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: 'Extra assistant content.',
                tool_calls: [
                  {
                    id: 'call_visible_reply',
                    type: 'function',
                    function: {
                      name: visibleReplyModelToolName,
                      arguments: '{"text":"Native visible reply."}'
                    }
                  }
                ]
              }
            }
          ]
        });
      },
      text() {
        return Promise.resolve('');
      }
    });
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret',
      fetchClient
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(inputEnvelope, {
      turnContext: renderRoleModelTurnContext(inputEnvelope)
    });
    const rawDecision: unknown = JSON.parse(output.rawOutputText);

    expect(rawDecision).toEqual({
      toolCalls: [
        {
          name: visibleReplyModelToolName,
          input: {
            text: 'Native visible reply.'
          }
        }
      ]
    });
    expect(rawDecision).not.toHaveProperty('text');
  });

  it('rejects non-finite native tool arguments before raw output normalization', async () => {
    const fetchClient: NvidiaFetchClient = () => Promise.resolve({
      ok: true,
      status: 200,
      json() {
        return Promise.resolve({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Checking the available plugins.',
                tool_calls: [
                  {
                    id: 'call_plugin_list',
                    type: 'function',
                    function: {
                      name: 'plugin_list',
                      arguments: '{"score":1e999}'
                    }
                  }
                ]
              }
            }
          ]
        });
      },
      text() {
        return Promise.resolve('');
      }
    });
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret',
      fetchClient
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(inputEnvelope, {
      turnContext: renderRoleModelTurnContext(inputEnvelope)
    });

    expect(output.rawOutputText).toBe('');
    expect(output.rejection?.reason).toBe('provider_error');
    expect(output.rejection?.details).toContain('must be finite JSON');
    expect(output.providerMetadata?.error?.code).toBe('malformed_response');
    expect(output.providerMetadata?.error?.message).toContain(
      'must be finite JSON'
    );
    expect(output.rawOutputText).not.toContain('null');
  });
});

function createNvidiaTestInputEnvelope() {
  const pluginHost = createDefaultProject02PluginHost();

  return createRoleModelInputEnvelope({
    event: createUserMessageRuntimeEvent(
      'hello',
      createRuntimeEventIdentity({
        eventId: 'evt_nvidia',
        traceId: 'trace_nvidia',
        createdAt: '2026-06-15T00:00:00.000Z'
      })
    ),
    decisionContext: createDecisionContext({
      sessionId: 'session-nvidia',
      characterSnapshot: {
        id: 'mira',
        displayName: 'Mira'
      },
      recentVisibleMessages: [
        {
          id: 'm1',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'previous question'
        },
        {
          id: 'm2',
          role: 'character',
          speakerId: 'mira',
          speakerName: 'Mira',
          text: 'previous answer'
        }
      ],
      runtimeNotes: ['Use concise replies.'],
      pluginContextItems: [
        createRuntimePluginContextItem({
          pluginId: 'character-state',
          id: 'current',
          kind: 'runtime_note',
          text: 'Character State: steady',
          budget: {
            estimatedTokens: 8,
            priority: 90
          },
          sourceReferences: [],
          confidence: 1,
          redactionLabels: []
        })
      ]
    }),
    pluginToolDefinitions: pluginHost.pluginToolDefinitions()
  });
}

function createNvidiaAliasCollisionInputEnvelope() {
  return createRoleModelInputEnvelope({
    event: createUserMessageRuntimeEvent(
      'hello',
      createRuntimeEventIdentity({
        eventId: 'evt_nvidia_alias_collision',
        traceId: 'trace_nvidia_alias_collision',
        createdAt: '2026-06-15T00:00:00.000Z'
      })
    ),
    decisionContext: createDecisionContext({
      sessionId: 'session-nvidia-alias',
      characterSnapshot: {
        id: 'mira',
        displayName: 'Mira'
      }
    }),
    pluginToolDefinitions: [
      createAliasCollisionToolDefinition({
        pluginId: 'memory_alias_dot',
        name: 'memory.search'
      }),
      createAliasCollisionToolDefinition({
        pluginId: 'memory_alias_plain',
        name: 'memory_search'
      }),
      createAliasCollisionToolDefinition({
        pluginId: 'memory_alias_two',
        name: 'memory_search_2'
      })
    ]
  });
}

function createAliasCollisionToolDefinition(options: {
  readonly pluginId: string;
  readonly name: string;
}): RoleModelPluginToolDefinition {
  return Object.freeze({
    pluginId: options.pluginId,
    name: options.name,
    description: `Alias collision fixture for ${options.name}.`,
    requiredForUserTurn: false,
    maxCallsPerUserTurn: 1,
    inputContract: {
      type: 'object',
      fields: [],
      additionalFields: false
    },
    validationOwner: 'plugin_host',
    sideEffectLevel: 'runtime_read',
    requiresConfirmation: false,
    sourceReferencesRequired: false
  } satisfies RoleModelPluginToolDefinition);
}
