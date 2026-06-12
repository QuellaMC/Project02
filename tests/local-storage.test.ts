import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  agentCapabilityContractVersion,
  createAcceptedRoleModelDecisionResult,
  createAgentCapabilityTurnEvidenceSnapshot,
  createCharacterStatePatchSnapshot,
  createDecisionContext,
  createDefaultCharacterRuntimeState,
  createLivingStateBrief,
  createLocalRuntimeSessionMetadata,
  createLocalRuntimeSessionPaths,
  createLocalRuntimeStorageLayout,
  createLocalRuntimeStorageSchemaMarker,
  createParsedRoleModelDecisionSnapshot,
  createRejectedRoleModelDecisionResult,
  createRoleModelCommitValidationSnapshot,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot,
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
  createVisibleReplyCharacterDecision,
  decodeConversationLogRecord,
  decodeRawEventLogRecord,
  decodeRuntimeTraceEntry,
  decodeStorageSchemaMarker,
  defaultLocalRuntimeSessionId,
  defaultLocalRuntimeStoreRoot,
  encodeConversationLogRecord,
  encodeRawEventLogRecord,
  encodeRuntimeTraceEntry,
  encodeStorageSchemaMarker,
  LocalRuntimeStorageContractError,
  localRuntimeStorageSchemaVersion,
  normalizeLocalRuntimeSessionId,
    parseRoleModelDecision,
    planCharacterStatePatch,
    roleModelAdapterRejectionNotReplayableDetails,
    roleModelCapabilityToolRejectedRejectionReason,
    roleModelDecisionContractVersion,
  roleModelDisallowedToolRejectionReason,
  roleModelInvalidCharacterStatePatchRejectionReason,
  roleModelInvalidVisibleReplyRejectionReason,
  roleModelMalformedOutputRejectionReason,
  roleModelProviderErrorRejectionReason,
  roleModelVisibleReplyActionName,
  type ConversationLogRecord,
  type LocalRuntimeStorageContractErrorCode,
  type AgentCapabilityTurnEvidenceSnapshot,
  type RawEventLogRecord,
  type RoleModelDecisionRejectionReason,
  type RuntimeEventIdentity,
  type RuntimeTraceEntry
} from '../src/index.ts';

const createdAt = '2026-06-04T00:00:00.000Z';

