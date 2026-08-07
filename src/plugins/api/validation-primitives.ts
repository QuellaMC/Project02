import {isOneOf} from '../../shared/one-of.ts';

export {isOneOf};
import {
  isJsonRecord as isRecord,
  ownJsonRecordValue,
} from '../../shared/json-boundary.ts';

export {isRecord};
import {isProject02Identifier} from '../../shared/identifier.ts';
import {isJsonBoundaryCredentialKey} from '../../shared/redaction.ts';
import {runtimePluginSourceKindValues} from './contract.ts';
import type {
  RuntimePluginContextBudget,
  RuntimePluginSourceReference,
  RuntimePluginValidationFailureReason,
  RuntimePluginValidationResult,
} from './types.ts';

export function requiredContextBudget(
  value: unknown,
): RuntimePluginValidationResult<RuntimePluginContextBudget> {
  if (!isRecord(value)) {
    return reject(
      'malformed_context_item',
      'Plugin context budget must be an object.',
    );
  }

  const estimatedTokens = requiredPositiveInteger(
    value['estimatedTokens'],
    'estimatedTokens',
  );
  const priority = requiredPositiveInteger(value['priority'], 'priority');

  if (estimatedTokens.status === 'rejected' || priority.status === 'rejected') {
    return firstRejected([estimatedTokens, priority]);
  }

  return accept(
    Object.freeze({
      estimatedTokens: estimatedTokens.value,
      priority: priority.value,
    } satisfies RuntimePluginContextBudget),
  );
}

export function requiredSourceReferences(
  value: unknown,
): RuntimePluginValidationResult<readonly RuntimePluginSourceReference[]> {
  if (!Array.isArray(value)) {
    return reject(
      'malformed_context_item',
      'Plugin sourceReferences must be an array.',
    );
  }

  if (value.length > 32) {
    return reject(
      'malformed_context_item',
      'Plugin sourceReferences exceed the 32-record limit.',
    );
  }

  const references: RuntimePluginSourceReference[] = [];

  for (const item of value) {
    const reference = requiredSourceReference(item);

    if (reference.status === 'rejected') {
      return reference;
    }

    references.push(reference.value);
  }

  return accept(Object.freeze(references));
}

function requiredSourceReference(
  value: unknown,
): RuntimePluginValidationResult<RuntimePluginSourceReference> {
  if (!isRecord(value)) {
    return reject(
      'malformed_context_item',
      'Plugin source reference must be an object.',
    );
  }

  const kind = value['kind'];
  const id = requiredNonEmptyString(value['id'], 'id');
  const title = optionalString(value['title'], 'title');
  const uri = optionalString(value['uri'], 'uri');

  if (
    id.status === 'rejected' ||
    title.status === 'rejected' ||
    uri.status === 'rejected'
  ) {
    return firstRejected([id, title, uri]);
  }

  if (!isOneOf(kind, runtimePluginSourceKindValues)) {
    return reject(
      'malformed_context_item',
      'Plugin source reference kind is not supported.',
    );
  }

  return accept(
    Object.freeze({
      kind,
      id: id.value,
      ...(title.value === undefined ? {} : {title: title.value}),
      ...(uri.value === undefined ? {} : {uri: uri.value}),
    } satisfies RuntimePluginSourceReference),
  );
}

export function freezeSourceReferences(
  value: readonly RuntimePluginSourceReference[],
): readonly RuntimePluginSourceReference[] {
  return Object.freeze(
    value.map(sourceReference =>
      Object.freeze({
        kind: sourceReference.kind,
        id: sourceReference.id,
        ...(sourceReference.title === undefined
          ? {}
          : {title: sourceReference.title}),
        ...(sourceReference.uri === undefined
          ? {}
          : {uri: sourceReference.uri}),
      } satisfies RuntimePluginSourceReference),
    ),
  );
}

export function freezeRedactedStrings(
  values: readonly string[],
): readonly string[] {
  return Object.freeze(values.map(value => value));
}

export function optionalConfidence(
  value: unknown,
): RuntimePluginValidationResult<number | undefined> {
  if (value === undefined) {
    return accept(undefined);
  }

  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    return reject(
      'malformed_context_item',
      'Plugin context item confidence must be a finite number between 0 and 1.',
    );
  }

  return accept(value);
}

export function requiredIdentifier(
  value: unknown,
  field: string,
): RuntimePluginValidationResult<string> {
  const stringValue = requiredNonEmptyString(value, field);

  if (stringValue.status === 'rejected') {
    return stringValue;
  }

  if (!isProject02Identifier(stringValue.value)) {
    return reject(
      'malformed_manifest',
      `Plugin field "${field}" must start with a letter and use only letters, numbers, dots, underscores, or hyphens.`,
    );
  }

  return stringValue;
}

