import {
  normalizeVisibleMessageText,
  type RuntimeEventIdentity,
  type RuntimeEventType,
  runtimeEventTypeValues,
  type UserMessageRuntimeEvent,
  VisibleMessageTextValidationError,
} from '../../core/index.ts';
import {
  createParsedRoleModelDecisionSnapshot,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot,
  createRoleModelToolObservation,
  freezeRoleModelPromptSize,
  getRequiredVisibleReplyText,
  visibleReplyToolCalls,
  hasDuplicateRoleModelAllowedTools,
  isRoleModelAllowedToolName,
  isRoleModelRawOutputReplayableDecisionEvidence,
  parseRoleModelProviderExchangeSnapshot,
  roleModelPluginToolRejectedRejectionReason,
  roleModelCommitValidationFailureRejectionReason,
  roleModelDecisionContractVersion,
  roleModelInvalidVisibleReplyRejectionReason,
  type CharacterDecision,
  type ParsedRoleModelDecisionSnapshot,
  type RoleModelPluginToolDefinition,
  type RoleModelAllowedToolName,
  type RoleModelDecisionRejectionReason,
  type RoleModelInputEnvelope,
  type RoleModelCharacterRef,
  type RoleModelIOSnapshot,
  type RoleModelOutputContract,
  type RoleModelPromptSize,
  type RoleModelProviderExchangeSnapshot,
  type RoleModelToolObservation,
} from '../../role-model/index.ts';
import {visibleReplyModelToolName} from '../../role-model/index.ts';
import {
  createPreparedRuntimePluginConfigEffect,
  createRuntimePluginEvidenceSnapshot,
  createRuntimePluginProvidedTool,
  createRuntimePluginToolCallResultSnapshot,
  createRuntimePluginTurnEvidenceSnapshot,
  type PreparedRuntimePluginConfigEffect,
  type RuntimePluginEvidenceSnapshot,
  type RuntimePluginJsonObject,
  type RuntimePluginSourceReference,
  type RuntimePluginToolCallResult,
  type RuntimePluginTurnEvidenceSnapshot,
} from '../../plugins/api/index.ts';
import {
  runtimePluginEvidenceKindValues,
  runtimePluginEvidenceStatusValues,
  runtimePluginPolicyOutcomeValues,
  runtimePluginSourceKindValues,
  type RuntimePluginEvidenceKind,
  type RuntimePluginEvidenceStatus,
  type RuntimePluginPolicyOutcome,
  type RuntimePluginSourceKind,
} from '../../plugins/api/index.ts';
import {
  createRoleModelCommitValidationSnapshot,
  isTerminalRawEventLogRecordKind,
  rawEventLogRecordKindValues,
  runtimeTurnStatusValues,
  type RawEventLogPayloadSummary,
  type RawEventLogRecord,
  type RawEventLogRecordKind,
  type RoleModelCommitValidationSnapshot,
  type RuntimeTurnStatus,
} from '../evidence/records.ts';
import {
  isOneOf,
  optionalCommittedMessage,
  optionalRecordBoolean,
  optionalRecordNumber,
  optionalRecordString,
  optionalStringArray,
  requiredArray,
  requiredBoundedJsonObject,
  requiredBoundedJsonValue,
  requiredLiteralString,
  requiredRecordNumber,
  requiredRecordStringAllowingEmpty,
  requiredRuntimeEventIdentity,
  requiredStringArray,
  throwMalformedRecord,
} from './codec-primitives.ts';
import {requiredDecisionContext} from './decision-context-codec.ts';
import {
  requiredRoleModelCommitValidationResult,
  requiredRoleModelDecisionResult,
} from './decision-result-codec.ts';
import {optionalRoleModelProviderMetadataOption} from './provider-metadata-codec.ts';
import {
  assertSessionContinuationRawEventSemantics,
  optionalSessionContinuationOption,
} from './session-continuation-codec.ts';
import {assertToolRawEventSemantics} from './raw-event-tool-semantics.ts';
import {
  isRecord,
  parseJsonObject,
  requiredRecordCanonicalTimestamp,
  requiredRecordString,
} from './layout-contract.ts';

