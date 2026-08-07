import {isJsonRecord} from '../../shared/json-boundary.ts';
import {pathExistsSync} from '../../shared/file-system.ts';
import {
  readBoundedJsonFileSource,
  type BoundedJsonFileSourceRejectionReason,
} from '../../shared/package-metadata.ts';
import {dirname} from 'node:path';

import {
  createProject02HomeLayout,
  LocalRuntimeStorageContractError,
} from '../storage/layout-contract.ts';
import {isProject02CharacterDataOwnedPath} from '../storage/character-data.ts';
import {
  runtimeConfigEnvVarName,
  runtimeConfigVersion,
  type Project02HostConfig,
  type Project02RuntimeConfig,
  type Project02RuntimePluginConfig,
  type RuntimeConfigDiagnostic,
  type RuntimeConfigDiagnosticPluginMetadata,
  type RuntimeConfigSource,
  type RuntimeConfigValue,
  type SelectedLoadedProject02RuntimeConfig,
  type SelectedProject02RuntimeConfigLocation,
  type SelectedProject02RuntimeConfigOwner,
} from './types.ts';
import {
  createJsonBoundaryObjectSnapshot,
  createJsonBoundarySnapshot,
  defaultJsonBoundaryLimits,
  type JsonBoundaryObject,
  type JsonBoundaryLimits,
} from '../../shared/json-boundary.ts';
import {canonicalRuntimeConfigPath} from './path.ts';
import {
  allowPlaintextSecretMarkerField,
  plaintextSecretMarkerField,
  secretEnvMarkerField,
} from '../../shared/secret-marker.ts';
import {createRuntimeConfigDiagnostic} from './diagnostic.ts';
import {
  project02RuntimeConfigFieldAcceptsValue,
  project02RuntimeConfigFieldDefinitions,
  project02RuntimeConfigFieldNames,
} from './schema.ts';

const project02RuntimeConfigFields = Object.freeze([
  'version',
  'project02',
  'plugins',
]);
const project02HostConfigFields = project02RuntimeConfigFieldNames();
const project02RuntimePluginConfigFields = Object.freeze(['enabled', 'config']);
const runtimeConfigSecretRefFields = Object.freeze([secretEnvMarkerField]);
const runtimeConfigPlaintextSecretOverrideFields = Object.freeze([
  plaintextSecretMarkerField,
  allowPlaintextSecretMarkerField,
  'justification',
]);

const maxProject02RuntimeConfigBytes = 256 * 1_024;
const runtimeConfigJsonBoundaryLimits = Object.freeze({
  ...defaultJsonBoundaryLimits,
  maxTotalStringBytes: maxProject02RuntimeConfigBytes,
} satisfies JsonBoundaryLimits);

export class RuntimeConfigLocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigLocationError';
  }
}

type Project02RuntimeConfigValidationResult = {
  readonly authoredDocument?: JsonBoundaryObject;
  readonly config?: Project02RuntimeConfig;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
};

const selectedLoadedProject02RuntimeConfigSnapshots = new WeakSet<object>();
const selectedProject02RuntimeConfigLocations = new WeakSet<object>();

export function loadSelectedProject02RuntimeConfig(
  location: SelectedProject02RuntimeConfigLocation,
): SelectedLoadedProject02RuntimeConfig {
  const selectedConfig =
    requireSelectedProject02RuntimeConfigLocation(location);

  assertSelectedRuntimeConfigStillBound(selectedConfig);

  if (!pathExistsSync(selectedConfig.canonicalPath)) {
    if (selectedConfig.source === 'default') {
      return registerSelectedLoadedProject02RuntimeConfigSnapshot({
        source: 'none',
        path: selectedConfig.path,
        selectedConfig,
        diagnostics: [],
      });
    }

    return registerSelectedLoadedProject02RuntimeConfigSnapshot({
      source: selectedConfig.source,
      path: selectedConfig.path,
      selectedConfig,
      diagnostics: [
        createRuntimeConfigDiagnostic(
          'error',
          'runtime_config_missing',
          `Runtime config file does not exist: ${selectedConfig.path}.`,
        ),
      ],
    });
  }

  const document = readProject02RuntimeConfigDocument(
    selectedConfig.canonicalPath,
  );

  if (document.status === 'rejected') {
    return registerSelectedLoadedProject02RuntimeConfigSnapshot({
      source: selectedConfig.source,
      path: selectedConfig.path,
      selectedConfig,
      diagnostics: [document.diagnostic],
    });
  }

  const accepted = validateProject02RuntimeConfig(document.value);

  return registerSelectedLoadedProject02RuntimeConfigSnapshot({
    source: selectedConfig.source,
    path: selectedConfig.path,
    selectedConfig,
    ...(accepted.authoredDocument === undefined
      ? {}
      : {authoredDocument: accepted.authoredDocument}),
    ...(accepted.config === undefined ? {} : {config: accepted.config}),
    diagnostics: accepted.diagnostics,
  });
}

