import {
  appendFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

import {testCharacterProfile} from '../support/character-fixtures.ts';
import {writeDurableSession} from '../support/runtime-log-fixtures.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

import type {RuntimePluginSessionHistoryMessage} from '../../src/plugins/api/session-history-contract.ts';
import {createFileRuntimeLogStore} from '../../src/runtime/storage/file-runtime-log-store.ts';
import {
  createLocalRuntimeSessionPaths,
  createLocalRuntimeStorageLayout,
} from '../../src/runtime/storage/layout-contract.ts';
import {createLocalRuntimeSessionHistoryFeed} from '../../src/runtime/storage/session-history-feed.ts';
import {createLocalRuntimeSessionStore} from '../../src/runtime/storage/session-store.ts';

const character = testCharacterProfile;

describe('session history feed', () => {
  it('serves visible messages incrementally with an opaque cursor', async () => {
    const storeRoot = createStoreRoot();

    await writeDurableSession({
      storeRoot,
      conversationId: 'alpha',
      exchanges: [
        ['hello there', 'hi'],
        ['how are you?', 'well'],
      ],
    });

    const feed = createLocalRuntimeSessionHistoryFeed({
      storeRoot,
      characterId: character.id,
    });
    const first = feed.readNewMessages({sessionId: 'alpha.1'});
    const expected = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'alpha.1',
      characterId: character.id,
      boundCharacter: character,
    }).conversationMessages();

    expect(first.reset).toBe(false);
    expect(first.damagedRecordCount).toBe(0);
    expect(first.messages.map(message => message.messageId)).toEqual(
      expected.map(message => message.id),
    );
    expect(first.messages.map(message => message.text)).toEqual(
      expected.map(message => message.text),
    );

    const caughtUp = feed.readNewMessages({
      sessionId: 'alpha.1',
      cursor: first.nextCursor,
    });

    expect(caughtUp.messages).toEqual([]);
    expect(caughtUp.nextCursor).toBe(first.nextCursor);
    expect(caughtUp.reset).toBe(false);
  });

  it('leaves torn tails unconsumed and counts damaged records', async () => {
    const storeRoot = createStoreRoot();

    await writeDurableSession({
      storeRoot,
      conversationId: 'damaged',
      exchanges: [['remember the riddle?', 'the silent drawbridge one']],
    });

    const rawEventsPath = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'damaged.1',
    }).rawEventsPath;
    const feed = createLocalRuntimeSessionHistoryFeed({
      storeRoot,
      characterId: character.id,
    });

    appendFileSync(rawEventsPath, '{"eventId":"evt_torn', 'utf8');

    const torn = feed.readNewMessages({sessionId: 'damaged.1'});

    expect(torn.messages).toHaveLength(2);
    expect(torn.damagedRecordCount).toBe(0);

    appendFileSync(rawEventsPath, '"}\n', 'utf8');

    const damaged = feed.readNewMessages({
      sessionId: 'damaged.1',
      cursor: torn.nextCursor,
    });

    expect(damaged.messages).toEqual([]);
    expect(damaged.damagedRecordCount).toBe(1);
    expect(damaged.nextCursor).not.toBe(torn.nextCursor);
  });

  it('lists the catalog leniently where the strict reader refuses it', async () => {
    const storeRoot = createStoreRoot();

    await writeDurableSession({
      storeRoot,
      conversationId: 'alpha',
      exchanges: [['hello', 'hi']],
    });

    const layout = createLocalRuntimeStorageLayout({storeRoot});

    appendFileSync(layout.sessionCatalogPath, '{"sessionId":42}\n', 'utf8');
    appendFileSync(
      layout.sessionCatalogPath,
      '{"sessionId":"ghost.1","createdAt":"2026-07-16T00:00:00.000Z"}\n',
      'utf8',
    );

    const feed = createLocalRuntimeSessionHistoryFeed({
      storeRoot,
      characterId: character.id,
    });
    const listing = feed.listSessions();

    expect(listing.sessions.map(session => session.sessionId)).toEqual([
      'alpha.1',
      'ghost.1',
    ]);
    expect(listing.damagedEntryCount).toBe(1);
    await expect(
      createLocalRuntimeSessionStore({
        storeRoot,
        characterId: character.id,
      }).listSessions(),
    ).rejects.toMatchObject({code: 'malformed_record'});

    // A catalog row whose transcript never materialized reads as empty.
    const ghost = feed.readNewMessages({sessionId: 'ghost'});

    expect(ghost.messages).toEqual([]);
    expect(ghost.reset).toBe(false);
  });

  it('resets when the transcript shrinks or the cursor is unreadable', async () => {
    const storeRoot = createStoreRoot();

    await writeDurableSession({
      storeRoot,
      conversationId: 'shrinks',
      exchanges: [['forget this thread', 'ok']],
    });

    const feed = createLocalRuntimeSessionHistoryFeed({
      storeRoot,
      characterId: character.id,
    });
    const first = feed.readNewMessages({sessionId: 'shrinks.1'});

    expect(first.messages).toHaveLength(2);

    truncateSync(
      createLocalRuntimeSessionPaths({storeRoot, sessionId: 'shrinks.1'})
        .rawEventsPath,
      0,
    );

    const afterShrink = feed.readNewMessages({
      sessionId: 'shrinks.1',
      cursor: first.nextCursor,
    });

    expect(afterShrink.reset).toBe(true);
    expect(afterShrink.messages).toEqual([]);

    const unreadable = feed.readNewMessages({
      sessionId: 'shrinks.1',
      cursor: 'not-a-cursor',
    });

    expect(unreadable.reset).toBe(true);
  });

  it('honors a byte budget and terminates when slicing', async () => {
    const storeRoot = createStoreRoot();

    await writeDurableSession({
      storeRoot,
      conversationId: 'sliced',
      exchanges: [
        ['first question', 'first answer'],
        ['second question', 'second answer'],
        ['third question', 'third answer'],
      ],
    });

    const feed = createLocalRuntimeSessionHistoryFeed({
      storeRoot,
      characterId: character.id,
    });
    const collected: RuntimePluginSessionHistoryMessage[] = [];
    let cursor: string | undefined;

    for (let slices = 0; slices < 100; slices += 1) {
      const batch = feed.readNewMessages({
        sessionId: 'sliced.1',
        ...(cursor === undefined ? {} : {cursor}),
        maxBytes: 4_096,
      });

      collected.push(...batch.messages);

      if (batch.nextCursor === cursor) {
        break;
      }

      cursor = batch.nextCursor;
    }

    expect(collected.map(message => message.text)).toEqual([
      'first question',
      'first answer',
      'second question',
      'second answer',
      'third question',
      'third answer',
    ]);
  });

  it('refuses a linked session directory instead of reading through it', async () => {
    const storeRoot = createStoreRoot();

    await writeDurableSession({
      storeRoot,
      conversationId: 'linked',
      exchanges: [['hello', 'hi']],
    });

    const outside = join(createTestTempRoot('project02-feed-outside-'), 'raw');

    mkdirSync(outside, {recursive: true});
    writeFileSync(join(outside, 'raw-events.jsonl'), '', 'utf8');

    const sessionRoot = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'linked.1',
    }).sessionRoot;

    rmSync(sessionRoot, {recursive: true});
    symlinkSync(outside, sessionRoot);

    const feed = createLocalRuntimeSessionHistoryFeed({
      storeRoot,
      characterId: character.id,
    });

    expect(() => feed.readNewMessages({sessionId: 'linked.1'})).toThrow(
      expect.objectContaining({code: 'read_failed'}),
    );
  });

  it('fails closed on marker problems', async () => {
    const versionedRoot = createStoreRoot();
    const layout = createLocalRuntimeStorageLayout({storeRoot: versionedRoot});

    writeFileSync(
      layout.schemaPath,
      '{"schemaVersion":7,"scope":"character-data","characterId":"mira","createdAt":"2026-07-16T00:00:00.000Z"}\n',
      'utf8',
    );
    expect(() =>
      createLocalRuntimeSessionHistoryFeed({
        storeRoot: versionedRoot,
        characterId: character.id,
      }),
    ).toThrow(expect.objectContaining({code: 'unsupported_schema_version'}));

    expect(() =>
      createLocalRuntimeSessionHistoryFeed({
        storeRoot: createStoreRoot(),
        characterId: character.id,
      }),
    ).toThrow(expect.objectContaining({code: 'missing_file'}));

    const foreignRoot = createStoreRoot();

    await writeDurableSession({
      storeRoot: foreignRoot,
      conversationId: 'theirs',
      exchanges: [['their secret', 'kept']],
      character: {id: 'nova', displayName: 'Nova'},
    });
    expect(() =>
      createLocalRuntimeSessionHistoryFeed({
        storeRoot: foreignRoot,
        characterId: character.id,
      }),
    ).toThrow(expect.objectContaining({code: 'character_identity_mismatch'}));
  });
});

function createStoreRoot(): string {
  return createTestTempRoot('project02-history-feed-');
}