const commitOwnedRoleModelRejectionReasons = [
  roleModelInvalidVisibleReplyRejectionReason,
  roleModelPluginToolRejectedRejectionReason,
  roleModelCommitValidationFailureRejectionReason,
] as const satisfies readonly RoleModelDecisionRejectionReason[];

export function encodeRawEventLogRecord(record: RawEventLogRecord): string {
  return JSON.stringify(record);
}

export function decodeRawEventLogRecord(line: string): RawEventLogRecord {
  const record = parseJsonObject(line, 'malformed_record');
  const {eventId, traceId, createdAt} = requiredRuntimeEventIdentity(record);
  const kind = requiredRawEventKind(record['kind']);
  const eventType = requiredRuntimeEventType(record['eventType']);
  const status = optionalRuntimeTurnStatus(record['status']);
  const reason = optionalRecordString(record, 'reason', 'malformed_record');
  const visibleMessageIds = optionalStringArray(
    record['visibleMessageIds'],
    'visibleMessageIds',
  );
  const committedMessage = optionalCommittedMessage(record);
  const toolCallIds = optionalStringArray(record['toolCallIds'], 'toolCallIds');
  const toolCallId = optionalRecordString(
    record,
    'toolCallId',
    'malformed_record',
  );
  const dispatchedToHost = optionalRecordBoolean(record, 'dispatchedToHost');
  const toolRound = optionalRecordNumber(record, 'toolRound');
  const toolName = optionalRecordString(record, 'toolName', 'malformed_record');
  const toolPluginId = optionalRecordString(
    record,
    'toolPluginId',
    'malformed_record',
  );
  const toolInput = optionalRuntimePluginJsonObject(record['toolInput']);
  const toolResult = optionalRuntimePluginToolCallResult(record['toolResult']);
  const pluginStoreRevision = optionalRecordNumber(
    record,
    'pluginStoreRevision',
  );
  const payloadSummary = optionalRawEventPayloadSummary(
    record['payloadSummary'],
  );
  const roleModelIOSnapshot = optionalRoleModelIOSnapshot(
    record['roleModelIOSnapshot'],
  );
  const parsedRoleModelDecisionSnapshot =
    optionalParsedRoleModelDecisionSnapshot(
      record['parsedRoleModelDecisionSnapshot'],
    );
  const commitValidation = optionalRoleModelCommitValidationSnapshot(
    record['commitValidation'],
  );
  const runtimePluginEvidence = optionalRuntimePluginEvidenceSnapshots(
    record['runtimePluginEvidence'],
  );
  const runtimePluginTurnEvidence = optionalRuntimePluginTurnEvidenceSnapshot(
    record['runtimePluginTurnEvidence'],
  );
  const runtimeConfigEffects = optionalPreparedRuntimePluginConfigEffects(
    record['runtimeConfigEffects'],
  );

  const sessionContinuation = optionalSessionContinuationOption(
    record['sessionContinuation'],
  );

  assertSessionContinuationRawEventSemantics({
    identity: {eventId, traceId, createdAt},
    kind,
    ...sessionContinuation,
  });
  assertTerminalRawEventSemantics({
    kind,
    status,
    visibleMessageIds,
  });
  assertToolRawEventSemantics({
    identity: {
      eventId,
      traceId,
      createdAt,
    },
    kind,
    toolCallId,
    dispatchedToHost,
    toolRound,
    toolName,
    toolPluginId,
    toolInput,
    toolResult,
  });
  assertRoleModelRawEventEvidenceSemantics({
    identity: {
      eventId,
      traceId,
      createdAt,
    },
    payloadSummary,
    kind,
    reason,
    status,
    roleModelIOSnapshot,
    parsedRoleModelDecisionSnapshot,
    commitValidation,
  });
  assertRuntimePluginEvidenceSemantics({
    identity: {
      eventId,
      traceId,
      createdAt,
    },
    runtimePluginEvidence,
    runtimePluginTurnEvidence,
  });
  assertRuntimeConfigEffectSemantics({
    identity: {eventId, traceId, createdAt},
    kind,
    toolCallIds,
    runtimeConfigEffects,
  });

  return Object.freeze({
    eventId,
    traceId,
    createdAt,
    kind,
    eventType,
    ...(status === undefined ? {} : {status}),
    ...(reason === undefined ? {} : {reason}),
    ...(visibleMessageIds === undefined ? {} : {visibleMessageIds}),
    ...committedMessage,
    ...(toolCallIds === undefined ? {} : {toolCallIds}),
    ...(toolCallId === undefined ? {} : {toolCallId}),
    ...(dispatchedToHost === undefined ? {} : {dispatchedToHost}),
    ...(toolRound === undefined ? {} : {toolRound}),
    ...(toolName === undefined ? {} : {toolName}),
    ...(toolPluginId === undefined ? {} : {toolPluginId}),
    ...(toolInput === undefined ? {} : {toolInput}),
    ...(toolResult === undefined ? {} : {toolResult}),
    ...(pluginStoreRevision === undefined ? {} : {pluginStoreRevision}),
    ...(payloadSummary === undefined ? {} : {payloadSummary}),
    ...(roleModelIOSnapshot === undefined ? {} : {roleModelIOSnapshot}),
    ...(parsedRoleModelDecisionSnapshot === undefined
      ? {}
      : {parsedRoleModelDecisionSnapshot}),
    ...(commitValidation === undefined ? {} : {commitValidation}),
    ...(runtimePluginEvidence === undefined ? {} : {runtimePluginEvidence}),
    ...(runtimePluginTurnEvidence === undefined
      ? {}
      : {runtimePluginTurnEvidence}),
    ...(runtimeConfigEffects === undefined ? {} : {runtimeConfigEffects}),
    ...sessionContinuation,
  } satisfies RawEventLogRecord);
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

function optionalRuntimeTurnStatus(
  value: unknown,
): RuntimeTurnStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (isOneOf(value, runtimeTurnStatusValues)) {
    return value;
  }

  throwMalformedRecord('status');
}

