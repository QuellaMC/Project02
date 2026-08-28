import {isJsonRecord as isRecord} from '../../shared/json-boundary.ts';
import {basename, dirname, join} from 'node:path';
import {assertCanonicalRuntimeTimestamp} from '../../core/index.ts';
import {isProject02Identifier} from '../../shared/identifier.ts';
import {isOneOf} from '../../shared/one-of.ts';

export const defaultProject02HomeRoot = '.project02';

// Bumped whenever a persisted shape changes; only stores written at this
// exact version are readable, and older ones fail closed by version.
export const localRuntimeStorageSchemaVersion = 13;

const localRuntimeStorageScopeValues = Object.freeze([
  'home',
  'character-data',
] as const);

type LocalRuntimeStorageScope = (typeof localRuntimeStorageScopeValues)[number];

export type LocalRuntimeStorageContractErrorCode =
  | 'character_identity_mismatch'
  | 'concurrent_write'
  | 'conversation_busy'
  | 'invalid_character_id'
  | 'invalid_conversation_id'
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

// Home lock families: runtime-control-file:* for the global config and
// .env writes, conversations-catalog for conversation creation, and
// conversation-writer:* for one process owning an open conversation.
export type Project02HomeLayout = {
  readonly homeRoot: string;
  readonly configPath: string;
  readonly envPath: string;
  readonly schemaPath: string;
  readonly locksRoot: string;
  readonly pluginPackagesRoot: string;
  readonly characterPackagesRoot: string;
  readonly characterDataRoot: string;
  readonly conversationsRoot: string;
};

// Deliberately has no package roots, so installable concerns cannot be
// derived from a data root by accident. Secrets are per-character: each
// data root carries its own env file, so one character's credentials are
// never another character's to read.
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
  /** The character data directory this store lives in; there is no default. */
  readonly storeRoot: string;
};

export type LocalRuntimeSessionPathsOptions =
  LocalRuntimeStorageLayoutOptions & {
    readonly sessionId: string;
  };

export type LocalRuntimePluginPathsOptions = LocalRuntimeSessionPathsOptions & {
  readonly pluginId: string;
};

export type LocalRuntimeHomeStorageSchemaMarker = {
  readonly schemaVersion: typeof localRuntimeStorageSchemaVersion;
  readonly scope: 'home';
  readonly createdAt: string;
};

export type LocalRuntimeCharacterDataStorageSchemaMarker = {
  readonly schemaVersion: typeof localRuntimeStorageSchemaVersion;
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

/**
 * One character's participation in one conversation: the id is
 * "<conversationId>.<segment>", so the binding has a single source and the
 * previous segment is always the same id with the segment before it.
 */
export type LocalRuntimeSessionMetadata = {
  readonly sessionId: string;
  readonly createdAt: string;
};

export type CreateLocalRuntimeSessionMetadataOptions = {
  readonly sessionId: string;
  readonly createdAt: string;
};

const configFileName = 'config.json';

const envFileName = '.env';

const schemaFileName = 'schema.json';

const sessionCatalogFileName = 'sessions.jsonl';

const sessionsDirectoryName = 'sessions';

const locksDirectoryName = '.locks';

const pluginsDirectoryName = 'plugins';

// Deliberately duplicated in src/characters/loader/discovery.ts, which
// cannot import runtime.
const charactersDirectoryName = 'characters';

export const characterDataDirectoryName = 'character-data';

const conversationsDirectoryName = 'conversations';

export const conversationFileName = 'conversation.json';

export const rawEventsFileName = 'raw-events.jsonl';

const pluginDataDirectoryName = 'plugin-data';

const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

// No dots and 56 max, so a segment id "<conversationId>.<n>" has exactly
// one dot and stays inside the session-id pattern above, which is frozen:
// it is also the plugin-facing JSON-schema pattern for session ids.
const conversationIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,55}$/u;

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
    conversationsRoot: join(homeRoot, conversationsDirectoryName),
  } satisfies Project02HomeLayout);
}

