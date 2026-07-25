/**
 * Scope-aware runtime config mutations: the same control operations,
 * targeted at either the global config.json or one character's
 * overlay. One resolved target carries the write path, owning global
 * layer, and scope policy for document and plugin-field changes.
 * Character scope rejects global-only fields and secret operations,
 * verifies the caller's layered expectation across both authored
 * documents, and then runs the per-file mutation
 * machinery against the overlay file — never the global one, and never
 * through the global bootstrap (which would seed a store root into the
 * overlay): an absent overlay is first materialized as a minimal
 * versioned document.
 */
import type {RuntimePluginManifest} from '../../plugins/api/index.ts';
import {
  assertRuntimeConfigControlOperation,
  runtimePluginConfigControlMutation,
  type RuntimeConfigControlOperation,
  type RuntimePluginConfigControlActor,
  type RuntimePluginConfigFieldControlOperation,
} from './control.ts';
import {
  applyRuntimeConfigControlTransaction,
  assertGlobalConfigLoadableForCharacterScope,
  readRuntimeConfigControlSnapshot,
  verifyRuntimeConfigControlExpectation,
  type RuntimeConfigControlSnapshot,
} from './control-transaction.ts';
import {createLayeredRuntimeConfigFingerprint} from './fingerprint.ts';
import {
  loadProject02RuntimeConfigForLocation,
  resolveProject02RuntimeLocation,
  sameRuntimeConfigCharacterScope,
  type ResolvedProject02RuntimeLocation,
  type ResolvedRuntimeConfigScopeTarget,
} from './location.ts';
import {
  assertOverlayLocatedCandidateStaysCharacterScoped,
  canonicalRuntimeConfigMutationPath,
  prepareRuntimeConfigMutationCandidate,
  RuntimeConfigMutationError,
  type PreparedRuntimeConfigMutationCandidate,
  type RuntimeConfigMutationResult,
} from './mutate.ts';
import {
  layeredRuntimeConfigFingerprintForScope,
  readCharacterOverlayForScope,
} from './overlay.ts';
import {mergeCharacterOverlayDocument} from './resolve-layered.ts';
import {
  characterRuntimeConfigFieldScopeViolation,
  project02RuntimeConfigValueMatchesField,
  project02RuntimeConfigFieldDefinitions,
} from './schema.ts';
import {runtimePluginScopeViolation} from './plugin-scope.ts';
import {
  runtimeConfigVersion,
  type Project02RuntimeConfig,
  type Project02RuntimePluginConfig,
  type RuntimeConfigMutationOperation,
} from './types.ts';

export type RuntimeConfigMutationScopeSelector = 'global' | 'character';

type ScopedRuntimeConfigLocation = {
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly env?: NodeJS.ProcessEnv;
};

export type RuntimeConfigControlRequest =
  | {
      readonly kind: 'document';
      readonly operation: RuntimeConfigControlOperation;
    }
  | {
      readonly kind: 'plugin_activation';
      readonly manifest: RuntimePluginManifest;
      readonly enabled: boolean;
    }
  | {
      readonly kind: 'plugin_config';
      readonly manifest: RuntimePluginManifest;
      readonly actor: RuntimePluginConfigControlActor;
      readonly fieldOperation: RuntimePluginConfigFieldControlOperation;
    };

export type RuntimeConfigCharacterMaterialization = {
  /** Pure package-owned overlay contribution; never a merged global view. */
  readonly document: Project02RuntimeConfig;
  /**
   * True when the package version differs from the marker. An absent
   * overlay is always materialized regardless of this flag.
   */
  readonly fillMissingFields: boolean;
};

export type RuntimeConfigCharacterMaterializationOutcome = {
  readonly configChanged: boolean;
  readonly autoEnabledPluginIds: readonly string[];
};

export type RuntimeConfigControlApplyResult = RuntimeConfigMutationResult & {
  readonly materialization: RuntimeConfigCharacterMaterializationOutcome;
};

type RuntimePluginConfigControlRequest = Extract<
  RuntimeConfigControlRequest,
  {readonly kind: 'plugin_config'}
>;

