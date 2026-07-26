import {existsSync, readFileSync, unlinkSync} from 'node:fs';

import {
  createJsonBoundaryObjectSnapshot,
  createJsonBoundarySnapshot,
  isJsonBoundaryObject,
  ownJsonRecordValue,
  type JsonBoundaryObject,
  type JsonBoundaryValue,
} from '../../shared/json-boundary.ts';
import {
  atomicReplaceFileSync,
  cleanupAbandonedAtomicReplacementFilesSync,
} from '../storage/atomic-file.ts';
import {
  isRuntimeControlEnvVarName,
  runtimeConfigVersion,
  type LoadedProject02RuntimeConfig,
  type Project02HostConfig,
  type Project02RuntimeConfig,
  type RuntimeConfigDiagnostic,
  type RuntimeConfigMutationOperation,
  type RuntimeConfigValue,
} from './types.ts';
import {validateProject02RuntimeConfig} from './load.ts';
import {redactRuntimeConfigValue} from './redact.ts';
import {
  canonicalRuntimeConfigPath,
  RuntimeConfigPathResolutionError,
} from './path.ts';
import {
  characterRuntimeConfigFieldScopeViolation,
  type Project02ConfigFieldDefinition,
  project02RuntimeConfigFieldDefinition,
  project02RuntimeConfigFieldDefinitions,
  project02RuntimeConfigValueMatchesField,
} from './schema.ts';

export type RuntimeConfigMutationResult = {
  readonly configPath: string;
  readonly envPath: string;
  readonly config: Project02RuntimeConfig;
  readonly fingerprint: string;
};

export type PreparedRuntimeConfigMutationCandidate = {
  readonly config: Project02RuntimeConfig;
};

/**
 * Commits one already-prepared candidate to exact paths while the caller
 * holds the transaction's complete lock set. This primitive never resolves
 * locations, acquires locks, reloads config, or retries.
 */
export function commitPreparedRuntimeConfigMutation(options: {
  readonly canonicalConfigPath: string;
  readonly displayConfigPath: string;
  readonly canonicalEnvPath: string;
  readonly displayEnvPath: string;
  readonly operation?: RuntimeConfigMutationOperation;
  readonly preparedCandidate: PreparedRuntimeConfigMutationCandidate;
}): void {
  if (
    options.operation?.kind === 'secret_set' &&
    options.canonicalConfigPath === options.canonicalEnvPath
  ) {
    throw new TypeError(
      'Cannot write runtime config secret because the selected config path and runtime env path resolve to the same file.',
    );
  }

  cleanupRuntimeConfigAtomicTemps(
    options.canonicalConfigPath,
    options.displayConfigPath,
    'config',
  );

  if (options.operation?.kind !== 'secret_set') {
    writeJsonAtomic(
      options.canonicalConfigPath,
      options.preparedCandidate.config,
      0o600,
    );
  } else {
    cleanupRuntimeConfigAtomicTemps(
      options.canonicalEnvPath,
      options.displayEnvPath,
      'env',
    );
    const secretWrite = prepareEnvSecretWrite(
      options.canonicalEnvPath,
      options.operation.envVar,
      options.operation.secretValue,
    );
    const previousConfigState = snapshotPreviousConfigState(
      options.canonicalConfigPath,
    );

    writeJsonAtomic(
      options.canonicalConfigPath,
      options.preparedCandidate.config,
      0o600,
    );

    try {
      writePreparedEnvSecret(secretWrite);
    } catch (error: unknown) {
      throwRuntimeConfigSecretWriteFailure(error, previousConfigState);
    }
  }
}

export class RuntimeConfigMutationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RuntimeConfigMutationError';
  }
}

export class RuntimeConfigConflictError extends RuntimeConfigMutationError {
  // Stable machine-readable marker: plugins detect conflicts through this
  // code (isRuntimeConfigConflictError in the builtin plugin) instead of
  // importing the class. Keep in sync with runtimeConfigConflictErrorCode.
  readonly code = 'runtime_config_conflict';

  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigConflictError';
  }
}

function throwRuntimeConfigSecretWriteFailure(
  error: unknown,
  previousConfigState: PreviousConfigState,
): never {
  const rollbackError = restorePreviousConfigState(previousConfigState);

  if (rollbackError !== undefined) {
    throw new RuntimeConfigMutationError(
      'Could not write runtime config secret and failed to roll back the config update.',
      {
        cause: new AggregateError(
          [error, rollbackError],
          'Runtime config secret write failed and config rollback failed.',
          {cause: error},
        ),
      },
    );
  }

  throw error;
}

