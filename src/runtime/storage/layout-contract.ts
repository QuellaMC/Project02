import {isJsonRecord as isRecord} from '../../shared/json-boundary.ts';
import {basename, dirname, join} from 'node:path';
import {assertCanonicalRuntimeTimestamp} from '../../core/index.ts';
import {isProject02Identifier} from '../../shared/identifier.ts';
import {isOneOf} from '../../shared/one-of.ts';

export const defaultProject02HomeRoot = '.project02';

export const defaultLocalRuntimeSessionId = 'local-session';

// v5: the conversation log became per-message (commit-as-emitted) — role is
// a recorded fact, turns may hold any number of visible messages, and each
// message anchors to its own visible_message_committed raw event. v4 stores
// were written under the strict user/character pair rule and fail closed.
// v6: raw-events.jsonl became the one session log. The turn trace is
// derived from it, trace.jsonl is no longer written or read, and a
// trailing turn a crash left without its terminal event is an incomplete
// state the reader surfaces, not damage. v5 stores fail closed.
// v7: a tool's input contract is JSON Schema. Persisted plugin tool
// definitions carry properties/required/additionalProperties where v6
// carried a fields list, and a v6 record would decode as a malformed
// contract rather than an older one, so v6 stores fail closed.
export const localRuntimeStorageSchemaVersion = 7;

export type LocalRuntimeReadableStorageSchemaVersion =
  typeof localRuntimeStorageSchemaVersion;

export const localRuntimeReadableStorageSchemaVersions: readonly LocalRuntimeReadableStorageSchemaVersion[] =
  Object.freeze([localRuntimeStorageSchemaVersion]);

const localRuntimeStorageScopeValues = Object.freeze([
  'home',
  'character-data',
] as const);

export type LocalRuntimeStorageScope =
  (typeof localRuntimeStorageScopeValues)[number];

export type LocalRuntimeStorageContractErrorCode =
  | 'character_identity_mismatch'
  | 'concurrent_write'
  | 'invalid_character_id'
  | 'invalid_session_id'
  | 'invalid_plugin_id'
  | 'malformed_record'
  | 'malformed_schema_marker'
  | 'missing_file'
  | 'partial_write'
  | 'read_failed'
  | 'session_busy'
  | 'storage_busy'
  | 'unsupported_schema_version'
  | 'write_failed';

export class LocalRuntimeStorageContractError extends Error {
  readonly code: LocalRuntimeStorageContractErrorCode;

  constructor(
    code: LocalRuntimeStorageContractErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LocalRuntimeStorageContractError';
    this.code = code;
  }
}

// The shared home: global config, secrets, installed packages, and the
// per-character data directories. Exactly one lock family lives here
// (runtime-control-file:* for the global config/.env writes).
export type Project02HomeLayout = {
  readonly homeRoot: string;
  readonly configPath: string;
  readonly envPath: string;
  readonly schemaPath: string;
  readonly locksRoot: string;
  readonly pluginPackagesRoot: string;
  readonly characterPackagesRoot: string;
  readonly characterDataRoot: string;
};

// One character's data directory under <home>/character-data/<id>:
// sessions, plugin state, the character-scoped config overlay, and one
// identity-bearing schema marker. Deliberately has no envPath or package roots so shared
// concerns cannot be derived from a data root by accident.
export type LocalRuntimeStorageLayout = {
  readonly storeRoot: string;
  readonly configPath: string;
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
  readonly rawEventsPath: string;
};

export type LocalRuntimePluginPaths = {
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly pluginId: string;
  readonly sessionRoot: string;
  readonly pluginsRoot: string;
  readonly pluginRoot: string;
};

export type Project02HomeLayoutOptions = {
  readonly homeRoot?: string;
};

export type LocalRuntimeStorageLayoutOptions = {
  /**
   * The character DATA directory this store lives in. Required at the
   * type level since the home/character-data split: there is no
   * meaningful default — a caller must always know which character's
   * directory it operates on.
   */
  readonly storeRoot: string;
};

export type LocalRuntimeSessionPathsOptions =
  LocalRuntimeStorageLayoutOptions & {
    readonly sessionId?: string;
  };

export type LocalRuntimePluginPathsOptions = LocalRuntimeSessionPathsOptions & {
  readonly pluginId: string;
};

