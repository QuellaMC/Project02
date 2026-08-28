import {testCharacterProfile} from '../support/character-fixtures.ts';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {createTestTempRoot} from '../support/temp-root.ts';

import {createFileRuntimeLogStore} from '../../src/runtime/storage/file-runtime-log-store.ts';
import {
  durableRuntimeSessionCharacterProfile,
  findRuntimeTurnTerminalRawEvent,
} from '../../src/runtime/evidence/validation.ts';
import {
  acquireLocalRuntimeSessionWriterLease,
  createLocalRuntimeSessionStore,
} from '../../src/runtime/storage/session-store.ts';
import {createLocalRuntimeMutationLockOwnerToken} from '../../src/runtime/storage/mutation-lock.ts';
import {
  createSession,
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
} from '../../src/core/index.ts';
import {runLocalUserMessageEvent} from '../../src/runtime/turn/local.ts';
import type {RuntimeLogStore} from '../../src/runtime/evidence/contract.ts';
import {createTurnEvidence} from '../../src/runtime/evidence/turn-projection.ts';
import {
  defaultRoleModelProviderCapabilities,
  parseRoleModelExecutionDecision,
  type RoleModelAdapter,
  roleModelCommitValidationFailureRejectionReason,
  roleModelDecisionContractVersion,
  type RoleModelProviderExchangeSnapshot,
  visibleReplyModelToolName,
} from '../../src/role-model/index.ts';
import {characterStatePatchModelToolName} from '../../src/plugins/api/contract.ts';
import {
  LocalRuntimeStorageContractError,
  createLocalRuntimeStorageLayout,
  parseSegmentSessionId,
} from '../../src/runtime/storage/layout-contract.ts';
import {decodeRawEventLogRecord} from '../../src/runtime/storage/raw-event-codec.ts';
import {createDefaultProject02PluginHost} from '../support/default-plugin-host.ts';
import {createRawEventAppendFailingLogStore} from '../support/plugin-tool-loop-fixtures.ts';
import {createSequencedAdapter} from '../support/role-model-loop-fixtures.ts';
import {
  appendModelRound,
  completedTerminalRecord,
} from '../support/runtime-log-fixtures.ts';
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
    const conversationId = 'session-foreign-character-marker';
    const sessionId = `${conversationId}.1`;
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'foreign-character',
    }).createSession({
      conversationId,
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
    const conversationId = 'session-owner-token-append';
    const sessionId = `${conversationId}.1`;
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      conversationId,
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
    const conversationId = 'session-owner-token-scavenge';
    const sessionId = `${conversationId}.1`;
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      conversationId,
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
    const conversationId = 'session-low-level-writer';
    const sessionId = `${conversationId}.1`;
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      conversationId,
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
    const conversationId = 'session-created-at-agreement';
    const sessionId = `${conversationId}.1`;
    const eventIdentity = identity('evt_created_at_agreement');
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      conversationId,
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
    const conversationId = 'session-canonical-created-at';
    const sessionId = `${conversationId}.1`;
    const eventIdentity = identity('evt_canonical_created_at');
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      conversationId,
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
    const conversationId = 'session-validated-terminal-lookup';
    const sessionId = `${conversationId}.1`;
    const eventIdentity = identity('evt_patch_completed');
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      conversationId,
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

    writeJsonLines(paths.rawEventsPath, [patchRoundRecord(sessionId)]);

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
      patchRoundRecord(sessionId),
      {
        ...eventIdentity,
        kind: 'runtime_turn_rejected',
        eventType: 'USER_MESSAGE',
        status: 'rejected',
        reason: 'tool_rounds_exhausted',
        message: 'Role model exceeded maximum executable tool rounds (0).',
        round: 1,
        commitValidation: {
          ...eventIdentity,
          kind: 'role_model_commit_validation_snapshot',
          sessionId,
          result: {
            status: 'rejected',
            rejection: {
              reason: 'tool_rounds_exhausted',
              details:
                'Role model exceeded maximum executable tool rounds (0).',
            },
          },
        },
      },
    ]);

    expect(
      findRuntimeTurnTerminalRawEvent(
        reopenStore(paths).rawEvents(),
        eventIdentity,
      )?.kind,
    ).toBe('runtime_turn_rejected');
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
      conversationId: 'catalog-session',
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
      patchRoundRecord('malformed-provider-exchange'),
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
      patchRoundRecord('tampered-character-ref'),
    );
    const roleModelIOSnapshot = isTestRecord(tamperedRecord)
      ? tamperedRecord['roleModelIOSnapshot']
      : undefined;

    if (!isTestRecord(roleModelIOSnapshot)) {
      throw new Error('Expected role-model IO snapshot fixture.');
    }

    // Two identities in one snapshot: the provenance claims nova while the
    // turn was decided as the fixture character.
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
      patchRoundRecord('absent-plugin-tool-definitions'),
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

    // Every envelope the runtime writes carries this array, so an absent one
    // is damage, not an older record.
    Reflect.deleteProperty(inputEnvelope, 'pluginToolDefinitions');

    expect(() =>
      decodeRawEventLogRecord(JSON.stringify(malformedRecord)),
    ).toThrow(LocalRuntimeStorageContractError);
  });

  it("round-trips this turn's tool rounds through the persisted envelope", () => {
    const storedRecord = patchRoundRecord('tool-rounds-round-trip') as {
      roleModelIOSnapshot: {inputEnvelope: Record<string, unknown>};
    };
    const toolRounds = [
      {
        round: 1,
        text: 'let me check',
        interimReplies: [
          {
            id: 'tool-rounds-round-trip:message-2',
            role: 'character',
            speakerId: testCharacterProfile.id,
            speakerName: testCharacterProfile.displayName,
            text: 'One moment.',
          },
        ],
        toolCalls: [
          {
            toolCallId: 'call-accepted',
            pluginId: 'character-state',
            toolName: characterStatePatchModelToolName,
            input: {mood: 'curious'},
            result: {status: 'accepted', output: {ok: true}},
          },
          {
            toolCallId: 'call-rejected',
            pluginId: 'character-state',
            toolName: characterStatePatchModelToolName,
            input: {},
            result: {
              status: 'rejected',
              reason: 'handler_rejected',
              message: 'Nothing to patch.',
            },
          },
        ],
      },
    ];

    storedRecord.roleModelIOSnapshot.inputEnvelope['toolRounds'] = toolRounds;

    // The stored envelope is what the model was shown; every round must come
    // back whole, the model's own note beside its calls included.
    expect(
      decodeRawEventLogRecord(JSON.stringify(storedRecord)).roleModelIOSnapshot
        ?.inputEnvelope.toolRounds,
    ).toEqual(toolRounds);
  });

  it.each([
    [
      'no tool rounds',
      (envelope: Record<string, unknown>) => {
        Reflect.deleteProperty(envelope, 'toolRounds');
      },
    ],
    [
      'a tool call result of an unknown status',
      (envelope: Record<string, unknown>) => {
        envelope['toolRounds'] = [
          {
            round: 1,
            interimReplies: [],
            toolCalls: [
              {
                toolCallId: 'call-1',
                pluginId: 'character-state',
                toolName: characterStatePatchModelToolName,
                input: {},
                result: {status: 'pending'},
              },
            ],
          },
        ];
      },
    ],
  ])('rejects an envelope that persisted %s', (_label, damage) => {
    const storedRecord = patchRoundRecord('damaged-tool-rounds') as {
      roleModelIOSnapshot: {inputEnvelope: Record<string, unknown>};
    };

    damage(storedRecord.roleModelIOSnapshot.inputEnvelope);

    expect(() => decodeRawEventLogRecord(JSON.stringify(storedRecord))).toThrow(
      LocalRuntimeStorageContractError,
    );
  });

  it('reloads a turn that ran out of tool rounds', async () => {
    const storedRecords = (
      await persistedRoundsExhaustedRecords('rounds-exhausted-round-trip.1')
    ).map(record => decodeRawEventLogRecord(JSON.stringify(record)));

    // The parsed round stays what the model said; the refusal is the
    // runtime's, on the commit validation of the terminal that judged it.
    expect(
      storedRecords
        .filter(record => record.kind === 'role_model_round')
        .map(record => [
          record.round,
          record.parsedRoleModelDecisionSnapshot?.result.status,
        ]),
    ).toEqual([
      [1, 'accepted'],
      [2, 'accepted'],
    ]);
    expect(storedRecords.at(-1)).toMatchObject({
      kind: 'runtime_turn_rejected',
      reason: 'tool_rounds_exhausted',
      round: 2,
      commitValidation: {
        result: {
          status: 'rejected',
          rejection: {reason: 'tool_rounds_exhausted'},
        },
      },
    });
  });

  it('round-trips trusted curated sections and runtime notes through the persisted envelope', () => {
    const conversationId = 'curated-context-round-trip';
    const sessionId = `${conversationId}.1`;
    const storedRecord = patchRoundRecord(sessionId) as {
      roleModelIOSnapshot: {
        inputEnvelope: {
          decisionContext: Record<string, unknown>;
        };
      };
    };
    const sections = [
      {
        pluginId: 'character-memory',
        id: 'notes',
        title: 'Character notes',
        text: 'Prefers tea over coffee.',
        capChars: 2200,
        usedChars: 24,
      },
    ];
    const runtimeNotes = [
      {id: 'today', text: 'Today is Saturday, August 15, 2026.'},
      {id: 'current', text: 'mood=steady', pluginId: 'character-state'},
    ];

    storedRecord.roleModelIOSnapshot.inputEnvelope.decisionContext[
      'curatedContextSections'
    ] = sections;
    storedRecord.roleModelIOSnapshot.inputEnvelope.decisionContext[
      'runtimeNotes'
    ] = runtimeNotes;

    const decoded = decodeRawEventLogRecord(JSON.stringify(storedRecord));

    // Trusted context that shaped the recorded model input must survive
    // reopening the log, or the record understates what the model saw.
    expect(
      decoded.roleModelIOSnapshot?.inputEnvelope.decisionContext
        .curatedContextSections,
    ).toEqual(sections);
    expect(
      decoded.roleModelIOSnapshot?.inputEnvelope.decisionContext.runtimeNotes,
    ).toEqual(runtimeNotes);
    expect(
      decodeRawEventLogRecord(JSON.stringify(patchRoundRecord(sessionId)))
        .roleModelIOSnapshot?.inputEnvelope.decisionContext
        .curatedContextSections,
    ).toEqual([]);
    // ...and reach inspect, so an operator auditing a turn sees the whole
    // dynamic model context, not just its untrusted half.
    const inspected = createTurnEvidence({
      conversationMessages: [],
      rawEvents: [
        decoded,
        {
          ...identity('evt_patch_completed'),
          kind: 'runtime_turn_completed',
          eventType: 'USER_MESSAGE',
          status: 'completed',
        },
      ],
      traceEntries: [],
    })[0]?.modelRounds[0]?.roleModelEvidence.input;
    expect(inspected?.curatedContextSections).toEqual(sections);
    expect(inspected?.runtimeNotes).toEqual(runtimeNotes);
  });

  it('round-trips the history window and decodes records written before it had one', () => {
    const conversationId = 'history-window-round-trip';
    const sessionId = `${conversationId}.1`;
    const storedRecord = patchRoundRecord(sessionId) as {
      roleModelIOSnapshot: {
        inputEnvelope: {
          decisionContext: Record<string, unknown>;
        };
      };
    };

    storedRecord.roleModelIOSnapshot.inputEnvelope.decisionContext[
      'historyWindow'
    ] = {turnEventIds: ['evt_1', 'evt_2']};

    expect(
      decodeRawEventLogRecord(JSON.stringify(storedRecord)).roleModelIOSnapshot
        ?.inputEnvelope.decisionContext.historyWindow,
    ).toEqual({turnEventIds: ['evt_1', 'evt_2']});

    delete storedRecord.roleModelIOSnapshot.inputEnvelope.decisionContext[
      'historyWindow'
    ];

    expect(
      decodeRawEventLogRecord(JSON.stringify(storedRecord)).roleModelIOSnapshot
        ?.inputEnvelope.decisionContext.historyWindow,
    ).toEqual({turnEventIds: []});
  });

  it('round-trips the prompt size, decodes records without one, and rejects a malformed one', () => {
    const conversationId = 'prompt-size-round-trip';
    const sessionId = `${conversationId}.1`;
    const storedRecord = patchRoundRecord(sessionId) as {
      roleModelIOSnapshot: Record<string, unknown>;
    };
    const promptSize = {
      frames: [
        {kind: 'system_protocol', count: 1, chars: 400},
        {kind: 'conversation_history', count: 4, chars: 800},
      ],
      toolChars: 1200,
    };

    storedRecord.roleModelIOSnapshot['promptSize'] = promptSize;
    expect(
      decodeRawEventLogRecord(JSON.stringify(storedRecord)).roleModelIOSnapshot
        ?.promptSize,
    ).toEqual(promptSize);

    delete storedRecord.roleModelIOSnapshot['promptSize'];
    expect(
      decodeRawEventLogRecord(JSON.stringify(storedRecord)).roleModelIOSnapshot
        ?.promptSize,
    ).toBeUndefined();

    // A frame row exists only for a frame that was sent, so a zero count is
    // as malformed as a negative measure, and a kind measured twice would
    // count twice in the whole.
    for (const malformed of [
      {...promptSize, toolChars: -1},
      {
        ...promptSize,
        frames: [{kind: 'system_protocol', count: 0, chars: 400}],
      },
      {...promptSize, frames: []},
      {
        ...promptSize,
        frames: [...promptSize.frames, {...promptSize.frames[0]}],
      },
    ]) {
      storedRecord.roleModelIOSnapshot['promptSize'] = malformed;
      expect(() =>
        decodeRawEventLogRecord(JSON.stringify(storedRecord)),
      ).toThrow(/promptSize/u);
    }
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
    const conversationId = 'session-malformed-provider-exchange-rejection';
    const sessionId = `${conversationId}.1`;
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      conversationId,
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
      session: createSession({
        id: sessionId,
        character: testCharacterProfile,
      }),
      logStore,
      pluginHost: createDefaultProject02PluginHost({storeRoot, sessionId}),
      roleModelAdapter: createMalformedProviderExchangeAdapter(),
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'provider_error',
      message: 'Role-model adapter provider exchange is malformed.',
    });

    const reloadedLogStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const reloadedRawEvents = reloadedLogStore.rawEvents();
    expect(
      reloadedRawEvents.find(event => event.kind === 'role_model_round'),
    ).toMatchObject({
      round: 1,
      parsedRoleModelDecisionSnapshot: {
        result: {
          status: 'rejected',
          rejection: {
            reason: 'provider_error',
            details: 'Role-model adapter provider exchange is malformed.',
          },
        },
      },
    });
    expect(reloadedRawEvents.at(-1)).toMatchObject({
      kind: 'runtime_turn_rejected',
      reason: 'provider_error',
      round: 1,
      commitValidation: {
        result: {
          status: 'rejected',
          rejection: {reason: 'provider_error'},
        },
      },
    });
  });

  it('keeps provider credential-key values out of durable raw-event evidence', async () => {
    const storeRoot = createStoreRoot();
    const conversationId = 'session-provider-exchange-credential-redaction';
    const sessionId = `${conversationId}.1`;
    const credentialSentinel = 'durable-provider-credential-sentinel';
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      conversationId,
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
      session: createSession({
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
    const round = rawEvents.find(
      rawEvent => rawEvent.kind === 'role_model_round',
    );

    expect(round?.roleModelIOSnapshot?.providerExchange?.usage).toEqual({
      api_key: '[redacted]',
      safe: 'preserved',
    });
    expect(JSON.stringify(rawEvents)).not.toContain(credentialSentinel);
  });

  it('rejects persisted allowed tools that differ from the offered tools', () => {
    const malformedRecord: unknown = structuredClone(
      patchRoundRecord('duplicate-persisted-allowed-tools'),
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
      conversationId: 'session-multiline-visible',
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'session-multiline-visible.1',
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const session = createSession({
      character: testCharacterProfile,
      id: 'session-multiline-visible.1',
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
        sessionId: 'session-multiline-visible.1',
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
    const conversationId = 'session-custom-character';
    const sessionId = `${conversationId}.1`;
    const character = {
      id: 'nova',
      displayName: 'Nova',
    };
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: character.id,
    }).createSession({
      conversationId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const session = createSession({
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
        readConversationEvidence() {
          const evidence = durableStore.readSessionEvidence();

          return {
            // A foreign bound profile is rejected by design.
            character: durableRuntimeSessionCharacterProfile(
              evidence,
              character,
            ),
            messages: evidence.conversationMessages,
          };
        },
      },
    }).rehydrateSession(sessionId);

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
    const conversationId = 'session-custom-character-raw-append-failure';
    const sessionId = `${conversationId}.1`;
    const character = {id: 'nova', displayName: 'Nova'};
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: character.id,
    }).createSession({
      conversationId,
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
    const failedSession = createSession({
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
        session: createSession({
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
    const conversationId = 'session-terminal-omits-message';
    const sessionId = `${conversationId}.1`;
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      conversationId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const session = createSession({
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

    // Transcript reconstruction reads prior messages from terminal references.
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
      'session-edited-character-text.1',
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

    // The row and its anchor travel on one record, so the codec sees the
    // difference before any cross-record rule needs to.
    expect(() => reopenStore(paths).conversationMessages()).toThrow(
      /"commitValidation" is malformed/iu,
    );
  });

  it('rejects replies committed out of their decision order', async () => {
    const {paths, rawLines} = await committedTurnRawLines(
      'session-reply-order.1',
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

    // Only the text moves, so IDs stay in sequence and each row still matches
    // an accepted reply.
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

  it('rejects a character row that names a round the turn never ran', async () => {
    const {paths, rawLines} = await committedTurnRawLines(
      'session-unrun-round-reference.1',
      createSequencedVisibleReplyAdapter(['first thought', 'and a second']),
    );
    const commit = rawLines.findLast(
      line =>
        line.includes('"visible_message_committed"') &&
        line.includes('"role":"character"'),
    );

    if (commit === undefined) {
      throw new Error('Expected a character commit event.');
    }

    // Internally the record is fine: the round it names is what is missing.
    const forged = JSON.stringify({
      ...(JSON.parse(commit) as Record<string, unknown>),
      round: 9,
    });

    writeFileSync(
      paths.rawEventsPath,
      `${rawLines.map(line => (line === commit ? forged : line)).join('\n')}\n`,
      'utf8',
    );

    expect(() => reopenStore(paths).conversationMessages()).toThrow(
      /references model round 9, which the turn never ran/iu,
    );
  });

  it('rejects a model round out of sequence', async () => {
    const {paths, rawLines} = await committedTurnRawLines(
      'session-round-out-of-sequence.1',
    );
    const round = rawLines.find(line => line.includes('"role_model_round"'));

    if (round === undefined) {
      throw new Error('Expected a model round record.');
    }

    const renumbered = JSON.stringify({
      ...(JSON.parse(round) as Record<string, unknown>),
      round: 2,
    });

    writeFileSync(
      paths.rawEventsPath,
      `${rawLines.map(line => (line === round ? renumbered : line)).join('\n')}\n`,
      'utf8',
    );

    expect(() => reopenStore(paths).rawEvents()).toThrow(
      /Model round 2 is out of sequence/iu,
    );
  });

  it("rejects a terminal that judges a round other than the turn's last", async () => {
    const {paths, rawLines} = await committedTurnRawLines(
      'session-terminal-on-earlier-round.1',
      createSequencedAdapter([
        {toolCalls: [{name: 'visible_reply', input: {text: '   '}}]},
        {toolCalls: [{name: 'visible_reply', input: {text: 'real reply'}}]},
      ]),
    );
    const terminal = rawLines.find(line =>
      line.includes('"runtime_turn_completed"'),
    );

    if (terminal === undefined) {
      throw new Error('Expected a completed terminal record.');
    }

    // The turn ended on round 2; a terminal pointed at round 1 attributes
    // the outcome to a round that did not end it.
    const repointed = JSON.stringify({
      ...(JSON.parse(terminal) as Record<string, unknown>),
      round: 1,
    });

    writeFileSync(
      paths.rawEventsPath,
      `${rawLines.map(line => (line === terminal ? repointed : line)).join('\n')}\n`,
      'utf8',
    );

    expect(() => reopenStore(paths).rawEvents()).toThrow(
      /judges the round the turn ended on, round 2, not round 1/iu,
    );
  });

  it('rejects a completed terminal whose last round the parser refused', async () => {
    const {paths, rawLines} = await committedTurnRawLines(
      'session-terminal-on-refused-round.1',
    );
    const round = rawLines.find(line => line.includes('"role_model_round"'));
    const commit = rawLines.find(
      line =>
        line.includes('"visible_message_committed"') &&
        line.includes('"role":"character"'),
    );
    const terminal = rawLines.find(line =>
      line.includes('"runtime_turn_completed"'),
    );

    if (round === undefined || commit === undefined || terminal === undefined) {
      throw new Error('Expected a round, its reply, and the terminal.');
    }

    // The round is rewritten as one the parser refused, consistently with its
    // raw output, and the reply it produced is dropped along with its
    // reference; only the terminal still claims an accepted round.
    const rawOutputText = 'not a decision';
    const roundRecord = JSON.parse(round) as {
      roleModelIOSnapshot: Record<string, unknown>;
      parsedRoleModelDecisionSnapshot: Record<string, unknown>;
    };
    const refusedRound = JSON.stringify({
      ...roundRecord,
      roleModelIOSnapshot: {...roundRecord.roleModelIOSnapshot, rawOutputText},
      parsedRoleModelDecisionSnapshot: {
        ...roundRecord.parsedRoleModelDecisionSnapshot,
        result: parseRoleModelExecutionDecision(rawOutputText),
      },
    });
    const commitRecord = JSON.parse(commit) as {
      visibleMessage: {id: string};
    };
    const terminalRecord = JSON.parse(terminal) as {
      visibleMessageIds: readonly string[];
    };
    const forgedTerminal = JSON.stringify({
      ...terminalRecord,
      visibleMessageIds: terminalRecord.visibleMessageIds.filter(
        id => id !== commitRecord.visibleMessage.id,
      ),
    });

    writeFileSync(
      paths.rawEventsPath,
      `${rawLines
        .flatMap(line =>
          line === round
            ? [refusedRound]
            : line === commit
              ? []
              : line === terminal
                ? [forgedTerminal]
                : [line],
        )
        .join('\n')}\n`,
      'utf8',
    );

    expect(() => reopenStore(paths).rawEvents()).toThrow(
      /must end on a round the parser accepted/iu,
    );
  });

  it('rejects a completed terminal on a round that still asked for a tool', async () => {
    const {paths, rawLines} = await committedTurnRawLines(
      'session-terminal-on-tool-round.1',
      createSequencedVisibleReplyAdapter(['a reply']),
    );
    const round = rawLines.find(line => line.includes('"role_model_round"'));

    if (round === undefined) {
      throw new Error('Expected a model round record.');
    }

    // The round keeps its reply, so the row still matches, and gains a tool
    // call the turn never ran; only the terminal claims it completed there.
    const rawOutputText = JSON.stringify({
      toolCalls: [
        {name: 'visible_reply', input: {text: 'a reply'}},
        {name: 'runtime.plugin.list', input: {}},
      ],
    });
    const roundRecord = JSON.parse(round) as {
      roleModelIOSnapshot: Record<string, unknown>;
      parsedRoleModelDecisionSnapshot: Record<string, unknown>;
    };
    const askingRound = JSON.stringify({
      ...roundRecord,
      roleModelIOSnapshot: {...roundRecord.roleModelIOSnapshot, rawOutputText},
      parsedRoleModelDecisionSnapshot: {
        ...roundRecord.parsedRoleModelDecisionSnapshot,
        result: parseRoleModelExecutionDecision(rawOutputText),
      },
    });

    writeFileSync(
      paths.rawEventsPath,
      `${rawLines.map(line => (line === round ? askingRound : line)).join('\n')}\n`,
      'utf8',
    );

    expect(() => reopenStore(paths).rawEvents()).toThrow(
      /must end on a round that asked for no tool/iu,
    );
  });

  it('rejects an exhausted-budget rejection on a round that asked for no tool', async () => {
    const {paths, rawLines} = await committedTurnRawLines(
      'session-exhausted-on-reply-round.1',
      createSequencedVisibleReplyAdapter(['a reply']),
    );
    const terminal = rawLines.find(line =>
      line.includes('"runtime_turn_completed"'),
    );

    if (terminal === undefined) {
      throw new Error('Expected a completed terminal record.');
    }

    // Internally consistent: reason, message, and verdict all say the budget
    // ran out. The round it judges asked for nothing the budget could refuse.
    const record = JSON.parse(terminal) as {
      commitValidation: Record<string, unknown>;
    };
    const forged = JSON.stringify({
      ...record,
      kind: 'runtime_turn_rejected',
      status: 'rejected',
      reason: 'tool_rounds_exhausted',
      message: 'forged budget refusal',
      commitValidation: {
        ...record.commitValidation,
        result: {
          status: 'rejected',
          rejection: {
            reason: 'tool_rounds_exhausted',
            details: 'forged budget refusal',
          },
        },
      },
    });

    writeFileSync(
      paths.rawEventsPath,
      `${rawLines.map(line => (line === terminal ? forged : line)).join('\n')}\n`,
      'utf8',
    );

    expect(() => reopenStore(paths).rawEvents()).toThrow(
      /must repeat the refusal of the round it judged/iu,
    );
  });

  it("rejects a rejection for one of the model's reasons that names no round", async () => {
    const {paths, rawLines} = await committedTurnRawLines(
      'session-model-rejection-without-round.1',
      createMalformedProviderExchangeAdapter(),
    );
    const terminal = rawLines.find(line =>
      line.includes('"runtime_turn_rejected"'),
    );

    if (terminal === undefined) {
      throw new Error('Expected a rejected terminal record.');
    }

    // The provider's failure was a round's; a rejection that keeps the reason
    // but drops the round claims a model refusal no round produced.
    const record = JSON.parse(terminal) as Record<string, unknown>;

    delete record['round'];
    delete record['commitValidation'];

    writeFileSync(
      paths.rawEventsPath,
      `${rawLines
        .map(line => (line === terminal ? JSON.stringify(record) : line))
        .join('\n')}\n`,
      'utf8',
    );

    expect(() => reopenStore(paths).rawEvents()).toThrow(
      /"commitValidation" is malformed/iu,
    );
  });

  it('rejects a completed terminal stripped of its round and verdict', async () => {
    const {paths, rawLines} = await committedTurnRawLines(
      'session-terminal-without-verdict.1',
    );
    const terminal = rawLines.find(line =>
      line.includes('"runtime_turn_completed"'),
    );

    if (terminal === undefined) {
      throw new Error('Expected a completed terminal record.');
    }

    // A turn that ran the model completed on a verdict; a terminal without
    // one reports a model turn with no verdict at all.
    const record = JSON.parse(terminal) as Record<string, unknown>;

    delete record['round'];
    delete record['commitValidation'];

    writeFileSync(
      paths.rawEventsPath,
      `${rawLines
        .map(line => (line === terminal ? JSON.stringify(record) : line))
        .join('\n')}\n`,
      'utf8',
    );

    expect(() => reopenStore(paths).rawEvents()).toThrow(
      /ran the model must judge the round it ended on/iu,
    );
  });

  it('rejects a completed terminal that anchors a reply its round never asked for', async () => {
    const {paths, rawLines} = await committedTurnRawLines(
      'session-terminal-anchor.1',
    );
    const terminal = rawLines.find(line =>
      line.includes('"runtime_turn_completed"'),
    );

    if (terminal === undefined) {
      throw new Error('Expected a completed terminal record.');
    }

    const record = JSON.parse(terminal) as {
      commitValidation: {result: Record<string, unknown>};
    };
    const forged = JSON.stringify({
      ...record,
      commitValidation: {
        ...record.commitValidation,
        result: {
          ...record.commitValidation.result,
          acceptedVisibleReplyText: 'not what the round said',
        },
      },
    });

    writeFileSync(
      paths.rawEventsPath,
      `${rawLines.map(line => (line === terminal ? forged : line)).join('\n')}\n`,
      'utf8',
    );

    expect(() => reopenStore(paths).rawEvents()).toThrow(
      /must anchor a reply the round it ended on asked for/iu,
    );
  });

  it('rejects a turn rejection whose reason disagrees with the round it judged', async () => {
    const {paths, rawLines} = await committedTurnRawLines(
      'session-rejection-disagrees.1',
      createMalformedProviderExchangeAdapter(),
    );
    const terminal = rawLines.find(line =>
      line.includes('"runtime_turn_rejected"'),
    );

    if (terminal === undefined) {
      throw new Error('Expected a rejected terminal record.');
    }

    // Reason and verdict agree with each other, but not with the round.
    const record = JSON.parse(terminal) as {
      commitValidation: {result: {rejection: Record<string, unknown>}};
    };
    const forged = JSON.stringify({
      ...record,
      reason: 'malformed_output',
      commitValidation: {
        ...record.commitValidation,
        result: {
          status: 'rejected',
          rejection: {
            ...record.commitValidation.result.rejection,
            reason: 'malformed_output',
          },
        },
      },
    });

    writeFileSync(
      paths.rawEventsPath,
      `${rawLines.map(line => (line === terminal ? forged : line)).join('\n')}\n`,
      'utf8',
    );

    expect(() => reopenStore(paths).rawEvents()).toThrow(
      /must repeat the refusal of the round it judged/iu,
    );
  });

  it('rejects replies swapped across rounds behind self-consistent forged rounds', async () => {
    const {paths, rawLines} = await committedTurnRawLines(
      'session-cross-round-swap.1',
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

    // Text, anchors, and round travel together while IDs and committedAt stay,
    // so every group is internally consistent and nothing else objects first.
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
      'session-input-drift.1',
      createSequencedVisibleReplyAdapter(['a reply']),
    );

    // Snapshot and summary agree inside the forged round record, so only
    // the cross-record rule can catch it.
    const editedLines = rawLines.map(line => {
      if (!line.includes('"role_model_round"')) {
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
    const conversationId = 'session-stale-prepared';
    const sessionId = `${conversationId}.1`;
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      conversationId: parseSegmentSessionId(sessionId).conversationId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });
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

      // Valid when prepared: the turn had no messages yet.
      const staleTerminal = logStore.prepareRawEvent({
        ...turnIdentity,
        kind: 'runtime_turn_rejected',
        eventType: 'USER_MESSAGE',
        status: 'rejected',
        reason: 'runtime_failure',
        message: 'prepared before the user message committed',
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

    // What remains is an open turn, the crash shape, which stays readable.
    expect(reopenStore(paths).conversationMessages()).toHaveLength(1);
  });

  it('accepts repeated replies whose text needed normalizing', async () => {
    const {paths} = await committedTurnRawLines(
      'session-repeated-normalized-replies.1',
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
    const conversationId = 'session-lagging-log-retry';
    const sessionId = `${conversationId}.1`;
    const character = {id: 'nova', displayName: 'Nova'};
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: character.id,
    }).createSession({
      conversationId: parseSegmentSessionId(sessionId).conversationId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });

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
    const session = createSession({id: sessionId, character});

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

    // The log skips the number the failed reply took.
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
        session: createSession({
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
      'session-repeated-rounds.1',
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
      'session-duplicate-commit-anchor.1',
    );
    const anchor = rawLines.find(line =>
      line.includes('"visible_message_committed"'),
    );

    if (anchor === undefined) {
      throw new Error('Expected a commit anchor line.');
    }

    // Inserted before the terminal, so the turn-shape gate decides rather than
    // the records-after-terminal rule.
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
  it('rejects a forged character row committed without its round and anchor', async () => {
    const storeRoot = createStoreRoot();
    const conversationId = 'session-forged-character-row';
    const sessionId = `${conversationId}.1`;
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      conversationId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const session = createSession({
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

    // A forged reply can carry a bare commit event but not the round that
    // produced its text nor the anchor that pins it.
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
      delete record['round'];
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
    ).toThrow(/"round" is malformed/iu);
  });

  it('rejects a second user row appended into one turn', async () => {
    const {paths, rawLines} = await committedTurnRawLines(
      'session-second-user-row.1',
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
      'session-reordered-rows.1',
    );
    const commits = rawLines.filter(line =>
      line.includes('"visible_message_committed"'),
    );

    if (commits.length < 2) {
      throw new Error('Expected two commit events.');
    }

    // Message IDs are assigned per session and checked against position.
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
    // A killed process ends the log mid-turn: messages committed, no terminal
    // event. The next writer's turn implicitly closes it.
    const {paths} = await committedTurnRawLines(
      'session-crash-open-turn.1',
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

    const session = createSession({
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
    const conversationId = 'session-torn-final-record';
    const sessionId = `${conversationId}.1`;
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      conversationId,
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
      session: createSession({
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

    expect(reopened.conversationMessages()).toHaveLength(2);
    expect(
      reopened.rawEvents().some(record => record.eventId === 'evt_torn_second'),
    ).toBe(false);

    const followupResult = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'still there?',
        identity('evt_after_torn'),
      ),
      session: createSession({
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
    const conversationId = 'session-before-call-rejected';
    const sessionId = `${conversationId}.1`;
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      conversationId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const session = createSession({
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
    // The user message committed before the gate ran, so a terminal rejection
    // that omits it leaves later reads rebuilding a shorter conversation.
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
    const followupSession = createSession({
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
      conversationId: 'session-health-rejected',
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'session-health-rejected.1',
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const session = createSession({
      character: testCharacterProfile,
      id: 'session-health-rejected.1',
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
    // Health gates run after delivery, so they never un-say shown text.
    expect(
      logStore.conversationMessages().map(message => message.role),
    ).toEqual(['user', 'character']);

    // One record says it all: the health gate is a commit validation
    // failure on the round the turn ended with.
    const rawEvents = logStore.rawEvents();

    expect(
      rawEvents.filter(event => event.kind === 'runtime_turn_rejected'),
    ).toHaveLength(1);
    expect(rawEvents.at(-1)).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected',
      reason: roleModelCommitValidationFailureRejectionReason,
      message: 'Plugin health unavailable: health fixture offline',
      round: 1,
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
  });

  it('rejects degraded health snapshots when plugin health policy rejects turns', async () => {
    const storeRoot = createStoreRoot();
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      conversationId: 'session-health-degraded-rejected',
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'session-health-degraded-rejected.1',
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const session = createSession({
      character: testCharacterProfile,
      id: 'session-health-degraded-rejected.1',
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
    // Health gates run after delivery, so they never un-say shown text.
    expect(
      logStore.conversationMessages().map(message => message.role),
    ).toEqual(['user', 'character']);

    const rawEvents = logStore.rawEvents();

    expect(rawEvents.at(-1)).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected',
      reason: roleModelCommitValidationFailureRejectionReason,
      round: 1,
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
  });

  it('keeps an unfinished tool call readable and refuses to complete over it', async () => {
    const storeRoot = createStoreRoot();
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: 'mira',
    }).createSession({
      conversationId: 'session-tools',
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'session-tools.1',
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const writerLease = await acquireLocalRuntimeSessionWriterLease({
      storeRoot,
      sessionId: 'session-tools.1',
      ownerToken: fileLogStoreWriterOwnerToken(logStore),
    });

    try {
      appendTurnPrefix(logStore);
      appendModelRound(logStore, identity(), {
        round: 1,
        sessionId: 'session-tools.1',
        decision: {
          toolCalls: [{name: 'memory.search', input: {query: 'Mira'}}],
        },
      });
      logStore.appendRawEvent({
        ...identity(),
        kind: 'tool_call_started',
        eventType: 'USER_MESSAGE',
        toolCallId: 'round-1.1.memory.search',
        round: 1,
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
        logStore.appendRawEvent(
          completedTerminalRecord(identity(), {sessionId: 'session-tools.1'}),
        ),
      ).toThrow(/started without finish/iu);
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
      conversationId: 'session-tools-rejected',
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'session-tools-rejected.1',
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const eventId = 'evt_tool_finish_log_failed';
    const writerLease = await acquireLocalRuntimeSessionWriterLease({
      storeRoot,
      sessionId: 'session-tools-rejected.1',
      ownerToken: fileLogStoreWriterOwnerToken(logStore),
    });

    try {
      appendTurnPrefix(logStore, eventId);
      appendModelRound(logStore, identity(eventId), {
        round: 1,
        sessionId: 'session-tools-rejected.1',
        decision: {
          toolCalls: [{name: 'memory.write', input: {value: 'planned'}}],
        },
      });
      logStore.appendRawEvent({
        ...identity(eventId),
        kind: 'tool_call_started',
        eventType: 'USER_MESSAGE',
        toolCallId: 'round-1.1.memory.write',
        round: 1,
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
        reason: 'runtime_failure',
        message: 'Runtime turn failed before producing a reply.',
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
      conversationId: 'session-terminal-tools',
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'session-terminal-tools.1',
      characterId: testCharacterProfile.id,
      boundCharacter: testCharacterProfile,
    });
    const writerLease = await acquireLocalRuntimeSessionWriterLease({
      storeRoot,
      sessionId: 'session-terminal-tools.1',
      ownerToken: fileLogStoreWriterOwnerToken(logStore),
    });

    try {
      appendTurnPrefix(logStore, 'evt_terminal_tool_ref');
      appendModelRound(logStore, identity('evt_terminal_tool_ref'), {
        round: 1,
        sessionId: 'session-terminal-tools.1',
        decision: {toolCalls: [{name: 'memory.search', input: {}}]},
      });
      expect(() =>
        logStore.appendRawEvent({
          ...completedTerminalRecord(identity('evt_terminal_tool_ref'), {
            sessionId: 'session-terminal-tools.1',
          }),
          toolCallIds: ['round-1.1.memory.search'],
        }),
      ).toThrow(/references unfinished tool call/iu);
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

async function persistedRoundsExhaustedRecords(
  sessionId: string,
): Promise<readonly unknown[]> {
  const storeRoot = createStoreRoot();
  await createLocalRuntimeSessionStore({
    storeRoot,
    characterId: 'mira',
  }).createSession({
    conversationId: parseSegmentSessionId(sessionId).conversationId,
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
    session: createSession({
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
  const storedRecords: unknown[] = structuredClone([...logStore.rawEvents()]);

  expect(result).toMatchObject({
    status: 'rejected',
    reason: 'tool_rounds_exhausted',
  });

  return storedRecords;
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
      JSON.stringify(patchRoundRecord('persisted-plugin-tool-schema')),
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

function patchRoundRecord(sessionId: string): object {
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
    kind: 'role_model_round',
    eventType: 'USER_MESSAGE',
    round: 1,
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
        toolRounds: [],
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
          name: 'nvidia',
        },
        capabilities: defaultRoleModelProviderCapabilities,
        reasoning: {
          mode: 'enabled',
          params: {},
        },
        renderedMessages: invocation.turnContext.messages,
        renderedTools: invocation.turnContext.tools,
        toolNameMappings: [],
        requestBody: {},
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
    enabledPluginIds: ['before-call.reject.fixture'],
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
    enabledPluginIds: ['health.reject.fixture'],
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
  }).createSession({
    conversationId: parseSegmentSessionId(sessionId).conversationId,
    createdAt: '2026-06-15T00:00:00.000Z',
  });

  const logStore = createFileRuntimeLogStore({
    storeRoot,
    sessionId,
    characterId: testCharacterProfile.id,
    boundCharacter: testCharacterProfile,
  });

  await runLocalUserMessageEvent({
    event: createUserMessageRuntimeEvent('hello', identity(`evt_${sessionId}`)),
    session: createSession({
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

// The repeated rounds are distinguishable only by which round they were.
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