function cleanupRuntimeConfigAtomicTemps(
  path: string,
  displayPath: string,
  kind: 'config' | 'env',
): void {
  try {
    cleanupAbandonedAtomicReplacementFilesSync(path);
  } catch (error: unknown) {
    throw mutationFileAccessError(
      kind === 'config'
        ? `Could not write runtime config file at ${displayPath}.`
        : `Could not write runtime config env file at ${displayPath}.`,
      error,
    );
  }
}

function bootstrapRuntimeConfig(options: {
  readonly storeRoot?: string;
}): Project02RuntimeConfig {
  if (options.storeRoot !== undefined) {
    return {
      version: runtimeConfigVersion,
      project02: Object.freeze({storeRoot: options.storeRoot}),
    };
  }

  return {version: runtimeConfigVersion};
}

/**
 * A candidate written to an overlay-located file must stay within the
 * character-scoped dialect regardless of which internal control path
 * prepared it. Public callers select this scope with --character.
 */
export function assertOverlayLocatedCandidateStaysCharacterScoped(
  candidate: Project02RuntimeConfig,
): void {
  const section = candidate.project02;

  if (section === undefined) {
    return;
  }

  for (const field of project02RuntimeConfigFieldDefinitions()) {
    const violation = characterRuntimeConfigFieldScopeViolation(field);

    if (violation !== undefined && section[field.name] !== undefined) {
      throw new RuntimeConfigMutationError(violation);
    }
  }
}

export type RuntimeConfigAuthoredSnapshot = Readonly<{
  /** Exact readable authored JSON, or the one bootstrap document if absent. */
  document: JsonBoundaryObject;
  /** Present only when that document is already schema-valid. */
  validatedConfig?: Project02RuntimeConfig;
}>;

/**
 * One authored layer as the mutation machinery sees it, independent of
 * which file it came from. A layer is repairable exactly when its
 * authored document was readable: the edit then applies to the real
 * bytes and the complete candidate is validated afterwards, so an
 * invalid field can be fixed in place instead of only by hand.
 */
export type AuthoredRuntimeConfigLayer = {
  readonly authoredDocument?: JsonBoundaryObject;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
};

/**
 * The one definition of "this layer failed to load so badly that no edit
 * can be based on it". Absence is not such a failure — it is the state a
 * bootstrap or a first overlay write is for — and neither is an invalid
 * value inside a document that was read, because that is precisely what
 * repair fixes. Every remaining error means there are no authored bytes
 * to edit: unparseable JSON, an unreadable file, a rejected symlink.
 *
 * Global and character scope share this predicate so that "can I repair
 * it with the CLI" has one answer per layer instead of one per file.
 */
export function blockingRuntimeConfigLayerDiagnostic(
  layer: AuthoredRuntimeConfigLayer,
): RuntimeConfigDiagnostic | undefined {
  return layer.authoredDocument === undefined
    ? layer.diagnostics.find(
        diagnostic =>
          diagnostic.severity === 'error' &&
          diagnostic.code !== 'runtime_config_missing',
      )
    : undefined;
}

export function createRuntimeConfigAuthoredSnapshot(
  loadedConfig: LoadedProject02RuntimeConfig,
): RuntimeConfigAuthoredSnapshot {
  if (loadedConfig.authoredDocument !== undefined) {
    return Object.freeze({
      document: loadedConfig.authoredDocument,
      ...(loadedConfig.config === undefined
        ? {}
        : {validatedConfig: loadedConfig.config}),
    });
  }

  if (loadedConfig.config !== undefined) {
    return Object.freeze({
      document: createJsonBoundaryObjectSnapshot(loadedConfig.config, {
        field: 'Runtime config authored snapshot',
      }),
      validatedConfig: loadedConfig.config,
    });
  }

  const selectedConfigPath =
    loadedConfig.selectedConfig?.canonicalPath ?? loadedConfig.path;

  if (selectedConfigPath === undefined) {
    throw new TypeError(
      'Absent runtime config bootstrap requires retained selection provenance.',
    );
  }

  const bootstrapStoreRoot =
    loadedConfig.selectedConfig?.runtimeHomeRoot ??
    (loadedConfig.selectedConfig === undefined
      ? undefined
      : loadedConfig.selectedConfig.owner.kind === 'home'
        ? loadedConfig.selectedConfig.owner.homeRoot
        : undefined);
  const canonicalBootstrapStoreRoot =
    bootstrapStoreRoot === undefined
      ? undefined
      : canonicalRuntimeConfigMutationPath(bootstrapStoreRoot);

  const validatedConfig = bootstrapRuntimeConfig({
    ...(canonicalBootstrapStoreRoot === undefined
      ? {}
      : {storeRoot: canonicalBootstrapStoreRoot}),
  });

  return Object.freeze({
    document: createJsonBoundaryObjectSnapshot(validatedConfig, {
      field: 'Runtime config bootstrap',
    }),
    validatedConfig,
  });
}

