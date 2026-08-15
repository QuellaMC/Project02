import {createRuntimePluginHost} from '../../src/plugins/index.ts';
import {testCharacterProfile} from '../support/character-fixtures.ts';
import {describe, expect, it, vi} from 'vitest';

import {
  createDecisionContext,
  createDefaultRoleModelPluginToolDefinitions,
  createRoleModelInputEnvelope,
  renderRoleModelTurnContext,
  type ConversationTurn,
  type RoleModelAdapterInvocation,
  type RoleModelAssistantChatMessage,
  type RoleModelChatCompletionTool,
  type RoleModelChatMessage,
  type RoleModelInputEnvelope,
  type RoleModelPluginToolDefinition,
  roleModelProviderErrorRejectionReason,
  visibleReplyModelToolName,
} from '../../src/role-model/index.ts';
import {
  createNvidiaRoleModelProviderAdapter,
  createNvidiaRoleModelProviderConfigFromEnv,
  defaultNvidiaRoleModelRequestTimeoutMs,
  defaultNvidiaRoleModelReasoningBudget,
  nvidiaModelEnvName,
  type NvidiaFetchClient,
} from '../../src/role-model/providers/nvidia.ts';
import {
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
} from '../../src/core/index.ts';
import {createDefaultProject02PluginHost} from '../support/default-plugin-host.ts';
import {runtimePluginConfigControlStateForTest} from '../support/runtime-config.ts';
import {testRuntimePluginConfigControlCapability} from '../support/plugin-host-fixtures.ts';
import {createRuntimePluginContextItem} from '../../src/plugins/api/index.ts';
import {
  visibleReplyTextDescription,
  visibleReplyToolDescription,
} from '../../src/role-model/prompt/prompt-text.ts';

