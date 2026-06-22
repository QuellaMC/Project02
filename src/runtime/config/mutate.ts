import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import { createLocalRuntimeStorageLayout } from '../storage/layout.ts';
import {
  isRuntimeControlEnvVarName,
  runtimeConfigEnvVarName,
  runtimeConfigVersion,
  type Project02RuntimeConfig,
  type Project02RuntimePluginConfig,
  type RuntimeConfigMutationOperation,
  type RuntimeConfigValue
} from './types.ts';
import {
  defaultRuntimeConfigPath,
  loadProject02RuntimeConfig,
  validateProject02RuntimeConfig
} from './load.ts';
import {
  redactRuntimeConfigValue
} from './redact.ts';

export type ApplyRuntimeConfigMutationOptions = {
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly storeRoot?: string;
  readonly operation: RuntimeConfigMutationOperation;
};

export type RuntimeConfigMutationResult = {
  readonly configPath: string;
  readonly envPath: string;
  readonly config: Project02RuntimeConfig;
};

export class RuntimeConfigMutationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RuntimeConfigMutationError';
  }
}

export function applyRuntimeConfigMutation(
  options: ApplyRuntimeConfigMutationOptions
): RuntimeConfigMutationResult {
  const locationLayout = createLocalRuntimeStorageLayout(
    options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }
  );
  const env = options.env ?? process.env;
  const configPath =
    options.configPath ??
    (options.storeRoot === undefined ? runtimeConfigPathFromEnv(env) : undefined) ??
    locationLayout.configPath;
  const loaded = loadProject02RuntimeConfig({
    configPath,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot })
  });
  const selectedConfigPath = loaded.path ?? configPath;
  const selectedStoreRoot =
    options.storeRoot ?? storeRootForSelectedDefaultConfigPath(selectedConfigPath);
  const bootstrapStoreRoot =
    options.storeRoot === undefined
      ? selectedStoreRoot
      : canonicalMutationPath(locationLayout.storeRoot);
  const blockingDiagnostic = loaded.diagnostics.find(
    (diagnostic) =>
      diagnostic.severity === 'error' && diagnostic.code !== 'runtime_config_missing'
  );

  if (blockingDiagnostic !== undefined) {
    throw new TypeError(
      `Cannot mutate runtime config because it failed to load: ${blockingDiagnostic.message}`
    );
  }

  const currentConfig =
    loaded.config ??
    bootstrapRuntimeConfig({
      selectedConfigPath,
      ...(bootstrapStoreRoot === undefined ? {} : { storeRoot: bootstrapStoreRoot })
    });
  const nextConfig = validateMutatedRuntimeConfig(
    mutateConfig(currentConfig, options.operation)
  );
  const nextEffectiveStoreRoot = nextConfig.storeRoot ?? selectedStoreRoot;
  const nextEffectiveLayout = createLocalRuntimeStorageLayout(
    nextEffectiveStoreRoot === undefined ? {} : { storeRoot: nextEffectiveStoreRoot }
  );
  const envPath = nextEffectiveLayout.envPath;

  if (
    options.operation.kind === 'secret_set' &&
    pathsAlias(selectedConfigPath, envPath)
  ) {
    throw new TypeError(
      'Cannot write runtime config secret because the selected config path and runtime env path resolve to the same file.'
    );
  }

  const secretWrite =
    options.operation.kind === 'secret_set'
      ? prepareEnvSecretWrite(
          envPath,
          options.operation.envVar,
          options.operation.secretValue
        )
      : undefined;
  if (secretWrite === undefined) {
    writeJsonAtomic(selectedConfigPath, nextConfig, 0o600);
  } else {
    const previousConfigState = snapshotPreviousConfigState(selectedConfigPath);

    writeJsonAtomic(selectedConfigPath, nextConfig, 0o600);

    try {
      writePreparedEnvSecret(secretWrite);
    } catch (error: unknown) {
      const rollbackError = restorePreviousConfigState(previousConfigState);

      if (rollbackError !== undefined) {
        throw new AggregateError(
          [error, rollbackError],
          'Could not write runtime config secret and failed to roll back the config update.',
          { cause: error }
        );
      }

      throw error;
    }
  }

  return Object.freeze({
    configPath: selectedConfigPath,
    envPath,
    config: nextConfig
  } satisfies RuntimeConfigMutationResult);
}

