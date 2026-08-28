import {
  appendFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {describe, expect, it} from 'vitest';

import {testCharacterProfile} from '../support/character-fixtures.ts';
import {jsonArray, jsonRecord} from '../support/json-view.ts';
import {createTestPluginContext} from '../support/role-model-loop-fixtures.ts';
import {writeDurableSession} from '../support/runtime-log-fixtures.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

import {existsSync} from 'node:fs';

import {createRuntimeEventIdentity} from '../../src/core/index.ts';
import {
  createRuntimePluginAfterTurnCommittedContext,
  createRuntimePluginContext,
} from '../../src/plugins/api/index.ts';
import {
  runtimePluginId,
  sessionHistoryPluginId,
  sessionHistoryReadToolName,
  sessionHistorySearchToolName,
} from '../../src/plugins/api/contract.ts';
import {
  createRuntimePluginHost,
  type RuntimePluginHost,
} from '../../src/plugins/host/index.ts';
import {createSessionHistoryPlugin} from '../../src/plugins/packages/session-history/plugin.ts';
import {join} from 'node:path';

import {
  characterPluginDataDirPath,
  createLocalRuntimeSessionPaths,
} from '../../src/runtime/storage/layout-contract.ts';
import {
  createLocalRuntimeSessionHistoryFeed,
  createRuntimePluginDatabaseProvider,
} from '../../src/runtime/storage/index.ts';

const enabledWithSessionHistory = [runtimePluginId, sessionHistoryPluginId];

describe('session history plugin through the host', () => {
  it('serves search and anchored reads over a real store', async () => {
    const {host} = await createHistoryHost();
    const searchResult = await host.handleToolCall(
      historyToolCall('evt_history_search', sessionHistorySearchToolName, {
        query: 'permission',
      }),
      createTestPluginContext('evt_history_search'),
    );

    expect(searchResult.status).toBe('accepted');
    if (searchResult.status !== 'accepted') {
      throw new Error('Expected sessions.search to be accepted.');
    }

    expect(searchResult.output).toMatchObject({
      totalSessionsWithHits: 1,
      damagedRecordsSkipped: 0,
    });

    const sessions = jsonArray(jsonRecord(searchResult.output)['sessions']);

    expect(sessions).toHaveLength(1);
    expect(jsonRecord(sessions[0])['sessionId']).toBe('alpha.1');

    const matchedRows = jsonArray(jsonRecord(sessions[0])['aroundMatch'])
      .map(row => jsonRecord(row))
      .filter(row => row['matched'] === true);

    expect(matchedRows).toHaveLength(1);
    expect(String(matchedRows[0]?.['snippet'])).toContain('permission');

    const readResult = await host.handleToolCall(
      historyToolCall('evt_history_read', sessionHistoryReadToolName, {
        sessionId: 'alpha.1',
        anchorMessageId: 'alpha.1:message-1',
        window: 1,
      }),
      createTestPluginContext('evt_history_read'),
    );

    expect(readResult.status).toBe('accepted');
    if (readResult.status !== 'accepted') {
      throw new Error('Expected sessions.read to be accepted.');
    }

    expect(readResult.output).toMatchObject({
      sessionId: 'alpha.1',
      hasBefore: false,
      hasAfter: true,
    });
  });

  it('always advertises the tools and rejects without providers', async () => {
    const {host} = await createHistoryHost();
    // A host without the capability providers (minimal test hosts) leaves
    // the context capabilities absent; the plugin rejects politely.
    const bareHost = createRuntimePluginHost({
      plugins: [createSessionHistoryPlugin()],
      enabledPluginIds: enabledWithSessionHistory,
    });

    for (const configuredHost of [host, bareHost]) {
      expect(
        configuredHost.pluginToolDefinitions().map(tool => tool.name),
      ).toEqual(
        expect.arrayContaining([
          sessionHistorySearchToolName,
          sessionHistoryReadToolName,
        ]),
      );
    }

    const forced = await bareHost.handleToolCall(
      historyToolCall('evt_history_bare', sessionHistorySearchToolName, {
        query: 'anything',
      }),
      createTestPluginContext('evt_history_bare'),
    );

    expect(forced).toMatchObject({
      status: 'rejected',
      reason: 'session_history_tool_unavailable',
    });
  });

  it('rejects malformed input at the host boundary', async () => {
    const {host} = await createHistoryHost();
    const result = await host.handleToolCall(
      historyToolCall('evt_history_invalid', sessionHistorySearchToolName, {}),
      createTestPluginContext('evt_history_invalid'),
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'invalid_input',
    });
  });

  it('maps unknown sessions and storage damage to honest results', async () => {
    const {host, storeRoot} = await createHistoryHost();
    const unknownSession = await host.handleToolCall(
      historyToolCall('evt_history_unknown', sessionHistoryReadToolName, {
        sessionId: 'nope',
      }),
      createTestPluginContext('evt_history_unknown'),
    );

    expect(unknownSession).toMatchObject({
      status: 'rejected',
      reason: 'session_not_found',
    });

    appendFileSync(
      createLocalRuntimeSessionPaths({storeRoot, sessionId: 'alpha.1'})
        .rawEventsPath,
      'not-json\n',
      'utf8',
    );

    const damaged = await host.handleToolCall(
      historyToolCall('evt_history_damaged', sessionHistorySearchToolName, {
        query: 'permission',
      }),
      createTestPluginContext('evt_history_damaged'),
    );

    expect(damaged.status).toBe('accepted');
    if (damaged.status !== 'accepted') {
      throw new Error('Expected the damaged-store search to be accepted.');
    }

    expect(damaged.output).toMatchObject({
      totalSessionsWithHits: 1,
      damagedRecordsSkipped: 1,
    });
  });

  it('emits the recall guidance context item when the plugin is enabled', async () => {
    const {host, storeRoot} = await createHistoryHost();
    const disabledHost = createRuntimePluginHost({
      plugins: [createSessionHistoryPlugin()],
      enabledPluginIds: [runtimePluginId],
      ...historyCapabilities(storeRoot),
    });
    const guided = await host.beforeRoleModelCall(
      createTestPluginContext('evt_history_guidance'),
    );

    expect(guided.status).toBe('completed');
    if (guided.status !== 'completed') {
      throw new Error('Expected beforeRoleModelCall to complete.');
    }

    expect(
      guided.contextItems.some(
        item =>
          item.pluginId === sessionHistoryPluginId &&
          item.text.includes('sessions.search'),
      ),
    ).toBe(true);

    const unguided = await disabledHost.beforeRoleModelCall(
      createTestPluginContext('evt_history_no_guidance'),
    );

    expect(unguided.status).toBe('completed');
    if (unguided.status !== 'completed') {
      throw new Error('Expected the disabled beforeRoleModelCall to complete.');
    }

    expect(
      unguided.contextItems.some(
        item => item.pluginId === sessionHistoryPluginId,
      ),
    ).toBe(false);
  });

  it('keeps the index warm after committed turns, only when enabled', async () => {
    const {host, storeRoot} = await createHistoryHost();

    expect(existsSync(historyIndexPath(storeRoot))).toBe(false);

    const committed = await host.afterTurnCommitted(
      afterTurnContext('evt_history_warm', 'alpha.1'),
    );

    expect(committed.status).toBe('completed');
    expect(existsSync(historyIndexPath(storeRoot))).toBe(true);

    // With the plugin disabled the hook never runs, so nothing materializes.
    const bareRoot = createTestTempRoot('project02-history-bare-');

    await writeDurableSession({
      storeRoot: bareRoot,
      conversationId: 'alpha',
      exchanges: [['hi', 'ho']],
    });

    const bareHost = createRuntimePluginHost({
      plugins: [createSessionHistoryPlugin()],
      enabledPluginIds: [runtimePluginId],
      ...historyCapabilities(bareRoot),
    });
    const skipped = await bareHost.afterTurnCommitted(
      afterTurnContext('evt_history_cold', 'alpha.1'),
    );

    expect(skipped.status).toBe('completed');
    expect(existsSync(historyIndexPath(bareRoot))).toBe(false);
  });

  it('excludes only messages the model sees, reaching the rest of the active session', async () => {
    const {host} = await createHistoryHost();
    // The context arrives from session "alpha": what the model still sees
    // never matches, while messages that scrolled out of its window do.
    const activeContext = (eventId: string, visibleIds: readonly string[]) =>
      createRuntimePluginContext({
        ...createRuntimeEventIdentity({
          eventId,
          traceId: `trace_${eventId}`,
          createdAt: '2026-06-15T00:00:00.000Z',
        }),
        sessionId: 'alpha.1',
        eventType: 'USER_MESSAGE',
        currentUserMessage: 'what was the permission design?',
        recentVisibleMessageIds: visibleIds,
        character: testCharacterProfile,
      });
    const scrolledPast = await host.handleToolCall(
      historyToolCall('evt_history_scrolled', sessionHistorySearchToolName, {
        query: 'permission',
      }),
      activeContext('evt_history_scrolled', [
        'alpha.1:message-3',
        'alpha.1:message-4',
      ]),
    );

    expect(scrolledPast.status).toBe('accepted');
    if (scrolledPast.status !== 'accepted') {
      throw new Error('Expected the scrolled-past search to be accepted.');
    }

    expect(scrolledPast.output).toMatchObject({totalSessionsWithHits: 1});

    // The anchored view stays a complete conversation: visible neighbors
    // are filtered from matching, not redacted from the window.
    const views = jsonArray(jsonRecord(scrolledPast.output)['sessions']);
    const aroundMatch = jsonArray(jsonRecord(views[0])['aroundMatch']).map(
      row => jsonRecord(row),
    );

    expect(aroundMatch.some(row => row['matched'] === true)).toBe(true);
    expect(
      aroundMatch.some(row => row['messageId'] === 'alpha.1:message-4'),
    ).toBe(true);

    const allVisible = await host.handleToolCall(
      historyToolCall('evt_history_visible', sessionHistorySearchToolName, {
        query: 'permission',
      }),
      activeContext('evt_history_visible', [
        'alpha.1:message-1',
        'alpha.1:message-2',
        'alpha.1:message-3',
        'alpha.1:message-4',
      ]),
    );

    expect(allVisible.status).toBe('accepted');
    if (allVisible.status !== 'accepted') {
      throw new Error('Expected the all-visible search to be accepted.');
    }

    expect(allVisible.output).toMatchObject({totalSessionsWithHits: 0});

    const restricted = await host.handleToolCall(
      historyToolCall('evt_history_restrict', sessionHistorySearchToolName, {
        query: 'permission',
        sessionId: 'beta.1',
      }),
      activeContext('evt_history_restrict', []),
    );

    expect(restricted.status).toBe('accepted');
    if (restricted.status !== 'accepted') {
      throw new Error('Expected the restricted search to be accepted.');
    }

    expect(restricted.output).toMatchObject({totalSessionsWithHits: 0});
  });

  it('keeps local paths out of model-facing storage failures', async () => {
    const {host, storeRoot} = await createHistoryHost();
    const outside = join(
      createTestTempRoot('project02-history-outside-'),
      'raw',
    );

    mkdirSync(outside, {recursive: true});
    writeFileSync(join(outside, 'raw-events.jsonl'), '', 'utf8');

    const sessionRoot = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'alpha.1',
    }).sessionRoot;

    rmSync(sessionRoot, {recursive: true});
    symlinkSync(outside, sessionRoot);

    const rejected = await host.handleToolCall(
      historyToolCall('evt_history_redacted', sessionHistorySearchToolName, {
        query: 'permission',
      }),
      createTestPluginContext('evt_history_redacted'),
    );

    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: 'session_history_read_failed',
    });
    if (rejected.status !== 'rejected') {
      throw new Error('Expected the linked-session search to be rejected.');
    }

    expect(rejected.message).not.toContain(storeRoot);
  });

  it('rejects requests from another character', async () => {
    const {host} = await createHistoryHost();
    const eventId = 'evt_history_foreign';
    const foreignContext = createRuntimePluginContext({
      ...createRuntimeEventIdentity({
        eventId,
        traceId: `trace_${eventId}`,
        createdAt: '2026-06-15T00:00:00.000Z',
      }),
      sessionId: 'session-loop',
      eventType: 'USER_MESSAGE',
      currentUserMessage: 'search memory',
      character: {id: 'nova', displayName: 'Nova'},
    });
    const result = await host.handleToolCall(
      historyToolCall(eventId, sessionHistorySearchToolName, {
        query: 'permission',
      }),
      foreignContext,
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'character_scope_mismatch',
    });
  });
});

