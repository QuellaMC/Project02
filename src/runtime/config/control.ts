import {
  applyRuntimeConfigMutation,
  canonicalRuntimeConfigMutationPath,
  createRuntimeConfigMutationBase,
  prepareRuntimeConfigMutationCandidate,
  type RuntimeConfigMutationResult,
} from './mutate.ts';
import {createRuntimeConfigFingerprint} from './fingerprint.ts';
import {
  verifyLayeredControlExpectation,
  withLayeredControlSnapshot,
  type LayeredControlSnapshot,
} from './control-transaction.ts';
import {
  deriveRuntimeConfigCharacterScope,
  layeredRuntimeConfigFingerprintForScope,
  loadCharacterOverlayForScope,
} from './overlay.ts';
import {
  mergedLoadedConfigForOverlay,
  resolveLayeredProject02RuntimeConfig,
} from './resolve-layered.ts';
import {canonicalJsonValuesEqual} from '../../shared/canonical-json.ts';
import {createRuntimePluginConfigInspectShape} from './inspect.ts';
import {defaultRuntimeConfigPath, loadProject02RuntimeConfig} from './load.ts';
import {resolveProject02RuntimeConfig} from './resolve.ts';
import {
  runtimeConfigFieldValueMismatchMessage,
  runtimeConfigValueMatchesField,
} from './schema.ts';
import {runtimePluginScopeViolation} from './plugin-scope.ts';
import {
  redactRuntimeConfigValue,
  runtimeConfigValueIsSecretMarker,
} from './redact.ts';
import type {
  RuntimePluginConfigField,
  RuntimePluginManifest,
} from '../../plugins/api/index.ts';
import type {
  Project02RuntimeConfig,
  RuntimeConfigCharacterScope,
  RuntimeConfigMutationOperation,
  RuntimeConfigValue,
  RuntimePluginConfigActivationInspectShape,
  RuntimePluginConfigInspectShape,
} from './types.ts';

export type RuntimeConfigControlOperation = Extract<
  RuntimeConfigMutationOperation,
  {
    readonly kind: 'set' | 'unset' | 'default_memory_provider';
  }
>;

export function applyGlobalRuntimeConfigControlMutation(options: {
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly expectedFingerprint?: string;
  readonly storeRoot?: string;
  readonly characterScope?: RuntimeConfigCharacterScope;
  readonly operation: RuntimeConfigMutationOperation;
  readonly validateCandidate?: (config: Project02RuntimeConfig) => void;
}): RuntimeConfigMutationResult {
  return withLayeredControlSnapshot(
    {
      ...(options.configPath === undefined
        ? {}
        : {configPath: options.configPath}),
      ...(options.env === undefined ? {} : {env: options.env}),
      ...(options.storeRoot === undefined
        ? {}
        : {storeRoot: options.storeRoot}),
      ...(options.characterScope === undefined
        ? {}
        : {characterScope: options.characterScope}),
      scopeSelector: 'global',
      lockMode: 'mutation',
      secretMutation: options.operation.kind === 'secret_set',
      expectingFingerprint: options.expectedFingerprint !== undefined,
    },
    snapshot => {
      if (options.expectedFingerprint !== undefined) {
        verifyLayeredControlExpectation(snapshot, options.expectedFingerprint);
      }

      const result = applyRuntimeConfigMutation({
        ...(options.configPath === undefined
          ? {}
          : {configPath: options.configPath}),
        ...(options.env === undefined ? {} : {env: options.env}),
        ...(options.storeRoot === undefined
          ? {}
          : {storeRoot: options.storeRoot}),
        // The layered expectation was verified against this locked
        // snapshot; pin the global file so the write engine checks the
        // same document it verified.
        ...(options.expectedFingerprint === undefined
          ? {}
          : {
              expectedFingerprint: createRuntimeConfigFingerprint(
                snapshot.globalDocument,
              ),
            }),
        ...(options.validateCandidate === undefined
          ? {}
          : {validateCandidate: options.validateCandidate}),
        operation: options.operation,
        ownerToken: snapshot.ownerToken,
        ...(snapshot.anticipatedEnvPath === undefined
          ? {}
          : {anticipatedEnvPath: snapshot.anticipatedEnvPath}),
        retryOnPathChange: false,
      });

      return Object.freeze({
        ...result,
        fingerprint: committedLayeredControlFingerprint(
          options,
          snapshot,
          result,
        ),
      });
    },
  );
}

/**
 * Result fingerprint of a committed global write: composed with the
 * overlay of the character the COMMITTED config selects — the locked
 * pre-write snapshot when the selection is unchanged, a fresh guarded
 * read when the write moved project02.character to another character.
 */