function bootstrapRuntimeConfig(options: {
  readonly selectedConfigPath: string;
  readonly storeRoot?: string;
}): Project02RuntimeConfig {
  if (options.storeRoot !== undefined) {
    return { version: runtimeConfigVersion, storeRoot: options.storeRoot };
  }

  const selectedStoreRoot = storeRootForSelectedDefaultConfigPath(
    options.selectedConfigPath
  );

  return selectedStoreRoot === undefined
    ? { version: runtimeConfigVersion }
    : { version: runtimeConfigVersion, storeRoot: selectedStoreRoot };
}

export function storeRootForSelectedDefaultConfigPath(
  selectedConfigPath: string
): string | undefined {
  const candidateStoreRoot = dirname(selectedConfigPath);
  const defaultConfigPath = defaultRuntimeConfigPath(candidateStoreRoot);

  return pathsAlias(selectedConfigPath, defaultConfigPath)
    ? canonicalMutationPath(candidateStoreRoot)
    : undefined;
}

export function getRuntimeConfigValueAtPath(
  config: Project02RuntimeConfig | undefined,
  path: string
): RuntimeConfigValue | undefined {
  const parts = parseConfigPath(path);

  return getRuntimeConfigValueForParts(config, path, parts);
}

export function getRedactedRuntimeConfigValueAtPath(
  config: Project02RuntimeConfig | undefined,
  path: string
): RuntimeConfigValue | undefined {
  const parts = parseConfigPath(path);
  const value = getRuntimeConfigValueForParts(config, path, parts);

  if (value === undefined) {
    return undefined;
  }

  const key = redactionKeyForRuntimeConfigPath(config, path, parts);

  return key === undefined
    ? redactRuntimeConfigValue(value)
    : redactRuntimeConfigValue(value, { key });
}

function getRuntimeConfigValueForParts(
  config: Project02RuntimeConfig | undefined,
  path: string,
  parts: readonly string[]
): RuntimeConfigValue | undefined {
  if (config === undefined) {
    return undefined;
  }

  if (parts.length === 1) {
    const [field] = parts;

    return rootConfigValue(config, field);
  }

  if (parts[0] !== 'plugins') {
    return undefined;
  }

  if (parts.length === 1) {
    return config.plugins;
  }

  const exactPluginConfig = exactPluginConfigForParts(config, parts);

  if (exactPluginConfig !== undefined) {
    return exactPluginConfig;
  }

  const pluginPath = tryParsePluginMutationPath(parts, path, config);

  if (pluginPath !== undefined) {
    const pluginConfig = config.plugins?.[pluginPath.pluginId];

    if (pluginPath.kind === 'enabled') {
      return pluginConfig?.enabled;
    }

    if (pluginPath.kind === 'config_object') {
      return pluginConfig?.config;
    }

    return pluginConfig?.config?.[pluginPath.fieldName];
  }

  return config.plugins?.[parts.slice(1).join('.')];
}

function redactionKeyForRuntimeConfigPath(
  config: Project02RuntimeConfig | undefined,
  path: string,
  parts: readonly string[]
): string | undefined {
  if (parts.length === 1) {
    return parts[0];
  }

  if (parts[0] !== 'plugins' || parts.length === 1) {
    return undefined;
  }

  const exactPluginConfig = exactPluginConfigForParts(config, parts);

  if (exactPluginConfig !== undefined) {
    return undefined;
  }

  const pluginPath = tryParsePluginMutationPath(parts, path, config);

  if (pluginPath?.kind === 'config_field') {
    return pluginPath.fieldName;
  }

  if (pluginPath?.kind === 'config_object') {
    return 'config';
  }

  return pluginPath?.kind === 'enabled' ? 'enabled' : undefined;
}

