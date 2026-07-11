import {
  normalizeVisibleMessageText,
  VisibleMessageTextValidationError
} from '../../core/message-validation.ts';
import { visibleMessageRoleValues, type VisibleMessageRole } from '../../core/conversation.ts';
import { LocalRuntimeStorageContractError, requiredRecordString } from './layout-contract.ts';

export function requiredNormalizedVisibleMessageText(
  record: Record<string, unknown>,
  key: string
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

export function requiredVisibleMessageRole(value: unknown): VisibleMessageRole {
  if (isOneOf(value, visibleMessageRoleValues)) {
    return value;
  }

  throwMalformedRecord('role');
}

export function isOneOf<const T extends string>(
  value: unknown,
  allowedValues: readonly T[]
): value is T {
  return typeof value === 'string' && allowedValues.includes(value as T);
}

export function throwMalformedRecord(field: string): never {
  throw new LocalRuntimeStorageContractError(
    'malformed_record',
    `Stored local runtime field "${field}" is malformed.`
  );
}
