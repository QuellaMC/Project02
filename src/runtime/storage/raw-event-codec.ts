import type { CharacterProfile, VisibleMessage } from '../../core/conversation.ts';
import {
  normalizeVisibleMessageText,
  VisibleMessageTextValidationError
} from '../../core/message-validation.ts';
import {
  runtimeEventTypeValues,
  type RuntimeEventIdentity,
  type RuntimeEventType,
  type UserMessageRuntimeEvent
} from '../event.ts';
import {
  createAcceptedRoleModelDecisionResult,
  createDefaultRoleModelPluginToolDefinitions,
  createDecisionContext,
  createParsedRoleModelDecisionSnapshot,
  createRejectedRoleModelDecisionResult,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot,
  createRoleModelToolObservation,
  getRequiredVisibleReplyText,
  getVisibleReplyToolCall,
  hasDuplicateRoleModelAllowedTools,
  isRoleModelAllowedToolName,
  isRoleModelRawOutputReplayableDecisionEvidence,
  normalizeReplayableRejectedRoleModelDecisionResult,
  parseRoleModelProviderExchangeSnapshot,
  roleModelPluginToolRejectedRejectionReason,
  roleModelCommitValidationFailureRejectionReason,
  roleModelDecisionContractVersion,
  roleModelDecisionRejectionReasons,
  roleModelInvalidVisibleReplyRejectionReason,
  type CharacterDecision,
  type DecisionContext,
  type ParsedRoleModelDecisionSnapshot,
  type RoleModelPluginToolDefinition,
  type RoleModelAllowedToolName,
  type RoleModelDecisionRejection,
  type RoleModelDecisionRejectionReason,
  type RoleModelDecisionResult,
  type RoleModelInputEnvelope,
  type RoleModelIOSnapshot,
  type RoleModelOutputContract,
  type RoleModelProviderExchangeSnapshot,
  type RoleModelProviderMetadata,
  type RoleModelToolObservation
} from '../../role-model/contracts.ts';
import {
  createVisibleReplyModelToolCall,
  visibleReplyModelToolName,
  type PluginModelToolCall,
  type ModelToolCall
} from '../../role-model/model-tools.ts';
import {
  characterStatePatchModelToolName
} from '../../plugins/packages/character-state/contract.ts';
import {
  createRuntimePluginContextItem,
  createRuntimePluginEvidenceSnapshot,
  createRuntimePluginProvidedTool,
  createRuntimePluginTurnEvidenceSnapshot,
  type RuntimePluginContextItem,
  type RuntimePluginEvidenceSnapshot,
  type RuntimePluginJsonObject,
  type RuntimePluginJsonValue,
  type RuntimePluginSourceReference,
  type RuntimePluginToolCallResult,
  type RuntimePluginTurnEvidenceSnapshot
} from '../../plugins/validation.ts';
import {
  runtimePluginEvidenceKindValues,
  runtimePluginEvidenceStatusValues,
  runtimePluginPolicyOutcomeValues,
  runtimePluginSourceKindValues,
  type RuntimePluginEvidenceKind,
  type RuntimePluginEvidenceStatus,
  type RuntimePluginPolicyOutcome,
  type RuntimePluginSourceKind
} from '../../plugins/contract.ts';
import {
  createRoleModelCommitValidationSnapshot,
  isTerminalRawEventLogRecordKind,
  rawEventLogRecordKindValues,
  runtimeTurnStatusValues,
  type AcceptedRoleModelCommitValidationResult,
  type RawEventLogPayloadSummary,
  type RawEventLogRecord,
  type RawEventLogRecordKind,
  type RejectedRoleModelCommitValidationResult,
  type RoleModelCommitValidationResult,
  type RoleModelCommitValidationSnapshot,
  type RuntimeTurnStatus
} from '../log.ts';
import {
  isOneOf,
  requiredNormalizedVisibleMessageText,
  requiredVisibleMessageRole,
  throwMalformedRecord
} from './codec-primitives.ts';
import {
  LocalRuntimeStorageContractError,
  isRecord,
  parseJsonObject,
  requiredNonEmptyString,
  requiredRecordCanonicalTimestamp,
  requiredRecordString,
  type LocalRuntimeStorageContractErrorCode
} from './layout-contract.ts';

const commitOwnedRoleModelRejectionReasons = [
  roleModelInvalidVisibleReplyRejectionReason,
  roleModelPluginToolRejectedRejectionReason,
  roleModelCommitValidationFailureRejectionReason
] as const satisfies readonly RoleModelDecisionRejectionReason[];

const legacySchema1CharacterStatePatchPluginToolDefinition = Object.freeze({
  pluginId: 'character-state',
  name: characterStatePatchModelToolName,
  description:
    'Legacy schema 1 compatibility definition for persisted character_state.patch evidence.',
  requiredForUserTurn: false,
  callLimit: {
    scope: 'user_turn',
    maxCalls: 1
  },
  inputContract: {
    type: 'object',
    fields: [],
    additionalFields: true
  },
  validationOwner: 'plugin_host',
  sideEffectLevel: 'local_memory_write',
  requiresConfirmation: false,
  sourceReferencesRequired: false
} satisfies RoleModelPluginToolDefinition);

export function encodeRawEventLogRecord(record: RawEventLogRecord): string {
  return JSON.stringify(record);
}

