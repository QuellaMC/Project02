import {appendFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

import {testCharacterProfile} from '../support/character-fixtures.ts';
import {jsonArray, jsonRecord} from '../support/json-view.ts';
import {createTestPluginContext} from '../support/role-model-loop-fixtures.ts';
import {writeDurableConversationSession} from '../support/runtime-log-fixtures.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

import {existsSync} from 'node:fs';

import {createRuntimeEventIdentity} from '../../src/core/index.ts';
import {
  createRuntimePluginAfterTurnCommittedContext,
  createRuntimePluginContext,
} from '../../src/plugins/api/index.ts';
import {
  firstPartyModelToolsPluginId,
  runtimePluginId,
  sessionHistoryPluginId,
  sessionHistoryReadToolName,
  sessionHistorySearchToolName,
} from '../../src/plugins/api/contract.ts';
import {
  createRuntimePluginHost,
  type RuntimePluginHost,
} from '../../src/plugins/host/index.ts';
import {createLocalRuntimeSessionPaths} from '../../src/runtime/storage/layout-contract.ts';
import {sessionIndexDatabasePath} from '../../src/runtime/storage/session-index/index.ts';
import {
  createLocalRuntimeSessionIndex,
  type LocalRuntimeSessionIndex,
} from '../../src/runtime/storage/index.ts';

const enabledWithSessionHistory = [
  runtimePluginId,
  firstPartyModelToolsPluginId,
  sessionHistoryPluginId,
];

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
    expect(jsonRecord(sessions[0])['sessionId']).toBe('alpha');

    const matchedRows = jsonArray(jsonRecord(sessions[0])['aroundMatch'])
      .map(row => jsonRecord(row))
      .filter(row => row['matched'] === true);

    expect(matchedRows).toHaveLength(1);
    expect(String(matchedRows[0]?.['snippet'])).toContain('permission');

    const readResult = await host.handleToolCall(
      historyToolCall('evt_history_read', sessionHistoryReadToolName, {
        sessionId: 'alpha',
        anchorMessageId: 'alpha:message-1',
        window: 1,
      }),
      createTestPluginContext('evt_history_read'),
    );

    expect(readResult.status).toBe('accepted');
    if (readResult.status !== 'accepted') {
      throw new Error('Expected sessions.read to be accepted.');
    }

    expect(readResult.output).toMatchObject({
      sessionId: 'alpha',
      hasBefore: false,
      hasAfter: true,
    });
  });

  it('advertises the tools only when an index is injected', async () => {
    const {host} = await createHistoryHost();
    const bareHost = createRuntimePluginHost({
      plugins: [],
      enabledPluginIds: enabledWithSessionHistory,
    });

    expect(host.pluginToolDefinitions().map(tool => tool.name)).toEqual(
      expect.arrayContaining([
        sessionHistorySearchToolName,
        sessionHistoryReadToolName,
      ]),
    );
    expect(bareHost.pluginToolDefinitions().map(tool => tool.name)).not.toEqual(
      expect.arrayContaining([sessionHistorySearchToolName]),
    );

    const forced = await bareHost.handleToolCall(
      historyToolCall('evt_history_bare', sessionHistorySearchToolName, {
        query: 'anything',
      }),
      createTestPluginContext('evt_history_bare'),
    );

    expect(forced.status).toBe('rejected');
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
      createLocalRuntimeSessionPaths({storeRoot, sessionId: 'alpha'})
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

  it('emits the recall guidance context item only with an index', async () => {
    const {host} = await createHistoryHost();
    const bareHost = createRuntimePluginHost({
      plugins: [],
      enabledPluginIds: enabledWithSessionHistory,
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

    const unguided = await bareHost.beforeRoleModelCall(
      createTestPluginContext('evt_history_no_guidance'),
    );

    expect(unguided.status).toBe('completed');
    if (unguided.status !== 'completed') {
      throw new Error('Expected the bare beforeRoleModelCall to complete.');
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
      afterTurnContext('evt_history_warm', 'alpha'),
    );

    expect(committed.status).toBe('completed');
    expect(existsSync(historyIndexPath(storeRoot))).toBe(true);

    // With the plugin disabled the hook never runs, so nothing materializes.
    const bareRoot = createTestTempRoot('project02-history-bare-');

    await writeDurableConversationSession({
      storeRoot: bareRoot,
      sessionId: 'alpha',
      exchanges: [['hi', 'ho']],
    });

    const bareHost = createRuntimePluginHost({
      plugins: [],
      enabledPluginIds: [runtimePluginId, firstPartyModelToolsPluginId],
      sessionIndex: createLocalRuntimeSessionIndex({
        storeRoot: bareRoot,
        characterId: testCharacterProfile.id,
        ownerPluginId: sessionHistoryPluginId,
      }),
    });
    const skipped = await bareHost.afterTurnCommitted(
      afterTurnContext('evt_history_cold', 'alpha'),
    );

    expect(skipped.status).toBe('completed');
    expect(existsSync(historyIndexPath(bareRoot))).toBe(false);
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
  readonly sessionIndex: LocalRuntimeSessionIndex;
}> {
  const storeRoot = createTestTempRoot('project02-history-plugin-');

  await writeDurableConversationSession({
    storeRoot,
    sessionId: 'alpha',
    exchanges: [
      [
        'what should the plugin permission architecture be?',
        'Scope every plugin to one capability grant.',
      ],
      ['and how do we persist that?', 'In the JSONL log, one commit per line.'],
    ],
  });
  await writeDurableConversationSession({
    storeRoot,
    sessionId: 'beta',
    exchanges: [['how is the weather?', 'Sunny.']],
  });

  const sessionIndex = createLocalRuntimeSessionIndex({
    storeRoot,
    characterId: testCharacterProfile.id,
    ownerPluginId: sessionHistoryPluginId,
  });
  const host = createRuntimePluginHost({
    plugins: [],
    enabledPluginIds: enabledWithSessionHistory,
    sessionIndex,
  });

  return {host, storeRoot, sessionIndex};
}

function historyIndexPath(storeRoot: string): string {
  return sessionIndexDatabasePath({
    storeRoot,
    ownerPluginId: sessionHistoryPluginId,
  });
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
