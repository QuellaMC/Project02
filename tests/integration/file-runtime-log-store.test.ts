import {testCharacterProfile} from '../support/character-fixtures.ts';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {createTestTempRoot} from '../support/temp-root.ts';

import {
  createFileRuntimeLogStore,
  durableRuntimeSessionCharacterProfile,
} from '../../src/runtime/storage/file-runtime-log-store.ts';
import {findRuntimeTurnTerminalRawEvent} from '../../src/runtime/evidence/validation.ts';
import {
  acquireLocalRuntimeSessionWriterLease,
  createLocalRuntimeSessionStore,
} from '../../src/runtime/storage/session-store.ts';
import {createLocalRuntimeMutationLockOwnerToken} from '../../src/runtime/storage/mutation-lock.ts';
import {
  createConversationSession,
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
} from '../../src/core/index.ts';
import {runLocalUserMessageEvent} from '../../src/runtime/turn/local.ts';
import type {RuntimeLogStore} from '../../src/runtime/evidence/contract.ts';
import {
  defaultRoleModelProviderCapabilities,
  type RoleModelAdapter,
  roleModelCommitValidationFailureRejectionReason,
  roleModelDecisionContractVersion,
  type RoleModelProviderExchangeSnapshot,
  visibleReplyModelToolName,
} from '../../src/role-model/index.ts';
import {characterStatePatchModelToolName} from '../../src/plugins/api/contract.ts';
import {firstPartyModelToolsPluginId} from '../../src/plugins/index.ts';
import {
  LocalRuntimeStorageContractError,
  createLocalRuntimeStorageLayout,
} from '../../src/runtime/storage/layout-contract.ts';
import {decodeRawEventLogRecord} from '../../src/runtime/storage/raw-event-codec.ts';
import {createDefaultProject02PluginHost} from '../support/default-plugin-host.ts';
import {createRawEventAppendFailingLogStore} from '../support/plugin-tool-loop-fixtures.ts';
import {createRuntimePluginHost} from '../../src/plugins/host/index.ts';
import {
  createRuntimePlugin,
  createRuntimePluginHealthSnapshot,
} from '../../src/plugins/api/index.ts';
import {runtimePluginContractVersion} from '../../src/plugins/api/contract.ts';
import type {RuntimePluginHealthStatus} from '../../src/plugins/api/contract.ts';
import {
  createNvidiaRoleModelProviderAdapter,
  type NvidiaFetchClient,
} from '../../src/role-model/providers/nvidia.ts';

