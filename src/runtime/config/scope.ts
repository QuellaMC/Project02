/** One control operation, aimed at the global config or one overlay. */
import type {RuntimePluginManifest} from '../../plugins/api/index.ts';
import {
  isJsonBoundaryObject,
  ownJsonRecordValue,
  type JsonBoundaryObject,
  type JsonBoundaryValue,
} from '../../shared/json-boundary.ts';
import {
  assertRuntimeConfigControlOperation,
  runtimePluginConfigControlMutation,
  type RuntimeConfigControlOperation,
  type RuntimePluginConfigControlActor,
  type RuntimePluginConfigFieldControlOperation,
} from './control.ts';
import {
  applyRuntimeConfigControlTransaction,
  readRuntimeConfigControlSnapshot,
  verifyRuntimeConfigControlExpectation,
  type RuntimeConfigControlSnapshot,
} from './control-transaction.ts';
import {createLayeredRuntimeConfigFingerprint} from './fingerprint.ts';
import {
  requireResolvedRuntimeConfigScopeTarget,
  type ResolvedRuntimeConfigScopeTarget,
} from './location.ts';
import {
  prepareRuntimeConfigMutationCandidate,
  RuntimeConfigConflictError,
  RuntimeConfigMutationError,
  type PreparedRuntimeConfigMutationCandidate,
  type RuntimeConfigMutationResult,
} from './mutate.ts';
import {
  layeredRuntimeConfigFingerprintForScope,
  type LoadedProject02CharacterOverlayConfig,
} from './overlay.ts';
import {mergeCharacterOverlayDocument} from './resolve-layered.ts';
import {
  project02RuntimeConfigFieldAcceptsValue,
  project02RuntimeConfigFieldDefinitions,
} from './schema.ts';
import {runtimePluginScopeViolation} from './plugin-scope.ts';
import {
  runtimeConfigVersion,
  type Project02RuntimeConfig,
  type Project02RuntimePluginConfig,
  type RuntimeConfigMutationOperation,
} from './types.ts';

export type RuntimeConfigControlRequest =
  | {
      readonly kind: 'document';
      readonly operation: RuntimeConfigControlOperation;
    }
  | {
      readonly kind: 'plugin_activation';
      readonly manifest: RuntimePluginManifest;
      /** Absent clears the authored value instead of deciding it. */
      readonly enabled?: boolean;
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
  /** Set when the package version differs; an absent overlay fills anyway. */
  readonly fillMissingFields: boolean;
};

export type RuntimeConfigCharacterMaterializationOutcome = {
  readonly autoEnabledPluginIds: readonly string[];
};

export type RuntimeConfigControlApplyResult = RuntimeConfigMutationResult & {
  readonly materialization: RuntimeConfigCharacterMaterializationOutcome;
};

type RuntimePluginConfigControlRequest = Extract<
  RuntimeConfigControlRequest,
  {readonly kind: 'plugin_config'}
>;