describe('NVIDIA role-model provider', () => {
  it('preserves successful assistant content for execution', async () => {
    let requestBody = '';
    const fetchClient: NvidiaFetchClient = (_url, request) => {
      requestBody = request.body;
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
                  content: 'api_key=reply-secret',
                },
              },
            ],
          });
        },
        text() {
          return Promise.resolve('');
        },
      });
    };
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'provider-secret',
      fetchClient,
    });
    const inputEnvelope = createNvidiaTestInputEnvelope(
      'Authorization: ApiKey user-secret',
    );
    const output = await adapter.invoke(
      inputEnvelope,
      testInvocation(inputEnvelope),
    );

    expect(requestBody).toContain('user-secret');
    expect(JSON.parse(output.rawOutputText)).toMatchObject({
      toolCalls: [
        {
          input: {text: 'api_key=reply-secret'},
        },
      ],
    });
    expect(output.nativeAssistantMessage?.content).toBe('api_key=reply-secret');
  });

  it('retries transient transport failures and succeeds within the deadline', async () => {
    let fetchCalls = 0;
    const fetchClient: NvidiaFetchClient = () => {
      fetchCalls += 1;

      if (fetchCalls === 1) {
        return Promise.resolve({
          ok: false,
          status: 503,
          json() {
            return Promise.resolve({});
          },
          text() {
            return Promise.resolve('upstream unavailable');
          },
        });
      }

      return Promise.resolve(successfulReplyResponse('recovered'));
    };
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'provider-secret',
      fetchClient,
      transportRetryDelaysMs: [0],
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(
      inputEnvelope,
      testInvocation(inputEnvelope),
    );

    expect(fetchCalls).toBe(2);
    expect(output.rejection).toBeUndefined();
    expect(output.rawOutputText).toContain('recovered');
  });

  it('retries a thrown network failure and succeeds', async () => {
    let fetchCalls = 0;
    const fetchClient: NvidiaFetchClient = () => {
      fetchCalls += 1;

      if (fetchCalls === 1) {
        return Promise.reject(new Error('socket hang up'));
      }

      return Promise.resolve(successfulReplyResponse('after network blip'));
    };
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'provider-secret',
      fetchClient,
      transportRetryDelaysMs: [0],
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(
      inputEnvelope,
      testInvocation(inputEnvelope),
    );

    expect(fetchCalls).toBe(2);
    expect(output.rejection).toBeUndefined();
  });

  it('does not retry non-transient http failures', async () => {
    let fetchCalls = 0;
    const fetchClient: NvidiaFetchClient = () => {
      fetchCalls += 1;

      return Promise.resolve({
        ok: false,
        status: 401,
        json() {
          return Promise.resolve({});
        },
        text() {
          return Promise.resolve('unauthorized');
        },
      });
    };
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'provider-secret',
      fetchClient,
      transportRetryDelaysMs: [0, 0],
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(
      inputEnvelope,
      testInvocation(inputEnvelope),
    );

    expect(fetchCalls).toBe(1);
    expect(output.rejection).toMatchObject({reason: 'provider_error'});
    expect(output.providerMetadata?.error).toMatchObject({code: 'http_error'});
    expect(output.providerMetadata?.response).toMatchObject({status: 401});
  });

  it('exhausts transport retries and reports the final http error', async () => {
    let fetchCalls = 0;
    const fetchClient: NvidiaFetchClient = () => {
      fetchCalls += 1;

      return Promise.resolve({
        ok: false,
        status: 429,
        json() {
          return Promise.resolve({});
        },
        text() {
          return Promise.resolve('rate limited');
        },
      });
    };
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'provider-secret',
      fetchClient,
      transportRetryDelaysMs: [0, 0],
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(
      inputEnvelope,
      testInvocation(inputEnvelope),
    );

    expect(fetchCalls).toBe(3);
    expect(output.providerMetadata?.error).toMatchObject({code: 'http_error'});
    expect(output.providerMetadata?.response).toMatchObject({status: 429});
  });

  it('normalizes empty assistant content into an empty decision', async () => {
    const fetchClient: NvidiaFetchClient = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json() {
          return Promise.resolve({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: '',
                },
              },
            ],
          });
        },
        text() {
          return Promise.resolve('');
        },
      });
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'provider-secret',
      fetchClient,
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(
      inputEnvelope,
      testInvocation(inputEnvelope),
    );

    expect(output.rejection).toBeUndefined();
    expect(JSON.parse(output.rawOutputText)).toEqual({toolCalls: []});
  });

  it('carries unparseable visible_reply arguments as an empty reply call', async () => {
    const fetchClient: NvidiaFetchClient = () =>
      Promise.resolve({
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
                      id: 'call_bad_reply_args',
                      type: 'function',
                      function: {
                        name: 'visible_reply',
                        arguments: '{"text": not-json',
                      },
                    },
                  ],
                },
              },
            ],
          });
        },
        text() {
          return Promise.resolve('');
        },
      });
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'provider-secret',
      fetchClient,
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(
      inputEnvelope,
      testInvocation(inputEnvelope),
    );

    expect(output.rejection).toBeUndefined();
    expect(JSON.parse(output.rawOutputText)).toMatchObject({
      toolCalls: [
        {
          name: visibleReplyModelToolName,
          input: {text: ''},
        },
      ],
    });
  });

  it('clears the retry backoff timer when the deadline expires first', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const fetchClient: NvidiaFetchClient = () =>
      Promise.reject(new Error('socket hang up'));
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'provider-secret',
      fetchClient,
      requestTimeoutMs: 40,
      transportRetryDelaysMs: [60_000],
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(
      inputEnvelope,
      testInvocation(inputEnvelope),
    );

    expect(output.providerMetadata?.error).toMatchObject({
      code: 'request_timeout',
    });
    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('preserves native tool-call identities and arguments for execution', async () => {
    const fetchClient: NvidiaFetchClient = () =>
      Promise.resolve({
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
                      id: 'call_token=id-secret',
                      type: 'function',
                      function: {
                        name: 'visible_reply',
                        arguments: '{"text":"Cookie: reply-cookie"}',
                      },
                    },
                  ],
                },
              },
            ],
          });
        },
        text() {
          return Promise.resolve('');
        },
      });
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'provider-secret',
      fetchClient,
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(
      inputEnvelope,
      testInvocation(inputEnvelope),
    );

    expect(JSON.parse(output.rawOutputText)).toMatchObject({
      toolCalls: [
        {
          name: visibleReplyModelToolName,
          input: {text: 'Cookie: reply-cookie'},
        },
      ],
    });
    expect(output.nativeAssistantMessage?.tool_calls?.[0]).toMatchObject({
      id: 'call_token=id-secret',
      function: {
        arguments: '{"text":"Cookie: reply-cookie"}',
      },
    });
  });

  it('reads the model name from environment configuration', () => {
    expect(
      createNvidiaRoleModelProviderConfigFromEnv({
        NVIDIA_API_KEY: 'secret',
        [nvidiaModelEnvName]: 'nvidia/test-model',
      }).model,
    ).toBe('nvidia/test-model');
  });

  it('redacts credential-bearing response keys from provider exchange evidence', async () => {
    const credentialSentinel = 'provider-response-credential-sentinel';
    const nestedCredentialSentinel = 'provider-response-nested-sentinel';
    const fetchClient: NvidiaFetchClient = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json() {
          return Promise.resolve({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: 'Hello.',
                },
              },
            ],
            usage: {
              api_key: credentialSentinel,
              nested: {
                access_token: nestedCredentialSentinel,
                safe: 'preserved',
              },
            },
          });
        },
        text() {
          return Promise.resolve('');
        },
      });
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret',
      fetchClient,
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(
      inputEnvelope,
      testInvocation(inputEnvelope),
    );
    const serializedExchange = JSON.stringify(output.providerExchange);

    expect(output.providerExchange?.usage).toEqual({
      api_key: '[redacted]',
      nested: {
        access_token: '[redacted]',
        safe: 'preserved',
      },
    });
    expect(serializedExchange).not.toContain(credentialSentinel);
    expect(serializedExchange).not.toContain(nestedCredentialSentinel);
  });

  it('renders OpenAI-compatible messages and native tools', async () => {
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const {messages, tools = []} = await captureNvidiaRequest(inputEnvelope);
    const rendered = renderRoleModelTurnContext(inputEnvelope);

    expect(messages.map(message => message.role)).toEqual([
      'system',
      'system',
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(messages[0]?.content).toBe(rendered.messages[0]?.content);
    expect(messages[0]?.content).toContain('plugins');
    expect(messages[1]?.content).toContain('call runtime.plugin.list');
    expect(messages[2]?.content).toBe(
      rendered.frames.find(frame => frame.kind === 'model_only_runtime_context')
        ?.content,
    );
    expect(messages[2]?.content).toContain('- Use concise replies.');
    expect(messages[2]?.content).toContain('mood=steady');
    expect(messages[3]).toMatchObject({
      role: 'user',
      content: 'previous question',
    });
    expect(messages[4]).toMatchObject({
      role: 'assistant',
      content: 'previous answer',
    });
    expect(messages[5]?.role).toBe('user');
    expect(
      messages[5]?.content?.startsWith('hello\n\n<recalled_memory>\n'),
    ).toBe(true);
    expect(messages[5]?.content).toContain('- Prefers tea without sugar.');
    expect(messages[5]?.content).toContain('<untrusted_plugin_context>\n');
    expect(messages[5]?.content).toContain('## weather.fixture · forecast');
    expect(messages[5]?.content?.endsWith('</untrusted_plugin_context>')).toBe(
      true,
    );
    for (const content of [messages[2]?.content, messages[5]?.content]) {
      expect(content).not.toContain('"event"');
      expect(content).not.toContain('"toolObservations"');
      expect(content).not.toContain('"version"');
      expect(content).not.toContain('sourceReferences');
      expect(content).not.toContain('confidence');
      expect(content).not.toContain('budget');
      expect(content).not.toContain('character_state.patch');
    }
    expect(messages[2]?.content).not.toContain(visibleReplyModelToolName);

    expect(tools.map(tool => tool.function.name)).toEqual([
      visibleReplyModelToolName,
      'runtime_plugin_list',
      'character_state_patch',
    ]);
    expect(
      tools.every(tool => /^[A-Za-z][A-Za-z0-9_-]*$/u.test(tool.function.name)),
    ).toBe(true);
    expect(
      tools.find(tool => tool.function.name === visibleReplyModelToolName)
        ?.function.parameters.properties?.['text'],
    ).toMatchObject({
      type: 'string',
      description: visibleReplyTextDescription,
    });
    expect(
      tools.find(tool => tool.function.name === visibleReplyModelToolName)
        ?.function.description,
    ).toBe(visibleReplyToolDescription);
    expect(
      tools.find(tool => tool.function.name === 'runtime_plugin_list')?.function
        .description,
    ).toContain('available to you');
    expect(
      tools.find(tool => tool.function.name === 'character_state_patch')
        ?.function.description,
    ).toContain('yours, never theirs');
    expect(
      tools.find(tool => tool.function.name === 'runtime_plugin_list')?.function
        .parameters.additionalProperties,
    ).toBe(false);
    expect(
      tools.find(tool => tool.function.name === 'runtime_plugin_list')?.function
        .strict,
    ).toBe(true);
  });

  it('uses canonical provider-safe names for every runtime plugin management tool', async () => {
    const pluginHost = createRuntimePluginHost({
      pluginConfigControl: runtimePluginConfigControlStateForTest({
        control: testRuntimePluginConfigControlCapability,
        pluginManifests: [],
      }),
      toolConfirmationHandler: () => ({status: 'approved'}),
    });
    const inputEnvelope = createNvidiaTestInputEnvelope(
      'hello',
      pluginHost.pluginToolDefinitions(),
    );
    const {tools = []} = await captureNvidiaRequest(inputEnvelope);

    expect(tools.map(tool => tool.function.name)).toEqual([
      visibleReplyModelToolName,
      'runtime_plugin_list',
      'runtime_plugin_config',
      'runtime_plugin_config_update',
    ]);
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
                        arguments: '{}',
                      },
                    },
                    {
                      id: 'call_memory_search_plain',
                      type: 'function',
                      function: {
                        name: 'memory_search_2',
                        arguments: '{}',
                      },
                    },
                    {
                      id: 'call_memory_search_two',
                      type: 'function',
                      function: {
                        name: 'memory_search_2_2',
                        arguments: '{}',
                      },
                    },
                  ],
                },
              },
            ],
          });
        },
        text() {
          return Promise.resolve('');
        },
      });
    };
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret',
      fetchClient,
    });
    const inputEnvelope = createNvidiaAliasCollisionInputEnvelope();
    const output = await adapter.invoke(
      inputEnvelope,
      testInvocation(inputEnvelope),
    );

    expect(
      (
        capturedBody as {
          readonly tools?: readonly {
            readonly function: {readonly name: string};
          }[];
        }
      ).tools?.map(tool => tool.function.name),
    ).toEqual([
      visibleReplyModelToolName,
      'memory_search',
      'memory_search_2',
      'memory_search_2_2',
    ]);
    expect(output.rejection).toBeUndefined();
    expect(JSON.parse(output.rawOutputText)).toEqual({
      toolCalls: [
        {
          name: 'memory.search',
          input: {},
        },
        {
          name: 'memory_search',
          input: {},
        },
        {
          name: 'memory_search_2',
          input: {},
        },
      ],
    });
  });

  it('preserves provider aliases in prior assistant tool-call history', async () => {
    const priorAssistantMessage = Object.freeze({
      role: 'assistant',
      content: null,
      tool_calls: Object.freeze([
        {
          id: 'call_memory_search_dot',
          type: 'function',
          function: {
            name: 'memory_search',
            arguments: '{}',
          },
        },
        {
          id: 'call_memory_search_plain',
          type: 'function',
          function: {
            name: 'memory_search_2',
            arguments: '{}',
          },
        },
        {
          id: 'call_memory_search_two',
          type: 'function',
          function: {
            name: 'memory_search_2_2',
            arguments: '{}',
          },
        },
      ]),
    } satisfies RoleModelAssistantChatMessage);
    const {messages} = await captureNvidiaRequest(
      createNvidiaAliasCollisionInputEnvelope(),
      [priorAssistantMessage],
    );
    const assistantHistoryMessage = messages.find(
      (message): message is RoleModelAssistantChatMessage =>
        message.role === 'assistant' && message.tool_calls !== undefined,
    );

    expect(
      assistantHistoryMessage?.tool_calls?.map(
        toolCall => toolCall.function.name,
      ),
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
                  content:
                    'Hello from assistant content.\n- runtime.plugin.list',
                },
              },
            ],
          });
        },
        text() {
          return Promise.resolve('');
        },
      });
    };
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret',
      fetchClient,
      model: 'nvidia/test-model',
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(
      inputEnvelope,
      testInvocation(inputEnvelope),
    );

    expect(capturedBody).toMatchObject({
      model: 'nvidia/test-model',
      stream: false,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      reasoning_budget: defaultNvidiaRoleModelReasoningBudget,
      chat_template_kwargs: {
        enable_thinking: true,
      },
    });
    expect(
      (
        capturedBody as {readonly messages?: readonly {readonly role: string}[]}
      ).messages?.map(message => message.role),
    ).toEqual(['system', 'system', 'system', 'user', 'assistant', 'user']);
    expect(JSON.parse(output.rawOutputText)).toEqual({
      toolCalls: [
        {
          name: visibleReplyModelToolName,
          input: {
            text: 'Hello from assistant content.\n- runtime.plugin.list',
          },
        },
      ],
    });
    expect(output.nativeAssistantMessage).toMatchObject({
      role: 'assistant',
      content: 'Hello from assistant content.\n- runtime.plugin.list',
    });
    expect(output.providerExchange?.reasoning).toEqual({
      mode: 'enabled',
      params: {
        reasoning_budget: defaultNvidiaRoleModelReasoningBudget,
        chat_template_kwargs: {
          enable_thinking: true,
        },
      },
    });
    expect(output.providerExchange?.finishReason).toBe('stop');
    expect(output.providerExchange?.outputNormalization).toEqual({
      source: 'terminal_assistant_content',
      committed: false,
    });
  });

  it('keeps terminal assistant content non-committed when visible_reply is unavailable', async () => {
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
                  content: 'Internal terminal model text.',
                },
              },
            ],
          });
        },
        text() {
          return Promise.resolve('');
        },
      });
    };
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret',
      fetchClient,
      model: 'nvidia/test-model',
    });
    const inputEnvelope = createNvidiaNoVisibleReplyInputEnvelope();
    const output = await adapter.invoke(
      inputEnvelope,
      testInvocation(inputEnvelope),
    );

    expect(capturedBody).not.toHaveProperty('tools');
    expect(JSON.parse(output.rawOutputText)).toEqual({
      toolCalls: [],
      text: 'Internal terminal model text.',
    });
    expect(output.providerExchange?.outputNormalization).toEqual({
      source: 'terminal_assistant_content',
      committed: false,
    });
  });

  it('scrubs leaked think blocks before visible_reply normalization', async () => {
    const fetchClient: NvidiaFetchClient = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json() {
          return Promise.resolve({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: '<think>secret</think>Hello',
                },
              },
            ],
          });
        },
        text() {
          return Promise.resolve('');
        },
      });
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret',
      fetchClient,
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(
      inputEnvelope,
      testInvocation(inputEnvelope),
    );

    expect(JSON.parse(output.rawOutputText)).toEqual({
      toolCalls: [
        {
          name: visibleReplyModelToolName,
          input: {
            text: 'Hello',
          },
        },
      ],
    });
    expect(output.rawOutputText).not.toContain('secret');
    expect(output.rawOutputText).not.toContain('<think>');
    expect(output.nativeAssistantMessage?.content).toBe('Hello');
    expect(JSON.stringify(output.providerExchange)).not.toContain('secret');
    expect(JSON.stringify(output.providerExchange)).not.toContain('<think>');
  });

  it('rejects length-finished assistant content as partial output', async () => {
    const fetchClient: NvidiaFetchClient = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json() {
          return Promise.resolve({
            choices: [
              {
                finish_reason: 'length',
                message: {
                  role: 'assistant',
                  content: 'This reply was truncated mid-sentence',
                },
              },
            ],
          });
        },
        text() {
          return Promise.resolve('');
        },
      });
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret',
      fetchClient,
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(
      inputEnvelope,
      testInvocation(inputEnvelope),
    );

    expect(output.rawOutputText).toBe('');
    expect(output.rejection).toMatchObject({
      reason: 'provider_error',
      details: 'NVIDIA response finish_reason "length" is not terminal.',
    });
    expect(output.providerMetadata?.error).toMatchObject({
      code: 'provider_error',
      message: 'NVIDIA response finish_reason "length" is not terminal.',
    });
  });

  it.each([undefined, null])(
    'rejects missing terminal finish_reason %s',
    async finishReason => {
      const fetchClient: NvidiaFetchClient = () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json() {
            return Promise.resolve({
              choices: [
                {
                  finish_reason: finishReason,
                  message: {
                    role: 'assistant',
                    content: 'Unconfirmed terminal output.',
                  },
                },
              ],
            });
          },
          text() {
            return Promise.resolve('');
          },
        });
      const adapter = createNvidiaRoleModelProviderAdapter({
        apiKey: 'secret',
        fetchClient,
      });
      const inputEnvelope = createNvidiaTestInputEnvelope();
      const output = await adapter.invoke(
        inputEnvelope,
        testInvocation(inputEnvelope),
      );

      expect(output.rejection).toEqual({
        reason: roleModelProviderErrorRejectionReason,
        details: 'NVIDIA response choice.finish_reason is required.',
      });
    },
  );

  it('enforces one hard deadline across clients that ignore abort signals', async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchClient: NvidiaFetchClient = (_url, request) => {
      requestSignal = request.signal;
      return new Promise(() => undefined);
    };
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret',
      fetchClient,
      requestTimeoutMs: 5,
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(
      inputEnvelope,
      testInvocation(inputEnvelope),
    );

    expect(requestSignal?.aborted).toBe(true);
    expect(output.rejection).toEqual({
      reason: roleModelProviderErrorRejectionReason,
      details: 'NVIDIA provider request timed out after 5ms.',
    });
    expect(defaultNvidiaRoleModelRequestTimeoutMs).toBe(30_000);
  });

  it('keeps the request deadline active while decoding the response body', async () => {
    const fetchClient: NvidiaFetchClient = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json() {
          return new Promise(() => undefined);
        },
        text() {
          return Promise.resolve('');
        },
      });
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret',
      fetchClient,
      requestTimeoutMs: 5,
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(
      inputEnvelope,
      testInvocation(inputEnvelope),
    );

    expect(output.rejection?.details).toBe(
      'NVIDIA provider request timed out after 5ms.',
    );
  });

  it('rejects a body decoder that blocks past the deadline before resolving', async () => {
    const fetchClient: NvidiaFetchClient = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json() {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
          return Promise.resolve({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: 'This late response must not be accepted.',
                },
              },
            ],
          });
        },
        text() {
          return Promise.resolve('');
        },
      });
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret',
      fetchClient,
      requestTimeoutMs: 5,
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(
      inputEnvelope,
      testInvocation(inputEnvelope),
    );

    expect(output.rejection?.details).toBe(
      'NVIDIA provider request timed out after 5ms.',
    );
    expect(output.rawOutputText).toBe('');
  });

  it('normalizes native assistant tool calls and content without top-level text', async () => {
    const fetchClient: NvidiaFetchClient = () =>
      Promise.resolve({
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
                      id: 'call_runtime_plugin_list',
                      type: 'function',
                      function: {
                        name: 'runtime_plugin_list',
                        arguments: '{}',
                      },
                    },
                    {
                      id: 'call_character_state_patch',
                      type: 'function',
                      function: {
                        name: 'character_state_patch',
                        arguments: '{"mood":"curious"}',
                      },
                    },
                  ],
                },
              },
            ],
          });
        },
        text() {
          return Promise.resolve('');
        },
      });
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret',
      fetchClient,
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(
      inputEnvelope,
      testInvocation(inputEnvelope),
    );

    const rawDecision: unknown = JSON.parse(output.rawOutputText);

    expect(rawDecision).toEqual({
      toolCalls: [
        {
          name: 'runtime.plugin.list',
          input: {},
        },
        {
          name: 'character_state.patch',
          input: {
            mood: 'curious',
          },
        },
      ],
    });
    expect(rawDecision).not.toHaveProperty('text');
    expect(output.providerExchange?.outputNormalization).toEqual({
      source: 'native_tool_calls',
      committed: false,
    });
    expect(output.nativeAssistantMessage?.tool_calls).toMatchObject([
      {
        id: 'call_runtime_plugin_list',
        function: {
          name: 'runtime_plugin_list',
          arguments: '{}',
        },
      },
      {
        id: 'call_character_state_patch',
        function: {
          name: 'character_state_patch',
          arguments: '{"mood":"curious"}',
        },
      },
    ]);
  });

  it('does not duplicate visible_reply when native tool calls already include it', async () => {
    const fetchClient: NvidiaFetchClient = () =>
      Promise.resolve({
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
                        arguments: '{"text":"Native visible reply."}',
                      },
                    },
                  ],
                },
              },
            ],
          });
        },
        text() {
          return Promise.resolve('');
        },
      });
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret',
      fetchClient,
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(
      inputEnvelope,
      testInvocation(inputEnvelope),
    );
    const rawDecision: unknown = JSON.parse(output.rawOutputText);

    expect(rawDecision).toEqual({
      toolCalls: [
        {
          name: visibleReplyModelToolName,
          input: {
            text: 'Native visible reply.',
          },
        },
      ],
    });
    expect(rawDecision).not.toHaveProperty('text');
  });

  it('carries a non-finite native tool argument through as null', async () => {
    const fetchClient: NvidiaFetchClient = () =>
      Promise.resolve({
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
                      id: 'call_runtime_plugin_list',
                      type: 'function',
                      function: {
                        name: 'runtime_plugin_list',
                        arguments: '{"score":1e999}',
                      },
                    },
                  ],
                },
              },
            ],
          });
        },
        text() {
          return Promise.resolve('');
        },
      });
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret',
      fetchClient,
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(
      inputEnvelope,
      testInvocation(inputEnvelope),
    );

    // JSON has no value for the provider's 1e999, so it arrives as null.
    expect(JSON.parse(output.rawOutputText)).toEqual({
      toolCalls: [
        {
          name: 'runtime.plugin.list',
          input: {score: null},
        },
      ],
    });
    expect(output.rejection).toBeUndefined();
    expect(output.nativeToolCallArgumentErrors).toBeUndefined();
    expect(output.providerMetadata?.error).toBeUndefined();
    expect(output.providerMetadata?.response?.status).toBe(200);
  });
});