describe('file runtime log store plugin tool event validation', () => {
  it('rejects a store before reading or mutating data owned by another character', async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'session-foreign-character-marker';
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'foreign-character',
    }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const evidenceReads: string[] = [];
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
      onEvidenceFileRead: event => evidenceReads.push(event.filePath),
    });
    const paths = logStore.localRuntimeSessionPaths;

    if (paths === undefined) {
      throw new Error('Expected file runtime log store session paths.');
    }

    const schemaPath = createLocalRuntimeStorageLayout({storeRoot}).schemaPath;
    const markerBeforeMutation = readFileSync(schemaPath, 'utf8');

    writeFileSync(paths.rawEventsPath, '', 'utf8');

    const writerLease = await acquireLocalRuntimeSessionWriterLease({
      storeRoot,
      sessionId,
      ownerToken: fileLogStoreWriterOwnerToken(logStore),
    });

    try {
      expect(() =>
        logStore.appendRawEvent({
          ...identity('evt_foreign_character_marker'),
          kind: 'runtime_event_received',
          eventType: 'USER_MESSAGE',
        }),
      ).toThrow(
        expect.objectContaining({
          code: 'character_identity_mismatch',
        }),
      );
      expect(evidenceReads).toEqual([]);
      expect(readFileSync(paths.rawEventsPath, 'utf8')).toBe('');
      expect(readFileSync(schemaPath, 'utf8')).toBe(markerBeforeMutation);
    } finally {
      await writerLease.release();
    }
  });

  it("refuses a store mutation under another owner token's writer lease", async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'session-owner-token-append';
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const ownerA = createLocalRuntimeMutationLockOwnerToken();
    const ownerB = createLocalRuntimeMutationLockOwnerToken();
    const storeA = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
      writerLockOwnerToken: ownerA,
    });
    const storeB = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
      writerLockOwnerToken: ownerB,
    });
    const writerLease = await acquireLocalRuntimeSessionWriterLease({
      storeRoot,
      sessionId,
      ownerToken: ownerA,
    });

    try {
      expect(() =>
        storeB.appendRawEvent({
          ...identity('evt_owner_token_append'),
          kind: 'runtime_event_received',
          eventType: 'USER_MESSAGE',
        }),
      ).toThrow(expect.objectContaining({code: 'session_busy'}));
      expect(storeA.rawEvents()).toEqual([]);
    } finally {
      await writerLease.release();
    }
  });

  it('allows only the writer lease owner to scavenge abandoned evidence temporaries', async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'session-owner-token-scavenge';
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const ownerA = createLocalRuntimeMutationLockOwnerToken();
    const ownerB = createLocalRuntimeMutationLockOwnerToken();
    const storeA = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
      writerLockOwnerToken: ownerA,
    });
    const storeB = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
      writerLockOwnerToken: ownerB,
    });
    const paths = storeA.localRuntimeSessionPaths;

    if (paths === undefined) {
      throw new Error('Expected file runtime log store session paths.');
    }

    const abandonedTemporaryPath = `${paths.sessionRoot}/.raw-events.jsonl.2147483647.00000000-0000-4000-8000-000000000000.tmp`;
    writeFileSync(abandonedTemporaryPath, 'abandoned', 'utf8');
    const writerLease = await acquireLocalRuntimeSessionWriterLease({
      storeRoot,
      sessionId,
      ownerToken: ownerA,
    });

    try {
      storeB.readSessionEvidence();
      expect(existsSync(abandonedTemporaryPath)).toBe(true);

      storeA.readSessionEvidence();
      expect(existsSync(abandonedTemporaryPath)).toBe(false);
    } finally {
      await writerLease.release();
    }
  });

  it('rejects low-level durable mutation without the active session writer lease', async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'session-low-level-writer';
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });

    expect(() =>
      logStore.appendRawEvent({
        ...identity('evt_low_level_writer'),
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'session_busy',
      }),
    );
    expect(logStore.readSessionEvidence().rawEvents).toEqual([]);
  });

  it('rejects canonical timestamps that disagree within one event identity', async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'session-created-at-agreement';
    const eventIdentity = identity('evt_created_at_agreement');
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      sessionId,
      createdAt: eventIdentity.createdAt,
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const paths = logStore.localRuntimeSessionPaths;

    if (paths === undefined) {
      throw new Error('Expected file runtime log store session paths.');
    }

    writeJsonLines(paths.rawEventsPath, [
      {
        ...eventIdentity,
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE',
      },
      {
        ...eventIdentity,
        createdAt: '2026-06-15T00:00:01.000Z',
        kind: 'runtime_event_normalized',
        eventType: 'USER_MESSAGE',
      },
    ]);

    expect(() => logStore.readSessionEvidence()).toThrow(
      'Runtime evidence for one event identity must share one createdAt timestamp.',
    );
  });

  it('rejects non-canonical timestamps decoded from durable evidence', async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'session-canonical-created-at';
    const eventIdentity = identity('evt_canonical_created_at');
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      sessionId,
      createdAt: eventIdentity.createdAt,
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const paths = logStore.localRuntimeSessionPaths;

    if (paths === undefined) {
      throw new Error('Expected file runtime log store session paths.');
    }

    writeJsonLines(paths.rawEventsPath, [
      {
        ...eventIdentity,
        createdAt: '2026-06-15T00:00:00Z',
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE',
      },
    ]);

    expect(() => logStore.readSessionEvidence()).toThrow(
      'Stored local runtime field "createdAt" must be a canonical UTC ISO timestamp.',
    );
  });

  it('validates full session evidence before returning an exact terminal identity', async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'session-validated-terminal-lookup';
    const eventIdentity = identity('evt_patch_completed');
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      sessionId,
      createdAt: eventIdentity.createdAt,
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const paths = logStore.localRuntimeSessionPaths;

    if (paths === undefined) {
      throw new Error('Expected file runtime log store session paths.');
    }

    writeJsonLines(paths.rawEventsPath, [patchCompletedEvent(sessionId)]);

    // The lookup takes a validated store read, so an invalid log fails
    // at the read rather than yielding a terminal.
    expect(() => reopenStore(paths).rawEvents()).toThrow(
      LocalRuntimeStorageContractError,
    );

    writeJsonLines(paths.rawEventsPath, [
      {
        ...eventIdentity,
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE',
      },
    ]);

    expect(
      findRuntimeTurnTerminalRawEvent(
        reopenStore(paths).rawEvents(),
        eventIdentity,
      ),
    ).toBeUndefined();

    writeJsonLines(paths.rawEventsPath, [
      {
        ...eventIdentity,
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE',
      },
      patchCompletedEvent(sessionId),
    ]);

    expect(
      findRuntimeTurnTerminalRawEvent(
        reopenStore(paths).rawEvents(),
        eventIdentity,
      )?.kind,
    ).toBe('runtime_turn_completed');
    expect(
      findRuntimeTurnTerminalRawEvent(reopenStore(paths).rawEvents(), {
        ...eventIdentity,
        createdAt: '2026-06-15T00:00:01.000Z',
      }),
    ).toBeUndefined();
  });

  it('rejects terminal recovery for durable logs without session metadata', async () => {
    const storeRoot = createStoreRoot();
    const eventIdentity = identity('evt_orphaned_terminal_recovery');
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      sessionId: 'catalog-session',
      createdAt: eventIdentity.createdAt,
    });
    const orphanedLogStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'orphaned-session',
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const paths = orphanedLogStore.localRuntimeSessionPaths;

    if (paths === undefined) {
      throw new Error('Expected file runtime log store session paths.');
    }

    mkdirSync(paths.sessionRoot, {recursive: true});
    writeJsonLines(paths.rawEventsPath, [
      {
        ...eventIdentity,
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE',
      },
    ]);

    expect(() => orphanedLogStore.rawEvents()).toThrow(
      LocalRuntimeStorageContractError,
    );
  });

  it('rejects malformed persisted provider exchange evidence with the storage contract error', () => {
    const malformedRecord: unknown = structuredClone(
      patchCompletedEvent('malformed-provider-exchange'),
    );
    const roleModelIOSnapshot = isTestRecord(malformedRecord)
      ? malformedRecord['roleModelIOSnapshot']
      : undefined;

    if (!isTestRecord(roleModelIOSnapshot)) {
      throw new Error('Expected role-model IO snapshot fixture.');
    }

    roleModelIOSnapshot['providerExchange'] = {
      provider: {},
    };

    expect(() =>
      decodeRawEventLogRecord(JSON.stringify(malformedRecord)),
    ).toThrow(LocalRuntimeStorageContractError);
  });

  it('rejects a persisted characterRef that disagrees with the decision context', () => {
    const tamperedRecord: unknown = structuredClone(
      patchCompletedEvent('tampered-character-ref'),
    );
    const roleModelIOSnapshot = isTestRecord(tamperedRecord)
      ? tamperedRecord['roleModelIOSnapshot']
      : undefined;

    if (!isTestRecord(roleModelIOSnapshot)) {
      throw new Error('Expected role-model IO snapshot fixture.');
    }

    // Two character identities in one snapshot: the package provenance
    // claims nova while the turn was decided as the fixture character.
    roleModelIOSnapshot['characterRef'] = {
      id: 'nova',
      version: '1.0.0',
      personaFingerprint: 'fp-foreign',
    };

    expect(() =>
      decodeRawEventLogRecord(JSON.stringify(tamperedRecord)),
    ).toThrow('characterRef id must match the decision-context character');
  });

  it('rejects an envelope that persisted no plugin tool definitions', () => {
    const malformedRecord: unknown = structuredClone(
      patchCompletedEvent('absent-plugin-tool-definitions'),
    );
    const roleModelIOSnapshot = isTestRecord(malformedRecord)
      ? malformedRecord['roleModelIOSnapshot']
      : undefined;
    const inputEnvelope = isTestRecord(roleModelIOSnapshot)
      ? roleModelIOSnapshot['inputEnvelope']
      : undefined;

    if (!isTestRecord(inputEnvelope)) {
      throw new Error('Expected role-model input envelope fixture.');
    }

    // Every envelope the runtime writes carries this array, so an absent
    // one is damage rather than an older record to reconstruct from.
    Reflect.deleteProperty(inputEnvelope, 'pluginToolDefinitions');

    expect(() =>
      decodeRawEventLogRecord(JSON.stringify(malformedRecord)),
    ).toThrow(LocalRuntimeStorageContractError);
  });

  it('rejects present requested tool names that disagree with raw evidence', async () => {
    const storedRecord = await persistedDisallowedToolRejectionRecord(
      'tampered-requested-tool-names',
    );
    const storedDecisionResult = rejectedDecisionResultRecord(storedRecord);

    storedDecisionResult['requestedToolNames'] = [visibleReplyModelToolName];

    expect(() => decodeRawEventLogRecord(JSON.stringify(storedRecord))).toThrow(
      LocalRuntimeStorageContractError,
    );
  });

  it('round-trips supported persisted plugin tool schemas unchanged', () => {
    const jsonSchema = supportedPersistedPluginToolJsonSchema();
    const storedRecord = storedRecordWithPluginToolJsonSchema(jsonSchema);
    const decodedRecord = decodeRawEventLogRecord(JSON.stringify(storedRecord));

    expect(
      decodedRecord.roleModelIOSnapshot?.inputEnvelope.pluginToolDefinitions.find(
        definition => definition.name === 'memory.capture',
      )?.inputContract,
    ).toEqual(jsonSchema);
  });

  it('rejects unsupported nested keywords in persisted plugin tool schemas', () => {
    const jsonSchema = supportedPersistedPluginToolJsonSchema();
    Object.assign(jsonSchema.properties.entries.items, {
      pattern: 'unsupported',
    });
    const storedRecord = storedRecordWithPluginToolJsonSchema(jsonSchema);

    expect(() => decodeRawEventLogRecord(JSON.stringify(storedRecord))).toThrow(
      LocalRuntimeStorageContractError,
    );
  });

  it('reloads a durable malformed provider exchange adapter rejection', async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'session-malformed-provider-exchange-rejection';
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const result = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'hello',
        identity('evt_malformed_provider_exchange_rejection'),
      ),
      session: createConversationSession({
        id: sessionId,
        character: testCharacterProfile,
      }),
      logStore,
      pluginHost: createDefaultProject02PluginHost({storeRoot, sessionId}),
      roleModelAdapter: createMalformedProviderExchangeAdapter(),
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'malformed_output',
      message: 'Role-model adapter provider exchange is malformed.',
    });

    const reloadedLogStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const reloadedTerminalEvent = reloadedLogStore.rawEvents().at(-1);
    expect(reloadedTerminalEvent).toMatchObject({
      kind: 'runtime_turn_rejected',
      parsedRoleModelDecisionSnapshot: {
        result: {
          status: 'rejected',
          rejection: {
            reason: 'malformed_output',
            details: 'Role-model adapter provider exchange is malformed.',
          },
        },
      },
    });
  });

  it('keeps provider credential-key values out of durable raw-event evidence', async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'session-provider-exchange-credential-redaction';
    const credentialSentinel = 'durable-provider-credential-sentinel';
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const fetchClient: NvidiaFetchClient = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json() {
          return Promise.resolve({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: 'Hello.',
                },
              },
            ],
            usage: {
              api_key: credentialSentinel,
              safe: 'preserved',
            },
          });
        },
        text() {
          return Promise.resolve('');
        },
      });
    const result = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'hello',
        identity('evt_provider_exchange_credential_redaction'),
      ),
      session: createConversationSession({
        id: sessionId,
        character: testCharacterProfile,
      }),
      logStore: createFileRuntimeLogStore({
        storeRoot,
        sessionId,
        characterId: testCharacterProfile.id,
        boundCharacter: testCharacterProfile,
      }),
      pluginHost: createDefaultProject02PluginHost({storeRoot, sessionId}),
      roleModelAdapter: createNvidiaRoleModelProviderAdapter({
        apiKey: 'secret',
        fetchClient,
      }),
    });

    expect(result.status).toBe('completed');

    const rawEvents = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    }).rawEvents();
    const completed = rawEvents.find(
      rawEvent => rawEvent.kind === 'runtime_turn_completed',
    );

    expect(completed?.roleModelIOSnapshot?.providerExchange?.usage).toEqual({
      api_key: '[redacted]',
      safe: 'preserved',
    });
    expect(JSON.stringify(rawEvents)).not.toContain(credentialSentinel);
  });

  it('rejects duplicate persisted allowed tools with the storage contract error', () => {
    const malformedRecord: unknown = structuredClone(
      patchCompletedEvent('duplicate-persisted-allowed-tools'),
    );
    const roleModelIOSnapshot = isTestRecord(malformedRecord)
      ? malformedRecord['roleModelIOSnapshot']
      : undefined;
    const inputEnvelope = isTestRecord(roleModelIOSnapshot)
      ? roleModelIOSnapshot['inputEnvelope']
      : undefined;

    if (!isTestRecord(inputEnvelope)) {
      throw new Error('Expected role-model input envelope fixture.');
    }

    inputEnvelope['allowedTools'] = [
      visibleReplyModelToolName,
      visibleReplyModelToolName,
      characterStatePatchModelToolName,
    ];

    expect(() =>
      decodeRawEventLogRecord(JSON.stringify(malformedRecord)),
    ).toThrow(LocalRuntimeStorageContractError);
  });

  it('persists multi-line visible conversation records', async () => {
    const storeRoot = createStoreRoot();
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      sessionId: 'session-multiline-visible',
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'session-multiline-visible',
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const session = createConversationSession({
      character: testCharacterProfile,
      id: 'session-multiline-visible',
    });
    const result = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'list tools',
        identity('evt_multiline_visible'),
      ),
      session,
      logStore,
      pluginHost: createDefaultProject02PluginHost({
        storeRoot,
        sessionId: 'session-multiline-visible',
      }),
      roleModelAdapter: createMultilineVisibleReplyAdapter(),
    });

    expect(result.status).toBe('completed');
    expect(
      logStore.conversationMessages().map(message => message.text),
    ).toEqual([
      'list tools',
      'I can use:\n- runtime.plugin.list\n- character_state.patch',
    ]);
  });

  it('preserves a custom session character in durable conversation evidence', async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'session-custom-character';
    const character = {
      id: 'nova',
      displayName: 'Nova',
    };
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: character.id,
    }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const session = createConversationSession({
      id: sessionId,
      character,
    });
    const result = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'show me the stars',
        identity('evt_custom_character'),
      ),
      session,
      logStore: createFileRuntimeLogStore({
        storeRoot,
        sessionId,
        characterId: character.id,
        boundCharacter: character,
      }),
      pluginHost: createDefaultProject02PluginHost({storeRoot, sessionId}),
      roleModelAdapter: createMultilineVisibleReplyAdapter(),
    });

    expect(result.status).toBe('completed');
    const durableStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: character.id,
      boundCharacter: character,
    });

    expect(
      durableStore
        .conversationMessages()
        .map(({role, speakerId, speakerName}) => ({
          role,
          speakerId,
          speakerName,
        })),
    ).toEqual([
      {
        role: 'user',
        speakerId: 'local-user',
        speakerName: 'You',
      },
      {
        role: 'character',
        speakerId: 'nova',
        speakerName: 'Nova',
      },
    ]);

    const rehydrated = await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: character.id,
      conversationLogReader: {
        readConversationMessages() {
          return durableStore.readSessionEvidence().conversationMessages;
        },
        readConversationEvidence() {
          const evidence = durableStore.readSessionEvidence();

          return {
            // The reader's bound character matches this store's custom
            // character; a foreign bound profile is rejected by design.
            character: durableRuntimeSessionCharacterProfile(
              evidence,
              character,
            ),
            messages: evidence.conversationMessages,
          };
        },
      },
    }).rehydrateConversationSession(sessionId);

    expect(rehydrated.character).toEqual({
      id: 'nova',
      displayName: 'Nova',
    });
    expect(rehydrated.visibleTranscript).toHaveLength(2);

    const paths = durableStore.localRuntimeSessionPaths;

    if (paths === undefined) {
      throw new Error('Expected file runtime log store session paths.');
    }

    const rawRecords = readFileSync(paths.rawEventsPath, 'utf8')
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);

    for (const rawRecord of rawRecords) {
      const message = rawRecord['visibleMessage'] as
        Record<string, unknown> | undefined;

      if (message?.['role'] === 'character') {
        message['speakerName'] = 'Not Nova';
      }
    }

    writeJsonLines(paths.rawEventsPath, rawRecords);

    expect(() =>
      createFileRuntimeLogStore({
        storeRoot,
        sessionId,
        characterId: character.id,
        boundCharacter: character,
      }).conversationMessages(),
    ).toThrow('Restored character message speaker metadata is malformed.');

    for (const rawRecord of rawRecords) {
      const message = rawRecord['visibleMessage'] as
        Record<string, unknown> | undefined;

      if (message?.['role'] === 'character') {
        message['speakerName'] = 'Nova';
      }
    }

    writeJsonLines(paths.rawEventsPath, rawRecords);

    const resumedResult = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'keep looking',
        identity('evt_custom_character_resumed'),
      ),
      session: rehydrated,
      logStore: createFileRuntimeLogStore({
        storeRoot,
        sessionId,
        characterId: character.id,
        boundCharacter: character,
      }),
      pluginHost: createDefaultProject02PluginHost({storeRoot, sessionId}),
      roleModelAdapter: createMultilineVisibleReplyAdapter(),
    });

    expect(resumedResult.status).toBe('completed');
    expect(
      createFileRuntimeLogStore({
        storeRoot,
        sessionId,
        characterId: character.id,
        boundCharacter: character,
      })
        .conversationMessages()
        .at(-1),
    ).toMatchObject({
      role: 'character',
      speakerId: 'nova',
      speakerName: 'Nova',
    });
  });

  it('keeps a shown reply in the session when its raw append fails', async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'session-custom-character-raw-append-failure';
    const character = {id: 'nova', displayName: 'Nova'};
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: character.id,
    }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const underlying = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: character.id,
      boundCharacter: character,
    });
    const appendFailureMessage = 'visible reply raw append failed';
    const failingStore = createRawEventAppendFailingLogStore({
      logStore: underlying,
      matches: record =>
        record.kind === 'visible_message_committed' &&
        record.visibleMessage?.role === 'character',
      message: appendFailureMessage,
    });
    const failedSession = createConversationSession({
      id: sessionId,
      character,
    });

    await expect(
      runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent(
          'show me the stars',
          identity('evt_custom_character_raw_append_failure'),
        ),
        session: failedSession,
        logStore: failingStore,
        pluginHost: createDefaultProject02PluginHost({storeRoot, sessionId}),
        roleModelAdapter: createMultilineVisibleReplyAdapter(),
      }),
    ).rejects.toThrow(appendFailureMessage);

    // The reply reached the user before the append, so it stays said.
    expect(failedSession.visibleTranscript).toMatchObject([
      {role: 'user', text: 'show me the stars'},
      {role: 'character', speakerName: 'Nova'},
    ]);

    const reopened = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: character.id,
      boundCharacter: character,
    });
    expect(reopened.readSessionEvidence().conversationMessages).toEqual([
      expect.objectContaining({role: 'user', text: 'show me the stars'}),
    ]);

    await expect(
      runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent(
          'try again',
          identity('evt_custom_character_raw_retry'),
        ),
        session: createConversationSession({
          id: sessionId,
          character,
          visibleTranscript: reopened.conversationMessages(),
        }),
        logStore: reopened,
        pluginHost: createDefaultProject02PluginHost({storeRoot, sessionId}),
        roleModelAdapter: createMultilineVisibleReplyAdapter(),
      }),
    ).resolves.toMatchObject({status: 'completed'});

    expect(reopened.conversationMessages()).toEqual([
      expect.objectContaining({role: 'user', text: 'show me the stars'}),
      expect.objectContaining({role: 'user', text: 'try again'}),
      expect.objectContaining({
        role: 'character',
        speakerId: 'nova',
        speakerName: 'Nova',
      }),
    ]);
  });

  it('rejects a terminal event that omits one of its turn committed messages', async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'session-terminal-omits-message';
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const session = createConversationSession({
      character: testCharacterProfile,
      id: sessionId,
    });
    const result = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'hello',
        identity('evt_terminal_omits_message'),
      ),
      session,
      logStore,
      roleModelAdapter: createMultilineVisibleReplyAdapter(),
      pluginHost: createDefaultProject02PluginHost({storeRoot, sessionId}),
    });

    expect(result.status).toBe('completed');

    const paths = logStore.localRuntimeSessionPaths;

    if (paths === undefined) {
      throw new Error('Expected file runtime log store session paths.');
    }

    // Transcript reconstruction reads prior messages from terminal
    // references, so a dropped id desyncs a later turn's context.
    const rawLines = readFileSync(paths.rawEventsPath, 'utf8')
      .split('\n')
      .filter(line => line.length > 0);
    const trimmedLines = rawLines.map(line => {
      if (!line.includes('"runtime_turn_completed"')) {
        return line;
      }

      const record = JSON.parse(line) as {visibleMessageIds?: string[]};

      return JSON.stringify({
        ...record,
        visibleMessageIds: (record.visibleMessageIds ?? []).slice(0, 1),
      });
    });

    writeFileSync(paths.rawEventsPath, `${trimmedLines.join('\n')}\n`, 'utf8');

    expect(() =>
      createFileRuntimeLogStore({
        storeRoot,
        sessionId,
        characterId: testCharacterProfile.id,
        boundCharacter: testCharacterProfile,
      }).readSessionEvidence(),
    ).toThrow(
      'Terminal raw-event evidence must exactly match the visible conversation messages for that turn.',
    );
  });

  it('rejects a character row edited away from its accepted reply', async () => {
    const {paths, rawLines} = await committedTurnRawLines(
      'session-edited-character-text',
    );
    const index = rawLines.findIndex(
      line =>
        line.includes('"visible_message_committed"') &&
        line.includes('"role":"character"'),
    );
    const record = JSON.parse(rawLines[index] ?? '{}') as {
      visibleMessage?: Record<string, unknown>;
    };

    writeFileSync(
      paths.rawEventsPath,
      `${rawLines
        .map((line, at) =>
          at === index
            ? JSON.stringify({
                ...record,
                visibleMessage: {
                  ...record.visibleMessage,
                  text: 'edited by hand',
                },
              })
            : line,
        )
        .join('\n')}\n`,
      'utf8',
    );

    expect(() => reopenStore(paths).conversationMessages()).toThrow(
      /must match the accepted reply/iu,
    );
  });
  it('rejects replies committed out of their decision order', async () => {
    const {paths, rawLines} = await committedTurnRawLines(
      'session-reply-order',
      createSequencedVisibleReplyAdapter(['first thought', 'and a second']),
    );
    const commits = rawLines.filter(
      line =>
        line.includes('"visible_message_committed"') &&
        line.includes('"role":"character"'),
    );

    if (commits.length !== 2) {
      throw new Error(
        `Expected two character commit events, got ${String(commits.length)}.`,
      );
    }

    // Swap only the text, so IDs stay in sequence and each row still
    // matches an accepted reply — only the order between them is wrong.
    const records = commits.map(
      line => JSON.parse(line) as Record<string, unknown>,
    );
    const texts = records.map(
      record => (record['visibleMessage'] as {text: string}).text,
    );
    const swappedLines = new Map(
      commits.map((line, index) => [
        line,
        JSON.stringify({
          ...records[index],
          visibleMessage: {
            ...(records[index]?.['visibleMessage'] as object),
            text: texts[texts.length - 1 - index],
          },
          commitValidation: {
            ...(records[index]?.['commitValidation'] as object),
            result: {
              status: 'accepted',
              acceptedVisibleReplyText: texts[texts.length - 1 - index],
            },
          },
        }),
      ]),
    );

    writeFileSync(
      paths.rawEventsPath,
      `${rawLines.map(line => swappedLines.get(line) ?? line).join('\n')}\n`,
      'utf8',
    );

    expect(() => reopenStore(paths).conversationMessages()).toThrow(
      /must follow the order their decision asked for/iu,
    );
  });

  it('rejects replies reordered by stripping their decision rounds', async () => {
    const {paths, rawLines} = await committedTurnRawLines(
      'session-stripped-rounds',
      createSequencedVisibleReplyAdapter(['first thought', 'and a second']),
    );
    const commits = rawLines.filter(
      line =>
        line.includes('"visible_message_committed"') &&
        line.includes('"role":"character"'),
    );

    if (commits.length !== 2) {
      throw new Error(
        `Expected two character commit events, got ${String(commits.length)}.`,
      );
    }

    // The ordering check keys on the decision round, so a forger who
    // swaps texts and anchors while deleting the rounds must not slip
    // past it: a character commit without its round is not a shape the
    // writer produces.
    const records = commits.map(
      line => JSON.parse(line) as Record<string, unknown>,
    );
    const texts = records.map(
      record => (record['visibleMessage'] as {text: string}).text,
    );
    const strippedLines = new Map(
      commits.map((line, index) => {
        const swapped: Record<string, unknown> = {
          ...records[index],
          visibleMessage: {
            ...(records[index]?.['visibleMessage'] as object),
            text: texts[texts.length - 1 - index],
          },
          commitValidation: {
            ...(records[index]?.['commitValidation'] as object),
            result: {
              status: 'accepted',
              acceptedVisibleReplyText: texts[texts.length - 1 - index],
            },
          },
        };

        delete swapped['decisionRound'];
        return [line, JSON.stringify(swapped)];
      }),
    );

    writeFileSync(
      paths.rawEventsPath,
      `${rawLines.map(line => strippedLines.get(line) ?? line).join('\n')}\n`,
      'utf8',
    );

    expect(() => reopenStore(paths).conversationMessages()).toThrow(
      /must carry the accepted decision/iu,
    );
  });

  it('rejects replies swapped across rounds behind self-consistent forged rounds', async () => {
    const {paths, rawLines} = await committedTurnRawLines(
      'session-cross-round-swap',
      createRepeatedRoundAdapter(),
    );
    const commits = rawLines.filter(
      line =>
        line.includes('"visible_message_committed"') &&
        line.includes('"role":"character"'),
    );

    if (commits.length !== 3) {
      throw new Error(
        `Expected three character commit events, got ${String(commits.length)}.`,
      );
    }

    // Swap the round-2 and round-3 rows wholesale — text, anchors, and
    // round travel together, so every round group stays internally
    // consistent and only the order between rounds is wrong. IDs and
    // committedAt stay in place, so nothing else can object first.
    const records = commits.map(
      line => JSON.parse(line) as Record<string, unknown>,
    );
    const swapContent = (
      target: Record<string, unknown>,
      source: Record<string, unknown>,
    ) =>
      JSON.stringify({
        ...target,
        visibleMessage: {
          ...(target['visibleMessage'] as object),
          text: (source['visibleMessage'] as {text: string}).text,
        },
        commitValidation: source['commitValidation'],
        parsedRoleModelDecisionSnapshot:
          source['parsedRoleModelDecisionSnapshot'],
        roleModelIOSnapshot: source['roleModelIOSnapshot'],
        decisionRound: source['decisionRound'],
      });
    const secondCommit = commits[1];
    const thirdCommit = commits[2];
    const secondRecord = records[1];
    const thirdRecord = records[2];

    if (
      secondCommit === undefined ||
      thirdCommit === undefined ||
      secondRecord === undefined ||
      thirdRecord === undefined
    ) {
      throw new Error('Expected the round-2 and round-3 commit events.');
    }

    const swappedLines = new Map([
      [secondCommit, swapContent(secondRecord, thirdRecord)],
      [thirdCommit, swapContent(thirdRecord, secondRecord)],
    ]);

    writeFileSync(
      paths.rawEventsPath,
      `${rawLines.map(line => swappedLines.get(line) ?? line).join('\n')}\n`,
      'utf8',
    );

    expect(() => reopenStore(paths).conversationMessages()).toThrow(
      /follow the order their decision asked for/iu,
    );
  });

  it('rejects recorded model input that differs from the committed user row', async () => {
    const {paths, rawLines} = await committedTurnRawLines(
      'session-input-drift',
      createSequencedVisibleReplyAdapter(['a reply']),
    );

    // Evidence saying the model answered "hi" while the visible user row
    // says "hello" is a transcript the user never saw. The forged record
    // stays internally consistent — snapshot and summary agree — so only
    // the cross-record rule can catch it.
    const editedLines = rawLines.map(line => {
      if (
        !line.includes('"visible_message_committed"') ||
        !line.includes('"role":"character"')
      ) {
        return line;
      }

      const record = JSON.parse(line) as {
        payloadSummary?: Record<string, unknown>;
        roleModelIOSnapshot?: {
          inputEnvelope: {event: {payload: Record<string, unknown>}};
        };
      };

      if (record.roleModelIOSnapshot !== undefined) {
        record.roleModelIOSnapshot.inputEnvelope.event.payload[
          'currentUserMessage'
        ] = 'hi';
      }

      if (record.payloadSummary !== undefined) {
        record.payloadSummary['normalizedCurrentUserMessage'] = 'hi';
      }

      return JSON.stringify(record);
    });

    writeFileSync(paths.rawEventsPath, `${editedLines.join('\n')}\n`, 'utf8');

    expect(() => reopenStore(paths).conversationMessages()).toThrow(
      /one model input text/iu,
    );
  });

  it('refuses to persist a prepared record made stale by a later append', async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'session-stale-prepared';
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({sessionId, createdAt: '2026-06-15T00:00:00.000Z'});
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const writerLease = await acquireLocalRuntimeSessionWriterLease({
      storeRoot,
      sessionId,
      ownerToken: fileLogStoreWriterOwnerToken(logStore),
    });

    try {
      const turnIdentity = identity('evt_stale_prepared');

      logStore.appendRawEvent({
        ...turnIdentity,
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE',
      });

      // Valid when prepared: the turn has no messages, so a rejection
      // without visibleMessageIds matches the evidence of that moment.
      const staleTerminal = logStore.prepareRawEvent({
        ...turnIdentity,
        kind: 'runtime_turn_rejected',
        eventType: 'USER_MESSAGE',
        status: 'rejected',
        reason: 'prepared before the user message committed',
      });
      const messageId = `${sessionId}:message-1`;

      logStore.appendRawEvent({
        ...turnIdentity,
        kind: 'visible_message_committed',
        eventType: 'USER_MESSAGE',
        visibleMessageIds: [messageId],
        visibleMessage: {
          id: messageId,
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'now committed',
        },
        committedAt: turnIdentity.createdAt,
      });

      // The stale bytes must never land: a terminal that omits the
      // committed row is a session the next start refuses to read.
      expect(() => {
        logStore.persistPreparedRawEvent(staleTerminal);
      }).toThrow(/must exactly match the visible conversation messages/iu);
      expect(
        logStore
          .rawEvents()
          .filter(record => record.kind === 'runtime_turn_rejected'),
      ).toHaveLength(0);
    } finally {
      await writerLease.release();
    }

    const paths = logStore.localRuntimeSessionPaths;

    if (paths === undefined) {
      throw new Error('Expected file runtime log store session paths.');
    }

    // What remains is an open turn — the crash shape — which stays
    // readable.
    expect(reopenStore(paths).conversationMessages()).toHaveLength(1);
  });

  it('accepts repeated replies whose text needed normalizing', async () => {
    const {paths} = await committedTurnRawLines(
      'session-repeated-normalized-replies',
      createSequencedVisibleReplyAdapter(['  checking  ', 'checking\r\n']),
    );

    expect(
      reopenStore(paths)
        .conversationMessages()
        .filter(message => message.role === 'character')
        .map(message => message.text),
    ).toEqual(['checking', 'checking']);
  });

  it('keeps taking turns on the session whose reply the log never got', async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'session-lagging-log-retry';
    const character = {id: 'nova', displayName: 'Nova'};
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: character.id,
    }).createSession({sessionId, createdAt: '2026-06-15T00:00:00.000Z'});

    const underlying = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: character.id,
      boundCharacter: character,
    });
    const failingStore = createRawEventAppendFailingLogStore({
      logStore: underlying,
      matches: record =>
        record.kind === 'visible_message_committed' &&
        record.visibleMessage?.role === 'character',
      message: 'visible reply raw append failed',
    });
    // The one session this process keeps, the way the CLI holds it.
    const session = createConversationSession({id: sessionId, character});

    await expect(
      runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent('first', identity('evt_lag_1')),
        session,
        logStore: failingStore,
        pluginHost: createDefaultProject02PluginHost({storeRoot, sessionId}),
        roleModelAdapter: createMultilineVisibleReplyAdapter(),
      }),
    ).rejects.toThrow('visible reply raw append failed');

    // The reply was said, so the session holds it and the log is a row behind.
    expect(session.visibleTranscript).toHaveLength(2);
    expect(underlying.conversationMessages()).toHaveLength(1);

    await expect(
      runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent('second', identity('evt_lag_2')),
        session,
        logStore: underlying,
        pluginHost: createDefaultProject02PluginHost({storeRoot, sessionId}),
        roleModelAdapter: createMultilineVisibleReplyAdapter(),
      }),
    ).resolves.toMatchObject({status: 'completed'});

    // The log now skips the number the failed reply took, so a session
    // rebuilt from it holds fewer messages than the highest number used.
    expect(
      underlying.conversationMessages().map(message => message.id),
    ).toEqual([
      `${sessionId}:message-1`,
      `${sessionId}:message-3`,
      `${sessionId}:message-4`,
    ]);

    await expect(
      runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent(
          'after restart',
          identity('evt_lag_3'),
        ),
        session: createConversationSession({
          id: sessionId,
          character,
          visibleTranscript: underlying.conversationMessages(),
        }),
        logStore: underlying,
        pluginHost: createDefaultProject02PluginHost({storeRoot, sessionId}),
        roleModelAdapter: createMultilineVisibleReplyAdapter(),
      }),
    ).resolves.toMatchObject({status: 'completed'});

    expect(
      underlying.conversationMessages().map(message => message.text),
    ).toEqual([
      'first',
      'second',
      expect.stringContaining('I can use:'),
      'after restart',
      expect.stringContaining('I can use:'),
    ]);
  });

  it('reads back two rounds of one turn that said exactly the same thing', async () => {
    const {paths} = await committedTurnRawLines(
      'session-repeated-rounds',
      createRepeatedRoundAdapter(),
    );

    expect(
      reopenStore(paths)
        .conversationMessages()
        .filter(message => message.role === 'character')
        .map(message => message.text),
    ).toEqual(['checking', 'checking', 'done']);
  });

  it('rejects a duplicated visible_message_committed anchor for one message', async () => {
    const {paths, rawLines} = await committedTurnRawLines(
      'session-duplicate-commit-anchor',
    );
    const anchor = rawLines.find(line =>
      line.includes('"visible_message_committed"'),
    );

    if (anchor === undefined) {
      throw new Error('Expected a commit anchor line.');
    }

    // One message, one commit event: a duplicate must fail closed. It is
    // inserted before the terminal, so the turn-shape gate decides rather
    // than the records-after-terminal rule.
    const terminalIndex = rawLines.findIndex(line =>
      line.includes('"runtime_turn_completed"'),
    );

    writeFileSync(
      paths.rawEventsPath,
      `${[
        ...rawLines.slice(0, terminalIndex),
        anchor,
        ...rawLines.slice(terminalIndex),
      ].join('\n')}\n`,
      'utf8',
    );

    expect(() => reopenStore(paths).conversationMessages()).toThrow(
      LocalRuntimeStorageContractError,
    );
  });
  it('rejects a forged character row committed without its accepted decision', async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'session-forged-character-row';
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const session = createConversationSession({
      character: testCharacterProfile,
      id: sessionId,
    });
    const result = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'hello',
        identity('evt_forged_character_row'),
      ),
      session,
      logStore,
      roleModelAdapter: createMultilineVisibleReplyAdapter(),
      pluginHost: createDefaultProject02PluginHost({storeRoot, sessionId}),
    });

    expect(result.status).toBe('completed');

    const paths = logStore.localRuntimeSessionPaths;

    if (paths === undefined) {
      throw new Error('Expected file runtime log store session paths.');
    }

    // A forged reply can carry a bare commit event but not the accepted
    // decision that produced its text.
    const rawLines = readFileSync(paths.rawEventsPath, 'utf8')
      .split('\n')
      .filter(line => line.length > 0);
    const strippedLines = rawLines.map(line => {
      if (!line.includes('"visible_message_committed"')) {
        return line;
      }

      const record = JSON.parse(line) as Record<string, unknown>;

      if (record['commitValidation'] === undefined) {
        return line;
      }

      delete record['commitValidation'];
      delete record['parsedRoleModelDecisionSnapshot'];
      delete record['roleModelIOSnapshot'];
      return JSON.stringify(record);
    });

    writeFileSync(paths.rawEventsPath, `${strippedLines.join('\n')}\n`, 'utf8');

    expect(() =>
      createFileRuntimeLogStore({
        storeRoot,
        sessionId,
        characterId: testCharacterProfile.id,
        boundCharacter: testCharacterProfile,
      }).readSessionEvidence(),
    ).toThrow(
      'Character message commit must carry the accepted decision that produced its text',
    );
  });

  it('rejects a second user row appended into one turn', async () => {
    const {paths, rawLines} = await committedTurnRawLines(
      'session-second-user-row',
    );
    const index = rawLines.findIndex(
      line =>
        line.includes('"visible_message_committed"') &&
        line.includes('"role":"user"'),
    );
    const record = JSON.parse(rawLines[index] ?? '{}') as {
      visibleMessage?: Record<string, unknown>;
      visibleMessageIds?: string[];
    };
    const forgedId = `session-second-user-row:message-9`;

    // One runtime input, one user row — even with its own commit event.
    writeFileSync(
      paths.rawEventsPath,
      `${[
        ...rawLines,
        JSON.stringify({
          ...record,
          visibleMessageIds: [forgedId],
          visibleMessage: {...record.visibleMessage, id: forgedId},
        }),
      ].join('\n')}\n`,
      'utf8',
    );

    expect(() => reopenStore(paths).conversationMessages()).toThrow(
      LocalRuntimeStorageContractError,
    );
  });
  it('rejects conversation rows reordered out of their session sequence', async () => {
    const {paths, rawLines} = await committedTurnRawLines(
      'session-reordered-rows',
    );
    const commits = rawLines.filter(line =>
      line.includes('"visible_message_committed"'),
    );

    if (commits.length < 2) {
      throw new Error('Expected two commit events.');
    }

    // Message IDs are assigned per session and checked against position,
    // so swapping two commit events breaks the file-wide sequence.
    const [first, second] = commits;
    const swapped = rawLines.map(line =>
      line === first ? second : line === second ? first : line,
    );

    writeFileSync(paths.rawEventsPath, `${swapped.join('\n')}\n`, 'utf8');

    expect(() => reopenStore(paths).conversationMessages()).toThrow(
      LocalRuntimeStorageContractError,
    );
  });
  it('keeps a session readable when a crash left its last turn unfinished', async () => {
    // A killed process ends the log mid-turn: messages committed, no
    // terminal event. That is a state the reader surfaces — the shown
    // messages stay in the transcript — and the next writer's turn
    // implicitly closes it.
    const {paths} = await committedTurnRawLines(
      'session-crash-open-turn',
      createMultilineVisibleReplyAdapter(),
    );
    const survivingLines = readFileSync(paths.rawEventsPath, 'utf8')
      .split('\n')
      .filter(line => line.length > 0)
      .filter(line => {
        const record = JSON.parse(line) as {kind: string};

        return (
          record.kind !== 'runtime_turn_completed' &&
          record.kind !== 'after_turn_committed'
        );
      });

    writeFileSync(
      paths.rawEventsPath,
      `${survivingLines.join('\n')}\n`,
      'utf8',
    );

    const reopened = reopenStore(paths);

    expect(
      reopened.conversationMessages().map(message => message.role),
    ).toEqual(['user', 'character']);

    // The next writer rehydrates from the log, so the session resumes
    // from the messages the crashed turn already showed.
    const session = createConversationSession({
      id: paths.sessionId,
      character: testCharacterProfile,
      visibleTranscript: reopened.conversationMessages(),
    });

    await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'still there?',
        identity('evt_after_crash'),
      ),
      session,
      logStore: reopened,
      roleModelAdapter: createMultilineVisibleReplyAdapter(),
      pluginHost: createDefaultProject02PluginHost({
        storeRoot: paths.storeRoot,
        sessionId: paths.sessionId,
      }),
    });

    const finalEvents = reopenStore(paths).rawEvents();

    expect(
      finalEvents.filter(event => event.kind === 'runtime_turn_completed'),
    ).toHaveLength(1);
    expect(reopenStore(paths).conversationMessages()).toHaveLength(4);
  });

  it('keeps a session readable when a crash left its last record unfinished', async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'session-torn-final-record';
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });

    await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent('hello', identity('evt_torn_first')),
      session: createConversationSession({
        character: testCharacterProfile,
        id: sessionId,
      }),
      logStore,
      roleModelAdapter: createMultilineVisibleReplyAdapter(),
      pluginHost: createDefaultProject02PluginHost(),
    });

    const paths = logStore.localRuntimeSessionPaths;

    if (paths === undefined) {
      throw new Error('Expected local runtime session paths.');
    }

    // The writer died partway through its next raw event.
    const rawEvents = readFileSync(paths.rawEventsPath, 'utf8');

    writeFileSync(
      paths.rawEventsPath,
      `${rawEvents}{"eventId":"evt_torn_second","kind":"runtime_tu`,
      'utf8',
    );

    const reopened = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });

    // The unfinished write costs its own record, not the conversation.
    expect(reopened.conversationMessages()).toHaveLength(2);
    expect(
      reopened.rawEvents().some(record => record.eventId === 'evt_torn_second'),
    ).toBe(false);

    // The next turn appends cleanly rather than splicing onto it.
    const followupResult = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'still there?',
        identity('evt_after_torn'),
      ),
      session: createConversationSession({
        character: testCharacterProfile,
        id: sessionId,
        visibleTranscript: reopened.conversationMessages(),
      }),
      logStore: reopened,
      roleModelAdapter: createMultilineVisibleReplyAdapter(),
      pluginHost: createDefaultProject02PluginHost(),
    });

    expect(followupResult.status).toBe('completed');
    expect(
      createFileRuntimeLogStore({
        storeRoot,
        sessionId,
        characterId: testCharacterProfile.id,
        boundCharacter: testCharacterProfile,
      }).conversationMessages(),
    ).toHaveLength(4);
  });

  it('anchors the committed user message when beforeRoleModelCall rejects the turn', async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'session-before-call-rejected';
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const session = createConversationSession({
      character: testCharacterProfile,
      id: sessionId,
    });

    const rejectedResult = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'blocked question',
        identity('evt_before_call_rejected'),
      ),
      session,
      logStore,
      roleModelAdapter: createMultilineVisibleReplyAdapter(),
      pluginHost: createBeforeCallRejectingPluginHost(),
    });

    expect(rejectedResult.status).toBe('rejected');
    // The user message committed before the gate ran, so the terminal
    // rejection must reference it — otherwise later full-evidence reads
    // rebuild a prior conversation missing a durable message.
    expect(logStore.rawEvents().at(-1)).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected',
      visibleMessageIds: [`${sessionId}:message-1`],
    });

    const reopened = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const followupSession = createConversationSession({
      character: testCharacterProfile,
      id: sessionId,
      visibleTranscript: reopened.conversationMessages(),
    });
    const followupResult = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'try again',
        identity('evt_after_before_call_rejected'),
      ),
      session: followupSession,
      logStore: reopened,
      roleModelAdapter: createMultilineVisibleReplyAdapter(),
      pluginHost: createDefaultProject02PluginHost({storeRoot, sessionId}),
    });

    expect(followupResult.status).toBe('completed');
    // The completed turn's recent-context snapshot includes the kept user
    // message; a full validated reload must accept that agreement.
    expect(() =>
      createFileRuntimeLogStore({
        storeRoot,
        sessionId,
        characterId: testCharacterProfile.id,
        boundCharacter: testCharacterProfile,
      }).readSessionEvidence(),
    ).not.toThrow();
  });

  it('persists decodable commit validation for plugin health rejections', async () => {
    const storeRoot = createStoreRoot();
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      sessionId: 'session-health-rejected',
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'session-health-rejected',
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const session = createConversationSession({
      character: testCharacterProfile,
      id: 'session-health-rejected',
    });

    const result = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'health check',
        identity('evt_health_rejected'),
      ),
      session,
      logStore,
      roleModelAdapter: createMultilineVisibleReplyAdapter(),
      pluginHost: createHealthRejectingPluginHost(),
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'plugin_health_rejected',
      message: 'Plugin health unavailable: health fixture offline',
    });
    // Health gates run after delivery: they reject the turn and stop
    // future messages, but never un-say text the user already saw.
    expect(
      logStore.conversationMessages().map(message => message.role),
    ).toEqual(['user', 'character']);

    const rawEvents = logStore.rawEvents();
    const commitRejection = rawEvents.find(
      event => event.kind === 'commit_validation_rejected',
    );

    expect(commitRejection).toMatchObject({
      kind: 'commit_validation_rejected',
      status: 'rejected',
      reason: roleModelCommitValidationFailureRejectionReason,
      commitValidation: {
        result: {
          status: 'rejected',
          rejection: {
            reason: roleModelCommitValidationFailureRejectionReason,
            details: 'Plugin health unavailable: health fixture offline',
          },
        },
      },
      runtimePluginTurnEvidence: {
        health: [
          {
            pluginId: 'health.reject.fixture',
            status: 'unavailable',
            summary: 'health fixture offline',
          },
        ],
      },
    });
    expect(rawEvents.at(-1)).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected',
      reason: roleModelCommitValidationFailureRejectionReason,
      commitValidation: {
        result: {
          status: 'rejected',
          rejection: {
            reason: roleModelCommitValidationFailureRejectionReason,
            details: 'Plugin health unavailable: health fixture offline',
          },
        },
      },
    });
  });

  it('rejects degraded health snapshots when plugin health policy rejects turns', async () => {
    const storeRoot = createStoreRoot();
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      sessionId: 'session-health-degraded-rejected',
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'session-health-degraded-rejected',
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const session = createConversationSession({
      character: testCharacterProfile,
      id: 'session-health-degraded-rejected',
    });

    const result = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'health check',
        identity('evt_health_degraded_rejected'),
      ),
      session,
      logStore,
      roleModelAdapter: createMultilineVisibleReplyAdapter(),
      pluginHost: createHealthRejectingPluginHost({
        status: 'degraded',
        summary: 'health fixture backpressure',
      }),
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'plugin_health_rejected',
      message: 'Plugin health degraded: health fixture backpressure',
    });
    // Health gates run after delivery: they reject the turn and stop
    // future messages, but never un-say text the user already saw.
    expect(
      logStore.conversationMessages().map(message => message.role),
    ).toEqual(['user', 'character']);

    const rawEvents = logStore.rawEvents();
    const commitRejection = rawEvents.find(
      event => event.kind === 'commit_validation_rejected',
    );

    expect(commitRejection).toMatchObject({
      kind: 'commit_validation_rejected',
      status: 'rejected',
      reason: roleModelCommitValidationFailureRejectionReason,
      commitValidation: {
        result: {
          status: 'rejected',
          rejection: {
            reason: roleModelCommitValidationFailureRejectionReason,
            details: 'Plugin health degraded: health fixture backpressure',
          },
        },
      },
      runtimePluginEvidence: [
        {
          pluginId: 'health.reject.fixture',
          evidenceKind: 'health',
          status: 'degraded',
          summary: 'Plugin health degraded: health fixture backpressure',
          policyOutcome: 'health_degraded',
        },
      ],
      runtimePluginTurnEvidence: {
        health: [
          {
            pluginId: 'health.reject.fixture',
            status: 'degraded',
            summary: 'health fixture backpressure',
          },
        ],
      },
    });
    expect(rawEvents.at(-1)).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected',
      reason: roleModelCommitValidationFailureRejectionReason,
      commitValidation: {
        result: {
          status: 'rejected',
          rejection: {
            reason: roleModelCommitValidationFailureRejectionReason,
            details: 'Plugin health degraded: health fixture backpressure',
          },
        },
      },
    });
  });

  it('keeps an unfinished tool call readable and refuses to complete over it', async () => {
    const storeRoot = createStoreRoot();
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      sessionId: 'session-tools',
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'session-tools',
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const writerLease = await acquireLocalRuntimeSessionWriterLease({
      storeRoot,
      sessionId: 'session-tools',
      ownerToken: fileLogStoreWriterOwnerToken(logStore),
    });

    try {
      appendTurnPrefix(logStore);
      logStore.appendRawEvent({
        ...identity(),
        kind: 'tool_call_started',
        eventType: 'USER_MESSAGE',
        toolCallId: 'round-1.1.memory.search',
        toolRound: 1,
        toolName: 'memory.search',
        toolPluginId: 'memory.fixture',
        toolInput: {
          query: 'Mira',
        },
      });

      // A crash mid-call leaves exactly this log, so reads surface it.
      expect(logStore.rawEvents().at(-1)?.kind).toBe('tool_call_started');
      // Claiming completion over an unfinished call is a writer bug.
      expect(() =>
        logStore.appendRawEvent({
          ...identity(),
          kind: 'runtime_turn_completed',
          eventType: 'USER_MESSAGE',
          status: 'completed',
        }),
      ).toThrow(LocalRuntimeStorageContractError);
    } finally {
      await writerLease.release();
    }
  });

  it('allows a rejected terminal turn to close an unfinished tool call start', async () => {
    const storeRoot = createStoreRoot();
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      sessionId: 'session-tools-rejected',
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'session-tools-rejected',
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const eventId = 'evt_tool_finish_log_failed';
    const writerLease = await acquireLocalRuntimeSessionWriterLease({
      storeRoot,
      sessionId: 'session-tools-rejected',
      ownerToken: fileLogStoreWriterOwnerToken(logStore),
    });

    try {
      appendTurnPrefix(logStore, eventId);
      logStore.appendRawEvent({
        ...identity(eventId),
        kind: 'tool_call_started',
        eventType: 'USER_MESSAGE',
        toolCallId: 'round-1.1.memory.write',
        toolRound: 1,
        toolName: 'memory.write',
        toolPluginId: 'memory.fixture',
        toolInput: {
          value: 'planned',
        },
      });
      logStore.appendRawEvent({
        ...identity(eventId),
        kind: 'runtime_turn_rejected',
        eventType: 'USER_MESSAGE',
        status: 'rejected',
        reason: 'Runtime turn failed before producing a reply.',
      });
      expect(logStore.rawEvents().at(-1)).toMatchObject({
        kind: 'runtime_turn_rejected',
        status: 'rejected',
      });
    } finally {
      await writerLease.release();
    }
  });

  it('rejects terminal events that reference unfinished tool calls', async () => {
    const storeRoot = createStoreRoot();
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      sessionId: 'session-terminal-tools',
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'session-terminal-tools',
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const writerLease = await acquireLocalRuntimeSessionWriterLease({
      storeRoot,
      sessionId: 'session-terminal-tools',
      ownerToken: fileLogStoreWriterOwnerToken(logStore),
    });

    try {
      appendTurnPrefix(logStore, 'evt_terminal_tool_ref');
      expect(() =>
        logStore.appendRawEvent({
          ...identity('evt_terminal_tool_ref'),
          kind: 'runtime_turn_completed',
          eventType: 'USER_MESSAGE',
          status: 'completed',
          toolCallIds: ['round-1.1.memory.search'],
        }),
      ).toThrow(LocalRuntimeStorageContractError);
    } finally {
      await writerLease.release();
    }
  });
});