async function createHistoryHost(): Promise<{
  readonly host: RuntimePluginHost;
  readonly storeRoot: string;
}> {
  const storeRoot = createTestTempRoot('project02-history-plugin-');

  await writeDurableSession({
    storeRoot,
    conversationId: 'alpha',
    exchanges: [
      [
        'what should the plugin permission architecture be?',
        'Scope every plugin to one capability grant.',
      ],
      ['and how do we persist that?', 'In the JSONL log, one commit per line.'],
    ],
  });
  await writeDurableSession({
    storeRoot,
    conversationId: 'beta',
    exchanges: [['how is the weather?', 'Sunny.']],
  });

  const host = createRuntimePluginHost({
    plugins: [createSessionHistoryPlugin()],
    enabledPluginIds: enabledWithSessionHistory,
    ...historyCapabilities(storeRoot),
  });

  return {host, storeRoot};
}

function historyCapabilities(storeRoot: string) {
  return {
    sessionHistory: createLocalRuntimeSessionHistoryFeed({
      storeRoot,
      characterId: testCharacterProfile.id,
    }),
    pluginDatabase: createRuntimePluginDatabaseProvider({storeRoot}),
  };
}

function historyIndexPath(storeRoot: string): string {
  return join(
    characterPluginDataDirPath({storeRoot, pluginId: sessionHistoryPluginId}),
    'session-index.sqlite',
  );
}

function afterTurnContext(eventId: string, sessionId: string) {
  return createRuntimePluginAfterTurnCommittedContext({
    ...createRuntimeEventIdentity({
      eventId,
      traceId: `trace_${eventId}`,
      createdAt: '2026-06-15T00:00:00.000Z',
    }),
    sessionId,
    eventType: 'USER_MESSAGE',
    currentUserMessage: 'hi',
    character: testCharacterProfile,
    committedAt: '2026-06-15T00:00:00.000Z',
    visibleMessages: [],
  });
}

function historyToolCall(
  eventId: string,
  toolName: string,
  input: Readonly<Record<string, string | number>>,
) {
  return {
    ...createRuntimeEventIdentity({
      eventId,
      traceId: `trace_${eventId}`,
      createdAt: '2026-06-15T00:00:00.000Z',
    }),
    pluginId: sessionHistoryPluginId,
    toolName,
    input,
  };
}
