import { join } from 'node:path';

import type {
  CharacterProfile,
  VisibleMessage,
  VisibleMessageRole
} from './conversation.ts';
import {
  characterRuntimeStatesEqual,
  createLivingStateBrief,
  createCharacterStatePatchSnapshot,
  decodeCharacterRuntimeState,
  planCharacterStatePatch,
  type AcceptedCharacterStatePatchResult,
  type CharacterRuntimeState,
  type CharacterStateAppliedChange,
  type CharacterStatePatch,
  type CharacterStatePatchRejection,
  type CharacterStatePatchRejectionReason,
  type CharacterStatePatchResult,
  type CharacterStatePatchSnapshot,
  type LivingStateBrief,
  type RejectedCharacterStatePatchResult
} from './character-state.ts';
import {
  normalizeOneLineMessage,
  OneLineMessageValidationError
} from './message-validation.ts';
import type {
  RuntimeEventIdentity,
  RuntimeEventType,
  UserMessageRuntimeEvent
} from './runtime-event.ts';
import {
  createAcceptedRoleModelDecisionResult,
  createDecisionContext,
  createParsedRoleModelDecisionSnapshot,
  createRejectedRoleModelDecisionResult,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot,
  getCharacterStatePatchToolCall,
  getRequiredVisibleReplyText,
  isRoleModelAllowedToolName,
  parseRoleModelDecision,
  roleModelAdapterRawOutputMissingTextRejectionDetails,
  roleModelCommitValidationFailureRejectionReason,
  roleModelDecisionContractVersion,
  roleModelLegacyDecisionContractVersion,
  roleModelDecisionRejectionReasons,
  roleModelInvalidCharacterStatePatchRejectionReason,
  roleModelInvalidVisibleReplyRejectionReason,
  roleModelMalformedOutputRejectionReason,
  roleModelProviderErrorRejectionReason,
  type CharacterDecision,
  type DecisionContext,
  type ParsedRoleModelDecisionSnapshot,
  type RoleModelAllowedToolName,
  type RoleModelDecisionRejection,
  type RoleModelDecisionRejectionReason,
  type RoleModelDecisionResult,
  type RoleModelInputEnvelope,
  type RoleModelIOSnapshot,
  type RoleModelOutputContract,
  type RoleModelProviderMetadata
} from './role-model-contracts.ts';
import {
  createRoleModelCommitValidationSnapshot,
  isTerminalRawEventLogRecordKind,
  type AcceptedRoleModelCommitValidationResult,
  type ConversationLogRecord,
  type RawEventLogPayloadSummary,
  type RawEventLogRecord,
  type RawEventLogRecordKind,
  type RejectedRoleModelCommitValidationResult,
  type RoleModelCommitValidationResult,
  type RoleModelCommitValidationSnapshot,
  type RuntimeTraceEntry,
  type RuntimeTraceStepName,
  type RuntimeTurnStatus
} from './runtime-log.ts';

export const defaultLocalRuntimeStoreRoot = '.project02-runtime';
export const defaultLocalRuntimeSessionId = 'local-session';
export const localRuntimeStorageSchemaVersion = 1;

export type LocalRuntimeStorageContractErrorCode =
  | 'invalid_session_id'
  | 'malformed_record'
  | 'malformed_schema_marker'
  | 'missing_file'
  | 'partial_write'
  | 'read_failed'
  | 'unsupported_schema_version'
  | 'write_failed';

export class LocalRuntimeStorageContractError extends Error {
  readonly code: LocalRuntimeStorageContractErrorCode;

  constructor(code: LocalRuntimeStorageContractErrorCode, message: string) {
    super(message);
    this.name = 'LocalRuntimeStorageContractError';
    this.code = code;
  }
}

export type LocalRuntimeStorageLayout = {
  readonly storeRoot: string;
  readonly schemaPath: string;
  readonly sessionCatalogPath: string;
  readonly sessionsRoot: string;
};

export type LocalRuntimeSessionPaths = {
  readonly sessionId: string;
  readonly sessionRoot: string;
  readonly tracePath: string;
  readonly rawEventsPath: string;
  readonly conversationPath: string;
  readonly characterStatePath: string;
};

export type LocalRuntimeStorageLayoutOptions = {
  readonly storeRoot?: string;
};

export type LocalRuntimeSessionPathsOptions = LocalRuntimeStorageLayoutOptions & {
  readonly sessionId?: string;
};

export type LocalRuntimeStorageSchemaMarker = {
  readonly schemaVersion: typeof localRuntimeStorageSchemaVersion;
  readonly createdAt: string;
};

export type CreateLocalRuntimeStorageSchemaMarkerOptions = {
  readonly createdAt: string;
};