describe('local runtime storage contract', () => {
  it('defines shared typed errors for downstream local storage boundaries', () => {
    const errorCodes = [
      'invalid_session_id',
      'malformed_record',
      'malformed_schema_marker',
      'missing_file',
      'partial_write',
      'read_failed',
      'unsupported_schema_version',
      'write_failed'
    ] as const satisfies readonly LocalRuntimeStorageContractErrorCode[];

    expect(errorCodes).toEqual([
      'invalid_session_id',
      'malformed_record',
      'malformed_schema_marker',
      'missing_file',
      'partial_write',
      'read_failed',
      'unsupported_schema_version',
      'write_failed'
    ]);

    for (const code of errorCodes) {
      const error = new LocalRuntimeStorageContractError(
        code,
        `Example local runtime storage error: ${code}.`
      );

      expect(error.code).toBe(code);
      expect(error.name).toBe('LocalRuntimeStorageContractError');
    }
  });

  it('defines the default store root, schema marker, and per-session path layout', () => {
    const layout = createLocalRuntimeStorageLayout();
    const sessionPaths = createLocalRuntimeSessionPaths({
      sessionId: 'mira-local'
    });

    expect(defaultLocalRuntimeStoreRoot).toBe('.project02-runtime');
    expect(defaultLocalRuntimeSessionId).toBe('local-session');
    expect(layout).toEqual({
      storeRoot: '.project02-runtime',
      schemaPath: join('.project02-runtime', 'schema.json'),
      sessionCatalogPath: join('.project02-runtime', 'sessions.jsonl'),
      sessionsRoot: join('.project02-runtime', 'sessions')
    });
    expect(sessionPaths).toEqual({
      storeRoot: '.project02-runtime',
      sessionId: 'mira-local',
      sessionRoot: join('.project02-runtime', 'sessions', 'mira-local'),
      tracePath: join('.project02-runtime', 'sessions', 'mira-local', 'trace.jsonl'),
      rawEventsPath: join(
        '.project02-runtime',
        'sessions',
        'mira-local',
        'raw-events.jsonl'
      ),
      conversationPath: join(
        '.project02-runtime',
        'sessions',
        'mira-local',
        'conversation.jsonl'
      ),
      characterStatePath: join(
        '.project02-runtime',
        'sessions',
        'mira-local',
        'character-state.json'
      )
    });
    expect(createLocalRuntimeStorageLayout({ storeRoot: '/tmp/project02-store' })).toEqual({
      storeRoot: '/tmp/project02-store',
      schemaPath: join('/tmp/project02-store', 'schema.json'),
      sessionCatalogPath: join('/tmp/project02-store', 'sessions.jsonl'),
      sessionsRoot: join('/tmp/project02-store', 'sessions')
    });
    expect(
      readFileSync(join(process.cwd(), '.gitignore'), 'utf8')
    ).toContain('.project02-runtime/');
  });

  it('validates storage-safe session IDs before they affect file paths', () => {
    expect(normalizeLocalRuntimeSessionId('  mira.local-01  ')).toBe('mira.local-01');
    expect(normalizeLocalRuntimeSessionId(undefined)).toBe(defaultLocalRuntimeSessionId);

    for (const unsafeSessionId of ['', '   ', '.', '..', 'a/b', 'a\\b', 'a b']) {
      expect(() => normalizeLocalRuntimeSessionId(unsafeSessionId)).toThrow(
        LocalRuntimeStorageContractError
      );
    }

    try {
      normalizeLocalRuntimeSessionId('a/b');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(LocalRuntimeStorageContractError);

      if (!(error instanceof LocalRuntimeStorageContractError)) {
        throw new Error('Expected LocalRuntimeStorageContractError.', {
          cause: error
        });
      }

      expect(error.code).toBe('invalid_session_id');
      expect(error.message).toBe(
        'Local runtime session ID must use only letters, numbers, dots, underscores, or hyphens.'
      );
      return;
    }

    throw new Error('Expected unsafe session ID to be rejected.');
  });

  it('creates deterministic session metadata and schema markers', () => {
    const session = createLocalRuntimeSessionMetadata({
      sessionId: 'mira-local',
      createdAt,
      updatedAt: '2026-06-04T00:05:00.000Z'
    });
    const schema = createLocalRuntimeStorageSchemaMarker({
      createdAt
    });

    expect(session).toEqual({
      sessionId: 'mira-local',
      createdAt,
      updatedAt: '2026-06-04T00:05:00.000Z'
    });
    expect(schema).toEqual({
      schemaVersion: localRuntimeStorageSchemaVersion,
      createdAt
    });
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(schema)).toBe(true);
  });

  it('encodes and decodes the schema marker with unsupported-version errors', () => {
    const encoded = encodeStorageSchemaMarker(
      createLocalRuntimeStorageSchemaMarker({
        createdAt
      })
    );

    expect(decodeStorageSchemaMarker(encoded)).toEqual({
      schemaVersion: localRuntimeStorageSchemaVersion,
      createdAt
    });
    expect(() =>
      decodeStorageSchemaMarker(
        JSON.stringify({
          schemaVersion: localRuntimeStorageSchemaVersion + 1,
          createdAt
        })
      )
    ).toThrow(LocalRuntimeStorageContractError);

    try {
      decodeStorageSchemaMarker('{"schemaVersion":999,"createdAt":"2026-06-04T00:00:00.000Z"}');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(LocalRuntimeStorageContractError);

      if (!(error instanceof LocalRuntimeStorageContractError)) {
        throw new Error('Expected LocalRuntimeStorageContractError.', {
          cause: error
        });
      }

      expect(error.code).toBe('unsupported_schema_version');
      return;
    }

    throw new Error('Expected unsupported schema version to be rejected.');
  });

  it('encodes and decodes MVP-003 runtime trace, raw event, and conversation records', () => {
    const trace: RuntimeTraceEntry = {
      eventId: 'evt_001',
      traceId: 'trace_001',
      createdAt,
      step: 'runtime_event_received'
    };
    const rawEvent: RawEventLogRecord = {
      eventId: 'evt_001',
      traceId: 'trace_001',
      createdAt,
      kind: 'runtime_turn_completed',
      eventType: 'USER_MESSAGE',
      status: 'completed',
      visibleMessageIds: ['local-session:message-1', 'local-session:message-2'],
      payloadSummary: {
        rawInput: ' hello ',
        normalizedCurrentUserMessage: 'hello'
      }
    };
    const conversation: ConversationLogRecord = {
      eventId: 'evt_001',
      traceId: 'trace_001',
      createdAt,
      id: 'local-session:message-1',
      role: 'user',
      speakerId: 'local-user',
      speakerName: 'You',
      text: 'hello',
      committedAt: '2026-06-04T00:00:01.000Z'
    };

    const decodedRawEvent = decodeRawEventLogRecord(encodeRawEventLogRecord(rawEvent));

    expect(decodeRuntimeTraceEntry(encodeRuntimeTraceEntry(trace))).toEqual(trace);
    expect(decodedRawEvent).toEqual(rawEvent);
    expect(decodeConversationLogRecord(encodeConversationLogRecord(conversation))).toEqual(
      conversation
    );
    expect(Object.isFrozen(decodedRawEvent)).toBe(true);
    expect(Object.isFrozen(decodedRawEvent.visibleMessageIds)).toBe(true);
    expect(Object.isFrozen(decodedRawEvent.payloadSummary)).toBe(true);
  });

  it('preserves empty payload summary strings used by rejected runtime turns', () => {
    const rawEvent: RawEventLogRecord = {
      eventId: 'evt_rejected_empty',
      traceId: 'trace_rejected_empty',
      createdAt,
      kind: 'runtime_turn_rejected',
      eventType: 'USER_MESSAGE',
      status: 'rejected',
      reason: 'Provide exactly one non-empty message.',
      payloadSummary: {
        rawInput: '',
        normalizedCurrentUserMessage: ''
      }
    };

    expect(decodeRawEventLogRecord(encodeRawEventLogRecord(rawEvent))).toEqual(rawEvent);
  });

  it('decodes redacted capability turn evidence with source refs and policy outcomes', () => {
    const rawEvent: RawEventLogRecord = {
      eventId: 'evt_capability_storage',
      traceId: 'trace_capability_storage',
      createdAt,
      kind: 'runtime_turn_rejected',
      eventType: 'USER_MESSAGE',
      status: 'rejected',
      reason: 'required capability failed',
      agentCapabilityTurnEvidence: createCapabilityTurnEvidence({
        eventId: 'evt_capability_storage',
        traceId: 'trace_capability_storage',
        createdAt
      })
    };

    const decoded = decodeRawEventLogRecord(encodeRawEventLogRecord(rawEvent));
    const capabilityEvidence = decoded.agentCapabilityTurnEvidence;

    expect(capabilityEvidence?.capabilities[0]).toMatchObject({
      capabilityId: 'memory.fixture',
      enabled: true,
      availableForTurn: false,
      configFingerprint: 'gateway_api_key=[redacted]'
    });
    expect(capabilityEvidence?.contextItems[0]).toMatchObject({
      capabilityId: 'memory.fixture',
      text: 'Recovered endpoint token=[redacted]',
      sourceReferences: [
        {
          kind: 'memory',
          id: 'mem_1',
          uri: 'https://[redacted]@memory.local/item?api_key=[redacted]'
        }
      ]
    });
    expect(capabilityEvidence?.evidence.map((snapshot) => snapshot.policyOutcome)).toEqual([
      'required_rejected',
      'optional_degraded',
      'disallowed_tool_call',
      'handler_rejected',
      'timeout',
      'health_degraded',
      'after_commit_failed'
    ]);
    expect(JSON.stringify(decoded)).not.toContain('secret-token');
    expect(JSON.stringify(decoded)).not.toContain('plain-secret');
  });

  it('rejects capability evidence whose nested identity does not match the raw event identity', () => {
    const rawEvent: RawEventLogRecord = {
      eventId: 'evt_capability_storage',
      traceId: 'trace_capability_storage',
      createdAt,
      kind: 'runtime_turn_rejected',
      eventType: 'USER_MESSAGE',
      status: 'rejected',
      reason: 'required capability failed',
      agentCapabilityTurnEvidence: createCapabilityTurnEvidence({
        eventId: 'evt_capability_storage',
        traceId: 'trace_capability_storage',
        createdAt
      })
    };
    const record = mutableRecordFromRawEvent(rawEvent);
    const turnEvidence = requiredMutableRecord(
      record['agentCapabilityTurnEvidence'],
      'agentCapabilityTurnEvidence'
    );

    turnEvidence['eventId'] = 'evt_other';

    expectMalformedRawEvent(record);
  });

  it('rejects role-model evidence whose nested identity does not match the raw event identity', () => {
    const record = mutableRecordFromRawEvent(createRoleModelCompletedRawEvent());
    const snapshot = requiredMutableRecord(
      record['roleModelIOSnapshot'],
      'roleModelIOSnapshot'
    );

    snapshot['eventId'] = 'evt_other';

    expectMalformedRawEvent(record);
  });

  it('rejects role-model input text that contradicts the normalized payload summary', () => {
    const record = mutableRecordFromRawEvent(createRoleModelCompletedRawEvent());
    const snapshot = requiredMutableRecord(
      record['roleModelIOSnapshot'],
      'roleModelIOSnapshot'
    );
    const inputEnvelope = requiredMutableRecord(
      snapshot['inputEnvelope'],
      'roleModelIOSnapshot.inputEnvelope'
    );
    const event = requiredMutableRecord(
      inputEnvelope['event'],
      'roleModelIOSnapshot.inputEnvelope.event'
    );
    const payload = requiredMutableRecord(
      event['payload'],
      'roleModelIOSnapshot.inputEnvelope.event.payload'
    );

    payload['currentUserMessage'] = 'DIFFERENT';

    expectMalformedRawEvent(record);
  });

  it('rejects partial role-model evidence on raw event records', () => {
    const record = mutableRecordFromRawEvent(createRoleModelCompletedRawEvent());

    delete record['parsedRoleModelDecisionSnapshot'];

    expectMalformedRawEvent(record);
  });

  it('rejects role-model evidence whose raw output parses to a different decision', () => {
    for (const rawOutputText of [
      JSON.stringify({
        action: {
          type: roleModelVisibleReplyActionName,
          text: 'tampered reply'
        }
      }),
      'not json'
    ]) {
      const record = mutableRecordFromRawEvent(createRoleModelCompletedRawEvent());
      const snapshot = requiredMutableRecord(
        record['roleModelIOSnapshot'],
        'roleModelIOSnapshot'
      );

      snapshot['rawOutputText'] = rawOutputText;

      expectMalformedRawEvent(record);
    }
  });

  it('rejects accepted role-model decisions excluded by the stored input envelope', () => {
    const record = mutableRecordFromRawEvent(createRoleModelCompletedRawEvent());
    const snapshot = requiredMutableRecord(
      record['roleModelIOSnapshot'],
      'roleModelIOSnapshot'
    );
    const inputEnvelope = requiredMutableRecord(
      snapshot['inputEnvelope'],
      'roleModelIOSnapshot.inputEnvelope'
    );

    inputEnvelope['allowedTools'] = [];

    expectMalformedRawEvent(record);
  });

  it('accepts parser-owned disallowed-tool rejection from stored input envelope tools', () => {
    const decoded = decodeRawEventLogRecord(
      JSON.stringify(createRoleModelDisallowedToolRejectedRawEvent())
    );

    expect(decoded).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected',
      reason: roleModelDisallowedToolRejectionReason,
      roleModelIOSnapshot: {
        inputEnvelope: {
          allowedTools: [roleModelVisibleReplyActionName]
        }
      },
      parsedRoleModelDecisionSnapshot: {
        result: {
          status: 'rejected',
          rejection: {
            reason: roleModelDisallowedToolRejectionReason,
            details: 'Decision requested disallowed tool "character_state.patch".'
          }
        }
      }
    });
  });

  it('rejects stored living-state brief text that does not match its current state', () => {
    const record = mutableRecordFromRawEvent(createRoleModelCompletedRawEvent());
    const snapshot = requiredMutableRecord(
      record['roleModelIOSnapshot'],
      'roleModelIOSnapshot'
    );
    const inputEnvelope = requiredMutableRecord(
      snapshot['inputEnvelope'],
      'roleModelIOSnapshot.inputEnvelope'
    );
    const decisionContext = requiredMutableRecord(
      inputEnvelope['decisionContext'],
      'roleModelIOSnapshot.inputEnvelope.decisionContext'
    );
    const livingStateBrief = requiredMutableRecord(
      decisionContext['livingStateBrief'],
      'roleModelIOSnapshot.inputEnvelope.decisionContext.livingStateBrief'
    );

    livingStateBrief['text'] = 'mood=steady; energy=high; attention=present';

    expectMalformedRawEvent(record);
  });

  it('rejects accepted character-state patch evidence that does not match the parsed tool call', () => {
    const record = mutableRecordFromRawEvent(
      createRoleModelCompletedRawEventWithStatePatch()
    );
    const snapshot = requiredMutableRecord(
      record['characterStatePatchSnapshot'],
      'characterStatePatchSnapshot'
    );
    const result = requiredMutableRecord(
      snapshot['result'],
      'characterStatePatchSnapshot.result'
    );
    const after = requiredMutableRecord(
      result['after'],
      'characterStatePatchSnapshot.result.after'
    );
    const current = requiredMutableRecord(
      after['current'],
      'characterStatePatchSnapshot.result.after.current'
    );

    current['mood'] = 'playful';

    expectMalformedRawEvent(record);
  });

  it('rejects accepted character-state patch decisions without patch evidence', () => {
    const record = mutableRecordFromRawEvent(
      createRoleModelCompletedRawEventWithStatePatch()
    );

    delete record['characterStatePatchSnapshot'];

    expectMalformedRawEvent(record);
  });

  it('rejects accepted character-state patch metadata that does not match the parsed tool call', () => {
    const record = mutableRecordFromRawEvent(
      createRoleModelCompletedRawEventWithStatePatch()
    );
    const snapshot = requiredMutableRecord(
      record['characterStatePatchSnapshot'],
      'characterStatePatchSnapshot'
    );
    const result = requiredMutableRecord(
      snapshot['result'],
      'characterStatePatchSnapshot.result'
    );
    const patch = requiredMutableRecord(
      result['patch'],
      'characterStatePatchSnapshot.result.patch'
    );

    patch['mood'] = 'playful';

    expectMalformedRawEvent(record);
  });

  it('rejects character-state patch snapshots with mismatched session identity', () => {
    const record = mutableRecordFromRawEvent(
      createRoleModelCompletedRawEventWithStatePatch()
    );
    const snapshot = requiredMutableRecord(
      record['characterStatePatchSnapshot'],
      'characterStatePatchSnapshot'
    );

    snapshot['sessionId'] = 'other-session';

    expectMalformedRawEvent(record);
  });

  it('rejects invalid character-state patch commit rejections without patch evidence', () => {
    const record = mutableRecordFromRawEvent(
      createRoleModelRejectedRawEventWithStatePatch()
    );

    delete record['characterStatePatchSnapshot'];

    expectMalformedRawEvent(record);
  });

  it('rejects rejected character-state patch input that does not match the parsed tool call', () => {
    const record = mutableRecordFromRawEvent(
      createRoleModelRejectedRawEventWithStatePatch()
    );
    const snapshot = requiredMutableRecord(
      record['characterStatePatchSnapshot'],
      'characterStatePatchSnapshot'
    );
    const result = requiredMutableRecord(
      snapshot['result'],
      'characterStatePatchSnapshot.result'
    );
    const patchInput = requiredMutableRecord(
      result['patchInput'],
      'characterStatePatchSnapshot.result.patchInput'
    );

    patchInput['mood'] = 'playful';

    expectMalformedRawEvent(record);
  });

  it('rejects rejected character-state patch rejection that does not match the parsed tool call', () => {
    const record = mutableRecordFromRawEvent(
      createRoleModelRejectedRawEventWithStatePatch()
    );
    const snapshot = requiredMutableRecord(
      record['characterStatePatchSnapshot'],
      'characterStatePatchSnapshot'
    );
    const result = requiredMutableRecord(
      snapshot['result'],
      'characterStatePatchSnapshot.result'
    );
    const rejection = requiredMutableRecord(
      result['rejection'],
      'characterStatePatchSnapshot.result.rejection'
    );

    rejection['details'] = 'Different rejected patch details.';

    expectMalformedRawEvent(record);
  });

  it('rejects accepted role-model commit text that does not match the parsed decision', () => {
    const record = mutableRecordFromRawEvent(createRoleModelCompletedRawEvent());
    const commitValidation = requiredMutableRecord(
      record['commitValidation'],
      'commitValidation'
    );
    const result = requiredMutableRecord(
      commitValidation['result'],
      'commitValidation.result'
    );

    result['acceptedVisibleReplyText'] = 'different reply';

    expectMalformedRawEvent(record);
  });

  it('rejects role-model commit validation that contradicts terminal turn status', () => {
    const record = mutableRecordFromRawEvent(createRoleModelCompletedRawEvent());
    const commitValidation = requiredMutableRecord(
      record['commitValidation'],
      'commitValidation'
    );

    commitValidation['result'] = {
      status: 'rejected',
      rejection: createRejectedRoleModelDecisionResult(
        roleModelMalformedOutputRejectionReason,
        'Adapter output must be valid JSON.'
      ).rejection
    };
    record['reason'] = roleModelMalformedOutputRejectionReason;

    expectMalformedRawEvent(record);
  });

  it('rejects parser-owned commit rejections when the parsed decision was accepted', () => {
    const record = mutableRecordFromRawEvent(createRoleModelCompletedRawEvent());

    rewriteRawEventAsRoleModelRejection(
      record,
      roleModelMalformedOutputRejectionReason,
      'Adapter output must be valid JSON.'
    );

    expectMalformedRawEvent(record);
  });

  it('accepts invalid visible-reply commit rejection for parsed text that fails reply validation', () => {
    const record = mutableRecordFromRawEvent(createRoleModelCompletedRawEvent());

    setParsedVisibleReplyText(record, '');
    rewriteRawEventAsRoleModelRejection(
      record,
      roleModelInvalidVisibleReplyRejectionReason,
      'Character agent returned an empty reply.'
    );

    const decoded = decodeRawEventLogRecord(JSON.stringify(record));

    expect(decoded).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected',
      reason: roleModelInvalidVisibleReplyRejectionReason,
      parsedRoleModelDecisionSnapshot: {
        result: {
          status: 'accepted',
          decision: {
            version: 'mvp-006.tool_calls.v1',
            toolCalls: [
              {
                name: roleModelVisibleReplyActionName,
                input: {
                  text: ''
                }
              }
            ]
          }
        }
      },
      commitValidation: {
        result: {
          status: 'rejected',
          rejection: {
            reason: roleModelInvalidVisibleReplyRejectionReason
          }
        }
      }
    });
  });

    it('rejects invalid visible-reply commit rejection when parsed text would commit', () => {
      const record = mutableRecordFromRawEvent(createRoleModelCompletedRawEvent());

    rewriteRawEventAsRoleModelRejection(
      record,
      roleModelInvalidVisibleReplyRejectionReason,
      'Character agent returned an empty reply.'
    );

      expectMalformedRawEvent(record);
    });

  it('accepts capability-tool commit rejection when parsed decision was accepted', () => {
    const record = mutableRecordFromRawEvent(createRoleModelCompletedRawEvent());

    rewriteRawEventAsRoleModelRejection(
      record,
      roleModelCapabilityToolRejectedRejectionReason,
      'memory fixture unavailable'
    );

    const decoded = decodeRawEventLogRecord(JSON.stringify(record));

    expect(decoded).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected',
      reason: roleModelCapabilityToolRejectedRejectionReason,
      parsedRoleModelDecisionSnapshot: {
        result: {
          status: 'accepted'
        }
      },
      commitValidation: {
        result: {
          status: 'rejected',
          rejection: {
            reason: roleModelCapabilityToolRejectedRejectionReason
          }
        }
      }
    });
  });

    it('accepts parser-owned commit rejection when it matches the parsed rejection', () => {
    const record = mutableRecordFromRawEvent(createRoleModelCompletedRawEvent());

    setParsedRoleModelRejection(
      record,
      roleModelMalformedOutputRejectionReason,
      'Adapter output must be valid JSON.',
      'not json'
    );
    rewriteRawEventAsRoleModelRejection(
      record,
      roleModelMalformedOutputRejectionReason,
      'Adapter output must be valid JSON.'
    );

    const decoded = decodeRawEventLogRecord(JSON.stringify(record));

    expect(decoded).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected',
      reason: roleModelMalformedOutputRejectionReason,
      parsedRoleModelDecisionSnapshot: {
        result: {
          status: 'rejected',
          rejection: {
            reason: roleModelMalformedOutputRejectionReason
          }
        }
      },
      commitValidation: {
        result: {
          status: 'rejected',
          rejection: {
            reason: roleModelMalformedOutputRejectionReason
          }
        }
      }
    });
  });

  it('rejects parser-owned commit rejection details that contradict the parsed rejection', () => {
    const record = mutableRecordFromRawEvent(createRoleModelCompletedRawEvent());

    setParsedRoleModelRejection(
      record,
      roleModelMalformedOutputRejectionReason,
      'Adapter output must be valid JSON.',
      'not json'
    );
    rewriteRawEventAsRoleModelRejection(
      record,
      roleModelMalformedOutputRejectionReason,
      'Different parser details.'
    );

    expectMalformedRawEvent(record);
  });

  it('accepts provider-error evidence when rejection details match provider metadata', () => {
    const record = mutableRecordFromRawEvent(createRoleModelCompletedRawEvent());

    setParsedRoleModelRejection(
      record,
      roleModelProviderErrorRejectionReason,
      'Provider request failed.',
      ''
    );
    setRoleModelProviderErrorMetadata(record, 'Provider request failed.');
    rewriteRawEventAsRoleModelRejection(
      record,
      roleModelProviderErrorRejectionReason,
      'Provider request failed.'
    );

    const decoded = decodeRawEventLogRecord(JSON.stringify(record));

    expect(decoded).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected',
      reason: roleModelProviderErrorRejectionReason,
      roleModelIOSnapshot: {
        rawOutputText: '',
        providerMetadata: {
          error: {
            message: 'Provider request failed.'
          }
        }
      },
      parsedRoleModelDecisionSnapshot: {
        result: {
          status: 'rejected',
          rejection: {
            reason: roleModelProviderErrorRejectionReason,
            details: 'Provider request failed.'
          }
        }
      }
    });
  });

  it('accepts sanitized adapter rejection evidence when explicit rejection cannot replay', () => {
    const record = mutableRecordFromRawEvent(createRoleModelCompletedRawEvent());

    setParsedRoleModelRejection(
      record,
      roleModelMalformedOutputRejectionReason,
      roleModelAdapterRejectionNotReplayableDetails,
      ''
    );
    rewriteRawEventAsRoleModelRejection(
      record,
      roleModelMalformedOutputRejectionReason,
      roleModelAdapterRejectionNotReplayableDetails
    );

    const decoded = decodeRawEventLogRecord(JSON.stringify(record));

    expect(decoded).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected',
      reason: roleModelMalformedOutputRejectionReason,
      roleModelIOSnapshot: {
        rawOutputText: ''
      },
      parsedRoleModelDecisionSnapshot: {
        result: {
          status: 'rejected',
          rejection: {
            reason: roleModelMalformedOutputRejectionReason,
            details: roleModelAdapterRejectionNotReplayableDetails
          }
        }
      }
    });
  });

  it('rejects provider-error evidence when rejection details do not match provider metadata', () => {
    const record = mutableRecordFromRawEvent(createRoleModelCompletedRawEvent());

    setParsedRoleModelRejection(
      record,
      roleModelProviderErrorRejectionReason,
      'Different provider details.',
      ''
    );
    setRoleModelProviderErrorMetadata(record, 'Provider request failed.');
    rewriteRawEventAsRoleModelRejection(
      record,
      roleModelProviderErrorRejectionReason,
      'Different provider details.'
    );

    expectMalformedRawEvent(record);
  });

  it('rejects terminal raw events without stored turn status', () => {
    expect(() =>
      decodeRawEventLogRecord(
        JSON.stringify({
          eventId: 'evt_missing_status',
          traceId: 'trace_missing_status',
          createdAt,
          kind: 'runtime_turn_completed',
          eventType: 'USER_MESSAGE'
        })
      )
    ).toThrow(LocalRuntimeStorageContractError);
  });

  it('rejects terminal raw events that contradict visible commit semantics', () => {
    for (const rawEvent of [
      {
        eventId: 'evt_completed_without_messages',
        traceId: 'trace_completed_without_messages',
        createdAt,
        kind: 'runtime_turn_completed',
        eventType: 'USER_MESSAGE',
        status: 'completed'
      },
      {
        eventId: 'evt_completed_with_empty_messages',
        traceId: 'trace_completed_with_empty_messages',
        createdAt,
        kind: 'runtime_turn_completed',
        eventType: 'USER_MESSAGE',
        status: 'completed',
        visibleMessageIds: []
      },
      {
        eventId: 'evt_completed_rejected',
        traceId: 'trace_completed_rejected',
        createdAt,
        kind: 'runtime_turn_completed',
        eventType: 'USER_MESSAGE',
        status: 'rejected',
        visibleMessageIds: ['local-session:message-1', 'local-session:message-2']
      },
      {
        eventId: 'evt_rejected_completed',
        traceId: 'trace_rejected_completed',
        createdAt,
        kind: 'runtime_turn_rejected',
        eventType: 'USER_MESSAGE',
        status: 'completed'
      },
      {
        eventId: 'evt_rejected_with_messages',
        traceId: 'trace_rejected_with_messages',
        createdAt,
        kind: 'runtime_turn_rejected',
        eventType: 'USER_MESSAGE',
        status: 'rejected',
        visibleMessageIds: ['local-session:message-1']
      },
      {
        eventId: 'evt_rejected_with_empty_messages',
        traceId: 'trace_rejected_with_empty_messages',
        createdAt,
        kind: 'runtime_turn_rejected',
        eventType: 'USER_MESSAGE',
        status: 'rejected',
        visibleMessageIds: []
      }
    ]) {
      expect(() => decodeRawEventLogRecord(JSON.stringify(rawEvent))).toThrow(
        LocalRuntimeStorageContractError
      );
    }
  });

  it('rejects stored visible message text that is not already normalized', () => {
    for (const text of [' hello ', 'line one\nline two']) {
      expect(() =>
        decodeConversationLogRecord(
          JSON.stringify({
            eventId: 'evt_001',
            traceId: 'trace_001',
            createdAt,
            id: 'local-session:message-1',
            role: 'user',
            speakerId: 'local-user',
            speakerName: 'You',
            text,
            committedAt: '2026-06-04T00:00:01.000Z'
          })
        )
      ).toThrow(LocalRuntimeStorageContractError);
    }
  });

  it('rejects malformed stored records without silently skipping them', () => {
    expect(() => decodeRuntimeTraceEntry('{not json')).toThrow(
      LocalRuntimeStorageContractError
    );
    expect(() =>
      decodeRawEventLogRecord(
        JSON.stringify({
          eventId: 'evt_001',
          traceId: 'trace_001',
          createdAt,
          kind: 'runtime_turn_completed',
          eventType: 'UNKNOWN'
        })
      )
    ).toThrow(LocalRuntimeStorageContractError);
    expect(() =>
      decodeConversationLogRecord(
        JSON.stringify({
          eventId: 'evt_001',
          traceId: 'trace_001',
          createdAt,
          id: 'local-session:message-1',
          role: 'system',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'hello',
          committedAt: '2026-06-04T00:00:01.000Z'
        })
      )
    ).toThrow(LocalRuntimeStorageContractError);
  });
});

