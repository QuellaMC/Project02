import {testCharacterProfile} from '../support/character-fixtures.ts';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {
  ConversationRehydrationError,
  createSession,
  createUserMessageRuntimeEvent,
} from '../../src/core/index.ts';
import {createRuntimePluginHost} from '../../src/plugins/host/index.ts';
import {createDeterministicTestRoleModelAdapter} from '../../src/role-model/index.ts';
import {
  createLocalRuntimeSessionPaths,
  createLocalRuntimeStorageLayout,
  createLocalRuntimeStorageSchemaMarker,
  encodeStorageSchemaMarker,
  LocalRuntimeStorageContractError,
} from '../../src/runtime/storage/layout-contract.ts';
import {
  createLocalRuntimeSessionStore,
  LocalRuntimeSessionStoreError,
} from '../../src/runtime/storage/session-store.ts';
import {createRuntimeLogStore} from '../../src/runtime/evidence/index.ts';
import {runLocalUserMessageEvent} from '../../src/runtime/turn/local.ts';
import type {ConversationLogRecord} from '../../src/runtime/evidence/records.ts';
import type {LocalRuntimeStorageContractErrorCode} from '../../src/runtime/storage/layout-contract.ts';
import type {LocalRuntimeSessionConversationLogReader} from '../../src/runtime/storage/session-store.ts';
import {assertLocalRuntimeSessionReadable} from '../../src/runtime/storage/session-store.ts';
import {
  appendCharacterMessage,
  appendUserMessage,
} from '../support/committed-messages.ts';

const tempRoots: string[] = [];

