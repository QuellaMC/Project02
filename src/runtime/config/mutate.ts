import {dirname} from 'node:path';

import {pathExistsSync} from '../../shared/file-system.ts';

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
import {ensureInitializedProject02Home} from '../storage/home.ts';
import {
  createProject02HomeLayout,
  type Project02HomeLayout,
} from '../storage/layout-contract.ts';
import {
  acquireLocalRuntimeMutationLock,
  type LocalRuntimeMutationLockTarget,
} from '../storage/mutation-lock.ts';
import {
  runtimeConfigDiagnosticLocation,
  runtimeConfigVersion,
  type LoadedProject02RuntimeConfig,
  type Project02RuntimeConfig,
  type RuntimeConfigDiagnostic,
  type RuntimeConfigMutationOperation,
  type RuntimeConfigSectionNamespace,
  type RuntimeConfigValue,
} from './types.ts';
import {validateProject02RuntimeConfig} from './load.ts';
import {redactRuntimeConfigValue} from './redact.ts';
import {canonicalRuntimeConfigPath, runtimeConfigSectionPath} from './path.ts';
import {
  type Project02ConfigFieldDefinition,
  project02RuntimeConfigFieldAcceptsValue,
  project02RuntimeConfigFieldDefinition,
} from './schema.ts';

export type RuntimeConfigMutationResult = {
  readonly configPath: string;
  readonly config: Project02RuntimeConfig;
  readonly fingerprint: string;
};

export type PreparedRuntimeConfigMutationCandidate = {
  readonly config: Project02RuntimeConfig;
};

/** Keyed by canonical path so two spellings of one file take one lock. */
export function runtimeConfigControlFileLockTarget(
  canonicalPath: string,
): LocalRuntimeMutationLockTarget {
  return Object.freeze({
    locksRoot: createProject02HomeLayout({homeRoot: dirname(canonicalPath)})
      .locksRoot,
    resourceKey: `runtime-control-file:${canonicalPath}`,
  });
}

/** The caller must hold the locks: this never resolves, locks, or retries. */
export function commitPreparedRuntimeConfigMutation(options: {
  readonly canonicalConfigPath: string;
  readonly displayConfigPath: string;
  readonly preparedCandidate: PreparedRuntimeConfigMutationCandidate;
}): void {
  try {
    cleanupAbandonedAtomicReplacementFilesSync(options.canonicalConfigPath);
  } catch (error: unknown) {
    throw mutationFileAccessError(
      `Could not write runtime config file at ${options.displayConfigPath}.`,
      error,
    );
  }

  writeJsonAtomic(
    options.canonicalConfigPath,
    options.preparedCandidate.config,
    0o600,
  );
}

export class RuntimeConfigMutationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RuntimeConfigMutationError';
  }
}

export class RuntimeConfigConflictError extends RuntimeConfigMutationError {
  // Plugins detect conflicts by this code instead of importing the class.
  // Keep in sync with runtimeConfigConflictErrorCode.
  readonly code = 'runtime_config_conflict';

  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigConflictError';
  }
}

function bootstrapRuntimeConfig(): Project02RuntimeConfig {
  return {version: runtimeConfigVersion};
}

/**
 * The one birth of a store: idempotent, and an existing config is never
 * replaced. Absence is decided under the lock, or a concurrent write is lost.
 */
export async function ensureInitializedProject02Store(options: {
  readonly homeRoot?: string;
}): Promise<Project02HomeLayout> {
  const layout = await ensureInitializedProject02Home(options);

  if (pathExistsSync(layout.configPath)) {
    return layout;
  }

  const lock = await acquireLocalRuntimeMutationLock(
    runtimeConfigControlFileLockTarget(
      canonicalRuntimeConfigMutationPath(layout.configPath),
    ),
  );

  try {
    if (!pathExistsSync(layout.configPath)) {
      writeJsonAtomic(layout.configPath, bootstrapRuntimeConfig(), 0o600);
    }
  } finally {
    await lock.release();
  }

  return layout;
}

export type RuntimeConfigAuthoredSnapshot = Readonly<{
  /** Exact readable authored JSON, or the one bootstrap document if absent. */
  document: JsonBoundaryObject;
  /** Present only when that document is already schema-valid. */
  validatedConfig?: Project02RuntimeConfig;
}>;

