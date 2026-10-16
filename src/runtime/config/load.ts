import {isJsonRecord} from '../../shared/json-boundary.ts';
import {pathExistsSync} from '../../shared/file-system.ts';
import {
  readBoundedJsonFileSource,
  type BoundedJsonFileSourceRejectionReason,
} from '../../shared/package-metadata.ts';
import {createProject02HomeLayout} from '../storage/layout-contract.ts';
import {isProject02CharacterDataOwnedPath} from '../storage/character-data.ts';
import {
  runtimeConfigSectionNamespaces,
  runtimeConfigVersion,
  type LoadedProject02RuntimeConfig,
  type Project02HostConfig,
  type Project02RuntimeConfig,
  type Project02RuntimeSectionConfig,
  type RuntimeConfigDiagnostic,
  type RuntimeConfigDiagnosticSectionMetadata,
  type RuntimeConfigSectionMap,
  type RuntimeConfigSectionNamespace,
  type RuntimeConfigValue,
} from './types.ts';
import {
  createJsonBoundaryObjectSnapshot,
  createJsonBoundarySnapshot,
  defaultJsonBoundaryLimits,
  type JsonBoundaryObject,
  type JsonBoundaryLimits,
} from '../../shared/json-boundary.ts';
import {canonicalRuntimeConfigPath, runtimeConfigSectionPath} from './path.ts';
import {unknownConnectorDiagnostics} from './connectors.ts';
import {createRuntimeConfigDiagnostic} from './diagnostic.ts';
import {
  project02RuntimeConfigFieldAcceptsValue,
  project02RuntimeConfigFieldDefinitions,
  project02RuntimeConfigFieldNames,
} from './schema.ts';

const project02RuntimeConfigFields = Object.freeze([
  'version',
  'project02',
  ...runtimeConfigSectionNamespaces,
]);
const project02HostConfigFields = project02RuntimeConfigFieldNames();
const project02RuntimeSectionConfigFields = Object.freeze([
  'enabled',
  'config',
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

/** Existence is decided here: an absent file is a valid empty config. */
export function loadProject02RuntimeConfigDocumentAt(location: {
  readonly path: string;
  readonly canonicalPath: string;
}): LoadedProject02RuntimeConfig {
  if (!pathExistsSync(location.canonicalPath)) {
    return Object.freeze({
      source: 'none',
      path: location.path,
      diagnostics: Object.freeze([]),
    } satisfies LoadedProject02RuntimeConfig);
  }

  const document = readProject02RuntimeConfigDocument(location.canonicalPath);

  if (document.status === 'rejected') {
    return Object.freeze({
      source: 'path',
      path: location.path,
      diagnostics: Object.freeze([document.diagnostic]),
    } satisfies LoadedProject02RuntimeConfig);
  }

  const accepted = validateProject02RuntimeConfig(document.value);

  return Object.freeze({
    source: 'path',
    path: location.path,
    ...(accepted.authoredDocument === undefined
      ? {}
      : {authoredDocument: accepted.authoredDocument}),
    ...(accepted.config === undefined ? {} : {config: accepted.config}),
    diagnostics: accepted.diagnostics,
  } satisfies LoadedProject02RuntimeConfig);
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

/** Selection, re-binding, and home resolution are location boundaries. */
export function canonicalRuntimeConfigLocationPath(path: string): string {
  return canonicalRuntimeConfigPath(
    path,
    cause => new RuntimeConfigLocationError(cause.message),
  );
}

export function canonicalRuntimeConfigHomeRoot(homeRoot?: string): string {
  return canonicalRuntimeConfigLocationPath(
    createProject02HomeLayout(homeRoot === undefined ? {} : {homeRoot})
      .homeRoot,
  );
}

export function assertRuntimeConfigGlobalTargetAdmitted(options: {
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
  let sections: Partial<
    RuntimeConfigSectionMap<Project02RuntimeSectionConfig>
  > = {};

  for (const namespace of runtimeConfigSectionNamespaces) {
    const configs = optionalSectionConfigs(
      namespace,
      value[namespace],
      diagnostics,
    );

    if (configs !== undefined) {
      sections = {...sections, [namespace]: configs};
    }
  }

  diagnostics.push(...unknownConnectorDiagnostics(sections));

  if (diagnostics.some(item => item.severity === 'error')) {
    return {
      diagnostics,
    };
  }

  return {
    config: Object.freeze({
      version: runtimeConfigVersion,
      ...(project02 === undefined ? {} : {project02}),
      ...sections,
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

function optionalSectionConfigs(
  namespace: RuntimeConfigSectionNamespace,
  value: unknown,
  diagnostics: RuntimeConfigDiagnostic[],
): Readonly<Record<string, Project02RuntimeSectionConfig>> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isJsonRecord(value)) {
    diagnostics.push(
      createRuntimeConfigDiagnostic(
        'error',
        `runtime_config_${namespace}_not_object`,
        `Runtime config ${namespace} must be an object.`,
        namespace,
      ),
    );
    return undefined;
  }

  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).flatMap(([id, sectionValue]) => {
        const path = runtimeConfigSectionPath(namespace, id);

        if (!isJsonRecord(sectionValue)) {
          diagnostics.push(
            createRuntimeConfigDiagnostic(
              'error',
              'runtime_config_plugin_not_object',
              `Runtime config plugin "${id}" must be an object.`,
              path,
            ),
          );
          return [];
        }

        pushUnknownRuntimeSectionConfigFieldDiagnostics({
          namespace,
          id,
          path,
          value: sectionValue,
          diagnostics,
        });

        const enabled = optionalBoolean(
          sectionValue['enabled'],
          `${path}.enabled`,
          diagnostics,
        );
        const config = optionalConfigRecord(
          sectionValue['config'],
          `${path}.config`,
          diagnostics,
        );

        return [
          [
            id,
            Object.freeze({
              ...(enabled === undefined ? {} : {enabled}),
              ...(config === undefined ? {} : {config}),
            } satisfies Project02RuntimeSectionConfig),
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
              'Runtime config values must be JSON-compatible values.',
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

function pushUnknownRuntimeSectionConfigFieldDiagnostics(options: {
  readonly namespace: RuntimeConfigSectionNamespace;
  readonly id: string;
  readonly path: string;
  readonly value: Readonly<Record<string, unknown>>;
  readonly diagnostics: RuntimeConfigDiagnostic[];
}): void {
  pushUnknownFieldDiagnostics({
    value: options.value,
    allowedFields: project02RuntimeSectionConfigFields,
    diagnostics: options.diagnostics,
    code: 'runtime_config_unknown_plugin_wrapper_field',
    messageForField: field =>
      `Unknown plugin wrapper field "${field}" for plugin "${options.id}".`,
    pathForField: field => `${options.path}.${field}`,
    metadataForField: () => ({namespace: options.namespace, id: options.id}),
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
  ) => RuntimeConfigDiagnosticSectionMetadata;
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

  return Object.values(value).every(isRuntimeConfigValue);
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
