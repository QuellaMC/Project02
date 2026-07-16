import {
  applyRuntimeConfigMutation,
  createRuntimeConfigMutationBase,
  type RuntimeConfigMutationResult
} from './mutate.ts';
import {
  createProject02RuntimeConfigFingerprint,
  stableStringify
} from './fingerprint.ts';
import { createRuntimePluginConfigInspectShape } from './inspect.ts';
import { loadProject02RuntimeConfig } from './load.ts';
import { resolveProject02RuntimeConfig } from './resolve.ts';
import { runtimeConfigValueMatchesField } from './schema.ts';
import { redactRuntimeConfigValue } from './redact.ts';
import type {
  RuntimePluginConfigField,
  RuntimePluginManifest
} from '../../plugins/plugin-types.ts';
import type {
  Project02RuntimeConfig,
  RuntimeConfigMutationOperation,
  RuntimeConfigValue,
  RuntimePluginConfigActivationInspectShape,
  RuntimePluginConfigInspectShape
} from './types.ts';

export type RuntimeConfigControlOperation = RuntimeConfigMutationOperation;

export function applyRuntimeConfigControlOperation(options: {
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly expectedFingerprint?: string;
  readonly storeRoot?: string;
  readonly operation: RuntimeConfigControlOperation;
}): RuntimeConfigMutationResult {
  return applyRuntimeConfigMutation(options);
}

export type RuntimePluginConfigControlActor = 'operator' | 'agent';

export type RuntimePluginConfigFieldControlOperation =
  | {
      readonly kind: 'set';
      readonly fieldName: string;
      readonly value: RuntimeConfigValue;
    }
  | {
      readonly kind: 'unset';
      readonly fieldName: string;
    };

export function inspectRuntimePluginConfig(options: {
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly storeRoot?: string;
  readonly manifest: RuntimePluginManifest;
  readonly pluginManifests?: readonly RuntimePluginManifest[];
  readonly activation?: RuntimePluginConfigActivationInspectShape;
  readonly defaultEnabled?: boolean;
}): RuntimePluginConfigInspectShape {
  const loadedConfig = loadProject02RuntimeConfig({
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot })
  });
  const manifests = manifestsIncludingTarget(
    options.manifest,
    options.pluginManifests
  );
  const resolvedConfig = resolveProject02RuntimeConfig({
    loadedConfig,
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
    pluginManifests: manifests,
    validateInactivePluginConfigs: true,
    ...(options.env === undefined ? {} : { env: options.env })
  });
  const mutationBase = createRuntimeConfigMutationBase({
    loadedConfig,
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot })
  });

  return createRuntimePluginConfigInspectShape({
    loadedConfig,
    resolvedConfig,
    manifest: options.manifest,
    ...(options.activation === undefined
      ? {}
      : { activation: options.activation }),
    ...(options.defaultEnabled === undefined
      ? {}
      : { defaultEnabled: options.defaultEnabled }),
    fingerprint: createProject02RuntimeConfigFingerprint(mutationBase)
  });
}

export function applyRuntimePluginConfigControlOperation(options: {
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly storeRoot?: string;
  readonly manifest: RuntimePluginManifest;
  readonly actor: RuntimePluginConfigControlActor;
  readonly expectedFingerprint: string;
  readonly operation: RuntimePluginConfigFieldControlOperation;
}): RuntimeConfigMutationResult {
  const field = validateRuntimePluginConfigControlOperation(options);

  return applyRuntimeConfigMutation({
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
    expectedFingerprint: options.expectedFingerprint,
    validateCandidate: (config) => {
      assertRuntimePluginConfigCandidateValid({
        config,
        manifest: options.manifest,
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.storeRoot === undefined
          ? {}
          : { storeRoot: options.storeRoot })
      });
    },
    operation:
      options.operation.kind === 'set'
        ? {
            kind: 'plugin_config_set',
            pluginId: options.manifest.id,
            fieldName: field.name,
            value: options.operation.value
          }
        : {
            kind: 'plugin_config_unset',
            pluginId: options.manifest.id,
            fieldName: field.name
          }
  });
}

function assertRuntimePluginConfigCandidateValid(options: {
  readonly config: Project02RuntimeConfig;
  readonly manifest: RuntimePluginManifest;
  readonly env?: NodeJS.ProcessEnv;
  readonly storeRoot?: string;
}): void {
  const resolved = resolveProject02RuntimeConfig({
    loadedConfig: {
      source: 'path',
      config: options.config,
      diagnostics: Object.freeze([])
    },
    pluginManifests: [options.manifest],
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
    validateInactivePluginConfigs: true
  });
  const blockingDiagnostic = resolved.diagnostics.find(
    (diagnostic) =>
      diagnostic.severity === 'error' &&
      diagnostic.scope === 'plugin' &&
      diagnostic.pluginId === options.manifest.id
  );

  if (blockingDiagnostic !== undefined) {
    throw new TypeError(
      `Cannot update plugin config because the resulting config is invalid: ${blockingDiagnostic.message}`
    );
  }
}

export function validateRuntimePluginConfigControlOperation(options: {
  readonly manifest: RuntimePluginManifest;
  readonly actor: RuntimePluginConfigControlActor;
  readonly operation: RuntimePluginConfigFieldControlOperation;
}): RuntimePluginConfigField {
  const field = options.manifest.config.fields.find(
    (candidate) => candidate.name === options.operation.fieldName
  );

  if (field === undefined) {
    throw new TypeError(
      `Plugin "${options.manifest.id}" does not declare config field "${options.operation.fieldName}".`
    );
  }

  if (field.secret) {
    throw new TypeError(
      `Plugin config field "${field.name}" is secret and must be managed through the dedicated secret command.`
    );
  }

  if (options.actor === 'agent' && field.agentMutable !== true) {
    throw new TypeError(
      `Plugin config field "${field.name}" does not allow agent mutation.`
    );
  }

  if (options.operation.kind === 'unset' && field.required) {
    throw new TypeError(
      `Required plugin config field "${field.name}" cannot be unset.`
    );
  }

  if (
    options.operation.kind === 'set' &&
    (!runtimeConfigValueMatchesField(options.operation.value, field) ||
      runtimeConfigControlValueContainsSecret(options.operation.value) ||
      runtimeConfigControlValueRequiresRedaction(
        options.operation.value,
        field.name
      ))
  ) {
    throw new TypeError(
      `Plugin config field "${field.name}" does not match its declared metadata.`
    );
  }

  return field;
}

function runtimeConfigControlValueRequiresRedaction(
  value: RuntimeConfigValue,
  fieldName: string
): boolean {
  return (
    stableStringify(redactRuntimeConfigValue(value, { key: fieldName })) !==
    stableStringify(value)
  );
}

function manifestsIncludingTarget(
  target: RuntimePluginManifest,
  manifests: readonly RuntimePluginManifest[] | undefined
): readonly RuntimePluginManifest[] {
  const byId = new Map(
    (manifests ?? []).map((manifest) => [manifest.id, manifest] as const)
  );

  byId.set(target.id, target);
  return Object.freeze([...byId.values()]);
}

function runtimeConfigControlValueContainsSecret(
  value: RuntimeConfigValue
): boolean {
  if (Array.isArray(value)) {
    return value.some(runtimeConfigControlValueContainsSecret);
  }

  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if ('$env' in value || '$plaintextSecret' in value) {
    return true;
  }

  return Object.values(value).some(runtimeConfigControlValueContainsSecret);
}
