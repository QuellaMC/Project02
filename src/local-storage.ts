import { join } from 'node:path';

import type { VisibleMessageRole } from './conversation.ts';
import {
  normalizeOneLineMessage,
  OneLineMessageValidationError
} from './message-validation.ts';
import type { RuntimeEventType } from './runtime-event.ts';
import {
  isTerminalRawEventLogRecordKind,
  type ConversationLogRecord,
  type RawEventLogPayloadSummary,
  type RawEventLogRecord,
  type RawEventLogRecordKind,
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

const runtimeTraceSteps = [
  'runtime_event_received',
  'runtime_event_normalized',
  'runtime_turn_started',
  'visible_reply_committed',
  'input_validation_rejected',
  'character_reply_rejected',
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
    conversationPath: join(sessionRoot, conversationFileName)
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
  const kind = requiredRawEventKind(record['kind']);
  const status = optionalRuntimeTurnStatus(record['status']);
  const reason = optionalRecordString(record, 'reason', 'malformed_record');
  const visibleMessageIds = optionalStringArray(record['visibleMessageIds'], 'visibleMessageIds');
  const payloadSummary = optionalRawEventPayloadSummary(record['payloadSummary']);

  assertTerminalRawEventSemantics({
    kind,
    status,
    visibleMessageIds
  });

  return Object.freeze({
    eventId: requiredRecordString(record, 'eventId', 'malformed_record'),
    traceId: requiredRecordString(record, 'traceId', 'malformed_record'),
    createdAt: requiredRecordString(record, 'createdAt', 'malformed_record'),
    kind,
    eventType: requiredRuntimeEventType(record['eventType']),
    ...(status === undefined ? {} : { status }),
    ...(reason === undefined ? {} : { reason }),
    ...(visibleMessageIds === undefined ? {} : { visibleMessageIds }),
    ...(payloadSummary === undefined ? {} : { payloadSummary })
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
