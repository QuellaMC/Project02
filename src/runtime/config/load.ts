import {existsSync, readFileSync, statSync} from 'node:fs';

import {
  createProject02HomeLayout,
  LocalRuntimeStorageContractError,
} from '../storage/layout-contract.ts';
import {
  runtimeConfigEnvVarName,
  runtimeConfigVersion,
  type LoadedProject02RuntimeConfig,
  type Project02HostConfig,
  type Project02RuntimeConfig,
  type Project02RuntimePluginConfig,
  type RuntimeConfigDiagnostic,
  type RuntimeConfigDiagnosticPluginMetadata,
  type RuntimeConfigSource,
  type RuntimeConfigValue,
} from './types.ts';
import {createJsonBoundarySnapshot} from '../../shared/json-boundary.ts';
import {createRuntimeConfigDiagnostic} from './diagnostic.ts';
import {
  project02RuntimeConfigFieldDefinitions,
  project02RuntimeConfigFieldNames,
  runtimeConfigValueMatchesField,
} from './schema.ts';

const project02RuntimeConfigFields = Object.freeze([
  'version',
  'project02',
  'plugins',
]);
const project02HostConfigFields = project02RuntimeConfigFieldNames();
const project02RuntimePluginConfigFields = Object.freeze(['enabled', 'config']);
const runtimeConfigSecretRefFields = Object.freeze(['$env', 'description']);
const runtimeConfigPlaintextSecretOverrideFields = Object.freeze([
  '$plaintextSecret',
  'allowPlaintextSecret',
  'justification',
]);

export const maxProject02RuntimeConfigBytes = 256 * 1_024;

export type LoadProject02RuntimeConfigOptions = {
  readonly configPath?: string;
  readonly storeRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
};

export type Project02RuntimeConfigValidationResult = {
  readonly config?: Project02RuntimeConfig;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
};

export function loadProject02RuntimeConfig(
  options: LoadProject02RuntimeConfigOptions = {},
): LoadedProject02RuntimeConfig {
  const env = options.env ?? process.env;
  const location = resolveRuntimeConfigLocation({...options, env});

  if (location.source === 'none') {
    return Object.freeze({
      source: 'none',
      diagnostics: [],
    } satisfies LoadedProject02RuntimeConfig);
  }

  if (!existsSync(location.path)) {
    if (location.source === 'default') {
      return Object.freeze({
        source: 'none',
        diagnostics: [],
      } satisfies LoadedProject02RuntimeConfig);
    }

    return Object.freeze({
      source: location.source,
      path: location.path,
      diagnostics: [
        createRuntimeConfigDiagnostic(
          'error',
          'runtime_config_missing',
          `Runtime config file does not exist: ${location.path}.`,
        ),
      ],
    } satisfies LoadedProject02RuntimeConfig);
  }

  const document = readProject02RuntimeConfigDocument(location.path);

  if (document.status === 'rejected') {
    return Object.freeze({
      source: location.source,
      path: location.path,
      diagnostics: [document.diagnostic],
    } satisfies LoadedProject02RuntimeConfig);
  }

  const accepted = validateProject02RuntimeConfig(document.value);

  return Object.freeze({
    source: location.source,
    path: location.path,
    ...(accepted.config === undefined ? {} : {config: accepted.config}),
    diagnostics: accepted.diagnostics,
  } satisfies LoadedProject02RuntimeConfig);
}

/**
 * Reads and parses one runtime config document (size caps + JSON parse),
 * shared by the global loader and the character overlay loader. Existence
 * checks stay with the callers: an absent file means different things to
 * each of them.
 */
export function readProject02RuntimeConfigDocument(path: string):
  | {readonly status: 'accepted'; readonly value: unknown}
  | {
      readonly status: 'rejected';
      readonly diagnostic: RuntimeConfigDiagnostic;
    } {
  const readResult = readRuntimeConfigSource(path);

  if (readResult.status === 'rejected') {
    return readResult;
  }

  try {
    return {
      status: 'accepted',
      value: JSON.parse(readResult.source) as unknown,
    };
  } catch (error: unknown) {
    return {
      status: 'rejected',
      diagnostic: createRuntimeConfigDiagnostic(
        'error',
        'runtime_config_malformed_json',
        `Runtime config file is not valid JSON: ${
          error instanceof Error ? error.message : 'unknown parse error'
        }.`,
      ),
    };
  }
}

