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
  appendCommittedMessage,
  type ConversationSession,
  type VisibleMessage,
  createCharacterMessage,
  createUserMessage,
  ConversationRehydrationError,
  createConversationSession,
  createUserMessageRuntimeEvent,
} from '../../src/core/index.ts';
import {createRuntimePluginHost} from '../../src/plugins/host/index.ts';
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

  it('creates, lists, reopens, and selects sessions by storage-safe ID', async () => {
    const storeRoot = await createTempStoreRoot();
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-06-04T00:00:00.000Z', '2026-06-04T00:01:00.000Z']),
    });

    const first = await store.createSession({
      sessionId: 'mira-local',
    });
    const second = await store.createSession({
      sessionId: 'evening-chat',
    });

    expect(await store.listSessions()).toEqual([first, second]);
    await expect(
      store.createSession({
        sessionId: 'mira-local',
      }),
    ).rejects.toThrow(LocalRuntimeSessionStoreError);

    const reopened = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-06-04T00:05:00.000Z']),
    });
    const selected = await reopened.selectSession('mira-local');

    expect(selected).toEqual({
      sessionId: 'mira-local',
      createdAt: '2026-06-04T00:00:00.000Z',
      updatedAt: '2026-06-04T00:05:00.000Z',
    });
    expect(await reopened.readSession('mira-local')).toEqual(selected);
    expect(await reopened.listSessions()).toEqual([selected, second]);
  });

  it('creates sessions for a padded character ID instead of mismatching its own marker', async () => {
    const storeRoot = await createTempStoreRoot();
    // An embedded caller can hand this seam an unnormalized ID. The marker
    // it writes is canonical, so a raw comparison failed the store against
    // the identity it had just stamped, after durable state existed.
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: ' mira ',
      now: fixedClock(['2026-07-26T00:00:00.000Z']),
    });

    const created = await store.createSession({sessionId: 'padded-id'});

    await expect(store.readSession('padded-id')).resolves.toEqual(created);
  });

  it('rejects a non-canonical creation clock without bricking the store', async () => {
    const storeRoot = await createTempStoreRoot();
    const invalid = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['not-a-time']),
    });

    await expect(
      invalid.createSession({sessionId: 'bad-time'}),
    ).rejects.toMatchObject({code: 'malformed_schema_marker'});

    const valid = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-07-11T00:00:00.000Z']),
    });
    const created = await valid.createSession({sessionId: 'good-time'});

    await expect(valid.readSession('good-time')).resolves.toEqual(created);
  });

  it('fails loudly when a cataloged session directory is missing before listing sessions', async () => {
    const storeRoot = await createTempStoreRoot();
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-06-04T00:00:00.000Z']),
    });
    const created = await store.createSession({
      sessionId: 'mira-local',
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
    const alpha = await store.createSession({sessionId: 'alpha'});
    await store.createSession({sessionId: 'beta'});
    const betaPaths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'beta',
    });

    await rm(betaPaths.sessionRoot, {recursive: true, force: true});

    await expect(store.readSession('alpha')).resolves.toEqual(alpha);
    expect(
      assertLocalRuntimeSessionReadable({storeRoot, sessionId: 'alpha'}),
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
    const alpha = await store.createSession({sessionId: 'alpha'});

    // A complete row that a crash left without its committing newline: it
    // is not an entry yet, so neither read may report it.
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
    ).toEqual(['alpha']);
  });

  it('ignores malformed unrelated catalog metadata on a point read', async () => {
    const storeRoot = await createTempStoreRoot();
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-06-04T00:00:00.000Z']),
    });
    const alpha = await store.createSession({sessionId: 'alpha'});

    await writeFile(
      store.layout.sessionCatalogPath,
      `${JSON.stringify(alpha)}\n${JSON.stringify({
        sessionId: 'unrelated',
        createdAt: false,
        updatedAt: false,
      })}\n`,
      'utf8',
    );

    await expect(store.readSession('alpha')).resolves.toEqual(alpha);
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
    const alpha = await store.createSession({sessionId: 'alpha'});

    // A syntactically damaged row for a different session, with a valid
    // row after it so it cannot be read as an unfinished append.
    await writeFile(
      store.layout.sessionCatalogPath,
      `{"sessionId":"corr\n${JSON.stringify(alpha)}\n`,
      'utf8',
    );

    // Alpha's own entry and directory are intact, so opening it works.
    await expect(store.readSession('alpha')).resolves.toEqual(alpha);
    // Listing is where the damage is reported.
    await expectStorageErrorCode(
      async () => await store.listSessions(),
      'malformed_record',
    );
  });

  it('requires readConversationEvidence from readers at the type level', () => {
    // The home/character-data split made evidence mandatory: a reader
    // without it is a compile-time migration, not a rehydrate call that
    // fails at runtime. This fails to compile if the method becomes
    // optional again.
    type MessagesOnlyReader = {
      readConversationMessages: () => readonly [];
    };
    type MessagesOnlyReaderIsAccepted =
      MessagesOnlyReader extends LocalRuntimeSessionConversationLogReader
        ? true
        : false;
    const messagesOnlyReaderIsAccepted: MessagesOnlyReaderIsAccepted = false;

    expect(messagesOnlyReaderIsAccepted).toBe(false);
  });

  it('rehydrates persisted visible conversation messages in order through the CT-02 reader seam', async () => {
    const storeRoot = await createTempStoreRoot();
    const logStore = createRuntimeLogStore({
      boundCharacter: testCharacterProfile,
    });
    const originalSession = createConversationSession({
      character: testCharacterProfile,
      id: 'mira-local',
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
    });

    const reader = createConversationLogReader({
      'mira-local': logStore.conversationMessages(),
    });
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      conversationLogReader: reader,
      now: fixedClock(['2026-06-04T00:02:00.000Z']),
    });

    await store.createSession({
      sessionId: 'mira-local',
    });

    const rehydrated = await store.rehydrateConversationSession('mira-local');

    expect(rehydrated.visibleTranscript).toEqual([
      {
        id: 'mira-local:message-1',
        role: 'user',
        speakerId: 'local-user',
        speakerName: 'You',
        text: 'first',
      },
      {
        id: 'mira-local:message-2',
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
      'mira-local': [
        createConversationRecord({
          id: 'mira-local:message-1',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'first',
        }),
        createConversationRecord({
          id: 'mira-local:message-2',
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
      sessionId: 'mira-local',
    });

    const rehydrated = await store.rehydrateConversationSession('mira-local');

    expect(rehydrated.visibleTranscript.map(message => message.text)).toEqual([
      'first',
      "I'm here. Tell me what you need.",
    ]);

    const userMessage = appendUserMessage(rehydrated, 'second');
    const characterMessage = appendCharacterMessage(rehydrated, {
      text: 'reply after rehydration',
    });

    expect(userMessage.id).toBe('mira-local:message-3');
    expect(characterMessage.id).toBe('mira-local:message-4');
  });

  it('keeps separate session transcripts isolated during rehydration', async () => {
    const storeRoot = await createTempStoreRoot();
    const reader = createConversationLogReader({
      alpha: [
        createConversationRecord({
          id: 'alpha:message-1',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'alpha first',
        }),
        createConversationRecord({
          id: 'alpha:message-2',
          role: 'character',
          speakerId: 'mira',
          speakerName: 'Mira',
          text: 'alpha reply',
        }),
      ],
      beta: [
        createConversationRecord({
          id: 'beta:message-1',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'beta first',
        }),
        createConversationRecord({
          id: 'beta:message-2',
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
      sessionId: 'alpha',
    });
    await store.createSession({
      sessionId: 'beta',
    });

    const alpha = await store.rehydrateConversationSession('alpha');
    const beta = await store.rehydrateConversationSession('beta');

    appendUserMessage(alpha, 'second');
    const alphaReply = appendCharacterMessage(alpha, {text: 'alpha again'});
    appendUserMessage(beta, 'second');
    const betaReply = appendCharacterMessage(beta, {text: 'beta again'});

    expect(alphaReply.id).toBe('alpha:message-4');
    expect(betaReply.id).toBe('beta:message-4');
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
      alpha: [
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
      sessionId: 'alpha',
    });

    await expect(store.rehydrateConversationSession('alpha')).rejects.toThrow(
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
      sessionId: 'alpha',
    });

    await expect(store.rehydrateConversationSession('alpha')).rejects.toThrow(
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
    const alpha = await store.createSession({sessionId: 'alpha'});

    await store.createSession({sessionId: 'beta'});
    // The catalog write died partway through its second entry.
    await writeFile(
      store.layout.sessionCatalogPath,
      `${JSON.stringify(alpha)}\n{"sessionId":"be`,
      'utf8',
    );

    // The session whose entry landed is still listed and still opens; the
    // one whose entry did not is simply absent.
    await expect(store.listSessions()).resolves.toEqual([alpha]);
    await expect(store.readSession('alpha')).resolves.toEqual(alpha);
  });

  it('fails non-canonical session IDs in stored catalog records', async () => {
    const storeRoot = await createTempStoreRoot();
    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-06-04T00:00:00.000Z']),
    });

    await store.createSession({
      sessionId: 'alpha',
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
      sessionId: 'mira-local',
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
      sessionId: 'orphan',
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
      sessionId: 'fresh',
    });

    expect(created).toEqual({
      sessionId: 'fresh',
      createdAt: '2026-06-04T00:01:00.000Z',
      updatedAt: '2026-06-04T00:01:00.000Z',
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
      sessionId: 'orphan',
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
    await writeFile(orphanPaths.conversationPath, '{"orphan":true}\n', 'utf8');

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
          sessionId: 'fresh',
        }),
      'missing_file',
    );
    await expectStorageErrorCode(
      async () =>
        await Promise.resolve(
          assertLocalRuntimeSessionReadable({
            storeRoot,
            sessionId: 'orphan',
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
      sessionId: 'cataloged',
    });
    const orphanPaths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'orphan',
    });
    await mkdir(orphanPaths.sessionRoot, {recursive: true});
    await writeFile(orphanPaths.conversationPath, '{"orphan":true}\n', 'utf8');

    await expectStorageErrorCode(
      async () =>
        await store.createSession({
          sessionId: 'orphan',
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
      sessionId: 'cataloged',
    });
    const emptyPaths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'empty-orphan',
    });
    await mkdir(emptyPaths.sessionRoot, {recursive: true});

    const created = await store.createSession({
      sessionId: 'empty-orphan',
    });

    expect(await store.listSessions()).toEqual([existing, created]);
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
      sessionId: 'fresh',
    });

    expect(created).toEqual({
      sessionId: 'fresh',
      createdAt: '2026-06-04T00:02:00.000Z',
      updatedAt: '2026-06-04T00:02:00.000Z',
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
      store.createSession({sessionId: 'fresh'}),
    ).rejects.toMatchObject({code: 'missing_file'});
  });

  it('refuses to initialize a character data directory containing a stray .env', async () => {
    const storeRoot = await createTempStoreRoot();

    await writeFile(join(storeRoot, '.env'), 'API_KEY=nope\n', 'utf8');

    const store = createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
      now: fixedClock(['2026-06-04T00:02:00.000Z']),
    });

    await expect(
      store.createSession({sessionId: 'fresh'}),
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
    readConversationMessages(sessionId) {
      return recordsBySessionId[sessionId] ?? [];
    },
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

function appendUserMessage(
  session: ConversationSession,
  text: string | undefined,
): VisibleMessage {
  const message = createUserMessage(session, text);

  appendCommittedMessage(session, message);
  return message;
}

function appendCharacterMessage(
  session: ConversationSession,
  reply: unknown,
): VisibleMessage {
  const message = createCharacterMessage(session, reply);

  appendCommittedMessage(session, message);
  return message;
}