export function applyRuntimeConfigControlOperation(options: {
  readonly target: ResolvedRuntimeConfigScopeTarget;
  readonly pluginManifests: readonly RuntimePluginManifest[];
  readonly expectedFingerprint?: string;
  readonly request?: RuntimeConfigControlRequest;
  readonly characterMaterialization?: RuntimeConfigCharacterMaterialization;
  /** How long to wait for a file another writer holds; the lock's default otherwise. */
  readonly lockWaitTimeoutMs?: number;
}): RuntimeConfigControlApplyResult {
  const target = requireResolvedRuntimeConfigScopeTarget(options.target);

  if (
    options.request === undefined &&
    options.characterMaterialization === undefined
  ) {
    throw new TypeError(
      'Runtime config control requires an operation or character materialization.',
    );
  }

  if (
    target.scope === 'global' &&
    options.characterMaterialization !== undefined
  ) {
    throw new TypeError(
      'Character package materialization requires a character-scoped target.',
    );
  }

  const mutation = normalizedControlMutation(target, options.request);

  if (target.scope === 'global' && mutation.operation === undefined) {
    throw new TypeError('Global runtime config control requires an operation.');
  }

  const transaction = applyRuntimeConfigControlTransaction({
    target,
    pluginManifests: options.pluginManifests,
    ...(options.expectedFingerprint === undefined
      ? {}
      : {expectedFingerprint: options.expectedFingerprint}),
    ...(options.lockWaitTimeoutMs === undefined
      ? {}
      : {lockWaitTimeoutMs: options.lockWaitTimeoutMs}),
    prepare: snapshot =>
      prepareScopedRuntimeConfigControlCandidate({
        target,
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

export type SimulatedCharacterOverlayCandidate =
  | {
      readonly status: 'valid';
      /** The document the commit would write, not the bytes on disk. */
      readonly document: Project02RuntimeConfig;
      readonly autoEnabledPluginIds: readonly string[];
    }
  | {readonly status: 'invalid'; readonly message: string}
  | {readonly status: 'conflict'; readonly message: string};

/**
 * Runs the commit's own preparation, so a plan and its commit cannot disagree.
 * It never locks or writes, and the data directory need not exist yet. Given
 * an expectation, it verifies it as the commit will, lock-free.
 */
export function simulateCharacterOverlayCandidate(options: {
  readonly target: ResolvedRuntimeConfigScopeTarget;
  readonly pluginManifests: readonly RuntimePluginManifest[];
  readonly request?: RuntimeConfigControlRequest;
  readonly characterMaterialization?: RuntimeConfigCharacterMaterialization;
  readonly expectedFingerprint?: string;
}): SimulatedCharacterOverlayCandidate {
  const target = requireResolvedRuntimeConfigScopeTarget(options.target);

  if (target.scope !== 'character') {
    throw new TypeError(
      'Character overlay simulation requires a character-scoped target.',
    );
  }

  const mutation = normalizedControlMutation(target, options.request);

  try {
    const snapshot = readRuntimeConfigControlSnapshot(target, {
      pluginManifests: options.pluginManifests,
      requireCharacterMarker: false,
    });

    if (options.expectedFingerprint !== undefined) {
      verifyRuntimeConfigControlExpectation(
        snapshot,
        options.expectedFingerprint,
      );
    }

    const prepared = prepareScopedRuntimeConfigControlCandidate({
      target,
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
    });

    return Object.freeze({
      status: 'valid',
      document: prepared.preparedCandidate.config,
      autoEnabledPluginIds: prepared.context.autoEnabledPluginIds,
    });
  } catch (error: unknown) {
    if (error instanceof RuntimeConfigConflictError) {
      return Object.freeze({status: 'conflict', message: error.message});
    }

    // These two mean unacceptable config; anything else is a real fault.
    if (
      error instanceof RuntimeConfigMutationError ||
      error instanceof TypeError
    ) {
      return Object.freeze({status: 'invalid', message: error.message});
    }

    throw error;
  }
}

export function prepareRuntimeConfigControlOperation(options: {
  readonly target: ResolvedRuntimeConfigScopeTarget;
  readonly pluginManifests: readonly RuntimePluginManifest[];
  readonly request: RuntimePluginConfigControlRequest;
  readonly expectedFingerprint: string;
}): {
  readonly resultFingerprint: string;
  readonly targetConfigPath: string;
} {
  const target = requireResolvedRuntimeConfigScopeTarget(options.target);
  const mutation = normalizedControlMutation(target, options.request);

  if (mutation.operation === undefined) {
    throw new TypeError(
      'Prepared runtime config control requires an operation.',
    );
  }

  const snapshot = readRuntimeConfigControlSnapshot(target, {
    pluginManifests: options.pluginManifests,
  });
  verifyRuntimeConfigControlExpectation(snapshot, options.expectedFingerprint);
  const prepared = prepareScopedRuntimeConfigControlCandidate({
    operation: mutation.operation,
    target,
    snapshot,
    ...(mutation.validateCandidate === undefined
      ? {}
      : {validateCandidate: mutation.validateCandidate}),
  });

  return Object.freeze({
    resultFingerprint: scopedPreparedCandidateFingerprint({
      target,
      snapshot,
      candidate: prepared.preparedCandidate.config,
    }),
    targetConfigPath: target.canonicalConfigPath,
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
      operation:
        request.enabled === undefined
          ? {kind: 'plugin_activation_clear', pluginId: request.manifest.id}
          : {
              kind: request.enabled ? 'plugin_enable' : 'plugin_disable',
              pluginId: request.manifest.id,
            },
    };
  }

  return runtimePluginConfigControlMutation({
    manifest: request.manifest,
    actor: request.actor,
    operation: request.fieldOperation,
    authoredScope: target.scope,
  });
}

/** Rejects before any ensure step materializes a marker or data directory. */
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

  if (
    operation.kind === 'set' &&
    !project02RuntimeConfigFieldAcceptsValue(operation.value, field)
  ) {
    throw new RuntimeConfigMutationError(
      `${field.invalidValueMessage} Path: ${operation.path}.`,
    );
  }
}

type PreparedScopedRuntimeConfigControlCandidate = {
  readonly preparedCandidate: PreparedRuntimeConfigMutationCandidate;
  readonly commit: boolean;
  readonly operation?: RuntimeConfigMutationOperation;
  readonly context: RuntimeConfigCharacterMaterializationOutcome;
};

/** Pure: it never reloads, locks, retries, or writes. */
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

  const overlay = requiredCharacterOverlay(options.snapshot);

  const overlayBase =
    overlay.authoredDocument ??
    Object.freeze({
      version: runtimeConfigVersion,
    } satisfies Project02RuntimeConfig);
  const materialization = mergeCharacterMaterializationIntoOverlay({
    current: overlayBase,
    materialization: options.characterMaterialization,
    overlayAbsent: overlay.authoredDocument === undefined,
  });
  const preparedCandidate = prepareRuntimeConfigMutationCandidate({
    loadedConfig: {
      source: 'path',
      path: options.target.configPath,
      authoredDocument: materialization.document,
      diagnostics: Object.freeze([]),
    },
    ...(options.operation === undefined ? {} : {operation: options.operation}),
    validateCandidate: candidate => {
      const globalConfig = options.snapshot.validatedGlobalConfig;

      if (globalConfig === undefined) {
        throw new RuntimeConfigMutationError(
          'Character config control requires a valid global config document.',
        );
      }

      options.validateCandidate?.(
        mergeCharacterOverlayDocument(globalConfig, candidate),
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
      pluginManifests: options.snapshot.pluginManifests,
    });
  }

  return layeredRuntimeConfigFingerprintForScope({
    globalConfig: options.candidate,
    characterScope: options.snapshot.characterRuntimeLocation?.characterScope,
    overlay: options.snapshot.characterOverlay?.overlay,
    pluginManifests: options.snapshot.pluginManifests,
  });
}

function requiredCharacterOverlay(
  snapshot: RuntimeConfigControlSnapshot,
): LoadedProject02CharacterOverlayConfig {
  if (snapshot.characterOverlay === undefined) {
    throw new TypeError(
      'Character config control requires a bound character overlay.',
    );
  }

  return snapshot.characterOverlay.overlay;
}

function emptyCharacterMaterializationOutcome(): RuntimeConfigCharacterMaterializationOutcome {
  return Object.freeze({
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
    readonly document: JsonBoundaryObject;
    /** Drives the commit decision; never leaves this file. */
    readonly configChanged: boolean;
  };

/** Only ever adds what is missing; an authored value is never overwritten. */
function mergeCharacterMaterializationIntoOverlay(options: {
  readonly current: JsonBoundaryObject;
  readonly materialization: RuntimeConfigCharacterMaterialization | undefined;
  readonly overlayAbsent: boolean;
}): CharacterMaterializationMerge {
  if (
    options.materialization === undefined ||
    (!options.overlayAbsent && !options.materialization.fillMissingFields)
  ) {
    return unmaterializedOverlayDocument(options.current, false);
  }

  const currentPlugins = authoredOverlaySection(options.current, 'plugins');

  // Left untouched so the candidate validation names the real problem.
  if (currentPlugins.status === 'malformed') {
    return unmaterializedOverlayDocument(
      options.current,
      options.overlayAbsent,
    );
  }

  const authoredPlugins =
    currentPlugins.status === 'object' ? currentPlugins.value : undefined;
  const nextPlugins: Record<string, JsonBoundaryValue> = {...authoredPlugins};
  const autoEnabledPluginIds: string[] = [];
  let fieldsChanged = false;

  for (const pluginId of Object.keys(
    options.materialization.document.plugins ?? {},
  ).sort((left, right) => left.localeCompare(right))) {
    const defaults = options.materialization.document.plugins?.[pluginId];
    const authored = ownJsonRecordValue(authoredPlugins, pluginId);

    if (
      defaults === undefined ||
      (authored !== undefined && !isJsonBoundaryObject(authored))
    ) {
      continue;
    }

    const merged = mergeCharacterPluginMaterialization(authored, defaults);

    if (!merged.changed) {
      continue;
    }

    fieldsChanged = true;
    nextPlugins[pluginId] = merged.plugin;
    if (merged.autoEnabled) {
      autoEnabledPluginIds.push(pluginId);
    }
  }

  const document = fieldsChanged
    ? Object.freeze({
        ...options.current,
        plugins: Object.freeze(nextPlugins),
      })
    : options.current;

  return Object.freeze({
    document,
    configChanged: options.overlayAbsent || fieldsChanged,
    autoEnabledPluginIds: Object.freeze(
      autoEnabledPluginIds.sort((left, right) => left.localeCompare(right)),
    ),
  });
}

function unmaterializedOverlayDocument(
  document: JsonBoundaryObject,
  configChanged: boolean,
): CharacterMaterializationMerge {
  return Object.freeze({
    document,
    configChanged,
    autoEnabledPluginIds: Object.freeze([]),
  });
}

/** Absent and malformed stay apart: one is filled in, one is reported. */
type AuthoredOverlaySection =
  | {readonly status: 'absent'}
  | {readonly status: 'malformed'}
  | {readonly status: 'object'; readonly value: JsonBoundaryObject};

const absentAuthoredOverlaySection: AuthoredOverlaySection = Object.freeze({
  status: 'absent',
});

const malformedAuthoredOverlaySection: AuthoredOverlaySection = Object.freeze({
  status: 'malformed',
});

function authoredOverlaySection(
  document: JsonBoundaryObject,
  key: string,
): AuthoredOverlaySection {
  const value = document[key];

  if (value === undefined) {
    return absentAuthoredOverlaySection;
  }

  return isJsonBoundaryObject(value)
    ? Object.freeze({status: 'object', value})
    : malformedAuthoredOverlaySection;
}

function mergeCharacterPluginMaterialization(
  existing: JsonBoundaryObject | undefined,
  defaults: Project02RuntimePluginConfig,
): {
  readonly plugin: JsonBoundaryObject;
  readonly changed: boolean;
  readonly autoEnabled: boolean;
} {
  const authoredEnabled = existing?.['enabled'];
  const enablementAdded =
    authoredEnabled === undefined && defaults.enabled !== undefined;
  const config = mergeMissingCharacterPluginConfig({
    current: authoredOverlaySection(existing ?? {}, 'config'),
    defaults: defaults.config,
    createEmpty: existing === undefined,
  });
  const changed =
    existing === undefined || enablementAdded || config.fieldsChanged;
  const enabled = authoredEnabled ?? defaults.enabled;

  return Object.freeze({
    // Preserved, not rebuilt: an invalid authored field survives to be named.
    plugin: changed
      ? Object.freeze({
          ...existing,
          ...(enabled === undefined ? {} : {enabled}),
          ...(config.value === undefined ? {} : {config: config.value}),
        })
      : existing,
    changed,
    autoEnabled: enablementAdded && defaults.enabled,
  });
}

function mergeMissingCharacterPluginConfig(options: {
  readonly current: AuthoredOverlaySection;
  readonly defaults: Project02RuntimePluginConfig['config'];
  readonly createEmpty: boolean;
}): {
  readonly value: JsonBoundaryObject | undefined;
  readonly fieldsChanged: boolean;
} {
  // A malformed config is not a missing one; filling it would erase authoring.
  if (options.current.status === 'malformed') {
    return Object.freeze({value: undefined, fieldsChanged: false});
  }

  const current =
    options.current.status === 'object' ? options.current.value : undefined;
  const missingEntries = Object.entries(options.defaults ?? {})
    .filter(([fieldName]) => !Object.hasOwn(current ?? {}, fieldName))
    .sort(([left], [right]) => left.localeCompare(right));
  const fieldsChanged = missingEntries.length > 0;
  const shouldMaterialize =
    options.defaults !== undefined && (options.createEmpty || fieldsChanged);

  return Object.freeze({
    value: shouldMaterialize
      ? Object.freeze({
          ...current,
          ...Object.fromEntries(missingEntries),
        })
      : current,
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
      autoEnabledPluginIds: Object.freeze([...outcome.autoEnabledPluginIds]),
    }),
  });
}