type CapturedNvidiaRequest = {
  readonly messages: readonly RoleModelChatMessage[];
  readonly tools?: readonly RoleModelChatCompletionTool[];
};

async function captureNvidiaRequest(
  inputEnvelope: RoleModelInputEnvelope,
  additionalMessages: readonly RoleModelChatMessage[] = [],
): Promise<CapturedNvidiaRequest> {
  let capturedBody: unknown;
  const adapter = createNvidiaRoleModelProviderAdapter({
    apiKey: 'secret',
    fetchClient: (_url, request) => {
      capturedBody = JSON.parse(request.body);

      return Promise.resolve(successfulReplyResponse('captured'));
    },
  });

  await adapter.invoke(
    inputEnvelope,
    testInvocation(inputEnvelope, {additionalMessages}),
  );

  return capturedBody as CapturedNvidiaRequest;
}

const nvidiaTestHistoryTurn = Object.freeze({
  eventId: 'evt_nvidia_previous',
  traceId: 'trace_nvidia_previous',
  createdAt: '2026-06-14T00:00:00.000Z',
  userMessage: {
    id: 'm1',
    role: 'user' as const,
    speakerId: 'local-user',
    speakerName: 'You',
    text: 'previous question',
  },
  toolRounds: [],
  finalReplies: [
    {
      id: 'm2',
      role: 'character' as const,
      speakerId: 'mira',
      speakerName: 'Mira',
      text: 'previous answer',
    },
  ],
} satisfies ConversationTurn);