function requiredRuntimePluginEvidenceKind(
  value: unknown,
): RuntimePluginEvidenceKind {
  if (isOneOf(value, runtimePluginEvidenceKindValues)) {
    return value;
  }

  throwMalformedRecord('runtimePluginEvidence.evidenceKind');
}

function requiredRuntimePluginEvidenceStatus(
  value: unknown,
): RuntimePluginEvidenceStatus {
  if (isOneOf(value, runtimePluginEvidenceStatusValues)) {
    return value;
  }

  throwMalformedRecord('runtimePluginEvidence.status');
}

function optionalRuntimePluginPolicyOutcome(
  value: unknown,
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
  value: unknown,
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

  if (
    options.visibleMessageIds !== undefined &&
    options.visibleMessageIds.length === 0
  ) {
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

function optionalRawEventPayloadSummary(
  value: unknown,
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
    'normalizedCurrentUserMessage',
  );

  return Object.freeze({
    ...(rawInput === undefined ? {} : {rawInput}),
    ...(normalizedCurrentUserMessage === undefined
      ? {}
      : {normalizedCurrentUserMessage}),
  } satisfies RawEventLogPayloadSummary);
}

function optionalRoleModelIOSnapshot(
  value: unknown,
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
    'roleModelIOSnapshot.kind',
  );

  return createRoleModelIOSnapshot({
    eventId: requiredRecordString(value, 'eventId', 'malformed_record'),
    traceId: requiredRecordString(value, 'traceId', 'malformed_record'),
    createdAt: requiredRecordCanonicalTimestamp(
      value,
      'createdAt',
      'malformed_record',
    ),
    sessionId: requiredRecordString(value, 'sessionId', 'malformed_record'),
    inputEnvelope: requiredRoleModelInputEnvelope(value['inputEnvelope']),
    rawOutputText: requiredRecordStringAllowingEmpty(
      value,
      'rawOutputText',
      'malformed_record',
    ),
    ...optionalRoleModelCharacterRefOption(value['characterRef']),
    ...optionalRoleModelPromptSizeOption(value['promptSize']),
    ...optionalRoleModelProviderMetadataOption(value['providerMetadata']),
    ...optionalRoleModelProviderExchangeOption(value['providerExchange']),
  });
}

