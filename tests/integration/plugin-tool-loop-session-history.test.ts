import {describe, expect, it} from 'vitest';

import {testCharacterProfile} from '../support/character-fixtures.ts';
import {createDefaultProject02PluginHost} from '../support/default-plugin-host.ts';
import {
  createSequencedAdapter,
  createTestEvent,
} from '../support/role-model-loop-fixtures.ts';
import {writeDurableConversationSession} from '../support/runtime-log-fixtures.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

import {createConversationSession} from '../../src/core/index.ts';
import {
  characterStatePluginId,
  firstPartyModelToolsPluginId,
  runtimePluginId,
  sessionHistoryPluginId,
  sessionHistorySearchToolName,
} from '../../src/plugins/api/contract.ts';
import {createRuntimeLogStore} from '../../src/runtime/evidence/index.ts';
import {
  createLocalRuntimeSessionHistoryFeed,
  createRuntimePluginDatabaseProvider,
} from '../../src/runtime/storage/index.ts';
import {runLocalUserMessageEventWithDefaultTestHost as runLocalUserMessageEvent} from '../support/plugin-tool-loop-fixtures.ts';

describe('session history through the tool loop', () => {
  it('recalls a past session and replies from what it found', async () => {
    const storeRoot = createTestTempRoot('project02-history-loop-');

    await writeDurableConversationSession({
      storeRoot,
      sessionId: 'earlier',
      exchanges: [
        [
          'remember the passphrase riddle?',
          'It was about a silent drawbridge.',
        ],
      ],
    });

    const pluginHost = createDefaultProject02PluginHost({
      sessionHistory: createLocalRuntimeSessionHistoryFeed({
        storeRoot,
        characterId: testCharacterProfile.id,
      }),
      pluginDatabase: createRuntimePluginDatabaseProvider({storeRoot}),
      enabledPluginIds: [
        runtimePluginId,
        firstPartyModelToolsPluginId,
        characterStatePluginId,
        sessionHistoryPluginId,
      ],
    });
    const session = createConversationSession({
      character: testCharacterProfile,
    });
    const logStore = createRuntimeLogStore();
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: sessionHistorySearchToolName,
            input: {query: 'drawbridge'},
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {text: 'It was the silent drawbridge riddle.'},
          },
        ],
      },
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('what was that riddle?', 'evt_history_loop'),
      session,
      logStore,
      roleModelAdapter: adapter,
      pluginHost,
    });

    expect(result.status).toBe('completed');
    expect(
      logStore.conversationMessages().map(message => message.text),
    ).toEqual([
      'what was that riddle?',
      'It was the silent drawbridge riddle.',
    ]);

    const toolEvents = logStore
      .rawEvents()
      .filter(event => event.kind.startsWith('tool_call'));

    expect(toolEvents.map(event => event.kind)).toEqual([
      'tool_call_started',
      'tool_call_finished',
    ]);
    expect(toolEvents[0]).toMatchObject({
      toolName: sessionHistorySearchToolName,
      toolPluginId: sessionHistoryPluginId,
      toolInput: {query: 'drawbridge'},
    });
    expect(toolEvents[1]).toMatchObject({
      dispatchedToHost: true,
      toolName: sessionHistorySearchToolName,
      toolResult: {status: 'accepted'},
    });
  });
});