export function decodeRawEventLogRecord(line: string): RawEventLogRecord {
  const record = parseJsonObject(line, 'malformed_record');
  const eventId = requiredRecordString(record, 'eventId', 'malformed_record');
  const traceId = requiredRecordString(record, 'traceId', 'malformed_record');
  const createdAt = requiredRecordCanonicalTimestamp(
    record,
    'createdAt',
    'malformed_record'
  );
  const kind = requiredRawEventKind(record['kind']);
  const eventType = requiredRuntimeEventType(record['eventType']);
  const status = optionalRuntimeTurnStatus(record['status']);
  const reason = optionalRecordString(record, 'reason', 'malformed_record');
  const visibleMessageIds = optionalStringArray(record['visibleMessageIds'], 'visibleMessageIds');
  const toolCallIds = optionalStringArray(record['toolCallIds'], 'toolCallIds');
  const toolCallId = optionalRecordString(record, 'toolCallId', 'malformed_record');
  const dispatchedToHost = optionalRecordBoolean(
    record,
    'dispatchedToHost'
  );
  const toolRound = optionalRecordNumber(record, 'toolRound');
  const toolName = optionalRecordString(record, 'toolName', 'malformed_record');
  const toolPluginId = optionalRecordString(record, 'toolPluginId', 'malformed_record');
  const toolInput = optionalRuntimePluginJsonObject(record['toolInput']);
  const toolResult = optionalRuntimePluginToolCallResult(record['toolResult']);
  const pluginStoreRevision = optionalRecordNumber(
    record,
    'pluginStoreRevision'
  );
  const payloadSummary = optionalRawEventPayloadSummary(record['payloadSummary']);
  const roleModelIOSnapshot = optionalRoleModelIOSnapshot(
    record['roleModelIOSnapshot']
  );
  const decodedParsedRoleModelDecisionSnapshot =
    optionalParsedRoleModelDecisionSnapshot(
      record['parsedRoleModelDecisionSnapshot']
    );
  const parsedRoleModelDecisionSnapshot =
    normalizeLegacyRejectedDecisionRequestedToolNames({
      roleModelIOSnapshot,
      parsedRoleModelDecisionSnapshot:
        decodedParsedRoleModelDecisionSnapshot
    });
  const commitValidation = optionalRoleModelCommitValidationSnapshot(
    record['commitValidation']
  );
  const runtimePluginEvidence = optionalRuntimePluginEvidenceSnapshots(
    record['runtimePluginEvidence']
  );
  const runtimePluginTurnEvidence = optionalRuntimePluginTurnEvidenceSnapshot(
    record['runtimePluginTurnEvidence']
  );

  assertTerminalRawEventSemantics({
    kind,
    status,
    visibleMessageIds
  });
  assertToolRawEventSemantics({
    kind,
    toolCallId,
    dispatchedToHost,
    toolRound,
    toolName,
    toolPluginId,
    toolInput,
    toolResult
  });
  assertRoleModelRawEventEvidenceSemantics({
    identity: {
      eventId,
      traceId,
      createdAt
    },
    payloadSummary,
    kind,
    reason,
    status,
    roleModelIOSnapshot,
    parsedRoleModelDecisionSnapshot,
    commitValidation
  });
  assertRuntimePluginEvidenceSemantics({
    identity: {
      eventId,
      traceId,
      createdAt
    },
    runtimePluginEvidence,
    runtimePluginTurnEvidence
  });

  return Object.freeze({
    eventId,
    traceId,
    createdAt,
    kind,
    eventType,
    ...(status === undefined ? {} : { status }),
    ...(reason === undefined ? {} : { reason }),
    ...(visibleMessageIds === undefined ? {} : { visibleMessageIds }),
    ...(toolCallIds === undefined ? {} : { toolCallIds }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...(dispatchedToHost === undefined ? {} : { dispatchedToHost }),
    ...(toolRound === undefined ? {} : { toolRound }),
    ...(toolName === undefined ? {} : { toolName }),
    ...(toolPluginId === undefined ? {} : { toolPluginId }),
    ...(toolInput === undefined ? {} : { toolInput }),
    ...(toolResult === undefined ? {} : { toolResult }),
    ...(pluginStoreRevision === undefined ? {} : { pluginStoreRevision }),
    ...(payloadSummary === undefined ? {} : { payloadSummary }),
    ...(roleModelIOSnapshot === undefined ? {} : { roleModelIOSnapshot }),
    ...(parsedRoleModelDecisionSnapshot === undefined
      ? {}
      : { parsedRoleModelDecisionSnapshot }),
    ...(commitValidation === undefined ? {} : { commitValidation }),
    ...(runtimePluginEvidence === undefined
      ? {}
      : { runtimePluginEvidence }),
    ...(runtimePluginTurnEvidence === undefined
      ? {}
      : { runtimePluginTurnEvidence })
  } satisfies RawEventLogRecord);
}

function optionalRecordString(
  record: Record<string, unknown>,
  key: string,
  code: LocalRuntimeStorageContractErrorCode
): string | undefined {
  const value = record[key];

  if (value === undefined) {
    return undefined;
  }

  return requiredNonEmptyString(value, key, code);
}

function requiredRecordStringAllowingEmpty(
  record: Record<string, unknown>,
  key: string,
  code: LocalRuntimeStorageContractErrorCode
): string {
  const value = record[key];

  if (typeof value !== 'string') {
    throw new LocalRuntimeStorageContractError(
      code,
      `Stored local runtime field "${key}" must be a string.`
    );
  }

  return value;
}

function optionalRecordStringAllowingEmpty(
  record: Record<string, unknown>,
  key: string,
  code: LocalRuntimeStorageContractErrorCode
): string | undefined {
  const value = record[key];

  if (value === undefined) {
    return undefined;
  }

  return requiredRecordStringAllowingEmpty(record, key, code);
}

function requiredRecordNumber(
  record: Record<string, unknown>,
  key: string,
  code: LocalRuntimeStorageContractErrorCode
): number {
  const value = record[key];

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new LocalRuntimeStorageContractError(
      code,
      `Stored local runtime field "${key}" must be a positive integer.`
    );
  }

  return value;
}

function optionalRecordNumber(
  record: Record<string, unknown>,
  key: string
): number | undefined {
  const value = record[key];

  if (value === undefined) {
    return undefined;
  }

  return requiredRecordNumber(record, key, 'malformed_record');
}

function optionalRecordBoolean(
  record: Record<string, unknown>,
  key: string
): boolean | undefined {
  const value = record[key];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throwMalformedRecord(key);
  }

  return value;
}

function requiredRawEventKind(value: unknown): RawEventLogRecordKind {
  if (isOneOf(value, rawEventLogRecordKindValues)) {
    return value;
  }

  throwMalformedRecord('kind');
}

function requiredRuntimeEventType(value: unknown): RuntimeEventType {
  if (isOneOf(value, runtimeEventTypeValues)) {
    return value;
  }

  throwMalformedRecord('eventType');
}

function optionalRuntimeTurnStatus(value: unknown): RuntimeTurnStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (isOneOf(value, runtimeTurnStatusValues)) {
    return value;
  }

  throwMalformedRecord('status');
}

function requiredRuntimePluginEvidenceKind(
  value: unknown
): RuntimePluginEvidenceKind {
  if (isOneOf(value, runtimePluginEvidenceKindValues)) {
    return value;
  }

  throwMalformedRecord('runtimePluginEvidence.evidenceKind');
}

function requiredRuntimePluginEvidenceStatus(
  value: unknown
): RuntimePluginEvidenceStatus {
  if (isOneOf(value, runtimePluginEvidenceStatusValues)) {
    return value;
  }

  throwMalformedRecord('runtimePluginEvidence.status');
}

function optionalRuntimePluginPolicyOutcome(
  value: unknown
): RuntimePluginPolicyOutcome | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (isOneOf(value, runtimePluginPolicyOutcomeValues)) {
    return value;
  }

  throwMalformedRecord('runtimePluginEvidence.policyOutcome');
}

function requiredRuntimePluginSourceKind(
  value: unknown
): RuntimePluginSourceKind {
  if (isOneOf(value, runtimePluginSourceKindValues)) {
    return value;
  }

  throwMalformedRecord('runtimePluginEvidence.sourceReferences.kind');
}