function committedLayeredControlFingerprint(
  options: {
    readonly storeRoot?: string;
    readonly characterScope?: RuntimeConfigCharacterScope;
  },
  snapshot: LayeredControlSnapshot,
  result: RuntimeConfigMutationResult,
): string {
  const characterScope = controlCharacterScope(
    {
      source: 'path',
      path: result.configPath,
      config: result.config,
      diagnostics: Object.freeze([]),
    },
    options,
  );
  const overlayConfig =
    characterScope === undefined
      ? undefined
      : snapshot.overlay !== undefined &&
          snapshot.characterScope !== undefined &&
          snapshot.characterScope.characterId === characterScope.characterId &&
          snapshot.characterScope.dataRoot === characterScope.dataRoot
        ? snapshot.overlay
        : loadCharacterOverlayForScope(characterScope);

  return layeredControlFingerprint({
    globalConfig: result.config,
    characterScope,
    overlayConfig,
  });
}

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
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly storeRoot?: string;
  readonly characterScope?: RuntimeConfigCharacterScope;
  /**
   * Which layer the authored values report from. 'merged' (default) is
   * the layered truth; 'global' is for surfaces that stage global-file
   * edits and must not present overlay-authored values as editable.
   * The fingerprint stays layered either way.
   */
  readonly authoredView?: 'merged' | 'global';
  readonly manifest: RuntimePluginManifest;
  readonly pluginManifests?: readonly RuntimePluginManifest[];
  readonly activation?: RuntimePluginConfigActivationInspectShape;
  readonly defaultEnabled?: boolean;
}): RuntimePluginConfigInspectShape {
  const loadedConfig = loadProject02RuntimeConfig({
    ...(options.configPath === undefined
      ? {}
      : {configPath: options.configPath}),
    ...(options.env === undefined ? {} : {env: options.env}),
    ...(options.storeRoot === undefined ? {} : {storeRoot: options.storeRoot}),
  });
  const characterScope = controlCharacterScope(loadedConfig, options);
  // The guarded overlay loader enforces the identity and adoptability
  // rules for control reads too: a data directory rebound to another
  // character must not feed its overlay into model-visible config.
  const overlayConfig =
    characterScope === undefined
      ? undefined
      : loadCharacterOverlayForScope(characterScope);
  const manifests = manifestsIncludingTarget(
    options.manifest,
    options.pluginManifests,
  );
  const resolvedConfig = resolveLayeredProject02RuntimeConfig({
    loadedConfig,
    ...(overlayConfig === undefined ? {} : {overlayConfig}),
    ...(options.storeRoot === undefined ? {} : {storeRoot: options.storeRoot}),
    pluginManifests: manifests,
    validateInactivePluginConfigs: true,
    ...(options.env === undefined ? {} : {env: options.env}),
  });
  const mutationBase = createRuntimeConfigMutationBase({
    loadedConfig,
    ...(options.configPath === undefined
      ? {}
      : {configPath: options.configPath}),
    ...(options.storeRoot === undefined ? {} : {storeRoot: options.storeRoot}),
  });

  return createRuntimePluginConfigInspectShape({
    // Authored values come from the merged view by default: a field
    // authored only in the overlay must read as configured, not unset.
    loadedConfig:
      overlayConfig === undefined || options.authoredView === 'global'
        ? loadedConfig
        : mergedLoadedConfigForOverlay(loadedConfig, overlayConfig),
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
    }),
  });
}

/**
 * The character scope a control operation fingerprints against: the
 * explicit scope threaded from activation when present, else the same
 * derivation activation itself uses. Every inspect/prepare/apply
 * site composes fingerprints through this one pair.
 */
function controlCharacterScope(
  loadedConfig: ReturnType<typeof loadProject02RuntimeConfig>,
  options: {
    readonly storeRoot?: string;
    readonly characterScope?: RuntimeConfigCharacterScope;
  },
): RuntimeConfigCharacterScope | undefined {
  return (
    options.characterScope ??
    deriveRuntimeConfigCharacterScope({
      loadedConfig,
      ...(options.storeRoot === undefined
        ? {}
        : {storeRoot: options.storeRoot}),
    })
  );
}

function layeredControlFingerprint(options: {
  readonly globalConfig: Project02RuntimeConfig;
  readonly characterScope: RuntimeConfigCharacterScope | undefined;
  readonly overlayConfig:
    ReturnType<typeof loadCharacterOverlayForScope> | undefined;
}): string {
  return layeredRuntimeConfigFingerprintForScope({
    globalConfig: options.globalConfig,
    characterScope: options.characterScope,
    overlay: options.overlayConfig,
  });
}

