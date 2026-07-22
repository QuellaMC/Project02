import {
  applyRuntimeConfigMutation,
  canonicalRuntimeConfigMutationPath,
  createRuntimeConfigMutationBase,
  prepareRuntimeConfigMutationCandidate,
  RuntimeConfigConflictError,
  type RuntimeConfigMutationResult,
} from './mutate.ts';
import {createRuntimeConfigFingerprint} from './fingerprint.ts';
import {dirname} from 'node:path';

import {
  createProject02HomeLayout,
  LocalRuntimeStorageContractError,
} from '../storage/layout-contract.ts';
import {acquireLocalRuntimeMutationLockSync} from '../storage/mutation-lock.ts';
import {
  characterOverlayConfigPath,
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
    readonly kind:
      | 'set'
      | 'unset'
      | 'plugin_enable'
      | 'plugin_disable'
      | 'default_memory_provider';
  }
>;

export function applyRuntimeConfigControlOperation(options: {
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly expectedFingerprint?: string;
  readonly storeRoot?: string;
  readonly characterScope?: RuntimeConfigCharacterScope;
  readonly operation: RuntimeConfigControlOperation;
}): RuntimeConfigMutationResult {
  assertRuntimeConfigControlOperation(options.operation);
  return applyGlobalTargetControlMutation(options);
}

/**
 * Shared core of the global-target control writes. A layered
 * expectation is verified — and stays protected — under the active
 * character's overlay control lock, so a concurrent scoped edit cannot
 * land between the check and the global commit; the mutation machinery
 * then takes the global file's own lock inside. (The scoped path locks
 * global-then-overlay; a rare cross-scope race resolves through the
 * lock wait timeout as a conflict, never a silent stale write.) The
 * result fingerprint re-derives the scope from the committed document:
 * a write that changes the selected character reports the new layer.
 */
function applyGlobalTargetControlMutation(options: {
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly expectedFingerprint?: string;
  readonly storeRoot?: string;
  readonly characterScope?: RuntimeConfigCharacterScope;
  readonly operation: Parameters<
    typeof applyRuntimeConfigMutation
  >[0]['operation'];
  readonly validateCandidate?: (config: Project02RuntimeConfig) => void;
}): RuntimeConfigMutationResult {
  return withExpectationOverlayLock(options, () => {
    const layered =
      options.expectedFingerprint === undefined
        ? undefined
        : verifyLayeredControlExpectation({
            ...options,
            expectedFingerprint: options.expectedFingerprint,
          });
    const result = applyRuntimeConfigMutation({
      ...(options.configPath === undefined
        ? {}
        : {configPath: options.configPath}),
      ...(options.env === undefined ? {} : {env: options.env}),
      ...(options.storeRoot === undefined
        ? {}
        : {storeRoot: options.storeRoot}),
      ...(layered === undefined
        ? {}
        : {expectedFingerprint: layered.globalFileFingerprint}),
      ...(options.validateCandidate === undefined
        ? {}
        : {validateCandidate: options.validateCandidate}),
      operation: options.operation,
    });
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
        : loadCharacterOverlayForScope(characterScope);

    return Object.freeze({
      ...result,
      fingerprint: layeredControlFingerprint({
        globalConfig: result.config,
        characterScope,
        overlayConfig,
      }),
    });
  });
}

/**
 * Holds the active character's overlay control lock while a layered
 * expectation authorizes a global write. Without an expectation there
 * is nothing to protect and no lock is taken.
 */
function withExpectationOverlayLock<T>(
  options: {
    readonly configPath?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly expectedFingerprint?: string;
    readonly storeRoot?: string;
    readonly characterScope?: RuntimeConfigCharacterScope;
  },
  run: () => T,
): T {
  if (options.expectedFingerprint === undefined) {
    return run();
  }

  const characterScope = controlCharacterScope(
    loadProject02RuntimeConfig({
      ...(options.configPath === undefined
        ? {}
        : {configPath: options.configPath}),
      ...(options.env === undefined ? {} : {env: options.env}),
      ...(options.storeRoot === undefined
        ? {}
        : {storeRoot: options.storeRoot}),
    }),
    options,
  );

  if (characterScope === undefined) {
    return run();
  }

  const canonicalOverlayPath = canonicalRuntimeConfigMutationPath(
    characterOverlayConfigPath(characterScope.dataRoot),
  );

  // A --config pointed directly at the overlay makes the "global" path
  // the overlay itself; pre-locking it here would deadlock against the
  // mutation's own lock on the same file. That single-file case is
  // covered by the mutation lock alone.
  if (resolveRuntimeConfigControlTargetPath(options) === canonicalOverlayPath) {
    return run();
  }

  let overlayLock: ReturnType<typeof acquireLocalRuntimeMutationLockSync>;

  try {
    overlayLock = acquireLocalRuntimeMutationLockSync({
      locksRoot: createProject02HomeLayout({
        homeRoot: dirname(canonicalOverlayPath),
      }).locksRoot,
      resourceKey: `runtime-control-file:${canonicalOverlayPath}`,
    });
  } catch (error: unknown) {
    // A lock root that cannot exist means no concurrent scoped writer
    // can be mid-write either; let the mutation surface the store
    // problem with its own precise error instead of masking it here.
    if (error instanceof LocalRuntimeStorageContractError) {
      return run();
    }

    throw error;
  }

  try {
    return run();
  } finally {
    overlayLock.release();
  }
}