/**
 * Names the target file, owning global file, and home. The scope itself
 * controls whether shared secret operations are allowed.
 * Character scope requires a derivable character (configured id +
 * resolvable home); anything else is a usage error, not a fallback.
 */
export function resolveRuntimeConfigScopeTarget(
  options: ScopedRuntimeConfigLocation & {
    readonly scope: RuntimeConfigMutationScopeSelector;
  },
): ResolvedRuntimeConfigScopeTarget {
  const shared = {
    runtimeLocation: options.runtimeLocation,
    ...(options.env === undefined ? {} : {env: options.env}),
  };

  if (options.scope === 'global') {
    return Object.freeze({
      ...shared,
      scope: 'global',
      configPath: options.runtimeLocation.globalConfigPath,
      canonicalConfigPath: canonicalRuntimeConfigMutationPath(
        options.runtimeLocation.globalConfigPath,
      ),
    });
  }

  return Object.freeze({
    ...shared,
    scope: 'character',
    configPath: options.runtimeLocation.overlayPath,
    canonicalConfigPath: canonicalRuntimeConfigMutationPath(
      options.runtimeLocation.overlayPath,
    ),
  });
}

export function applyRuntimeConfigControlOperation(options: {
  readonly target: ResolvedRuntimeConfigScopeTarget;
  readonly expectedFingerprint?: string;
  readonly request?: RuntimeConfigControlRequest;
  readonly characterMaterialization?: RuntimeConfigCharacterMaterialization;
}): RuntimeConfigControlApplyResult {
  if (
    options.request === undefined &&
    options.characterMaterialization === undefined
  ) {
    throw new TypeError(
      'Runtime config control requires an operation or character materialization.',
    );
  }

  if (
    options.target.scope === 'global' &&
    options.characterMaterialization !== undefined
  ) {
    throw new TypeError(
      'Character package materialization requires a character-scoped target.',
    );
  }

  const mutation = normalizedControlMutation(options.target, options.request);

  if (options.target.scope === 'global' && mutation.operation === undefined) {
    throw new TypeError('Global runtime config control requires an operation.');
  }

  const transaction = applyRuntimeConfigControlTransaction({
    target: options.target,
    ...(options.expectedFingerprint === undefined
      ? {}
      : {expectedFingerprint: options.expectedFingerprint}),
    secretMutation: mutation.operation?.kind === 'secret_set',
    prepare: snapshot =>
      prepareScopedRuntimeConfigControlCandidate({
        target: options.target,
        snapshot,
        ...(mutation.operation === undefined
          ? {}
          : {operation: mutation.operation}),
        ...(options.characterMaterialization === undefined
          ? {}
          : {characterMaterialization: options.characterMaterialization}),
        ...(mutation.validateCandidate === undefined
          ? {}
          : {validateCandidate: mutation.validateCandidate}),
      }),
  });

  return withMaterializationOutcome(transaction.result, transaction.context);
}

export function prepareRuntimeConfigControlOperation(options: {
  readonly target: ResolvedRuntimeConfigScopeTarget;
  readonly request: RuntimePluginConfigControlRequest;
  readonly expectedFingerprint: string;
}): {
  readonly resultFingerprint: string;
  readonly targetConfigPath: string;
} {
  const mutation = normalizedControlMutation(options.target, options.request);

  if (mutation.operation === undefined) {
    throw new TypeError(
      'Prepared runtime config control requires an operation.',
    );
  }

  const snapshot = readRuntimeConfigControlSnapshot(options.target);
  verifyRuntimeConfigControlExpectation(snapshot, options.expectedFingerprint);
  const prepared = prepareScopedRuntimeConfigControlCandidate({
    operation: mutation.operation,
    target: options.target,
    snapshot,
    ...(mutation.validateCandidate === undefined
      ? {}
      : {validateCandidate: mutation.validateCandidate}),
  });

  return Object.freeze({
    resultFingerprint: scopedPreparedCandidateFingerprint({
      target: options.target,
      snapshot,
      candidate: prepared.preparedCandidate.config,
    }),
    targetConfigPath: canonicalRuntimeConfigMutationPath(
      options.target.configPath,
    ),
  });
}