function createStoreRoot(): string {
  return createTestTempRoot('project02-log-store-');
}

function fileLogStoreWriterOwnerToken(
  logStore: ReturnType<typeof createFileRuntimeLogStore>,
) {
  const ownerToken = logStore.localRuntimeWriterLockOwnerToken;

  if (ownerToken === undefined) {
    throw new Error('Expected file runtime log store writer owner token.');
  }

  return ownerToken;
}

function identity(eventId = 'evt_tool_events') {
  return createRuntimeEventIdentity({
    eventId,
    traceId: `trace_${eventId}`,
    createdAt: '2026-06-15T00:00:00.000Z',
  });
}

function appendTurnPrefix(
  logStore: ReturnType<typeof createFileRuntimeLogStore>,
  eventId = 'evt_tool_events',
): void {
  logStore.appendRawEvent({
    ...identity(eventId),
    kind: 'runtime_event_received',
    eventType: 'USER_MESSAGE',
  });
  logStore.appendRawEvent({
    ...identity(eventId),
    kind: 'runtime_event_normalized',
    eventType: 'USER_MESSAGE',
  });
}

function writeJsonLines(filePath: string, records: readonly object[]): void {
  writeFileSync(
    filePath,
    records.map(record => `${JSON.stringify(record)}\n`).join(''),
    'utf8',
  );
}

function isTestRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function persistedDisallowedToolRejectionRecord(
  sessionId: string,
): Promise<Record<string, unknown>> {
  const storeRoot = createStoreRoot();
  await createLocalRuntimeSessionStore({
    storeRoot,
    characterId: 'mira',
  }).createSession({
    sessionId,
    createdAt: '2026-06-15T00:00:00.000Z',
  });
  const logStore = createFileRuntimeLogStore({
    storeRoot,
    sessionId,
    characterId: testCharacterProfile.id,
    boundCharacter: testCharacterProfile,
  });
  const result = await runLocalUserMessageEvent({
    event: createUserMessageRuntimeEvent(
      'try unknown',
      identity(`evt_${sessionId}`),
    ),
    session: createConversationSession({
      id: sessionId,
      character: testCharacterProfile,
    }),
    logStore,
    pluginHost: createDefaultProject02PluginHost({storeRoot, sessionId}),
    roleModelAdapter: Object.freeze({
      invoke() {
        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {
                name: 'memory.unknown',
                input: {
                  query: 'Mira',
                },
              },
            ],
          }),
        };
      },
    } satisfies RoleModelAdapter),
    maxToolRounds: 1,
  });
  const storedRecord: unknown = structuredClone(logStore.rawEvents().at(-1));

  expect(result).toMatchObject({
    status: 'rejected',
    reason: 'plugin_tool_rejected',
  });

  if (!isTestRecord(storedRecord)) {
    throw new Error('Expected persisted disallowed-tool rejection fixture.');
  }

  return storedRecord;
}