function rootConfigValue(
  config: Project02RuntimeConfig,
  field: string | undefined
): RuntimeConfigValue | undefined {
  switch (field) {
    case 'version':
      return config.version;
    case 'storeRoot':
      return config.storeRoot;
    case 'enabledPlugins':
      return config.enabledPlugins;
    case 'defaultMemoryProvider':
      return config.defaultMemoryProvider;
    case 'plugins':
      return config.plugins;
    default:
      return undefined;
  }
}

function exactPluginConfigForParts(
  config: Project02RuntimeConfig | undefined,
  parts: readonly string[]
): Project02RuntimePluginConfig | undefined {
  return config?.plugins?.[parts.slice(1).join('.')];
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
  operation: RuntimeConfigMutationOperation
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
        ? unsetConfigPath(config, 'defaultMemoryProvider')
        : setConfigPath(config, 'defaultMemoryProvider', operation.pluginId);
    case 'secret_set':
      return setPluginConfigField(
        config,
        operation.pluginId,
        operation.fieldName,
        { $env: operation.envVar }
      );
  }
}

function validateMutatedRuntimeConfig(
  config: Project02RuntimeConfig
): Project02RuntimeConfig {
  const accepted = validateProject02RuntimeConfig(config);
  const blockingDiagnostic = accepted.diagnostics.find(
    (diagnostic) => diagnostic.severity === 'error'
  );

  if (blockingDiagnostic !== undefined) {
    throw new TypeError(
      `Cannot mutate runtime config because the mutation would produce invalid config: ${blockingDiagnostic.message}`
    );
  }

  if (accepted.config === undefined) {
    throw new TypeError(
      'Cannot mutate runtime config because the mutation would produce empty config.'
    );
  }

  return accepted.config;
}

function setPluginEnabled(
  config: Project02RuntimeConfig,
  pluginId: string,
  enabled: boolean
): Project02RuntimeConfig {
  const currentPlugin = config.plugins?.[pluginId] ?? {};
  const plugins = { ...(config.plugins ?? {}) };

  plugins[pluginId] = freezePluginConfig({
    ...currentPlugin,
    enabled
  });

  return freezeConfig({ ...config, plugins });
}

function setPluginConfigField(
  config: Project02RuntimeConfig,
  pluginId: string,
  fieldName: string,
  value: RuntimeConfigValue
): Project02RuntimeConfig {
  const currentPlugin = config.plugins?.[pluginId] ?? {};
  const plugins = { ...(config.plugins ?? {}) };

  plugins[pluginId] = freezePluginConfig({
    ...currentPlugin,
    config: {
      ...(currentPlugin.config ?? {}),
      [fieldName]: value
    }
  });

  return freezeConfig({ ...config, plugins });
}

function setConfigPath(
  config: Project02RuntimeConfig,
  path: string,
  value: RuntimeConfigValue
): Project02RuntimeConfig {
  const parts = parseConfigPath(path);

  if (parts.length === 1) {
    const [field] = parts;

    if (field === 'storeRoot' && typeof value === 'string') {
      return freezeConfig({ ...config, storeRoot: value });
    }

    if (field === 'defaultMemoryProvider' && typeof value === 'string') {
      return freezeConfig({ ...config, defaultMemoryProvider: value });
    }

    if (field === 'enabledPlugins' && isStringArray(value)) {
      return freezeConfig({ ...config, enabledPlugins: value });
    }

    throw new TypeError(`Unsupported runtime config path: ${path}.`);
  }

  if (parts[0] !== 'plugins' || parts.length < 3) {
    throw new TypeError(`Unsupported runtime config path: ${path}.`);
  }

  const pluginPath = parsePluginMutationPath(parts, path, config);

  if (pluginPath.kind === 'config_object') {
    throw new TypeError('Plugin config path must include a field name.');
  }

  const currentPlugin = config.plugins?.[pluginPath.pluginId] ?? {};
  const plugins = { ...(config.plugins ?? {}) };

  if (pluginPath.kind === 'enabled') {
    if (typeof value !== 'boolean') {
      throw new TypeError('Plugin enabled config value must be boolean.');
    }

    plugins[pluginPath.pluginId] = freezePluginConfig({
      ...currentPlugin,
      enabled: value
    });
    return freezeConfig({ ...config, plugins });
  }

  plugins[pluginPath.pluginId] = freezePluginConfig({
    ...currentPlugin,
    config: {
      ...(currentPlugin.config ?? {}),
      [pluginPath.fieldName]: value
    }
  });
  return freezeConfig({ ...config, plugins });
}

