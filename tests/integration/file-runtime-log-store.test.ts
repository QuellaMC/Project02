import {testCharacterProfile} from '../support/character-fixtures.ts';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {createTestTempRoot} from '../support/temp-root.ts';

import {
  createFileRuntimeLogStore,
  durableRuntimeSessionCharacterProfile,
  findValidatedTerminalRawEventForSession,
} from '../../src/runtime/storage/file-runtime-log-store.ts';
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
import type {RuntimeLogStore} from '../../src/runtime/evidence/records.ts';
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

    writeFileSync(paths.tracePath, '', 'utf8');
    writeFileSync(paths.rawEventsPath, '', 'utf8');
    writeFileSync(paths.conversationPath, '', 'utf8');

    const writerLease = await acquireLocalRuntimeSessionWriterLease({
      storeRoot,
      sessionId,
      ownerToken: fileLogStoreWriterOwnerToken(logStore),
    });

    try {
      expect(() =>
        logStore.appendTrace({
          ...identity('evt_foreign_character_marker'),
          step: 'runtime_event_received',
        }),
      ).toThrow(
        expect.objectContaining({
          code: 'character_identity_mismatch',
        }),
      );
      expect(evidenceReads).toEqual([]);
      expect(readFileSync(paths.tracePath, 'utf8')).toBe('');
      expect(readFileSync(paths.rawEventsPath, 'utf8')).toBe('');
      expect(readFileSync(paths.conversationPath, 'utf8')).toBe('');
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
        storeB.appendTrace({
          ...identity('evt_owner_token_append'),
          step: 'runtime_event_received',
        }),
      ).toThrow(expect.objectContaining({code: 'session_busy'}));
      expect(storeA.traceEntries()).toEqual([]);
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

    const abandonedTemporaryPath = `${paths.sessionRoot}/.trace.jsonl.2147483647.00000000-0000-4000-8000-000000000000.tmp`;
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
      logStore.appendTrace({
        ...identity('evt_low_level_writer'),
        step: 'runtime_event_received',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'session_busy',
      }),
    );
    expect(logStore.readSessionEvidence().stored.traceEntries).toEqual([]);
  });

  it('rejects canonical timestamps that disagree across evidence streams', async () => {
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

    writeJsonLines(paths.tracePath, [
      {...eventIdentity, step: 'runtime_event_received'},
    ]);
    writeJsonLines(paths.rawEventsPath, [
      {
        ...eventIdentity,
        createdAt: '2026-06-15T00:00:01.000Z',
        kind: 'runtime_event_received',
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

    writeJsonLines(paths.tracePath, [
      {
        ...eventIdentity,
        createdAt: '2026-06-15T00:00:00Z',
        step: 'runtime_event_received',
      },
    ]);

    expect(() => logStore.readSessionEvidence()).toThrow(
      'Stored local runtime field "createdAt" must be a canonical UTC ISO timestamp.',
    );
  });

  it('reports a missing terminal trace as anchored derived evidence without changing stored reads', async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'session-read-only-terminal-trace-reconciliation';
    const eventIdentity = identity('evt_legacy_schema1_patch');
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

    writeJsonLines(paths.tracePath, [
      {
        ...eventIdentity,
        step: 'runtime_event_received',
      },
    ]);
    writeJsonLines(paths.rawEventsPath, [
      {
        ...eventIdentity,
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE',
      },
      {
        ...eventIdentity,
        kind: 'runtime_event_normalized',
        eventType: 'USER_MESSAGE',
        payloadSummary: {
          rawInput: 'remember the mood',
          normalizedCurrentUserMessage: 'remember the mood',
        },
      },
      legacySchema1PatchCompletedEvent(sessionId),
    ]);
    const traceBeforePublicReads = readFileSync(paths.tracePath, 'utf8');
    const rawEventsBeforePublicReads = readFileSync(
      paths.rawEventsPath,
      'utf8',
    );

    const evidence = logStore.readSessionEvidence();

    expect(evidence.stored.traceEntries.map(entry => entry.step)).toEqual([
      'runtime_event_received',
    ]);
    expect(evidence.derived.traceEntries).toEqual([
      {
        ...eventIdentity,
        step: 'raw_event_log_appended',
        provenance: {
          source: 'terminal_raw_event',
          reason: 'missing_persisted_trace_entry',
          rawEventAnchor: {
            ...eventIdentity,
            kind: 'runtime_turn_completed',
          },
        },
      },
      {
        ...eventIdentity,
        step: 'runtime_turn_completed',
        provenance: {
          source: 'terminal_raw_event',
          reason: 'missing_persisted_trace_entry',
          rawEventAnchor: {
            ...eventIdentity,
            kind: 'runtime_turn_completed',
          },
        },
      },
    ]);
    expect(logStore.traceEntries().map(entry => entry.step)).toEqual([
      'runtime_event_received',
    ]);
    expect(logStore.rawEvents().at(-1)?.kind).toBe('runtime_turn_completed');
    expect(logStore.conversationMessages()).toEqual([]);
    expect(readFileSync(paths.tracePath, 'utf8')).toBe(traceBeforePublicReads);
    expect(readFileSync(paths.rawEventsPath, 'utf8')).toBe(
      rawEventsBeforePublicReads,
    );
  });

  it('keeps rejected terminal trace compatibility evidence separate from stored trace', async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'session-read-only-rejected-trace-reconciliation';
    const eventIdentity = identity(
      'evt_read_only_rejected_trace_reconciliation',
    );
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

    writeJsonLines(paths.tracePath, [
      {
        ...eventIdentity,
        step: 'runtime_event_received',
      },
    ]);
    writeJsonLines(paths.rawEventsPath, [
      {
        ...eventIdentity,
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE',
      },
      {
        ...eventIdentity,
        kind: 'runtime_turn_rejected',
        eventType: 'USER_MESSAGE',
        status: 'rejected',
        reason: 'fixture rejection',
      },
    ]);
    const traceBeforePublicRead = readFileSync(paths.tracePath, 'utf8');

    const evidence = logStore.readSessionEvidence();

    expect(logStore.traceEntries().map(entry => entry.step)).toEqual([
      'runtime_event_received',
    ]);
    expect(evidence.derived.traceEntries.map(entry => entry.step)).toEqual([
      'raw_event_log_appended',
      'runtime_turn_rejected',
    ]);
    expect(
      evidence.derived.traceEntries.map(
        entry => entry.provenance.rawEventAnchor.kind,
      ),
    ).toEqual(['runtime_turn_rejected', 'runtime_turn_rejected']);
    expect(readFileSync(paths.tracePath, 'utf8')).toBe(traceBeforePublicRead);
  });

  it('validates full session evidence before returning an exact terminal identity', async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'session-validated-terminal-lookup';
    const eventIdentity = identity('evt_legacy_schema1_patch');
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
      legacySchema1PatchCompletedEvent(sessionId),
    ]);

    expect(() =>
      findValidatedTerminalRawEventForSession(paths, eventIdentity),
    ).toThrow(LocalRuntimeStorageContractError);

    writeJsonLines(paths.tracePath, [
      {
        ...eventIdentity,
        step: 'runtime_event_received',
      },
    ]);
    writeJsonLines(paths.rawEventsPath, [
      {
        ...eventIdentity,
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE',
      },
    ]);

    expect(
      findValidatedTerminalRawEventForSession(paths, eventIdentity),
    ).toBeUndefined();

    writeJsonLines(paths.rawEventsPath, [
      {
        ...eventIdentity,
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE',
      },
      legacySchema1PatchCompletedEvent(sessionId),
    ]);

    expect(
      findValidatedTerminalRawEventForSession(paths, eventIdentity)?.kind,
    ).toBe('runtime_turn_completed');
    expect(
      findValidatedTerminalRawEventForSession(paths, {
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
    writeJsonLines(paths.tracePath, [
      {
        ...eventIdentity,
        step: 'runtime_event_received',
      },
    ]);
    writeJsonLines(paths.rawEventsPath, [
      {
        ...eventIdentity,
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE',
      },
    ]);

    expect(() =>
      findValidatedTerminalRawEventForSession(paths, eventIdentity),
    ).toThrow(LocalRuntimeStorageContractError);
  });

  it('rejects malformed persisted provider exchange evidence with the storage contract error', () => {
    const malformedRecord: unknown = structuredClone(
      legacySchema1PatchCompletedEvent('malformed-provider-exchange'),
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
      legacySchema1PatchCompletedEvent('tampered-character-ref'),
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

  it('normalizes missing legacy requested tool names from replayable raw evidence', async () => {
    const storedRecord = await persistedDisallowedToolRejectionRecord(
      'legacy-missing-requested-tool-names',
    );
    const storedDecisionResult = rejectedDecisionResultRecord(storedRecord);

    Reflect.deleteProperty(storedDecisionResult, 'requestedToolNames');

    const decodedRecord = decodeRawEventLogRecord(JSON.stringify(storedRecord));

    expect(decodedRecord.parsedRoleModelDecisionSnapshot?.result).toMatchObject(
      {
        status: 'rejected',
        requestedToolNames: ['memory.unknown'],
      },
    );
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
      )?.inputContract.jsonSchema,
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
    expect(
      reloadedTerminalEvent?.roleModelIOSnapshot?.inputEnvelope.pluginToolDefinitions.find(
        definition => definition.name === visibleReplyModelToolName,
      )?.callLimit,
    ).toEqual({
      scope: 'model_response',
      maxCalls: 1,
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
      legacySchema1PatchCompletedEvent('duplicate-persisted-allowed-tools'),
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

  it('decodes legacy schema 1 role-model snapshots with character_state.patch as a former built-in allowed tool', async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'legacy-schema-1-role-model';
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    writeFileSync(
      createLocalRuntimeStorageLayout({storeRoot}).schemaPath,
      `${JSON.stringify({
        schemaVersion: 5,
        scope: 'character-data',
        characterId: 'mira',
        createdAt: '2026-06-15T00:00:00.000Z',
      })}\n`,
      'utf8',
    );

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

    mkdirSync(paths.sessionRoot, {recursive: true});
    writeJsonLines(paths.tracePath, [
      {
        ...identity('evt_legacy_schema1_patch'),
        step: 'runtime_event_received',
      },
      {
        ...identity('evt_legacy_schema1_patch'),
        step: 'runtime_turn_completed',
      },
    ]);
    writeJsonLines(paths.rawEventsPath, [
      {
        ...identity('evt_legacy_schema1_patch'),
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE',
      },
      {
        ...identity('evt_legacy_schema1_patch'),
        kind: 'runtime_event_normalized',
        eventType: 'USER_MESSAGE',
        payloadSummary: {
          rawInput: 'remember the mood',
          normalizedCurrentUserMessage: 'remember the mood',
        },
      },
      legacySchema1PatchCompletedEvent(sessionId),
    ]);

    const completed = logStore
      .rawEvents()
      .find(event => event.kind === 'runtime_turn_completed');

    expect(completed?.roleModelIOSnapshot?.inputEnvelope.allowedTools).toEqual([
      visibleReplyModelToolName,
      characterStatePatchModelToolName,
    ]);
    expect(
      completed?.roleModelIOSnapshot?.inputEnvelope.pluginToolDefinitions,
    ).toMatchObject([
      {
        pluginId: firstPartyModelToolsPluginId,
        name: visibleReplyModelToolName,
      },
      {
        pluginId: 'character-state',
        name: characterStatePatchModelToolName,
      },
    ]);
    expect(completed?.parsedRoleModelDecisionSnapshot?.result).toMatchObject({
      status: 'accepted',
      decision: {
        toolCalls: [
          {
            name: characterStatePatchModelToolName,
            input: {
              mood: 'curious',
            },
          },
        ],
      },
    });
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
          return durableStore.readSessionEvidence().stored.conversationMessages;
        },
        readConversationEvidence() {
          const evidence = durableStore.readSessionEvidence().stored;

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

    const conversationRecords = readFileSync(paths.conversationPath, 'utf8')
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    for (const conversationRecord of conversationRecords) {
      if (conversationRecord['role'] === 'character') {
        conversationRecord['speakerName'] = 'Not Nova';
      }
    }
    writeJsonLines(paths.conversationPath, conversationRecords);

    expect(() =>
      createFileRuntimeLogStore({
        storeRoot,
        sessionId,
        characterId: character.id,
        boundCharacter: character,
      }).conversationMessages(),
    ).toThrow(
      'Durable character speaker metadata must match recorded role-model character evidence.',
    );

    for (const conversationRecord of conversationRecords) {
      if (conversationRecord['role'] === 'character') {
        conversationRecord['speakerName'] = 'Nova';
      }
    }
    writeJsonLines(paths.conversationPath, conversationRecords);

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

  it('rolls back a custom first turn when visible-reply raw evidence fails before append', async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'session-custom-character-raw-rollback';
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
    const appendFailure = new Error('visible reply raw append failed');
    let failedVisibleReplyAppend = false;
    const failingStore = Object.freeze({
      ...(underlying.localRuntimeSessionPaths === undefined
        ? {}
        : {localRuntimeSessionPaths: underlying.localRuntimeSessionPaths}),
      ...(underlying.localRuntimeWriterLockOwnerToken === undefined
        ? {}
        : {
            localRuntimeWriterLockOwnerToken:
              underlying.localRuntimeWriterLockOwnerToken,
          }),
      appendTrace: entry => underlying.appendTrace(entry),
      appendRawEvent(record) {
        if (
          !failedVisibleReplyAppend &&
          record.kind === 'visible_message_committed'
        ) {
          failedVisibleReplyAppend = true;
          throw appendFailure;
        }

        return underlying.appendRawEvent(record);
      },
      appendConversationMessage: (record, expectedCharacter) =>
        underlying.appendConversationMessage(record, expectedCharacter),
      removeConversationMessages: messageIds => {
        underlying.removeConversationMessages(messageIds);
      },
      checkpointWriterEvidence: () => underlying.checkpointWriterEvidence?.(),
      recoverAbandonedWriterEvidence: () =>
        underlying.recoverAbandonedWriterEvidence?.() ?? false,
      readSessionEvidence: () => underlying.readSessionEvidence(),
      traceEntries: () => underlying.traceEntries(),
      rawEvents: () => underlying.rawEvents(),
      conversationMessages: () => underlying.conversationMessages(),
    } satisfies RuntimeLogStore);
    const failedSession = createConversationSession({
      id: sessionId,
      character,
    });

    await expect(
      runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent(
          'show me the stars',
          identity('evt_custom_character_raw_rollback'),
        ),
        session: failedSession,
        logStore: failingStore,
        pluginHost: createDefaultProject02PluginHost({storeRoot, sessionId}),
        roleModelAdapter: createMultilineVisibleReplyAdapter(),
      }),
    ).rejects.toBe(appendFailure);

    expect(failedSession.visibleTranscript).toEqual([]);
    const reopened = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: character.id,
      boundCharacter: character,
    });
    expect(reopened.readSessionEvidence().stored.conversationMessages).toEqual(
      [],
    );
    expect(reopened.rawEvents().at(-1)).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected',
    });

    await expect(
      runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent(
          'try again',
          identity('evt_custom_character_raw_retry'),
        ),
        session: createConversationSession({
          id: sessionId,
          character,
        }),
        logStore: reopened,
        pluginHost: createDefaultProject02PluginHost({storeRoot, sessionId}),
        roleModelAdapter: createMultilineVisibleReplyAdapter(),
      }),
    ).resolves.toMatchObject({status: 'completed'});

    expect(reopened.conversationMessages()).toEqual([
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
    // references, so a terminal that drops one of its turn's committed
    // ids would desync a later turn's model context.
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
    const storeRoot = createStoreRoot();
    const sessionId = 'session-character-text-drift';
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
        identity('evt_character_text_drift'),
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

    // Evidence keeps the redacted projection of the reply, so the rows
    // compare through that projection: editing the character text to
    // unrelated content is rejected rather than silently trusted.
    const conversationLines = readFileSync(paths.conversationPath, 'utf8')
      .split('\n')
      .filter(line => line.length > 0);
    const editedLines = conversationLines.map(line => {
      if (!line.includes('"role":"character"')) {
        return line;
      }

      const record = JSON.parse(line) as Record<string, unknown>;

      record['text'] = 'text the model never produced';
      return JSON.stringify(record);
    });

    writeFileSync(
      paths.conversationPath,
      `${editedLines.join('\n')}\n`,
      'utf8',
    );

    expect(() =>
      createFileRuntimeLogStore({
        storeRoot,
        sessionId,
        characterId: testCharacterProfile.id,
        boundCharacter: testCharacterProfile,
      }).readSessionEvidence(),
    ).toThrow('must match the accepted reply its commit anchored');
  });

  it('rejects a duplicated visible_message_committed anchor for one message', async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'session-duplicate-commit-anchor';
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
        identity('evt_duplicate_commit_anchor'),
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

    // Simulate duplicate processing by a direct writer: re-append the
    // reply's commit event verbatim. One message, one commit event — the
    // duplicated anchor must fail closed instead of reading publicly.
    const rawLines = readFileSync(paths.rawEventsPath, 'utf8')
      .split('\n')
      .filter(line => line.length > 0);
    const commitIndex = rawLines.findIndex(line =>
      line.includes('"visible_message_committed"'),
    );

    if (commitIndex === -1) {
      throw new Error('Expected a visible_message_committed raw event line.');
    }

    const duplicatedLines = [
      ...rawLines.slice(0, commitIndex + 1),
      rawLines[commitIndex],
      ...rawLines.slice(commitIndex + 1),
    ];

    writeFileSync(
      paths.rawEventsPath,
      `${duplicatedLines.join('\n')}\n`,
      'utf8',
    );

    expect(() =>
      createFileRuntimeLogStore({
        storeRoot,
        sessionId,
        characterId: testCharacterProfile.id,
        boundCharacter: testCharacterProfile,
      }).readSessionEvidence(),
    ).toThrow('more than one visible_message_committed raw event');
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

    // A direct writer forging a character reply can anchor it with a bare
    // commit event, but not with the accepted decision that produced the
    // text — the turn-shape gate rejects the evidence-free character row.
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

  it('rejects a user row whose text disagrees with the recorded model input', async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'session-user-text-drift';
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
        identity('evt_user_text_drift'),
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

    // The turn's user row is resolved by event identity, not by which
    // events reference it: editing the durable user text away from the
    // recorded model input fails even though the character commit events
    // never name the user row.
    const conversationLines = readFileSync(paths.conversationPath, 'utf8')
      .split('\n')
      .filter(line => line.length > 0);
    const editedLines = conversationLines.map(line => {
      if (!line.includes('"role":"user"')) {
        return line;
      }

      const record = JSON.parse(line) as Record<string, unknown>;

      record['text'] = 'edited after the fact';
      return JSON.stringify(record);
    });

    writeFileSync(
      paths.conversationPath,
      `${editedLines.join('\n')}\n`,
      'utf8',
    );

    expect(() =>
      createFileRuntimeLogStore({
        storeRoot,
        sessionId,
        characterId: testCharacterProfile.id,
        boundCharacter: testCharacterProfile,
      }).readSessionEvidence(),
    ).toThrow(
      'Role-model input text must match the committed user visible message for the turn.',
    );
  });

  it('rejects a second user row appended into one turn', async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'session-second-user-row';
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
        identity('evt_second_user_row'),
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

    // One runtime input, one user row: a direct writer duplicating the
    // user utterance under the same turn identity is rejected even with
    // its own commit anchor, so one input cannot appear as two
    // utterances in future model context.
    const conversationLines = readFileSync(paths.conversationPath, 'utf8')
      .split('\n')
      .filter(line => line.length > 0);
    const userLine = conversationLines.find(line =>
      line.includes('"role":"user"'),
    );

    if (userLine === undefined) {
      throw new Error('Expected a user conversation line.');
    }

    const userRecord = JSON.parse(userLine) as Record<string, unknown>;
    const forgedUserRecord = {
      ...userRecord,
      id: `${sessionId}:message-${String(conversationLines.length + 1)}`,
    };

    writeFileSync(
      paths.conversationPath,
      `${[...conversationLines, JSON.stringify(forgedUserRecord)].join('\n')}\n`,
      'utf8',
    );

    expect(() =>
      createFileRuntimeLogStore({
        storeRoot,
        sessionId,
        characterId: testCharacterProfile.id,
        boundCharacter: testCharacterProfile,
      }).readSessionEvidence(),
    ).toThrow();
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

  it('rejects started tool calls without matching finished records', async () => {
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

      expect(() => logStore.rawEvents()).toThrow(
        LocalRuntimeStorageContractError,
      );
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
      logStore.appendTrace({
        ...identity(eventId),
        step: 'runtime_turn_rejected',
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
  logStore.appendTrace({
    ...identity(eventId),
    step: 'runtime_event_received',
  });
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
      JSON.stringify(
        legacySchema1PatchCompletedEvent('persisted-plugin-tool-schema'),
      ),
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
    requiredForUserTurn: false,
    callLimit: {
      scope: 'user_turn',
      maxCalls: 1,
    },
    inputContract: {
      type: 'object',
      fields: [],
      additionalFields: false,
      jsonSchema,
    },
    validationOwner: 'plugin_host',
    sideEffectLevel: 'local_memory_write',
    requiresConfirmation: false,
    sourceReferencesRequired: false,
  });
  allowedTools.push('memory.capture');

  return storedRecord;
}

function legacySchema1PatchCompletedEvent(sessionId: string): object {
  const eventIdentity = identity('evt_legacy_schema1_patch');
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
        toolObservations: [],
        outputContract: {
          version: roleModelDecisionContractVersion,
          text: 'legacy schema 1 output contract text',
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
          localTrustLevel: 'test_fixture',
          runtimePolicy: {
            requiredForTurn: true,
            sideEffectLevel: 'runtime_read',
            confirmation: 'not_required',
            timeoutMs: 1000,
            sourceReferencesRequired: false,
            redactionLabels: [],
            failureBehavior: {
              beforeRoleModelCall: 'reject_turn',
              handleToolCall: 'reject_tool_call',
              afterTurnCommitted: 'log_failure',
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
          localTrustLevel: 'test_fixture',
          runtimePolicy: {
            requiredForTurn: true,
            sideEffectLevel: 'runtime_read',
            confirmation: 'not_required',
            timeoutMs: 1000,
            sourceReferencesRequired: false,
            redactionLabels: [],
            failureBehavior: {
              beforeRoleModelCall: 'degrade',
              handleToolCall: 'reject_tool_call',
              afterTurnCommitted: 'log_failure',
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