export type LocalRuntimeSessionMetadata = {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type CreateLocalRuntimeSessionMetadataOptions = {
  readonly sessionId?: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
};

const schemaFileName = 'schema.json';
const sessionCatalogFileName = 'sessions.jsonl';
const sessionsDirectoryName = 'sessions';
const traceFileName = 'trace.jsonl';
const rawEventsFileName = 'raw-events.jsonl';
const conversationFileName = 'conversation.jsonl';
const characterStateFileName = 'character-state.json';

const runtimeTraceSteps = [
  'runtime_event_received',
  'runtime_event_normalized',
  'runtime_turn_started',
  'visible_reply_committed',
  'input_validation_rejected',
  'character_reply_rejected',
  'commit_validation_rejected',
  'raw_event_log_appended',
  'runtime_turn_completed',
  'runtime_turn_rejected'
] as const satisfies readonly RuntimeTraceStepName[];

const rawEventKinds = [
  'runtime_event_received',
  'runtime_event_normalized',
  'visible_reply_committed',
  'input_validation_rejected',
  'character_reply_rejected',
  'commit_validation_rejected',
  'runtime_turn_completed',
  'runtime_turn_rejected'
] as const satisfies readonly RawEventLogRecordKind[];

const runtimeTurnStatuses = [
  'completed',
  'rejected'
] as const satisfies readonly RuntimeTurnStatus[];

const visibleMessageRoles = ['user', 'character'] as const satisfies readonly VisibleMessageRole[];
const runtimeEventTypes = ['USER_MESSAGE'] as const satisfies readonly RuntimeEventType[];
const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const commitOwnedRoleModelRejectionReasons = [
  roleModelInvalidVisibleReplyRejectionReason,
  roleModelInvalidCharacterStatePatchRejectionReason,
  roleModelCommitValidationFailureRejectionReason
] as const satisfies readonly RoleModelDecisionRejectionReason[];

export function createLocalRuntimeStorageLayout(
  options: LocalRuntimeStorageLayoutOptions = {}
): LocalRuntimeStorageLayout {
  const storeRoot = normalizeStoreRoot(options.storeRoot);
  const sessionsRoot = join(storeRoot, sessionsDirectoryName);

  return Object.freeze({
    storeRoot,
    schemaPath: join(storeRoot, schemaFileName),
    sessionCatalogPath: join(storeRoot, sessionCatalogFileName),
    sessionsRoot
  } satisfies LocalRuntimeStorageLayout);
}

export function createLocalRuntimeSessionPaths(
  options: LocalRuntimeSessionPathsOptions = {}
): LocalRuntimeSessionPaths {
  const layout = createLocalRuntimeStorageLayout(options);
  const sessionId = normalizeLocalRuntimeSessionId(options.sessionId);
  const sessionRoot = join(layout.sessionsRoot, sessionId);

  return Object.freeze({
    sessionId,
    sessionRoot,
    tracePath: join(sessionRoot, traceFileName),
    rawEventsPath: join(sessionRoot, rawEventsFileName),
    conversationPath: join(sessionRoot, conversationFileName),
    characterStatePath: join(sessionRoot, characterStateFileName)
  } satisfies LocalRuntimeSessionPaths);
}

export function normalizeLocalRuntimeSessionId(sessionId: string | undefined): string {
  const normalizedSessionId = sessionId?.trim() ?? defaultLocalRuntimeSessionId;

  if (normalizedSessionId.length === 0) {
    throw new LocalRuntimeStorageContractError(
      'invalid_session_id',
      'Local runtime session ID must be non-empty.'
    );
  }

  if (
    normalizedSessionId === '.' ||
    normalizedSessionId === '..' ||
    !sessionIdPattern.test(normalizedSessionId)
  ) {
    throw new LocalRuntimeStorageContractError(
      'invalid_session_id',
      'Local runtime session ID must use only letters, numbers, dots, underscores, or hyphens.'
    );
  }

  return normalizedSessionId;
}

export function createLocalRuntimeSessionMetadata(
  options: CreateLocalRuntimeSessionMetadataOptions
): LocalRuntimeSessionMetadata {
  return Object.freeze({
    sessionId: normalizeLocalRuntimeSessionId(options.sessionId),
    createdAt: requiredNonEmptyString(options.createdAt, 'createdAt', 'malformed_record'),
    updatedAt: requiredNonEmptyString(
      options.updatedAt ?? options.createdAt,
      'updatedAt',
      'malformed_record'
    )
  } satisfies LocalRuntimeSessionMetadata);
}

export function createLocalRuntimeStorageSchemaMarker(
  options: CreateLocalRuntimeStorageSchemaMarkerOptions
): LocalRuntimeStorageSchemaMarker {
  return Object.freeze({
    schemaVersion: localRuntimeStorageSchemaVersion,
    createdAt: requiredNonEmptyString(options.createdAt, 'createdAt', 'malformed_schema_marker')
  } satisfies LocalRuntimeStorageSchemaMarker);
}

export function encodeStorageSchemaMarker(marker: LocalRuntimeStorageSchemaMarker): string {
  return JSON.stringify(marker);
}

export function decodeStorageSchemaMarker(line: string): LocalRuntimeStorageSchemaMarker {
  const record = parseJsonObject(line, 'malformed_schema_marker');
  const schemaVersion = record['schemaVersion'];

  if (typeof schemaVersion !== 'number') {
    throwMalformedSchemaMarker('schemaVersion');
  }

  if (schemaVersion !== localRuntimeStorageSchemaVersion) {
    throw new LocalRuntimeStorageContractError(
      'unsupported_schema_version',
      `Unsupported local runtime storage schema version: ${String(schemaVersion)}.`
    );
  }

  return Object.freeze({
    schemaVersion: localRuntimeStorageSchemaVersion,
    createdAt: requiredRecordString(record, 'createdAt', 'malformed_schema_marker')
  } satisfies LocalRuntimeStorageSchemaMarker);
}

export function encodeRuntimeTraceEntry(entry: RuntimeTraceEntry): string {
  return JSON.stringify(entry);
}

export function decodeRuntimeTraceEntry(line: string): RuntimeTraceEntry {
  const record = parseJsonObject(line, 'malformed_record');

  return Object.freeze({
    eventId: requiredRecordString(record, 'eventId', 'malformed_record'),
    traceId: requiredRecordString(record, 'traceId', 'malformed_record'),
    createdAt: requiredRecordString(record, 'createdAt', 'malformed_record'),
    step: requiredRuntimeTraceStep(record['step'])
  } satisfies RuntimeTraceEntry);
}

export function encodeRawEventLogRecord(record: RawEventLogRecord): string {
  return JSON.stringify(record);
}

export function decodeRawEventLogRecord(line: string): RawEventLogRecord {
  const record = parseJsonObject(line, 'malformed_record');
  const eventId = requiredRecordString(record, 'eventId', 'malformed_record');
  const traceId = requiredRecordString(record, 'traceId', 'malformed_record');
  const createdAt = requiredRecordString(record, 'createdAt', 'malformed_record');
  const kind = requiredRawEventKind(record['kind']);
  const eventType = requiredRuntimeEventType(record['eventType']);
  const status = optionalRuntimeTurnStatus(record['status']);
  const reason = optionalRecordString(record, 'reason', 'malformed_record');
  const visibleMessageIds = optionalStringArray(record['visibleMessageIds'], 'visibleMessageIds');
  const payloadSummary = optionalRawEventPayloadSummary(record['payloadSummary']);
  const roleModelIOSnapshot = optionalRoleModelIOSnapshot(
    record['roleModelIOSnapshot']
  );
  const parsedRoleModelDecisionSnapshot =
    optionalParsedRoleModelDecisionSnapshot(
      record['parsedRoleModelDecisionSnapshot']
    );
  const commitValidation = optionalRoleModelCommitValidationSnapshot(
    record['commitValidation']
  );
  const characterStatePatchSnapshot = optionalCharacterStatePatchSnapshot(
    record['characterStatePatchSnapshot']
  );

  assertTerminalRawEventSemantics({
    kind,
    status,
    visibleMessageIds
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
  assertCharacterStatePatchEvidenceSemantics({
    identity: {
      eventId,
      traceId,
      createdAt
    },
    kind,
    reason,
    status,
    commitValidation,
    roleModelIOSnapshot,
    parsedRoleModelDecisionSnapshot,
    characterStatePatchSnapshot
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
    ...(payloadSummary === undefined ? {} : { payloadSummary }),
    ...(roleModelIOSnapshot === undefined ? {} : { roleModelIOSnapshot }),
    ...(parsedRoleModelDecisionSnapshot === undefined
      ? {}
      : { parsedRoleModelDecisionSnapshot }),
    ...(commitValidation === undefined ? {} : { commitValidation }),
    ...(characterStatePatchSnapshot === undefined
      ? {}
      : { characterStatePatchSnapshot })
  } satisfies RawEventLogRecord);
}

export function encodeConversationLogRecord(record: ConversationLogRecord): string {
  return JSON.stringify(record);
}

export function decodeConversationLogRecord(line: string): ConversationLogRecord {
  const record = parseJsonObject(line, 'malformed_record');

  return Object.freeze({
    eventId: requiredRecordString(record, 'eventId', 'malformed_record'),
    traceId: requiredRecordString(record, 'traceId', 'malformed_record'),
    createdAt: requiredRecordString(record, 'createdAt', 'malformed_record'),
    id: requiredRecordString(record, 'id', 'malformed_record'),
    role: requiredVisibleMessageRole(record['role']),
    speakerId: requiredRecordString(record, 'speakerId', 'malformed_record'),
    speakerName: requiredRecordString(record, 'speakerName', 'malformed_record'),
    text: requiredNormalizedVisibleMessageText(record, 'text'),
    committedAt: requiredRecordString(record, 'committedAt', 'malformed_record')
  } satisfies ConversationLogRecord);
}

function normalizeStoreRoot(storeRoot: string | undefined): string {
  const normalizedStoreRoot = storeRoot?.trim() ?? defaultLocalRuntimeStoreRoot;

  if (normalizedStoreRoot.length === 0) {
    throw new LocalRuntimeStorageContractError(
      'malformed_schema_marker',
      'Local runtime store root must be non-empty.'
    );
  }

  return normalizedStoreRoot;
}

function parseJsonObject(
  line: string,
  code: 'malformed_record' | 'malformed_schema_marker'
): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new LocalRuntimeStorageContractError(code, 'Stored local runtime record is not valid JSON.');
  }

  if (!isRecord(parsed)) {
    throw new LocalRuntimeStorageContractError(code, 'Stored local runtime record must be an object.');
  }

  return parsed;
}

function requiredRecordString(
  record: Record<string, unknown>,
  key: string,
  code: LocalRuntimeStorageContractErrorCode
): string {
  return requiredNonEmptyString(record[key], key, code);
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

function requiredNormalizedVisibleMessageText(
  record: Record<string, unknown>,
  key: string
): string {
  const value = requiredRecordString(record, key, 'malformed_record');
  let normalizedValue: string;

  try {
    normalizedValue = normalizeOneLineMessage(value);
  } catch (error: unknown) {
    if (error instanceof OneLineMessageValidationError) {
      throwMalformedRecord(key);
    }

    throw error;
  }

  if (normalizedValue !== value) {
    throwMalformedRecord(key);
  }

  return value;
}

function requiredNonEmptyString(
  value: unknown,
  key: string,
  code: LocalRuntimeStorageContractErrorCode
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LocalRuntimeStorageContractError(
      code,
      `Stored local runtime field "${key}" must be a non-empty string.`
    );
  }

  return value;
}

function requiredRuntimeTraceStep(value: unknown): RuntimeTraceStepName {
  if (isOneOf(value, runtimeTraceSteps)) {
    return value;
  }

  throwMalformedRecord('step');
}

function requiredRawEventKind(value: unknown): RawEventLogRecordKind {
  if (isOneOf(value, rawEventKinds)) {
    return value;
  }

  throwMalformedRecord('kind');
}

function requiredRuntimeEventType(value: unknown): RuntimeEventType {
  if (isOneOf(value, runtimeEventTypes)) {
    return value;
  }

  throwMalformedRecord('eventType');
}

function requiredVisibleMessageRole(value: unknown): VisibleMessageRole {
  if (isOneOf(value, visibleMessageRoles)) {
    return value;
  }

  throwMalformedRecord('role');
}

function optionalRuntimeTurnStatus(value: unknown): RuntimeTurnStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (isOneOf(value, runtimeTurnStatuses)) {
    return value;
  }

  throwMalformedRecord('status');
}

