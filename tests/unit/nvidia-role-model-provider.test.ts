import {createRuntimePluginHost} from '../../src/plugins/index.ts';
import {testCharacterProfile} from '../support/character-fixtures.ts';
import {describe, expect, it, vi} from 'vitest';
import {
  sseResponse,
  sseText,
  streamed,
  textResponse,
} from '../support/nvidia-fixtures.ts';

import {
  createDecisionContext,
  createRoleModelInputEnvelope,
  renderRoleModelTurnContext,
  type ConversationTurn,
  type RoleModelAdapterInvocation,
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
      return Promise.resolve(
        streamed({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'api_key=reply-secret',
              },
            },
          ],
        }),
      );
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
    expect(output.providerExchange?.nativeAssistantMessage?.content).toBe(
      'api_key=reply-secret',
    );
  });

  it('retries transient transport failures and succeeds within the deadline', async () => {
    let fetchCalls = 0;
    const fetchClient: NvidiaFetchClient = () => {
      fetchCalls += 1;

      if (fetchCalls === 1) {
        return Promise.resolve(textResponse('upstream unavailable', 503));
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

      return Promise.resolve(textResponse('unauthorized', 401));
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

      return Promise.resolve(textResponse('rate limited', 429));
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
      Promise.resolve(
        streamed({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: '',
              },
            },
          ],
        }),
      );
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

  it('passes native tool arguments that are not a JSON object to the parser as written', async () => {
    const fetchClient: NvidiaFetchClient = () =>
      Promise.resolve(
        streamed({
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
        }),
      );
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
    expect(JSON.parse(output.rawOutputText)).toEqual({
      toolCalls: [
        {name: visibleReplyModelToolName, input: '{"text": not-json'},
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
      Promise.resolve(
        streamed({
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
        }),
      );
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
    expect(output.providerExchange?.nativeAssistantMessage).toMatchObject({
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_token=id-secret',
          function: {arguments: '{"text":"Cookie: reply-cookie"}'},
        },
      ],
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
      Promise.resolve(
        streamed({
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
        }),
      );
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
      expect(content).not.toContain('"toolRounds"');
      expect(content).not.toContain('"version"');
      expect(content).not.toContain('sourceReferences');
      expect(content).not.toContain('confidence');
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

      return Promise.resolve(
        streamed({
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
        }),
      );
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

  it('maps replayed tool rounds to provider names', async () => {
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const historyWithTools: ConversationTurn = {
      ...nvidiaTestHistoryTurn,
      toolRounds: [
        {
          round: 1,
          interimReplies: [],
          toolCalls: [
            {
              toolCallId: 'evt_nvidia_previous.round-1.1',
              pluginId: 'runtime',
              toolName: 'runtime.plugin.list',
              input: {},
              result: {status: 'accepted', output: {plugins: []}},
            },
          ],
        },
      ],
    };
    let capturedBody: unknown;
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret',
      fetchClient: (_url, request) => {
        capturedBody = JSON.parse(request.body);

        return Promise.resolve(successfulReplyResponse('captured'));
      },
    });

    const output = await adapter.invoke(
      inputEnvelope,
      testInvocation(inputEnvelope, {conversationHistory: [historyWithTools]}),
    );
    const messages = (capturedBody as CapturedNvidiaRequest).messages;
    const replayedCall = messages.find(
      message =>
        message.role === 'assistant' && message.tool_calls !== undefined,
    );

    expect(replayedCall).toMatchObject({
      tool_calls: [
        {
          id: 'evt_nvidia_previous.round-1.1',
          function: {name: 'runtime_plugin_list', arguments: '{}'},
        },
      ],
    });
    expect(messages.find(message => message.role === 'tool')).toMatchObject({
      tool_call_id: 'evt_nvidia_previous.round-1.1',
    });
    expect(output.rejection).toBeUndefined();
  });

  it('normalizes final assistant content through visible_reply', async () => {
    let capturedBody: unknown;
    const fetchClient: NvidiaFetchClient = (_url, request) => {
      capturedBody = JSON.parse(request.body);

      return Promise.resolve(
        streamed({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'Hello from assistant content.\n- runtime.plugin.list',
              },
            },
          ],
        }),
      );
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
      stream: true,
      stream_options: {include_usage: true},
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
    expect(output.providerExchange?.nativeAssistantMessage).toMatchObject({
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
  });

  it('scrubs leaked think blocks before visible_reply normalization', async () => {
    const fetchClient: NvidiaFetchClient = () =>
      Promise.resolve(
        streamed({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: '<think>secret</think>Hello',
              },
            },
          ],
        }),
      );
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
    expect(output.providerExchange?.nativeAssistantMessage?.content).toBe(
      'Hello',
    );
    expect(JSON.stringify(output.providerExchange)).not.toContain('secret');
    expect(JSON.stringify(output.providerExchange)).not.toContain('<think>');
  });

  it('passes a reply with an unterminated reasoning block to the parser as the model wrote it', async () => {
    const fetchClient: NvidiaFetchClient = () =>
      Promise.resolve(
        streamed({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: '<think>still thinking about it',
              },
            },
          ],
        }),
      );
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret',
      fetchClient,
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(
      inputEnvelope,
      testInvocation(inputEnvelope),
    );

    // Not a provider fault: the model wrote something the runtime cannot
    // use, so it is not a rejection here — the parser refuses it and the
    // loop hands that back to the model.
    expect(output.rejection).toBeUndefined();
    expect(output.rawOutputText).toBe('<think>still thinking about it');
    expect(output.providerExchange?.nativeAssistantMessage).toBeUndefined();
  });

  it('rejects length-finished assistant content as partial output', async () => {
    const fetchClient: NvidiaFetchClient = () =>
      Promise.resolve(
        streamed({
          choices: [
            {
              finish_reason: 'length',
              message: {
                role: 'assistant',
                content: 'This reply was truncated mid-sentence',
              },
            },
          ],
        }),
      );
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
        Promise.resolve(
          streamed({
            choices: [
              {
                finish_reason: finishReason,
                message: {
                  role: 'assistant',
                  content: 'Unconfirmed terminal output.',
                },
              },
            ],
          }),
        );
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

  it('keeps the deadline active while the body streams: a chunk that never comes is a timeout', async () => {
    const fetchClient: NvidiaFetchClient = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            pull() {
              return new Promise(() => undefined);
            },
          }),
        ),
      );
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

  it('refuses a body that blocked the loop past the deadline before its first chunk', async () => {
    const late = sseText([
      {
        choices: [
          {
            index: 0,
            delta: {content: 'This late response must not be accepted.'},
            finish_reason: 'stop',
          },
        ],
      },
      '[DONE]',
    ]);
    const fetchClient: NvidiaFetchClient = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            pull(controller) {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
              controller.enqueue(new TextEncoder().encode(late));
              controller.close();
            },
          }),
        ),
      );
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

  it('keeps assistant content next to native tool calls as the decision text', async () => {
    const fetchClient: NvidiaFetchClient = () =>
      Promise.resolve(
        streamed({
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
        }),
      );
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
      text: 'Checking the available plugins.',
    });
    expect(output.providerExchange?.nativeAssistantMessage).toMatchObject({
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_runtime_plugin_list',
          function: {name: 'runtime_plugin_list', arguments: '{}'},
        },
        {
          id: 'call_character_state_patch',
          function: {
            name: 'character_state_patch',
            arguments: '{"mood":"curious"}',
          },
        },
      ],
    });
  });

  it('keeps content next to a native visible_reply as text, not as a second reply', async () => {
    const fetchClient: NvidiaFetchClient = () =>
      Promise.resolve(
        streamed({
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
        }),
      );
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
      text: 'Extra assistant content.',
    });
  });

  it('carries a non-finite native tool argument through as null', async () => {
    const fetchClient: NvidiaFetchClient = () =>
      Promise.resolve(
        streamed({
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
        }),
      );
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
    expect(JSON.parse(output.rawOutputText)).toMatchObject({
      toolCalls: [
        {
          name: 'runtime.plugin.list',
          input: {score: null},
        },
      ],
    });
    expect(output.rejection).toBeUndefined();
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
          sourceReferences: [],
          confidence: 1,
          redactionLabels: [],
        }),
        createRuntimePluginContextItem({
          pluginId: 'weather.fixture',
          id: 'forecast',
          kind: 'resource',
          text: 'Sunny, 24C.',
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
      ...[],
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

function successfulReplyResponse(text: string): Response {
  return streamed({
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
}

describe('NVIDIA role-model provider streaming', () => {
  const contentChunk = (content: string) => ({
    choices: [{index: 0, delta: {content}, finish_reason: null}],
  });
  const finishChunk = (finishReason: string) => ({
    choices: [{index: 0, delta: {}, finish_reason: finishReason}],
  });
  const argumentsChunk = (text: string, first = false) => ({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              ...(first ? {id: 'call_reply', type: 'function'} : {}),
              function: {
                ...(first ? {name: 'visible_reply'} : {}),
                arguments: text,
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  });

  async function invokeStreaming(
    response: Response | (() => Promise<Response>),
    options: {readonly requestTimeoutMs?: number} = {},
  ) {
    const heard: {reply: number; text: string}[] = [];
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret',
      fetchClient:
        typeof response === 'function'
          ? response
          : () => Promise.resolve(response),
      ...options,
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(inputEnvelope, {
      ...testInvocation(inputEnvelope),
      onReplyDelta(delta) {
        heard.push(delta);
      },
    });

    return {output, heard};
  }

  it('speaks content as it arrives and ends in the decision the parser accepts, usage and all', async () => {
    const {output, heard} = await invokeStreaming(
      sseResponse([
        contentChunk('Hel'),
        contentChunk('lo'),
        finishChunk('stop'),
        {choices: [], usage: {total_tokens: 3}},
        '[DONE]',
      ]),
    );

    expect(heard).toEqual([
      {reply: 0, text: 'Hel'},
      {reply: 0, text: 'lo'},
    ]);
    expect(output.rejection).toBeUndefined();
    expect(JSON.parse(output.rawOutputText)).toEqual({
      toolCalls: [{name: visibleReplyModelToolName, input: {text: 'Hello'}}],
    });
    expect(output.providerExchange).toMatchObject({
      finishReason: 'stop',
      usage: {total_tokens: 3},
    });
  });

  it("follows a visible_reply call's arguments as they arrive, escapes decoded", async () => {
    const {output, heard} = await invokeStreaming(
      sseResponse([
        argumentsChunk('{"te', true),
        argumentsChunk('xt": "Hi'),
        argumentsChunk(' there\\u0021"}'),
        finishChunk('tool_calls'),
        '[DONE]',
      ]),
    );

    expect(heard).toEqual([
      {reply: 0, text: 'Hi'},
      {reply: 0, text: ' there!'},
    ]);
    expect(JSON.parse(output.rawOutputText)).toEqual({
      toolCalls: [
        {name: visibleReplyModelToolName, input: {text: 'Hi there!'}},
      ],
    });
  });

  it('holds reasoning back and never speaks it, whole or split', async () => {
    const {output, heard} = await invokeStreaming(
      sseResponse([
        contentChunk('<thi'),
        contentChunk('nk>secret</think>Hel'),
        contentChunk('lo'),
        finishChunk('stop'),
        '[DONE]',
      ]),
    );

    expect(heard).toEqual([
      {reply: 0, text: 'Hel'},
      {reply: 0, text: 'lo'},
    ]);
    expect(output.rawOutputText).not.toContain('secret');
    expect(JSON.parse(output.rawOutputText)).toEqual({
      toolCalls: [{name: visibleReplyModelToolName, input: {text: 'Hello'}}],
    });
  });

  it("keeps the model's note out of the reply: content beside a visible_reply call is its own draft", async () => {
    const {output, heard} = await invokeStreaming(
      sseResponse([
        contentChunk('thinking aloud'),
        argumentsChunk('{"text": "Hi"}', true),
        finishChunk('tool_calls'),
        '[DONE]',
      ]),
    );

    expect(heard).toEqual([
      {reply: 0, text: 'thinking aloud'},
      {reply: 1, text: 'Hi'},
    ]);
    expect(output.replyDrafts).toEqual([1]);
    expect(JSON.parse(output.rawOutputText)).toEqual({
      toolCalls: [{name: visibleReplyModelToolName, input: {text: 'Hi'}}],
      text: 'thinking aloud',
    });

    const alone = await invokeStreaming(
      sseResponse([contentChunk('Hello'), finishChunk('stop'), '[DONE]']),
    );

    expect(alone.output.replyDrafts).toEqual([0]);
  });

  it('starts the silence bound over when the headers arrive', async () => {
    const wait = (ms: number) =>
      new Promise<void>(resolve => setTimeout(resolve, ms));
    const {output} = await invokeStreaming(
      async () => {
        await wait(200);

        return new Response(
          new ReadableStream({
            async pull(controller) {
              await wait(200);
              controller.enqueue(
                new TextEncoder().encode(
                  sseText([
                    contentChunk('late'),
                    finishChunk('stop'),
                    '[DONE]',
                  ]),
                ),
              );
              controller.close();
            },
          }),
        );
      },
      {requestTimeoutMs: 300},
    );

    // Headers after 200 ms and the first chunk 200 ms later: neither wait
    // reached the bound, though together they passed it.
    expect(output.rejection).toBeUndefined();
    expect(JSON.parse(output.rawOutputText)).toEqual({
      toolCalls: [{name: visibleReplyModelToolName, input: {text: 'late'}}],
    });
  });

  it('reports a stream that breaks mid-reply as a provider error with no raw text', async () => {
    const {output, heard} = await invokeStreaming(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(sseText([contentChunk('Hel')])),
            );
          },
          pull(controller) {
            controller.error(new Error('connection reset'));
          },
        }),
      ),
    );

    expect(heard).toEqual([{reply: 0, text: 'Hel'}]);
    expect(output.rawOutputText).toBe('');
    expect(output.rejection).toEqual({
      reason: roleModelProviderErrorRejectionReason,
      details: 'connection reset',
    });
    expect(output.providerMetadata?.error?.code).toBe('provider_error');
  });

  it('names a timeout that the abort delivers ahead of the timer', async () => {
    const {output} = await invokeStreaming(
      (request?: unknown) => {
        const signal = (request as {signal?: AbortSignal} | undefined)?.signal;

        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                signal?.addEventListener('abort', () => {
                  controller.error(new Error('aborted by the client'));
                });
              },
              pull() {
                return new Promise(() => undefined);
              },
            }),
          ),
        );
      },
      {requestTimeoutMs: 5},
    );

    expect(output.rejection?.details).toBe(
      'NVIDIA provider request timed out after 5ms.',
    );
    expect(output.providerMetadata?.error?.code).toBe('request_timeout');
  });

  it('bounds silence, not the exchange: a slow but steady stream completes past the old whole-request bound', async () => {
    const pieces = [
      contentChunk('a'),
      contentChunk('b'),
      contentChunk('c'),
      contentChunk('d'),
      finishChunk('stop'),
      '[DONE]',
    ];
    let next = 0;
    const {output} = await invokeStreaming(
      new Response(
        new ReadableStream({
          async pull(controller) {
            await new Promise(resolve => setTimeout(resolve, 30));

            const piece = pieces[next];

            next += 1;

            if (piece === undefined) {
              controller.close();
              return;
            }

            controller.enqueue(new TextEncoder().encode(sseText([piece])));
          },
        }),
      ),
      {requestTimeoutMs: 100},
    );

    expect(output.rejection).toBeUndefined();
    expect(JSON.parse(output.rawOutputText)).toEqual({
      toolCalls: [{name: visibleReplyModelToolName, input: {text: 'abcd'}}],
    });
  });

  it('refuses a stream cut before its finish reason as a malformed response', async () => {
    const {output} = await invokeStreaming(
      sseResponse([contentChunk('Hel'), '[DONE]']),
    );

    expect(output.rejection).toEqual({
      reason: roleModelProviderErrorRejectionReason,
      details: 'NVIDIA response choice.finish_reason is required.',
    });
    expect(output.providerMetadata?.error?.code).toBe('malformed_response');
  });
});