type NormalizedRuntimeConfigControlMutation = {
  readonly operation?: RuntimeConfigMutationOperation;
  readonly validateCandidate?: (config: Project02RuntimeConfig) => void;
};

function normalizedControlMutation(
  target: ResolvedRuntimeConfigScopeTarget,
  request: RuntimeConfigControlRequest | undefined,
): NormalizedRuntimeConfigControlMutation {
  if (request === undefined) {
    return {};
  }

  if (request.kind === 'document') {
    assertRuntimeConfigControlOperation(request.operation);

    if (target.scope === 'character') {
      assertCharacterScopedControlOperation(request.operation);
    }

    return {operation: request.operation};
  }

  if (request.kind === 'plugin_activation') {
    const violation = runtimePluginScopeViolation({
      manifest: request.manifest,
      authoredScope: target.scope,
      operation: {kind: 'activation'},
    });

    if (violation !== undefined) {
      throw new RuntimeConfigMutationError(violation.message);
    }

    return {
      operation: {
        kind: request.enabled ? 'plugin_enable' : 'plugin_disable',
        pluginId: request.manifest.id,
      },
    };
  }

  if (
    request.fieldOperation.kind === 'secret_set' &&
    target.scope === 'character'
  ) {
    throw new RuntimeConfigMutationError(
      'Secrets are shared across characters; run the secret command ' +
        'without --character.',
    );
  }

  return runtimePluginConfigControlMutation({
    manifest: request.manifest,
    actor: request.actor,
    operation: request.fieldOperation,
    runtimeLocation: target.runtimeLocation,
    authoredScope: target.scope,
    ...(target.env === undefined ? {} : {env: target.env}),
  });
}

export {assertGlobalConfigLoadableForCharacterScope};

/**
 * Deterministic preflight for character-scoped mutations, mirroring
 * the mutation machinery's own set/unset validation: an unknown path,
 * a dialect violation (global-only field), or an invalid value is
 * rejected here, before any ensure step materializes a marker or data
 * directory for the character.
 */
export function assertScopedMutationOperationAllowed(
  operation: RuntimeConfigMutationOperation,
): void {
  if (operation.kind !== 'set' && operation.kind !== 'unset') {
    return;
  }

  const field = project02RuntimeConfigFieldDefinitions().find(
    definition => definition.path === operation.path,
  );

  if (field === undefined) {
    throw new RuntimeConfigMutationError(
      `Unsupported runtime config path: ${operation.path}.`,
    );
  }

  const scopeViolation = characterRuntimeConfigFieldScopeViolation(field);

  if (scopeViolation !== undefined) {
    throw new RuntimeConfigMutationError(scopeViolation);
  }

  if (
    operation.kind === 'set' &&
    (!project02RuntimeConfigValueMatchesField(operation.value, field) ||
      (typeof operation.value === 'string' &&
        operation.value.trim().length === 0))
  ) {
    throw new RuntimeConfigMutationError(
      `${field.invalidValueMessage} Path: ${operation.path}.`,
    );
  }
}

/**
 * Read-only preflight for CLI verbs: validates the selected global
 * document before ensure materializes any durable character state.
 */
export function assertScopedGlobalLayerLoadable(
  options: ScopedRuntimeConfigLocation,
): void {
  assertGlobalConfigLoadableForCharacterScope(
    loadProject02RuntimeConfigForLocation(options.runtimeLocation),
  );
}

type PreparedScopedRuntimeConfigControlCandidate = {
  readonly preparedCandidate: PreparedRuntimeConfigMutationCandidate;
  readonly commit: boolean;
  readonly operation?: RuntimeConfigMutationOperation;
  readonly context: RuntimeConfigCharacterMaterializationOutcome;
};

/**
 * The one pure candidate builder used by read-only preparation and the
 * locked apply. It never reloads, locks, retries, or writes.
 */