describe('local runtime session store', () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.map(async root => {
        await rm(root, {recursive: true, force: true});
      }),
    );
    tempRoots.length = 0;
  });

  it('creates, lists, and reopens conversation segments by storage-safe ID', async () => {
    const storeRoot = await createTempStoreRoot();
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-06-04T00:00:00.000Z', '2026-06-04T00:01:00.000Z']),
    });

    const first = await store.createSession({
      conversationId: 'mira-local',
    });
    const second = await store.createSession({
      conversationId: 'evening-chat',
    });

    expect(first).toEqual({
      sessionId: 'mira-local.1',
      createdAt: '2026-06-04T00:00:00.000Z',
    });
    expect(await store.listSessions()).toEqual([first, second]);
    await expect(
      store.createSession({
        conversationId: 'mira-local',
      }),
    ).rejects.toThrow(LocalRuntimeSessionStoreError);

    const reopened = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    });

    expect(await reopened.readSession('mira-local.1')).toEqual(first);
    expect(await reopened.latestSegment('mira-local')).toEqual(first);
    expect(await reopened.latestSegment('unknown')).toBeUndefined();
    expect(await reopened.listSessions()).toEqual([first, second]);
  });

  it('continues a conversation segment by segment and tracks the latest', async () => {
    const storeRoot = await createTempStoreRoot();
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock([
        '2026-06-04T00:00:00.000Z',
        '2026-06-04T00:01:00.000Z',
        '2026-06-04T00:02:00.000Z',
        '2026-06-04T00:03:00.000Z',
      ]),
    });

    const root = await store.createSession({conversationId: 'talk'});
    const second = await store.createContinuedSession({
      continuedFrom: 'talk.1',
    });
    const third = await store.createContinuedSession({
      continuedFrom: second.sessionId,
    });

    expect(second.sessionId).toBe('talk.2');
    expect(third.sessionId).toBe('talk.3');
    expect(await store.latestSegment('talk')).toEqual(third);
    // Reopening the root exactly is allowed; it stays a closed segment.
    expect(await store.readSession(root.sessionId)).toEqual(root);
    // Only the latest segment can be continued: a stale window cannot fork
    // the conversation from a closed segment.
    await expect(
      store.createContinuedSession({continuedFrom: 'talk.1'}),
    ).rejects.toThrow(/latest segment/u);
    await expect(
      store.createContinuedSession({continuedFrom: 'never-existed.1'}),
    ).rejects.toThrow(LocalRuntimeSessionStoreError);

    // A session that never received a record can be discarded — a torn tail
    // from a write that never completed is not a record; one holding
    // evidence cannot.
    await writeFile(
      createLocalRuntimeSessionPaths({storeRoot, sessionId: third.sessionId})
        .rawEventsPath,
      '{"torn": tru',
    );
    await store.discardEmptySession(third.sessionId);
    expect((await store.listSessions()).map(item => item.sessionId)).toEqual([
      root.sessionId,
      second.sessionId,
    ]);
    const rootLog = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: root.sessionId,
    }).rawEventsPath;
    await writeFile(rootLog, '{"later": true}\n');
    await expect(store.discardEmptySession(root.sessionId)).rejects.toThrow(
      /holds evidence/u,
    );
    expect(await store.readSession(root.sessionId)).toEqual(root);
  });

  it('creates sessions for a padded character ID instead of mismatching its own marker', async () => {
    const storeRoot = await createTempStoreRoot();
    // The marker this writes is canonical, so a raw comparison used to fail the
    // store against the identity it had just stamped.
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: ' mira ',
      now: fixedClock(['2026-07-26T00:00:00.000Z']),
    });

    const created = await store.createSession({conversationId: 'padded-id'});

    await expect(store.readSession('padded-id.1')).resolves.toEqual(created);
  });

  it('rejects a non-canonical creation clock without bricking the store', async () => {
    const storeRoot = await createTempStoreRoot();
    const invalid = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['not-a-time']),
    });

    await expect(
      invalid.createSession({conversationId: 'bad-time'}),
    ).rejects.toMatchObject({code: 'malformed_schema_marker'});

    const valid = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-07-11T00:00:00.000Z']),
    });
    const created = await valid.createSession({conversationId: 'good-time'});

    await expect(valid.readSession('good-time.1')).resolves.toEqual(created);
  });

  it('fails loudly when a cataloged session directory is missing before listing sessions', async () => {
    const storeRoot = await createTempStoreRoot();
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-06-04T00:00:00.000Z']),
    });
    const created = await store.createSession({
      conversationId: 'mira-local',
    });
    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: created.sessionId,
    });

    await rm(paths.sessionRoot, {recursive: true, force: true});

    await expectStorageErrorCode(
      async () => await store.listSessions(),
      'missing_file',
    );
  });

  it('validates only the requested session on point reads', async () => {
    const storeRoot = await createTempStoreRoot();
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-06-04T00:00:00.000Z', '2026-06-04T00:01:00.000Z']),
    });
    const alpha = await store.createSession({conversationId: 'alpha'});
    await store.createSession({conversationId: 'beta'});
    const betaPaths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'beta.1',
    });

    await rm(betaPaths.sessionRoot, {recursive: true, force: true});

    await expect(store.readSession('alpha.1')).resolves.toEqual(alpha);
    expect(
      assertLocalRuntimeSessionReadable({storeRoot, sessionId: 'alpha.1'}),
    ).toEqual(alpha);
    await expectStorageErrorCode(
      async () => await store.listSessions(),
      'missing_file',
    );
  });

  it('ignores an uncommitted catalog tail on a point read', async () => {
    const storeRoot = await createTempStoreRoot();
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-06-04T00:00:00.000Z']),
    });
    const alpha = await store.createSession({conversationId: 'alpha'});

    // A complete row a crash left without its committing newline.
    await writeFile(
      store.layout.sessionCatalogPath,
      `${JSON.stringify(alpha)}\n${JSON.stringify({
        ...alpha,
        sessionId: 'unfinished',
      })}`,
      'utf8',
    );

    await expect(store.readSession('unfinished')).rejects.toMatchObject({
      code: 'session_not_found',
    });
    expect(
      (await store.listSessions()).map(session => session.sessionId),
    ).toEqual(['alpha.1']);
  });

  it('ignores malformed unrelated catalog metadata on a point read', async () => {
    const storeRoot = await createTempStoreRoot();
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-06-04T00:00:00.000Z']),
    });
    const alpha = await store.createSession({conversationId: 'alpha'});

    await writeFile(
      store.layout.sessionCatalogPath,
      `${JSON.stringify(alpha)}\n${JSON.stringify({
        sessionId: 'unrelated',
        createdAt: false,
        updatedAt: false,
      })}\n`,
      'utf8',
    );

    await expect(store.readSession('alpha.1')).resolves.toEqual(alpha);
    await expectStorageErrorCode(
      async () => await store.listSessions(),
      'malformed_record',
    );
  });

  it('opens a healthy session even when another catalog row is damaged', async () => {
    const storeRoot = await createTempStoreRoot();
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-06-04T00:00:00.000Z']),
    });
    const alpha = await store.createSession({conversationId: 'alpha'});

    // A damaged row followed by a valid one, so it cannot read as an
    // unfinished append.
    await writeFile(
      store.layout.sessionCatalogPath,
      `{"sessionId":"corr\n${JSON.stringify(alpha)}\n`,
      'utf8',
    );

    await expect(store.readSession('alpha.1')).resolves.toEqual(alpha);
    await expectStorageErrorCode(
      async () => await store.listSessions(),
      'malformed_record',
    );
  });

  it('rehydrates persisted visible conversation messages in order through the CT-02 reader seam', async () => {
    const storeRoot = await createTempStoreRoot();
    const logStore = createRuntimeLogStore({
      boundCharacter: testCharacterProfile,
    });
    const originalSession = createSession({
      character: testCharacterProfile,
      id: 'mira-local.1',
    });

    await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent('first', {
        eventId: 'evt_first',
        traceId: 'trace_first',
        createdAt: '2026-06-04T00:00:00.000Z',
      }),
      session: originalSession,
      logStore,
      pluginHost: createRuntimePluginHost(),
      roleModelAdapter: createDeterministicTestRoleModelAdapter(),
    });

    const reader = createConversationLogReader({
      'mira-local.1': logStore.conversationMessages(),
    });
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      conversationLogReader: reader,
      now: fixedClock(['2026-06-04T00:02:00.000Z']),
    });

    await store.createSession({
      conversationId: 'mira-local',
    });

    const rehydrated = await store.rehydrateSession('mira-local.1');

    expect(rehydrated.visibleTranscript).toEqual([
      {
        id: 'mira-local.1:message-1',
        role: 'user',
        speakerId: 'local-user',
        speakerName: 'You',
        text: 'first',
      },
      {
        id: 'mira-local.1:message-2',
        role: 'character',
        speakerId: 'mira',
        speakerName: 'Mira',
        text: "I'm here. Tell me what you need.",
      },
    ]);
  });

  it('resumes a second turn with prior visible context and appends IDs after restored records', async () => {
    const storeRoot = await createTempStoreRoot();
    const reader = createConversationLogReader({
      'mira-local.1': [
        createConversationRecord({
          id: 'mira-local.1:message-1',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'first',
        }),
        createConversationRecord({
          id: 'mira-local.1:message-2',
          role: 'character',
          speakerId: 'mira',
          speakerName: 'Mira',
          text: "I'm here. Tell me what you need.",
        }),
      ],
    });
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      conversationLogReader: reader,
      now: fixedClock(['2026-06-04T00:00:00.000Z']),
    });

    await store.createSession({
      conversationId: 'mira-local',
    });

    const rehydrated = await store.rehydrateSession('mira-local.1');

    expect(rehydrated.visibleTranscript.map(message => message.text)).toEqual([
      'first',
      "I'm here. Tell me what you need.",
    ]);

    const userMessage = appendUserMessage(rehydrated, 'second');
    const characterMessage = appendCharacterMessage(rehydrated, {
      text: 'reply after rehydration',
    });

    expect(userMessage.id).toBe('mira-local.1:message-3');
    expect(characterMessage.id).toBe('mira-local.1:message-4');
  });

  it('keeps separate session transcripts isolated during rehydration', async () => {
    const storeRoot = await createTempStoreRoot();
    const reader = createConversationLogReader({
      'alpha.1': [
        createConversationRecord({
          id: 'alpha.1:message-1',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'alpha first',
        }),
        createConversationRecord({
          id: 'alpha.1:message-2',
          role: 'character',
          speakerId: 'mira',
          speakerName: 'Mira',
          text: 'alpha reply',
        }),
      ],
      'beta.1': [
        createConversationRecord({
          id: 'beta.1:message-1',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'beta first',
        }),
        createConversationRecord({
          id: 'beta.1:message-2',
          role: 'character',
          speakerId: 'mira',
          speakerName: 'Mira',
          text: 'beta reply',
        }),
      ],
    });
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      conversationLogReader: reader,
      now: fixedClock(['2026-06-04T00:00:00.000Z', '2026-06-04T00:01:00.000Z']),
    });

    await store.createSession({
      conversationId: 'alpha',
    });
    await store.createSession({
      conversationId: 'beta',
    });

    const alpha = await store.rehydrateSession('alpha.1');
    const beta = await store.rehydrateSession('beta.1');

    appendUserMessage(alpha, 'second');
    const alphaReply = appendCharacterMessage(alpha, {text: 'alpha again'});
    appendUserMessage(beta, 'second');
    const betaReply = appendCharacterMessage(beta, {text: 'beta again'});

    expect(alphaReply.id).toBe('alpha.1:message-4');
    expect(betaReply.id).toBe('beta.1:message-4');
    expect(alpha.visibleTranscript.map(message => message.text)).toEqual([
      'alpha first',
      'alpha reply',
      'second',
      'alpha again',
    ]);
    expect(beta.visibleTranscript.map(message => message.text)).toEqual([
      'beta first',
      'beta reply',
      'second',
      'beta again',
    ]);
  });

  it('fails loudly when persisted visible messages are malformed', async () => {
    const storeRoot = await createTempStoreRoot();
    const reader = createConversationLogReader({
      'alpha.1': [
        createConversationRecord({
          id: 'other-session:message-1',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'wrong owner',
        }),
      ],
    });
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      conversationLogReader: reader,
      now: fixedClock(['2026-06-04T00:00:00.000Z']),
    });

    await store.createSession({
      conversationId: 'alpha',
    });

    await expect(store.rehydrateSession('alpha.1')).rejects.toThrow(
      ConversationRehydrationError,
    );
  });

  it('fails clearly when CT-02 has not provided a conversation log reader', async () => {
    const storeRoot = await createTempStoreRoot();
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-06-04T00:00:00.000Z']),
    });

    await store.createSession({
      conversationId: 'alpha',
    });

    await expect(store.rehydrateSession('alpha.1')).rejects.toThrow(
      LocalRuntimeSessionStoreError,
    );
  });

  it('keeps listing sessions when a crash cut the catalog short', async () => {
    const storeRoot = await createTempStoreRoot();
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-06-04T00:00:00.000Z', '2026-06-04T00:01:00.000Z']),
    });
    const alpha = await store.createSession({conversationId: 'alpha'});

    await store.createSession({conversationId: 'beta'});
    // The catalog write died partway through its second entry.
    await writeFile(
      store.layout.sessionCatalogPath,
      `${JSON.stringify(alpha)}\n{"sessionId":"be`,
      'utf8',
    );

    await expect(store.listSessions()).resolves.toEqual([alpha]);
    await expect(store.readSession('alpha.1')).resolves.toEqual(alpha);
  });

  it('fails non-canonical session IDs in stored catalog records', async () => {
    const storeRoot = await createTempStoreRoot();
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-06-04T00:00:00.000Z']),
    });

    await store.createSession({
      conversationId: 'alpha',
    });
    await writeFile(
      store.layout.sessionCatalogPath,
      `${JSON.stringify({
        sessionId: 'alpha ',
        createdAt: '2026-06-04T00:00:00.000Z',
        updatedAt: '2026-06-04T00:00:00.000Z',
      })}\n`,
      'utf8',
    );

    await expectStorageErrorCode(
      async () => await store.listSessions(),
      'malformed_record',
    );

    await writeFile(
      store.layout.sessionCatalogPath,
      `${JSON.stringify({
        sessionId: 'alpha/beta',
        createdAt: '2026-06-04T00:00:00.000Z',
        updatedAt: '2026-06-04T00:00:00.000Z',
      })}\n`,
      'utf8',
    );
    await expectStorageErrorCode(
      async () => await store.listSessions(),
      'malformed_record',
    );
  });

  it('rejects pre-split schema 1 markers after the clean cut', async () => {
    const storeRoot = await createTempStoreRoot();
    const layout = createLocalRuntimeStorageLayout({storeRoot});
    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'mira-local.1',
    });

    await mkdir(paths.sessionRoot, {recursive: true});
    await writeFile(
      layout.schemaPath,
      `${JSON.stringify({
        schemaVersion: 1,
        createdAt: '2026-06-04T00:00:00.000Z',
      })}\n`,
      'utf8',
    );

    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-06-04T00:05:00.000Z']),
    });

    await expect(store.listSessions()).rejects.toMatchObject({
      code: 'unsupported_schema_version',
    });
  });

  it('does not report an empty store when its root is nested below a file', async () => {
    const parentRoot = await createTempStoreRoot();
    const blockingPath = join(parentRoot, 'not-a-directory');
    const storeRoot = join(blockingPath, 'mira');

    await writeFile(blockingPath, 'not a directory\n', 'utf8');

    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    });

    await expect(store.listSessions()).rejects.toMatchObject({
      name: 'LocalRuntimeStorageContractError',
      code: 'read_failed',
    });
  });

  it('tolerates empty orphan session directories when the catalog was never created', async () => {
    const storeRoot = await createTempStoreRoot();
    const layout = createLocalRuntimeStorageLayout({storeRoot});
    const orphanPaths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'orphan.1',
    });

    await mkdir(orphanPaths.sessionRoot, {recursive: true});
    await writeFile(
      layout.schemaPath,
      `${encodeStorageSchemaMarker(
        createLocalRuntimeStorageSchemaMarker({
          scope: 'character-data',
          characterId: 'mira',
          createdAt: '2026-06-04T00:00:00.000Z',
        }),
      )}\n`,
      'utf8',
    );

    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-06-04T00:01:00.000Z']),
    });

    await expect(store.listSessions()).resolves.toEqual([]);

    const created = await store.createSession({
      conversationId: 'fresh',
    });

    expect(created).toEqual({
      sessionId: 'fresh.1',
      createdAt: '2026-06-04T00:01:00.000Z',
    });
    await expect(readFile(layout.sessionCatalogPath, 'utf8')).resolves.toBe(
      `${JSON.stringify(created)}\n`,
    );
  });

  it('fails empty session catalogs when session directories contain durable evidence', async () => {
    const storeRoot = await createTempStoreRoot();
    const layout = createLocalRuntimeStorageLayout({storeRoot});
    const orphanPaths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'orphan.1',
    });

    await mkdir(orphanPaths.sessionRoot, {recursive: true});
    await writeFile(
      layout.schemaPath,
      `${encodeStorageSchemaMarker(
        createLocalRuntimeStorageSchemaMarker({
          scope: 'character-data',
          characterId: 'mira',
          createdAt: '2026-06-04T00:00:00.000Z',
        }),
      )}\n`,
      'utf8',
    );
    await writeFile(layout.sessionCatalogPath, '', 'utf8');
    await writeFile(orphanPaths.rawEventsPath, '{"orphan":true}\n', 'utf8');

    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-06-04T00:01:00.000Z']),
    });

    await expectStorageErrorCode(
      async () => await store.listSessions(),
      'missing_file',
    );
    await expectStorageErrorCode(
      async () =>
        await store.createSession({
          conversationId: 'fresh',
        }),
      'missing_file',
    );
    await expectStorageErrorCode(
      async () =>
        await Promise.resolve(
          assertLocalRuntimeSessionReadable({
            storeRoot,
            sessionId: 'orphan.1',
          }),
        ),
      'missing_file',
    );
    await expect(readFile(layout.sessionCatalogPath, 'utf8')).resolves.toBe('');
  });

  it('rejects creating an uncataloged session over durable directory evidence', async () => {
    const storeRoot = await createTempStoreRoot();
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-06-04T00:00:00.000Z', '2026-06-04T00:01:00.000Z']),
    });

    const existing = await store.createSession({
      conversationId: 'cataloged',
    });
    const orphanPaths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'orphan.1',
    });
    await mkdir(orphanPaths.sessionRoot, {recursive: true});
    await writeFile(orphanPaths.rawEventsPath, '{"orphan":true}\n', 'utf8');

    await expectStorageErrorCode(
      async () =>
        await store.createSession({
          conversationId: 'orphan',
        }),
      'missing_file',
    );
    await expect(
      readFile(store.layout.sessionCatalogPath, 'utf8'),
    ).resolves.toBe(`${JSON.stringify(existing)}\n`);
  });

  it('creates an uncataloged session only after verifying its directory is empty', async () => {
    const storeRoot = await createTempStoreRoot();
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-06-04T00:00:00.000Z', '2026-06-04T00:01:00.000Z']),
    });

    const existing = await store.createSession({
      conversationId: 'cataloged',
    });
    const emptyPaths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'empty-orphan.1',
    });
    await mkdir(emptyPaths.sessionRoot, {recursive: true});

    const created = await store.createSession({
      conversationId: 'empty-orphan',
    });

    expect(await store.listSessions()).toEqual([existing, created]);
  });

  it('treats a torn uncataloged directory as an interrupted discard and reuses it', async () => {
    const storeRoot = await createTempStoreRoot();
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-06-04T00:00:00.000Z', '2026-06-04T00:01:00.000Z']),
    });
    const first = await store.createSession({conversationId: 'talk'});
    const tornPaths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'talk.2',
    });

    // An interrupted discard rewrote the catalog without the segment but
    // crashed before deleting its torn opening record.
    await mkdir(tornPaths.sessionRoot, {recursive: true});
    await writeFile(
      tornPaths.rawEventsPath,
      '{"kind":"session_continu',
      'utf8',
    );

    expect(await store.listSessions()).toEqual([first]);
    expect((await store.latestSegment('talk'))?.sessionId).toBe('talk.1');

    const continued = await store.createContinuedSession({
      continuedFrom: 'talk.1',
    });

    expect(continued.sessionId).toBe('talk.2');
    expect(await store.listSessions()).toEqual([first, continued]);
  });

  it('tolerates an empty sessions root when the schema marker was never created', async () => {
    const storeRoot = await createTempStoreRoot();
    const layout = createLocalRuntimeStorageLayout({storeRoot});

    await mkdir(layout.sessionsRoot, {recursive: true});

    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-06-04T00:02:00.000Z']),
    });
    const created = await store.createSession({
      conversationId: 'fresh',
    });

    expect(created).toEqual({
      sessionId: 'fresh.1',
      createdAt: '2026-06-04T00:02:00.000Z',
    });
    await expect(readFile(layout.sessionCatalogPath, 'utf8')).resolves.toBe(
      `${JSON.stringify(created)}\n`,
    );
  });

  it('rejects a symlinked character overlay before initializing storage', async () => {
    const storeRoot = await createTempStoreRoot();
    const controlTargetRoot = await createTempRoot(
      'project02-session-store-control-target-',
    );
    const layout = createLocalRuntimeStorageLayout({storeRoot});
    const targetPath = join(controlTargetRoot, 'config.target');

    await writeFile(targetPath, '{}\n', 'utf8');
    await symlink(targetPath, layout.configPath);

    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-06-04T00:02:00.000Z']),
    });

    await expect(
      store.createSession({conversationId: 'fresh'}),
    ).rejects.toMatchObject({code: 'missing_file'});
  });

  it('refuses to initialize a character data directory containing a stray file', async () => {
    const storeRoot = await createTempStoreRoot();

    await writeFile(join(storeRoot, 'notes.txt'), 'not ours\n', 'utf8');

    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-06-04T00:02:00.000Z']),
    });

    await expect(
      store.createSession({conversationId: 'fresh'}),
    ).rejects.toMatchObject({
      name: 'LocalRuntimeStorageContractError',
      code: 'missing_file',
    });
  });
});