function optionalRoleModelPromptSizeOption(value: unknown): {
  readonly promptSize?: RoleModelPromptSize;
} {
  if (value === undefined) {
    return {};
  }

  try {
    return {promptSize: freezeRoleModelPromptSize(value)};
  } catch {
    throwMalformedRecord('promptSize');
  }
}

function optionalRoleModelCharacterRefOption(value: unknown): {
  readonly characterRef?: RoleModelCharacterRef;
} {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    throwMalformedRecord('characterRef');
  }

  return {
    characterRef: Object.freeze({
      id: requiredRecordString(value, 'id', 'malformed_record'),
      version: requiredRecordString(value, 'version', 'malformed_record'),
      personaFingerprint: requiredRecordString(
        value,
        'personaFingerprint',
        'malformed_record',
      ),
    } satisfies RoleModelCharacterRef),
  };
}

function optionalParsedRoleModelDecisionSnapshot(
  value: unknown,
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
    'parsedRoleModelDecisionSnapshot.kind',
  );

  return createParsedRoleModelDecisionSnapshot({
    eventId: requiredRecordString(value, 'eventId', 'malformed_record'),
    traceId: requiredRecordString(value, 'traceId', 'malformed_record'),
    createdAt: requiredRecordCanonicalTimestamp(
      value,
      'createdAt',
      'malformed_record',
    ),
    sessionId: requiredRecordString(value, 'sessionId', 'malformed_record'),
    result: requiredRoleModelDecisionResult(value['result']),
  });
}

function optionalRoleModelCommitValidationSnapshot(
  value: unknown,
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
    'commitValidation.kind',
  );

  return createRoleModelCommitValidationSnapshot({
    eventId: requiredRecordString(value, 'eventId', 'malformed_record'),
    traceId: requiredRecordString(value, 'traceId', 'malformed_record'),
    createdAt: requiredRecordCanonicalTimestamp(
      value,
      'createdAt',
      'malformed_record',
    ),
    sessionId: requiredRecordString(value, 'sessionId', 'malformed_record'),
    result: requiredRoleModelCommitValidationResult(value['result']),
  });
}

function optionalRuntimePluginEvidenceSnapshots(
  value: unknown,
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
  value: unknown,
): RuntimePluginJsonObject | undefined {
  return value === undefined
    ? undefined
    : requiredBoundedJsonObject(value, 'toolInput');
}

function optionalRuntimePluginToolCallResult(
  value: unknown,
): RuntimePluginToolCallResult | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    return createRuntimePluginToolCallResultSnapshot(value);
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      throwMalformedRecord('toolResult');
    }

    throw error;
  }
}

function optionalRuntimePluginTurnEvidenceSnapshot(
  value: unknown,
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

function optionalPreparedRuntimePluginConfigEffects(
  value: unknown,
): readonly PreparedRuntimePluginConfigEffect[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    const items = requiredArray(value, 'runtimeConfigEffects');

    if (items.length === 0 || items.length > 16) {
      throw new TypeError(
        'runtimeConfigEffects must contain between 1 and 16 records.',
      );
    }

    return Object.freeze(
      items.map(item => createPreparedRuntimePluginConfigEffect(item)),
    );
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      throwMalformedRecord('runtimeConfigEffects');
    }

    throw error;
  }
}

function assertRuntimeConfigEffectSemantics(options: {
  readonly identity: RuntimeEventIdentity;
  readonly kind: RawEventLogRecordKind;
  readonly toolCallIds: readonly string[] | undefined;
  readonly runtimeConfigEffects:
    readonly PreparedRuntimePluginConfigEffect[] | undefined;
}): void {
  if (options.runtimeConfigEffects === undefined) {
    return;
  }

  if (options.kind !== 'runtime_turn_completed') {
    throwMalformedRecord('runtimeConfigEffects');
  }

  for (const effect of options.runtimeConfigEffects) {
    if (
      effect.eventId !== options.identity.eventId ||
      effect.traceId !== options.identity.traceId ||
      effect.createdAt !== options.identity.createdAt ||
      !options.toolCallIds?.includes(effect.effectId)
    ) {
      throwMalformedRecord('runtimeConfigEffects');
    }
  }
}

