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
  key: string
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
  maxTotalStringBytes: 64 * 1_024
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
    Pick<CreateJsonBoundarySnapshotOptions, 'field' | 'redact' | 'limits' | 'now'>
  > &
    Pick<CreateJsonBoundarySnapshotOptions, 'deadlineAt'>;
};

export function createJsonBoundarySnapshot(
  value: unknown,
  options: CreateJsonBoundarySnapshotOptions
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
        : { deadlineAt: options.deadlineAt })
    }
  };

  return normalizeJsonBoundaryValue(value, options.field, 0, state);
}

export function createJsonBoundaryObjectSnapshot(
  value: unknown,
  options: CreateJsonBoundarySnapshotOptions
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
  key?: string
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

    const snapshot = state.options.redact
      ? redactJsonBoundaryText(value)
      : value;

    return snapshot;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${field} must be finite JSON.`);
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
            state
          )
        )
      );
    } finally {
      state.activeContainers.delete(value);
    }
  }

  if (isRecord(value)) {
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
            accountJsonBoundaryString(
              entryKey,
              `${field} object key`,
              state
            );
            return [
              entryKey,
              normalizeJsonBoundaryValue(
                item,
                `${field}.${entryKey}`,
                depth + 1,
                state,
                entryKey
              )
            ];
          })
        )
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
  state: JsonBoundaryState
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
          state
        );
      });
    } finally {
      state.activeContainers.delete(value);
    }
    return;
  }

  if (isRecord(value)) {
    assertContainerCanBeVisited(value, field, state);
    const entries = Object.entries(value);
    if (entries.length > state.options.limits.maxEntriesPerContainer) {
      throw new TypeError(`${field} exceeds the JSON container entry limit.`);
    }

    state.activeContainers.add(value);
    try {
      for (const [entryKey, item] of entries) {
        accountJsonBoundaryString(
          entryKey,
          `${field} object key`,
          state
        );
        normalizeJsonBoundaryValue(
          item,
          `${field}.${entryKey}`,
          depth + 1,
          state,
          entryKey
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
  state: JsonBoundaryState
): void {
  const rawStringBytes = jsonBoundaryUtf8ByteLength(value);
  state.totalStringBytes += rawStringBytes;
  if (rawStringBytes > state.options.limits.maxStringBytes) {
    throw new TypeError(`${field} exceeds the JSON string byte limit.`);
  }
  if (state.totalStringBytes > state.options.limits.maxTotalStringBytes) {
    throw new TypeError(
      `${state.options.field} exceeds the aggregate JSON text limit.`
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
  state: JsonBoundaryState
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
  state: JsonBoundaryState
): void {
  if (state.activeContainers.has(value)) {
    throw new TypeError(`${field} must not contain cycles.`);
  }
}

const credentialMetricKeys = new Set([
  'acceptedpredictiontokens',
  'inputtokens',
  'outputtokens',
  'prompttokens',
  'prompttokensdetails',
  'reasoningtokens',
  'rejectedpredictiontokens',
  'tokencount',
  'tokenusage',
  'totaltokens'
]);

const exactCredentialKeys = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'clientsecret',
  'privatekey',
  'accesskey',
  'secretkey',
  'sessionkey'
]);

export function isJsonBoundaryCredentialKey(value: string): boolean {
  const normalized = value.toLowerCase().replaceAll(/[^a-z0-9]/gu, '');

  if (credentialMetricKeys.has(normalized)) {
    return false;
  }

  return (
    exactCredentialKeys.has(normalized) ||
    normalized.includes('apikey') ||
    normalized.includes('accesstoken') ||
    normalized.includes('refreshtoken') ||
    normalized.includes('clientsecret') ||
    normalized.includes('secretaccesskey') ||
    normalized.includes('privatekey') ||
    normalized.includes('accesskey') ||
    normalized.includes('sessionkey') ||
    normalized.includes('password') ||
    normalized.includes('passphrase') ||
    normalized.includes('credential') ||
    normalized.endsWith('token') ||
    normalized.endsWith('secret')
  );
}

const authorizationHeaderPattern =
  /\b(Authorization|Proxy-Authorization)(\s*[:=]\s*)[^\r\n]+/giu;
const authenticationSchemePattern =
  /\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/giu;
const cookieHeaderPattern =
  /\b(Cookie|Set-Cookie)(\s*[:=]\s*)[^\r\n]+/giu;
const secretKeyValuePattern =
  /(["']?)([A-Za-z0-9_.-]*(?:api[_.-]?key|access[_.-]?token|refresh[_.-]?token|client[_.-]?secret|secret[_.-]?access[_.-]?key|private[_.-]?key|access[_.-]?key|session[_.-]?key|password|passphrase|credential|secret|token)[A-Za-z0-9_.-]*)\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^&#\s,;}]+)/giu;
const secretQueryValuePattern =
  /([?&][A-Za-z0-9_.-]*(?:api[_.-]?key|access[_.-]?token|refresh[_.-]?token|client[_.-]?secret|secret[_.-]?access[_.-]?key|private[_.-]?key|access[_.-]?key|session[_.-]?key|password|passphrase|credential|secret|token)[A-Za-z0-9_.-]*=)[^&#\s]+/giu;
const uriCredentialsPattern =
  /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/@\s]+)@/giu;

export function redactJsonBoundaryText(value: string): string {
  return value
    .replace(authorizationHeaderPattern, '$1$2[redacted]')
    .replace(authenticationSchemePattern, '$1 [redacted]')
    .replace(cookieHeaderPattern, '$1$2[redacted]')
    .replace(secretKeyValuePattern, redactSecretKeyValueMatch)
    .replace(secretQueryValuePattern, '$1[redacted]')
    .replace(uriCredentialsPattern, '$1[redacted]@');
}

export function redactJsonTextPreservingStructure(
  value: string,
  field: string
): string {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    return redactJsonBoundaryText(value);
  }

  try {
    return JSON.stringify(
      createJsonBoundarySnapshot(parsed, {
        field,
        redact: true
      })
    );
  } catch {
    return '';
  }
}

function redactSecretKeyValueMatch(
  _match: string,
  keyQuote: string,
  key: string,
  separator: string,
  rawValue: string
): string {
  const valueQuote = rawValue.startsWith('"')
    ? '"'
    : rawValue.startsWith("'")
      ? "'"
      : '';

  return `${keyQuote}${key}${keyQuote}${separator}${valueQuote}[redacted]${valueQuote}`;
}

function isJsonBoundaryObject(value: JsonBoundaryValue): value is JsonBoundaryObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