function readRuntimeConfigSource(path: string):
  | {readonly status: 'accepted'; readonly source: string}
  | {
      readonly status: 'rejected';
      readonly diagnostic: RuntimeConfigDiagnostic;
    } {
  let fileStat: ReturnType<typeof statSync>;

  try {
    fileStat = statSync(path);
  } catch {
    return {
      status: 'rejected',
      diagnostic: createRuntimeConfigDiagnostic(
        'error',
        'runtime_config_read_failed',
        `Runtime config file could not be inspected: ${path}.`,
      ),
    };
  }

  if (!fileStat.isFile()) {
    return {
      status: 'rejected',
      diagnostic: createRuntimeConfigDiagnostic(
        'error',
        'runtime_config_read_failed',
        `Runtime config path is not a regular file: ${path}.`,
      ),
    };
  }

  if (fileStat.size > maxProject02RuntimeConfigBytes) {
    return {
      status: 'rejected',
      diagnostic: runtimeConfigLimitDiagnostic(
        `Runtime config file exceeds the ${String(maxProject02RuntimeConfigBytes)}-byte size limit.`,
      ),
    };
  }

  let source: string;

  try {
    source = readFileSync(path, 'utf8');
  } catch {
    return {
      status: 'rejected',
      diagnostic: createRuntimeConfigDiagnostic(
        'error',
        'runtime_config_read_failed',
        `Runtime config file could not be read: ${path}.`,
      ),
    };
  }

  if (Buffer.byteLength(source, 'utf8') > maxProject02RuntimeConfigBytes) {
    return {
      status: 'rejected',
      diagnostic: runtimeConfigLimitDiagnostic(
        `Runtime config file exceeds the ${String(maxProject02RuntimeConfigBytes)}-byte size limit.`,
      ),
    };
  }

  return {status: 'accepted', source};
}

export function validateProject02RuntimeConfig(
  value: unknown,
): Project02RuntimeConfigValidationResult {
  let accepted: ReturnType<typeof parseProject02RuntimeConfig>;

  try {
    accepted = parseProject02RuntimeConfig(value);
  } catch (error: unknown) {
    if (error instanceof RuntimeConfigBoundaryLimitError) {
      return Object.freeze({
        diagnostics: Object.freeze([
          runtimeConfigLimitDiagnostic(
            `Runtime config exceeds safe JSON limits: ${error.message}`,
          ),
        ]),
      } satisfies Project02RuntimeConfigValidationResult);
    }

    throw error;
  }

  return Object.freeze({
    ...(accepted.config === undefined ? {} : {config: accepted.config}),
    diagnostics: Object.freeze([...accepted.diagnostics]),
  } satisfies Project02RuntimeConfigValidationResult);
}

export function defaultRuntimeConfigPath(storeRoot?: string): string {
  return createProject02HomeLayout(
    storeRoot === undefined ? {} : {homeRoot: storeRoot},
  ).configPath;
}

export function defaultRuntimeConfigEnvPath(storeRoot?: string): string {
  return createProject02HomeLayout(
    storeRoot === undefined ? {} : {homeRoot: storeRoot},
  ).envPath;
}

function resolveRuntimeConfigLocation(options: {
  readonly configPath?: string;
  readonly storeRoot?: string;
  readonly env: NodeJS.ProcessEnv;
}):
  | {
      readonly source: Exclude<RuntimeConfigSource, 'none'>;
      readonly path: string;
    }
  | {readonly source: 'none'} {
  if (options.configPath !== undefined) {
    return {
      source: 'path',
      path: normalizeConfigPath(options.configPath),
    };
  }

  if (options.storeRoot !== undefined) {
    return {
      source: 'default',
      path: defaultRuntimeConfigPath(options.storeRoot),
    };
  }

  const envPath = options.env[runtimeConfigEnvVarName];

  if (envPath !== undefined && envPath.trim().length > 0) {
    return {
      source: 'env',
      path: normalizeConfigPath(envPath),
    };
  }

  return {
    source: 'default',
    path: defaultRuntimeConfigPath(options.storeRoot),
  };
}

