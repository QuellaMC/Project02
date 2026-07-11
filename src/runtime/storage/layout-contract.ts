import { join } from 'node:path';
import { assertCanonicalRuntimeTimestamp } from '../event.ts';

export const defaultLocalRuntimeStoreRoot = '.project02-runtime';

export const defaultLocalRuntimeSessionId = 'local-session';

export const localRuntimeStorageSchemaVersion = 3;

export type LocalRuntimeReadableStorageSchemaVersion =
  | 1
  | typeof localRuntimeStorageSchemaVersion;

export const localRuntimeReadableStorageSchemaVersions: readonly LocalRuntimeReadableStorageSchemaVersion[] =
  Object.freeze([1, localRuntimeStorageSchemaVersion]);

export type LocalRuntimeStorageContractErrorCode =
  | 'concurrent_write'
  | 'invalid_session_id'
  | 'invalid_plugin_id'
  | 'malformed_record'
  | 'malformed_schema_marker'
  | 'missing_file'
  | 'partial_write'
  | 'read_failed'
  | 'session_busy'
  | 'stale_session'
  | 'storage_busy'
  | 'unsupported_schema_version'
  | 'write_failed';

export class LocalRuntimeStorageContractError extends Error {
  readonly code: LocalRuntimeStorageContractErrorCode;

  constructor(
    code: LocalRuntimeStorageContractErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'LocalRuntimeStorageContractError';
    this.code = code;
  }
}

export type LocalRuntimeStorageLayout = {
  readonly storeRoot: string;
  readonly configPath: string;
  readonly envPath: string;
  readonly schemaPath: string;
  readonly locksRoot: string;
  readonly sessionCatalogPath: string;
  readonly sessionsRoot: string;
};

export type LocalRuntimeSessionPaths = {
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly sessionRoot: string;
  readonly pluginsRoot: string;
  readonly tracePath: string;
  readonly rawEventsPath: string;
  readonly conversationPath: string;
};

export type LocalRuntimePluginPaths = {
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly pluginId: string;
  readonly sessionRoot: string;
  readonly pluginsRoot: string;
  readonly pluginRoot: string;
};

export type LocalRuntimeStorageLayoutOptions = {
  readonly storeRoot?: string;
};

export type LocalRuntimeSessionPathsOptions = LocalRuntimeStorageLayoutOptions & {
  readonly sessionId?: string;
};

export type LocalRuntimePluginPathsOptions = LocalRuntimeSessionPathsOptions & {
  readonly pluginId: string;
};