function rejectedDecisionResultRecord(
  storedRecord: Record<string, unknown>,
): Record<string, unknown> {
  const parsedSnapshot = storedRecord['parsedRoleModelDecisionSnapshot'];
  const result = isTestRecord(parsedSnapshot)
    ? parsedSnapshot['result']
    : undefined;

  if (!isTestRecord(result) || result['status'] !== 'rejected') {
    throw new Error('Expected persisted rejected decision result fixture.');
  }

  return result;
}

function supportedPersistedPluginToolJsonSchema() {
  return {
    type: 'object',
    description: 'Capture memory entries.',
    properties: {
      note: {
        type: ['string', 'null'],
        description: 'Optional note.',
        enum: ['remember', 'forget'],
      },
      entries: {
        type: ['array', 'null'],
        items: {
          type: ['object', 'null'],
          properties: {
            text: {
              type: 'string',
            },
          },
          required: ['text'],
          additionalProperties: false,
        },
      },
    },
    required: ['entries'],
    additionalProperties: false,
  };
}

function storedRecordWithPluginToolJsonSchema(
  jsonSchema: Readonly<Record<string, unknown>>,
): object {
  const storedRecord: unknown = structuredClone(
    decodeRawEventLogRecord(
      JSON.stringify(patchCompletedEvent('persisted-plugin-tool-schema')),
    ),
  );

  if (!isTestRecord(storedRecord)) {
    throw new Error('Expected persisted raw-event fixture.');
  }

  const roleModelIOSnapshot = storedRecord['roleModelIOSnapshot'];
  const inputEnvelope = isTestRecord(roleModelIOSnapshot)
    ? roleModelIOSnapshot['inputEnvelope']
    : undefined;
  const pluginToolDefinitions = isTestRecord(inputEnvelope)
    ? inputEnvelope['pluginToolDefinitions']
    : undefined;
  const allowedTools = isTestRecord(inputEnvelope)
    ? inputEnvelope['allowedTools']
    : undefined;

  if (!Array.isArray(pluginToolDefinitions) || !Array.isArray(allowedTools)) {
    throw new Error('Expected persisted role-model input envelope fixture.');
  }

  pluginToolDefinitions.push({
    pluginId: 'memory.fixture',
    name: 'memory.capture',
    description: 'Capture a memory.',
    inputContract: jsonSchema,
    validationOwner: 'plugin_host',
    requiresConfirmation: false,
  });
  allowedTools.push('memory.capture');

  return storedRecord;
}