function unsetConfigPath(
  config: Project02RuntimeConfig,
  path: string
): Project02RuntimeConfig {
  const parts = parseConfigPath(path);

  if (parts.length === 1) {
    const [field] = parts;

    if (field === 'storeRoot') {
      return freezeConfig({
        version: config.version,
        ...(config.enabledPlugins === undefined ? {} : { enabledPlugins: config.enabledPlugins }),
        ...(config.defaultMemoryProvider === undefined
          ? {}
          : { defaultMemoryProvider: config.defaultMemoryProvider }),
        ...(config.plugins === undefined ? {} : { plugins: config.plugins })
      });
    }

    if (field === 'defaultMemoryProvider') {
      return freezeConfig({
        version: config.version,
        ...(config.storeRoot === undefined ? {} : { storeRoot: config.storeRoot }),
        ...(config.enabledPlugins === undefined ? {} : { enabledPlugins: config.enabledPlugins }),
        ...(config.plugins === undefined ? {} : { plugins: config.plugins })
      });
    }

    if (field === 'enabledPlugins') {
      return freezeConfig({
        version: config.version,
        ...(config.storeRoot === undefined ? {} : { storeRoot: config.storeRoot }),
        ...(config.defaultMemoryProvider === undefined
          ? {}
          : { defaultMemoryProvider: config.defaultMemoryProvider }),
        ...(config.plugins === undefined ? {} : { plugins: config.plugins })
      });
    }
  }

  if (parts[0] !== 'plugins' || parts.length < 3) {
    throw new TypeError(`Unsupported runtime config path: ${path}.`);
  }

  const pluginPath = parsePluginMutationPath(parts, path, config);

  if (pluginPath.kind === 'config_object') {
    throw new TypeError('Plugin config path must include a field name.');
  }

  const currentPlugin = config.plugins?.[pluginPath.pluginId];

  if (currentPlugin === undefined) {
    return config;
  }

  const plugins = { ...(config.plugins ?? {}) };

  if (pluginPath.kind === 'enabled') {
    return setOrDeletePluginWrapper(config, plugins, pluginPath.pluginId, {
      ...(currentPlugin.config === undefined ? {} : { config: currentPlugin.config })
    });
  }

  const nextPluginConfigEntries = Object.entries(currentPlugin.config ?? {}).filter(
    ([key]) => key !== pluginPath.fieldName
  );

  return setOrDeletePluginWrapper(config, plugins, pluginPath.pluginId, {
    ...(currentPlugin.enabled === undefined ? {} : { enabled: currentPlugin.enabled }),
    ...(nextPluginConfigEntries.length === 0
      ? {}
      : {
          config: Object.freeze(
            Object.fromEntries(nextPluginConfigEntries) as Readonly<
              Record<string, RuntimeConfigValue>
            >
          )
        })
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
  const mutationPath = canonicalMutationPath(path);

  if (!existsSync(mutationPath)) {
    return Object.freeze({
      path: mutationPath
    } satisfies PreviousConfigState);
  }

  return Object.freeze({
    path: mutationPath,
    text: readFileSync(mutationPath, 'utf8')
  } satisfies PreviousConfigState);
}

function prepareEnvSecretWrite(
  envPath: string,
  envVar: string,
  secretValue: string
): PreparedEnvSecretWrite {
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(envVar)) {
    throw new TypeError('Secret env var name must be uppercase snake case.');
  }

  if (isRuntimeControlEnvVarName(envVar)) {
    throw new TypeError(
      `Secret env var ${envVar} is reserved for Project02 runtime control and cannot be used for plugin secrets.`
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
    mode: 0o600
  } satisfies PreparedEnvSecretWrite);
}

function writePreparedEnvSecret(secretWrite: PreparedEnvSecretWrite): void {
  try {
    writeTextAtomic(secretWrite.envPath, secretWrite.value, secretWrite.mode);
  } catch (error: unknown) {
    throw mutationFileAccessError(
      `Could not write runtime config env file at ${secretWrite.envPath}.`,
      error
    );
  }
}

function readExistingEnvSecretFile(envPath: string): string {
  try {
    return existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  } catch (error: unknown) {
    throw mutationFileAccessError(
      `Could not read runtime config env file at ${envPath}.`,
      error
    );
  }
}

function restorePreviousConfigState(
  previousConfigState: PreviousConfigState
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
      error
    );
  }
}