function createCapabilityTurnEvidence(
  identity: RuntimeEventIdentity
): AgentCapabilityTurnEvidenceSnapshot {
  return createAgentCapabilityTurnEvidenceSnapshot({
    ...identity,
    kind: 'agent_capability_turn_evidence_snapshot',
    contractVersion: agentCapabilityContractVersion,
    capabilities: [
      {
        capabilityId: 'memory.fixture',
        manifest: createCapabilityManifestFixture(),
        providedTools: [
          {
            name: 'memory.search',
            description: 'Search memory.',
            requiredForUserTurn: false,
            maxCallsPerUserTurn: 1,
            inputContract: {
              type: 'object',
              additionalFields: false,
              fields: [
                {
                  name: 'query',
                  description: 'Search query.',
                  required: true
                }
              ]
            },
            validationOwner: 'capability_host',
            sideEffectLevel: 'runtime_read',
            requiresConfirmation: false,
            sourceReferencesRequired: true
          }
        ],
        registeredLifecycleHooks: [
          'before_role_model_call',
          'handle_tool_call',
          'after_turn_committed',
          'health'
        ],
        installed: true,
        registered: true,
        enabled: true,
        availableForTurn: false,
        redactionLabels: ['secret'],
        configFingerprint: 'gateway_api_key=plain-secret',
        healthStatus: 'degraded'
      }
    ],
    contextItems: [
      {
        capabilityId: 'memory.fixture',
        id: 'memory.item_1',
        kind: 'memory',
        text: 'Recovered endpoint token=secret-token',
        budget: {
          estimatedTokens: 12,
          priority: 1
        },
        sourceReferences: [
          {
            kind: 'memory',
            id: 'mem_1',
            title: 'token=secret-token',
            uri: 'https://user:plain-secret@memory.local/item?api_key=secret-token'
          }
        ],
        confidence: 0.8,
        redactionLabels: ['memory']
      }
    ],
    evidence: [
      createCapabilityEvidence(identity, {
        evidenceKind: 'before_role_model_call',
        status: 'rejected',
        policyOutcome: 'required_rejected',
        summary: 'Required recall rejected with Bearer secret-token'
      }),
      createCapabilityEvidence(identity, {
        evidenceKind: 'before_role_model_call',
        status: 'degraded',
        policyOutcome: 'optional_degraded',
        summary: 'Optional recall degraded'
      }),
      createCapabilityEvidence(identity, {
        evidenceKind: 'tool_invocation',
        status: 'rejected',
        policyOutcome: 'disallowed_tool_call',
        summary: 'Tool was not allowed'
      }),
      createCapabilityEvidence(identity, {
        evidenceKind: 'tool_invocation',
        status: 'rejected',
        policyOutcome: 'handler_rejected',
        summary: 'Handler rejected query'
      }),
      createCapabilityEvidence(identity, {
        evidenceKind: 'tool_invocation',
        status: 'failed',
        policyOutcome: 'timeout',
        summary: 'Timed out after 1000ms'
      }),
      createCapabilityEvidence(identity, {
        evidenceKind: 'health',
        status: 'degraded',
        policyOutcome: 'health_degraded',
        summary: 'Health degraded'
      }),
      createCapabilityEvidence(identity, {
        evidenceKind: 'after_turn_committed',
        status: 'failed',
        policyOutcome: 'after_commit_failed',
        summary: 'Capture failed'
      })
    ],
    health: [
      {
        capabilityId: 'memory.fixture',
        status: 'degraded',
        checkedAt: createdAt,
        summary: 'gateway token=secret-token degraded',
        redactionLabels: ['secret']
      }
    ]
  });
}

