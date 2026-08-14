import {createRuntimeConfigAuthoredSnapshot} from './mutate.ts';
import {
  layeredRuntimeConfigFingerprintForScope,
  loadCharacterSecretsEnv,
  readCharacterOverlayForScope,
} from './overlay.ts';
import {
  assertResolvedProject02HomeAdoptable,
  loadProject02RuntimeConfigForLocation,
  type ResolvedProject02RuntimeLocation,
} from './location.ts';
import {
  resolveLayeredProject02RuntimeConfigWithSnapshot,
  runtimeConfigEnvWithCharacterSecrets,
} from './resolve-layered.ts';
import {canonicalJsonValuesEqual} from '../../shared/canonical-json.ts';
import {createRuntimePluginConfigInspectShape} from './inspect.ts';
import {resolveProject02RuntimeConfig} from './resolve.ts';
import {
  runtimeConfigFieldValueMismatchMessage,
  runtimeConfigValueMatchesField,
} from './schema.ts';
import {runtimePluginScopeViolation} from './plugin-scope.ts';
import {nestedSecretMarkerPath} from '../../shared/secret-marker.ts';
import {redactRuntimeConfigValue} from './redact.ts';
import type {
  RuntimePluginConfigField,
  RuntimePluginManifest,
} from '../../plugins/api/index.ts';
import type {
  Project02RuntimeConfig,
  LoadedProject02RuntimeConfig,
  RuntimeConfigCharacterScope,
  RuntimeConfigMutationOperation,
  RuntimeConfigValue,
  RuntimePluginActivationStatusShape,
  RuntimePluginConfigInspectShape,
} from './types.ts';
import type {JsonBoundaryObject} from '../../shared/json-boundary.ts';

export type RuntimeConfigControlOperation = Extract<
  RuntimeConfigMutationOperation,
  {
    readonly kind: 'set' | 'unset' | 'default_memory_provider';
  }
>;

export function assertRuntimeConfigControlOperation(
  operation: RuntimeConfigMutationOperation,
): asserts operation is RuntimeConfigControlOperation {
  switch (operation.kind) {
    case 'set':
    case 'unset':
    case 'default_memory_provider':
      return;
    case 'plugin_enable':
    case 'plugin_disable':
      throw new TypeError(
        'Plugin activation must be changed through manifest-aware control.',
      );
    case 'plugin_config_set':
    case 'plugin_config_unset':
    case 'secret_set':
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
    }
  | {
      readonly kind: 'secret_set';
      readonly fieldName: string;
      readonly envVar: string;
      readonly secretValue: string;
    };

export function inspectRuntimePluginConfig(options: {
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly env?: NodeJS.ProcessEnv;
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
      ...(options.env === undefined ? {} : {env: options.env}),
    });
  const mutationBase =
    createRuntimeConfigAuthoredSnapshot(loadedConfig).document;

  return createRuntimePluginConfigInspectShape({
    layeredConfig,
    targetScope: options.targetScope,
    resolvedConfig,
    manifest: options.manifest,
    ...(options.activation === undefined
      ? {}
      : {activation: options.activation}),
    ...(options.defaultEnabled === undefined
      ? {}
      : {defaultEnabled: options.defaultEnabled}),
    fingerprint: layeredControlFingerprint({
      globalConfig: mutationBase,
      characterScope,
      overlayConfig,
      pluginManifests: manifests,
    }),
  });
}

function layeredControlFingerprint(options: {
  readonly globalConfig: Project02RuntimeConfig | JsonBoundaryObject;
  readonly characterScope: RuntimeConfigCharacterScope | undefined;
  readonly overlayConfig:
    ReturnType<typeof readCharacterOverlayForScope>['overlay'] | undefined;
  readonly pluginManifests: readonly RuntimePluginManifest[];
}): string {
  return layeredRuntimeConfigFingerprintForScope({
    globalConfig: options.globalConfig,
    characterScope: options.characterScope,
    overlay: options.overlayConfig,
    pluginManifests: options.pluginManifests,
  });
}