/** One authored layer, global or overlay, as the mutation seam sees it. */
export type AuthoredRuntimeConfigLayer = {
  readonly authoredDocument?: JsonBoundaryObject;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
};

/**
 * The one blocking rule for an authored layer: an error other than a missing
 * file. `authoredBytesUnblock` says whether readable bytes make it editable
 * anyway — true for the layer being written, false for a layer merely read.
 */
export function blockingRuntimeConfigLayerDiagnostic(
  layer: AuthoredRuntimeConfigLayer,
  authoredBytesUnblock = true,
): RuntimeConfigDiagnostic | undefined {
  if (authoredBytesUnblock && layer.authoredDocument !== undefined) {
    return undefined;
  }

  return layer.diagnostics.find(
    diagnostic =>
      diagnostic.severity === 'error' &&
      diagnostic.code !== 'runtime_config_missing',
  );
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

  const validatedConfig = bootstrapRuntimeConfig();

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

/** A host field's authored value, redacted by its key; the field inspection is its reader. */
export function getRedactedRuntimeConfigValueAtPath(
  config: Project02RuntimeConfig | undefined,
  path: string,
): RuntimeConfigValue | undefined {
  const parts = parseConfigPath(path);

  if (parts[0] !== 'project02' || parts.length !== 2) {
    throw new TypeError(`Unsupported runtime config path: ${path}.`);
  }

  const name = parts[1] ?? '';
  const value = project02ConfigValue(config, name);

  return value === undefined
    ? undefined
    : redactRuntimeConfigValue(value, {
        key: name,
        secret: project02RuntimeConfigFieldDefinition(name)?.secret === true,
      });
}

function project02ConfigValue(
  config: Project02RuntimeConfig | undefined,
  field: string | undefined,
): RuntimeConfigValue | undefined {
  return field === undefined
    ? undefined
    : ownJsonRecordValue(config?.project02, field);
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
    case 'section_enable':
      return setSectionEnabled(config, operation.namespace, operation.id, true);
    case 'section_disable':
      return setSectionEnabled(
        config,
        operation.namespace,
        operation.id,
        false,
      );
    case 'section_activation_clear':
      return clearSectionEnabled(config, operation.namespace, operation.id);
    case 'section_field_set':
      return setSectionField(
        config,
        operation.namespace,
        operation.id,
        operation.fieldName,
        operation.value,
      );
    case 'section_field_unset':
      return unsetSectionField(
        config,
        operation.namespace,
        operation.id,
        operation.fieldName,
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
      'Cannot mutate runtime config because the mutation would produce ' +
        `invalid config: ${blockingDiagnostic.message} ` +
        `(${runtimeConfigDiagnosticLocation(blockingDiagnostic)})`,
    );
  }

  if (accepted.config === undefined) {
    throw new TypeError(
      'Cannot mutate runtime config because the mutation would produce empty config.',
    );
  }

  return accepted.config;
}

function setSectionEnabled(
  config: JsonBoundaryObject,
  namespace: RuntimeConfigSectionNamespace,
  id: string,
  enabled: boolean,
): JsonBoundaryObject {
  const sections = authoredObjectValue(config[namespace], namespace) ?? {};
  const currentSection =
    authoredObjectValue(
      ownJsonRecordValue(sections, id),
      runtimeConfigSectionPath(namespace, id),
    ) ?? {};
  const nextSections = {...sections};

  nextSections[id] = freezeJsonObject({
    ...currentSection,
    enabled,
  });

  return freezeJsonObject({
    ...config,
    [namespace]: freezeJsonObject(nextSections),
  });
}

/** Removes the authored flag, leaving the rest of the section's entry. */
function clearSectionEnabled(
  config: JsonBoundaryObject,
  namespace: RuntimeConfigSectionNamespace,
  id: string,
): JsonBoundaryObject {
  const sections = authoredObjectValue(config[namespace], namespace) ?? {};
  const currentSection = authoredObjectValue(
    ownJsonRecordValue(sections, id),
    runtimeConfigSectionPath(namespace, id),
  );

  if (currentSection === undefined) {
    return config;
  }

  const {enabled: removedEnabled, ...rest} = currentSection;
  const nextSections = {...sections};

  void removedEnabled;
  nextSections[id] = freezeJsonObject(rest);

  return freezeJsonObject({
    ...config,
    [namespace]: freezeJsonObject(nextSections),
  });
}

