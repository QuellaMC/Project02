import {createRuntimeConfigAuthoredSnapshot} from './mutate.ts';
import {layeredRuntimeConfigFingerprintForScope} from './fingerprint.ts';
import {readCharacterOverlayForScope} from './overlay.ts';
import {
  assertResolvedProject02HomeAdoptable,
  loadProject02RuntimeConfigForLocation,
  type ResolvedProject02RuntimeLocation,
} from './location.ts';
import {resolveLayeredProject02RuntimeConfigWithSnapshot} from './resolve-layered.ts';
import {canonicalJsonValuesEqual} from '../../shared/canonical-json.ts';
import {createRuntimePluginConfigInspectShape} from './inspect.ts';
import {resolveRuntimePluginConfigs} from './resolve.ts';
import {
  runtimeConfigFieldValueMismatchMessage,
  runtimeConfigValueMatchesField,
} from './schema.ts';
import {runtimePluginScopeViolation} from './plugin-scope.ts';
import {redactRuntimeConfigValue} from './redact.ts';
import type {
  RuntimePluginConfigField,
  RuntimePluginManifest,
} from '../../plugins/api/index.ts';
import type {
  Project02RuntimeConfig,
  RuntimeConfigMutationOperation,
  RuntimeConfigValue,
  RuntimePluginActivationStatusShape,
  RuntimePluginConfigInspectShape,
} from './types.ts';

export type RuntimeConfigControlOperation = Extract<
  RuntimeConfigMutationOperation,
  {
    readonly kind: 'set' | 'unset';
  }
>;

export function assertRuntimeConfigControlOperation(
  operation: RuntimeConfigMutationOperation,
): asserts operation is RuntimeConfigControlOperation {
  switch (operation.kind) {
    case 'set':
    case 'unset':
      return;
    case 'plugin_enable':
    case 'plugin_disable':
      throw new TypeError(
        'Plugin activation must be changed through manifest-aware control.',
      );
    case 'plugin_config_set':
    case 'plugin_config_unset':
      throw new TypeError(
        'Plugin config fields must be changed through manifest-aware control.',
      );
  }
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
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  /** The one document this inspection's control operation can mutate. */
  readonly targetScope: 'global' | 'character';
  readonly manifest: RuntimePluginManifest;
  readonly pluginManifests?: readonly RuntimePluginManifest[];
  readonly activation?: RuntimePluginActivationStatusShape;
  readonly defaultEnabled?: boolean;
}): RuntimePluginConfigInspectShape {
  assertResolvedProject02HomeAdoptable(options.runtimeLocation);
  const loadedConfig = loadProject02RuntimeConfigForLocation(
    options.runtimeLocation,
  );
  const characterScope = options.runtimeLocation.characterScope;
  // A rebound data directory must not feed an overlay into model-visible config.
  const overlayConfig = readCharacterOverlayForScope(characterScope).overlay;
  const manifests = manifestsIncludingTarget(
    options.manifest,
    options.pluginManifests,
  );
  const {layeredConfig, resolvedConfig} =
    resolveLayeredProject02RuntimeConfigWithSnapshot({
      loadedConfig,
      runtimeLocation: options.runtimeLocation,
      overlayConfig,
      pluginManifests: manifests,
      validateInactivePluginConfigs: true,
    });
  const mutationBase =
    createRuntimeConfigAuthoredSnapshot(loadedConfig).document;

  return createRuntimePluginConfigInspectShape({
    layeredConfig,
    targetScope: options.targetScope,
    pluginResolution: resolvedConfig,
    manifest: options.manifest,
    ...(options.activation === undefined
      ? {}
      : {activation: options.activation}),
    ...(options.defaultEnabled === undefined
      ? {}
      : {defaultEnabled: options.defaultEnabled}),
    fingerprint: layeredRuntimeConfigFingerprintForScope({
      globalConfig: mutationBase,
      characterScope,
      overlay: overlayConfig,
      pluginManifests: manifests,
    }),
  });
}

export function runtimePluginConfigControlMutation(options: {
  readonly manifest: RuntimePluginManifest;
  readonly actor: RuntimePluginConfigControlActor;
  readonly operation: RuntimePluginConfigFieldControlOperation;
  readonly authoredScope?: 'global' | 'character';
}): {
  readonly operation: RuntimeConfigMutationOperation;
  readonly validateCandidate: (config: Project02RuntimeConfig) => void;
} {
  const scopeViolation = runtimePluginScopeViolation({
    manifest: options.manifest,
    authoredScope: options.authoredScope ?? 'global',
    operation: {
      kind: 'field',
      fieldName: fieldNameOf(options.operation),
    },
  });

  if (scopeViolation !== undefined) {
    throw new TypeError(scopeViolation.message);
  }

  const field = validateRuntimePluginConfigControlOperation(options);

  return {
    operation: runtimePluginConfigMutationOperation(options.operation, {
      pluginId: options.manifest.id,
      fieldName: field.name,
    }),
    validateCandidate: config => {
      assertRuntimePluginConfigCandidateValid({
        config,
        manifest: options.manifest,
        operation: options.operation,
      });
    },
  };
}