export type LocalRuntimeHomeStorageSchemaMarker = {
  readonly schemaVersion: LocalRuntimeReadableStorageSchemaVersion;
  readonly scope: 'home';
  readonly createdAt: string;
};

export type LocalRuntimeCharacterDataStorageSchemaMarker = {
  readonly schemaVersion: LocalRuntimeReadableStorageSchemaVersion;
  readonly scope: 'character-data';
  readonly characterId: string;
  readonly createdAt: string;
  readonly materializedCharacterPackageVersion?: string;
};

export type LocalRuntimeStorageSchemaMarker =
  | LocalRuntimeHomeStorageSchemaMarker
  | LocalRuntimeCharacterDataStorageSchemaMarker;

export type CreateLocalRuntimeStorageSchemaMarkerOptions =
  | {
      readonly scope: 'home';
      readonly createdAt: string;
    }
  | {
      readonly scope: 'character-data';
      readonly characterId: string;
      readonly createdAt: string;
      readonly materializedCharacterPackageVersion?: string;
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

// Same directory name as the characters loader's operator root
// (src/characters/loader/discovery.ts); the loader cannot import runtime,
// so the one-word literal is deliberately duplicated there.
const charactersDirectoryName = 'characters';

export const characterDataDirectoryName = 'character-data';

const rawEventsFileName = 'raw-events.jsonl';

const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export function createProject02HomeLayout(
  options: Project02HomeLayoutOptions = {},
): Project02HomeLayout {
  const homeRoot = normalizeRootPath(
    options.homeRoot ?? defaultProject02HomeRoot,
    'Project02 home root',
  );

  return Object.freeze({
    homeRoot,
    configPath: join(homeRoot, configFileName),
    envPath: join(homeRoot, envFileName),
    schemaPath: join(homeRoot, schemaFileName),
    locksRoot: join(homeRoot, locksDirectoryName),
    pluginPackagesRoot: join(homeRoot, pluginsDirectoryName),
    characterPackagesRoot: join(homeRoot, charactersDirectoryName),
    characterDataRoot: join(homeRoot, characterDataDirectoryName),
  } satisfies Project02HomeLayout);
}

/**
 * Inverse of characterDataDirPath: the home a character-data directory
 * belongs to. Throws when the path is not shaped like one, so callers
 * cannot silently treat an arbitrary directory as a data dir.
 */
export function homeRootForCharacterDataDir(dataRoot: string): string {
  const parent = dirname(dataRoot);

  if (basename(parent) !== characterDataDirectoryName) {
    throw new LocalRuntimeStorageContractError(
      'missing_file',
      `Directory "${dataRoot}" is not a character-data directory.`,
    );
  }

  return dirname(parent);
}

export function characterDataDirPath(
  homeRoot: string | undefined,
  characterId: string,
): string {
  const home = createProject02HomeLayout(
    homeRoot === undefined ? {} : {homeRoot},
  );

  return join(
    home.characterDataRoot,
    normalizeLocalRuntimeCharacterId(characterId),
  );
}

export function normalizeLocalRuntimeCharacterId(characterId: string): string {
  const normalized = characterId.trim();

  if (!isProject02Identifier(normalized)) {
    throw new LocalRuntimeStorageContractError(
      'invalid_character_id',
      'Local runtime character ID must start with a letter and use only letters, numbers, dots, underscores, or hyphens.',
    );
  }

  return normalized;
}

export function createLocalRuntimeStorageLayout(
  options: LocalRuntimeStorageLayoutOptions,
): LocalRuntimeStorageLayout {
  const storeRoot = normalizeRootPath(options.storeRoot, 'Character data root');
  const sessionsRoot = join(storeRoot, sessionsDirectoryName);

  return Object.freeze({
    storeRoot,
    configPath: join(storeRoot, configFileName),
    schemaPath: join(storeRoot, schemaFileName),
    locksRoot: join(storeRoot, locksDirectoryName),
    sessionCatalogPath: join(storeRoot, sessionCatalogFileName),
    sessionsRoot,
  } satisfies LocalRuntimeStorageLayout);
}

export function createLocalRuntimeSessionPaths(
  options: LocalRuntimeSessionPathsOptions,
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
    rawEventsPath: join(sessionRoot, rawEventsFileName),
  } satisfies LocalRuntimeSessionPaths);
}