export type LocalRuntimeStorageSchemaMarker = {
  readonly schemaVersion: LocalRuntimeReadableStorageSchemaVersion;
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

const configFileName = 'config.json';

const envFileName = '.env';

const schemaFileName = 'schema.json';

const sessionCatalogFileName = 'sessions.jsonl';

const sessionsDirectoryName = 'sessions';

const locksDirectoryName = '.locks';

const pluginsDirectoryName = 'plugins';

const traceFileName = 'trace.jsonl';

const rawEventsFileName = 'raw-events.jsonl';

const conversationFileName = 'conversation.jsonl';

const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

const pluginIdPattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;

export function createLocalRuntimeStorageLayout(
  options: LocalRuntimeStorageLayoutOptions = {}
): LocalRuntimeStorageLayout {
  const storeRoot = normalizeStoreRoot(options.storeRoot);
  const sessionsRoot = join(storeRoot, sessionsDirectoryName);

  return Object.freeze({
    storeRoot,
    configPath: join(storeRoot, configFileName),
    envPath: join(storeRoot, envFileName),
    schemaPath: join(storeRoot, schemaFileName),
    locksRoot: join(storeRoot, locksDirectoryName),
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
  const pluginsRoot = join(sessionRoot, pluginsDirectoryName);

  return Object.freeze({
    storeRoot: layout.storeRoot,
    sessionId,
    sessionRoot,
    pluginsRoot,
    tracePath: join(sessionRoot, traceFileName),
    rawEventsPath: join(sessionRoot, rawEventsFileName),
    conversationPath: join(sessionRoot, conversationFileName)
  } satisfies LocalRuntimeSessionPaths);
}

export function createLocalRuntimePluginPaths(
  options: LocalRuntimePluginPathsOptions
): LocalRuntimePluginPaths {
  const sessionPaths = createLocalRuntimeSessionPaths(options);
  const pluginId = normalizeLocalRuntimePluginId(options.pluginId);

  return Object.freeze({
    storeRoot: sessionPaths.storeRoot,
    sessionId: sessionPaths.sessionId,
    pluginId,
    sessionRoot: sessionPaths.sessionRoot,
    pluginsRoot: sessionPaths.pluginsRoot,
    pluginRoot: join(sessionPaths.pluginsRoot, pluginId)
  } satisfies LocalRuntimePluginPaths);
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

export function normalizeLocalRuntimePluginId(pluginId: string): string {
  const normalizedPluginId = pluginId.trim();

  if (!pluginIdPattern.test(normalizedPluginId)) {
    throw new LocalRuntimeStorageContractError(
      'invalid_plugin_id',
      'Local runtime plugin ID must start with a letter and use only letters, numbers, dots, underscores, or hyphens.'
    );
  }

  return normalizedPluginId;
}

export function createLocalRuntimeSessionMetadata(
  options: CreateLocalRuntimeSessionMetadataOptions
): LocalRuntimeSessionMetadata {
  return Object.freeze({
    sessionId: normalizeLocalRuntimeSessionId(options.sessionId),
    createdAt: requiredCanonicalTimestamp(
      options.createdAt,
      'createdAt',
      'malformed_record'
    ),
    updatedAt: requiredCanonicalTimestamp(
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
    createdAt: requiredCanonicalTimestamp(
      options.createdAt,
      'createdAt',
      'malformed_schema_marker'
    )
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

  if (!isLocalRuntimeReadableStorageSchemaVersion(schemaVersion)) {
    throw new LocalRuntimeStorageContractError(
      'unsupported_schema_version',
      `Unsupported local runtime storage schema version: ${String(schemaVersion)}.`
    );
  }

  return Object.freeze({
    schemaVersion,
    createdAt: requiredRecordCanonicalTimestamp(
      record,
      'createdAt',
      'malformed_schema_marker'
    )
  } satisfies LocalRuntimeStorageSchemaMarker);
}

function isLocalRuntimeReadableStorageSchemaVersion(
  schemaVersion: number
): schemaVersion is LocalRuntimeReadableStorageSchemaVersion {
  return localRuntimeReadableStorageSchemaVersions.some(
    (readableVersion) => readableVersion === schemaVersion
  );
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

export function parseJsonObject(
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

export function requiredRecordString(
  record: Record<string, unknown>,
  key: string,
  code: LocalRuntimeStorageContractErrorCode
): string {
  return requiredNonEmptyString(record[key], key, code);
}

export function requiredRecordCanonicalTimestamp(
  record: Record<string, unknown>,
  key: string,
  code: LocalRuntimeStorageContractErrorCode
): string {
  return requiredCanonicalTimestamp(record[key], key, code);
}

function requiredCanonicalTimestamp(
  value: unknown,
  key: string,
  code: LocalRuntimeStorageContractErrorCode
): string {
  const timestamp = requiredNonEmptyString(value, key, code);

  try {
    return assertCanonicalRuntimeTimestamp(
      timestamp,
      `Stored local runtime field "${key}"`
    );
  } catch (error: unknown) {
    throw new LocalRuntimeStorageContractError(
      code,
      `Stored local runtime field "${key}" must be a canonical UTC ISO timestamp.`,
      { cause: error }
    );
  }
}

export function requiredNonEmptyString(
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function throwMalformedSchemaMarker(field: string): never {
  throw new LocalRuntimeStorageContractError(
    'malformed_schema_marker',
    `Stored local runtime schema field "${field}" is malformed.`
  );
}