function fieldNameOf(
  operation: RuntimePluginConfigFieldControlOperation,
): string {
  return operation.fieldName;
}

function runtimePluginConfigMutationOperation(
  operation: RuntimePluginConfigFieldControlOperation,
  target: {
    readonly pluginId: string;
    readonly fieldName: string;
  },
): RuntimeConfigMutationOperation {
  switch (operation.kind) {
    case 'set':
      return {
        kind: 'plugin_config_set',
        ...target,
        value: operation.value,
      };
    case 'unset':
      return {
        kind: 'plugin_config_unset',
        ...target,
      };
  }
}

function assertRuntimePluginConfigCandidateValid(options: {
  readonly config: Project02RuntimeConfig;
  readonly manifest: RuntimePluginManifest;
  readonly operation: RuntimePluginConfigFieldControlOperation;
}): void {
  const resolved = resolveRuntimePluginConfigs({
    config: options.config,
    pluginManifests: [options.manifest],
    skipPluginScopeValidation: true,
    validateInactivePluginConfigs: true,
  });
  const blockingDiagnostic = resolved.diagnostics.find(
    diagnostic =>
      diagnostic.severity === 'error' &&
      diagnostic.scope === 'plugin' &&
      diagnostic.pluginId === options.manifest.id,
  );

  if (blockingDiagnostic !== undefined) {
    throw new TypeError(
      `Cannot update plugin config because the resulting config is invalid: ${blockingDiagnostic.message}`,
    );
  }
}

export function validateRuntimePluginConfigControlOperation(options: {
  readonly manifest: RuntimePluginManifest;
  readonly actor: RuntimePluginConfigControlActor;
  readonly operation: RuntimePluginConfigFieldControlOperation;
}): RuntimePluginConfigField {
  const field = options.manifest.config.fields.find(
    candidate => candidate.name === options.operation.fieldName,
  );

  if (field === undefined) {
    const declaredFieldNames = options.manifest.config.fields
      .map(candidate => candidate.name)
      .join(', ');

    throw new TypeError(
      `Plugin "${options.manifest.id}" does not declare config field "${options.operation.fieldName}". ` +
        `Declared fields: ${declaredFieldNames.length === 0 ? 'none' : declaredFieldNames}.`,
    );
  }

  // A secret is the operator's alone: the model never reads one back, so
  // it never writes one either.
  if (field.secret && options.actor !== 'operator') {
    throw new TypeError(
      `Plugin config field "${field.name}" is secret; only an operator may change it.`,
    );
  }

  if (options.actor === 'agent' && field.agentMutable !== true) {
    throw new TypeError(
      `Plugin config field "${field.name}" does not allow agent mutation.`,
    );
  }

  if (options.operation.kind === 'unset' && field.required) {
    throw new TypeError(
      `Required plugin config field "${field.name}" cannot be unset.`,
    );
  }

  if (options.operation.kind === 'set') {
    if (!runtimeConfigValueMatchesField(options.operation.value, field)) {
      throw new TypeError(
        runtimeConfigFieldValueMismatchMessage(field, options.operation.value),
      );
    }

    // A secret field holds a credential by declaration; a plain field
    // must not be handed one by its name.
    if (
      !field.secret &&
      runtimeConfigControlValueRequiresRedaction(
        options.operation.value,
        field.name,
      )
    ) {
      throw new TypeError(
        `Plugin config field "${field.name}" value contains content that must stay redacted and cannot be written.`,
      );
    }
  }

  return field;
}

function runtimeConfigControlValueRequiresRedaction(
  value: RuntimeConfigValue,
  fieldName: string,
): boolean {
  return !canonicalJsonValuesEqual(
    redactRuntimeConfigValue(value, {key: fieldName}),
    value,
  );
}

function manifestsIncludingTarget(
  target: RuntimePluginManifest,
  manifests: readonly RuntimePluginManifest[] | undefined,
): readonly RuntimePluginManifest[] {
  const byId = new Map(
    (manifests ?? []).map(manifest => [manifest.id, manifest] as const),
  );

  byId.set(target.id, target);
  return Object.freeze([...byId.values()]);
}
