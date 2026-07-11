import { existsSync, readFileSync } from 'node:fs';

import {
  createLocalRuntimeStorageLayout,
  LocalRuntimeStorageContractError
} from '../storage/layout.ts';
import {
  runtimeConfigEnvVarName,
  runtimeConfigVersion,
  type LoadedProject02RuntimeConfig,
  type Project02RuntimeConfig,
  type Project02RuntimePluginConfig,
  type RuntimeConfigDiagnostic,
  type RuntimeConfigDiagnosticPluginMetadata,
  type RuntimeConfigSource,
  type RuntimeConfigValue
} from './types.ts';
import { createJsonBoundarySnapshot } from '../../shared/json-boundary.ts';

const project02RuntimeConfigFields = Object.freeze([
  'version',
  'storeRoot',
  'defaultMemoryProvider',
  'plugins'
]);
const project02RuntimePluginConfigFields = Object.freeze([
  'enabled',
  'config'
]);
const runtimeConfigSecretRefFields = Object.freeze(['$env', 'description']);
const runtimeConfigPlaintextSecretOverrideFields = Object.freeze([
  '$plaintextSecret',
  'allowPlaintextSecret',
  'justification'
]);

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
  options: LoadProject02RuntimeConfigOptions = {}
): LoadedProject02RuntimeConfig {
  const env = options.env ?? process.env;
  const location = resolveRuntimeConfigLocation({ ...options, env });

  if (location.source === 'none') {
    return Object.freeze({
      source: 'none',
      diagnostics: []
    } satisfies LoadedProject02RuntimeConfig);
  }

  if (!existsSync(location.path)) {
    if (location.source === 'default') {
      return Object.freeze({
        source: 'none',
        diagnostics: []
      } satisfies LoadedProject02RuntimeConfig);
    }

    return Object.freeze({
      source: location.source,
      path: location.path,
      diagnostics: [
        diagnostic(
          'error',
          'runtime_config_missing',
          `Runtime config file does not exist: ${location.path}.`
        )
      ]
    } satisfies LoadedProject02RuntimeConfig);
  }

  try {
    const parsed = JSON.parse(readFileSync(location.path, 'utf8')) as unknown;
    const accepted = validateProject02RuntimeConfig(parsed);

    return Object.freeze({
      source: location.source,
      path: location.path,
      ...(accepted.config === undefined ? {} : { config: accepted.config }),
      diagnostics: accepted.diagnostics
    } satisfies LoadedProject02RuntimeConfig);
  } catch (error: unknown) {
    return Object.freeze({
      source: location.source,
      path: location.path,
      diagnostics: [
        diagnostic(
          'error',
          'runtime_config_malformed_json',
          `Runtime config file is not valid JSON: ${
            error instanceof Error ? error.message : 'unknown parse error'
          }.`
        )
      ]
    } satisfies LoadedProject02RuntimeConfig);
  }
}

export function validateProject02RuntimeConfig(
  value: unknown
): Project02RuntimeConfigValidationResult {
  const accepted = parseProject02RuntimeConfig(value);

  return Object.freeze({
    ...(accepted.config === undefined ? {} : { config: accepted.config }),
    diagnostics: Object.freeze([...accepted.diagnostics])
  } satisfies Project02RuntimeConfigValidationResult);
}

export function defaultRuntimeConfigPath(storeRoot?: string): string {
  return createLocalRuntimeStorageLayout(
    storeRoot === undefined ? {} : { storeRoot }
  ).configPath;
}

export function defaultRuntimeConfigEnvPath(storeRoot?: string): string {
  return createLocalRuntimeStorageLayout(
    storeRoot === undefined ? {} : { storeRoot }
  ).envPath;
}

function resolveRuntimeConfigLocation(options: {
  readonly configPath?: string;
  readonly storeRoot?: string;
  readonly env: NodeJS.ProcessEnv;
}):
  | { readonly source: Exclude<RuntimeConfigSource, 'none'>; readonly path: string }
  | { readonly source: 'none' } {
  if (options.configPath !== undefined) {
    return {
      source: 'path',
      path: normalizeConfigPath(options.configPath)
    };
  }

  if (options.storeRoot !== undefined) {
    return {
      source: 'default',
      path: defaultRuntimeConfigPath(options.storeRoot)
    };
  }

  const envPath = options.env[runtimeConfigEnvVarName];

  if (envPath !== undefined && envPath.trim().length > 0) {
    return {
      source: 'env',
      path: normalizeConfigPath(envPath)
    };
  }

  return {
    source: 'default',
    path: defaultRuntimeConfigPath(options.storeRoot)
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
        diagnostic(
          'error',
          'runtime_config_not_object',
          'Runtime config must be an object.'
        )
      ]
    };
  }

  pushUnknownRuntimeConfigFieldDiagnostics(value, diagnostics);

  if (value['version'] !== runtimeConfigVersion) {
    diagnostics.push(
      diagnostic(
        'error',
        'runtime_config_version_unsupported',
        `Runtime config version must be "${runtimeConfigVersion}".`,
        'version'
      )
    );
  }

  const storeRoot = optionalString(value['storeRoot'], 'storeRoot', diagnostics);
  const defaultMemoryProvider = optionalString(
    value['defaultMemoryProvider'],
    'defaultMemoryProvider',
    diagnostics
  );
  const plugins = optionalPluginConfigs(value['plugins'], diagnostics);

  if (diagnostics.some((item) => item.severity === 'error')) {
    return {
      diagnostics
    };
  }

  return {
    config: Object.freeze({
      version: runtimeConfigVersion,
      ...(storeRoot === undefined ? {} : { storeRoot }),
      ...(defaultMemoryProvider === undefined ? {} : { defaultMemoryProvider }),
      ...(plugins === undefined ? {} : { plugins })
    } satisfies Project02RuntimeConfig),
    diagnostics
  };
}