function createCapabilityEvidence(
  identity: RuntimeEventIdentity,
  options: {
    readonly evidenceKind:
      | 'before_role_model_call'
      | 'tool_invocation'
      | 'after_turn_committed'
      | 'health';
    readonly status: 'rejected' | 'degraded' | 'failed';
    readonly policyOutcome:
      | 'required_rejected'
      | 'optional_degraded'
      | 'disallowed_tool_call'
      | 'handler_rejected'
      | 'timeout'
      | 'health_degraded'
      | 'after_commit_failed';
    readonly summary: string;
  }
): AgentCapabilityTurnEvidenceSnapshot['evidence'][number] {
  return {
    ...identity,
    kind: 'agent_capability_evidence_snapshot',
    capabilityId: 'memory.fixture',
    evidenceKind: options.evidenceKind,
    status: options.status,
    summary: options.summary,
    policyOutcome: options.policyOutcome,
    redactionLabels: ['secret']
  };
}

function createCapabilityManifestFixture(): AgentCapabilityTurnEvidenceSnapshot['capabilities'][number]['manifest'] {
  return {
    id: 'memory.fixture',
    displayName: 'Fixture memory',
    version: '1.0.0',
    kind: 'memory_provider',
    description: 'Fixture memory provider.',
    contractVersion: agentCapabilityContractVersion,
    compatibility: {
      hostContractVersions: [agentCapabilityContractVersion],
      sourceSystem: 'project02'
    },
    declaredCapabilities: [
      'context_provider',
      'before_role_model_call',
      'tool_provider',
      'handle_tool_call',
      'after_turn_committed',
      'health'
    ],
    config: {
      fields: [
        {
          name: 'gateway_api_key',
          description: 'Gateway API key.',
          required: true,
          secret: true,
          redactionLabels: ['secret']
        }
      ],
      fingerprint: 'gateway_api_key=plain-secret'
    },
    localTrustLevel: 'test_fixture',
    runtimePolicy: {
      requiredForTurn: true,
      sideEffectLevel: 'local_memory_write',
      confirmation: 'not_required',
      timeoutMs: 1000,
      sourceReferencesRequired: true,
      redactionLabels: ['secret'],
      failureBehavior: {
        beforeRoleModelCall: 'reject_turn',
        handleToolCall: 'degrade',
        afterTurnCommitted: 'log_failure',
        health: 'degrade'
      }
    },
    activation: {
      defaultEnabled: true,
      reasons: ['storage_test']
    }
  };
}

