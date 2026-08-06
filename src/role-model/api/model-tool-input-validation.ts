/**
 * Model tool input validation: checks a proposed tool call's input
 * against the tool's declared JSON Schema input contract before the call
 * may commit.
 */
import {isJsonRecord} from '../../shared/json-boundary.ts';
import {
  isModelToolJsonSchemaTypeArray,
  type ModelToolInputContract,
  type ModelToolJsonSchema,
  type ModelToolJsonSchemaType,
} from './model-tools.ts';

export type ModelToolInputValidationResult =
  | {
      readonly status: 'accepted';
      readonly input: Readonly<Record<string, unknown>>;
    }
  | {
      readonly status: 'rejected';
      readonly details: string;
    };

export function validateModelToolInputAgainstContract(options: {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly inputContract: ModelToolInputContract;
}): ModelToolInputValidationResult {
  const schemaValidation = validateModelToolInputAgainstJsonSchema({
    toolName: options.toolName,
    value: options.input,
    schema: options.inputContract,
    fieldPath: '',
  });

  if (schemaValidation !== undefined) {
    return rejectModelToolInput(schemaValidation);
  }

  return Object.freeze({
    status: 'accepted',
    input: freezeJsonRecord(options.input),
  } satisfies ModelToolInputValidationResult);
}

function rejectModelToolInput(details: string): ModelToolInputValidationResult {
  return Object.freeze({
    status: 'rejected',
    details,
  } satisfies ModelToolInputValidationResult);
}

function validateModelToolInputJsonValue(options: {
  readonly toolName: string;
  readonly fieldPath: string;
  readonly value: unknown;
}): string | undefined {
  if (
    options.value === null ||
    typeof options.value === 'string' ||
    typeof options.value === 'boolean'
  ) {
    return undefined;
  }

  if (typeof options.value === 'number') {
    if (Number.isFinite(options.value)) {
      return undefined;
    }

    return `${options.toolName} input field "${options.fieldPath}" must be finite JSON.`;
  }

  if (Array.isArray(options.value)) {
    for (const [index, item] of options.value.entries()) {
      const result = validateModelToolInputJsonValue({
        toolName: options.toolName,
        fieldPath: `${options.fieldPath}[${String(index)}]`,
        value: item,
      });

      if (result !== undefined) {
        return result;
      }
    }

    return undefined;
  }

  if (isJsonRecord(options.value)) {
    for (const [key, item] of Object.entries(options.value)) {
      const result = validateModelToolInputJsonValue({
        toolName: options.toolName,
        fieldPath: `${options.fieldPath}.${key}`,
        value: item,
      });

      if (result !== undefined) {
        return result;
      }
    }

    return undefined;
  }

  return `${options.toolName} input field "${options.fieldPath}" must be JSON serializable.`;
}

function validateModelToolInputAgainstJsonSchema(options: {
  readonly toolName: string;
  readonly value: unknown;
  readonly schema: ModelToolJsonSchema;
  readonly fieldPath: string;
}): string | undefined {
  const typeError = validateJsonSchemaType({
    toolName: options.toolName,
    value: options.value,
    schema: options.schema,
    fieldPath: options.fieldPath,
  });

  if (typeError !== undefined) {
    return typeError;
  }

  if (
    options.schema.enum !== undefined &&
    (typeof options.value !== 'string' ||
      !options.schema.enum.includes(options.value))
  ) {
    return `${options.toolName} input field "${displayFieldPath(options.fieldPath)}" must be one of: ${options.schema.enum.join(', ')}.`;
  }

  if (Array.isArray(options.value)) {
    if (options.schema.items === undefined) {
      return validateModelToolInputJsonValue({
        toolName: options.toolName,
        fieldPath: displayFieldPath(options.fieldPath),
        value: options.value,
      });
    }

    for (const [index, item] of options.value.entries()) {
      const itemError = validateModelToolInputAgainstJsonSchema({
        toolName: options.toolName,
        value: item,
        schema: options.schema.items,
        fieldPath: `${options.fieldPath}[${String(index)}]`,
      });

      if (itemError !== undefined) {
        return itemError;
      }
    }

    return undefined;
  }

  if (isJsonRecord(options.value)) {
    const properties = options.schema.properties ?? {};
    const required = options.schema.required ?? [];

    for (const field of required) {
      if (options.value[field] === undefined) {
        return `${options.toolName} input missing required field "${displayFieldPath(
          appendFieldPath(options.fieldPath, field),
        )}".`;
      }
    }

    if (options.schema.additionalProperties === false) {
      const unsupportedKeys = Object.keys(options.value).filter(
        key => properties[key] === undefined,
      );

      if (unsupportedKeys.length > 0) {
        return `${options.toolName} input includes unsupported fields: ${unsupportedKeys
          .map(key => displayFieldPath(appendFieldPath(options.fieldPath, key)))
          .join(', ')}.`;
      }
    }

    for (const [field, schema] of Object.entries(properties)) {
      const childValue = options.value[field];

      if (childValue === undefined) {
        continue;
      }

      const childError = validateModelToolInputAgainstJsonSchema({
        toolName: options.toolName,
        value: childValue,
        schema,
        fieldPath: appendFieldPath(options.fieldPath, field),
      });

      if (childError !== undefined) {
        return childError;
      }
    }
  }

  return validateModelToolInputJsonValue({
    toolName: options.toolName,
    fieldPath: displayFieldPath(options.fieldPath),
    value: options.value,
  });
}

function validateJsonSchemaType(options: {
  readonly toolName: string;
  readonly value: unknown;
  readonly schema: ModelToolJsonSchema;
  readonly fieldPath: string;
}): string | undefined {
  const schemaType = options.schema.type;

  if (schemaType === undefined) {
    return undefined;
  }

  const types = modelToolJsonSchemaTypes(schemaType);

  if (types.some(type => jsonValueMatchesSchemaType(options.value, type))) {
    return undefined;
  }

  return `${options.toolName} input field "${displayFieldPath(
    options.fieldPath,
  )}" must be ${types.join(' or ')}.`;
}

function jsonValueMatchesSchemaType(
  value: unknown,
  type: ModelToolJsonSchemaType,
): boolean {
  if (type === 'array') {
    return Array.isArray(value);
  }

  if (type === 'object') {
    return isJsonRecord(value);
  }

  if (type === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }

  if (type === 'null') {
    return value === null;
  }

  return typeof value === type;
}

function modelToolJsonSchemaTypes(
  type: NonNullable<ModelToolJsonSchema['type']>,
): readonly ModelToolJsonSchemaType[] {
  return isModelToolJsonSchemaTypeArray(type)
    ? Object.freeze([...type])
    : Object.freeze([type]);
}

function appendFieldPath(path: string, field: string): string {
  return path.length === 0 ? field : `${path}.${field}`;
}

function displayFieldPath(path: string): string {
  return path.length === 0 ? '$' : path;
}

function freezeJsonRecord(
  record: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const snapshot: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    snapshot[key] = freezeJsonValue(value);
  }

  return Object.freeze(snapshot);
}

function freezeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeJsonValue));
  }

  if (isJsonRecord(value)) {
    return freezeJsonRecord(value);
  }

  return value;
}
