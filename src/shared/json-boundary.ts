import {isJsonBoundaryCredentialKey} from './redaction.ts';

export type JsonBoundaryValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonBoundaryValue[]
  | JsonBoundaryObject;

export type JsonBoundaryObject = {
  readonly [key: string]: JsonBoundaryValue;
};

export function ownJsonRecordValue<T>(
  record: Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined {
  return record !== undefined && Object.hasOwn(record, key)
    ? record[key]
    : undefined;
}

export type JsonBoundaryLimits = {
  readonly maxDepth: number;
  readonly maxEntriesPerContainer: number;
  readonly maxNodes: number;
  readonly maxStringBytes: number;
  readonly maxTotalStringBytes: number;
};

export const defaultJsonBoundaryLimits = Object.freeze({
  maxDepth: 16,
  maxEntriesPerContainer: 256,
  maxNodes: 4_096,
  maxStringBytes: 16 * 1_024,
  maxTotalStringBytes: 64 * 1_024,
} satisfies JsonBoundaryLimits);

export type CreateJsonBoundarySnapshotOptions = {
  readonly field: string;
  readonly redact?: boolean;
  readonly limits?: JsonBoundaryLimits;
  readonly deadlineAt?: number | undefined;
  readonly now?: () => number;
};

type JsonBoundaryState = {
  nodeCount: number;
  totalStringBytes: number;
  readonly activeContainers: WeakSet<object>;
  readonly options: Required<
    Pick<
      CreateJsonBoundarySnapshotOptions,
      'field' | 'redact' | 'limits' | 'now'
    >
  > &
    Pick<CreateJsonBoundarySnapshotOptions, 'deadlineAt'>;
};

export function createJsonBoundarySnapshot(
  value: unknown,
  options: CreateJsonBoundarySnapshotOptions,
): JsonBoundaryValue {
  const state: JsonBoundaryState = {
    nodeCount: 0,
    totalStringBytes: 0,
    activeContainers: new WeakSet<object>(),
    options: {
      field: options.field,
      redact: options.redact ?? false,
      limits: options.limits ?? defaultJsonBoundaryLimits,
      now: options.now ?? Date.now,
      ...(options.deadlineAt === undefined
        ? {}
        : {deadlineAt: options.deadlineAt}),
    },
  };

  return normalizeJsonBoundaryValue(value, options.field, 0, state);
}

export function createJsonBoundaryObjectSnapshot(
  value: unknown,
  options: CreateJsonBoundarySnapshotOptions,
): JsonBoundaryObject {
  const snapshot = createJsonBoundarySnapshot(value, options);

  if (!isJsonBoundaryObject(snapshot)) {
    throw new TypeError(`${options.field} must be a JSON object.`);
  }

  return snapshot;
}

function normalizeJsonBoundaryValue(
  value: unknown,
  field: string,
  depth: number,
  state: JsonBoundaryState,
  key?: string,
): JsonBoundaryValue {
  state.nodeCount += 1;
  assertBoundaryProgress(field, depth, state);

  const redactCredentialValue =
    state.options.redact &&
    key !== undefined &&
    isJsonBoundaryCredentialKey(key);

  if (value === null || typeof value === 'boolean') {
    return redactCredentialValue ? '[redacted]' : value;
  }

  if (typeof value === 'string') {
    accountJsonBoundaryString(value, field, state);
    if (redactCredentialValue) {
      return '[redacted]';
    }

    return value;
  }

  if (typeof value === 'number') {
    // JSON has no NaN or Infinity, so the snapshot carries what
    // serialization would have written anyway.
    if (!Number.isFinite(value)) {
      return null;
    }

    return redactCredentialValue ? '[redacted]' : value;
  }

  if (redactCredentialValue) {
    measureRedactedCredentialValue(value, field, depth, state);
    return '[redacted]';
  }

  if (Array.isArray(value)) {
    assertContainerCanBeVisited(value, field, state);
    if (value.length > state.options.limits.maxEntriesPerContainer) {
      throw new TypeError(`${field} exceeds the JSON container entry limit.`);
    }

    state.activeContainers.add(value);
    try {
      return Object.freeze(
        value.map((item, index) =>
          normalizeJsonBoundaryValue(
            item,
            `${field}[${String(index)}]`,
            depth + 1,
            state,
          ),
        ),
      );
    } finally {
      state.activeContainers.delete(value);
    }
  }

  if (isJsonRecord(value)) {
    assertContainerCanBeVisited(value, field, state);
    const entries = Object.entries(value);
    if (entries.length > state.options.limits.maxEntriesPerContainer) {
      throw new TypeError(`${field} exceeds the JSON container entry limit.`);
    }

    state.activeContainers.add(value);
    try {
      return Object.freeze(
        Object.fromEntries(
          entries.map(([entryKey, item]) => {
            accountJsonBoundaryString(entryKey, `${field} object key`, state);
            return [
              entryKey,
              normalizeJsonBoundaryValue(
                item,
                `${field}.${entryKey}`,
                depth + 1,
                state,
                entryKey,
              ),
            ];
          }),
        ),
      );
    } finally {
      state.activeContainers.delete(value);
    }
  }

  throw new TypeError(`${field} must be JSON serializable.`);
}

function measureRedactedCredentialValue(
  value: unknown,
  field: string,
  depth: number,
  state: JsonBoundaryState,
): void {
  if (Array.isArray(value)) {
    assertContainerCanBeVisited(value, field, state);
    if (value.length > state.options.limits.maxEntriesPerContainer) {
      throw new TypeError(`${field} exceeds the JSON container entry limit.`);
    }

    state.activeContainers.add(value);
    try {
      value.forEach((item, index) => {
        normalizeJsonBoundaryValue(
          item,
          `${field}[${String(index)}]`,
          depth + 1,
          state,
        );
      });
    } finally {
      state.activeContainers.delete(value);
    }
    return;
  }

  if (isJsonRecord(value)) {
    assertContainerCanBeVisited(value, field, state);
    const entries = Object.entries(value);
    if (entries.length > state.options.limits.maxEntriesPerContainer) {
      throw new TypeError(`${field} exceeds the JSON container entry limit.`);
    }

    state.activeContainers.add(value);
    try {
      for (const [entryKey, item] of entries) {
        accountJsonBoundaryString(entryKey, `${field} object key`, state);
        normalizeJsonBoundaryValue(
          item,
          `${field}.${entryKey}`,
          depth + 1,
          state,
          entryKey,
        );
      }
    } finally {
      state.activeContainers.delete(value);
    }
    return;
  }

  throw new TypeError(`${field} must be JSON serializable.`);
}

function accountJsonBoundaryString(
  value: string,
  field: string,
  state: JsonBoundaryState,
): void {
  const rawStringBytes = jsonBoundaryUtf8ByteLength(value);
  state.totalStringBytes += rawStringBytes;
  if (rawStringBytes > state.options.limits.maxStringBytes) {
    throw new TypeError(`${field} exceeds the JSON string byte limit.`);
  }
  if (state.totalStringBytes > state.options.limits.maxTotalStringBytes) {
    throw new TypeError(
      `${state.options.field} exceeds the aggregate JSON text limit.`,
    );
  }
}

const utf8Encoder = new TextEncoder();

export function jsonBoundaryUtf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

function assertBoundaryProgress(
  field: string,
  depth: number,
  state: JsonBoundaryState,
): void {
  if (depth > state.options.limits.maxDepth) {
    throw new TypeError(`${field} exceeds the JSON depth limit.`);
  }
  if (state.nodeCount > state.options.limits.maxNodes) {
    throw new TypeError(`${state.options.field} exceeds the JSON node limit.`);
  }
  if (
    state.options.deadlineAt !== undefined &&
    (state.nodeCount === 1 || state.nodeCount % 32 === 0) &&
    state.options.now() >= state.options.deadlineAt
  ) {
    throw new TypeError(`${state.options.field} JSON normalization timed out.`);
  }
}

function assertContainerCanBeVisited(
  value: object,
  field: string,
  state: JsonBoundaryState,
): void {
  if (state.activeContainers.has(value)) {
    throw new TypeError(`${field} must not contain cycles.`);
  }
}

export function isJsonBoundaryObject(
  value: JsonBoundaryValue,
): value is JsonBoundaryObject {
  return isJsonRecord(value);
}

export function isJsonRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
