import {isOneOf} from '../../shared/one-of.ts';

export {isOneOf};
import {
  createRuntimeEventIdentitySnapshot,
  normalizeVisibleMessageText,
  type RuntimeEventIdentity,
  type VisibleMessage,
  type VisibleMessageRole,
  visibleMessageRoleValues,
  VisibleMessageTextValidationError,
} from '../../core/index.ts';
import {
  createJsonBoundaryObjectSnapshot,
  createJsonBoundarySnapshot,
} from '../../shared/json-boundary.ts';
import type {
  RuntimePluginJsonObject,
  RuntimePluginJsonValue,
} from '../../plugins/api/index.ts';
import {
  isRecord,
  LocalRuntimeStorageContractError,
  requiredNonEmptyString,
  requiredRecordCanonicalTimestamp,
  requiredRecordString,
  type LocalRuntimeStorageContractErrorCode,
} from './layout-contract.ts';

export function optionalRecordString(
  record: Record<string, unknown>,
  key: string,
  code: LocalRuntimeStorageContractErrorCode,
): string | undefined {
  const value = record[key];

  if (value === undefined) {
    return undefined;
  }

  return requiredNonEmptyString(value, key, code);
}

export function requiredRecordStringAllowingEmpty(
  record: Record<string, unknown>,
  key: string,
  code: LocalRuntimeStorageContractErrorCode,
): string {
  const value = record[key];

  if (typeof value !== 'string') {
    throw new LocalRuntimeStorageContractError(
      code,
      `Stored local runtime field "${key}" must be a string.`,
    );
  }

  return value;
}

export function optionalRecordStringAllowingEmpty(
  record: Record<string, unknown>,
  key: string,
  code: LocalRuntimeStorageContractErrorCode,
): string | undefined {
  const value = record[key];

  if (value === undefined) {
    return undefined;
  }

  return requiredRecordStringAllowingEmpty(record, key, code);
}

export function requiredRecordNumber(
  record: Record<string, unknown>,
  key: string,
  code: LocalRuntimeStorageContractErrorCode,
): number {
  const value = record[key];

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new LocalRuntimeStorageContractError(
      code,
      `Stored local runtime field "${key}" must be a positive integer.`,
    );
  }

  return value;
}

export function optionalRecordNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];

  if (value === undefined) {
    return undefined;
  }

  return requiredRecordNumber(record, key, 'malformed_record');
}

export function optionalRecordBoolean(
  record: Record<string, unknown>,
  key: string,
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

export function requiredRuntimeEventIdentity(
  record: Record<string, unknown>,
): RuntimeEventIdentity {
  try {
    return createRuntimeEventIdentitySnapshot({
      eventId: requiredRecordString(record, 'eventId', 'malformed_record'),
      traceId: requiredRecordString(record, 'traceId', 'malformed_record'),
      createdAt: requiredRecordCanonicalTimestamp(
        record,
        'createdAt',
        'malformed_record',
      ),
    });
  } catch (error: unknown) {
    if (error instanceof LocalRuntimeStorageContractError) {
      throw error;
    }

    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Stored local runtime event identity is malformed.',
      {cause: error},
    );
  }
}

export function requiredNormalizedVisibleMessageText(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = requiredRecordString(record, key, 'malformed_record');
  let normalizedValue: string;

  try {
    normalizedValue = normalizeVisibleMessageText(value);
  } catch (error: unknown) {
    if (error instanceof VisibleMessageTextValidationError) {
      throwMalformedRecord(key);
    }

    throw error;
  }

  if (normalizedValue !== value) {
    throwMalformedRecord(key);
  }

  return value;
}

/** The one decoder for a stored visible message, wherever it appears. */
export function requiredVisibleMessage(
  value: unknown,
  field: string,
): VisibleMessage {
  if (!isRecord(value)) {
    throwMalformedRecord(field);
  }

  return Object.freeze({
    id: requiredRecordString(value, 'id', 'malformed_record'),
    role: requiredVisibleMessageRole(value['role']),
    speakerId: requiredRecordString(value, 'speakerId', 'malformed_record'),
    speakerName: requiredRecordString(value, 'speakerName', 'malformed_record'),
    text: requiredNormalizedVisibleMessageText(value, 'text'),
  } satisfies VisibleMessage);
}

/**
 * `committedAt` names the turn, not the instant: it orders turns and never
 * messages within one.
 */
export function optionalCommittedMessage(record: Record<string, unknown>): {
  readonly visibleMessage?: VisibleMessage;
  readonly committedAt?: string;
  readonly decisionRound?: number;
} {
  const value = record['visibleMessage'];
  const commitsAMessage = record['kind'] === 'visible_message_committed';

  if (value === undefined) {
    // A commit event with no message would decode and then silently vanish
    // from the transcript.
    if (commitsAMessage || record['committedAt'] !== undefined) {
      throwMalformedRecord('visibleMessage');
    }

    return {};
  }

  if (!commitsAMessage) {
    throwMalformedRecord('visibleMessage');
  }

  const decisionRound = record['decisionRound'];

  return Object.freeze({
    committedAt: requiredRecordCanonicalTimestamp(
      record,
      'committedAt',
      'malformed_record',
    ),
    visibleMessage: requiredVisibleMessage(value, 'visibleMessage'),
    ...(decisionRound === undefined
      ? {}
      : {decisionRound: requiredCommittedDecisionRound(decisionRound)}),
  });
}

function requiredCommittedDecisionRound(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throwMalformedRecord('decisionRound');
  }

  return value;
}

function requiredVisibleMessageRole(value: unknown): VisibleMessageRole {
  if (isOneOf(value, visibleMessageRoleValues)) {
    return value;
  }

  throwMalformedRecord('role');
}

export function throwMalformedRecord(field: string): never {
  throw new LocalRuntimeStorageContractError(
    'malformed_record',
    `Stored local runtime field "${field}" is malformed.`,
  );
}

export function requiredArray(value: unknown, key: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throwMalformedRecord(key);
  }

  return value;
}

export function requiredStringArray(
  value: unknown,
  key: string,
): readonly string[] {
  const strings: string[] = [];

  for (const item of requiredArray(value, key)) {
    if (typeof item !== 'string') {
      throwMalformedRecord(key);
    }

    strings.push(item);
  }

  return Object.freeze(strings);
}

export function optionalStringArray(
  value: unknown,
  key: string,
): readonly string[] | undefined {
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
export function requiredBoundedJsonObject(
  value: unknown,
  field: string,
): RuntimePluginJsonObject {
  try {
    return createJsonBoundaryObjectSnapshot(value, {field});
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      throwMalformedRecord(field);
    }

    throw error;
  }
}
export function requiredBoundedJsonValue(
  value: unknown,
  field: string,
): RuntimePluginJsonValue {
  try {
    return createJsonBoundarySnapshot(value, {field});
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      throwMalformedRecord(field);
    }

    throw error;
  }
}
export function requiredLiteralString(
  record: Record<string, unknown>,
  key: string,
  expectedValue: string,
  errorField: string,
): void {
  const value = requiredRecordString(record, key, 'malformed_record');

  if (value !== expectedValue) {
    throwMalformedRecord(errorField);
  }
}

export function sameOrderedValues(
  actualValues: readonly string[],
  expectedValues: readonly string[],
): boolean {
  return (
    actualValues.length === expectedValues.length &&
    actualValues.every((value, index) => value === expectedValues[index])
  );
}