function createRoleModelCompletedRawEvent(): RawEventLogRecord {
  const identity = createRuntimeEventIdentity({
    eventId: 'evt_role_model_storage',
    traceId: 'trace_role_model_storage',
    createdAt
  });
  const event = createUserMessageRuntimeEvent('hello', identity);
  const decisionContext = createDecisionContext({
    sessionId: 'local-session',
    characterSnapshot: {
      id: 'mira',
      displayName: 'Mira'
    },
    livingStateBrief: createLivingStateBrief(createDefaultCharacterRuntimeState())
  });
  const inputEnvelope = createRoleModelInputEnvelope({
    event,
    decisionContext
  });
  const decision = createVisibleReplyCharacterDecision('hello back');
  const accepted = createAcceptedRoleModelDecisionResult(decision);

  return Object.freeze({
    ...identity,
    kind: 'runtime_turn_completed',
    eventType: 'USER_MESSAGE',
    status: 'completed',
    visibleMessageIds: ['local-session:message-1', 'local-session:message-2'],
    payloadSummary: {
      normalizedCurrentUserMessage: 'hello'
    },
    roleModelIOSnapshot: createRoleModelIOSnapshot({
      ...identity,
      sessionId: 'local-session',
      inputEnvelope,
      rawOutputText: JSON.stringify(decision)
    }),
    parsedRoleModelDecisionSnapshot: createParsedRoleModelDecisionSnapshot({
      ...identity,
      sessionId: 'local-session',
      result: accepted
    }),
    commitValidation: createRoleModelCommitValidationSnapshot({
      ...identity,
      sessionId: 'local-session',
      result: {
        status: 'accepted',
        acceptedVisibleReplyText: 'hello back'
      }
    })
  } satisfies RawEventLogRecord);
}