function assertTerminalRawEventSemantics(options: {
  readonly kind: RawEventLogRecordKind;
  readonly status: RuntimeTurnStatus | undefined;
  readonly visibleMessageIds: readonly string[] | undefined;
}): void {
  if (!isTerminalRawEventLogRecordKind(options.kind)) {
    return;
  }

  if (options.visibleMessageIds !== undefined && options.visibleMessageIds.length === 0) {
    throwMalformedRecord('visibleMessageIds');
  }

  if (options.kind === 'runtime_turn_completed') {
    if (
      options.status !== 'completed' &&
      options.status !== 'completed_with_failures'
    ) {
      throwMalformedRecord('status');
    }

    return;
  }

  if (options.status !== 'rejected') {
    throwMalformedRecord('status');
  }
}

function assertToolRawEventSemantics(options: {
  readonly kind: RawEventLogRecordKind;
  readonly toolCallId: string | undefined;
  readonly dispatchedToHost: boolean | undefined;
  readonly toolRound: number | undefined;
  readonly toolName: string | undefined;
  readonly toolPluginId: string | undefined;
  readonly toolInput: RuntimePluginJsonObject | undefined;
  readonly toolResult: RuntimePluginToolCallResult | undefined;
}): void {
  if (options.kind !== 'tool_call_started' && options.kind !== 'tool_call_finished') {
    if (
      options.toolCallId !== undefined ||
      options.dispatchedToHost !== undefined ||
      options.toolRound !== undefined ||
      options.toolName !== undefined ||
      options.toolPluginId !== undefined ||
      options.toolInput !== undefined ||
      options.toolResult !== undefined
    ) {
      throwMalformedRecord('toolCallId');
    }

    return;
  }

  if (
    options.toolCallId === undefined ||
    options.toolRound === undefined ||
    options.toolName === undefined ||
    options.toolPluginId === undefined
  ) {
    throwMalformedRecord('toolCallId');
  }

  if (options.kind === 'tool_call_started') {
    if (options.dispatchedToHost !== undefined) {
      throwMalformedRecord('dispatchedToHost');
    }

    if (options.toolInput === undefined || options.toolResult !== undefined) {
      throwMalformedRecord('toolInput');
    }

    return;
  }

  if (options.toolResult === undefined || options.toolInput !== undefined) {
    throwMalformedRecord('toolResult');
  }
}

function optionalStringArray(value: unknown, key: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throwMalformedRecord(key);
  }

  const strings: string[] = [];
  const items = value as readonly unknown[];

  for (const item of items) {
    if (typeof item !== 'string') {
      throwMalformedRecord(key);
    }

    strings.push(item);
  }

  return Object.freeze(strings);
}

function optionalRawEventPayloadSummary(
  value: unknown
): RawEventLogPayloadSummary | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throwMalformedRecord('payloadSummary');
  }

  const rawInput = optionalPayloadSummaryString(value, 'rawInput');
  const normalizedCurrentUserMessage = optionalPayloadSummaryString(
    value,
    'normalizedCurrentUserMessage'
  );

  return Object.freeze({
    ...(rawInput === undefined ? {} : { rawInput }),
    ...(normalizedCurrentUserMessage === undefined
      ? {}
      : { normalizedCurrentUserMessage })
  } satisfies RawEventLogPayloadSummary);
}

function optionalRoleModelIOSnapshot(
  value: unknown
): RoleModelIOSnapshot | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throwMalformedRecord('roleModelIOSnapshot');
  }

  requiredLiteralString(
    value,
    'kind',
    'role_model_io_snapshot',
    'roleModelIOSnapshot.kind'
  );

  return createRoleModelIOSnapshot({
    eventId: requiredRecordString(value, 'eventId', 'malformed_record'),
    traceId: requiredRecordString(value, 'traceId', 'malformed_record'),
    createdAt: requiredRecordCanonicalTimestamp(
      value,
      'createdAt',
      'malformed_record'
    ),
    sessionId: requiredRecordString(value, 'sessionId', 'malformed_record'),
    inputEnvelope: requiredRoleModelInputEnvelope(value['inputEnvelope']),
    rawOutputText: requiredRecordStringAllowingEmpty(
      value,
      'rawOutputText',
      'malformed_record'
    ),
    ...optionalRoleModelProviderMetadataOption(value['providerMetadata']),
    ...optionalRoleModelProviderExchangeOption(value['providerExchange'])
  });
}

function optionalParsedRoleModelDecisionSnapshot(
  value: unknown
): ParsedRoleModelDecisionSnapshot | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throwMalformedRecord('parsedRoleModelDecisionSnapshot');
  }

  requiredLiteralString(
    value,
    'kind',
    'role_model_decision_snapshot',
    'parsedRoleModelDecisionSnapshot.kind'
  );

  return createParsedRoleModelDecisionSnapshot({
    eventId: requiredRecordString(value, 'eventId', 'malformed_record'),
    traceId: requiredRecordString(value, 'traceId', 'malformed_record'),
    createdAt: requiredRecordCanonicalTimestamp(
      value,
      'createdAt',
      'malformed_record'
    ),
    sessionId: requiredRecordString(value, 'sessionId', 'malformed_record'),
    result: requiredRoleModelDecisionResult(value['result'])
  });
}

function optionalRoleModelCommitValidationSnapshot(
  value: unknown
): RoleModelCommitValidationSnapshot | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throwMalformedRecord('commitValidation');
  }

  requiredLiteralString(
    value,
    'kind',
    'role_model_commit_validation_snapshot',
    'commitValidation.kind'
  );

  return createRoleModelCommitValidationSnapshot({
    eventId: requiredRecordString(value, 'eventId', 'malformed_record'),
    traceId: requiredRecordString(value, 'traceId', 'malformed_record'),
    createdAt: requiredRecordCanonicalTimestamp(
      value,
      'createdAt',
      'malformed_record'
    ),
    sessionId: requiredRecordString(value, 'sessionId', 'malformed_record'),
    result: requiredRoleModelCommitValidationResult(value['result'])
  });
}

function optionalRuntimePluginEvidenceSnapshots(
  value: unknown
): readonly RuntimePluginEvidenceSnapshot[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const snapshots: RuntimePluginEvidenceSnapshot[] = [];

  try {
    for (const item of requiredArray(value, 'runtimePluginEvidence')) {
      snapshots.push(requiredRuntimePluginEvidenceSnapshot(item));
    }
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      throwMalformedRecord('runtimePluginEvidence');
    }

    throw error;
  }

  return Object.freeze(snapshots);
}

function optionalRuntimePluginJsonObject(
  value: unknown
): RuntimePluginJsonObject | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throwMalformedRecord('toolInput');
  }

  return freezeJsonRecord(value);
}

function optionalRuntimePluginToolCallResult(
  value: unknown
): RuntimePluginToolCallResult | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throwMalformedRecord('toolResult');
  }

  if (value['status'] === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      output: freezeJsonValue(value['output']),
      evidence: Object.freeze(
        requiredArray(value['evidence'], 'toolResult.evidence').map(
          requiredRuntimePluginEvidenceSnapshot
        )
      )
    } satisfies RuntimePluginToolCallResult);
  }

  if (value['status'] === 'rejected') {
    return Object.freeze({
      status: 'rejected',
      reason: requiredRecordString(value, 'reason', 'malformed_record'),
      message: requiredRecordString(value, 'message', 'malformed_record'),
      evidence: Object.freeze(
        requiredArray(value['evidence'], 'toolResult.evidence').map(
          requiredRuntimePluginEvidenceSnapshot
        )
      )
    } satisfies RuntimePluginToolCallResult);
  }

  throwMalformedRecord('toolResult.status');
}