function setSectionField(
  config: JsonBoundaryObject,
  namespace: RuntimeConfigSectionNamespace,
  id: string,
  fieldName: string,
  value: RuntimeConfigValue,
): JsonBoundaryObject {
  const sectionPath = runtimeConfigSectionPath(namespace, id);
  const sections = authoredObjectValue(config[namespace], namespace) ?? {};
  const currentSection =
    authoredObjectValue(ownJsonRecordValue(sections, id), sectionPath) ?? {};
  const currentFields =
    authoredObjectValue(
      ownJsonRecordValue(currentSection, 'config'),
      `${sectionPath}.config`,
    ) ?? {};
  const nextSections = {...sections};

  nextSections[id] = freezeJsonObject({
    ...currentSection,
    config: freezeJsonObject({
      ...currentFields,
      [fieldName]: snapshotMutationValue(
        value,
        runtimeConfigSectionPath(namespace, id, fieldName),
      ),
    }),
  });

  return freezeJsonObject({
    ...config,
    [namespace]: freezeJsonObject(nextSections),
  });
}

function unsetSectionField(
  config: JsonBoundaryObject,
  namespace: RuntimeConfigSectionNamespace,
  id: string,
  fieldName: string,
): JsonBoundaryObject {
  const sectionPath = runtimeConfigSectionPath(namespace, id);
  const sections = authoredObjectValue(config[namespace], namespace);
  const currentSectionValue =
    sections === undefined ? undefined : ownJsonRecordValue(sections, id);

  if (currentSectionValue === undefined) {
    return config;
  }

  const currentSection = requiredAuthoredObjectValue(
    currentSectionValue,
    sectionPath,
  );
  const currentFields = authoredObjectValue(
    ownJsonRecordValue(currentSection, 'config'),
    `${sectionPath}.config`,
  );

  if (
    currentFields === undefined ||
    ownJsonRecordValue(currentFields, fieldName) === undefined
  ) {
    return config;
  }

  const nextFields = jsonObjectWithout(currentFields, fieldName);
  const nextSection = jsonObjectWithout(currentSection, 'config');

  if (Object.keys(nextFields).length > 0) {
    nextSection['config'] = freezeJsonObject(nextFields);
  }

  return setOrDeleteSection(
    config,
    namespace,
    sections ?? {},
    id,
    freezeJsonObject(nextSection),
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
  if (!project02RuntimeConfigFieldAcceptsValue(value, field)) {
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

/** Preparing, locking, and committing a write are mutation boundaries. */
export function canonicalRuntimeConfigMutationPath(path: string): string {
  return canonicalRuntimeConfigPath(
    path,
    cause => new RuntimeConfigMutationError(cause.message, {cause}),
  );
}

export function mutationFileAccessError(
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

function setOrDeleteSection(
  config: JsonBoundaryObject,
  namespace: RuntimeConfigSectionNamespace,
  sections: JsonBoundaryObject,
  id: string,
  section: JsonBoundaryObject,
): JsonBoundaryObject {
  const nextSections = {...sections};

  if (Object.keys(section).length === 0) {
    return freezeConfigWithSections(
      config,
      namespace,
      jsonObjectWithout(sections, id),
    );
  }

  nextSections[id] = section;
  return freezeConfigWithSections(
    config,
    namespace,
    freezeJsonObject(nextSections),
  );
}

function freezeConfigWithSections(
  config: JsonBoundaryObject,
  namespace: RuntimeConfigSectionNamespace,
  sections: JsonBoundaryObject,
): JsonBoundaryObject {
  const sectionEntries = Object.entries(sections);

  if (sectionEntries.length > 0) {
    return freezeJsonObject({
      ...config,
      [namespace]: sections,
    });
  }

  return freezeJsonObject(jsonObjectWithout(config, namespace));
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