async function createTempStoreRoot(): Promise<string> {
  return await createTempRoot('project02-session-store-');
}

async function createTempRoot(prefix: string): Promise<string> {
  const storeRoot = await mkdtemp(join(tmpdir(), prefix));

  tempRoots.push(storeRoot);
  return storeRoot;
}

function fixedClock(times: readonly string[]): () => string {
  let index = 0;

  return () => {
    const time = times[index] ?? times[times.length - 1];

    if (time === undefined) {
      throw new Error('Expected fixed clock to have at least one time.');
    }

    index += 1;
    return time;
  };
}

function createConversationLogReader(
  recordsBySessionId: Readonly<
    Record<string, readonly ConversationLogRecord[]>
  >,
): LocalRuntimeSessionConversationLogReader {
  return {
    readConversationEvidence(sessionId) {
      return {
        character: testCharacterProfile,
        messages: recordsBySessionId[sessionId] ?? [],
      };
    },
  };
}

function createConversationRecord(
  message: Pick<
    ConversationLogRecord,
    'id' | 'role' | 'speakerId' | 'speakerName' | 'text'
  >,
): ConversationLogRecord {
  return Object.freeze({
    eventId: 'evt_persisted',
    traceId: 'trace_persisted',
    createdAt: '2026-06-04T00:00:00.000Z',
    committedAt: '2026-06-04T00:00:01.000Z',
    ...message,
  } satisfies ConversationLogRecord);
}

async function expectStorageErrorCode(
  operation: () => Promise<unknown>,
  code: LocalRuntimeStorageContractErrorCode,
): Promise<void> {
  try {
    await operation();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(LocalRuntimeStorageContractError);

    if (!(error instanceof LocalRuntimeStorageContractError)) {
      throw new Error('Expected LocalRuntimeStorageContractError.', {
        cause: error,
      });
    }

    expect(error.code).toBe(code);
    return;
  }

  throw new Error(`Expected local runtime storage error code "${code}".`);
}