function assertTerminalRawEventSemantics(options: {
  readonly kind: RawEventLogRecordKind;
  readonly status: RuntimeTurnStatus | undefined;
  readonly visibleMessageIds: readonly string[] | undefined;
}): void {
  if (!isTerminalRawEventLogRecordKind(options.kind)) {
    return;
  }

  if (options.kind === 'runtime_turn_completed') {
    if (options.status !== 'completed') {
      throwMalformedRecord('status');
    }

    if (
      options.visibleMessageIds === undefined ||
      options.visibleMessageIds.length === 0
    ) {
      throwMalformedRecord('visibleMessageIds');
    }

    return;
  }

  if (options.status !== 'rejected') {
    throwMalformedRecord('status');
  }

  if (options.visibleMessageIds !== undefined) {
    throwMalformedRecord('visibleMessageIds');
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
    createdAt: requiredRecordString(value, 'createdAt', 'malformed_record'),
    sessionId: requiredRecordString(value, 'sessionId', 'malformed_record'),
    inputEnvelope: requiredRoleModelInputEnvelope(value['inputEnvelope']),
    rawOutputText: requiredRecordStringAllowingEmpty(
      value,
      'rawOutputText',
      'malformed_record'
    ),
    ...optionalRoleModelProviderMetadataOption(value['providerMetadata'])
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
    createdAt: requiredRecordString(value, 'createdAt', 'malformed_record'),
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
    createdAt: requiredRecordString(value, 'createdAt', 'malformed_record'),
    sessionId: requiredRecordString(value, 'sessionId', 'malformed_record'),
    result: requiredRoleModelCommitValidationResult(value['result'])
  });
}