function registerSelectedLoadedProject02RuntimeConfigSnapshot(
  loadedConfig: SelectedLoadedProject02RuntimeConfig,
): SelectedLoadedProject02RuntimeConfig {
  const snapshot = Object.freeze(loadedConfig);

  selectedLoadedProject02RuntimeConfigSnapshots.add(snapshot);
  return snapshot;
}

/** Only the loader's exact snapshot: a clone loses the selection event. */
export function requireSelectedLoadedProject02RuntimeConfigSnapshot(
  value: unknown,
): SelectedLoadedProject02RuntimeConfig {
  if (
    typeof value === 'object' &&
    value !== null &&
    selectedLoadedProject02RuntimeConfigSnapshots.has(value)
  ) {
    return value as SelectedLoadedProject02RuntimeConfig;
  }

  throw new TypeError(
    'Runtime config location requires the exact selected snapshot returned by the runtime config loader.',
  );
}

function snapshotAuthoredRuntimeConfigDocument(value: unknown):
  | {
      readonly status: 'accepted';
      readonly document?: JsonBoundaryObject;
    }
  | {
      readonly status: 'rejected';
      readonly diagnostic: RuntimeConfigDiagnostic;
    } {
  if (!isJsonRecord(value)) {
    return {status: 'accepted'};
  }

  try {
    return {
      status: 'accepted',
      document: createJsonBoundaryObjectSnapshot(value, {
        field: 'Runtime config',
        limits: runtimeConfigJsonBoundaryLimits,
      }),
    };
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      return {
        status: 'rejected',
        diagnostic: runtimeConfigLimitDiagnostic(
          `Runtime config exceeds safe JSON limits: ${error.message}`,
        ),
      };
    }

    throw error;
  }
}