function parseProject02RuntimeConfig(value: unknown): {
  readonly config?: Project02RuntimeConfig;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
} {
  const diagnostics: RuntimeConfigDiagnostic[] = [];

  if (!isRecord(value)) {
    return {
      diagnostics: [
        createRuntimeConfigDiagnostic(
          'error',
          'runtime_config_not_object',
          'Runtime config must be an object.',
        ),
      ],
    };
  }

  pushUnknownRuntimeConfigFieldDiagnostics(value, diagnostics);

  if (value['version'] !== runtimeConfigVersion) {
    diagnostics.push(
      createRuntimeConfigDiagnostic(
        'error',
        'runtime_config_version_unsupported',
        `Runtime config version must be "${runtimeConfigVersion}".`,
        'version',
      ),
    );
  }

  const project02 = optionalProject02HostConfig(
    value['project02'],
    diagnostics,
  );
  const plugins = optionalPluginConfigs(value['plugins'], diagnostics);

  if (diagnostics.some(item => item.severity === 'error')) {
    return {
      diagnostics,
    };
  }

  return {
    config: Object.freeze({
      version: runtimeConfigVersion,
      ...(project02 === undefined ? {} : {project02}),
      ...(plugins === undefined ? {} : {plugins}),
    } satisfies Project02RuntimeConfig),
    diagnostics,
  };
}

function optionalProject02HostConfig(
  value: unknown,
  diagnostics: RuntimeConfigDiagnostic[],
): Project02HostConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    diagnostics.push(
      createRuntimeConfigDiagnostic(
        'error',
        'runtime_config_project02_not_object',
        'Runtime config project02 section must be an object.',
        'project02',
      ),
    );
    return undefined;
  }

  pushUnknownFieldDiagnostics({
    value,
    allowedFields: project02HostConfigFields,
    diagnostics,
    code: 'runtime_config_unknown_project02_field',
    messageForField: field => `Unknown Project02 config field "${field}".`,
    pathForField: field => `project02.${field}`,
  });

  const config: Record<string, RuntimeConfigValue> = {};

  for (const field of project02RuntimeConfigFieldDefinitions()) {
    const fieldValue = value[field.name];

    if (fieldValue === undefined) {
      continue;
    }

    if (
      !isRuntimeConfigValue(fieldValue) ||
      !runtimeConfigValueMatchesField(fieldValue, field) ||
      (typeof fieldValue === 'string' && fieldValue.trim().length === 0)
    ) {
      diagnostics.push(project02HostConfigFieldDiagnostic(field));
      continue;
    }

    config[field.name] = snapshotRuntimeConfigValue(fieldValue, field.path);
  }

  return Object.freeze(config);
}

function project02HostConfigFieldDiagnostic(
  field: ReturnType<typeof project02RuntimeConfigFieldDefinitions>[number],
): RuntimeConfigDiagnostic {
  return createRuntimeConfigDiagnostic(
    'error',
    field.invalidValueCode,
    field.invalidValueMessage,
    field.path,
  );
}

function optionalPluginConfigs(
  value: unknown,
  diagnostics: RuntimeConfigDiagnostic[],
): Readonly<Record<string, Project02RuntimePluginConfig>> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    diagnostics.push(
      createRuntimeConfigDiagnostic(
        'error',
        'runtime_config_plugins_not_object',
        'Runtime config plugins must be an object.',
        'plugins',
      ),
    );
    return undefined;
  }

  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).flatMap(([pluginId, pluginValue]) => {
        if (!isRecord(pluginValue)) {
          diagnostics.push(
            createRuntimeConfigDiagnostic(
              'error',
              'runtime_config_plugin_not_object',
              `Runtime config plugin "${pluginId}" must be an object.`,
              `plugins.${pluginId}`,
            ),
          );
          return [];
        }

        pushUnknownRuntimePluginConfigFieldDiagnostics({
          pluginId,
          value: pluginValue,
          diagnostics,
        });

        const enabled = optionalBoolean(
          pluginValue['enabled'],
          `plugins.${pluginId}.enabled`,
          diagnostics,
        );
        const config = optionalConfigRecord(
          pluginValue['config'],
          `plugins.${pluginId}.config`,
          diagnostics,
        );

        return [
          [
            pluginId,
            Object.freeze({
              ...(enabled === undefined ? {} : {enabled}),
              ...(config === undefined ? {} : {config}),
            } satisfies Project02RuntimePluginConfig),
          ],
        ];
      }),
    ),
  );
}

function optionalConfigRecord(
  value: unknown,
  path: string,
  diagnostics: RuntimeConfigDiagnostic[],
): Readonly<Record<string, RuntimeConfigValue>> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    diagnostics.push(
      createRuntimeConfigDiagnostic(
        'error',
        'runtime_config_plugin_config_not_object',
        'Plugin config must be an object.',
        path,
      ),
    );
    return undefined;
  }

  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        if (!isRuntimeConfigValue(item)) {
          diagnostics.push(
            createRuntimeConfigDiagnostic(
              'error',
              'runtime_config_value_invalid',
              'Runtime config values must be JSON-compatible values or supported secret refs.',
              `${path}.${key}`,
            ),
          );
          return [];
        }

        return [[key, snapshotRuntimeConfigValue(item, `${path}.${key}`)]];
      }),
    ),
  );
}