export function createLocalRuntimePluginPaths(
  options: LocalRuntimePluginPathsOptions,
): LocalRuntimePluginPaths {
  const sessionPaths = createLocalRuntimeSessionPaths(options);
  const pluginId = normalizeLocalRuntimePluginId(options.pluginId);

  return Object.freeze({
    storeRoot: sessionPaths.storeRoot,
    sessionId: sessionPaths.sessionId,
    pluginId,
    sessionRoot: sessionPaths.sessionRoot,
    pluginsRoot: sessionPaths.pluginsRoot,
    pluginRoot: join(sessionPaths.pluginsRoot, pluginId),
  } satisfies LocalRuntimePluginPaths);
}

export function normalizeLocalRuntimeSessionId(
  sessionId: string | undefined,
): string {
  const normalizedSessionId = sessionId?.trim() ?? defaultLocalRuntimeSessionId;

  if (normalizedSessionId.length === 0) {
    throw new LocalRuntimeStorageContractError(
      'invalid_session_id',
      'Local runtime session ID must be non-empty.',
    );
  }

  if (
    normalizedSessionId === '.' ||
    normalizedSessionId === '..' ||
    !sessionIdPattern.test(normalizedSessionId)
  ) {
    throw new LocalRuntimeStorageContractError(
      'invalid_session_id',
      'Local runtime session ID must use only letters, numbers, dots, underscores, or hyphens.',
    );
  }

  return normalizedSessionId;
}

export function normalizeLocalRuntimePluginId(pluginId: string): string {
  const normalizedPluginId = pluginId.trim();

  if (!isProject02Identifier(normalizedPluginId)) {
    throw new LocalRuntimeStorageContractError(
      'invalid_plugin_id',
      'Local runtime plugin ID must start with a letter and use only letters, numbers, dots, underscores, or hyphens.',
    );
  }

  return normalizedPluginId;
}

export function createLocalRuntimeSessionMetadata(
  options: CreateLocalRuntimeSessionMetadataOptions,
): LocalRuntimeSessionMetadata {
  return Object.freeze({
    sessionId: normalizeLocalRuntimeSessionId(options.sessionId),
    createdAt: requiredCanonicalTimestamp(
      options.createdAt,
      'createdAt',
      'malformed_record',
    ),
    updatedAt: requiredCanonicalTimestamp(
      options.updatedAt ?? options.createdAt,
      'updatedAt',
      'malformed_record',
    ),
  } satisfies LocalRuntimeSessionMetadata);
}

export function createLocalRuntimeStorageSchemaMarker(
  options: CreateLocalRuntimeStorageSchemaMarkerOptions,
): LocalRuntimeStorageSchemaMarker {
  const common = {
    schemaVersion: localRuntimeStorageSchemaVersion,
    createdAt: requiredCanonicalTimestamp(
      options.createdAt,
      'createdAt',
      'malformed_schema_marker',
    ),
  } as const;

  if (options.scope === 'home') {
    return Object.freeze({
      ...common,
      scope: 'home',
    } satisfies LocalRuntimeHomeStorageSchemaMarker);
  }

  return Object.freeze({
    ...common,
    scope: 'character-data',
    characterId: normalizeLocalRuntimeCharacterId(options.characterId),
    ...(options.materializedCharacterPackageVersion === undefined
      ? {}
      : {
          materializedCharacterPackageVersion: requiredCharacterPackageVersion(
            options.materializedCharacterPackageVersion,
          ),
        }),
  } satisfies LocalRuntimeCharacterDataStorageSchemaMarker);
}

function requiredStorageScope(value: unknown): LocalRuntimeStorageScope {
  if (!isOneOf(value, localRuntimeStorageScopeValues)) {
    throwMalformedSchemaMarker('scope');
  }

  return value;
}

export function encodeStorageSchemaMarker(
  marker: LocalRuntimeStorageSchemaMarker,
): string {
  return JSON.stringify(marker);
}