type DotenvQuoteDelimiter = '"' | "'" | '`';

function envFileTextWithoutAssignment(
  value: string,
  envVar: string
): string {
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
    value: line.slice(index + 1).trimStart()
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
  value: string | undefined
): value is DotenvQuoteDelimiter {
  return value === '"' || value === "'" || value === '`';
}

function dotenvAssignmentBlockEndIndex(
  lines: readonly string[],
  startIndex: number,
  assignmentValue: string
): number {
  const delimiter = dotenvQuoteDelimiter(assignmentValue);

  if (delimiter === undefined || assignmentValue.slice(1).includes(delimiter)) {
    return startIndex;
  }

  return dotenvQuotedValueContinuationEndIndex(lines, startIndex + 1, delimiter);
}

function dotenvQuotedValueContinuationEndIndex(
  lines: readonly string[],
  startIndex: number,
  delimiter: DotenvQuoteDelimiter
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
      'Secret value cannot be written to the runtime config env file because dotenv parsing does not preserve carriage returns.'
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
    'Secret value cannot be written to the runtime config env file because it has no non-escaping dotenv quote delimiter and cannot be safely written as an unquoted value.'
  );
}

function isSafeUnquotedDotenvValue(value: string): boolean {
  return !isDotenvQuoteDelimiter(value[0]) && /^[^\s#]+$/u.test(value);
}

function writeJsonAtomic(
  path: string,
  value: Project02RuntimeConfig,
  mode: number
): void {
  try {
    writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);
  } catch (error: unknown) {
    throw mutationFileAccessError(
      `Could not write runtime config file at ${path}.`,
      error
    );
  }
}

function writeTextAtomic(path: string, value: string, mode: number): void {
  const targetPath = canonicalMutationPath(path);
  const tmpPath = `${targetPath}.${String(process.pid)}.${String(Date.now())}.tmp`;

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(tmpPath, value, { encoding: 'utf8', mode });
  chmodIfSupported(tmpPath, mode);
  renameSync(tmpPath, targetPath);
  chmodIfSupported(targetPath, mode);
}

function chmodIfSupported(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Some filesystems do not support chmod; config redaction remains enforced.
  }
}

function pathsAlias(left: string, right: string): boolean {
  return canonicalMutationPath(left) === canonicalMutationPath(right);
}

function canonicalMutationPath(path: string): string {
  return canonicalAbsoluteMutationPath(resolve(path), new Set<string>());
}

