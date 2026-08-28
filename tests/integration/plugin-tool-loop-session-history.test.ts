import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {testCharacterProfile} from '../support/character-fixtures.ts';
import {createDefaultProject02PluginHost} from '../support/default-plugin-host.ts';
import {jsonArray, jsonRecord} from '../support/json-view.ts';
import {
  createSequencedAdapter,
  createTestEvent,
} from '../support/role-model-loop-fixtures.ts';
import {writeDurableSession} from '../support/runtime-log-fixtures.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

import {createSession} from '../../src/core/index.ts';
import {
  characterStatePluginId,
  runtimePluginId,
  sessionHistoryPluginId,
  sessionHistorySearchToolName,
} from '../../src/plugins/api/contract.ts';
import {createRuntimeLogStore} from '../../src/runtime/evidence/index.ts';
import {createFileRuntimeLogStore} from '../../src/runtime/storage/file-runtime-log-store.ts';
import {createLocalRuntimeSessionPaths} from '../../src/runtime/storage/layout-contract.ts';
import {
  createLocalRuntimeSessionHistoryFeed,
  createRuntimePluginDatabaseProvider,
} from '../../src/runtime/storage/index.ts';
import {runLocalUserMessageEventWithDefaultTestHost as runLocalUserMessageEvent} from '../support/plugin-tool-loop-fixtures.ts';

