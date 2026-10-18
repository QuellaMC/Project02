import {chmodSync, mkdirSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import type {ConversationParticipant} from '../../src/core/index.ts';
import {
  acquireLocalRuntimeConversationWriterLease,
  createLocalRuntimeConversationStore,
  createLocalRuntimeMutationLockOwnerToken,
  createProject02HomeLayout,
} from '../../src/runtime/storage/index.ts';
import {createLocalRuntimeConversationPaths} from '../../src/runtime/storage/layout-contract.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

const user: ConversationParticipant = {
  kind: 'user',
  id: 'local-user',
  displayName: 'You',
};
const mira: ConversationParticipant = {
  kind: 'character',
  id: 'mira',
  displayName: 'Mira',
};
const kai: ConversationParticipant = {
  kind: 'character',
  id: 'kai',
  displayName: 'Kai',
};

function tempHomeRoot(): string {
  return join(createTestTempRoot('project02-conversations-'), 'home');
}

describe('local runtime conversation store', () => {
  it('creates, finds, reads, and lists conversations', async () => {
    const homeRoot = tempHomeRoot();
    const store = createLocalRuntimeConversationStore({
      homeRoot,
      now: () => '2026-08-20T00:00:00.000Z',
    });

    expect(await store.listConversations()).toEqual([]);
    expect(await store.findConversationWith([user, mira])).toBeUndefined();

    const created = await store.createConversation({
      id: 'talk',
      participants: [user, mira],
    });

    expect(created.id).toBe('talk');
    expect(created.participants.map(entry => entry.id)).toEqual([
      'mira',
      'local-user',
    ]);

    const generated = await store.createConversation({
      participants: [user, kai],
      createdAt: '2026-08-20T00:00:01.000Z',
    });

    expect(generated.id).toMatch(/^conv_[0-9a-f-]{36}$/u);
    expect(await store.readConversation('talk')).toEqual(created);
    expect((await store.findConversationWith([mira, user]))?.id).toBe('talk');
    expect(
      (await store.listConversations()).map(conversation => conversation.id),
    ).toEqual(['talk', generated.id]);
    await expect(store.readConversation('absent')).rejects.toMatchObject({
      code: 'conversation_not_found',
    });
  });

  it('keeps one conversation per participant set', async () => {
    const homeRoot = tempHomeRoot();
    const store = createLocalRuntimeConversationStore({homeRoot});
    const created = await store.createConversation({
      participants: [user, mira],
    });

    await expect(
      store.createConversation({participants: [mira, user]}),
    ).rejects.toMatchObject({code: 'conversation_already_exists'});
    expect((await store.ensureConversationWith([mira, user])).id).toBe(
      created.id,
    );

    const other = await store.ensureConversationWith([user, kai]);

    expect(other.id).not.toBe(created.id);
    expect(await store.listConversations()).toHaveLength(2);
  });

  it('reports a creation write failure as a storage error', async () => {
    const homeRoot = tempHomeRoot();
    const store = createLocalRuntimeConversationStore({homeRoot});
    const layout = createProject02HomeLayout({homeRoot});

    await store.createConversation({participants: [user, mira]});
    chmodSync(layout.conversationsRoot, 0o500);

    try {
      await expect(
        store.createConversation({participants: [user, kai]}),
      ).rejects.toMatchObject({code: 'write_failed'});
    } finally {
      chmodSync(layout.conversationsRoot, 0o755);
    }
  });

  it('fails closed on a home written at an older schema version', async () => {
    const homeRoot = tempHomeRoot();
    const layout = createProject02HomeLayout({homeRoot});

    mkdirSync(homeRoot, {recursive: true});
    writeFileSync(
      layout.schemaPath,
      `${JSON.stringify({
        schemaVersion: 12,
        scope: 'home',
        createdAt: '2026-08-19T00:00:00.000Z',
      })}\n`,
      'utf8',
    );

    const store = createLocalRuntimeConversationStore({homeRoot});

    await expect(store.listConversations()).rejects.toMatchObject({
      code: 'unsupported_schema_version',
    });
  });

  it('holds one writer lease per conversation, reentrant per owner', async () => {
    const homeRoot = tempHomeRoot();
    const store = createLocalRuntimeConversationStore({homeRoot});
    const conversation = await store.createConversation({
      participants: [user, mira],
    });
    const ownerToken = createLocalRuntimeMutationLockOwnerToken();
    const lease = await acquireLocalRuntimeConversationWriterLease({
      homeRoot,
      conversationId: conversation.id,
      ownerToken,
    });

    await expect(
      acquireLocalRuntimeConversationWriterLease({
        homeRoot,
        conversationId: conversation.id,
      }),
    ).rejects.toMatchObject({code: 'storage_busy'});

    const reentrant = await acquireLocalRuntimeConversationWriterLease({
      homeRoot,
      conversationId: conversation.id,
      ownerToken,
    });

    await reentrant.release();
    await lease.release();

    const successor = await acquireLocalRuntimeConversationWriterLease({
      homeRoot,
      conversationId: conversation.id,
    });

    await successor.release();
  });

  it('skips an interrupted create and fails closed on malformed threads', async () => {
    const homeRoot = tempHomeRoot();
    const store = createLocalRuntimeConversationStore({homeRoot});
    const conversation = await store.createConversation({
      participants: [user, mira],
    });
    const layout = createProject02HomeLayout({homeRoot});

    // A crash between the directory and its file leaves no conversation.
    mkdirSync(join(layout.conversationsRoot, 'interrupted'));
    expect((await store.listConversations()).map(entry => entry.id)).toEqual([
      conversation.id,
    ]);

    // Writing the file completes the interrupted create instead of refusing
    // its id forever.
    const completed = await store.createConversation({
      id: 'interrupted',
      participants: [user, kai],
    });

    expect(completed.id).toBe('interrupted');
    expect((await store.listConversations()).map(entry => entry.id)).toEqual([
      conversation.id,
      'interrupted',
    ]);

    const damaged = createLocalRuntimeConversationPaths({
      homeRoot,
      conversationId: 'damaged',
    });

    mkdirSync(damaged.conversationRoot);
    writeFileSync(damaged.conversationPath, '{"id":"damaged"', 'utf8');
    await expect(store.listConversations()).rejects.toMatchObject({
      code: 'malformed_record',
    });
  });

  it('refuses a conversation whose record names another directory', async () => {
    const homeRoot = tempHomeRoot();
    const store = createLocalRuntimeConversationStore({homeRoot});
    const conversation = await store.createConversation({
      participants: [user, mira],
    });
    const moved = createLocalRuntimeConversationPaths({
      homeRoot,
      conversationId: 'moved',
    });
    const original = createLocalRuntimeConversationPaths({
      homeRoot,
      conversationId: conversation.id,
    });

    mkdirSync(moved.conversationRoot);
    writeFileSync(
      moved.conversationPath,
      `${JSON.stringify(conversation)}\n`,
      'utf8',
    );
    await expect(store.readConversation('moved')).rejects.toMatchObject({
      code: 'malformed_record',
    });
    expect(original.conversationRoot).not.toBe(moved.conversationRoot);
  });

  it('refuses a symlinked conversation directory', async () => {
    const homeRoot = tempHomeRoot();
    const store = createLocalRuntimeConversationStore({homeRoot});
    const conversation = await store.createConversation({
      participants: [user, mira],
    });
    const outside = createTestTempRoot('project02-conversation-target-');
    const layout = createProject02HomeLayout({homeRoot});

    symlinkSync(outside, join(layout.conversationsRoot, 'linked'));
    await expect(store.listConversations()).rejects.toMatchObject({
      code: 'read_failed',
    });
    await expect(store.readConversation('linked')).rejects.toMatchObject({
      code: 'read_failed',
    });
    expect(conversation.id).not.toBe('linked');
  });
});