export function prepareRuntimeConfigMutationCandidate(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly operation?: RuntimeConfigMutationOperation;
  readonly validateCandidate?:
    ((config: Project02RuntimeConfig) => void) | undefined;
}): PreparedRuntimeConfigMutationCandidate {
  const blockingDiagnostic = blockingRuntimeConfigLayerDiagnostic(
    options.loadedConfig,
  );

  if (blockingDiagnostic !== undefined) {
    throw new TypeError(
      `Cannot mutate runtime config because it failed to load: ${blockingDiagnostic.message}`,
    );
  }

  const currentConfig = createRuntimeConfigAuthoredSnapshot(
    options.loadedConfig,
  ).document;
  const config = validateMutatedRuntimeConfig(
    options.operation === undefined
      ? currentConfig
      : mutateConfig(currentConfig, options.operation),
  );

  options.validateCandidate?.(config);

  return Object.freeze({
    config,
  } satisfies PreparedRuntimeConfigMutationCandidate);
}

export function getRedactedRuntimeConfigValueAtPath(
  config: Project02RuntimeConfig | undefined,
  path: string,
): RuntimeConfigValue | undefined {
  const parts = parseConfigPath(path);
  const value = getRuntimeConfigValueForParts(config, path, parts);

  if (value === undefined) {
    return undefined;
  }

  const key = redactionKeyForRuntimeConfigPath(config, path, parts);

  return key === undefined
    ? redactRuntimeConfigValue(value)
    : redactRuntimeConfigValue(value, {key});
}

function getRuntimeConfigValueForParts(
  config: Project02RuntimeConfig | undefined,
  _path: string,
  parts: readonly string[],
): RuntimeConfigValue | undefined {
  if (parts[0] === 'plugins') {
    throw new TypeError(
      'Plugin config values are not available through generic runtime config get.',
    );
  }

  if (config === undefined) {
    return undefined;
  }

  if (parts.length === 1) {
    const [field] = parts;

    return rootConfigValue(config, field);
  }

  if (parts[0] === 'project02' && parts.length === 2) {
    return project02ConfigValue(config, parts[1]);
  }

  return undefined;
}

function redactionKeyForRuntimeConfigPath(
  _config: Project02RuntimeConfig | undefined,
  _path: string,
  parts: readonly string[],
): string | undefined {
  if (parts.length === 1) {
    return parts[0];
  }

  if (parts[0] === 'project02' && parts.length === 2) {
    return parts[1];
  }

  return undefined;
}

function rootConfigValue(
  config: Project02RuntimeConfig,
  field: string | undefined,
): RuntimeConfigValue | undefined {
  switch (field) {
    case 'version':
      return config.version;
    case 'project02':
      return project02ConfigObject(config.project02);
    default:
      return undefined;
  }
}

function project02ConfigObject(
  config: Project02HostConfig | undefined,
): Readonly<Record<string, RuntimeConfigValue>> | undefined {
  if (config === undefined) {
    return undefined;
  }

  return frozenRuntimeConfigRecord(
    Object.entries(config).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, value]],
    ),
  );
}

function project02ConfigValue(
  config: Project02RuntimeConfig,
  field: string | undefined,
): RuntimeConfigValue | undefined {
  return field === undefined
    ? undefined
    : ownJsonRecordValue(config.project02, field);
}