function optionalRuntimePluginTurnEvidenceSnapshot(
  value: unknown
): RuntimePluginTurnEvidenceSnapshot | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    return createRuntimePluginTurnEvidenceSnapshot(value);
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      throwMalformedRecord('runtimePluginTurnEvidence');
    }

    throw error;
  }
}

function requiredRuntimePluginEvidenceSnapshot(
  value: unknown
): RuntimePluginEvidenceSnapshot {
  if (!isRecord(value)) {
    throwMalformedRecord('runtimePluginEvidence');
  }

  requiredLiteralString(
    value,
    'kind',
    'runtime_plugin_evidence_snapshot',
    'runtimePluginEvidence.kind'
  );

  const sourceReferences = optionalRuntimePluginSourceReferences(
    value['sourceReferences']
  );
  const policyOutcome = optionalRuntimePluginPolicyOutcome(
    value['policyOutcome']
  );
  const configFingerprint = optionalRecordString(
    value,
    'configFingerprint',
    'malformed_record'
  );

  return createRuntimePluginEvidenceSnapshot({
    eventId: requiredRecordString(value, 'eventId', 'malformed_record'),
    traceId: requiredRecordString(value, 'traceId', 'malformed_record'),
    createdAt: requiredRecordCanonicalTimestamp(
      value,
      'createdAt',
      'malformed_record'
    ),
    kind: 'runtime_plugin_evidence_snapshot',
    pluginId: requiredRecordString(
      value,
      'pluginId',
      'malformed_record'
    ),
    evidenceKind: requiredRuntimePluginEvidenceKind(value['evidenceKind']),
    status: requiredRuntimePluginEvidenceStatus(value['status']),
    summary: requiredRecordString(value, 'summary', 'malformed_record'),
    ...(policyOutcome === undefined ? {} : { policyOutcome }),
    ...(sourceReferences === undefined ? {} : { sourceReferences }),
    redactionLabels: requiredStringArray(
      value['redactionLabels'],
      'runtimePluginEvidence.redactionLabels'
    ),
    ...(configFingerprint === undefined ? {} : { configFingerprint })
  });
}

function optionalRuntimePluginSourceReferences(
  value: unknown
): readonly RuntimePluginSourceReference[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const sourceReferences: RuntimePluginSourceReference[] = [];

  for (const item of requiredArray(value, 'sourceReferences')) {
    sourceReferences.push(requiredRuntimePluginSourceReference(item));
  }

  return Object.freeze(sourceReferences);
}

function requiredRuntimePluginSourceReference(
  value: unknown
): RuntimePluginSourceReference {
  if (!isRecord(value)) {
    throwMalformedRecord('sourceReferences');
  }

  const title = optionalRecordString(value, 'title', 'malformed_record');
  const uri = optionalRecordString(value, 'uri', 'malformed_record');

  return Object.freeze({
    kind: requiredRuntimePluginSourceKind(value['kind']),
    id: requiredRecordString(value, 'id', 'malformed_record'),
    ...(title === undefined ? {} : { title }),
    ...(uri === undefined ? {} : { uri })
  } satisfies RuntimePluginSourceReference);
}

function assertRuntimePluginEvidenceSemantics(options: {
  readonly identity: RuntimeEventIdentity;
  readonly runtimePluginEvidence:
    | readonly RuntimePluginEvidenceSnapshot[]
    | undefined;
  readonly runtimePluginTurnEvidence:
    | RuntimePluginTurnEvidenceSnapshot
    | undefined;
}): void {
  for (const snapshot of options.runtimePluginEvidence ?? []) {
    assertMatchingRoleModelIdentity({
      actual: snapshot,
      expected: options.identity,
      field: 'runtimePluginEvidence'
    });
  }

  if (options.runtimePluginTurnEvidence === undefined) {
    return;
  }

  assertMatchingRoleModelIdentity({
    actual: options.runtimePluginTurnEvidence,
    expected: options.identity,
    field: 'runtimePluginTurnEvidence'
  });
}

function assertRoleModelRawEventEvidenceSemantics(options: {
  readonly identity: RuntimeEventIdentity;
  readonly payloadSummary: RawEventLogPayloadSummary | undefined;
  readonly kind: RawEventLogRecordKind;
  readonly status: RuntimeTurnStatus | undefined;
  readonly reason: string | undefined;
  readonly roleModelIOSnapshot: RoleModelIOSnapshot | undefined;
  readonly parsedRoleModelDecisionSnapshot:
    | ParsedRoleModelDecisionSnapshot
    | undefined;
  readonly commitValidation: RoleModelCommitValidationSnapshot | undefined;
}): void {
  const roleModelEvidenceCount = [
    options.roleModelIOSnapshot,
    options.parsedRoleModelDecisionSnapshot
  ].filter((value) => value !== undefined).length;

  if (
    roleModelEvidenceCount === 0 &&
    options.commitValidation === undefined
  ) {
    return;
  }

  if (
    options.roleModelIOSnapshot === undefined ||
    options.parsedRoleModelDecisionSnapshot === undefined
  ) {
    throwMalformedRecord('roleModelEvidence');
  }

  const roleModelIOSnapshot = options.roleModelIOSnapshot;
  const parsedRoleModelDecisionSnapshot =
    options.parsedRoleModelDecisionSnapshot;
  const commitValidation = options.commitValidation;

  assertMatchingRoleModelIdentity({
    actual: roleModelIOSnapshot,
    expected: options.identity,
    field: 'roleModelIOSnapshot'
  });
  assertMatchingRoleModelIdentity({
    actual: roleModelIOSnapshot.inputEnvelope.event,
    expected: options.identity,
    field: 'roleModelIOSnapshot.inputEnvelope.event'
  });
  assertRoleModelInputTextMatchesPayloadSummary({
    payloadSummary: options.payloadSummary,
    inputText:
      roleModelIOSnapshot.inputEnvelope.event.payload.currentUserMessage
  });
  assertMatchingRoleModelIdentity({
    actual: parsedRoleModelDecisionSnapshot,
    expected: options.identity,
    field: 'parsedRoleModelDecisionSnapshot'
  });
  assertMatchingRoleModelSession({
    actual: roleModelIOSnapshot.inputEnvelope.decisionContext.sessionId,
    expected: roleModelIOSnapshot.sessionId,
    field: 'roleModelIOSnapshot.inputEnvelope.decisionContext.sessionId'
  });
  assertMatchingRoleModelSession({
    actual: parsedRoleModelDecisionSnapshot.sessionId,
    expected: roleModelIOSnapshot.sessionId,
    field: 'parsedRoleModelDecisionSnapshot.sessionId'
  });
  assertParsedRoleModelDecisionMatchesRawOutput({
    roleModelIOSnapshot,
    parsedRoleModelDecisionSnapshot
  });
  assertParsedRoleModelDecisionAllowedByEnvelope({
    roleModelIOSnapshot,
    parsedRoleModelDecisionSnapshot
  });

  if (commitValidation === undefined) {
    if (
      options.kind !== 'tool_call_started' &&
      options.kind !== 'interim_visible_reply_emitted'
    ) {
      throwMalformedRecord('commitValidation');
    }

    if (options.status !== undefined || options.reason !== undefined) {
      throwMalformedRecord('commitValidation');
    }

    return;
  }

  assertMatchingRoleModelSession({
    actual: commitValidation.sessionId,
    expected: roleModelIOSnapshot.sessionId,
    field: 'commitValidation.sessionId'
  });
  assertMatchingRoleModelIdentity({
    actual: commitValidation,
    expected: options.identity,
    field: 'commitValidation'
  });
  assertRoleModelCommitStatusMatchesRawEvent({
    kind: options.kind,
    status: options.status,
    reason: options.reason,
    parsedRoleModelDecisionSnapshot,
    commitValidation
  });
}

