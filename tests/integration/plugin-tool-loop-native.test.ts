import { describe, expect, it } from 'vitest';
import { createConversationSession } from '../../src/core/index.ts';
import { createRuntimePluginHost } from '../../src/plugins/host/index.ts';
import { createRuntimeLogStore } from '../../src/runtime/evidence/index.ts';
import {
  type RoleModelAdapter,
  type RoleModelChatMessage
} from '../../src/role-model/index.ts';
import {
  createNativePluginListAdapter,
  createNativeVisibleReplyAndPluginListAdapter,
  createPluginStoreRevisionFixtureHost,
  createSequencedAdapter,
  createTestEvent,
  runLocalUserMessageEventWithDefaultTestHost as runLocalUserMessageEvent
} from '../support/plugin-tool-loop-fixtures.ts';

describe('plugin-driven native tool loop routing', () => {
  it('feeds native assistant tool calls back as OpenAI tool result messages', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const messagesByRound: RoleModelChatMessage[][] = [];
    const adapter = createNativePluginListAdapter(messagesByRound);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('what plugins are available?', 'evt_native_tools'),
      session,
      logStore,
      roleModelAdapter: adapter
    });

    expect(result.status).toBe('completed');
    expect(logStore.conversationMessages().map((message) => message.text)).toEqual([
      'what plugins are available?',
      'Plugins are available.'
    ]);
    expect(messagesByRound).toHaveLength(2);
    expect(messagesByRound[0]?.map((message) => message.role)).toEqual([
      'system',
      'system',
      'user',
      'user'
    ]);
    expect(messagesByRound[1]?.map((message) => message.role)).toEqual([
      'system',
      'system',
      'user',
      'user',
      'assistant',
      'tool'
    ]);
    expect(messagesByRound[1]?.[4]).toMatchObject({
      role: 'assistant',
      content: 'Checking plugins.',
      tool_calls: [
        {
          id: 'call_runtime_plugin_list',
          function: {
            name: 'runtime.plugin.list',
            arguments: '{}'
          }
        }
      ]
    });
    expect(messagesByRound[1]?.[5]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_runtime_plugin_list'
    });
    expect(messagesByRound[1]?.[5]?.content).toContain('"toolName":"runtime.plugin.list"');
    expect(messagesByRound[1]?.[5]?.content).toContain('"status":"accepted"');
  });

  it('answers every native tool call when visible_reply shares an executable tool round', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const messagesByRound: RoleModelChatMessage[][] = [];
    const adapter =
      createNativeVisibleReplyAndPluginListAdapter(messagesByRound);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('check plugins with progress', 'evt_native_visible_tool'),
      session,
      logStore,
      roleModelAdapter: adapter
    });

    expect(result.status).toBe('completed');
    expect(logStore.conversationMessages().map((message) => message.text)).toEqual([
      'check plugins with progress',
      'Plugins are available after progress.'
    ]);
    expect(messagesByRound).toHaveLength(2);
    expect(messagesByRound[1]?.map((message) => message.role)).toEqual([
      'system',
      'system',
      'user',
      'user',
      'assistant',
      'tool',
      'tool'
    ]);
    expect(messagesByRound[1]?.[4]).toMatchObject({
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_visible_reply',
          function: {
            name: 'visible_reply',
            arguments: '{"text":"Checking plugins."}'
          }
        },
        {
          id: 'call_runtime_plugin_list_with_visible',
          function: {
            name: 'runtime.plugin.list',
            arguments: '{}'
          }
        }
      ]
    });
    expect(messagesByRound[1]?.[5]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_visible_reply'
    });
    expect(messagesByRound[1]?.[5]?.content).toContain(
      '"toolName":"visible_reply"'
    );
    expect(messagesByRound[1]?.[6]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_runtime_plugin_list_with_visible'
    });
    expect(messagesByRound[1]?.[6]?.content).toContain('"toolName":"runtime.plugin.list"');
    expect(messagesByRound[1]?.[6]?.content).toContain('"status":"accepted"');
  });

  it('feeds native tool argument errors back as rejected tool result messages', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const messagesByRound: RoleModelChatMessage[][] = [];
    let index = 0;
    const adapter: RoleModelAdapter = Object.freeze({
      invoke(_inputEnvelope, invocation) {
        messagesByRound.push([...invocation.turnContext.messages]);
        index += 1;

        if (index === 1) {
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'runtime.plugin.list',
                  input: {}
                }
              ]
            }),
            nativeAssistantMessage: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_bad_args',
                  type: 'function',
                  function: {
                    name: 'runtime.plugin.list',
                    arguments: '{"score":1e999}'
                  }
                }
              ]
            },
            nativeToolCallArgumentErrors: [
              {
                executableIndex: 0,
                toolName: 'runtime.plugin.list',
                reason: 'invalid_native_tool_arguments',
                message: 'runtime.plugin.list arguments must contain finite JSON values.'
              }
            ]
          };
        }

        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {
                name: 'visible_reply',
                input: {
                  text: 'Recovered after argument error.'
                }
              }
            ]
          })
        };
      }
    });

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('check plugins after bad args', 'evt_native_bad_args'),
      session,
      logStore,
      roleModelAdapter: adapter
    });

    expect(result.status).toBe('completed');
    expect(messagesByRound).toHaveLength(2);
    expect(messagesByRound[1]?.map((message) => message.role)).toEqual([
      'system',
      'system',
      'user',
      'user',
      'assistant',
      'tool'
    ]);
    expect(messagesByRound[1]?.[5]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_bad_args'
    });
    expect(messagesByRound[1]?.[5]?.content).toContain('"status":"rejected"');
    expect(messagesByRound[1]?.[5]?.content).toContain(
      '"reason":"invalid_native_tool_arguments"'
    );
    expect(
      logStore.rawEvents().find((event) => event.kind === 'tool_call_finished')
    ).toMatchObject({
      dispatchedToHost: false,
      toolName: 'runtime.plugin.list',
      toolResult: {
        status: 'rejected',
        reason: 'invalid_native_tool_arguments'
      }
    });
  });

  it('rejects undeclared executable tools before routing', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'memory.unknown',
            input: {
              query: 'Mira'
            }
          }
        ]
      }
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('try unknown', 'evt_unknown_tool'),
      session,
      logStore,
      roleModelAdapter: adapter
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'disallowed_tool',
      message: 'Decision requested disallowed tool memory.unknown.'
    });
    expect(logStore.conversationMessages()).toEqual([]);
    expect(
      logStore.rawEvents().some((event) => event.kind.startsWith('tool_call'))
    ).toBe(false);
  });

  it('does not synthesize Character State when the injected host omits it', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const pluginHost = createRuntimePluginHost({ plugins: [] });
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'character_state.patch',
            input: { mood: 'curious' }
          }
        ]
      }
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('update state', 'evt_character_state_omitted'),
      session,
      logStore,
      roleModelAdapter: adapter,
      pluginHost
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'disallowed_tool',
      message: 'Decision requested disallowed tool character_state.patch.'
    });
    expect(
      logStore.rawEvents().some((event) => event.kind.startsWith('tool_call'))
    ).toBe(false);
  });

  it('logs only valid pluginStoreRevision metadata from accepted tool output', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const pluginHost = createPluginStoreRevisionFixtureHost();
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'revision.zero',
            input: {}
          }
        ]
      },
      {
        toolCalls: [
          {
            name: 'revision.valid',
            input: {}
          }
        ]
      },
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'revision metadata checked'
            }
          }
        ]
      }
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('check revisions', 'evt_plugin_store_revision'),
      session,
      logStore,
      roleModelAdapter: adapter,
      pluginHost
    });
    const toolCallFinishedEvents = logStore
      .rawEvents()
      .filter((event) => event.kind === 'tool_call_finished');

    expect(result.status).toBe('completed');
    expect(toolCallFinishedEvents).toHaveLength(2);
    expect(toolCallFinishedEvents[0]).toMatchObject({
      toolName: 'revision.zero'
    });
    expect(toolCallFinishedEvents[0]).not.toHaveProperty(
      'pluginStoreRevision'
    );
    expect(toolCallFinishedEvents[1]).toMatchObject({
      toolName: 'revision.valid',
      pluginStoreRevision: 2
    });
  });
});