function optionalPluginConfigs(
  value: unknown,
  diagnostics: RuntimeConfigDiagnostic[]
): Readonly<Record<string, Project02RuntimePluginConfig>> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic(
        'error',
        'runtime_config_plugins_not_object',
        'Runtime config plugins must be an object.',
        'plugins'
      )
    );
    return undefined;
  }

  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).flatMap(([pluginId, pluginValue]) => {
        if (!isRecord(pluginValue)) {
          diagnostics.push(
            diagnostic(
              'error',
              'runtime_config_plugin_not_object',
              `Runtime config plugin "${pluginId}" must be an object.`,
              `plugins.${pluginId}`
            )
          );
          return [];
        }

        pushUnknownRuntimePluginConfigFieldDiagnostics({
          pluginId,
          value: pluginValue,
          diagnostics
        });

        const enabled = optionalBoolean(
          pluginValue['enabled'],
          `plugins.${pluginId}.enabled`,
          diagnostics
        );
        const config = optionalConfigRecord(
          pluginValue['config'],
          `plugins.${pluginId}.config`,
          diagnostics
        );

        return [
          [
            pluginId,
            Object.freeze({
              ...(enabled === undefined ? {} : { enabled }),
              ...(config === undefined ? {} : { config })
            } satisfies Project02RuntimePluginConfig)
          ]
        ];
      })
    )
  );
}

function optionalConfigRecord(
  value: unknown,
  path: string,
  diagnostics: RuntimeConfigDiagnostic[]
): Readonly<Record<string, RuntimeConfigValue>> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic(
        'error',
        'runtime_config_plugin_config_not_object',
        'Plugin config must be an object.',
        path
      )
    );
    return undefined;
  }

  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        if (!isRuntimeConfigValue(item)) {
          diagnostics.push(
            diagnostic(
              'error',
              'runtime_config_value_invalid',
              'Runtime config values must be JSON-compatible values or supported secret refs.',
              `${path}.${key}`
            )
          );
          return [];
        }

        return [
          [
            key,
            createJsonBoundarySnapshot(item, {
              field: `${path}.${key}`
            })
          ]
        ];
      })
    )
  );
}

function pushUnknownRuntimeConfigFieldDiagnostics(
  value: Readonly<Record<string, unknown>>,
  diagnostics: RuntimeConfigDiagnostic[]
): void {
  pushUnknownFieldDiagnostics({
    value,
    allowedFields: project02RuntimeConfigFields,
    diagnostics,
    code: 'runtime_config_unknown_top_level_field',
    messageForField: (field) => `Unknown runtime config field "${field}".`,
    pathForField: (field) => field
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
    messageForField: (field) =>
      `Unknown plugin wrapper field "${field}" for plugin "${options.pluginId}".`,
    pathForField: (field) => `plugins.${options.pluginId}.${field}`,
    metadataForField: () => ({ pluginId: options.pluginId })
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
    field: string
  ) => RuntimeConfigDiagnosticPluginMetadata;
}): void {
  const allowedFields = new Set(options.allowedFields);

  for (const field of Object.keys(options.value).sort((a, b) =>
    a.localeCompare(b)
  )) {
    if (allowedFields.has(field)) {
      continue;
    }

    options.diagnostics.push(
      diagnostic(
        'error',
        options.code,
        options.messageForField(field),
        options.pathForField(field),
        options.metadataForField?.(field)
      )
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
  allowedFields: readonly string[]
): boolean {
  return Object.keys(value).every((field) => allowedFields.includes(field));
}

function optionalString(
  value: unknown,
  path: string,
  diagnostics: RuntimeConfigDiagnostic[]
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    diagnostics.push(
      diagnostic(
        'error',
        'runtime_config_string_invalid',
        'Runtime config field must be a non-empty string.',
        path
      )
    );
    return undefined;
  }

  return value;
}

function optionalBoolean(
  value: unknown,
  path: string,
  diagnostics: RuntimeConfigDiagnostic[]
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    diagnostics.push(
      diagnostic(
        'error',
        'runtime_config_boolean_invalid',
        'Runtime config field must be a boolean.',
        path
      )
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
      'Runtime config path must be non-empty.'
    );
  }

  return normalized;
}

function diagnostic(
  severity: RuntimeConfigDiagnostic['severity'],
  code: string,
  message: string,
  path?: string,
  metadata?: RuntimeConfigDiagnosticPluginMetadata
): RuntimeConfigDiagnostic {
  const base = {
    severity,
    code,
    message,
    ...(path === undefined ? {} : { path })
  } as const;

  return metadata === undefined
    ? Object.freeze({ ...base, scope: 'global' })
    : Object.freeze({
        ...base,
        scope: 'plugin',
        pluginId: metadata.pluginId,
        ...(metadata.pluginConfigField === undefined
          ? {}
          : { pluginConfigField: metadata.pluginConfigField })
      });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