function requiredRuntimePluginEvidenceSnapshot(
  value: unknown,
): RuntimePluginEvidenceSnapshot {
  if (!isRecord(value)) {
    throwMalformedRecord('runtimePluginEvidence');
  }

  requiredLiteralString(
    value,
    'kind',
    'runtime_plugin_evidence_snapshot',
    'runtimePluginEvidence.kind',
  );

  const sourceReferences = optionalRuntimePluginSourceReferences(
    value['sourceReferences'],
  );
  const policyOutcome = optionalRuntimePluginPolicyOutcome(
    value['policyOutcome'],
  );
  const configFingerprint = optionalRecordString(
    value,
    'configFingerprint',
    'malformed_record',
  );

  return createRuntimePluginEvidenceSnapshot({
    eventId: requiredRecordString(value, 'eventId', 'malformed_record'),
    traceId: requiredRecordString(value, 'traceId', 'malformed_record'),
    createdAt: requiredRecordCanonicalTimestamp(
      value,
      'createdAt',
      'malformed_record',
    ),
    kind: 'runtime_plugin_evidence_snapshot',
    pluginId: requiredRecordString(value, 'pluginId', 'malformed_record'),
    evidenceKind: requiredRuntimePluginEvidenceKind(value['evidenceKind']),
    status: requiredRuntimePluginEvidenceStatus(value['status']),
    summary: requiredRecordString(value, 'summary', 'malformed_record'),
    ...(policyOutcome === undefined ? {} : {policyOutcome}),
    ...(sourceReferences === undefined ? {} : {sourceReferences}),
    redactionLabels: requiredStringArray(
      value['redactionLabels'],
      'runtimePluginEvidence.redactionLabels',
    ),
    ...(configFingerprint === undefined ? {} : {configFingerprint}),
  });
}

function optionalRuntimePluginSourceReferences(
  value: unknown,
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
  value: unknown,
): RuntimePluginSourceReference {
  if (!isRecord(value)) {
    throwMalformedRecord('sourceReferences');
  }

  const title = optionalRecordString(value, 'title', 'malformed_record');
  const uri = optionalRecordString(value, 'uri', 'malformed_record');

  return Object.freeze({
    kind: requiredRuntimePluginSourceKind(value['kind']),
    id: requiredRecordString(value, 'id', 'malformed_record'),
    ...(title === undefined ? {} : {title}),
    ...(uri === undefined ? {} : {uri}),
  } satisfies RuntimePluginSourceReference);
}