function patchCompletedEvent(sessionId: string): object {
  const eventIdentity = identity('evt_patch_completed');
  const rawOutputText = JSON.stringify({
    toolCalls: [
      {
        name: characterStatePatchModelToolName,
        input: {
          mood: 'curious',
        },
      },
    ],
  });

  return {
    ...eventIdentity,
    kind: 'runtime_turn_completed',
    eventType: 'USER_MESSAGE',
    status: 'completed',
    roleModelIOSnapshot: {
      ...eventIdentity,
      kind: 'role_model_io_snapshot',
      sessionId,
      inputEnvelope: {
        event: {
          ...eventIdentity,
          type: 'USER_MESSAGE',
          payload: {
            currentUserMessage: 'remember the mood',
          },
        },
        decisionContext: {
          sessionId,
          characterSnapshot: testCharacterProfile,
          recentVisibleMessages: [],
          runtimeNotes: [],
        },
        allowedTools: [
          visibleReplyModelToolName,
          characterStatePatchModelToolName,
        ],
        pluginToolDefinitions: [
          {
            pluginId: firstPartyModelToolsPluginId,
            name: visibleReplyModelToolName,
            description: 'Say one message to the user.',
            inputContract: {
              type: 'object',
              properties: {
                text: {type: 'string', description: 'The message text.'},
              },
              required: ['text'],
              additionalProperties: false,
            },
            validationOwner: 'built_in_model_tools',
            annotations: {readOnlyHint: true},
            concurrency: 'shared',
            requiresConfirmation: false,
          },
          {
            pluginId: 'character-state',
            name: characterStatePatchModelToolName,
            description: "Patch the character's internal state.",
            inputContract: {
              type: 'object',
              properties: {},
              required: [],
              additionalProperties: true,
            },
            validationOwner: 'plugin_host',
            concurrency: 'exclusive',
            requiresConfirmation: false,
          },
        ],
        toolObservations: [],
        outputContract: {
          version: roleModelDecisionContractVersion,
          text: 'patch completed output contract text',
        },
      },
      rawOutputText,
    },
    parsedRoleModelDecisionSnapshot: {
      ...eventIdentity,
      kind: 'role_model_decision_snapshot',
      sessionId,
      result: {
        status: 'accepted',
        decision: {
          version: roleModelDecisionContractVersion,
          toolCalls: [
            {
              name: characterStatePatchModelToolName,
              input: {
                mood: 'curious',
              },
            },
          ],
        },
      },
    },
    commitValidation: {
      ...eventIdentity,
      kind: 'role_model_commit_validation_snapshot',
      sessionId,
      result: {
        status: 'accepted',
      },
    },
  };
}