function createRoleModelCompletedRawEventWithStatePatch(): RawEventLogRecord {
  const identity = createRuntimeEventIdentity({
    eventId: 'evt_role_model_storage_state_patch',
    traceId: 'trace_role_model_storage_state_patch',
    createdAt
  });
  const event = createUserMessageRuntimeEvent('hello', identity);
  const decisionContext = createDecisionContext({
    sessionId: 'local-session',
    characterSnapshot: {
      id: 'mira',
      displayName: 'Mira'
    },
    livingStateBrief: createLivingStateBrief(createDefaultCharacterRuntimeState())
  });
  const inputEnvelope = createRoleModelInputEnvelope({
    event,
    decisionContext
  });
  const rawOutputText = JSON.stringify({
    version: roleModelDecisionContractVersion,
    toolCalls: [
      {
        name: roleModelVisibleReplyActionName,
        input: {
          text: 'hello back'
        }
      },
      {
        name: 'character_state.patch',
        input: {
          mood: 'curious'
        }
      }
    ]
  });
  const accepted = parseRoleModelDecision(rawOutputText);
  const statePatchPlan = planCharacterStatePatch({
    before: createDefaultCharacterRuntimeState(),
    patchInput: {
      mood: 'curious'
    }
  });

  if (accepted.status !== 'accepted' || statePatchPlan.status !== 'accepted') {
    throw new Error('Expected accepted state-patch fixture.');
  }

  return Object.freeze({
    ...identity,
    kind: 'runtime_turn_completed',
    eventType: 'USER_MESSAGE',
    status: 'completed',
    visibleMessageIds: ['local-session:message-1', 'local-session:message-2'],
    payloadSummary: {
      normalizedCurrentUserMessage: 'hello'
    },
    roleModelIOSnapshot: createRoleModelIOSnapshot({
      ...identity,
      sessionId: 'local-session',
      inputEnvelope,
      rawOutputText
    }),
    parsedRoleModelDecisionSnapshot: createParsedRoleModelDecisionSnapshot({
      ...identity,
      sessionId: 'local-session',
      result: accepted
    }),
    commitValidation: createRoleModelCommitValidationSnapshot({
      ...identity,
      sessionId: 'local-session',
      result: {
        status: 'accepted',
        acceptedVisibleReplyText: 'hello back'
      }
    }),
    characterStatePatchSnapshot: createCharacterStatePatchSnapshot({
      ...identity,
      sessionId: 'local-session',
      result: statePatchPlan
    })
  } satisfies RawEventLogRecord);
}