function testInvocation(
  inputEnvelope: RoleModelInputEnvelope,
  options: {
    readonly additionalMessages?: readonly RoleModelChatMessage[];
    readonly conversationHistory?: readonly ConversationTurn[];
  } = {},
): RoleModelAdapterInvocation {
  const conversationHistory = options.conversationHistory ?? [
    nvidiaTestHistoryTurn,
  ];

  return {
    turnContext: renderRoleModelTurnContext(inputEnvelope, {
      conversationHistory,
      ...(options.additionalMessages === undefined
        ? {}
        : {additionalMessages: options.additionalMessages}),
    }),
    conversationHistory,
  };
}

function createNvidiaTestInputEnvelope(
  userMessage = 'hello',
  pluginToolDefinitions?: readonly RoleModelPluginToolDefinition[],
) {
  const pluginHost = createDefaultProject02PluginHost();

  return createRoleModelInputEnvelope({
    event: createUserMessageRuntimeEvent(
      userMessage,
      createRuntimeEventIdentity({
        eventId: 'evt_nvidia',
        traceId: 'trace_nvidia',
        createdAt: '2026-06-15T00:00:00.000Z',
      }),
    ),
    decisionContext: createDecisionContext({
      sessionId: 'session-nvidia',
      characterSnapshot: testCharacterProfile,
      historyWindow: {turnEventIds: [nvidiaTestHistoryTurn.eventId]},
      runtimeNotes: [
        {id: 'concise', text: 'Use concise replies.'},
        {
          id: 'current',
          pluginId: 'character-state',
          text: 'How you are right now (your own inner state, not theirs): mood=steady',
        },
      ],
      pluginContextItems: [
        createRuntimePluginContextItem({
          pluginId: 'memory.fixture',
          id: 'tea',
          kind: 'memory',
          text: 'Prefers tea without sugar.',
          budget: {estimatedTokens: 8, priority: 70},
          sourceReferences: [],
          confidence: 1,
          redactionLabels: [],
        }),
        createRuntimePluginContextItem({
          pluginId: 'weather.fixture',
          id: 'forecast',
          kind: 'resource',
          text: 'Sunny, 24C.',
          budget: {estimatedTokens: 8, priority: 50},
          sourceReferences: [],
          redactionLabels: [],
        }),
      ],
    }),
    pluginToolDefinitions:
      pluginToolDefinitions ?? pluginHost.pluginToolDefinitions(),
  });
}