function normalizeLegacyRejectedDecisionRequestedToolNames(options: {
  readonly roleModelIOSnapshot: RoleModelIOSnapshot | undefined;
  readonly parsedRoleModelDecisionSnapshot:
    | ParsedRoleModelDecisionSnapshot
    | undefined;
}): ParsedRoleModelDecisionSnapshot | undefined {
  const roleModelIOSnapshot = options.roleModelIOSnapshot;
  const parsedSnapshot = options.parsedRoleModelDecisionSnapshot;
  const storedResult = parsedSnapshot?.result;

  if (
    roleModelIOSnapshot === undefined ||
    parsedSnapshot === undefined ||
    storedResult?.status !== 'rejected' ||
    storedResult.requestedToolNames !== undefined
  ) {
    return parsedSnapshot;
  }

  const normalizedResult = normalizeReplayableRejectedRoleModelDecisionResult({
    rawOutputText: roleModelIOSnapshot.rawOutputText,
    providerMetadata: roleModelIOSnapshot.providerMetadata,
    decisionResult: storedResult,
    allowedTools: roleModelIOSnapshot.inputEnvelope.allowedTools,
    pluginToolDefinitions:
      roleModelIOSnapshot.inputEnvelope.pluginToolDefinitions,
    toolObservations: roleModelIOSnapshot.inputEnvelope.toolObservations
  });

  if (
    normalizedResult === undefined ||
    normalizedResult.requestedToolNames === undefined
  ) {
    return parsedSnapshot;
  }

  return createParsedRoleModelDecisionSnapshot({
    eventId: parsedSnapshot.eventId,
    traceId: parsedSnapshot.traceId,
    createdAt: parsedSnapshot.createdAt,
    sessionId: parsedSnapshot.sessionId,
    result: normalizedResult
  });
}

function assertRoleModelInputTextMatchesPayloadSummary(options: {
  readonly payloadSummary: RawEventLogPayloadSummary | undefined;
  readonly inputText: string;
}): void {
  const normalizedCurrentUserMessage =
    options.payloadSummary?.normalizedCurrentUserMessage;

  if (normalizedCurrentUserMessage === undefined) {
    return;
  }

  if (options.inputText === normalizedCurrentUserMessage) {
    return;
  }

  throwMalformedRecord(
    'roleModelIOSnapshot.inputEnvelope.event.payload.currentUserMessage'
  );
}

function assertParsedRoleModelDecisionMatchesRawOutput(options: {
  readonly roleModelIOSnapshot: RoleModelIOSnapshot;
  readonly parsedRoleModelDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
}): void {
  if (
    isRoleModelRawOutputReplayableDecisionEvidence({
      rawOutputText: options.roleModelIOSnapshot.rawOutputText,
      providerMetadata: options.roleModelIOSnapshot.providerMetadata,
      decisionResult: options.parsedRoleModelDecisionSnapshot.result,
      allowedTools: options.roleModelIOSnapshot.inputEnvelope.allowedTools,
      pluginToolDefinitions:
        options.roleModelIOSnapshot.inputEnvelope.pluginToolDefinitions,
      toolObservations: options.roleModelIOSnapshot.inputEnvelope.toolObservations
    })
  ) {
    return;
  }

  throwMalformedRecord('parsedRoleModelDecisionSnapshot.result');
}

function assertParsedRoleModelDecisionAllowedByEnvelope(options: {
  readonly roleModelIOSnapshot: RoleModelIOSnapshot;
  readonly parsedRoleModelDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
}): void {
  const parsedResult = options.parsedRoleModelDecisionSnapshot.result;

  if (parsedResult.status === 'rejected') {
    return;
  }

  const everyToolIsAllowed = parsedResult.decision.toolCalls.every((call) =>
    options.roleModelIOSnapshot.inputEnvelope.allowedTools.includes(call.name)
  );

  if (!everyToolIsAllowed) {
    throwMalformedRecord('roleModelIOSnapshot.inputEnvelope.allowedTools');
  }
}

function assertRoleModelCommitStatusMatchesRawEvent(options: {
  readonly kind: RawEventLogRecordKind;
  readonly status: RuntimeTurnStatus | undefined;
  readonly reason: string | undefined;
  readonly parsedRoleModelDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly commitValidation: RoleModelCommitValidationSnapshot;
}): void {
  const commitResult = options.commitValidation.result;

  if (commitResult.status === 'accepted') {
    const parsedResult = options.parsedRoleModelDecisionSnapshot.result;

    if (parsedResult.status !== 'accepted') {
      throwMalformedRecord('parsedRoleModelDecisionSnapshot.result');
    }

    assertAcceptedCommitTextMatchesParsedDecision({
      actual: commitResult.acceptedVisibleReplyText,
      parsedDecision: parsedResult.decision
    });

    if (
      options.kind !== 'visible_reply_committed' &&
      options.kind !== 'runtime_turn_completed'
    ) {
      throwMalformedRecord('commitValidation');
    }

    if (
      options.kind === 'runtime_turn_completed' &&
      options.status !== 'completed' &&
      options.status !== 'completed_with_failures'
    ) {
      throwMalformedRecord('commitValidation.result.status');
    }

    if (options.reason !== undefined) {
      throwMalformedRecord('reason');
    }

    return;
  }

  if (
    options.kind !== 'commit_validation_rejected' &&
    options.kind !== 'runtime_turn_rejected'
  ) {
    throwMalformedRecord('commitValidation');
  }

  if (
    options.kind === 'runtime_turn_rejected' &&
    options.status !== 'rejected'
  ) {
    throwMalformedRecord('commitValidation.result.status');
  }

  if (options.reason !== commitResult.rejection.reason) {
    throwMalformedRecord('reason');
  }

  assertRejectedCommitMatchesParsedDecision({
    parsedRoleModelDecisionSnapshot: options.parsedRoleModelDecisionSnapshot,
    commitValidation: options.commitValidation
  });
}