function createRoleModelRejectedRawEventWithStatePatch(): RawEventLogRecord {
  const identity = createRuntimeEventIdentity({
    eventId: 'evt_role_model_storage_state_patch_rejected',
    traceId: 'trace_role_model_storage_state_patch_rejected',
    createdAt
  });
  const event = createUserMessageRuntimeEvent('hello', identity);
  const decisionContext = createDecisionContext({
    sessionId: 'local-session',
    characterSnapshot: {
      id: 'mira',
      displayName: 'Mira'
    },
    livingStateBrief: createLivingStateBrief(createDefaultCharacterRuntimeState())
  });
  const inputEnvelope = createRoleModelInputEnvelope({
    event,
    decisionContext
  });
  const rawOutputText = JSON.stringify({
    version: roleModelDecisionContractVersion,
    toolCalls: [
      {
        name: roleModelVisibleReplyActionName,
        input: {
          text: 'hello back'
        }
      },
      {
        name: 'character_state.patch',
        input: {
          mood: 'ecstatic'
        }
      }
    ]
  });
  const accepted = parseRoleModelDecision(rawOutputText);
  const statePatchPlan = planCharacterStatePatch({
    before: createDefaultCharacterRuntimeState(),
    patchInput: {
      mood: 'ecstatic'
    }
  });

  if (accepted.status !== 'accepted' || statePatchPlan.status !== 'rejected') {
    throw new Error('Expected rejected state-patch fixture.');
  }

  return Object.freeze({
    ...identity,
    kind: 'runtime_turn_rejected',
    eventType: 'USER_MESSAGE',
    status: 'rejected',
    reason: roleModelInvalidCharacterStatePatchRejectionReason,
    payloadSummary: {
      normalizedCurrentUserMessage: 'hello'
    },
    roleModelIOSnapshot: createRoleModelIOSnapshot({
      ...identity,
      sessionId: 'local-session',
      inputEnvelope,
      rawOutputText
    }),
    parsedRoleModelDecisionSnapshot: createParsedRoleModelDecisionSnapshot({
      ...identity,
      sessionId: 'local-session',
      result: accepted
    }),
    commitValidation: createRoleModelCommitValidationSnapshot({
      ...identity,
      sessionId: 'local-session',
      result: {
        status: 'rejected',
        rejection: createRejectedRoleModelDecisionResult(
          roleModelInvalidCharacterStatePatchRejectionReason,
          statePatchPlan.rejection.details
        ).rejection
      }
    }),
    characterStatePatchSnapshot: createCharacterStatePatchSnapshot({
      ...identity,
      sessionId: 'local-session',
      result: statePatchPlan
    })
  } satisfies RawEventLogRecord);
}

