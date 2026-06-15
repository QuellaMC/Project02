import { describe, expect, it } from 'vitest';

import {
  createDecisionContext,
  createRoleModelInputEnvelope
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
  renderRoleModelTurnContext
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
      'call plugin.list and use its tool result'
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
      'plugin.list',
      'character_state.patch'
    ]);
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
      tools.find((tool) => tool.function.name === 'plugin.list')
        ?.function.description
    ).toContain('available to you');
    expect(
      tools.find((tool) => tool.function.name === 'character_state.patch')
        ?.function.description
    ).toContain('your current Character State');
    expect(
      tools.find((tool) => tool.function.name === 'plugin.list')
        ?.function.parameters.additionalProperties
    ).toBe(false);
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

  it('normalizes native assistant tool calls without parsing content as JSON', async () => {
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
                      name: 'plugin.list',
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
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'secret',
      fetchClient
    });
    const inputEnvelope = createNvidiaTestInputEnvelope();
    const output = await adapter.invoke(inputEnvelope, {
      turnContext: renderRoleModelTurnContext(inputEnvelope)
    });

    expect(JSON.parse(output.rawOutputText)).toEqual({
      toolCalls: [
        {
          name: 'plugin.list',
          input: {}
        }
      ],
      text: 'Checking the available plugins.'
    });
    expect(output.nativeAssistantMessage?.tool_calls?.[0]).toMatchObject({
      id: 'call_plugin_list',
      function: {
        name: 'plugin.list',
        arguments: '{}'
      }
    });
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
                      name: 'plugin.list',
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