export function runtimePluginConfigControlMutation(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
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
  // Unsetting is how a document already holding a value this scope may
  // not author gets repaired -- including a required field, whose value
  // this scope was never the place for; refusing it would leave the
  // operator editing JSON by hand.
  const scopeRepair =
    scopeViolation !== undefined && options.operation.kind === 'unset';
  const field = validateRuntimePluginConfigControlOperation({
    ...options,
    ...(scopeRepair ? {allowRequiredUnset: true} : {}),
  });

  if (scopeViolation !== undefined && !scopeRepair) {
    throw new TypeError(scopeViolation.message);
  }

  return {
    operation: runtimePluginConfigMutationOperation(options.operation, {
      pluginId: options.manifest.id,
      fieldName: field.name,
    }),
    validateCandidate: config => {
      assertRuntimePluginConfigCandidateValid({
        config,
        manifest: options.manifest,
        runtimeLocation: options.runtimeLocation,
        operation: options.operation,
        ...(options.env === undefined ? {} : {env: options.env}),
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
    case 'secret_set':
      return {
        kind: 'secret_set',
        ...target,
        envVar: operation.envVar,
        secretValue: operation.secretValue,
      };
  }
}

function assertRuntimePluginConfigCandidateValid(options: {
  readonly config: Project02RuntimeConfig;
  readonly manifest: RuntimePluginManifest;
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly operation: RuntimePluginConfigFieldControlOperation;
  readonly env?: NodeJS.ProcessEnv;
}): void {
  const loadedConfig: LoadedProject02RuntimeConfig = Object.freeze({
    source: options.runtimeLocation.selectedConfig.source,
    path: options.runtimeLocation.selectedConfig.path,
    config: options.config,
    diagnostics: Object.freeze([]),
  });
  const resolved = resolveProject02RuntimeConfig({
    loadedConfig,
    runtimeLocation: options.runtimeLocation,
    pluginManifests: [options.manifest],
    skipPluginScopeValidation: true,
    // The runtime resolves this document with the character's env
    // overlaid; validating a write against anything narrower would
    // reject an edit the runtime itself accepts. The pending secret sits
    // on top of both: the file this is validated against is the one this
    // mutation is about to write.
    env: {
      ...runtimeConfigEnvWithCharacterSecrets(
        options.env,
        loadCharacterSecretsEnv(options.runtimeLocation.characterScope.dataRoot)
          .env,
      ),
      ...(options.operation.kind === 'secret_set'
        ? {[options.operation.envVar]: options.operation.secretValue}
        : {}),
    },
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
  /** Set only for a scope repair: removing a value this scope may not hold. */
  readonly allowRequiredUnset?: boolean;
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

  if (options.operation.kind === 'secret_set') {
    if (options.actor !== 'operator') {
      throw new TypeError('Only an operator can update plugin secrets.');
    }

    if (!field.secret) {
      throw new TypeError(
        `Plugin config field "${field.name}" is not declared as secret.`,
      );
    }

    return field;
  }

  if (field.secret) {
    throw new TypeError(
      `Plugin config field "${field.name}" is secret and must be managed through the dedicated secret command.`,
    );
  }

  if (options.actor === 'agent' && field.agentMutable !== true) {
    throw new TypeError(
      `Plugin config field "${field.name}" does not allow agent mutation.`,
    );
  }

  if (
    options.operation.kind === 'unset' &&
    field.required &&
    options.allowRequiredUnset !== true
  ) {
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

    if (runtimeConfigControlValueContainsSecret(options.operation.value)) {
      throw new TypeError(
        `Plugin config field "${field.name}" value must not embed secret references; secrets are managed through the dedicated secret command.`,
      );
    }

    if (
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

function runtimeConfigControlValueContainsSecret(
  value: RuntimeConfigValue,
): boolean {
  return nestedSecretMarkerPath(value, 'value') !== undefined;
}