function createNvidiaAliasCollisionInputEnvelope() {
  return createRoleModelInputEnvelope({
    event: createUserMessageRuntimeEvent(
      'hello',
      createRuntimeEventIdentity({
        eventId: 'evt_nvidia_alias_collision',
        traceId: 'trace_nvidia_alias_collision',
        createdAt: '2026-06-15T00:00:00.000Z',
      }),
    ),
    decisionContext: createDecisionContext({
      sessionId: 'session-nvidia-alias',
      characterSnapshot: testCharacterProfile,
    }),
    pluginToolDefinitions: [
      ...createDefaultRoleModelPluginToolDefinitions(),
      createAliasCollisionToolDefinition({
        pluginId: 'memory_alias_dot',
        name: 'memory.search',
      }),
      createAliasCollisionToolDefinition({
        pluginId: 'memory_alias_plain',
        name: 'memory_search',
      }),
      createAliasCollisionToolDefinition({
        pluginId: 'memory_alias_two',
        name: 'memory_search_2',
      }),
    ],
  });
}

function createNvidiaNoVisibleReplyInputEnvelope() {
  return createRoleModelInputEnvelope({
    event: createUserMessageRuntimeEvent(
      'hello',
      createRuntimeEventIdentity({
        eventId: 'evt_nvidia_no_visible_reply',
        traceId: 'trace_nvidia_no_visible_reply',
        createdAt: '2026-06-15T00:00:00.000Z',
      }),
    ),
    decisionContext: createDecisionContext({
      sessionId: 'session-nvidia-no-visible-reply',
      characterSnapshot: testCharacterProfile,
    }),
    pluginToolDefinitions: [],
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
    inputContract: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    validationOwner: 'plugin_host',
    requiresConfirmation: false,
  } satisfies RoleModelPluginToolDefinition);
}

function successfulReplyResponse(text: string): {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
} {
  return {
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
                  id: 'call_reply',
                  type: 'function',
                  function: {
                    name: 'visible_reply',
                    arguments: JSON.stringify({text}),
                  },
                },
              ],
            },
          },
        ],
      });
    },
    text() {
      return Promise.resolve('');
    },
  };
}