function mutateConfig(
  config: JsonBoundaryObject,
  operation: RuntimeConfigMutationOperation,
): JsonBoundaryObject {
  switch (operation.kind) {
    case 'set':
      return setConfigPath(config, operation.path, operation.value);
    case 'unset':
      return unsetConfigPath(config, operation.path);
    case 'plugin_enable':
      return setPluginEnabled(config, operation.pluginId, true);
    case 'plugin_disable':
      return setPluginEnabled(config, operation.pluginId, false);
    case 'default_memory_provider':
      return operation.pluginId === undefined
        ? unsetConfigPath(config, 'project02.defaultMemoryProvider')
        : setConfigPath(
            config,
            'project02.defaultMemoryProvider',
            operation.pluginId,
          );
    case 'plugin_config_set':
      return setPluginConfigField(
        config,
        operation.pluginId,
        operation.fieldName,
        operation.value,
      );
    case 'plugin_config_unset':
      return unsetPluginConfigField(
        config,
        operation.pluginId,
        operation.fieldName,
      );
    case 'secret_set':
      return setPluginConfigField(
        config,
        operation.pluginId,
        operation.fieldName,
        {$env: operation.envVar},
      );
  }
}

function validateMutatedRuntimeConfig(
  config: JsonBoundaryObject,
): Project02RuntimeConfig {
  const accepted = validateProject02RuntimeConfig(config);
  const blockingDiagnostic = accepted.diagnostics.find(
    diagnostic => diagnostic.severity === 'error',
  );

  if (blockingDiagnostic !== undefined) {
    throw new TypeError(
      `Cannot mutate runtime config because the mutation would produce invalid config: ${blockingDiagnostic.message}`,
    );
  }

  if (accepted.config === undefined) {
    throw new TypeError(
      'Cannot mutate runtime config because the mutation would produce empty config.',
    );
  }

  return accepted.config;
}

function setPluginEnabled(
  config: JsonBoundaryObject,
  pluginId: string,
  enabled: boolean,
): JsonBoundaryObject {
  const plugins = authoredObjectValue(config['plugins'], 'plugins') ?? {};
  const currentPlugin =
    authoredObjectValue(
      ownJsonRecordValue(plugins, pluginId),
      `plugins.${pluginId}`,
    ) ?? {};
  const nextPlugins = {...plugins};

  nextPlugins[pluginId] = freezeJsonObject({
    ...currentPlugin,
    enabled,
  });

  return freezeJsonObject({...config, plugins: freezeJsonObject(nextPlugins)});
}

function setPluginConfigField(
  config: JsonBoundaryObject,
  pluginId: string,
  fieldName: string,
  value: RuntimeConfigValue,
): JsonBoundaryObject {
  const plugins = authoredObjectValue(config['plugins'], 'plugins') ?? {};
  const currentPlugin =
    authoredObjectValue(
      ownJsonRecordValue(plugins, pluginId),
      `plugins.${pluginId}`,
    ) ?? {};
  const currentFields =
    authoredObjectValue(
      ownJsonRecordValue(currentPlugin, 'config'),
      `plugins.${pluginId}.config`,
    ) ?? {};
  const nextPlugins = {...plugins};

  nextPlugins[pluginId] = freezeJsonObject({
    ...currentPlugin,
    config: freezeJsonObject({
      ...currentFields,
      [fieldName]: snapshotMutationValue(
        value,
        `plugins.${pluginId}.config.${fieldName}`,
      ),
    }),
  });

  return freezeJsonObject({
    ...config,
    plugins: freezeJsonObject(nextPlugins),
  });
}

function unsetPluginConfigField(
  config: JsonBoundaryObject,
  pluginId: string,
  fieldName: string,
): JsonBoundaryObject {
  const plugins = authoredObjectValue(config['plugins'], 'plugins');
  const currentPluginValue =
    plugins === undefined ? undefined : ownJsonRecordValue(plugins, pluginId);

  if (currentPluginValue === undefined) {
    return config;
  }

  const currentPlugin = requiredAuthoredObjectValue(
    currentPluginValue,
    `plugins.${pluginId}`,
  );
  const currentFields = authoredObjectValue(
    ownJsonRecordValue(currentPlugin, 'config'),
    `plugins.${pluginId}.config`,
  );

  if (
    currentFields === undefined ||
    ownJsonRecordValue(currentFields, fieldName) === undefined
  ) {
    return config;
  }

  const nextFields = jsonObjectWithout(currentFields, fieldName);
  const nextPlugin = jsonObjectWithout(currentPlugin, 'config');

  if (Object.keys(nextFields).length > 0) {
    nextPlugin['config'] = freezeJsonObject(nextFields);
  }

  return setOrDeletePluginWrapper(
    config,
    plugins ?? {},
    pluginId,
    freezeJsonObject(nextPlugin),
  );
}

