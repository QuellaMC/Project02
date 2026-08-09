import Database from 'better-sqlite3';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import {describe, expect, it} from 'vitest';

import {testCharacterProfile} from '../support/character-fixtures.ts';
import {
  appendDurableConversationExchanges,
  writeDurableConversationSession,
  type DurableConversationExchange,
} from '../support/runtime-log-fixtures.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

import type {CharacterProfile} from '../../src/core/index.ts';
import {createFileRuntimeLogStore} from '../../src/runtime/storage/file-runtime-log-store.ts';
import {
  createLocalRuntimeSessionPaths,
  createLocalRuntimeStorageLayout,
} from '../../src/runtime/storage/layout-contract.ts';
import {createLocalRuntimeSessionIndex} from '../../src/runtime/storage/session-index/index.ts';
import {createLocalRuntimeSessionStore} from '../../src/runtime/storage/session-store.ts';

const character = testCharacterProfile;

describe('session index', () => {
  it('projects committed messages and searches across sessions', async () => {
    const storeRoot = createStoreRoot();

    await writeSession(storeRoot, 'alpha', [
      [
        'what should the plugin permission architecture be?',
        'Scope every plugin to one capability grant.',
      ],
      ['and storage?', 'Keep the JSONL log canonical.'],
    ]);
    await writeSession(storeRoot, 'beta', [
      ['how is the weather?', 'Sunny, with a chance of tool calls.'],
      ['我们讨论了插件权限设计吗？', '讨论过，结论是每个插件一个能力授权。'],
    ]);

    const index = createLocalRuntimeSessionIndex({
      storeRoot,
      characterId: character.id,
    });
    const result = index.search({query: 'permission', sessionLimit: 3});

    expect(result.totalSessionsWithHits).toBe(1);
    expect(result.sessions).toHaveLength(1);

    const view = result.sessions[0];

    expect(view?.sessionId).toBe('alpha');
    expect(
      view?.window.some(message => message.messageId === view.matchMessageId),
    ).toBe(true);
    expect(result.damagedRecordCount).toBe(0);

    // Word-index parity with the validating reader: same messages, same order.
    for (const sessionId of ['alpha', 'beta']) {
      const expected = createFileRuntimeLogStore({
        storeRoot,
        sessionId,
        characterId: character.id,
        boundCharacter: character,
      }).conversationMessages();
      const projected = index.readAround({sessionId, window: 50});

      expect(projected.messages.map(message => message.messageId)).toEqual(
        expected.map(message => message.id),
      );
      expect(projected.messages.map(message => message.text)).toEqual(
        expected.map(message => message.text),
      );
    }

    // CJK queries route through the trigram index.
    const cjk = index.search({query: '插件权限', sessionLimit: 3});

    expect(cjk.sessions.map(sessionView => sessionView.sessionId)).toContain(
      'beta',
    );

    // Short queries fall back to case-insensitive substring matching.
    const short = index.search({query: 'su', sessionLimit: 3});

    expect(short.totalSessionsWithHits).toBe(1);
    expect(short.sessions[0]?.sessionId).toBe('beta');

    // FTS syntax is treated as literal text, never as operators.
    const literal = index.search({
      query: '"permission" OR archi*',
      sessionLimit: 3,
    });

    expect(literal.totalSessionsWithHits).toBe(0);

    index.close();
  });

  it('returns anchored views with bookends around the best match', async () => {
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

    await writeSession(storeRoot, 'long-session', exchanges);

    const index = createLocalRuntimeSessionIndex({
      storeRoot,
      characterId: character.id,
    });
    const result = index.search({query: 'anchovy', sessionLimit: 1});
    const view = result.sessions[0];

    // 20 messages, match at ordinal 12: bookends [0,1] and [18,19], window
    // [9..15], no overlap and no duplicates.
    expect(view?.bookendStart.map(message => message.text)).toEqual([
      'filler question 0',
      'filler answer 0',
    ]);
    expect(view?.window.map(message => message.text)).toContain(
      'where did we put the anchovy pizza?',
    );
    expect(view?.window).toHaveLength(7);
    expect(view?.bookendEnd.map(message => message.text)).toEqual([
      'filler question 9',
      'filler answer 9',
    ]);

    const allIds = [
      ...(view?.bookendStart ?? []),
      ...(view?.window ?? []),
      ...(view?.bookendEnd ?? []),
    ].map(message => message.messageId);

    expect(new Set(allIds).size).toBe(allIds.length);

    // Anchored scrolling reaches the messages the view elided.
    const scrolled = index.readAround({
      sessionId: 'long-session',
      anchorMessageId: view?.matchMessageId ?? '',
      window: 2,
    });

    expect(scrolled.messages).toHaveLength(5);
    expect(scrolled.hasBefore).toBe(true);
    expect(scrolled.hasAfter).toBe(true);

    index.close();
  });

  it('projects incrementally from byte watermarks', async () => {
    const storeRoot = createStoreRoot();

    await writeSession(storeRoot, 'grows', [
      ['first question', 'first answer'],
    ]);

    const index = createLocalRuntimeSessionIndex({
      storeRoot,
      characterId: character.id,
    });

    expect(
      index.search({query: 'first', sessionLimit: 1}).totalSessionsWithHits,
    ).toBe(1);

    const layout = createLocalRuntimeStorageLayout({storeRoot});
    const rawEventsPath = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'grows',
    }).rawEventsPath;
    const watermarkAfterFirst = readWatermark(layout.sessionIndexPath, 'grows');

    await appendDurableConversationExchanges({
      storeRoot,
      sessionId: 'grows',
      firstTurn: 2,
      exchanges: [['second question about narwhals', 'second answer']],
    });

    expect(
      index.search({query: 'narwhals', sessionLimit: 1}).totalSessionsWithHits,
    ).toBe(1);

    const watermarkAfterSecond = readWatermark(
      layout.sessionIndexPath,
      'grows',
    );

    expect(watermarkAfterSecond).toBeGreaterThan(watermarkAfterFirst);
    expect(watermarkAfterSecond).toBe(fileSize(rawEventsPath));

    index.close();
  });

  it('tolerates torn tails and counts damage without losing neighbors', async () => {
    const storeRoot = createStoreRoot();

    await writeSession(storeRoot, 'damaged', [
      ['remember the passphrase riddle?', 'It was about a silent drawbridge.'],
    ]);
    await writeSession(storeRoot, 'intact', [['unrelated chatter', 'indeed']]);

    const rawEventsPath = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'damaged',
    }).rawEventsPath;

    // A torn tail is an unfinished append, not damage.
    appendFileSync(rawEventsPath, '{"eventId":"evt_torn', 'utf8');

    const index = createLocalRuntimeSessionIndex({
      storeRoot,
      characterId: character.id,
    });
    const tornResult = index.search({query: 'drawbridge', sessionLimit: 3});

    expect(tornResult.totalSessionsWithHits).toBe(1);
    expect(tornResult.damagedRecordCount).toBe(0);

    // A committed line that does not decode is damage: counted, skipped,
    // and isolated from every other record.
    appendFileSync(rawEventsPath, '"}\n', 'utf8');

    const damagedResult = index.search({query: 'drawbridge', sessionLimit: 3});

    expect(damagedResult.totalSessionsWithHits).toBe(1);
    expect(damagedResult.damagedRecordCount).toBe(1);

    // A damaged catalog row is counted and skipped; the strict reader
    // refuses the same store outright.
    const layout = createLocalRuntimeStorageLayout({storeRoot});

    appendFileSync(layout.sessionCatalogPath, '{"sessionId":42}\n', 'utf8');

    const catalogResult = index.search({query: 'drawbridge', sessionLimit: 3});

    expect(catalogResult.totalSessionsWithHits).toBe(1);
    expect(catalogResult.damagedRecordCount).toBe(2);
    await expect(
      createLocalRuntimeSessionStore({
        storeRoot,
        characterId: character.id,
      }).listSessions(),
    ).rejects.toMatchObject({code: 'malformed_record'});

    index.close();
  });

  it('ignores mid-create session states', async () => {
    const storeRoot = createStoreRoot();

    await writeSession(storeRoot, 'settled', [['hello there', 'hi']]);

    // A crash between directory creation and the catalog rewrite leaves an
    // empty uncatalogued directory; a catalog row whose directory never
    // materialized reads as an empty conversation.
    const layout = createLocalRuntimeStorageLayout({storeRoot});
    const orphanPaths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'orphan-dir',
    });

    mkdirSync(orphanPaths.sessionRoot, {recursive: true});
    appendFileSync(
      layout.sessionCatalogPath,
      '{"sessionId":"ghost","createdAt":"2026-07-16T00:00:00.000Z","updatedAt":"2026-07-16T00:00:00.000Z"}\n',
      'utf8',
    );

    const index = createLocalRuntimeSessionIndex({
      storeRoot,
      characterId: character.id,
    });
    const result = index.search({query: 'hello', sessionLimit: 3});

    expect(result.totalSessionsWithHits).toBe(1);
    expect(result.damagedRecordCount).toBe(0);

    const ghost = index.readAround({sessionId: 'ghost', window: 5});

    expect(ghost.messages).toEqual([]);
    expect(ghost.hasBefore).toBe(false);
    expect(ghost.hasAfter).toBe(false);

    index.close();
  });

  it('rebuilds the view on version bumps, foreign meta, and shrunken transcripts', async () => {
    const storeRoot = createStoreRoot();

    await writeSession(storeRoot, 'kept', [['keep this thread', 'kept']]);
    await writeSession(storeRoot, 'shrinks', [['forget this thread', 'ok']]);

    const index = createLocalRuntimeSessionIndex({
      storeRoot,
      characterId: character.id,
    });

    expect(
      index.search({query: 'thread', sessionLimit: 3}).totalSessionsWithHits,
    ).toBe(2);
    index.close();

    const layout = createLocalRuntimeStorageLayout({storeRoot});

    // A future-version view is deleted and reprojected, never migrated.
    const tampered = new Database(layout.sessionIndexPath);

    tampered.pragma('user_version = 99');
    tampered.close();

    const afterVersionBump = createLocalRuntimeSessionIndex({
      storeRoot,
      characterId: character.id,
    });

    expect(
      afterVersionBump.search({query: 'thread', sessionLimit: 3})
        .totalSessionsWithHits,
    ).toBe(2);
    afterVersionBump.close();

    // A view claiming another character is derived data: rebuilt in place.
    const foreign = new Database(layout.sessionIndexPath);

    foreign.prepare('UPDATE index_meta SET character_id = ?').run('nova');
    foreign.close();

    const afterForeignMeta = createLocalRuntimeSessionIndex({
      storeRoot,
      characterId: character.id,
    });

    expect(
      afterForeignMeta.search({query: 'thread', sessionLimit: 3})
        .totalSessionsWithHits,
    ).toBe(2);

    // A transcript now smaller than its watermark reprojects from zero;
    // other sessions keep their rows.
    truncateSync(
      createLocalRuntimeSessionPaths({storeRoot, sessionId: 'shrinks'})
        .rawEventsPath,
      0,
    );

    const afterShrink = afterForeignMeta.search({
      query: 'thread',
      sessionLimit: 3,
    });

    expect(afterShrink.totalSessionsWithHits).toBe(1);
    expect(afterShrink.sessions[0]?.sessionId).toBe('kept');
    afterForeignMeta.close();
  });

  it('fails closed at construction on marker problems', async () => {
    const versionedRoot = createStoreRoot();
    const layout = createLocalRuntimeStorageLayout({storeRoot: versionedRoot});

    writeFileSync(
      layout.schemaPath,
      '{"schemaVersion":7,"scope":"character-data","characterId":"mira","createdAt":"2026-07-16T00:00:00.000Z"}\n',
      'utf8',
    );
    expect(() =>
      createLocalRuntimeSessionIndex({
        storeRoot: versionedRoot,
        characterId: character.id,
      }),
    ).toThrow(expect.objectContaining({code: 'unsupported_schema_version'}));

    expect(() =>
      createLocalRuntimeSessionIndex({
        storeRoot: createStoreRoot(),
        characterId: character.id,
      }),
    ).toThrow(expect.objectContaining({code: 'missing_file'}));

    const foreignRoot = createStoreRoot();

    await writeSession(foreignRoot, 'theirs', [['their secret', 'kept']], {
      id: 'nova',
      displayName: 'Nova',
    });
    expect(() =>
      createLocalRuntimeSessionIndex({
        storeRoot: foreignRoot,
        characterId: character.id,
      }),
    ).toThrow(expect.objectContaining({code: 'character_identity_mismatch'}));
  });

  it('rejects invalid and unknown session requests', async () => {
    const storeRoot = createStoreRoot();

    await writeSession(storeRoot, 'only', [['hello', 'hi']]);

    const index = createLocalRuntimeSessionIndex({
      storeRoot,
      characterId: character.id,
    });

    expect(() => index.readAround({sessionId: '../x', window: 5})).toThrow(
      expect.objectContaining({code: 'invalid_session_id'}),
    );
    expect(() =>
      index.search({query: 'hello', sessionId: 'nope', sessionLimit: 1}),
    ).toThrow(expect.objectContaining({code: 'missing_file'}));
    expect(() =>
      index.readAround({
        sessionId: 'only',
        anchorMessageId: 'only:message-99',
        window: 5,
      }),
    ).toThrow(expect.objectContaining({code: 'missing_file'}));

    index.close();
  });

  it('warms up without a query and tolerates unknown sessions', async () => {
    const storeRoot = createStoreRoot();

    await writeSession(storeRoot, 'alpha', [['hello there', 'hi']]);
    await writeSession(storeRoot, 'beta', [['more words', 'indeed']]);

    const layout = createLocalRuntimeStorageLayout({storeRoot});
    const index = createLocalRuntimeSessionIndex({
      storeRoot,
      characterId: character.id,
    });

    await index.warmUp();
    expect(existsSync(layout.sessionIndexPath)).toBe(true);

    const database = new Database(layout.sessionIndexPath, {readonly: true});

    try {
      const row = database
        .prepare<[], {total: number}>('SELECT count(*) AS total FROM messages')
        .get();

      expect(row?.total).toBe(4);
    } finally {
      database.close();
    }

    await index.warmUp({sessionId: 'never-existed'});
    index.close();
  });

  it('opens lazily and serves concurrent instances', async () => {
    const storeRoot = createStoreRoot();

    await writeSession(storeRoot, 'lazy', [['open sesame', 'opened']]);

    const layout = createLocalRuntimeStorageLayout({storeRoot});
    const first = createLocalRuntimeSessionIndex({
      storeRoot,
      characterId: character.id,
    });

    expect(existsSync(layout.sessionIndexPath)).toBe(false);
    expect(
      first.search({query: 'sesame', sessionLimit: 1}).totalSessionsWithHits,
    ).toBe(1);
    expect(existsSync(layout.sessionIndexPath)).toBe(true);

    const second = createLocalRuntimeSessionIndex({
      storeRoot,
      characterId: character.id,
    });

    expect(
      second.search({query: 'sesame', sessionLimit: 1}).totalSessionsWithHits,
    ).toBe(1);

    second.close();
    expect(() => second.search({query: 'sesame', sessionLimit: 1})).toThrow(
      expect.objectContaining({code: 'read_failed'}),
    );
    expect(
      first.search({query: 'sesame', sessionLimit: 1}).totalSessionsWithHits,
    ).toBe(1);
    first.close();
  });
});

function createStoreRoot(): string {
  return createTestTempRoot('project02-session-index-');
}

async function writeSession(
  storeRoot: string,
  sessionId: string,
  exchanges: readonly DurableConversationExchange[],
  boundCharacter?: CharacterProfile,
): Promise<void> {
  await writeDurableConversationSession({
    storeRoot,
    sessionId,
    exchanges,
    ...(boundCharacter === undefined ? {} : {character: boundCharacter}),
  });
}

function readWatermark(sessionIndexPath: string, sessionId: string): number {
  const database = new Database(sessionIndexPath, {readonly: true});

  try {
    const row = database
      .prepare<[string], {offset: number}>(
        'SELECT next_byte_offset AS offset FROM projection_state WHERE session_id = ?',
      )
      .get(sessionId);

    if (row === undefined) {
      throw new Error(`No projection state for session "${sessionId}".`);
    }

    return row.offset;
  } finally {
    database.close();
  }
}

function fileSize(path: string): number {
  return statSync(path).size;
}