export function decodeStorageSchemaMarker(
  line: string,
): LocalRuntimeStorageSchemaMarker {
  const record = parseJsonObject(line, 'malformed_schema_marker');
  const schemaVersion = record['schemaVersion'];

  if (typeof schemaVersion !== 'number') {
    throwMalformedSchemaMarker('schemaVersion');
  }

  if (!isLocalRuntimeReadableStorageSchemaVersion(schemaVersion)) {
    throw new LocalRuntimeStorageContractError(
      'unsupported_schema_version',
      `This store uses storage schema version ${String(schemaVersion)}, but this ` +
        `version of Project02 reads only version ${String(localRuntimeStorageSchemaVersion)}. ` +
        'To keep this store, run the Project02 version that created it; to ' +
        'continue here, choose a different store directory or delete this one ' +
        'and start fresh.',
    );
  }

  const scope = requiredStorageScope(record['scope']);
  const common = {
    schemaVersion,
    createdAt: requiredRecordCanonicalTimestamp(
      record,
      'createdAt',
      'malformed_schema_marker',
    ),
  } as const;

  if (scope === 'home') {
    return Object.freeze({
      ...common,
      scope,
    } satisfies LocalRuntimeHomeStorageSchemaMarker);
  }

  const characterId = record['characterId'];
  const materializedCharacterPackageVersion =
    record['materializedCharacterPackageVersion'];

  if (typeof characterId !== 'string' || !isProject02Identifier(characterId)) {
    throwMalformedSchemaMarker('characterId');
  }

  if (
    materializedCharacterPackageVersion !== undefined &&
    (typeof materializedCharacterPackageVersion !== 'string' ||
      !characterPackageVersionPattern.test(materializedCharacterPackageVersion))
  ) {
    throwMalformedSchemaMarker('materializedCharacterPackageVersion');
  }

  return Object.freeze({
    ...common,
    scope,
    characterId,
    ...(materializedCharacterPackageVersion === undefined
      ? {}
      : {materializedCharacterPackageVersion}),
  } satisfies LocalRuntimeCharacterDataStorageSchemaMarker);
}

const characterPackageVersionPattern = /^\d+\.\d+\.\d+$/u;

function requiredCharacterPackageVersion(value: string): string {
  if (!characterPackageVersionPattern.test(value)) {
    throw new LocalRuntimeStorageContractError(
      'malformed_schema_marker',
      'Materialized character package version must be a semantic version like "1.0.0".',
    );
  }

  return value;
}

function isLocalRuntimeReadableStorageSchemaVersion(
  schemaVersion: number,
): schemaVersion is LocalRuntimeReadableStorageSchemaVersion {
  return localRuntimeReadableStorageSchemaVersions.some(
    readableVersion => readableVersion === schemaVersion,
  );
}

function normalizeRootPath(root: string | undefined, label: string): string {
  const normalized = root?.trim();

  if (normalized === undefined || normalized.length === 0) {
    throw new LocalRuntimeStorageContractError(
      'malformed_schema_marker',
      `${label} must be a non-empty path.`,
    );
  }

  return normalized;
}

export function parseJsonObject(
  line: string,
  code: 'malformed_record' | 'malformed_schema_marker',
): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new LocalRuntimeStorageContractError(
      code,
      'Stored local runtime record is not valid JSON.',
    );
  }

  if (!isRecord(parsed)) {
    throw new LocalRuntimeStorageContractError(
      code,
      'Stored local runtime record must be an object.',
    );
  }

  return parsed;
}

export function requiredRecordString(
  record: Record<string, unknown>,
  key: string,
  code: LocalRuntimeStorageContractErrorCode,
): string {
  return requiredNonEmptyString(record[key], key, code);
}

export function requiredRecordCanonicalTimestamp(
  record: Record<string, unknown>,
  key: string,
  code: LocalRuntimeStorageContractErrorCode,
): string {
  return requiredCanonicalTimestamp(record[key], key, code);
}

function requiredCanonicalTimestamp(
  value: unknown,
  key: string,
  code: LocalRuntimeStorageContractErrorCode,
): string {
  const timestamp = requiredNonEmptyString(value, key, code);

  try {
    return assertCanonicalRuntimeTimestamp(
      timestamp,
      `Stored local runtime field "${key}"`,
    );
  } catch (error: unknown) {
    throw new LocalRuntimeStorageContractError(
      code,
      `Stored local runtime field "${key}" must be a canonical UTC ISO timestamp.`,
      {cause: error},
    );
  }
}

export function requiredNonEmptyString(
  value: unknown,
  key: string,
  code: LocalRuntimeStorageContractErrorCode,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LocalRuntimeStorageContractError(
      code,
      `Stored local runtime field "${key}" must be a non-empty string.`,
    );
  }

  return value;
}

function throwMalformedSchemaMarker(field: string): never {
  throw new LocalRuntimeStorageContractError(
    'malformed_schema_marker',
    `Stored local runtime schema field "${field}" is malformed.`,
  );
}

export {isRecord};