function setConfigPath(
  config: JsonBoundaryObject,
  path: string,
  value: RuntimeConfigValue,
): JsonBoundaryObject {
  const parts = parseConfigPath(path);
  const project02Field = project02FieldForConfigPath(parts);

  if (project02Field !== undefined) {
    return setProject02ConfigField(config, project02Field, value, path);
  }

  throw new TypeError(`Unsupported runtime config path: ${path}.`);
}

function unsetConfigPath(
  config: JsonBoundaryObject,
  path: string,
): JsonBoundaryObject {
  const parts = parseConfigPath(path);
  const project02Field = project02FieldForConfigPath(parts);

  if (project02Field !== undefined) {
    return unsetProject02ConfigField(config, project02Field);
  }

  throw new TypeError(`Unsupported runtime config path: ${path}.`);
}

function frozenRuntimeConfigRecord(
  entries: readonly (readonly [string, RuntimeConfigValue])[],
): Readonly<Record<string, RuntimeConfigValue>> {
  const record: Record<string, RuntimeConfigValue> = {};

  for (const [name, value] of entries) {
    record[name] = value;
  }

  return Object.freeze(record);
}

function project02FieldForConfigPath(
  parts: readonly string[],
): Project02ConfigFieldDefinition | undefined {
  const fieldName =
    parts.length === 2 && parts[0] === 'project02' ? parts[1] : undefined;

  return fieldName === undefined
    ? undefined
    : project02RuntimeConfigFieldDefinition(fieldName);
}

function setProject02ConfigField(
  config: JsonBoundaryObject,
  field: Project02ConfigFieldDefinition,
  value: RuntimeConfigValue,
  path: string,
): JsonBoundaryObject {
  if (
    !project02RuntimeConfigValueMatchesField(value, field) ||
    (typeof value === 'string' && value.trim().length === 0)
  ) {
    throw new TypeError(`${field.invalidValueMessage} Path: ${path}.`);
  }

  const current = authoredObjectValue(config['project02'], 'project02') ?? {};
  const project02 = freezeJsonObject({
    ...current,
    [field.name]: snapshotMutationValue(value, path),
  });

  return freezeJsonObject({
    ...config,
    project02,
  });
}

function unsetProject02ConfigField(
  config: JsonBoundaryObject,
  field: Project02ConfigFieldDefinition,
): JsonBoundaryObject {
  const current = authoredObjectValue(config['project02'], 'project02');

  if (
    current === undefined ||
    ownJsonRecordValue(current, field.name) === undefined
  ) {
    return config;
  }

  const project02 = jsonObjectWithout(current, field.name);
  const root = jsonObjectWithout(config, 'project02');

  if (Object.keys(project02).length > 0) {
    root['project02'] = freezeJsonObject(project02);
  }

  return freezeJsonObject(root);
}

type PreparedEnvSecretWrite = {
  readonly envPath: string;
  readonly value: string;
  readonly mode: number;
};

type PreviousConfigState = {
  readonly path: string;
  readonly text?: string;
};

function snapshotPreviousConfigState(path: string): PreviousConfigState {
  if (!existsSync(path)) {
    return Object.freeze({
      path,
    } satisfies PreviousConfigState);
  }

  return Object.freeze({
    path,
    text: readFileSync(path, 'utf8'),
  } satisfies PreviousConfigState);
}

function prepareEnvSecretWrite(
  envPath: string,
  envVar: string,
  secretValue: string,
): PreparedEnvSecretWrite {
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(envVar)) {
    throw new TypeError('Secret env var name must be uppercase snake case.');
  }

  if (isRuntimeControlEnvVarName(envVar)) {
    throw new TypeError(
      `Secret env var ${envVar} is reserved for Project02 runtime control and cannot be used for plugin secrets.`,
    );
  }

  const current = readExistingEnvSecretFile(envPath);
  const existing = envFileTextWithoutAssignment(current, envVar);
  const assignment = `${envVar}=${formatDotenvSecretValue(secretValue)}`;
  const next =
    existing.length === 0
      ? `${assignment}\n`
      : `${existing}${existing.endsWith('\n') ? '' : '\n'}${assignment}\n`;

  return Object.freeze({
    envPath,
    value: next,
    mode: 0o600,
  } satisfies PreparedEnvSecretWrite);
}