function assertAcceptedCommitTextMatchesParsedDecision(options: {
  readonly actual: string | undefined;
  readonly parsedDecision: CharacterDecision;
}): void {
  const parsedDecisionText = getVisibleReplyToolCall(options.parsedDecision)?.input.text;

  if (parsedDecisionText === undefined) {
    if (options.actual === undefined) {
      return;
    }

    throwMalformedRecord('commitValidation.result.acceptedVisibleReplyText');
  }

  if (options.actual === undefined) {
    throwMalformedRecord('commitValidation.result.acceptedVisibleReplyText');
  }

  let normalizedParsedDecisionText: string;

  try {
    normalizedParsedDecisionText = normalizeVisibleMessageText(
      parsedDecisionText
    );
  } catch (error: unknown) {
    if (error instanceof VisibleMessageTextValidationError) {
      throwMalformedRecord(
        'parsedRoleModelDecisionSnapshot.result.decision.action.text'
      );
    }

    throw error;
  }

  if (options.actual !== normalizedParsedDecisionText) {
    throwMalformedRecord('commitValidation.result.acceptedVisibleReplyText');
  }
}

function assertRejectedCommitMatchesParsedDecision(options: {
  readonly parsedRoleModelDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly commitValidation: RoleModelCommitValidationSnapshot;
}): void {
  const parsedResult = options.parsedRoleModelDecisionSnapshot.result;
  const commitResult = options.commitValidation.result;

  if (commitResult.status !== 'rejected') {
    throwMalformedRecord('commitValidation.result.status');
  }

  if (parsedResult.status === 'rejected') {
    if (parsedResult.rejection.reason !== commitResult.rejection.reason) {
      throwMalformedRecord('commitValidation.result.rejection.reason');
    }

    if (parsedResult.rejection.details !== commitResult.rejection.details) {
      throwMalformedRecord('commitValidation.result.rejection.details');
    }

    return;
  }

  if (
    !isOneOf(
      commitResult.rejection.reason,
      commitOwnedRoleModelRejectionReasons
    )
  ) {
    throwMalformedRecord('commitValidation.result.rejection.reason');
  }

  if (
    commitResult.rejection.reason ===
    roleModelInvalidVisibleReplyRejectionReason
  ) {
    assertParsedDecisionTextFailsCommitValidation(
      getRequiredVisibleReplyText(parsedResult.decision)
    );
  }
}

function assertParsedDecisionTextFailsCommitValidation(
  parsedDecisionText: string
): void {
  try {
    normalizeVisibleMessageText(parsedDecisionText);
  } catch (error: unknown) {
    if (error instanceof VisibleMessageTextValidationError) {
      return;
    }

    throw error;
  }

  throwMalformedRecord('commitValidation.result.rejection.reason');
}

function assertMatchingRoleModelIdentity(options: {
  readonly actual: RuntimeEventIdentity;
  readonly expected: RuntimeEventIdentity;
  readonly field: string;
}): void {
  if (
    options.actual.eventId === options.expected.eventId &&
    options.actual.traceId === options.expected.traceId &&
    options.actual.createdAt === options.expected.createdAt
  ) {
    return;
  }

  throwMalformedRecord(options.field);
}

function assertMatchingRoleModelSession(options: {
  readonly actual: string;
  readonly expected: string;
  readonly field: string;
}): void {
  if (options.actual === options.expected) {
    return;
  }

  throwMalformedRecord(options.field);
}

function requiredRoleModelInputEnvelope(
  value: unknown
): RoleModelInputEnvelope {
  if (!isRecord(value)) {
    throwMalformedRecord('roleModelInputEnvelope');
  }
  const allowedTools = requiredRoleModelAllowedTools(value['allowedTools']);
  const storedPluginToolDefinitions = value['pluginToolDefinitions'];
  const pluginToolDefinitions =
    storedPluginToolDefinitions === undefined
      ? legacyRoleModelPluginToolDefinitions(allowedTools)
      : optionalRoleModelPluginToolDefinitions(storedPluginToolDefinitions);

  try {
    return createRoleModelInputEnvelope({
      event: requiredUserMessageRuntimeEvent(value['event']),
      decisionContext: requiredDecisionContext(value['decisionContext']),
      allowedTools,
      pluginToolDefinitions,
      toolObservations: optionalRoleModelToolObservations(
        value['toolObservations']
      ),
      outputContract: requiredRoleModelOutputContract(value['outputContract'])
    });
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      throwMalformedRecord('roleModelInputEnvelope');
    }

    throw error;
  }
}

function legacyRoleModelPluginToolDefinitions(
  allowedTools: readonly RoleModelAllowedToolName[]
): readonly RoleModelPluginToolDefinition[] {
  // Schema 1 stored character_state.patch as a built-in tool before plugin
  // definitions were persisted with role-model envelopes.
  return Object.freeze([
    ...createDefaultRoleModelPluginToolDefinitions().filter((definition) =>
      allowedTools.includes(definition.name)
    ),
    ...(allowedTools.includes(characterStatePatchModelToolName)
      ? [legacySchema1CharacterStatePatchPluginToolDefinition]
      : [])
  ]);
}

function requiredUserMessageRuntimeEvent(
  value: unknown
): UserMessageRuntimeEvent {
  if (!isRecord(value)) {
    throwMalformedRecord('event');
  }

  const payload = value['payload'];

  if (!isRecord(payload)) {
    throwMalformedRecord('event.payload');
  }

  return Object.freeze({
    eventId: requiredRecordString(value, 'eventId', 'malformed_record'),
    traceId: requiredRecordString(value, 'traceId', 'malformed_record'),
    createdAt: requiredRecordCanonicalTimestamp(
      value,
      'createdAt',
      'malformed_record'
    ),
    type: requiredRuntimeEventType(value['type']),
    payload: Object.freeze({
      currentUserMessage: requiredRecordString(
        payload,
        'currentUserMessage',
        'malformed_record'
      )
    })
  } satisfies UserMessageRuntimeEvent);
}

function requiredDecisionContext(value: unknown): DecisionContext {
  if (!isRecord(value)) {
    throwMalformedRecord('decisionContext');
  }

  return createDecisionContext({
    sessionId: requiredRecordString(value, 'sessionId', 'malformed_record'),
    characterSnapshot: requiredCharacterProfile(value['characterSnapshot']),
    recentVisibleMessages: requiredVisibleMessages(
      value['recentVisibleMessages'],
      'recentVisibleMessages'
    ),
    runtimeNotes: requiredStringArray(value['runtimeNotes'], 'runtimeNotes'),
    pluginContextItems: optionalRuntimePluginContextItems(
      value['pluginContextItems']
    )
  });
}

function requiredCharacterProfile(value: unknown): CharacterProfile {
  if (!isRecord(value)) {
    throwMalformedRecord('characterSnapshot');
  }

  return Object.freeze({
    id: requiredRecordString(value, 'id', 'malformed_record'),
    displayName: requiredRecordString(value, 'displayName', 'malformed_record')
  } satisfies CharacterProfile);
}