/** Existence checks stay with callers: absence means different things. */
export function readProject02RuntimeConfigDocument(path: string):
  | {readonly status: 'accepted'; readonly value: unknown}
  | {
      readonly status: 'rejected';
      readonly diagnostic: RuntimeConfigDiagnostic;
    } {
  const read = readBoundedJsonFileSource({
    path,
    maxBytes: maxProject02RuntimeConfigBytes,
  });

  if (read.status === 'rejected') {
    return {
      status: 'rejected',
      diagnostic: runtimeConfigSourceDiagnostic(read.reason, path),
    };
  }

  try {
    return {
      status: 'accepted',
      value: JSON.parse(read.source) as unknown,
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

function runtimeConfigSourceDiagnostic(
  reason: BoundedJsonFileSourceRejectionReason,
  path: string,
): RuntimeConfigDiagnostic {
  switch (reason) {
    case 'uninspectable':
      return createRuntimeConfigDiagnostic(
        'error',
        'runtime_config_read_failed',
        `Runtime config file could not be inspected: ${path}.`,
      );
    case 'not_file':
      return createRuntimeConfigDiagnostic(
        'error',
        'runtime_config_read_failed',
        `Runtime config path is not a regular file: ${path}.`,
      );
    case 'too_large':
      return runtimeConfigLimitDiagnostic(
        `Runtime config file exceeds the ${String(maxProject02RuntimeConfigBytes)}-byte size limit.`,
      );
    case 'unreadable':
      return createRuntimeConfigDiagnostic(
        'error',
        'runtime_config_read_failed',
        `Runtime config file could not be read: ${path}.`,
      );
  }
}

export function validateProject02RuntimeConfig(
  value: unknown,
): Project02RuntimeConfigValidationResult {
  const authoredDocument = snapshotAuthoredRuntimeConfigDocument(value);

  if (authoredDocument.status === 'rejected') {
    return Object.freeze({
      diagnostics: Object.freeze([authoredDocument.diagnostic]),
    });
  }

  let accepted: ReturnType<typeof parseProject02RuntimeConfig>;

  try {
    accepted = parseProject02RuntimeConfig(authoredDocument.document ?? value);
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
    ...(authoredDocument.document === undefined
      ? {}
      : {authoredDocument: authoredDocument.document}),
    ...(accepted.config === undefined ? {} : {config: accepted.config}),
    diagnostics: Object.freeze([...accepted.diagnostics]),
  } satisfies Project02RuntimeConfigValidationResult);
}

function defaultRuntimeConfigPath(storeRoot?: string): string {
  return createProject02HomeLayout(
    storeRoot === undefined ? {} : {homeRoot: storeRoot},
  ).configPath;
}

export function defaultRuntimeConfigEnvPath(storeRoot?: string): string {
  return createProject02HomeLayout(
    storeRoot === undefined ? {} : {homeRoot: storeRoot},
  ).envPath;
}

export function selectProject02RuntimeConfigLocation(options: {
  readonly selection: {
    readonly configPath?: string;
    readonly storeRoot?: string;
  };
  readonly env: NodeJS.ProcessEnv;
}): SelectedProject02RuntimeConfigLocation {
  if (options.selection.configPath !== undefined) {
    return createSelectedRuntimeConfigLocation(
      'path',
      normalizeConfigPath(options.selection.configPath),
      options.selection.storeRoot,
    );
  }

  if (options.selection.storeRoot !== undefined) {
    return createSelectedRuntimeConfigLocation(
      'default',
      defaultRuntimeConfigPath(options.selection.storeRoot),
    );
  }

  const envPath = options.env[runtimeConfigEnvVarName];

  if (envPath !== undefined && envPath.trim().length > 0) {
    return createSelectedRuntimeConfigLocation(
      'env',
      normalizeConfigPath(envPath),
    );
  }

  return createSelectedRuntimeConfigLocation(
    'default',
    defaultRuntimeConfigPath(options.selection.storeRoot),
  );
}

/** Selection, re-binding, and home resolution are location boundaries. */
export function canonicalRuntimeConfigLocationPath(path: string): string {
  return canonicalRuntimeConfigPath(
    path,
    cause => new RuntimeConfigLocationError(cause.message),
  );
}

function createSelectedRuntimeConfigLocation(
  source: Exclude<RuntimeConfigSource, 'none'>,
  path: string,
  runtimeHomeRoot?: string,
): SelectedProject02RuntimeConfigLocation {
  const canonicalPath = canonicalRuntimeConfigLocationPath(path);
  const normalizedRuntimeHomeRoot =
    runtimeHomeRoot === undefined
      ? undefined
      : normalizeSelectedRuntimeHomeRoot(runtimeHomeRoot);
  const owner: SelectedProject02RuntimeConfigOwner =
    source === 'default'
      ? Object.freeze({
          kind: 'home',
          homeRoot: canonicalRuntimeConfigHomeRoot(dirname(path)),
        })
      : Object.freeze({kind: 'standalone'});
  const selectedHomeRoot =
    owner.kind === 'home' ? owner.homeRoot : normalizedRuntimeHomeRoot;

  assertRuntimeConfigGlobalTargetAdmitted({
    displayPath: path,
    canonicalPath,
    ...(selectedHomeRoot === undefined ? {} : {selectedHomeRoot}),
  });

  const selectedConfig = Object.freeze({
    source,
    path,
    canonicalPath,
    owner,
    ...(normalizedRuntimeHomeRoot === undefined
      ? {}
      : {runtimeHomeRoot: normalizedRuntimeHomeRoot}),
  });

  selectedProject02RuntimeConfigLocations.add(selectedConfig);
  return selectedConfig;
}

export function canonicalRuntimeConfigHomeRoot(homeRoot?: string): string {
  return canonicalRuntimeConfigLocationPath(
    createProject02HomeLayout(homeRoot === undefined ? {} : {homeRoot})
      .homeRoot,
  );
}

function normalizeSelectedRuntimeHomeRoot(homeRoot: string): string {
  return canonicalRuntimeConfigHomeRoot(homeRoot);
}

function requireSelectedProject02RuntimeConfigLocation(
  value: unknown,
): SelectedProject02RuntimeConfigLocation {
  if (
    typeof value === 'object' &&
    value !== null &&
    selectedProject02RuntimeConfigLocations.has(value)
  ) {
    return value as SelectedProject02RuntimeConfigLocation;
  }

  throw new TypeError(
    'Selected runtime config location must come from runtime config selection.',
  );
}

export function assertSelectedRuntimeConfigStillBound(
  selectedConfig: SelectedProject02RuntimeConfigLocation,
): void {
  selectedConfig =
    requireSelectedProject02RuntimeConfigLocation(selectedConfig);
  const currentCanonicalPath = canonicalRuntimeConfigLocationPath(
    selectedConfig.path,
  );

  if (currentCanonicalPath !== selectedConfig.canonicalPath) {
    throw new RuntimeConfigLocationError(
      `Selected runtime config path "${selectedConfig.path}" now names another file. Resolve a fresh runtime location before retrying.`,
    );
  }

  const selectedHomeRoot = selectedRuntimeConfigHomeRoot(selectedConfig);

  assertRuntimeConfigGlobalTargetAdmitted({
    displayPath: selectedConfig.path,
    canonicalPath: selectedConfig.canonicalPath,
    ...(selectedHomeRoot === undefined ? {} : {selectedHomeRoot}),
  });
}

function selectedRuntimeConfigHomeRoot(
  selectedConfig: SelectedProject02RuntimeConfigLocation,
): string | undefined {
  return selectedConfig.owner.kind === 'home'
    ? selectedConfig.owner.homeRoot
    : selectedConfig.runtimeHomeRoot;
}

function assertRuntimeConfigGlobalTargetAdmitted(options: {
  readonly displayPath: string;
  readonly canonicalPath: string;
  readonly selectedHomeRoot?: string;
}): void {
  if (
    !isProject02CharacterDataOwnedPath({
      canonicalPath: options.canonicalPath,
      ...(options.selectedHomeRoot === undefined
        ? {}
        : {selectedHomeRoot: options.selectedHomeRoot}),
    })
  ) {
    return;
  }

  throw new RuntimeConfigLocationError(
    `Runtime config path "${options.displayPath}" is inside a character-data directory. ` +
      'Use --store with --character to select a character overlay.',
  );
}

function parseProject02RuntimeConfig(value: unknown): {
  readonly config?: Project02RuntimeConfig;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
} {
  const diagnostics: RuntimeConfigDiagnostic[] = [];

  if (!isJsonRecord(value)) {
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

  if (!isJsonRecord(value)) {
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
      !project02RuntimeConfigFieldAcceptsValue(fieldValue, field)
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

  if (!isJsonRecord(value)) {
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
        if (!isJsonRecord(pluginValue)) {
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

  if (!isJsonRecord(value)) {
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

  if (!isJsonRecord(value)) {
    return false;
  }

  if (secretEnvMarkerField in value) {
    return (
      hasOnlyFields(value, runtimeConfigSecretRefFields) &&
      typeof value[secretEnvMarkerField] === 'string' &&
      value[secretEnvMarkerField].trim().length > 0
    );
  }

  if (plaintextSecretMarkerField in value) {
    return (
      hasOnlyFields(value, runtimeConfigPlaintextSecretOverrideFields) &&
      typeof value[plaintextSecretMarkerField] === 'string' &&
      value[allowPlaintextSecretMarkerField] === true &&
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
