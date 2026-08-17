import {
  type RuntimeEventIdentity,
  type RuntimeEventType,
  runtimeEventTypeValues,
  type UserMessageRuntimeEvent,
} from '../../core/index.ts';
import {
  createParsedRoleModelDecisionSnapshot,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot,
  freezeRoleModelPromptSize,
  parseRoleModelProviderExchangeSnapshot,
  roleModelDecisionContractVersion,
  type ParsedRoleModelDecisionSnapshot,
  type RoleModelPluginToolDefinition,
  type RoleModelInputEnvelope,
  type RoleModelCharacterRef,
  type RoleModelIOSnapshot,
  type RoleModelOutputContract,
  type RoleModelPromptSize,
  type RoleModelProviderExchangeSnapshot,
} from '../../role-model/index.ts';
import {
  createRuntimePluginEvidenceSnapshot,
  createRuntimePluginProvidedTool,
  createRuntimePluginToolCallResultSnapshot,
  createRuntimePluginTurnEvidenceSnapshot,
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
  runtimeTurnRejectionReasonValues,
  runtimeTurnStatusValues,
  type RawEventLogPayloadSummary,
  type RawEventLogRecord,
  type RawEventLogRecordKind,
  type RoleModelCommitValidationSnapshot,
  type RuntimeTurnRejectionReason,
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
  requiredLiteralString,
  requiredRecordStringAllowingEmpty,
  requiredRuntimeEventIdentity,
  requiredStringArray,
  throwMalformedRecord,
  sameOrderedValues,
} from './codec-primitives.ts';
import {requiredConversationToolRounds} from './conversation-turn-codec.ts';
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
import {assertRoundRawEventSemantics} from './raw-event-round-semantics.ts';
import {assertToolRawEventSemantics} from './raw-event-tool-semantics.ts';
import {
  isRecord,
  parseJsonObject,
  requiredRecordCanonicalTimestamp,
  requiredRecordString,
} from './layout-contract.ts';

export function encodeRawEventLogRecord(record: RawEventLogRecord): string {
  return JSON.stringify(record);
}

export function decodeRawEventLogRecord(line: string): RawEventLogRecord {
  const record = parseJsonObject(line, 'malformed_record');
  const {eventId, traceId, createdAt} = requiredRuntimeEventIdentity(record);
  const kind = requiredRawEventKind(record['kind']);
  const eventType = requiredRuntimeEventType(record['eventType']);
  const status = optionalRuntimeTurnStatus(record['status']);
  const reason = optionalRuntimeTurnRejectionReason(record['reason']);
  const message = optionalRecordString(record, 'message', 'malformed_record');
  const round = optionalRecordNumber(record, 'round');
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
    round,
    toolName,
    toolPluginId,
    toolInput,
    toolResult,
  });
  assertRoundRawEventSemantics({
    identity: {
      eventId,
      traceId,
      createdAt,
    },
    kind,
    status,
    reason,
    message,
    round,
    visibleMessage: committedMessage.visibleMessage,
    payloadSummary,
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
  return Object.freeze({
    eventId,
    traceId,
    createdAt,
    kind,
    eventType,
    ...(status === undefined ? {} : {status}),
    ...(reason === undefined ? {} : {reason}),
    ...(message === undefined ? {} : {message}),
    ...(visibleMessageIds === undefined ? {} : {visibleMessageIds}),
    ...committedMessage,
    ...(round === undefined ? {} : {round}),
    ...(toolCallIds === undefined ? {} : {toolCallIds}),
    ...(toolCallId === undefined ? {} : {toolCallId}),
    ...(dispatchedToHost === undefined ? {} : {dispatchedToHost}),
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

function optionalRuntimeTurnRejectionReason(
  value: unknown,
): RuntimeTurnRejectionReason | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (isOneOf(value, runtimeTurnRejectionReasonValues)) {
    return value;
  }

  throwMalformedRecord('reason');
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

function requiredRoleModelInputEnvelope(
  value: unknown,
): RoleModelInputEnvelope {
  if (!isRecord(value)) {
    throwMalformedRecord('roleModelInputEnvelope');
  }
  const storedAllowedTools = requiredStringArray(
    value['allowedTools'],
    'allowedTools',
  );
  const pluginToolDefinitions = requiredRoleModelPluginToolDefinitions(
    value['pluginToolDefinitions'],
  );
  let envelope: RoleModelInputEnvelope;

  try {
    envelope = createRoleModelInputEnvelope({
      event: requiredUserMessageRuntimeEvent(value['event']),
      decisionContext: requiredDecisionContext(value['decisionContext']),
      pluginToolDefinitions,
      // Every envelope the runtime writes carries this array, so an absent one
      // is damage, not an older record.
      toolRounds: requiredConversationToolRounds(value['toolRounds']),
      outputContract: requiredRoleModelOutputContract(value['outputContract']),
    });
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      throwMalformedRecord('roleModelInputEnvelope');
    }

    throw error;
  }

  // What was offered is derived from the tools, so a stored list can only
  // agree with it; anything else is a tampered record.
  if (!sameOrderedValues(envelope.allowedTools, storedAllowedTools)) {
    throwMalformedRecord('allowedTools');
  }

  return envelope;
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