function requiredVisibleMessages(
  value: unknown,
  key: string
): readonly VisibleMessage[] {
  const messages: VisibleMessage[] = [];

  for (const item of requiredArray(value, key)) {
    messages.push(requiredVisibleMessage(item));
  }

  return Object.freeze(messages);
}

function requiredVisibleMessage(value: unknown): VisibleMessage {
  if (!isRecord(value)) {
    throwMalformedRecord('recentVisibleMessages');
  }

  return Object.freeze({
    id: requiredRecordString(value, 'id', 'malformed_record'),
    role: requiredVisibleMessageRole(value['role']),
    speakerId: requiredRecordString(value, 'speakerId', 'malformed_record'),
    speakerName: requiredRecordString(value, 'speakerName', 'malformed_record'),
    text: requiredNormalizedVisibleMessageText(value, 'text')
  } satisfies VisibleMessage);
}

function requiredStringArray(value: unknown, key: string): readonly string[] {
  const strings: string[] = [];

  for (const item of requiredArray(value, key)) {
    if (typeof item !== 'string') {
      throwMalformedRecord(key);
    }

    strings.push(item);
  }

  return Object.freeze(strings);
}

function optionalRuntimePluginContextItems(
  value: unknown
): readonly RuntimePluginContextItem[] {
  if (value === undefined) {
    return Object.freeze([]);
  }

  const contextItems: RuntimePluginContextItem[] = [];

  for (const item of requiredArray(value, 'pluginContextItems')) {
    try {
      contextItems.push(createRuntimePluginContextItem(item));
    } catch (error: unknown) {
      if (error instanceof TypeError) {
        throwMalformedRecord('pluginContextItems');
      }

      throw error;
    }
  }

  return Object.freeze(contextItems);
}

function optionalRoleModelPluginToolDefinitions(
  value: unknown
): readonly RoleModelPluginToolDefinition[] {
  if (value === undefined) {
    return Object.freeze([]);
  }

  const definitions: RoleModelPluginToolDefinition[] = [];

  for (const item of requiredArray(value, 'pluginToolDefinitions')) {
    if (!isRecord(item)) {
      throwMalformedRecord('pluginToolDefinitions');
    }

    const pluginId = requiredRecordString(
      item,
      'pluginId',
      'malformed_record'
    );

    try {
      definitions.push(
        Object.freeze({
          pluginId,
          ...createRuntimePluginProvidedTool(item)
        } satisfies RoleModelPluginToolDefinition)
      );
    } catch (error: unknown) {
      if (error instanceof TypeError) {
        throwMalformedRecord('pluginToolDefinitions');
      }

      throw error;
    }
  }

  return Object.freeze(definitions);
}

function optionalRoleModelToolObservations(
  value: unknown
): readonly RoleModelToolObservation[] {
  if (value === undefined) {
    return Object.freeze([]);
  }

  const observations: RoleModelToolObservation[] = [];

  for (const item of requiredArray(value, 'toolObservations')) {
    if (!isRecord(item)) {
      throwMalformedRecord('toolObservations');
    }

    const input = item['input'];

    if (!isRecord(input)) {
      throwMalformedRecord('toolObservations.input');
    }

    try {
      observations.push(
        createRoleModelToolObservation({
          round: requiredRecordNumber(item, 'round', 'malformed_record'),
          pluginId: requiredRecordString(
            item,
            'pluginId',
            'malformed_record'
          ),
          toolName: requiredRecordString(item, 'toolName', 'malformed_record'),
          input: freezeJsonRecord(input),
          result: requiredRoleModelToolObservationResult(item['result'])
        })
      );
    } catch (error: unknown) {
      if (error instanceof TypeError) {
        throwMalformedRecord('toolObservations');
      }

      throw error;
    }
  }

  return Object.freeze(observations);
}

function requiredRoleModelToolObservationResult(
  value: unknown
): RoleModelToolObservation['result'] {
  if (!isRecord(value)) {
    throwMalformedRecord('toolObservations.result');
  }

  const status = requiredRecordString(value, 'status', 'malformed_record');

  if (status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      output: freezeJsonValue(value['output'])
    } satisfies RoleModelToolObservation['result']);
  }

  if (status === 'rejected') {
    return Object.freeze({
      status: 'rejected',
      reason: requiredRecordString(value, 'reason', 'malformed_record'),
      message: requiredRecordString(value, 'message', 'malformed_record')
    } satisfies RoleModelToolObservation['result']);
  }

  throwMalformedRecord('toolObservations.result.status');
}

function requiredRoleModelAllowedTools(
  value: unknown
): readonly RoleModelAllowedToolName[] {
  const tools: RoleModelAllowedToolName[] = [];

  for (const item of requiredArray(value, 'allowedTools')) {
    if (!isRoleModelAllowedToolName(item)) {
      throwMalformedRecord('allowedTools');
    }

    tools.push(item);
  }

  if (hasDuplicateRoleModelAllowedTools(tools)) {
    throwMalformedRecord('allowedTools');
  }

  return Object.freeze(tools);
}

function requiredRoleModelOutputContract(
  value: unknown
): RoleModelOutputContract {
  if (!isRecord(value)) {
    throwMalformedRecord('outputContract');
  }

  const version = requiredRecordString(value, 'version', 'malformed_record');

  if (version !== roleModelDecisionContractVersion) {
    throwMalformedRecord('outputContract.version');
  }

  return Object.freeze({
    version,
    text: requiredRecordString(value, 'text', 'malformed_record')
  } satisfies RoleModelOutputContract);
}

function optionalRoleModelProviderMetadataOption(value: unknown): {
  readonly providerMetadata?: RoleModelProviderMetadata;
} {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    throwMalformedRecord('providerMetadata');
  }

  const provider = requiredRecordString(value, 'provider', 'malformed_record');

  if (provider !== 'local' && provider !== 'nvidia') {
    throwMalformedRecord('providerMetadata.provider');
  }

  const model = optionalRecordString(value, 'model', 'malformed_record');
  const request = optionalProviderRequestMetadata(value['request']);
  const response = optionalProviderResponseMetadata(value['response']);
  const error = optionalProviderErrorMetadata(value['error']);

  return {
    providerMetadata: Object.freeze({
      provider,
      ...(model === undefined ? {} : { model }),
      ...(request === undefined ? {} : { request }),
      ...(response === undefined ? {} : { response }),
      ...(error === undefined ? {} : { error })
    } satisfies RoleModelProviderMetadata)
  };
}

function optionalRoleModelProviderExchangeOption(value: unknown): {
  readonly providerExchange?: RoleModelProviderExchangeSnapshot;
} {
  if (value === undefined) {
    return {};
  }

  const providerExchange = parseRoleModelProviderExchangeSnapshot(value);

  if (providerExchange === undefined) {
    throwMalformedRecord('providerExchange');
  }

  return {
    providerExchange
  };
}