export function prepareGlobalRuntimeConfigControlMutation(options: {
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly storeRoot?: string;
  readonly characterScope?: RuntimeConfigCharacterScope;
  readonly expectedFingerprint: string;
  readonly operation: RuntimeConfigMutationOperation;
  readonly validateCandidate?: (config: Project02RuntimeConfig) => void;
}): {
  readonly resultFingerprint: string;
  readonly targetConfigPath: string;
} {
  // Read-only preparation runs without locks: the apply re-verifies
  // the same layered expectation under the full mutation lock set.
  return withLayeredControlSnapshot(
    {
      ...(options.configPath === undefined
        ? {}
        : {configPath: options.configPath}),
      ...(options.env === undefined ? {} : {env: options.env}),
      ...(options.storeRoot === undefined
        ? {}
        : {storeRoot: options.storeRoot}),
      ...(options.characterScope === undefined
        ? {}
        : {characterScope: options.characterScope}),
      scopeSelector: 'global',
      lockMode: 'none',
      expectingFingerprint: true,
    },
    snapshot => {
      verifyLayeredControlExpectation(snapshot, options.expectedFingerprint);

      // The layered expectation was already verified on this exact
      // loaded snapshot, so the candidate preparation runs without its
      // own per-file expectation.
      const prepared = prepareRuntimeConfigMutationCandidate({
        loadedConfig: snapshot.loadedConfig,
        ...(options.configPath === undefined
          ? {}
          : {configPath: options.configPath}),
        ...(options.storeRoot === undefined
          ? {}
          : {storeRoot: options.storeRoot}),
        ...(options.validateCandidate === undefined
          ? {}
          : {validateCandidate: options.validateCandidate}),
        operation: options.operation,
      });

      return Object.freeze({
        resultFingerprint: layeredControlFingerprint({
          globalConfig: prepared.config,
          characterScope: snapshot.characterScope,
          overlayConfig: snapshot.overlay,
        }),
        targetConfigPath: snapshot.canonicalGlobalPath,
      });
    },
  );
}

export function resolveRuntimeConfigControlTargetPath(options: {
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly storeRoot?: string;
}): string {
  const loadedConfig = loadProject02RuntimeConfig({
    ...(options.configPath === undefined
      ? {}
      : {configPath: options.configPath}),
    ...(options.env === undefined ? {} : {env: options.env}),
    ...(options.storeRoot === undefined ? {} : {storeRoot: options.storeRoot}),
  });

  return runtimeConfigControlTargetPathFromLoaded({
    ...(loadedConfig.path === undefined ? {} : {loadedPath: loadedConfig.path}),
    ...(options.configPath === undefined
      ? {}
      : {configPath: options.configPath}),
    ...(options.storeRoot === undefined ? {} : {storeRoot: options.storeRoot}),
  });
}

function runtimeConfigControlTargetPathFromLoaded(options: {
  readonly loadedPath?: string;
  readonly configPath?: string;
  readonly storeRoot?: string;
}): string {
  return canonicalRuntimeConfigMutationPath(
    options.loadedPath ??
      options.configPath ??
      defaultRuntimeConfigPath(options.storeRoot),
  );
}

export function runtimePluginConfigControlMutation(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly storeRoot?: string;
  readonly manifest: RuntimePluginManifest;
  readonly actor: RuntimePluginConfigControlActor;
  readonly operation: RuntimePluginConfigFieldControlOperation;
  readonly authoredScope?: 'global' | 'character';
}): {
  readonly operation: RuntimeConfigMutationOperation;
  readonly validateCandidate: (config: Project02RuntimeConfig) => void;
} {
  const field = validateRuntimePluginConfigControlOperation(options);
  const scopeViolation = runtimePluginScopeViolation({
    manifest: options.manifest,
    authoredScope: options.authoredScope ?? 'global',
    operation: {kind: 'field', fieldName: field.name},
  });

  if (scopeViolation !== undefined) {
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
        ...(options.env === undefined ? {} : {env: options.env}),
        ...(options.storeRoot === undefined
          ? {}
          : {storeRoot: options.storeRoot}),
      });
    },
  };
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
  readonly env?: NodeJS.ProcessEnv;
  readonly storeRoot?: string;
}): void {
  const resolved = resolveProject02RuntimeConfig({
    loadedConfig: {
      source: 'path',
      config: options.config,
      diagnostics: Object.freeze([]),
    },
    pluginManifests: [options.manifest],
    skipPluginScopeValidation: true,
    ...(options.env === undefined ? {} : {env: options.env}),
    ...(options.storeRoot === undefined ? {} : {storeRoot: options.storeRoot}),
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
  if (Array.isArray(value)) {
    return value.some(runtimeConfigControlValueContainsSecret);
  }

  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if (runtimeConfigValueIsSecretMarker(value)) {
    return true;
  }

  return Object.values(value).some(runtimeConfigControlValueContainsSecret);
}