function optionalCharacterStatePatchSnapshot(
  value: unknown
): CharacterStatePatchSnapshot | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throwMalformedRecord('characterStatePatchSnapshot');
  }

  requiredLiteralString(
    value,
    'kind',
    'character_state_patch_snapshot',
    'characterStatePatchSnapshot.kind'
  );

  return createCharacterStatePatchSnapshot({
    eventId: requiredRecordString(value, 'eventId', 'malformed_record'),
    traceId: requiredRecordString(value, 'traceId', 'malformed_record'),
    createdAt: requiredRecordString(value, 'createdAt', 'malformed_record'),
    sessionId: requiredRecordString(value, 'sessionId', 'malformed_record'),
    result: requiredCharacterStatePatchResult(value['result'])
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
  const evidenceCount = [
    options.roleModelIOSnapshot,
    options.parsedRoleModelDecisionSnapshot,
    options.commitValidation
  ].filter((value) => value !== undefined).length;

  if (evidenceCount === 0) {
    return;
  }

  if (
    options.roleModelIOSnapshot === undefined ||
    options.parsedRoleModelDecisionSnapshot === undefined ||
    options.commitValidation === undefined
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
  assertMatchingRoleModelIdentity({
    actual: commitValidation,
    expected: options.identity,
    field: 'commitValidation'
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
  assertMatchingRoleModelSession({
    actual: commitValidation.sessionId,
    expected: roleModelIOSnapshot.sessionId,
    field: 'commitValidation.sessionId'
  });
  assertParsedRoleModelDecisionMatchesRawOutput({
    roleModelIOSnapshot,
    parsedRoleModelDecisionSnapshot
  });
  assertParsedRoleModelDecisionAllowedByEnvelope({
    roleModelIOSnapshot,
    parsedRoleModelDecisionSnapshot
  });
  assertRoleModelCommitStatusMatchesRawEvent({
    kind: options.kind,
    status: options.status,
    reason: options.reason,
    parsedRoleModelDecisionSnapshot,
    commitValidation
  });
}

function assertCharacterStatePatchEvidenceSemantics(options: {
  readonly identity: RuntimeEventIdentity;
  readonly kind: RawEventLogRecordKind;
  readonly status: RuntimeTurnStatus | undefined;
  readonly reason: string | undefined;
  readonly commitValidation: RoleModelCommitValidationSnapshot | undefined;
  readonly roleModelIOSnapshot: RoleModelIOSnapshot | undefined;
  readonly parsedRoleModelDecisionSnapshot:
    | ParsedRoleModelDecisionSnapshot
    | undefined;
  readonly characterStatePatchSnapshot: CharacterStatePatchSnapshot | undefined;
}): void {
  if (options.characterStatePatchSnapshot === undefined) {
    return;
  }

  const snapshot = options.characterStatePatchSnapshot;

  assertMatchingRoleModelIdentity({
    actual: snapshot,
    expected: options.identity,
    field: 'characterStatePatchSnapshot'
  });

  assertMatchingRoleModelSession({
    actual: snapshot.sessionId,
    expected: requiredPatchEvidenceRoleModelSessionId(
      options.roleModelIOSnapshot
    ),
    field: 'characterStatePatchSnapshot.sessionId'
  });

  const result = snapshot.result;

  if (result.status === 'accepted') {
    if (
      options.kind !== 'visible_reply_committed' &&
      options.kind !== 'runtime_turn_completed'
    ) {
      throwMalformedRecord('characterStatePatchSnapshot');
    }

    if (
      options.kind === 'runtime_turn_completed' &&
      options.status !== 'completed'
    ) {
      throwMalformedRecord('characterStatePatchSnapshot.result.status');
    }

    if (options.commitValidation?.result.status !== 'accepted') {
      throwMalformedRecord('commitValidation.result.status');
    }

    assertAcceptedCharacterStatePatchMatchesParsedToolCall({
      parsedRoleModelDecisionSnapshot: options.parsedRoleModelDecisionSnapshot,
      snapshot
    });

    return;
  }

  if (
    options.kind !== 'commit_validation_rejected' &&
    options.kind !== 'runtime_turn_rejected'
  ) {
    throwMalformedRecord('characterStatePatchSnapshot');
  }

  if (
    options.kind === 'runtime_turn_rejected' &&
    options.status !== 'rejected'
  ) {
    throwMalformedRecord('characterStatePatchSnapshot.result.status');
  }

  if (options.reason !== roleModelInvalidCharacterStatePatchRejectionReason) {
    throwMalformedRecord('reason');
  }

  if (
    options.commitValidation?.result.status !== 'rejected' ||
    options.commitValidation.result.rejection.reason !==
      roleModelInvalidCharacterStatePatchRejectionReason
  ) {
    throwMalformedRecord('commitValidation.result.rejection.reason');
  }

  assertRejectedCharacterStatePatchMatchesParsedToolCall({
    parsedRoleModelDecisionSnapshot: options.parsedRoleModelDecisionSnapshot,
    snapshot
  });
}

function requiredPatchEvidenceRoleModelSessionId(
  roleModelIOSnapshot: RoleModelIOSnapshot | undefined
): string {
  if (roleModelIOSnapshot !== undefined) {
    return roleModelIOSnapshot.sessionId;
  }

  throwMalformedRecord('characterStatePatchSnapshot.sessionId');
}

function assertAcceptedCharacterStatePatchMatchesParsedToolCall(options: {
  readonly parsedRoleModelDecisionSnapshot:
    | ParsedRoleModelDecisionSnapshot
    | undefined;
  readonly snapshot: CharacterStatePatchSnapshot;
}): void {
  const actualResult = options.snapshot.result;

  if (actualResult.status !== 'accepted') {
    throwMalformedRecord('characterStatePatchSnapshot.result.status');
  }

  const expectedResult = expectedCharacterStatePatchResultFromParsedToolCall({
    parsedRoleModelDecisionSnapshot: options.parsedRoleModelDecisionSnapshot,
    before: actualResult.before
  });

  if (
    expectedResult.status !== 'accepted' ||
    !acceptedCharacterStatePatchResultsEqual(actualResult, expectedResult)
  ) {
    throwMalformedRecord('characterStatePatchSnapshot.result');
  }
}

function acceptedCharacterStatePatchResultsEqual(
  left: AcceptedCharacterStatePatchResult,
  right: AcceptedCharacterStatePatchResult
): boolean {
  return (
    characterStatePatchesEqual(left.patch, right.patch) &&
    characterRuntimeStatesEqual(left.before, right.before) &&
    characterRuntimeStatesEqual(left.after, right.after) &&
    characterStateAppliedChangesEqual(left.appliedChanges, right.appliedChanges)
  );
}

function expectedCharacterStatePatchResultFromParsedToolCall(options: {
  readonly parsedRoleModelDecisionSnapshot:
    | ParsedRoleModelDecisionSnapshot
    | undefined;
  readonly before: CharacterRuntimeState;
}): CharacterStatePatchResult {
  const parsedResult = options.parsedRoleModelDecisionSnapshot?.result;

  if (parsedResult?.status !== 'accepted') {
    throwMalformedRecord('characterStatePatchSnapshot');
  }

  const toolCall = getCharacterStatePatchToolCall(parsedResult.decision);

  if (toolCall === undefined) {
    throwMalformedRecord('characterStatePatchSnapshot');
  }

  return planCharacterStatePatch({
    before: options.before,
    patchInput: toolCall.input
  });
}

function assertRejectedCharacterStatePatchMatchesParsedToolCall(options: {
  readonly parsedRoleModelDecisionSnapshot:
    | ParsedRoleModelDecisionSnapshot
    | undefined;
  readonly snapshot: CharacterStatePatchSnapshot;
}): void {
  const actualResult = options.snapshot.result;

  if (actualResult.status !== 'rejected') {
    throwMalformedRecord('characterStatePatchSnapshot.result.status');
  }

  const expectedResult = expectedCharacterStatePatchResultFromParsedToolCall({
    parsedRoleModelDecisionSnapshot: options.parsedRoleModelDecisionSnapshot,
    before: actualResult.before
  });

  if (
    expectedResult.status !== 'rejected' ||
    !rejectedCharacterStatePatchResultsEqual(actualResult, expectedResult)
  ) {
    throwMalformedRecord('characterStatePatchSnapshot.result');
  }
}

function rejectedCharacterStatePatchResultsEqual(
  left: RejectedCharacterStatePatchResult,
  right: RejectedCharacterStatePatchResult
): boolean {
  return (
    JSON.stringify(left.patchInput) === JSON.stringify(right.patchInput) &&
    characterRuntimeStatesEqual(left.before, right.before) &&
    left.rejection.reason === right.rejection.reason &&
    left.rejection.details === right.rejection.details
  );
}

function characterStatePatchesEqual(
  left: CharacterStatePatch,
  right: CharacterStatePatch
): boolean {
  return (
    left.mood === right.mood &&
    left.energy === right.energy &&
    left.attention === right.attention &&
    left.currentActivity === right.currentActivity &&
    left.socialOrientation === right.socialOrientation
  );
}

function characterStateAppliedChangesEqual(
  left: readonly CharacterStateAppliedChange[],
  right: readonly CharacterStateAppliedChange[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((leftChange, index) => {
    const rightChange = right[index];

    return (
      rightChange !== undefined &&
      leftChange.field === rightChange.field &&
      leftChange.before === rightChange.before &&
      leftChange.after === rightChange.after
    );
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
  const parsedRawOutputDecision = parseRoleModelDecision(
    options.roleModelIOSnapshot.rawOutputText
  );
  const parsedSnapshotDecision =
    options.parsedRoleModelDecisionSnapshot.result;

  if (
    roleModelDecisionResultsMatch({
      actual: parsedSnapshotDecision,
      expected: parsedRawOutputDecision
    }) ||
    isMalformedAdapterRawOutputEvidence({
      rawOutputText: options.roleModelIOSnapshot.rawOutputText,
      parsedSnapshotDecision
    }) ||
    isProviderErrorRawOutputEvidence({
      roleModelIOSnapshot: options.roleModelIOSnapshot,
      parsedSnapshotDecision
    })
  ) {
    return;
  }

  throwMalformedRecord('parsedRoleModelDecisionSnapshot.result');
}

function isProviderErrorRawOutputEvidence(options: {
  readonly roleModelIOSnapshot: RoleModelIOSnapshot;
  readonly parsedSnapshotDecision: RoleModelDecisionResult;
}): boolean {
  const providerError = options.roleModelIOSnapshot.providerMetadata?.error;

  return (
    options.roleModelIOSnapshot.rawOutputText.length === 0 &&
    providerError !== undefined &&
    options.parsedSnapshotDecision.status === 'rejected' &&
    options.parsedSnapshotDecision.rejection.reason ===
      roleModelProviderErrorRejectionReason &&
    options.parsedSnapshotDecision.rejection.details === providerError.message
  );
}

function assertParsedRoleModelDecisionAllowedByEnvelope(options: {
  readonly roleModelIOSnapshot: RoleModelIOSnapshot;
  readonly parsedRoleModelDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
}): void {
  const parsedResult = options.parsedRoleModelDecisionSnapshot.result;

  if (parsedResult.status === 'rejected') {
    return;
  }

  const allToolCallsAreAllowed = parsedResult.decision.toolCalls.every((call) =>
    options.roleModelIOSnapshot.inputEnvelope.allowedTools.includes(call.name)
  );

  if (allToolCallsAreAllowed) {
    return;
  }

  throwMalformedRecord(
    'roleModelIOSnapshot.inputEnvelope.allowedTools'
  );
}

function roleModelDecisionResultsMatch(options: {
  readonly actual: RoleModelDecisionResult;
  readonly expected: RoleModelDecisionResult;
}): boolean {
  if (options.actual.status !== options.expected.status) {
    return false;
  }

  if (options.actual.status === 'accepted') {
    return (
      options.expected.status === 'accepted' &&
      JSON.stringify(options.actual.decision) ===
        JSON.stringify(options.expected.decision)
    );
  }

  return (
    options.expected.status === 'rejected' &&
    options.actual.rejection.reason === options.expected.rejection.reason &&
    options.actual.rejection.details === options.expected.rejection.details
  );
}

function isMalformedAdapterRawOutputEvidence(options: {
  readonly rawOutputText: string;
  readonly parsedSnapshotDecision: RoleModelDecisionResult;
}): boolean {
  return (
    options.rawOutputText.length === 0 &&
    options.parsedSnapshotDecision.status === 'rejected' &&
    options.parsedSnapshotDecision.rejection.reason ===
      roleModelMalformedOutputRejectionReason &&
    options.parsedSnapshotDecision.rejection.details ===
      roleModelAdapterRawOutputMissingTextRejectionDetails
  );
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
      options.status !== 'completed'
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
  readonly actual: string;
  readonly parsedDecision: CharacterDecision;
}): void {
  const parsedDecisionText = getRequiredVisibleReplyText(
    options.parsedDecision
  );
  let normalizedParsedDecisionText: string;

  try {
    normalizedParsedDecisionText = normalizeOneLineMessage(
      parsedDecisionText
    );
  } catch (error: unknown) {
    if (error instanceof OneLineMessageValidationError) {
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
    normalizeOneLineMessage(parsedDecisionText);
  } catch (error: unknown) {
    if (error instanceof OneLineMessageValidationError) {
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

  return createRoleModelInputEnvelope({
    event: requiredUserMessageRuntimeEvent(value['event']),
    decisionContext: requiredDecisionContext(value['decisionContext']),
    allowedTools: requiredRoleModelAllowedTools(
      value['allowedTools'] ?? value['allowedActions']
    ),
    outputContract: requiredRoleModelOutputContract(value['outputContract'])
  });
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
    createdAt: requiredRecordString(value, 'createdAt', 'malformed_record'),
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
    ...optionalLivingStateBriefOption(value['livingStateBrief'])
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

function optionalLivingStateBriefOption(value: unknown): {
  readonly livingStateBrief?: LivingStateBrief;
} {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    throwMalformedRecord('livingStateBrief');
  }

  const current = value['current'];

  if (!isRecord(current)) {
    throwMalformedRecord('livingStateBrief.current');
  }

  const text = requiredRecordString(value, 'text', 'malformed_record');
  const livingStateBrief = createLivingStateBrief({
    version: 'mvp-006.character_state.v1',
    current: requiredCharacterRuntimeState({
      version: 'mvp-006.character_state.v1',
      current
    }).current
  });

  if (text !== livingStateBrief.text) {
    throwMalformedRecord('livingStateBrief.text');
  }

  return {
    livingStateBrief
  };
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

  return Object.freeze(tools);
}

function requiredRoleModelOutputContract(
  value: unknown
): RoleModelOutputContract {
  if (!isRecord(value)) {
    throwMalformedRecord('outputContract');
  }

  const version = requiredRecordString(value, 'version', 'malformed_record');

  if (
    version !== roleModelDecisionContractVersion &&
    version !== roleModelLegacyDecisionContractVersion
  ) {
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
    return createAcceptedRoleModelDecisionResult(
      requiredCharacterDecision(value['decision'])
    );
  }

  if (status === 'rejected') {
    const rejection = requiredRoleModelDecisionRejection(value['rejection']);

    return createRejectedRoleModelDecisionResult(
      rejection.reason,
      rejection.details
    );
  }

  throwMalformedRecord('status');
}

function requiredCharacterDecision(value: unknown): CharacterDecision {
  if (!isRecord(value)) {
    throwMalformedRecord('decision');
  }

  const result = parseRoleModelDecision(JSON.stringify(value));

  if (result.status === 'accepted') {
    return result.decision;
  }

  throwMalformedRecord('decision');
}

function requiredRoleModelCommitValidationResult(
  value: unknown
): RoleModelCommitValidationResult {
  if (!isRecord(value)) {
    throwMalformedRecord('commitValidation.result');
  }

  const status = requiredRecordString(value, 'status', 'malformed_record');

  if (status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      acceptedVisibleReplyText: requiredNormalizedVisibleMessageText(
        value,
        'acceptedVisibleReplyText'
      )
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

function requiredCharacterStatePatchResult(
  value: unknown
): CharacterStatePatchResult {
  if (!isRecord(value)) {
    throwMalformedRecord('characterStatePatchSnapshot.result');
  }

  const status = requiredRecordString(value, 'status', 'malformed_record');

  if (status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      patch: requiredCharacterStatePatch(value['patch']),
      before: requiredCharacterRuntimeState(value['before']),
      after: requiredCharacterRuntimeState(value['after']),
      appliedChanges: requiredCharacterStateAppliedChanges(
        value['appliedChanges']
      )
    } satisfies AcceptedCharacterStatePatchResult);
  }

  if (status === 'rejected') {
    return Object.freeze({
      status: 'rejected',
      patchInput: requiredUnknownRecord(value['patchInput'], 'patchInput'),
      before: requiredCharacterRuntimeState(value['before']),
      rejection: requiredCharacterStatePatchRejection(value['rejection'])
    } satisfies RejectedCharacterStatePatchResult);
  }

  throwMalformedRecord('characterStatePatchSnapshot.result.status');
}

function requiredCharacterRuntimeState(value: unknown): CharacterRuntimeState {
  return decodeCharacterRuntimeState(value, throwMalformedRecord);
}

function requiredCharacterStatePatch(value: unknown): CharacterStatePatch {
  if (!isRecord(value)) {
    throwMalformedRecord('characterStatePatchSnapshot.result.patch');
  }

  for (const key of Object.keys(value)) {
    requiredCharacterStatePatchField(key);
  }

  const state = decodeCharacterRuntimeState(
    {
      version: 'mvp-006.character_state.v1',
      current: {
        mood: value['mood'] ?? 'steady',
        energy: value['energy'] ?? 'medium',
        attention: value['attention'] ?? 'present',
        currentActivity: value['currentActivity'] ?? 'idle',
        socialOrientation: value['socialOrientation'] ?? 'open'
      }
    },
    throwMalformedRecord
  );

  return Object.freeze({
    ...(value['mood'] === undefined ? {} : { mood: state.current.mood }),
    ...(value['energy'] === undefined ? {} : { energy: state.current.energy }),
    ...(value['attention'] === undefined
      ? {}
      : { attention: state.current.attention }),
    ...(value['currentActivity'] === undefined
      ? {}
      : { currentActivity: state.current.currentActivity }),
    ...(value['socialOrientation'] === undefined
      ? {}
      : { socialOrientation: state.current.socialOrientation })
  } satisfies CharacterStatePatch);
}

function requiredCharacterStateAppliedChanges(
  value: unknown
): readonly CharacterStateAppliedChange[] {
  const changes: CharacterStateAppliedChange[] = [];

  for (const item of requiredArray(value, 'appliedChanges')) {
    if (!isRecord(item)) {
      throwMalformedRecord('appliedChanges');
    }

    changes.push(
      Object.freeze({
        field: requiredCharacterStatePatchField(item['field']),
        before: requiredRecordString(item, 'before', 'malformed_record'),
        after: requiredRecordString(item, 'after', 'malformed_record')
      } satisfies CharacterStateAppliedChange)
    );
  }

  return Object.freeze(changes);
}

function requiredCharacterStatePatchField(
  value: unknown
): CharacterStateAppliedChange['field'] {
  if (
    value === 'mood' ||
    value === 'energy' ||
    value === 'attention' ||
    value === 'currentActivity' ||
    value === 'socialOrientation'
  ) {
    return value;
  }

  throwMalformedRecord('appliedChanges.field');
}

function requiredCharacterStatePatchRejection(
  value: unknown
): CharacterStatePatchRejection {
  if (!isRecord(value)) {
    throwMalformedRecord('characterStatePatchSnapshot.result.rejection');
  }

  return Object.freeze({
    reason: requiredCharacterStatePatchRejectionReason(value['reason']),
    details: requiredRecordStringAllowingEmpty(
      value,
      'details',
      'malformed_record'
    )
  } satisfies CharacterStatePatchRejection);
}

function requiredCharacterStatePatchRejectionReason(
  value: unknown
): CharacterStatePatchRejectionReason {
  if (
    value === 'malformed_state_patch' ||
    value === 'unsupported_state_field' ||
    value === 'invalid_state_value'
  ) {
    return value;
  }

  throwMalformedRecord('characterStatePatchSnapshot.result.rejection.reason');
}

function requiredUnknownRecord(
  value: unknown,
  key: string
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throwMalformedRecord(key);
  }

  return Object.freeze({ ...value });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<const T extends string>(
  value: unknown,
  allowedValues: readonly T[]
): value is T {
  return typeof value === 'string' && allowedValues.includes(value as T);
}

function throwMalformedRecord(field: string): never {
  throw new LocalRuntimeStorageContractError(
    'malformed_record',
    `Stored local runtime field "${field}" is malformed.`
  );
}

function throwMalformedSchemaMarker(field: string): never {
  throw new LocalRuntimeStorageContractError(
    'malformed_schema_marker',
    `Stored local runtime schema field "${field}" is malformed.`
  );
}