function prepareScopedRuntimeConfigControlCandidate(options: {
  readonly target: ResolvedRuntimeConfigScopeTarget;
  readonly snapshot: RuntimeConfigControlSnapshot;
  readonly operation?: RuntimeConfigMutationOperation;
  readonly characterMaterialization?: RuntimeConfigCharacterMaterialization;
  readonly validateCandidate?: (config: Project02RuntimeConfig) => void;
}): PreparedScopedRuntimeConfigControlCandidate {
  if (options.target.scope === 'global') {
    if (options.operation === undefined) {
      throw new TypeError(
        'Global runtime config control requires an operation.',
      );
    }

    return Object.freeze({
      preparedCandidate: prepareRuntimeConfigMutationCandidate({
        loadedConfig: options.snapshot.loadedConfig,
        configPath: options.target.runtimeLocation.globalConfigPath,
        ...(options.target.runtimeLocation.selection.storeRoot === undefined
          ? {}
          : {
              storeRoot: options.target.runtimeLocation.selection.storeRoot,
            }),
        operation: options.operation,
        ...(options.validateCandidate === undefined
          ? {}
          : {validateCandidate: options.validateCandidate}),
      }),
      commit: true,
      operation: options.operation,
      context: emptyCharacterMaterializationOutcome(),
    });
  }

  const overlay = options.snapshot.characterOverlay.overlay;

  const overlayBase =
    overlay.config ??
    Object.freeze({
      version: runtimeConfigVersion,
    } satisfies Project02RuntimeConfig);
  const materialization = mergeCharacterMaterializationIntoOverlay({
    current: overlayBase,
    materialization: options.characterMaterialization,
    overlayAbsent: overlay.config === undefined,
  });
  const preparedCandidate = prepareRuntimeConfigMutationCandidate({
    loadedConfig: {
      source: 'path',
      path: options.target.configPath,
      config: materialization.config,
      diagnostics: Object.freeze([]),
    },
    configPath: options.target.configPath,
    ...(options.operation === undefined ? {} : {operation: options.operation}),
    validateCandidate: candidate => {
      assertOverlayLocatedCandidateStaysCharacterScoped(candidate);
      options.validateCandidate?.(
        mergeCharacterOverlayDocument(
          options.snapshot.globalDocument,
          candidate,
        ),
      );
    },
  });

  return Object.freeze({
    preparedCandidate,
    commit: options.operation !== undefined || materialization.configChanged,
    ...(options.operation === undefined ? {} : {operation: options.operation}),
    context: materialization,
  });
}

function scopedPreparedCandidateFingerprint(options: {
  readonly target: ResolvedRuntimeConfigScopeTarget;
  readonly snapshot: RuntimeConfigControlSnapshot;
  readonly candidate: Project02RuntimeConfig;
}): string {
  if (options.target.scope === 'character') {
    return createLayeredRuntimeConfigFingerprint({
      globalConfig: options.snapshot.globalDocument,
      characterId: options.target.runtimeLocation.characterScope.characterId,
      overlayConfig: options.candidate,
    });
  }

  const candidateLocation = resolveProject02RuntimeLocation({
    loadedConfig: Object.freeze({
      source: 'path',
      path: options.target.runtimeLocation.globalConfigPath,
      config: options.candidate,
      diagnostics: Object.freeze([]),
    }),
    selection: options.target.runtimeLocation.selection,
    selectedConfig: {
      source: options.target.runtimeLocation.configSource,
      path: options.target.runtimeLocation.globalConfigPath,
    },
  });
  const characterScope = candidateLocation.characterScope;
  const overlay = sameRuntimeConfigCharacterScope(
    characterScope,
    options.snapshot.runtimeLocation.characterScope,
  )
    ? options.snapshot.characterOverlay.overlay
    : readCharacterOverlayForScope(characterScope).overlay;

  return layeredRuntimeConfigFingerprintForScope({
    globalConfig: options.candidate,
    characterScope,
    overlay,
  });
}

function emptyCharacterMaterializationOutcome(): RuntimeConfigCharacterMaterializationOutcome {
  return Object.freeze({
    configChanged: false,
    autoEnabledPluginIds: Object.freeze([]),
  });
}

function assertCharacterScopedControlOperation(
  operation: RuntimeConfigControlOperation,
): void {
  assertScopedMutationOperationAllowed(operation);
}

type CharacterMaterializationMerge =
  RuntimeConfigCharacterMaterializationOutcome & {
    readonly config: Project02RuntimeConfig;
  };

