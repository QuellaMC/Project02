import {
  existsSync,
  lstatSync,
  readlinkSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';

import {ownJsonRecordValue} from '../../shared/json-boundary.ts';
import {
  characterBindingFileName,
  characterDataDirectoryName,
  createLocalRuntimeStorageLayout,
  createProject02HomeLayout,
  homeRootForCharacterDataDir,
} from '../storage/layout-contract.ts';
import {readCharacterBinding} from '../storage/character-binding.ts';
import {
  atomicReplaceFileSync,
  cleanupAbandonedAtomicReplacementFilesSync,
} from '../storage/atomic-file.ts';
import {
  acquireLocalRuntimeMutationLockSync,
  defaultLocalRuntimeMutationLockWaitTimeoutMs,
  type LocalRuntimeMutationLocksLeaseSync,
  type LocalRuntimeMutationLockLeaseSync,
} from '../storage/mutation-lock.ts';
import {
  isRuntimeControlEnvVarName,
  runtimeConfigEnvVarName,
  runtimeConfigVersion,
  type LoadedProject02RuntimeConfig,
  type Project02HostConfig,
  type Project02RuntimeConfig,
  type Project02RuntimePluginConfig,
  type RuntimeConfigMutationOperation,
  type RuntimeConfigValue,
} from './types.ts';
import {
  defaultRuntimeConfigPath,
  loadProject02RuntimeConfig,
  validateProject02RuntimeConfig,
} from './load.ts';
import {redactRuntimeConfigValue} from './redact.ts';
import {createRuntimeConfigFingerprint} from './fingerprint.ts';
import {
  type Project02ConfigFieldDefinition,
  project02RuntimeConfigFieldDefinition,
  project02RuntimeConfigFieldDefinitions,
  runtimeConfigValueMatchesField,
} from './schema.ts';

export type ApplyRuntimeConfigMutationOptions = {
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly expectedFingerprint?: string;
  readonly storeRoot?: string;
  /**
   * Set by the character-scope mutation seam, which initializes the
   * data directory (home guard plus binding stamp) before mutating.
   * Direct path selection leaves this unset, so an overlay-located
   * target must already carry a matching binding stamp.
   */
  readonly characterScopeManaged?: boolean;
  readonly operation: RuntimeConfigMutationOperation;
  readonly validateCandidate?: (config: Project02RuntimeConfig) => void;
};

export type RuntimeConfigMutationResult = {
  readonly configPath: string;
  readonly envPath: string;
  readonly config: Project02RuntimeConfig;
  readonly fingerprint: string;
};

export type PreparedRuntimeConfigMutationCandidate = {
  readonly config: Project02RuntimeConfig;
  readonly fingerprint: string;
};

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

export function applyRuntimeConfigMutation(
  options: ApplyRuntimeConfigMutationOptions,
): RuntimeConfigMutationResult {
  return applyRuntimeConfigMutationWithLocks(options);
}

function applyRuntimeConfigMutationWithLocks(
  options: ApplyRuntimeConfigMutationOptions,
  anticipatedEnvPath?: string,
  retryCount: number = 0,
): RuntimeConfigMutationResult {
  const location = resolveRuntimeConfigMutationLocation(
    options,
    anticipatedEnvPath,
  );
  const overlayLocatedTarget = selectedConfigPathIsCharacterOverlay(
    location.canonicalSelectedConfigPath,
  );

  if (options.characterScopeManaged !== true) {
    if (overlayLocatedTarget) {
      assertOverlayLocatedTargetIsInitialized(
        location.canonicalSelectedConfigPath,
      );
    } else {
      assertTargetNotInsideCharacterDataDir(
        location.canonicalSelectedConfigPath,
      );
    }
  }

  const mutationLease = acquireRuntimeConfigMutationLease(location);

  try {
    cleanupRuntimeConfigMutationTargets(location);
    const candidate = prepareLockedRuntimeConfigMutation(options, location);

    if (
      candidate.canonicalLoadedConfigPath !==
      location.canonicalSelectedConfigPath
    ) {
      return retryRuntimeConfigMutationAfterPathChange({
        options,
        anticipatedEnvPath,
        retryCount,
        mutationLease,
      });
    }

    const retryEnvPath = secretMutationRetryEnvPath(
      options.operation,
      location,
      candidate,
    );

    if (retryEnvPath !== undefined) {
      return retryRuntimeConfigMutationAfterPathChange({
        options,
        anticipatedEnvPath: retryEnvPath,
        retryCount,
        mutationLease,
      });
    }

    if (overlayLocatedTarget) {
      assertOverlayLocatedCandidateStaysCharacterScoped(
        candidate.preparedCandidate.config,
      );
    }

    writeLockedRuntimeConfigMutation(options.operation, location, candidate);

    return Object.freeze({
      configPath: candidate.selectedConfigPath,
      envPath: candidate.envPath,
      config: candidate.preparedCandidate.config,
      fingerprint: candidate.preparedCandidate.fingerprint,
    } satisfies RuntimeConfigMutationResult);
  } finally {
    mutationLease.release();
  }
}

type RuntimeConfigMutationLocation = {
  readonly configPath: string;
  readonly displayConfigPath: string;
  readonly canonicalSelectedConfigPath: string;
  readonly anticipatedEnvPath?: string;
  readonly canonicalAnticipatedEnvPath?: string;
};

function resolveRuntimeConfigMutationLocation(
  options: ApplyRuntimeConfigMutationOptions,
  anticipatedEnvPath: string | undefined,
): RuntimeConfigMutationLocation {
  const locationLayout = createProject02HomeLayout(
    options.storeRoot === undefined ? {} : {homeRoot: options.storeRoot},
  );
  const env = options.env ?? process.env;
  const configPath =
    options.configPath ??
    (options.storeRoot === undefined
      ? runtimeConfigPathFromEnv(env)
      : undefined) ??
    locationLayout.configPath;
  const displayConfigPath = configPath.trim();

  return {
    configPath,
    displayConfigPath,
    canonicalSelectedConfigPath:
      canonicalRuntimeConfigMutationPath(displayConfigPath),
    ...(anticipatedEnvPath === undefined
      ? {}
      : {
          anticipatedEnvPath,
          canonicalAnticipatedEnvPath:
            canonicalRuntimeConfigMutationPath(anticipatedEnvPath),
        }),
  };
}

function acquireRuntimeConfigMutationLease(
  location: RuntimeConfigMutationLocation,
): LocalRuntimeMutationLocksLeaseSync | LocalRuntimeMutationLockLeaseSync {
  if (location.canonicalAnticipatedEnvPath === undefined) {
    return acquireRuntimeConfigFileLock({
      path: location.canonicalSelectedConfigPath,
      displayPath: location.displayConfigPath,
      kind: 'config',
    });
  }

  return acquireRuntimeConfigFileLocks({
    configPath: location.canonicalSelectedConfigPath,
    displayConfigPath: location.displayConfigPath,
    envPath: location.canonicalAnticipatedEnvPath,
    displayEnvPath:
      location.anticipatedEnvPath ?? location.canonicalAnticipatedEnvPath,
  });
}

function cleanupRuntimeConfigMutationTargets(
  location: RuntimeConfigMutationLocation,
): void {
  cleanupRuntimeConfigAtomicTemps(
    location.canonicalSelectedConfigPath,
    location.displayConfigPath,
    'config',
  );

  if (location.canonicalAnticipatedEnvPath !== undefined) {
    cleanupRuntimeConfigAtomicTemps(
      location.canonicalAnticipatedEnvPath,
      location.anticipatedEnvPath ?? location.canonicalAnticipatedEnvPath,
      'env',
    );
  }
}

type LockedRuntimeConfigMutation = {
  readonly selectedConfigPath: string;
  readonly canonicalLoadedConfigPath: string;
  readonly preparedCandidate: PreparedRuntimeConfigMutationCandidate;
  readonly envPath: string;
  readonly canonicalEnvPath: string;
};

function prepareLockedRuntimeConfigMutation(
  options: ApplyRuntimeConfigMutationOptions,
  location: RuntimeConfigMutationLocation,
): LockedRuntimeConfigMutation {
  const loaded = loadProject02RuntimeConfig({
    configPath: location.configPath,
    ...(options.env === undefined ? {} : {env: options.env}),
    ...(options.storeRoot === undefined ? {} : {storeRoot: options.storeRoot}),
  });
  const selectedConfigPath = loaded.path ?? location.configPath;
  const selectedStoreRoot =
    options.storeRoot ??
    storeRootForSelectedDefaultConfigPath(selectedConfigPath);
  const preparedCandidate = prepareRuntimeConfigMutationCandidate({
    loadedConfig: loaded,
    configPath: location.configPath,
    ...(options.storeRoot === undefined ? {} : {storeRoot: options.storeRoot}),
    expectedFingerprint: options.expectedFingerprint,
    operation: options.operation,
    validateCandidate: options.validateCandidate,
  });
  const nextEffectiveStoreRoot =
    preparedCandidate.config.project02?.storeRoot ?? selectedStoreRoot;
  const nextEffectiveLayout = createProject02HomeLayout(
    nextEffectiveStoreRoot === undefined
      ? {}
      : {homeRoot: nextEffectiveStoreRoot},
  );

  return {
    selectedConfigPath,
    canonicalLoadedConfigPath:
      canonicalRuntimeConfigMutationPath(selectedConfigPath),
    preparedCandidate,
    envPath: nextEffectiveLayout.envPath,
    canonicalEnvPath: canonicalRuntimeConfigMutationPath(
      nextEffectiveLayout.envPath,
    ),
  };
}

function secretMutationRetryEnvPath(
  operation: RuntimeConfigMutationOperation,
  location: RuntimeConfigMutationLocation,
  candidate: LockedRuntimeConfigMutation,
): string | undefined {
  if (operation.kind !== 'secret_set') {
    return undefined;
  }

  if (location.canonicalSelectedConfigPath === candidate.canonicalEnvPath) {
    throw new TypeError(
      'Cannot write runtime config secret because the selected config path and runtime env path resolve to the same file.',
    );
  }

  return location.canonicalAnticipatedEnvPath === candidate.canonicalEnvPath
    ? undefined
    : candidate.envPath;
}

function writeLockedRuntimeConfigMutation(
  operation: RuntimeConfigMutationOperation,
  location: RuntimeConfigMutationLocation,
  candidate: LockedRuntimeConfigMutation,
): void {
  if (operation.kind !== 'secret_set') {
    writeJsonAtomic(
      location.canonicalSelectedConfigPath,
      candidate.preparedCandidate.config,
      0o600,
    );
    return;
  }

  const secretWrite = prepareEnvSecretWrite(
    candidate.canonicalEnvPath,
    operation.envVar,
    operation.secretValue,
  );
  const previousConfigState = snapshotPreviousConfigState(
    location.canonicalSelectedConfigPath,
  );

  writeJsonAtomic(
    location.canonicalSelectedConfigPath,
    candidate.preparedCandidate.config,
    0o600,
  );

  try {
    writePreparedEnvSecret(secretWrite);
  } catch (error: unknown) {
    throwRuntimeConfigSecretWriteFailure(error, previousConfigState);
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

function retryRuntimeConfigMutationAfterPathChange(options: {
  readonly options: ApplyRuntimeConfigMutationOptions;
  readonly anticipatedEnvPath: string | undefined;
  readonly retryCount: number;
  readonly mutationLease:
    LocalRuntimeMutationLocksLeaseSync | LocalRuntimeMutationLockLeaseSync;
}): RuntimeConfigMutationResult {
  options.mutationLease.release();

  if (options.retryCount >= 8) {
    throw new RuntimeConfigMutationError(
      'Runtime config mutation paths kept changing while acquiring filesystem locks.',
    );
  }

  return applyRuntimeConfigMutationWithLocks(
    options.options,
    options.anticipatedEnvPath,
    options.retryCount + 1,
  );
}

function bootstrapRuntimeConfig(options: {
  readonly selectedConfigPath: string;
  readonly storeRoot?: string;
}): Project02RuntimeConfig {
  // A config path inside a character-data directory is an overlay:
  // seeding project02.storeRoot there would produce a document the
  // overlay loader must reject as global-only.
  if (selectedConfigPathIsCharacterOverlay(options.selectedConfigPath)) {
    return {version: runtimeConfigVersion};
  }

  if (options.storeRoot !== undefined) {
    return {
      version: runtimeConfigVersion,
      project02: Object.freeze({storeRoot: options.storeRoot}),
    };
  }

  const selectedStoreRoot = storeRootForSelectedDefaultConfigPath(
    options.selectedConfigPath,
  );

  return selectedStoreRoot === undefined
    ? {version: runtimeConfigVersion}
    : {
        version: runtimeConfigVersion,
        project02: Object.freeze({storeRoot: selectedStoreRoot}),
      };
}

/**
 * A candidate written to an overlay-located file must stay within the
 * character-scoped dialect regardless of which flag routed the write
 * here: a --config pointed straight at the overlay gets the same field
 * allowlist as --character.
 */
export function characterOverlayGlobalOnlyFieldMessage(
  fieldPath: string,
): string {
  return (
    `Config field "${fieldPath}" is global-only; set it in the home ` +
    'config.json, not the character overlay.'
  );
}

export function assertOverlayLocatedCandidateStaysCharacterScoped(
  candidate: Project02RuntimeConfig,
): void {
  const section = candidate.project02;

  if (section === undefined) {
    return;
  }

  for (const field of project02RuntimeConfigFieldDefinitions()) {
    if (
      !field.scopes.includes('character') &&
      section[field.name] !== undefined
    ) {
      throw new RuntimeConfigMutationError(
        characterOverlayGlobalOnlyFieldMessage(field.path),
      );
    }
  }
}

// The scoped seam stamps a data directory before writing into it; a
// directly selected overlay path must find that stamp already present,
// or the write would create durable character state the runtime later
// refuses to open. Runs before the mutation lock so even the lock root
// leaves no trace in an uninitialized directory. The character-scope
// seam runs the same assertion itself before creating an overlay.
export function assertOverlayLocatedTargetIsInitialized(
  canonicalConfigPath: string,
): void {
  const dataRoot = dirname(canonicalConfigPath);
  const directoryCharacterId = basename(dataRoot);
  const read = readCharacterBinding({storeRoot: dataRoot});

  if (
    read.status === 'bound' &&
    read.binding.characterId === directoryCharacterId
  ) {
    return;
  }

  if (read.status === 'bound') {
    throw new RuntimeConfigMutationError(
      `Character data directory "${dataRoot}" holds history for character ` +
        `"${read.binding.characterId}"; its config file cannot be edited ` +
        `as "${directoryCharacterId}".`,
    );
  }

  if (read.status === 'malformed') {
    throw new RuntimeConfigMutationError(read.message);
  }

  throw new RuntimeConfigMutationError(
    `Config file "${canonicalConfigPath}" sits in a character-data ` +
      'directory that has no binding stamp; run the command with ' +
      `--character ${directoryCharacterId} to initialize it first.`,
  );
}

// Character-data locations are recognized structurally (a parent named
// character-data, the layout invariant) or by the binding stamp a
// materialized data dir always carries.
function characterDataLocationForConfigPath(
  canonicalConfigPath: string,
): string | undefined {
  const containingDirectory = dirname(canonicalConfigPath);
  const isDataLocation =
    basename(dirname(containingDirectory)) === characterDataDirectoryName ||
    existsSync(join(containingDirectory, characterBindingFileName));

  return isDataLocation ? containingDirectory : undefined;
}

// The overlay is exactly the data directory's config.json (the layout
// names it); any other file there is not a config target at all.
export function selectedConfigPathIsCharacterOverlay(
  selectedConfigPath: string,
): boolean {
  const canonicalConfigPath =
    canonicalRuntimeConfigMutationPath(selectedConfigPath);
  const dataRoot = characterDataLocationForConfigPath(canonicalConfigPath);

  return (
    dataRoot !== undefined &&
    canonicalConfigPath ===
      createLocalRuntimeStorageLayout({storeRoot: dataRoot}).configPath
  );
}

// A non-overlay file inside a character-data directory is not a valid
// mutation target: no reader ever loads it, so a "successful" write
// would change no effective config while reporting success.
function assertTargetNotInsideCharacterDataDir(
  canonicalConfigPath: string,
): void {
  const dataRoot = characterDataLocationForConfigPath(canonicalConfigPath);

  if (dataRoot === undefined) {
    return;
  }

  throw new RuntimeConfigMutationError(
    `Config file "${canonicalConfigPath}" sits in a character-data ` +
      'directory but is not its overlay; the overlay for this directory ' +
      `is "${createLocalRuntimeStorageLayout({storeRoot: dataRoot}).configPath}".`,
  );
}

export function createRuntimeConfigMutationBase(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly configPath?: string;
  readonly storeRoot?: string;
}): Project02RuntimeConfig {
  if (options.loadedConfig.config !== undefined) {
    return options.loadedConfig.config;
  }

  const selectedConfigPath =
    options.loadedConfig.path ??
    options.configPath ??
    defaultRuntimeConfigPath(options.storeRoot);
  const selectedStoreRoot =
    options.storeRoot ??
    storeRootForSelectedDefaultConfigPath(selectedConfigPath);
  const bootstrapStoreRoot =
    options.storeRoot === undefined
      ? selectedStoreRoot
      : canonicalRuntimeConfigMutationPath(
          createProject02HomeLayout({homeRoot: options.storeRoot}).homeRoot,
        );

  return bootstrapRuntimeConfig({
    selectedConfigPath,
    ...(bootstrapStoreRoot === undefined
      ? {}
      : {storeRoot: bootstrapStoreRoot}),
  });
}

export function prepareRuntimeConfigMutationCandidate(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly configPath?: string;
  readonly storeRoot?: string;
  readonly expectedFingerprint?: string | undefined;
  readonly operation: RuntimeConfigMutationOperation;
  readonly validateCandidate?:
    ((config: Project02RuntimeConfig) => void) | undefined;
}): PreparedRuntimeConfigMutationCandidate {
  const blockingDiagnostic = options.loadedConfig.diagnostics.find(
    diagnostic =>
      diagnostic.severity === 'error' &&
      diagnostic.code !== 'runtime_config_missing',
  );

  if (blockingDiagnostic !== undefined) {
    throw new TypeError(
      `Cannot mutate runtime config because it failed to load: ${blockingDiagnostic.message}`,
    );
  }

  const currentConfig = createRuntimeConfigMutationBase(options);
  const currentFingerprint = createRuntimeConfigFingerprint(currentConfig);

  if (
    options.expectedFingerprint !== undefined &&
    options.expectedFingerprint !== currentFingerprint
  ) {
    throw new RuntimeConfigConflictError(
      `Runtime config changed before the mutation could be committed. Expected ${options.expectedFingerprint}, found ${currentFingerprint}.`,
    );
  }

  const config = validateMutatedRuntimeConfig(
    mutateConfig(currentConfig, options.operation),
  );

  options.validateCandidate?.(config);

  return Object.freeze({
    config,
    fingerprint: createRuntimeConfigFingerprint(config),
  } satisfies PreparedRuntimeConfigMutationCandidate);
}

export function storeRootForSelectedDefaultConfigPath(
  selectedConfigPath: string,
): string | undefined {
  const canonicalConfigPath =
    canonicalRuntimeConfigMutationPath(selectedConfigPath);

  // An overlay is not a home's default config: store resolution — and
  // with it every env write — must land in the OWNING home, never
  // inside the data directory (which deliberately has no env file).
  if (selectedConfigPathIsCharacterOverlay(canonicalConfigPath)) {
    try {
      return homeRootForCharacterDataDir(dirname(canonicalConfigPath));
    } catch {
      // A stamped directory outside any character-data parent names no
      // home; claim none instead of aliasing the data dir as one.
      return undefined;
    }
  }

  const candidateStoreRoot = dirname(canonicalConfigPath);
  const defaultConfigPath = defaultRuntimeConfigPath(candidateStoreRoot);

  return pathsAlias(canonicalConfigPath, defaultConfigPath)
    ? canonicalRuntimeConfigMutationPath(candidateStoreRoot)
    : undefined;
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

function runtimeConfigPathFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const value = env[runtimeConfigEnvVarName];

  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  return value.trim();
}

function mutateConfig(
  config: Project02RuntimeConfig,
  operation: RuntimeConfigMutationOperation,
): Project02RuntimeConfig {
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
  config: Project02RuntimeConfig,
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
  config: Project02RuntimeConfig,
  pluginId: string,
  enabled: boolean,
): Project02RuntimeConfig {
  const currentPlugin = ownJsonRecordValue(config.plugins, pluginId) ?? {};
  const plugins = {...(config.plugins ?? {})};

  plugins[pluginId] = freezePluginConfig({
    ...currentPlugin,
    enabled,
  });

  return freezeConfig({...config, plugins});
}

function setPluginConfigField(
  config: Project02RuntimeConfig,
  pluginId: string,
  fieldName: string,
  value: RuntimeConfigValue,
): Project02RuntimeConfig {
  const currentPlugin = ownJsonRecordValue(config.plugins, pluginId) ?? {};
  const plugins = {...(config.plugins ?? {})};

  plugins[pluginId] = freezePluginConfig({
    ...currentPlugin,
    config: {
      ...(currentPlugin.config ?? {}),
      [fieldName]: value,
    },
  });

  return freezeConfig({...config, plugins});
}

function unsetPluginConfigField(
  config: Project02RuntimeConfig,
  pluginId: string,
  fieldName: string,
): Project02RuntimeConfig {
  const currentPlugin = ownJsonRecordValue(config.plugins, pluginId);

  if (currentPlugin === undefined) {
    return config;
  }

  const plugins = {...(config.plugins ?? {})};
  const nextPluginConfigEntries = Object.entries(
    currentPlugin.config ?? {},
  ).filter(([name]) => name !== fieldName);

  return setOrDeletePluginWrapper(config, plugins, pluginId, {
    ...(currentPlugin.enabled === undefined
      ? {}
      : {enabled: currentPlugin.enabled}),
    ...(nextPluginConfigEntries.length === 0
      ? {}
      : {
          config: frozenRuntimeConfigRecord(nextPluginConfigEntries),
        }),
  });
}

function setConfigPath(
  config: Project02RuntimeConfig,
  path: string,
  value: RuntimeConfigValue,
): Project02RuntimeConfig {
  const parts = parseConfigPath(path);
  const project02Field = project02FieldForConfigPath(parts);

  if (project02Field !== undefined) {
    return setProject02ConfigField(config, project02Field, value, path);
  }

  throw new TypeError(`Unsupported runtime config path: ${path}.`);
}

function unsetConfigPath(
  config: Project02RuntimeConfig,
  path: string,
): Project02RuntimeConfig {
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
  config: Project02RuntimeConfig,
  field: Project02ConfigFieldDefinition,
  value: RuntimeConfigValue,
  path: string,
): Project02RuntimeConfig {
  if (
    !runtimeConfigValueMatchesField(value, field) ||
    (typeof value === 'string' && value.trim().length === 0)
  ) {
    throw new TypeError(`${field.invalidValueMessage} Path: ${path}.`);
  }

  const current = config.project02 ?? {};
  const project02: Project02HostConfig = Object.freeze({
    ...current,
    [field.name]: value,
  });

  return freezeConfig({
    ...config,
    project02,
  });
}

function unsetProject02ConfigField(
  config: Project02RuntimeConfig,
  field: Project02ConfigFieldDefinition,
): Project02RuntimeConfig {
  const project02 =
    config.project02 === undefined
      ? undefined
      : Object.freeze(
          Object.fromEntries(
            Object.entries(config.project02).filter(
              ([name]) => name !== field.name,
            ),
          ),
        );
  const hasProject02Fields =
    project02 !== undefined && Object.keys(project02).length > 0;

  return freezeConfig({
    version: config.version,
    ...(hasProject02Fields ? {project02: Object.freeze(project02)} : {}),
    ...(config.plugins === undefined ? {} : {plugins: config.plugins}),
  });
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
  const mutationPath = canonicalRuntimeConfigMutationPath(path);

  if (!existsSync(mutationPath)) {
    return Object.freeze({
      path: mutationPath,
    } satisfies PreviousConfigState);
  }

  return Object.freeze({
    path: mutationPath,
    text: readFileSync(mutationPath, 'utf8'),
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

function acquireRuntimeConfigFileLock(options: {
  readonly path: string;
  readonly displayPath: string;
  readonly kind: 'config' | 'env';
}): LocalRuntimeMutationLocksLeaseSync {
  try {
    return acquireRuntimeControlPathLocks([options.path]);
  } catch (error: unknown) {
    throw mutationFileAccessError(
      options.kind === 'config'
        ? `Could not write runtime config file at ${options.displayPath}.`
        : `Could not write runtime config env file at ${options.displayPath}.`,
      error,
    );
  }
}

function acquireRuntimeConfigFileLocks(options: {
  readonly configPath: string;
  readonly displayConfigPath: string;
  readonly envPath: string;
  readonly displayEnvPath: string;
}): LocalRuntimeMutationLocksLeaseSync {
  try {
    return acquireRuntimeControlPathLocks([
      options.configPath,
      options.envPath,
    ]);
  } catch (error: unknown) {
    const pathError =
      error instanceof RuntimeControlPathLockError ? error : undefined;

    throw mutationFileAccessError(
      pathError?.path === options.envPath
        ? `Could not write runtime config env file at ${options.displayEnvPath}.`
        : `Could not write runtime config file at ${options.displayConfigPath}.`,
      error,
    );
  }
}

class RuntimeControlPathLockError extends Error {
  readonly path: string;

  constructor(path: string, options?: ErrorOptions) {
    super(`Could not acquire runtime control path lock for ${path}.`, options);
    this.name = 'RuntimeControlPathLockError';
    this.path = path;
  }
}

function acquireRuntimeControlPathLocks(
  paths: readonly string[],
): LocalRuntimeMutationLocksLeaseSync {
  const canonicalPaths = Object.freeze(
    [...new Set(paths.map(canonicalRuntimeConfigMutationPath))].sort(
      compareCodeUnits,
    ),
  );
  const leases: LocalRuntimeMutationLockLeaseSync[] = [];
  const startedAt = Date.now();

  try {
    for (const path of canonicalPaths) {
      try {
        leases.push(
          acquireLocalRuntimeMutationLockSync({
            // Control-file locks live beside the file they guard: the
            // home config locks at <home>/.locks, a character overlay at
            // <dataRoot>/.locks. Both layouts agree on the .locks name.
            locksRoot: createProject02HomeLayout({
              homeRoot: dirname(path),
            }).locksRoot,
            resourceKey: `runtime-control-file:${path}`,
            waitTimeoutMs: Math.max(
              0,
              defaultLocalRuntimeMutationLockWaitTimeoutMs -
                (Date.now() - startedAt),
            ),
          }),
        );
      } catch (error: unknown) {
        throw new RuntimeControlPathLockError(path, {cause: error});
      }
    }
  } catch (error: unknown) {
    releaseRuntimeControlPathLocks(leases);
    throw error;
  }

  let released = false;

  return Object.freeze({
    resourceKeys: Object.freeze(
      canonicalPaths.map(path => `runtime-control-file:${path}`),
    ),
    release() {
      if (released) {
        return;
      }

      released = true;
      releaseRuntimeControlPathLocks(leases);
    },
  } satisfies LocalRuntimeMutationLocksLeaseSync);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function releaseRuntimeControlPathLocks(
  leases: readonly LocalRuntimeMutationLockLeaseSync[],
): void {
  let firstError: unknown;

  for (const lease of [...leases].reverse()) {
    try {
      lease.release();
    } catch (error: unknown) {
      firstError ??= error;
    }
  }

  if (firstError !== undefined) {
    throw firstError instanceof Error
      ? firstError
      : new RuntimeConfigMutationError(
          'Could not release all runtime config path locks.',
          {cause: firstError},
        );
  }
}

function pathsAlias(left: string, right: string): boolean {
  return (
    canonicalRuntimeConfigMutationPath(left) ===
    canonicalRuntimeConfigMutationPath(right)
  );
}

export function canonicalRuntimeConfigMutationPath(path: string): string {
  return canonicalAbsoluteMutationPath(resolve(path), new Set<string>());
}

function canonicalAbsoluteMutationPath(
  path: string,
  followedSymlinks: Set<string>,
): string {
  try {
    return realpathSync.native(path);
  } catch {
    const symlinkTargetPath = danglingSymlinkTargetPath(path, followedSymlinks);

    return symlinkTargetPath === undefined
      ? canonicalMissingMutationPath(path, followedSymlinks)
      : canonicalAbsoluteMutationPath(symlinkTargetPath, followedSymlinks);
  }
}

function danglingSymlinkTargetPath(
  path: string,
  followedSymlinks: Set<string>,
): string | undefined {
  try {
    if (!lstatSync(path).isSymbolicLink()) {
      return undefined;
    }

    if (followedSymlinks.has(path)) {
      throw new RuntimeConfigMutationError(
        `Could not resolve runtime config path because ${path} is part of a symlink cycle.`,
      );
    }

    followedSymlinks.add(path);
    return resolve(dirname(path), readlinkSync(path));
  } catch (error: unknown) {
    if (error instanceof RuntimeConfigMutationError) {
      throw error;
    }

    return undefined;
  }
}

function canonicalMissingMutationPath(
  path: string,
  followedSymlinks: Set<string>,
): string {
  const parent = dirname(path);

  if (parent === path) {
    return path;
  }

  return resolve(
    canonicalAbsoluteMutationPath(parent, followedSymlinks),
    basename(path),
  );
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

function freezeConfig(config: Project02RuntimeConfig): Project02RuntimeConfig {
  return Object.freeze(config);
}

function setOrDeletePluginWrapper(
  config: Project02RuntimeConfig,
  plugins: Record<string, Project02RuntimePluginConfig>,
  pluginId: string,
  pluginConfig: Project02RuntimePluginConfig,
): Project02RuntimeConfig {
  if (isEmptyPluginWrapper(pluginConfig)) {
    return freezeConfigWithPluginWrappers(
      config,
      pluginWrappersWithout(plugins, pluginId),
    );
  }

  plugins[pluginId] = freezePluginConfig(pluginConfig);
  return freezeConfigWithPluginWrappers(config, plugins);
}

function pluginWrappersWithout(
  plugins: Readonly<Record<string, Project02RuntimePluginConfig>>,
  pluginId: string,
): Record<string, Project02RuntimePluginConfig> {
  return Object.fromEntries(
    Object.entries(plugins).filter(
      ([entryPluginId]) => entryPluginId !== pluginId,
    ),
  );
}

function isEmptyPluginWrapper(config: Project02RuntimePluginConfig): boolean {
  return (
    config.enabled === undefined &&
    (config.config === undefined || Object.keys(config.config).length === 0)
  );
}

function freezeConfigWithPluginWrappers(
  config: Project02RuntimeConfig,
  plugins: Readonly<Record<string, Project02RuntimePluginConfig>>,
): Project02RuntimeConfig {
  const pluginEntries = Object.entries(plugins);

  if (pluginEntries.length > 0) {
    return freezeConfig({
      ...config,
      plugins: Object.freeze(
        Object.fromEntries(pluginEntries) as Readonly<
          Record<string, Project02RuntimePluginConfig>
        >,
      ),
    });
  }

  return freezeConfig({
    version: config.version,
    ...(config.project02 === undefined ? {} : {project02: config.project02}),
  });
}

function freezePluginConfig(
  config: Project02RuntimePluginConfig,
): Project02RuntimePluginConfig {
  return Object.freeze(config);
}
