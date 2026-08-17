import {testCharacterProfile} from '../support/character-fixtures.ts';
import {describe, expect, it} from 'vitest';
import {createConversationSession} from '../../src/core/index.ts';
import {createRuntimePluginHost} from '../../src/plugins/host/index.ts';
import {createRuntimeLogStore} from '../../src/runtime/evidence/index.ts';
import {type RoleModelChatMessage} from '../../src/role-model/index.ts';
import {
  createNativePluginListAdapter,
  createNativeVisibleReplyAndPluginListAdapter,
  createPluginStoreRevisionFixtureHost,
  runLocalUserMessageEventWithDefaultTestHost as runLocalUserMessageEvent,
} from '../support/plugin-tool-loop-fixtures.ts';
import {
  createSequencedAdapter,
  createTestEvent,
} from '../support/role-model-loop-fixtures.ts';

describe('plugin-driven native tool loop routing', () => {
  it('feeds native assistant tool calls back as OpenAI tool result messages', async () => {
    const session = createConversationSession({
      character: testCharacterProfile,
    });
    const logStore = createRuntimeLogStore();
    const messagesByRound: RoleModelChatMessage[][] = [];
    const adapter = createNativePluginListAdapter(messagesByRound);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('what plugins are available?', 'evt_native_tools'),
      session,
      logStore,
      roleModelAdapter: adapter,
    });

    expect(result.status).toBe('completed');
    expect(
      logStore.conversationMessages().map(message => message.text),
    ).toEqual(['what plugins are available?', 'Plugins are available.']);
    expect(messagesByRound).toHaveLength(2);
    expect(messagesByRound[0]?.map(message => message.role)).toEqual([
      'system',
      'system',
      'system',
      'user',
    ]);
    expect(messagesByRound[1]?.map(message => message.role)).toEqual([
      'system',
      'system',
      'system',
      'user',
      'assistant',
      'tool',
    ]);
    expect(messagesByRound[1]?.[4]).toMatchObject({
      role: 'assistant',
      content: 'Checking plugins.',
      tool_calls: [
        {
          id: 'call_runtime_plugin_list',
          function: {
            name: 'runtime.plugin.list',
            arguments: '{}',
          },
        },
      ],
    });
    expect(messagesByRound[1]?.[5]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_runtime_plugin_list',
    });
    expect(messagesByRound[1]?.[5]?.content).toContain(
      '"toolName":"runtime.plugin.list"',
    );
    expect(messagesByRound[1]?.[5]?.content).toContain('"status":"accepted"');
  });

  it('answers every native tool call when visible_reply shares an executable tool round', async () => {
    const session = createConversationSession({
      character: testCharacterProfile,
    });
    const logStore = createRuntimeLogStore();
    const messagesByRound: RoleModelChatMessage[][] = [];
    const adapter =
      createNativeVisibleReplyAndPluginListAdapter(messagesByRound);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent(
        'check plugins with progress',
        'evt_native_visible_tool',
      ),
      session,
      logStore,
      roleModelAdapter: adapter,
    });

    expect(result.status).toBe('completed');
    expect(
      logStore.conversationMessages().map(message => message.text),
    ).toEqual([
      'check plugins with progress',
      'Checking plugins.',
      'Plugins are available after progress.',
    ]);
    expect(messagesByRound).toHaveLength(2);
    expect(messagesByRound[1]?.map(message => message.role)).toEqual([
      'system',
      'system',
      'system',
      'user',
      'assistant',
      'tool',
      'tool',
    ]);
    expect(messagesByRound[1]?.[4]).toMatchObject({
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_visible_reply',
          function: {
            name: 'visible_reply',
            arguments: '{"text":"Checking plugins."}',
          },
        },
        {
          id: 'call_runtime_plugin_list_with_visible',
          function: {
            name: 'runtime.plugin.list',
            arguments: '{}',
          },
        },
      ],
    });
    expect(messagesByRound[1]?.[5]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_visible_reply',
    });
    expect(messagesByRound[1]?.[5]?.content).toContain(
      '"toolName":"visible_reply"',
    );
    expect(messagesByRound[1]?.[6]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_runtime_plugin_list_with_visible',
    });
    expect(messagesByRound[1]?.[6]?.content).toContain(
      '"toolName":"runtime.plugin.list"',
    );
    expect(messagesByRound[1]?.[6]?.content).toContain('"status":"accepted"');
  });

  it('hands a native tool call with non-object arguments back to the model', async () => {
    const session = createConversationSession({
      character: testCharacterProfile,
    });
    const logStore = createRuntimeLogStore();
    const messagesByRound: RoleModelChatMessage[][] = [];
    const adapter = createSequencedAdapter(
      [
        // What NVIDIA hands the parser when the model's arguments were not
        // a JSON object: the string, as written.
        {toolCalls: [{name: 'runtime.plugin.list', input: '{"score":'}]},
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: {text: 'Recovered after the argument error.'},
            },
          ],
        },
      ],
      invocation => {
        messagesByRound.push([...invocation.turnContext.messages]);
      },
    );

    const result = await runLocalUserMessageEvent({
      event: createTestEvent(
        'check plugins after bad args',
        'evt_native_bad_args',
      ),
      session,
      logStore,
      roleModelAdapter: adapter,
    });

    expect(result.status).toBe('completed');
    expect(messagesByRound).toHaveLength(2);
    // The refusal is a note in the next round, not a tool result: no call
    // was made, so nothing was dispatched or recorded as a tool event.
    const note = messagesByRound[1]?.find(
      message =>
        message.role === 'system' &&
        message.content.startsWith('Your last reply could not be used.'),
    );

    expect(note?.content).toContain('runtime.plugin.list');
    expect(note?.content).toContain('must be a JSON object');
    expect(
      logStore.rawEvents().some(event => event.kind === 'tool_call_started'),
    ).toBe(false);
  });

  it('returns undeclared executable tools to the model without dispatching them', async () => {
    const session = createConversationSession({
      character: testCharacterProfile,
    });
    const logStore = createRuntimeLogStore();
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'memory.unknown',
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
            input: {text: 'that tool is unavailable'},
          },
        ],
      },
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('try unknown', 'evt_unknown_tool'),
      session,
      logStore,
      roleModelAdapter: adapter,
    });

    expect(result.status).toBe('completed');
    const toolFinishedEvents = logStore
      .rawEvents()
      .filter(event => event.kind === 'tool_call_finished');
    expect(toolFinishedEvents).toHaveLength(1);
    expect(toolFinishedEvents[0]).toMatchObject({
      dispatchedToHost: false,
      toolName: 'memory.unknown',
      toolResult: {
        status: 'rejected',
        reason: 'tool_not_declared',
      },
    });
    expect(
      logStore
        .conversationMessages()
        .some(message => message.text === 'that tool is unavailable'),
    ).toBe(true);
  });

  it('does not synthesize Character State when the injected host omits it', async () => {
    const session = createConversationSession({
      character: testCharacterProfile,
    });
    const logStore = createRuntimeLogStore();
    const pluginHost = createRuntimePluginHost({plugins: []});
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'character_state.patch',
            input: {mood: 'curious'},
          },
        ],
      },
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('update state', 'evt_character_state_omitted'),
      session,
      logStore,
      roleModelAdapter: adapter,
      pluginHost,
      maxToolRounds: 1,
    });

    expect(result.status).toBe('rejected');
    const dispatchedToolEvents = logStore
      .rawEvents()
      .filter(
        event =>
          event.kind === 'tool_call_finished' &&
          event.dispatchedToHost === true,
      );
    expect(dispatchedToolEvents).toEqual([]);
    const finished = logStore
      .rawEvents()
      .filter(event => event.kind === 'tool_call_finished');
    expect(finished[0]).toMatchObject({
      toolName: 'character_state.patch',
      toolResult: {
        status: 'rejected',
        reason: 'tool_not_declared',
      },
    });
  });

  it('logs only valid pluginStoreRevision metadata from accepted tool output', async () => {
    const session = createConversationSession({
      character: testCharacterProfile,
    });
    const logStore = createRuntimeLogStore();
    const pluginHost = createPluginStoreRevisionFixtureHost();
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'revision.zero',
            input: {},
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'revision.valid',
            input: {},
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'revision metadata checked',
            },
          },
        ],
      },
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('check revisions', 'evt_plugin_store_revision'),
      session,
      logStore,
      roleModelAdapter: adapter,
      pluginHost,
    });
    const toolCallFinishedEvents = logStore
      .rawEvents()
      .filter(event => event.kind === 'tool_call_finished');

    expect(result.status).toBe('completed');
    expect(toolCallFinishedEvents).toHaveLength(2);
    expect(toolCallFinishedEvents[0]).toMatchObject({
      toolName: 'revision.zero',
    });
    expect(toolCallFinishedEvents[0]).not.toHaveProperty('pluginStoreRevision');
    expect(toolCallFinishedEvents[1]).toMatchObject({
      toolName: 'revision.valid',
      pluginStoreRevision: 2,
    });
  });
});