function assertRuntimeConfigControlOperation(
  operation: RuntimeConfigMutationOperation,
): asserts operation is RuntimeConfigControlOperation {
  switch (operation.kind) {
    case 'set':
    case 'unset':
    case 'plugin_enable':
    case 'plugin_disable':
    case 'default_memory_provider':
      return;
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
 * derivation activation itself uses. Every stamp/inspect/prepare/apply
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

export function applyRuntimePluginConfigControlOperation(options: {
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly storeRoot?: string;
  readonly characterScope?: RuntimeConfigCharacterScope;
  readonly manifest: RuntimePluginManifest;
  readonly actor: RuntimePluginConfigControlActor;
  readonly expectedFingerprint: string;
  readonly operation: RuntimePluginConfigFieldControlOperation;
}): RuntimeConfigMutationResult {
  const mutation = runtimePluginConfigControlMutation(options);

  return applyGlobalTargetControlMutation({
    ...options,
    operation: mutation.operation,
    validateCandidate: mutation.validateCandidate,
  });
}

/**
 * Verifies a caller's layered expected fingerprint against the current
 * pair of authored documents and hands back the global file's per-file
 * fingerprint for the mutation lock plus the overlay snapshot the
 * result fingerprint composes with.
 */
function verifyLayeredControlExpectation(options: {
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly storeRoot?: string;
  readonly characterScope?: RuntimeConfigCharacterScope;
  readonly expectedFingerprint: string;
}): {
  readonly globalFileFingerprint: string;
  readonly characterScope: RuntimeConfigCharacterScope | undefined;
  readonly overlayConfig:
    ReturnType<typeof loadCharacterOverlayForScope> | undefined;
} {
  const loadedConfig = loadProject02RuntimeConfig({
    ...(options.configPath === undefined
      ? {}
      : {configPath: options.configPath}),
    ...(options.env === undefined ? {} : {env: options.env}),
    ...(options.storeRoot === undefined ? {} : {storeRoot: options.storeRoot}),
  });
  const characterScope = controlCharacterScope(loadedConfig, options);
  const overlayConfig =
    characterScope === undefined
      ? undefined
      : loadCharacterOverlayForScope(characterScope);
  const globalConfig = createRuntimeConfigMutationBase({
    loadedConfig,
    ...(options.configPath === undefined
      ? {}
      : {configPath: options.configPath}),
    ...(options.storeRoot === undefined ? {} : {storeRoot: options.storeRoot}),
  });
  const currentFingerprint = layeredControlFingerprint({
    globalConfig,
    characterScope,
    overlayConfig,
  });

  if (options.expectedFingerprint !== currentFingerprint) {
    throw new RuntimeConfigConflictError(
      'Runtime config changed before the mutation could be committed. ' +
        `Expected ${options.expectedFingerprint}, found ${currentFingerprint}.`,
    );
  }

  return {
    globalFileFingerprint: createRuntimeConfigFingerprint(globalConfig),
    characterScope,
    overlayConfig,
  };
}

export function prepareRuntimePluginConfigControlOperation(options: {
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly storeRoot?: string;
  readonly characterScope?: RuntimeConfigCharacterScope;
  readonly manifest: RuntimePluginManifest;
  readonly actor: RuntimePluginConfigControlActor;
  readonly expectedFingerprint: string;
  readonly operation: RuntimePluginConfigFieldControlOperation;
}): {
  readonly resultFingerprint: string;
  readonly targetConfigPath: string;
} {
  const loadedConfig = loadProject02RuntimeConfig({
    ...(options.configPath === undefined
      ? {}
      : {configPath: options.configPath}),
    ...(options.env === undefined ? {} : {env: options.env}),
    ...(options.storeRoot === undefined ? {} : {storeRoot: options.storeRoot}),
  });
  const characterScope = controlCharacterScope(loadedConfig, options);
  const overlayConfig =
    characterScope === undefined
      ? undefined
      : loadCharacterOverlayForScope(characterScope);
  const globalConfig = createRuntimeConfigMutationBase({
    loadedConfig,
    ...(options.configPath === undefined
      ? {}
      : {configPath: options.configPath}),
    ...(options.storeRoot === undefined ? {} : {storeRoot: options.storeRoot}),
  });
  const currentFingerprint = layeredControlFingerprint({
    globalConfig,
    characterScope,
    overlayConfig,
  });

  if (options.expectedFingerprint !== currentFingerprint) {
    throw new RuntimeConfigConflictError(
      'Runtime config changed before the mutation could be committed. ' +
        `Expected ${options.expectedFingerprint}, found ${currentFingerprint}.`,
    );
  }

  const mutation = runtimePluginConfigControlMutation(options);
  // The layered expectation was already verified on this exact loaded
  // snapshot, so the candidate preparation runs without its own
  // per-file expectation.
  const prepared = prepareRuntimeConfigMutationCandidate({
    loadedConfig,
    ...(options.configPath === undefined
      ? {}
      : {configPath: options.configPath}),
    ...(options.storeRoot === undefined ? {} : {storeRoot: options.storeRoot}),
    validateCandidate: mutation.validateCandidate,
    operation: mutation.operation,
  });

  return Object.freeze({
    resultFingerprint: layeredControlFingerprint({
      globalConfig: prepared.config,
      characterScope,
      overlayConfig,
    }),
    targetConfigPath: runtimeConfigControlTargetPathFromLoaded({
      ...(loadedConfig.path === undefined
        ? {}
        : {loadedPath: loadedConfig.path}),
      ...(options.configPath === undefined
        ? {}
        : {configPath: options.configPath}),
      ...(options.storeRoot === undefined
        ? {}
        : {storeRoot: options.storeRoot}),
    }),
  });
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
}): {
  readonly operation: RuntimeConfigMutationOperation;
  readonly validateCandidate: (config: Project02RuntimeConfig) => void;
} {
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