function optionalProviderRequestMetadata(
  value: unknown
): RoleModelProviderMetadata['request'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throwMalformedRecord('providerMetadata.request');
  }

  const endpoint = optionalRecordString(value, 'endpoint', 'malformed_record');
  const messageCount = value['messageCount'];

  if (messageCount !== undefined && typeof messageCount !== 'number') {
    throwMalformedRecord('providerMetadata.request.messageCount');
  }

  requiredLiteralBooleanFalse(value, 'stream', 'providerMetadata.request.stream');

  return Object.freeze({
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(messageCount === undefined ? {} : { messageCount }),
    stream: false
  });
}

function optionalProviderResponseMetadata(
  value: unknown
): RoleModelProviderMetadata['response'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throwMalformedRecord('providerMetadata.response');
  }

  const status = value['status'];

  if (status !== undefined && typeof status !== 'number') {
    throwMalformedRecord('providerMetadata.response.status');
  }

  return Object.freeze({
    ...(status === undefined ? {} : { status })
  });
}

function optionalProviderErrorMetadata(
  value: unknown
): RoleModelProviderMetadata['error'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throwMalformedRecord('providerMetadata.error');
  }

  return Object.freeze({
    code: requiredRecordString(value, 'code', 'malformed_record'),
    message: requiredRecordString(value, 'message', 'malformed_record')
  });
}

function requiredRoleModelDecisionResult(
  value: unknown
): RoleModelDecisionResult {
  if (!isRecord(value)) {
    throwMalformedRecord('roleModelDecisionResult');
  }

  const status = requiredRecordString(value, 'status', 'malformed_record');

  if (status === 'accepted') {
    const nonCommittedText = optionalRecordStringAllowingEmpty(
      value,
      'nonCommittedText',
      'malformed_record'
    );

    return createAcceptedRoleModelDecisionResult(
      requiredCharacterDecision(value['decision']),
      {
        ...(nonCommittedText === undefined ? {} : { nonCommittedText })
      }
    );
  }

  if (status === 'rejected') {
    const rejection = requiredRoleModelDecisionRejection(value['rejection']);
    const requestedToolNames = optionalStringArray(
      value['requestedToolNames'],
      'roleModelDecisionResult.requestedToolNames'
    );

    if (
      requestedToolNames?.some(
        (toolName) => !isRoleModelAllowedToolName(toolName)
      ) === true
    ) {
      throwMalformedRecord('roleModelDecisionResult.requestedToolNames');
    }

    return createRejectedRoleModelDecisionResult(
      rejection.reason,
      rejection.details,
      {
        ...(requestedToolNames === undefined ? {} : { requestedToolNames })
      }
    );
  }

  throwMalformedRecord('status');
}

function requiredCharacterDecision(value: unknown): CharacterDecision {
  if (!isRecord(value)) {
    throwMalformedRecord('decision');
  }

  if (value['version'] === roleModelDecisionContractVersion) {
    return Object.freeze({
      version: roleModelDecisionContractVersion,
      toolCalls: Object.freeze(
        requiredArray(value['toolCalls'], 'decision.toolCalls').map(
          requiredModelToolCall
        )
      )
    } satisfies CharacterDecision);
  }

  throwMalformedRecord('decision.version');
}

function requiredModelToolCall(value: unknown): ModelToolCall {
  if (!isRecord(value)) {
    throwMalformedRecord('decision.toolCalls');
  }

  const name = requiredRecordString(value, 'name', 'malformed_record');
  const input = value['input'];

  if (!isRecord(input)) {
    throwMalformedRecord('decision.toolCalls.input');
  }

  if (name === visibleReplyModelToolName) {
    const text = requiredRecordStringAllowingEmpty(
      input,
      'text',
      'malformed_record'
    );

    return createVisibleReplyModelToolCall(text);
  }

  return Object.freeze({
    name,
    input: freezeJsonRecord(input)
  } satisfies PluginModelToolCall);
}

function freezeJsonRecord(
  record: Readonly<Record<string, unknown>>
): Readonly<Record<string, RuntimePluginJsonValue>> {
  const snapshot: Record<string, RuntimePluginJsonValue> = {};

  for (const [key, value] of Object.entries(record)) {
    snapshot[key] = freezeJsonValue(value);
  }

  return Object.freeze(snapshot);
}

function freezeJsonValue(value: unknown): RuntimePluginJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeJsonValue));
  }

  if (isRecord(value)) {
    return freezeJsonRecord(value);
  }

  throwMalformedRecord('decision.toolCalls.input');
}

function requiredRoleModelCommitValidationResult(
  value: unknown
): RoleModelCommitValidationResult {
  if (!isRecord(value)) {
    throwMalformedRecord('commitValidation.result');
  }

  const status = requiredRecordString(value, 'status', 'malformed_record');

  if (status === 'accepted') {
    const acceptedVisibleReplyText =
      value['acceptedVisibleReplyText'] === undefined
        ? undefined
        : requiredNormalizedVisibleMessageText(
            value,
            'acceptedVisibleReplyText'
          );

    return Object.freeze({
      status: 'accepted',
      ...(acceptedVisibleReplyText === undefined
        ? {}
        : { acceptedVisibleReplyText })
    } satisfies AcceptedRoleModelCommitValidationResult);
  }

  if (status === 'rejected') {
    return Object.freeze({
      status: 'rejected',
      rejection: requiredRoleModelDecisionRejection(value['rejection'])
    } satisfies RejectedRoleModelCommitValidationResult);
  }

  throwMalformedRecord('status');
}

function requiredRoleModelDecisionRejection(
  value: unknown
): RoleModelDecisionRejection {
  if (!isRecord(value)) {
    throwMalformedRecord('rejection');
  }

  const reason = requiredRoleModelDecisionRejectionReason(value['reason']);
  const details = optionalRecordStringAllowingEmpty(
    value,
    'details',
    'malformed_record'
  );

  return Object.freeze({
    reason,
    ...(details === undefined ? {} : { details })
  } satisfies RoleModelDecisionRejection);
}

function requiredRoleModelDecisionRejectionReason(
  value: unknown
): RoleModelDecisionRejectionReason {
  if (isOneOf(value, roleModelDecisionRejectionReasons)) {
    return value;
  }

  throwMalformedRecord('rejection.reason');
}

function requiredArray(value: unknown, key: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throwMalformedRecord(key);
  }

  return value;
}

function requiredLiteralString(
  record: Record<string, unknown>,
  key: string,
  expectedValue: string,
  errorField: string
): void {
  const value = requiredRecordString(record, key, 'malformed_record');

  if (value !== expectedValue) {
    throwMalformedRecord(errorField);
  }
}

function requiredLiteralBooleanFalse(
  record: Record<string, unknown>,
  key: string,
  errorField: string
): void {
  if (record[key] !== false) {
    throwMalformedRecord(errorField);
  }
}

function optionalPayloadSummaryString(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throwMalformedRecord(key);
  }

  return value;
}