function assertRuntimePluginEvidenceSemantics(options: {
  readonly identity: RuntimeEventIdentity;
  readonly runtimePluginEvidence:
    readonly RuntimePluginEvidenceSnapshot[] | undefined;
  readonly runtimePluginTurnEvidence:
    RuntimePluginTurnEvidenceSnapshot | undefined;
}): void {
  for (const snapshot of options.runtimePluginEvidence ?? []) {
    assertMatchingRoleModelIdentity({
      actual: snapshot,
      expected: options.identity,
      field: 'runtimePluginEvidence',
    });
  }

  if (options.runtimePluginTurnEvidence === undefined) {
    return;
  }

  assertMatchingRoleModelIdentity({
    actual: options.runtimePluginTurnEvidence,
    expected: options.identity,
    field: 'runtimePluginTurnEvidence',
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
    ParsedRoleModelDecisionSnapshot | undefined;
  readonly commitValidation: RoleModelCommitValidationSnapshot | undefined;
}): void {
  const roleModelEvidenceCount = [
    options.roleModelIOSnapshot,
    options.parsedRoleModelDecisionSnapshot,
  ].filter(value => value !== undefined).length;

  if (roleModelEvidenceCount === 0 && options.commitValidation === undefined) {
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
    field: 'roleModelIOSnapshot',
  });
  assertMatchingRoleModelIdentity({
    actual: roleModelIOSnapshot.inputEnvelope.event,
    expected: options.identity,
    field: 'roleModelIOSnapshot.inputEnvelope.event',
  });
  assertRoleModelInputTextMatchesPayloadSummary({
    payloadSummary: options.payloadSummary,
    inputText:
      roleModelIOSnapshot.inputEnvelope.event.payload.currentUserMessage,
  });
  assertMatchingRoleModelIdentity({
    actual: parsedRoleModelDecisionSnapshot,
    expected: options.identity,
    field: 'parsedRoleModelDecisionSnapshot',
  });
  assertMatchingRoleModelSession({
    actual: roleModelIOSnapshot.inputEnvelope.decisionContext.sessionId,
    expected: roleModelIOSnapshot.sessionId,
    field: 'roleModelIOSnapshot.inputEnvelope.decisionContext.sessionId',
  });
  assertMatchingRoleModelSession({
    actual: parsedRoleModelDecisionSnapshot.sessionId,
    expected: roleModelIOSnapshot.sessionId,
    field: 'parsedRoleModelDecisionSnapshot.sessionId',
  });
  assertParsedRoleModelDecisionMatchesRawOutput({
    roleModelIOSnapshot,
    parsedRoleModelDecisionSnapshot,
  });
  assertParsedRoleModelDecisionAllowedByEnvelope({
    roleModelIOSnapshot,
    parsedRoleModelDecisionSnapshot,
  });

  if (commitValidation === undefined) {
    if (options.kind !== 'tool_call_started') {
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
    field: 'commitValidation.sessionId',
  });
  assertMatchingRoleModelIdentity({
    actual: commitValidation,
    expected: options.identity,
    field: 'commitValidation',
  });
  assertRoleModelCommitStatusMatchesRawEvent({
    kind: options.kind,
    status: options.status,
    reason: options.reason,
    parsedRoleModelDecisionSnapshot,
    commitValidation,
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
    'roleModelIOSnapshot.inputEnvelope.event.payload.currentUserMessage',
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

  // Only visible_reply must be allowed when present: it commits without a
  // routing gate, unlike executable calls the router rejects pre-dispatch.
  const visibleReplyIsAllowed = parsedResult.decision.toolCalls.every(
    call =>
      call.name !== visibleReplyModelToolName ||
      options.roleModelIOSnapshot.inputEnvelope.allowedTools.includes(
        call.name,
      ),
  );

  if (!visibleReplyIsAllowed) {
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
      parsedDecision: parsedResult.decision,
    });

    if (
      options.kind !== 'visible_message_committed' &&
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
    commitValidation: options.commitValidation,
  });
}

function assertAcceptedCommitTextMatchesParsedDecision(options: {
  readonly actual: string | undefined;
  readonly parsedDecision: CharacterDecision;
}): void {
  const parsedTexts = visibleReplyToolCalls(options.parsedDecision).map(
    call => call.input.text,
  );

  if (parsedTexts.length === 0 || options.actual === undefined) {
    if (parsedTexts.length === 0 && options.actual === undefined) {
      return;
    }

    throwMalformedRecord('commitValidation.result.acceptedVisibleReplyText');
  }

  let normalizedTexts: readonly string[];

  try {
    normalizedTexts = parsedTexts.map(text =>
      normalizeVisibleMessageText(text),
    );
  } catch (error: unknown) {
    if (error instanceof VisibleMessageTextValidationError) {
      throwMalformedRecord(
        'parsedRoleModelDecisionSnapshot.result.decision.action.text',
      );
    }

    throw error;
  }

  if (!normalizedTexts.includes(options.actual)) {
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
      commitOwnedRoleModelRejectionReasons,
    )
  ) {
    throwMalformedRecord('commitValidation.result.rejection.reason');
  }

  if (
    commitResult.rejection.reason ===
    roleModelInvalidVisibleReplyRejectionReason
  ) {
    assertParsedDecisionTextFailsCommitValidation(
      getRequiredVisibleReplyText(parsedResult.decision),
    );
  }
}