function createRoleModelDisallowedToolRejectedRawEvent(): RawEventLogRecord {
  const identity = createRuntimeEventIdentity({
    eventId: 'evt_role_model_storage_disallowed_tool',
    traceId: 'trace_role_model_storage_disallowed_tool',
    createdAt
  });
  const event = createUserMessageRuntimeEvent('hello', identity);
  const decisionContext = createDecisionContext({
    sessionId: 'local-session',
    characterSnapshot: {
      id: 'mira',
      displayName: 'Mira'
    },
    livingStateBrief: createLivingStateBrief(createDefaultCharacterRuntimeState())
  });
  const inputEnvelope = createRoleModelInputEnvelope({
    event,
    decisionContext,
    allowedTools: [roleModelVisibleReplyActionName]
  });
  const rawOutputText = JSON.stringify({
    version: roleModelDecisionContractVersion,
    toolCalls: [
      {
        name: roleModelVisibleReplyActionName,
        input: {
          text: 'hello back'
        }
      },
      {
        name: 'character_state.patch',
        input: {
          mood: 'curious'
        }
      }
    ]
  });
  const rejected = parseRoleModelDecision(rawOutputText, [
    roleModelVisibleReplyActionName
  ]);

  if (
    rejected.status !== 'rejected' ||
    rejected.rejection.reason !== roleModelDisallowedToolRejectionReason
  ) {
    throw new Error('Expected disallowed tool fixture.');
  }

  return Object.freeze({
    ...identity,
    kind: 'runtime_turn_rejected',
    eventType: 'USER_MESSAGE',
    status: 'rejected',
    reason: roleModelDisallowedToolRejectionReason,
    payloadSummary: {
      normalizedCurrentUserMessage: 'hello'
    },
    roleModelIOSnapshot: createRoleModelIOSnapshot({
      ...identity,
      sessionId: 'local-session',
      inputEnvelope,
      rawOutputText
    }),
    parsedRoleModelDecisionSnapshot: createParsedRoleModelDecisionSnapshot({
      ...identity,
      sessionId: 'local-session',
      result: rejected
    }),
    commitValidation: createRoleModelCommitValidationSnapshot({
      ...identity,
      sessionId: 'local-session',
      result: {
        status: 'rejected',
        rejection: rejected.rejection
      }
    })
  } satisfies RawEventLogRecord);
}

function rewriteRawEventAsRoleModelRejection(
  record: Record<string, unknown>,
  reason: RoleModelDecisionRejectionReason,
  details: string
): void {
  record['kind'] = 'runtime_turn_rejected';
  record['status'] = 'rejected';
  record['reason'] = reason;
  delete record['visibleMessageIds'];

  const commitValidation = requiredMutableRecord(
    record['commitValidation'],
    'commitValidation'
  );

  commitValidation['result'] = {
    status: 'rejected',
    rejection: createRejectedRoleModelDecisionResult(
      reason,
      details
    ).rejection
  };
}

function setParsedVisibleReplyText(
  record: Record<string, unknown>,
  text: string
): void {
  const parsedRoleModelDecisionSnapshot = requiredMutableRecord(
    record['parsedRoleModelDecisionSnapshot'],
    'parsedRoleModelDecisionSnapshot'
  );
  const result = requiredMutableRecord(
    parsedRoleModelDecisionSnapshot['result'],
    'parsedRoleModelDecisionSnapshot.result'
  );
  const decision = requiredMutableRecord(
    result['decision'],
    'parsedRoleModelDecisionSnapshot.result.decision'
  );
  const toolCalls = decision['toolCalls'];

  if (!Array.isArray(toolCalls)) {
    throw new Error(
      'Expected mutable array for parsedRoleModelDecisionSnapshot.result.decision.toolCalls.'
    );
  }

  const visibleReplyToolCall = requiredMutableRecord(
    toolCalls[0],
    'parsedRoleModelDecisionSnapshot.result.decision.toolCalls[0]'
  );
  const input = requiredMutableRecord(
    visibleReplyToolCall['input'],
    'parsedRoleModelDecisionSnapshot.result.decision.toolCalls[0].input'
  );

  input['text'] = text;
  setRoleModelRawOutputText(record, JSON.stringify({
    version: 'mvp-006.tool_calls.v1',
    toolCalls: [
      {
        name: roleModelVisibleReplyActionName,
        input: {
          text
        }
      }
    ]
  }));
}

function setParsedRoleModelRejection(
  record: Record<string, unknown>,
  reason: RoleModelDecisionRejectionReason,
  details: string,
  rawOutputText: string
): void {
  const parsedRoleModelDecisionSnapshot = requiredMutableRecord(
    record['parsedRoleModelDecisionSnapshot'],
    'parsedRoleModelDecisionSnapshot'
  );

  parsedRoleModelDecisionSnapshot['result'] =
    createRejectedRoleModelDecisionResult(reason, details);
  setRoleModelRawOutputText(record, rawOutputText);
}

function setRoleModelRawOutputText(
  record: Record<string, unknown>,
  rawOutputText: string
): void {
  const roleModelIOSnapshot = requiredMutableRecord(
    record['roleModelIOSnapshot'],
    'roleModelIOSnapshot'
  );

  roleModelIOSnapshot['rawOutputText'] = rawOutputText;
}

function setRoleModelProviderErrorMetadata(
  record: Record<string, unknown>,
  message: string
): void {
  const roleModelIOSnapshot = requiredMutableRecord(
    record['roleModelIOSnapshot'],
    'roleModelIOSnapshot'
  );

  roleModelIOSnapshot['providerMetadata'] = {
    provider: 'nvidia',
    model: 'nvidia/test-model',
    request: {
      endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
      stream: false
    },
    error: {
      code: 'provider_error',
      message
    }
  };
}

function mutableRecordFromRawEvent(
  rawEvent: RawEventLogRecord
): Record<string, unknown> {
  const parsed: unknown = JSON.parse(JSON.stringify(rawEvent));

  return requiredMutableRecord(parsed, 'rawEvent');
}

function requiredMutableRecord(
  value: unknown,
  field: string
): Record<string, unknown> {
  if (isMutableRecord(value)) {
    return value;
  }

  throw new Error(`Expected mutable record for ${field}.`);
}

function isMutableRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectMalformedRawEvent(record: Record<string, unknown>): void {
  expect(() => decodeRawEventLogRecord(JSON.stringify(record))).toThrow(
    LocalRuntimeStorageContractError
  );
}