/** Throws when the path is not shaped like a character-data directory. */
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
    envPath: join(storeRoot, envFileName),
    schemaPath: join(storeRoot, schemaFileName),
    locksRoot: join(storeRoot, locksDirectoryName),
    sessionCatalogPath: join(storeRoot, sessionCatalogFileName),
    sessionsRoot,
  } satisfies LocalRuntimeStorageLayout);
}

/**
 * A plugin's character-scoped durable data directory: cross-session, owned
 * by the plugin, and deleted with it. Session-scoped plugin state lives
 * under the session's own `plugins/` directory instead.
 */
export function characterPluginDataDirPath(options: {
  readonly storeRoot: string;
  readonly pluginId: string;
}): string {
  const layout = createLocalRuntimeStorageLayout({
    storeRoot: options.storeRoot,
  });

  return join(
    layout.storeRoot,
    pluginDataDirectoryName,
    normalizeLocalRuntimePluginId(options.pluginId),
  );
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

export type LocalRuntimeConversationPaths = {
  readonly homeRoot: string;
  readonly conversationId: string;
  readonly conversationRoot: string;
  readonly conversationPath: string;
};

export function createLocalRuntimeConversationPaths(options: {
  readonly homeRoot?: string;
  readonly conversationId: string;
}): LocalRuntimeConversationPaths {
  const home = createProject02HomeLayout(
    options.homeRoot === undefined ? {} : {homeRoot: options.homeRoot},
  );
  const conversationId = normalizeConversationId(options.conversationId);
  const conversationRoot = join(home.conversationsRoot, conversationId);

  return Object.freeze({
    homeRoot: home.homeRoot,
    conversationId,
    conversationRoot,
    conversationPath: join(conversationRoot, conversationFileName),
  } satisfies LocalRuntimeConversationPaths);
}

export function normalizeConversationId(conversationId: string): string {
  const normalized = conversationId.trim();

  if (!conversationIdPattern.test(normalized)) {
    throw new LocalRuntimeStorageContractError(
      'invalid_conversation_id',
      'Conversation ID must start with a letter or number and use only ' +
        'letters, numbers, underscores, or hyphens, at most 56 characters.',
    );
  }

  return normalized;
}

/** The one spelling of a character's participation in a conversation. */
export function segmentSessionId(
  conversationId: string,
  segment: number,
): string {
  if (!Number.isSafeInteger(segment) || segment < 1) {
    throw new LocalRuntimeStorageContractError(
      'invalid_session_id',
      'Session segment number must be a positive integer.',
    );
  }

  return `${normalizeConversationId(conversationId)}.${String(segment)}`;
}

export function parseSegmentSessionId(sessionId: string): {
  readonly conversationId: string;
  readonly segment: number;
} {
  const dotIndex = sessionId.lastIndexOf('.');
  const segmentText = dotIndex === -1 ? '' : sessionId.slice(dotIndex + 1);

  if (!/^[1-9][0-9]*$/u.test(segmentText)) {
    throw new LocalRuntimeStorageContractError(
      'invalid_session_id',
      `Session ID "${sessionId}" must be "<conversation-id>.<segment>" with a positive segment number.`,
    );
  }

  return Object.freeze({
    conversationId: normalizeConversationId(sessionId.slice(0, dotIndex)),
    segment: Number(segmentText),
  });
}

export function normalizeLocalRuntimeSessionId(sessionId: string): string {
  const normalizedSessionId = sessionId.trim();

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

function normalizeLocalRuntimePluginId(pluginId: string): string {
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
  const sessionId = normalizeLocalRuntimeSessionId(options.sessionId);
  const segment = parseSegmentSessionId(sessionId);

  return Object.freeze({
    sessionId: segmentSessionId(segment.conversationId, segment.segment),
    createdAt: requiredCanonicalTimestamp(
      options.createdAt,
      'createdAt',
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

  if (schemaVersion !== localRuntimeStorageSchemaVersion) {
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