function writePreparedEnvSecret(secretWrite: PreparedEnvSecretWrite): void {
  try {
    writeTextAtomic(secretWrite.envPath, secretWrite.value, secretWrite.mode);
  } catch (error: unknown) {
    throw mutationFileAccessError(
      `Could not write runtime config env file at ${secretWrite.envPath}.`,
      error,
    );
  }
}

function readExistingEnvSecretFile(envPath: string): string {
  try {
    return existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  } catch (error: unknown) {
    throw mutationFileAccessError(
      `Could not read runtime config env file at ${envPath}.`,
      error,
    );
  }
}

function restorePreviousConfigState(
  previousConfigState: PreviousConfigState,
): Error | undefined {
  try {
    if (previousConfigState.text === undefined) {
      if (existsSync(previousConfigState.path)) {
        unlinkSync(previousConfigState.path);
      }
      return undefined;
    }

    writeTextAtomic(previousConfigState.path, previousConfigState.text, 0o600);
    return undefined;
  } catch (error: unknown) {
    return mutationFileAccessError(
      `Could not restore runtime config file at ${previousConfigState.path}.`,
      error,
    );
  }
}

type DotenvQuoteDelimiter = '"' | "'" | '`';

function envFileTextWithoutAssignment(value: string, envVar: string): string {
  const lines = value.split('\n');
  const kept: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const assignment = dotenvAssignmentForLine(line);
    const blockEndIndex =
      assignment === undefined
        ? index
        : dotenvAssignmentBlockEndIndex(lines, index, assignment.value);

    if (assignment?.name === envVar) {
      index = blockEndIndex;
      continue;
    }

    kept.push(...lines.slice(index, blockEndIndex + 1));
    index = blockEndIndex;
  }

  return kept.join('\n');
}

type DotenvAssignment = {
  readonly name: string;
  readonly value: string;
};

function dotenvAssignmentForLine(line: string): DotenvAssignment | undefined {
  let index = 0;

  while (isDotenvWhitespace(line[index])) {
    index += 1;
  }

  if (
    line.startsWith('export', index) &&
    isDotenvWhitespace(line[index + 'export'.length])
  ) {
    index += 'export'.length;

    while (isDotenvWhitespace(line[index])) {
      index += 1;
    }
  }

  const nameStart = index;

  while (isDotenvNameCharacter(line[index])) {
    index += 1;
  }

  const name = line.slice(nameStart, index);

  if (name.length === 0 || !isDotenvNameStart(name[0])) {
    return undefined;
  }

  while (isDotenvWhitespace(line[index])) {
    index += 1;
  }

  if (line[index] !== '=') {
    return undefined;
  }

  return Object.freeze({
    name,
    value: line.slice(index + 1).trimStart(),
  } satisfies DotenvAssignment);
}

function isDotenvWhitespace(value: string | undefined): boolean {
  return value === ' ' || value === '\t';
}

function isDotenvNameStart(value: string | undefined): boolean {
  return value !== undefined && /^[A-Za-z_]$/u.test(value);
}

function isDotenvNameCharacter(value: string | undefined): boolean {
  return value !== undefined && /^[A-Za-z0-9_]$/u.test(value);
}

function dotenvQuoteDelimiter(value: string): DotenvQuoteDelimiter | undefined {
  const first = value[0];

  return isDotenvQuoteDelimiter(first) ? first : undefined;
}

function isDotenvQuoteDelimiter(
  value: string | undefined,
): value is DotenvQuoteDelimiter {
  return value === '"' || value === "'" || value === '`';
}

function dotenvAssignmentBlockEndIndex(
  lines: readonly string[],
  startIndex: number,
  assignmentValue: string,
): number {
  const delimiter = dotenvQuoteDelimiter(assignmentValue);

  if (delimiter === undefined || assignmentValue.slice(1).includes(delimiter)) {
    return startIndex;
  }

  return dotenvQuotedValueContinuationEndIndex(
    lines,
    startIndex + 1,
    delimiter,
  );
}

function dotenvQuotedValueContinuationEndIndex(
  lines: readonly string[],
  startIndex: number,
  delimiter: DotenvQuoteDelimiter,
): number {
  for (let index = startIndex; index < lines.length; index += 1) {
    if ((lines[index] ?? '').includes(delimiter)) {
      return index;
    }
  }

  return startIndex - 1;
}