function canonicalAbsoluteMutationPath(
  path: string,
  followedSymlinks: Set<string>
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
  followedSymlinks: Set<string>
): string | undefined {
  try {
    if (!lstatSync(path).isSymbolicLink()) {
      return undefined;
    }

    if (followedSymlinks.has(path)) {
      throw new RuntimeConfigMutationError(
        `Could not resolve runtime config path because ${path} is part of a symlink cycle.`
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
  followedSymlinks: Set<string>
): string {
  const parent = dirname(path);

  if (parent === path) {
    return path;
  }

  return resolve(
    canonicalAbsoluteMutationPath(parent, followedSymlinks),
    basename(path)
  );
}

function mutationFileAccessError(
  message: string,
  cause: unknown
): RuntimeConfigMutationError {
  return cause instanceof RuntimeConfigMutationError
    ? cause
    : new RuntimeConfigMutationError(message, { cause });
}

function parseConfigPath(path: string): readonly string[] {
  const parts = path.split('.').map((part) => part.trim());

  if (parts.length === 0 || parts.some((part) => part.length === 0)) {
    throw new TypeError('Runtime config path must use non-empty dot segments.');
  }

  return Object.freeze(parts);
}

type ParsedPluginMutationPath =
  | {
      readonly kind: 'enabled';
      readonly pluginId: string;
    }
  | {
      readonly kind: 'config_object';
      readonly pluginId: string;
    }
  | {
      readonly kind: 'config_field';
      readonly pluginId: string;
      readonly fieldName: string;
    };

function parsePluginMutationPath(
  parts: readonly string[],
  path: string,
  config?: Project02RuntimeConfig
): ParsedPluginMutationPath {
  // Paths can contain `config` in both plugin IDs and field names; prefer known
  // plugin IDs before falling back to the legacy delimiter heuristic.
  const contextCandidate = knownPluginPathCandidate(
    pluginPathCandidates(parts),
    config
  );

  if (contextCandidate !== undefined) {
    return contextCandidate;
  }

  const fallbackCandidate = fallbackPluginPathCandidate(parts);

  if (fallbackCandidate !== undefined) {
    return fallbackCandidate;
  }

  throw new TypeError(`Unsupported runtime config path: ${path}.`);
}

function pluginPathCandidates(parts: readonly string[]): readonly ParsedPluginMutationPath[] {
  const candidates: ParsedPluginMutationPath[] = [];

  for (let index = 2; index < parts.length - 1; index += 1) {
    if (parts[index] === 'config') {
      const pluginId = parts.slice(1, index).join('.');
      const fieldName = parts.slice(index + 1).join('.');

      if (pluginId.length > 0 && fieldName.length > 0) {
        candidates.push(
          Object.freeze({
            kind: 'config_field',
            pluginId,
            fieldName
          })
        );
      }
    }
  }

  if (parts.at(-1) === 'config') {
    const pluginId = parts.slice(1, -1).join('.');

    if (pluginId.length > 0) {
      candidates.push(
        Object.freeze({
          kind: 'config_object',
          pluginId
        })
      );
    }
  }

  if (parts.at(-1) === 'enabled') {
    const pluginId = parts.slice(1, -1).join('.');

    if (pluginId.length > 0) {
      candidates.push(
        Object.freeze({
          kind: 'enabled',
          pluginId
        })
      );
    }
  }

  return Object.freeze(candidates);
}

function knownPluginPathCandidate(
  candidates: readonly ParsedPluginMutationPath[],
  config: Project02RuntimeConfig | undefined
): ParsedPluginMutationPath | undefined {
  if (config === undefined) {
    return undefined;
  }

  let selected: ParsedPluginMutationPath | undefined;

  for (const candidate of candidates) {
    if (!isKnownPluginId(config, candidate.pluginId)) {
      continue;
    }

    if (
      selected === undefined ||
      pluginIdSpecificity(candidate.pluginId) > pluginIdSpecificity(selected.pluginId)
    ) {
      selected = candidate;
    }
  }

  return selected;
}

function isKnownPluginId(config: Project02RuntimeConfig, pluginId: string): boolean {
  return (
    Object.hasOwn(config.plugins ?? {}, pluginId) ||
    config.enabledPlugins?.includes(pluginId) === true ||
    config.defaultMemoryProvider === pluginId
  );
}

function pluginIdSpecificity(pluginId: string): number {
  return pluginId.split('.').length;
}

function fallbackPluginPathCandidate(
  parts: readonly string[]
): ParsedPluginMutationPath | undefined {
  const configSegmentIndex = fallbackPluginConfigSegmentIndex(parts);

  if (configSegmentIndex !== undefined) {
    const pluginId = parts.slice(1, configSegmentIndex).join('.');
    const fieldName = parts.slice(configSegmentIndex + 1).join('.');

    if (pluginId.length === 0) {
      throw new TypeError('Runtime config plugin path must include a plugin id.');
    }

    if (fieldName.length === 0) {
      throw new TypeError('Plugin config path must include a field name.');
    }

    return Object.freeze({
      kind: 'config_field',
      pluginId,
      fieldName
    });
  }

  if (parts.at(-1) === 'enabled') {
    const pluginId = parts.slice(1, -1).join('.');

    if (pluginId.length === 0) {
      throw new TypeError('Runtime config plugin path must include a plugin id.');
    }

    return Object.freeze({
      kind: 'enabled',
      pluginId
    });
  }

  return undefined;
}

function fallbackPluginConfigSegmentIndex(parts: readonly string[]): number | undefined {
  for (let index = 2; index < parts.length - 1; index += 1) {
    if (parts[index] === 'config') {
      return index;
    }
  }

  return undefined;
}

function tryParsePluginMutationPath(
  parts: readonly string[],
  path: string,
  config?: Project02RuntimeConfig
): ParsedPluginMutationPath | undefined {
  try {
    return parsePluginMutationPath(parts, path, config);
  } catch {
    return undefined;
  }
}

function freezeConfig(config: Project02RuntimeConfig): Project02RuntimeConfig {
  return Object.freeze(config);
}

function setOrDeletePluginWrapper(
  config: Project02RuntimeConfig,
  plugins: Record<string, Project02RuntimePluginConfig>,
  pluginId: string,
  pluginConfig: Project02RuntimePluginConfig
): Project02RuntimeConfig {
  if (isEmptyPluginWrapper(pluginConfig)) {
    return freezeConfigWithPluginWrappers(
      config,
      pluginWrappersWithout(plugins, pluginId)
    );
  }

  plugins[pluginId] = freezePluginConfig(pluginConfig);
  return freezeConfigWithPluginWrappers(config, plugins);
}

function pluginWrappersWithout(
  plugins: Readonly<Record<string, Project02RuntimePluginConfig>>,
  pluginId: string
): Record<string, Project02RuntimePluginConfig> {
  return Object.fromEntries(
    Object.entries(plugins).filter(([entryPluginId]) => entryPluginId !== pluginId)
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
  plugins: Readonly<Record<string, Project02RuntimePluginConfig>>
): Project02RuntimeConfig {
  const pluginEntries = Object.entries(plugins);

  if (pluginEntries.length > 0) {
    return freezeConfig({
      ...config,
      plugins: Object.freeze(
        Object.fromEntries(pluginEntries) as Readonly<
          Record<string, Project02RuntimePluginConfig>
        >
      )
    });
  }

  return freezeConfig({
    version: config.version,
    ...(config.storeRoot === undefined ? {} : { storeRoot: config.storeRoot }),
    ...(config.enabledPlugins === undefined ? {} : { enabledPlugins: config.enabledPlugins }),
    ...(config.defaultMemoryProvider === undefined
      ? {}
      : { defaultMemoryProvider: config.defaultMemoryProvider })
  });
}

function freezePluginConfig(
  config: Project02RuntimePluginConfig
): Project02RuntimePluginConfig {
  return Object.freeze(config);
}

function isStringArray(value: RuntimeConfigValue): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