function createMultilineVisibleReplyAdapter(): RoleModelAdapter {
  return {
    invoke() {
      return {
        rawOutputText: JSON.stringify({
          toolCalls: [
            {
              name: 'visible_reply',
              input: {
                text: 'I can use:\n- runtime.plugin.list\n- character_state.patch',
              },
            },
          ],
        }),
      };
    },
  };
}

function createMalformedProviderExchangeAdapter(): RoleModelAdapter {
  return {
    invoke(_inputEnvelope, invocation) {
      const providerExchange: RoleModelProviderExchangeSnapshot = {
        provider: {
          name: 'local',
        },
        capabilities: defaultRoleModelProviderCapabilities,
        reasoning: {
          mode: 'none',
          params: {},
        },
        renderedMessages: invocation.turnContext.messages,
        renderedTools: invocation.turnContext.tools,
        toolNameMappings: [],
        requestBody: {},
        nativeToolResultMessages: [],
      };
      Reflect.deleteProperty(providerExchange, 'reasoning');

      return {
        rawOutputText: JSON.stringify({
          toolCalls: [
            {
              name: visibleReplyModelToolName,
              input: {
                text: 'hello',
              },
            },
          ],
        }),
        providerExchange,
      };
    },
  };
}

function createBeforeCallRejectingPluginHost() {
  return createRuntimePluginHost({
    plugins: [
      createRuntimePlugin({
        manifest: {
          id: 'before-call.reject.fixture',
          displayName: 'Before Call Reject Fixture',
          version: '1.0.0',
          kind: 'first_party',
          description: 'Test plugin that rejects turns before the model call.',
          contractVersion: runtimePluginContractVersion,
          compatibility: {
            hostContractVersions: [runtimePluginContractVersion],
            sourceSystem: 'test',
          },
          declaredPlugins: ['before_role_model_call'],
          config: {
            scope: 'global_with_character_overrides',
            fields: [],
          },
          firstParty: false,
          runtimePolicy: {
            timeoutMs: 1000,
            redactionLabels: [],
            failureBehavior: {
              beforeRoleModelCall: 'reject_turn',
              handleToolCall: 'reject_tool_call',
              health: 'degrade',
            },
          },
          activation: {
            defaultEnabled: true,
            reasons: ['test'],
          },
          requestedAccess: {},
        },
        providedTools: [],
        lifecycleHooks: {
          beforeRoleModelCall() {
            throw new Error('before-call fixture rejects the turn');
          },
        },
      }),
    ],
    enabledPluginIds: [
      firstPartyModelToolsPluginId,
      'before-call.reject.fixture',
    ],
  });
}