export function requiredNonEmptyString(
  value: unknown,
  field: string,
): RuntimePluginValidationResult<string> {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return reject(
      'malformed_manifest',
      `Plugin field "${field}" must be a non-empty string.`,
    );
  }

  return accept(value);
}

export function optionalString(
  value: unknown,
  field: string,
): RuntimePluginValidationResult<string | undefined> {
  if (value === undefined) {
    return accept(undefined);
  }

  return requiredNonEmptyString(value, field);
}

export function requiredBoolean(
  value: unknown,
  field: string,
): RuntimePluginValidationResult<boolean> {
  if (typeof value !== 'boolean') {
    return reject(
      'malformed_manifest',
      `Plugin field "${field}" must be a boolean.`,
    );
  }

  return accept(value);
}

export function requiredPositiveInteger(
  value: unknown,
  field: string,
): RuntimePluginValidationResult<number> {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return reject(
      'malformed_manifest',
      `Plugin field "${field}" must be a positive integer.`,
    );
  }

  return accept(value);
}

export function requiredStringArray(
  value: unknown,
  field: string,
): RuntimePluginValidationResult<readonly string[]> {
  if (!Array.isArray(value)) {
    return reject(
      'malformed_manifest',
      `Plugin field "${field}" must be an array.`,
    );
  }

  const strings: string[] = [];

  for (const item of value) {
    const stringValue = requiredNonEmptyString(item, field);

    if (stringValue.status === 'rejected') {
      return stringValue;
    }

    strings.push(stringValue.value);
  }

  return accept(Object.freeze(strings));
}

export function firstRejected(
  results: readonly RuntimePluginValidationResult<unknown>[],
): RuntimePluginValidationResult<never> {
  const rejected = results.find(result => result.status === 'rejected');

  if (rejected !== undefined) {
    return reject(rejected.reason, rejected.details);
  }

  throw new Error('Expected at least one rejected validation result.');
}

export function acceptedOrThrow<T>(
  result: RuntimePluginValidationResult<T>,
): T {
  if (result.status === 'accepted') {
    return result.value;
  }

  throw new TypeError(result.details);
}

export function accept<T>(value: T): RuntimePluginValidationResult<T> {
  return Object.freeze({
    status: 'accepted',
    value,
  } satisfies RuntimePluginValidationResult<T>);
}

export function reject(
  reason: RuntimePluginValidationFailureReason,
  details: string,
): RuntimePluginValidationResult<never> {
  return Object.freeze({
    status: 'rejected',
    reason,
    details,
  } satisfies RuntimePluginValidationResult<never>);
}

export function requiredOneOf<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  field: string,
): T {
  if (!isOneOf(value, allowedValues)) {
    throw new TypeError(`Unsupported ${field}: ${String(value)}.`);
  }

  return value;
}

export function optionalOneOf<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requiredOneOf(value, allowedValues, field);
}

export function optionalPlainString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requirePlainNonEmptyStringFromUnknown(value, field);
}

export function requiredArrayOrThrow(
  value: unknown,
  field: string,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Plugin field "${field}" must be an array.`);
  }

  return value;
}

export function requiredStringArrayOrThrow(
  value: unknown,
  field: string,
): readonly string[] {
  const result = requiredStringArray(value, field);

  if (result.status === 'accepted') {
    return result.value;
  }

  throw new TypeError(result.details);
}

export function requireBooleanRecordField(
  record: Readonly<Record<string, unknown>>,
  field: string,
): boolean {
  const value = ownJsonRecordValue(record, field);

  if (typeof value !== 'boolean') {
    throw new TypeError(`Plugin field "${field}" must be a boolean.`);
  }

  return value;
}

export function requirePlainNonEmptyString(
  value: string,
  field: string,
): string {
  if (value.trim().length === 0) {
    throw new TypeError(`Plugin field "${field}" must be non-empty.`);
  }

  return value;
}

export function requirePlainNonEmptyRecordString(
  record: Readonly<Record<string, unknown>>,
  field: string,
): string {
  return requirePlainNonEmptyStringFromUnknown(
    ownJsonRecordValue(record, field),
    field,
  );
}

function requirePlainNonEmptyStringFromUnknown(
  value: unknown,
  field: string,
): string {
  if (typeof value !== 'string') {
    throw new TypeError(`Plugin field "${field}" must be a string.`);
  }

  return requirePlainNonEmptyString(value, field);
}

export function isRuntimePluginCredentialKey(value: string): boolean {
  return isJsonBoundaryCredentialKey(value);
}