function pushUnknownRuntimeConfigFieldDiagnostics(
  value: Readonly<Record<string, unknown>>,
  diagnostics: RuntimeConfigDiagnostic[],
): void {
  pushUnknownFieldDiagnostics({
    value,
    allowedFields: project02RuntimeConfigFields,
    diagnostics,
    code: 'runtime_config_unknown_top_level_field',
    messageForField: field => `Unknown runtime config field "${field}".`,
    pathForField: field => field,
  });
}

function pushUnknownRuntimePluginConfigFieldDiagnostics(options: {
  readonly pluginId: string;
  readonly value: Readonly<Record<string, unknown>>;
  readonly diagnostics: RuntimeConfigDiagnostic[];
}): void {
  pushUnknownFieldDiagnostics({
    value: options.value,
    allowedFields: project02RuntimePluginConfigFields,
    diagnostics: options.diagnostics,
    code: 'runtime_config_unknown_plugin_wrapper_field',
    messageForField: field =>
      `Unknown plugin wrapper field "${field}" for plugin "${options.pluginId}".`,
    pathForField: field => `plugins.${options.pluginId}.${field}`,
    metadataForField: () => ({pluginId: options.pluginId}),
  });
}

function pushUnknownFieldDiagnostics(options: {
  readonly value: Readonly<Record<string, unknown>>;
  readonly allowedFields: readonly string[];
  readonly diagnostics: RuntimeConfigDiagnostic[];
  readonly code: string;
  readonly messageForField: (field: string) => string;
  readonly pathForField: (field: string) => string;
  readonly metadataForField?: (
    field: string,
  ) => RuntimeConfigDiagnosticPluginMetadata;
}): void {
  const allowedFields = new Set(options.allowedFields);

  for (const field of Object.keys(options.value).sort((a, b) =>
    a.localeCompare(b),
  )) {
    if (allowedFields.has(field)) {
      continue;
    }

    options.diagnostics.push(
      createRuntimeConfigDiagnostic(
        'error',
        options.code,
        options.messageForField(field),
        options.pathForField(field),
        options.metadataForField?.(field),
      ),
    );
  }
}

function isRuntimeConfigValue(value: unknown): value is RuntimeConfigValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isRuntimeConfigValue);
  }

  if (!isRecord(value)) {
    return false;
  }

  if ('$env' in value) {
    return (
      hasOnlyFields(value, runtimeConfigSecretRefFields) &&
      typeof value['$env'] === 'string' &&
      value['$env'].trim().length > 0 &&
      (value['description'] === undefined ||
        typeof value['description'] === 'string')
    );
  }

  if ('$plaintextSecret' in value) {
    return (
      hasOnlyFields(value, runtimeConfigPlaintextSecretOverrideFields) &&
      typeof value['$plaintextSecret'] === 'string' &&
      value['allowPlaintextSecret'] === true &&
      typeof value['justification'] === 'string' &&
      value['justification'].trim().length > 0
    );
  }

  return Object.values(value).every(isRuntimeConfigValue);
}

function hasOnlyFields(
  value: Readonly<Record<string, unknown>>,
  allowedFields: readonly string[],
): boolean {
  return Object.keys(value).every(field => allowedFields.includes(field));
}

function optionalBoolean(
  value: unknown,
  path: string,
  diagnostics: RuntimeConfigDiagnostic[],
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    diagnostics.push(
      createRuntimeConfigDiagnostic(
        'error',
        'runtime_config_boolean_invalid',
        'Runtime config field must be a boolean.',
        path,
      ),
    );
    return undefined;
  }

  return value;
}

function normalizeConfigPath(value: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new LocalRuntimeStorageContractError(
      'missing_file',
      'Runtime config path must be non-empty.',
    );
  }

  return normalized;
}

function runtimeConfigLimitDiagnostic(
  message: string,
): RuntimeConfigDiagnostic {
  return createRuntimeConfigDiagnostic(
    'error',
    'runtime_config_limit_exceeded',
    message,
  );
}

class RuntimeConfigBoundaryLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigBoundaryLimitError';
  }
}

function snapshotRuntimeConfigValue(
  value: RuntimeConfigValue,
  field: string,
): RuntimeConfigValue {
  try {
    return createJsonBoundarySnapshot(value, {field});
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      throw new RuntimeConfigBoundaryLimitError(error.message);
    }

    throw error;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