function createHealthRejectingPluginHost(options?: {
  readonly status?: RuntimePluginHealthStatus;
  readonly summary?: string;
}) {
  const status = options?.status ?? 'unavailable';
  const summary = options?.summary ?? 'health fixture offline';

  return createRuntimePluginHost({
    plugins: [
      createRuntimePlugin({
        manifest: {
          id: 'health.reject.fixture',
          displayName: 'Health Reject Fixture',
          version: '1.0.0',
          kind: 'first_party',
          description: 'Test plugin that rejects turns during health checks.',
          contractVersion: runtimePluginContractVersion,
          compatibility: {
            hostContractVersions: [runtimePluginContractVersion],
            sourceSystem: 'test',
          },
          declaredPlugins: ['health'],
          config: {
            scope: 'global_with_character_overrides',
            fields: [],
          },
          firstParty: false,
          runtimePolicy: {
            timeoutMs: 1000,
            redactionLabels: [],
            failureBehavior: {
              beforeRoleModelCall: 'degrade',
              handleToolCall: 'reject_tool_call',
              health: 'reject_turn',
            },
          },
          activation: {
            defaultEnabled: true,
            reasons: ['test'],
          },
          requestedAccess: {},
        },
        providedTools: [],
        lifecycleHooks: {
          health(context) {
            return createRuntimePluginHealthSnapshot({
              pluginId: 'health.reject.fixture',
              status,
              checkedAt: context.timestamp,
              summary,
              redactionLabels: [],
            });
          },
        },
      }),
    ],
    enabledPluginIds: [firstPartyModelToolsPluginId, 'health.reject.fixture'],
  });
}

async function committedTurnRawLines(
  sessionId: string,
  adapter: RoleModelAdapter = createMultilineVisibleReplyAdapter(),
): Promise<{
  readonly paths: NonNullable<RuntimeLogStore['localRuntimeSessionPaths']>;
  readonly rawLines: readonly string[];
}> {
  const storeRoot = createStoreRoot();
  await createLocalRuntimeSessionStore({
    storeRoot,
    characterId: 'mira',
  }).createSession({sessionId, createdAt: '2026-06-15T00:00:00.000Z'});

  const logStore = createFileRuntimeLogStore({
    storeRoot,
    sessionId,
    characterId: testCharacterProfile.id,
    boundCharacter: testCharacterProfile,
  });

  await runLocalUserMessageEvent({
    event: createUserMessageRuntimeEvent('hello', identity(`evt_${sessionId}`)),
    session: createConversationSession({
      character: testCharacterProfile,
      id: sessionId,
    }),
    logStore,
    roleModelAdapter: adapter,
    pluginHost: createDefaultProject02PluginHost({storeRoot, sessionId}),
  });

  const paths = logStore.localRuntimeSessionPaths;

  if (paths === undefined) {
    throw new Error('Expected file runtime log store session paths.');
  }

  return {
    paths,
    rawLines: readFileSync(paths.rawEventsPath, 'utf8')
      .split('\n')
      .filter(line => line.length > 0),
  };
}

function reopenStore(
  paths: NonNullable<RuntimeLogStore['localRuntimeSessionPaths']>,
): RuntimeLogStore {
  return createFileRuntimeLogStore({
    storeRoot: paths.storeRoot,
    sessionId: paths.sessionId,
    characterId: testCharacterProfile.id,
    boundCharacter: testCharacterProfile,
  });
}

/**
 * A model that repeats itself: two rounds whose raw output is the same
 * bytes, then a terminal one. The repeated rounds are distinguishable only
 * by which round they were, never by what they said.
 */
function createRepeatedRoundAdapter(): RoleModelAdapter {
  const repeatedRound = JSON.stringify({
    toolCalls: [
      {name: 'visible_reply', input: {text: 'checking'}},
      {name: characterStatePatchModelToolName, input: {mood: 'curious'}},
    ],
  });
  let round = 0;

  return {
    invoke() {
      round += 1;

      return {
        rawOutputText:
          round <= 2
            ? repeatedRound
            : JSON.stringify({
                toolCalls: [{name: 'visible_reply', input: {text: 'done'}}],
              }),
      };
    },
  };
}

function createSequencedVisibleReplyAdapter(
  texts: readonly string[],
): RoleModelAdapter {
  return {
    invoke() {
      return {
        rawOutputText: JSON.stringify({
          toolCalls: texts.map(text => ({
            name: 'visible_reply',
            input: {text},
          })),
        }),
      };
    },
  };
}