function mergeCharacterMaterializationIntoOverlay(options: {
  readonly current: Project02RuntimeConfig;
  readonly materialization: RuntimeConfigCharacterMaterialization | undefined;
  readonly overlayAbsent: boolean;
}): CharacterMaterializationMerge {
  if (options.materialization === undefined) {
    return Object.freeze({
      config: options.current,
      configChanged: false,
      autoEnabledPluginIds: Object.freeze([]),
    });
  }

  if (!options.overlayAbsent && !options.materialization.fillMissingFields) {
    return Object.freeze({
      config: options.current,
      configChanged: false,
      autoEnabledPluginIds: Object.freeze([]),
    });
  }

  const nextPlugins = {...options.current.plugins};
  const autoEnabledPluginIds: string[] = [];
  let fieldsChanged = false;

  for (const pluginId of Object.keys(
    options.materialization.document.plugins ?? {},
  ).sort((left, right) => left.localeCompare(right))) {
    const defaults = options.materialization.document.plugins?.[pluginId];

    if (defaults === undefined) {
      continue;
    }

    const merged = mergeCharacterPluginMaterialization(
      nextPlugins[pluginId],
      defaults,
    );

    if (!merged.changed) {
      continue;
    }

    fieldsChanged = true;
    nextPlugins[pluginId] = merged.plugin;
    if (merged.autoEnabled) {
      autoEnabledPluginIds.push(pluginId);
    }
  }

  const config = fieldsChanged
    ? Object.freeze({
        ...options.current,
        plugins: Object.freeze(nextPlugins),
      })
    : options.current;

  return Object.freeze({
    config,
    configChanged: options.overlayAbsent || fieldsChanged,
    autoEnabledPluginIds: Object.freeze(
      autoEnabledPluginIds.sort((left, right) => left.localeCompare(right)),
    ),
  });
}

function mergeCharacterPluginMaterialization(
  existing: Project02RuntimePluginConfig | undefined,
  defaults: Project02RuntimePluginConfig,
): {
  readonly plugin: Project02RuntimePluginConfig;
  readonly changed: boolean;
  readonly autoEnabled: boolean;
} {
  const enablementAdded =
    existing?.enabled === undefined && defaults.enabled !== undefined;
  const config = mergeMissingCharacterPluginConfig({
    current: existing?.config,
    defaults: defaults.config,
    createEmpty: existing === undefined,
  });
  const changed =
    existing === undefined || enablementAdded || config.fieldsChanged;
  const enabled = existing?.enabled ?? defaults.enabled;

  return Object.freeze({
    plugin: changed
      ? Object.freeze({
          ...(enabled === undefined ? {} : {enabled}),
          ...(config.value === undefined ? {} : {config: config.value}),
        })
      : existing,
    changed,
    autoEnabled: enablementAdded && defaults.enabled,
  });
}

function mergeMissingCharacterPluginConfig(options: {
  readonly current: Project02RuntimePluginConfig['config'];
  readonly defaults: Project02RuntimePluginConfig['config'];
  readonly createEmpty: boolean;
}): {
  readonly value: Project02RuntimePluginConfig['config'];
  readonly fieldsChanged: boolean;
} {
  const missingEntries = Object.entries(options.defaults ?? {})
    .filter(([fieldName]) => !Object.hasOwn(options.current ?? {}, fieldName))
    .sort(([left], [right]) => left.localeCompare(right));
  const fieldsChanged = missingEntries.length > 0;
  const shouldMaterialize =
    options.defaults !== undefined && (options.createEmpty || fieldsChanged);

  return Object.freeze({
    value: shouldMaterialize
      ? Object.freeze({
          ...options.current,
          ...Object.fromEntries(missingEntries),
        })
      : options.current,
    fieldsChanged,
  });
}

function withMaterializationOutcome(
  result: RuntimeConfigMutationResult,
  outcome: RuntimeConfigCharacterMaterializationOutcome,
): RuntimeConfigControlApplyResult {
  return Object.freeze({
    ...result,
    materialization: Object.freeze({
      configChanged: outcome.configChanged,
      autoEnabledPluginIds: Object.freeze([...outcome.autoEnabledPluginIds]),
    }),
  });
}