describe('session history through the tool loop', () => {
  it('recalls a past session and replies from what it found', async () => {
    const storeRoot = createTestTempRoot('project02-history-loop-');

    await writeDurableSession({
      storeRoot,
      conversationId: 'earlier',
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
        characterStatePluginId,
        sessionHistoryPluginId,
      ],
    });
    const session = createSession({
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

  it('recalls messages that scrolled out of the model window in the same session', async () => {
    const storeRoot = createTestTempRoot('project02-history-window-');
    const conversationId = 'local-session';
    const sessionId = `${conversationId}.1`;
    const exchanges: readonly [string, string][] = [
      ['the wifi password is stormlight42', 'Saved it, I will remember.'],
      ...Array.from({length: 5}, (_, index): [string, string] => [
        `filler question ${String(index + 1)}`,
        `filler answer ${String(index + 1)}`,
      ]),
    ];

    await writeDurableSession({storeRoot, conversationId, exchanges});

    // Restore the same transcript the store holds; with a 256-token context
    // window the history budget (half of it) holds the five filler turns and
    // not the wifi exchange, which sits beyond what the model sees.
    const session = createSession({
      id: sessionId,
      character: testCharacterProfile,
      visibleTranscript: exchanges.flatMap(
        ([userText, characterText], turn) => [
          {
            id: `${sessionId}:message-${String(turn * 2 + 1)}`,
            role: 'user' as const,
            speakerId: 'local-user',
            speakerName: 'You',
            text: userText,
          },
          {
            id: `${sessionId}:message-${String(turn * 2 + 2)}`,
            role: 'character' as const,
            speakerId: testCharacterProfile.id,
            speakerName: testCharacterProfile.displayName,
            text: characterText,
          },
        ],
      ),
    });
    const pluginHost = createDefaultProject02PluginHost({
      sessionHistory: createLocalRuntimeSessionHistoryFeed({
        storeRoot,
        characterId: testCharacterProfile.id,
      }),
      pluginDatabase: createRuntimePluginDatabaseProvider({storeRoot}),
      enabledPluginIds: [
        runtimePluginId,
        characterStatePluginId,
        sessionHistoryPluginId,
      ],
    });
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {name: sessionHistorySearchToolName, input: {query: 'stormlight42'}},
        ],
      },
      {
        toolCalls: [
          {name: sessionHistorySearchToolName, input: {query: 'zephyr77'}},
        ],
      },
      {
        toolCalls: [
          {name: 'visible_reply', input: {text: 'It was stormlight42.'}},
        ],
      },
    ]);
    const result = await runLocalUserMessageEvent({
      event: createTestEvent(
        'what was the wifi password again? my locker code is zephyr77 now.',
        'evt_history_window',
      ),
      session,
      logStore: createFileRuntimeLogStore({
        boundCharacter: testCharacterProfile,
        characterId: testCharacterProfile.id,
        storeRoot,
        sessionId,
      }),
      roleModelAdapter: adapter,
      pluginHost,
      contextWindowTokens: 256,
    });

    expect(result.status).toBe('completed');

    const searchResults = readFileSync(
      createLocalRuntimeSessionPaths({storeRoot, sessionId}).rawEventsPath,
      'utf8',
    )
      .trim()
      .split('\n')
      .map(line => jsonRecord(JSON.parse(line)))
      .filter(record => record['kind'] === 'tool_call_finished')
      .map(record => jsonRecord(jsonRecord(record['toolResult'])['output']));

    expect(searchResults).toHaveLength(2);

    // The recalled hit is the out-of-window message, not anything the
    // model already sees.
    expect(searchResults[0]).toMatchObject({totalSessionsWithHits: 1});

    const matched = jsonArray(
      jsonRecord(jsonArray(searchResults[0]?.['sessions'])[0])['aroundMatch'],
    )
      .map(row => jsonRecord(row))
      .find(row => row['matched'] === true);

    expect(matched?.['messageId']).toBe(`${sessionId}:message-1`);

    // The just-committed user message carries "zephyr77", but what the
    // model already sees never matches.
    expect(searchResults[1]).toMatchObject({totalSessionsWithHits: 0});
  });

  it('never returns the model its own interim reply from the same turn', async () => {
    const storeRoot = createTestTempRoot('project02-history-interim-');
    const conversationId = 'local-session';
    const sessionId = `${conversationId}.1`;

    // An empty durable session: the whole turn, including the interim
    // reply, commits into the store the search index reads.
    await writeDurableSession({
      storeRoot,
      conversationId,
      exchanges: [],
    });

    const pluginHost = createDefaultProject02PluginHost({
      sessionHistory: createLocalRuntimeSessionHistoryFeed({
        storeRoot,
        characterId: testCharacterProfile.id,
      }),
      pluginDatabase: createRuntimePluginDatabaseProvider({storeRoot}),
      enabledPluginIds: [
        runtimePluginId,
        characterStatePluginId,
        sessionHistoryPluginId,
      ],
    });
    // The interim reply commits before the search in the same round; the
    // search must not surface the words the model just said.
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {text: 'One moment, the secret phrase is glimmerwing.'},
          },
          {name: sessionHistorySearchToolName, input: {query: 'glimmerwing'}},
        ],
      },
      {
        toolCalls: [
          {name: 'visible_reply', input: {text: 'Nothing else came up.'}},
        ],
      },
    ]);
    const result = await runLocalUserMessageEvent({
      event: createTestEvent('what was that phrase?', 'evt_history_interim'),
      session: createSession({
        id: sessionId,
        character: testCharacterProfile,
      }),
      logStore: createFileRuntimeLogStore({
        boundCharacter: testCharacterProfile,
        characterId: testCharacterProfile.id,
        storeRoot,
        sessionId,
      }),
      roleModelAdapter: adapter,
      pluginHost,
    });

    expect(result.status).toBe('completed');

    const searchResults = readFileSync(
      createLocalRuntimeSessionPaths({storeRoot, sessionId}).rawEventsPath,
      'utf8',
    )
      .trim()
      .split('\n')
      .map(line => jsonRecord(JSON.parse(line)))
      .filter(record => record['kind'] === 'tool_call_finished')
      .map(record => jsonRecord(jsonRecord(record['toolResult'])['output']));

    expect(searchResults).toEqual([
      expect.objectContaining({totalSessionsWithHits: 0}),
    ]);
  });
});