function assertParsedDecisionTextFailsCommitValidation(
  parsedDecisionText: string,
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
  value: unknown,
): RoleModelInputEnvelope {
  if (!isRecord(value)) {
    throwMalformedRecord('roleModelInputEnvelope');
  }
  const allowedTools = requiredRoleModelAllowedTools(value['allowedTools']);
  const pluginToolDefinitions = requiredRoleModelPluginToolDefinitions(
    value['pluginToolDefinitions'],
  );

  try {
    return createRoleModelInputEnvelope({
      event: requiredUserMessageRuntimeEvent(value['event']),
      decisionContext: requiredDecisionContext(value['decisionContext']),
      allowedTools,
      pluginToolDefinitions,
      toolObservations: optionalRoleModelToolObservations(
        value['toolObservations'],
      ),
      outputContract: requiredRoleModelOutputContract(value['outputContract']),
    });
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      throwMalformedRecord('roleModelInputEnvelope');
    }

    throw error;
  }
}

function requiredUserMessageRuntimeEvent(
  value: unknown,
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
      'malformed_record',
    ),
    type: requiredRuntimeEventType(value['type']),
    payload: Object.freeze({
      currentUserMessage: requiredRecordString(
        payload,
        'currentUserMessage',
        'malformed_record',
      ),
    }),
  } satisfies UserMessageRuntimeEvent);
}

// Every envelope the runtime writes carries this array, empty or not, so
// an absent one is a damaged record rather than an older shape.
function requiredRoleModelPluginToolDefinitions(
  value: unknown,
): readonly RoleModelPluginToolDefinition[] {
  const definitions: RoleModelPluginToolDefinition[] = [];

  for (const item of requiredArray(value, 'pluginToolDefinitions')) {
    if (!isRecord(item)) {
      throwMalformedRecord('pluginToolDefinitions');
    }

    const pluginId = requiredRecordString(item, 'pluginId', 'malformed_record');

    try {
      definitions.push(
        Object.freeze({
          pluginId,
          ...createRuntimePluginProvidedTool(item),
        } satisfies RoleModelPluginToolDefinition),
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
  value: unknown,
): readonly RoleModelToolObservation[] {
  if (value === undefined) {
    return Object.freeze([]);
  }

  const observations: RoleModelToolObservation[] = [];

  for (const item of requiredArray(value, 'toolObservations')) {
    if (!isRecord(item)) {
      throwMalformedRecord('toolObservations');
    }

    try {
      observations.push(
        createRoleModelToolObservation({
          round: requiredRecordNumber(item, 'round', 'malformed_record'),
          pluginId: requiredRecordString(item, 'pluginId', 'malformed_record'),
          toolName: requiredRecordString(item, 'toolName', 'malformed_record'),
          input: requiredBoundedJsonObject(
            item['input'],
            'toolObservations.input',
          ),
          result: requiredRoleModelToolObservationResult(item['result']),
        }),
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
  value: unknown,
): RoleModelToolObservation['result'] {
  if (!isRecord(value)) {
    throwMalformedRecord('toolObservations.result');
  }

  const status = requiredRecordString(value, 'status', 'malformed_record');

  if (status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      output: requiredBoundedJsonValue(
        value['output'],
        'toolObservations.result.output',
      ),
    } satisfies RoleModelToolObservation['result']);
  }

  if (status === 'rejected') {
    return Object.freeze({
      status: 'rejected',
      reason: requiredRecordString(value, 'reason', 'malformed_record'),
      message: requiredRecordString(value, 'message', 'malformed_record'),
    } satisfies RoleModelToolObservation['result']);
  }

  throwMalformedRecord('toolObservations.result.status');
}

function requiredRoleModelAllowedTools(
  value: unknown,
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
  value: unknown,
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
    text: requiredRecordString(value, 'text', 'malformed_record'),
  } satisfies RoleModelOutputContract);
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
    providerExchange,
  };
}

/**
 * Stored JSON is corruption-controlled input, so every decoded value passes
 * the same depth, node, entry, and byte limits a live tool call would.
 */

function optionalPayloadSummaryString(
  record: Record<string, unknown>,
  key: string,
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