function formatDotenvSecretValue(value: string): string {
  if (value.includes('\r')) {
    throw new TypeError(
      'Secret value cannot be written to the runtime config env file because dotenv parsing does not preserve carriage returns.',
    );
  }

  const delimiters = value.includes('\\')
    ? (["'", '`'] as const)
    : (['"', "'", '`'] as const);

  for (const delimiter of delimiters) {
    if (!value.includes(delimiter)) {
      return `${delimiter}${value}${delimiter}`;
    }
  }

  if (isSafeUnquotedDotenvValue(value)) {
    return value;
  }

  throw new TypeError(
    'Secret value cannot be written to the runtime config env file because it has no non-escaping dotenv quote delimiter and cannot be safely written as an unquoted value.',
  );
}

function isSafeUnquotedDotenvValue(value: string): boolean {
  return !isDotenvQuoteDelimiter(value[0]) && /^[^\s#]+$/u.test(value);
}

function writeJsonAtomic(
  path: string,
  value: Project02RuntimeConfig,
  mode: number,
): void {
  try {
    writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);
  } catch (error: unknown) {
    throw mutationFileAccessError(
      `Could not write runtime config file at ${path}.`,
      error,
    );
  }
}

function writeTextAtomic(path: string, value: string, mode: number): void {
  atomicReplaceFileSync({
    targetPath: path,
    content: value,
    mode,
  });
}

export function canonicalRuntimeConfigMutationPath(path: string): string {
  try {
    return canonicalRuntimeConfigPath(path);
  } catch (error: unknown) {
    if (error instanceof RuntimeConfigPathResolutionError) {
      throw new RuntimeConfigMutationError(error.message, {cause: error});
    }

    throw error;
  }
}

function mutationFileAccessError(
  message: string,
  cause: unknown,
): RuntimeConfigMutationError {
  return cause instanceof RuntimeConfigMutationError
    ? cause
    : new RuntimeConfigMutationError(message, {cause});
}

function parseConfigPath(path: string): readonly string[] {
  const parts = path.split('.').map(part => part.trim());

  if (parts.length === 0 || parts.some(part => part.length === 0)) {
    throw new TypeError('Runtime config path must use non-empty dot segments.');
  }

  return Object.freeze(parts);
}

function setOrDeletePluginWrapper(
  config: JsonBoundaryObject,
  plugins: JsonBoundaryObject,
  pluginId: string,
  pluginConfig: JsonBoundaryObject,
): JsonBoundaryObject {
  const nextPlugins = {...plugins};

  if (Object.keys(pluginConfig).length === 0) {
    return freezeConfigWithPluginWrappers(
      config,
      jsonObjectWithout(plugins, pluginId),
    );
  }

  nextPlugins[pluginId] = pluginConfig;
  return freezeConfigWithPluginWrappers(config, freezeJsonObject(nextPlugins));
}

function freezeConfigWithPluginWrappers(
  config: JsonBoundaryObject,
  plugins: JsonBoundaryObject,
): JsonBoundaryObject {
  const pluginEntries = Object.entries(plugins);

  if (pluginEntries.length > 0) {
    return freezeJsonObject({
      ...config,
      plugins,
    });
  }

  return freezeJsonObject(jsonObjectWithout(config, 'plugins'));
}

function authoredObjectValue(
  value: JsonBoundaryValue | undefined,
  path: string,
): JsonBoundaryObject | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (isJsonBoundaryObject(value)) {
    return value;
  }

  throw new TypeError(
    `Cannot mutate runtime config because authored field "${path}" is not an object.`,
  );
}

function requiredAuthoredObjectValue(
  value: JsonBoundaryValue,
  path: string,
): JsonBoundaryObject {
  const object = authoredObjectValue(value, path);

  if (object === undefined) {
    throw new TypeError(
      `Cannot mutate runtime config because authored field "${path}" is missing.`,
    );
  }

  return object;
}

function snapshotMutationValue(
  value: RuntimeConfigValue,
  field: string,
): JsonBoundaryValue {
  return createJsonBoundarySnapshot(value, {field});
}

function jsonObjectWithout(
  value: JsonBoundaryObject,
  omittedKey: string,
): Record<string, JsonBoundaryValue> {
  const result: Record<string, JsonBoundaryValue> = {};

  for (const [key, item] of Object.entries(value)) {
    if (key !== omittedKey) {
      result[key] = item;
    }
  }

  return result;
}

function freezeJsonObject(
  value: Record<string, JsonBoundaryValue>,
): JsonBoundaryObject {
  return Object.freeze(value);
}
