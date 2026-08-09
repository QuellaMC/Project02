import Database from 'better-sqlite3';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

import {testCharacterProfile} from '../support/character-fixtures.ts';
import {
  appendDurableConversationExchanges,
  writeDurableConversationSession,
} from '../support/runtime-log-fixtures.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

import {sessionHistoryPluginId} from '../../src/plugins/api/contract.ts';
import {
  createSessionHistoryEngine,
  type SessionHistoryEngine,
} from '../../src/plugins/packages/session-history/engine/index.ts';
import {characterPluginDataDirPath} from '../../src/runtime/storage/layout-contract.ts';
import {
  createLocalRuntimeSessionHistoryFeed,
  createRuntimePluginDatabaseOpener,
} from '../../src/runtime/storage/index.ts';

const character = testCharacterProfile;

describe('session history engine', () => {
  it('searches across sessions with routed queries', async () => {
    const storeRoot = createStoreRoot();

    await writeDurableConversationSession({
      storeRoot,
      sessionId: 'alpha',
      exchanges: [
        [
          'what should the plugin permission architecture be?',
          'Scope every plugin to one capability grant.',
        ],
        ['and storage?', 'Keep the JSONL log canonical.'],
      ],
    });
    await writeDurableConversationSession({
      storeRoot,
      sessionId: 'beta',
      exchanges: [
        ['how is the weather?', 'Sunny, with a chance of tool calls.'],
        ['我们讨论了插件权限设计吗？', '讨论过，结论是每个插件一个能力授权。'],
      ],
    });

    const engine = createEngine(storeRoot);
    const result = engine.search({query: 'permission', sessionLimit: 3});

    expect(result.totalSessionsWithHits).toBe(1);
    expect(result.sessions[0]?.sessionId).toBe('alpha');
    expect(
      result.sessions[0]?.window.some(
        message => message.messageId === result.sessions[0]?.matchMessageId,
      ),
    ).toBe(true);
    expect(result.damagedRecordCount).toBe(0);

    const cjk = engine.search({query: '插件权限', sessionLimit: 3});

    expect(cjk.sessions.map(view => view.sessionId)).toContain('beta');

    const short = engine.search({query: 'su', sessionLimit: 3});

    expect(short.totalSessionsWithHits).toBe(1);
    expect(short.sessions[0]?.sessionId).toBe('beta');

    const literal = engine.search({
      query: '"permission" OR archi*',
      sessionLimit: 3,
    });

    expect(literal.totalSessionsWithHits).toBe(0);

    engine.close();
  });

  it('returns anchored views and scrolls by message anchor', async () => {
    const storeRoot = createStoreRoot();
    const exchanges: [string, string][] = [];

    for (let turn = 0; turn < 10; turn += 1) {
      exchanges.push([
        turn === 6
          ? 'where did we put the anchovy pizza?'
          : `filler question ${String(turn)}`,
        `filler answer ${String(turn)}`,
      ]);
    }

    await writeDurableConversationSession({
      storeRoot,
      sessionId: 'long-session',
      exchanges,
    });

    const engine = createEngine(storeRoot);
    const view = engine.search({query: 'anchovy', sessionLimit: 1}).sessions[0];

    expect(view?.bookendStart.map(message => message.text)).toEqual([
      'filler question 0',
      'filler answer 0',
    ]);
    expect(view?.window).toHaveLength(7);
    expect(view?.bookendEnd.map(message => message.text)).toEqual([
      'filler question 9',
      'filler answer 9',
    ]);

    const scrolled = engine.readAround({
      sessionId: 'long-session',
      anchorMessageId: view?.matchMessageId ?? '',
      window: 2,
    });

    expect(scrolled.messages).toHaveLength(5);
    expect(scrolled.hasBefore).toBe(true);
    expect(scrolled.hasAfter).toBe(true);

    engine.close();
  });

  it('warms up without a query and ingests appends incrementally', async () => {
    const storeRoot = createStoreRoot();

    await writeDurableConversationSession({
      storeRoot,
      sessionId: 'grows',
      exchanges: [['first question', 'first answer']],
    });

    const engine = createEngine(storeRoot);

    expect(existsSync(indexPath(storeRoot))).toBe(false);
    await engine.warmUp();
    expect(existsSync(indexPath(storeRoot))).toBe(true);
    expect(countIndexedMessages(storeRoot)).toBe(2);

    await engine.warmUp({sessionId: 'never-existed'});

    await appendDurableConversationExchanges({
      storeRoot,
      sessionId: 'grows',
      firstTurn: 2,
      exchanges: [['second question about narwhals', 'second answer']],
    });

    expect(
      engine.search({query: 'narwhals', sessionLimit: 1}).totalSessionsWithHits,
    ).toBe(1);
    expect(countIndexedMessages(storeRoot)).toBe(4);

    engine.close();
  });

  it('rebuilds on database version bumps and adopts foreign databases', async () => {
    const storeRoot = createStoreRoot();

    await writeDurableConversationSession({
      storeRoot,
      sessionId: 'kept',
      exchanges: [['keep this thread', 'kept']],
    });

    const engine = createEngine(storeRoot);

    expect(
      engine.search({query: 'thread', sessionLimit: 3}).totalSessionsWithHits,
    ).toBe(1);
    engine.close();

    // A future-version database is deleted and re-ingested, never migrated.
    const tampered = new Database(indexPath(storeRoot));

    tampered.pragma('user_version = 99');
    tampered.close();

    const afterVersionBump = createEngine(storeRoot);

    expect(
      afterVersionBump.search({query: 'thread', sessionLimit: 3})
        .totalSessionsWithHits,
    ).toBe(1);
    afterVersionBump.close();

    // A database claiming another character is wiped and adopted.
    const foreign = new Database(indexPath(storeRoot));

    foreign.prepare('UPDATE index_meta SET character_id = ?').run('nova');
    foreign.close();

    const afterForeignMeta = createEngine(storeRoot);

    expect(
      afterForeignMeta.search({query: 'thread', sessionLimit: 3})
        .totalSessionsWithHits,
    ).toBe(1);
    afterForeignMeta.close();
  });

  it('rejects database names outside the identifier rules', async () => {
    const storeRoot = createStoreRoot();

    await writeDurableConversationSession({
      storeRoot,
      sessionId: 'only',
      exchanges: [['hello', 'hi']],
    });

    const openDatabase = createRuntimePluginDatabaseOpener({
      storeRoot,
      pluginId: sessionHistoryPluginId,
    });

    expect(() =>
      openDatabase({
        name: '../escape',
        schemaVersion: 1,
        initializeSchema: () => undefined,
      }),
    ).toThrow(/database name/);
  });

  it('rejects unknown sessions, anchors, and closed engines', async () => {
    const storeRoot = createStoreRoot();

    await writeDurableConversationSession({
      storeRoot,
      sessionId: 'only',
      exchanges: [['hello', 'hi']],
    });

    const engine = createEngine(storeRoot);

    expect(() =>
      engine.search({query: 'hello', sessionId: 'nope', sessionLimit: 1}),
    ).toThrow(expect.objectContaining({code: 'session_not_found'}));
    expect(() => engine.readAround({sessionId: '../x', window: 5})).toThrow(
      expect.objectContaining({code: 'session_not_found'}),
    );
    expect(() =>
      engine.readAround({
        sessionId: 'only',
        anchorMessageId: 'only:message-99',
        window: 5,
      }),
    ).toThrow(expect.objectContaining({code: 'message_not_found'}));

    engine.close();
    expect(() => engine.search({query: 'hello', sessionLimit: 1})).toThrow(
      expect.objectContaining({code: 'engine_closed'}),
    );

    // A second engine over the same store keeps working.
    const second = createEngine(storeRoot);

    expect(
      second.search({query: 'hello', sessionLimit: 1}).totalSessionsWithHits,
    ).toBe(1);
    second.close();
  });
});

function createStoreRoot(): string {
  return createTestTempRoot('project02-history-engine-');
}

function createEngine(storeRoot: string): SessionHistoryEngine {
  return createSessionHistoryEngine({
    feed: createLocalRuntimeSessionHistoryFeed({
      storeRoot,
      characterId: character.id,
    }),
    openDatabase: createRuntimePluginDatabaseOpener({
      storeRoot,
      pluginId: sessionHistoryPluginId,
    }),
  });
}

function indexPath(storeRoot: string): string {
  return join(
    characterPluginDataDirPath({storeRoot, pluginId: sessionHistoryPluginId}),
    'session-index.sqlite',
  );
}

function countIndexedMessages(storeRoot: string): number {
  const database = new Database(indexPath(storeRoot), {readonly: true});

  try {
    const row = database
      .prepare<[], {total: number}>('SELECT count(*) AS total FROM messages')
      .get();

    return row?.total ?? 0;
  } finally {
    database.close();
  }
}
