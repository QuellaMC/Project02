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
  assertGlobalConfigLoadableForCharacterScope,
  readRuntimeConfigControlSnapshot,
  verifyRuntimeConfigControlExpectation,
  type RuntimeConfigControlSnapshot,
} from './control-transaction.ts';
import {createLayeredRuntimeConfigFingerprint} from './fingerprint.ts';
import {
  loadProject02RuntimeConfigForLocation,
  requireResolvedRuntimeConfigScopeTarget,
  type ResolvedProject02ConfigLocation,
  type ResolvedProject02RuntimeLocation,
  type ResolvedRuntimeConfigScopeTarget,
} from './location.ts';
import {
  assertOverlayLocatedCandidateStaysCharacterScoped,
  prepareRuntimeConfigMutationCandidate,
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

export function applyRuntimeConfigControlOperation(options: {
  readonly target: ResolvedRuntimeConfigScopeTarget;
  readonly expectedFingerprint?: string;
  readonly request?: RuntimeConfigControlRequest;
  readonly characterMaterialization?: RuntimeConfigCharacterMaterialization;
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
    ...(options.expectedFingerprint === undefined
      ? {}
      : {expectedFingerprint: options.expectedFingerprint}),
    secretMutation: mutation.operation?.kind === 'secret_set',
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
      /**
       * The overlay document the commit would write. Startup judges its
       * plan against this rather than against the bytes on disk.
       */
      readonly document: Project02RuntimeConfig;
      readonly configChanged: boolean;
      readonly autoEnabledPluginIds: readonly string[];
    }
  | {readonly status: 'invalid'; readonly message: string};

/**
 * What the character overlay would contain if this materialization and
 * edit were committed, without committing anything.
 *
 * Startup used to answer "may I proceed?" from the overlay on disk, then
 * write, then discover the write was invalid — leaving a half-created
 * store behind a failed command. It also had to exempt the overlay's own
 * errors whenever a run carried an edit, on the theory that the edit
 * fixed them; an edit only fixes the values it touches, so a second bad
 * value slipped through to the commit. Simulating removes both: the plan
 * is judged against the result, so an edit that fixes everything passes
 * and one that leaves a value invalid is rejected before the first
 * directory exists.
 *
 * This runs the commit's own preparation — same merge, same candidate
 * validation — so the two cannot disagree. It never locks or writes, and
 * it does not require the data directory to exist yet.
 */
export function simulateCharacterOverlayCandidate(options: {
  readonly target: ResolvedRuntimeConfigScopeTarget;
  readonly request?: RuntimeConfigControlRequest;
  readonly characterMaterialization?: RuntimeConfigCharacterMaterialization;
}): SimulatedCharacterOverlayCandidate {
  const target = requireResolvedRuntimeConfigScopeTarget(options.target);

  if (target.scope !== 'character') {
    throw new TypeError(
      'Character overlay simulation requires a character-scoped target.',
    );
  }

  const mutation = normalizedControlMutation(target, options.request);

  try {
    const prepared = prepareScopedRuntimeConfigControlCandidate({
      target,
      snapshot: readRuntimeConfigControlSnapshot(target, {
        requireCharacterMarker: false,
      }),
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
      configChanged: prepared.context.configChanged,
      autoEnabledPluginIds: prepared.context.autoEnabledPluginIds,
    });
  } catch (error: unknown) {
    // The candidate being unacceptable is the answer, not a failure:
    // both the mutation seam's rejection and the validators' TypeError
    // describe config this startup must refuse. Anything else is a real
    // fault — a drifted target, an unreadable home — and keeps its own
    // identity through the caller's terminal-error path.
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

  const snapshot = readRuntimeConfigControlSnapshot(target);
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
    runtimeLocation: runtimeConfigControlCharacterLocation(target),
    authoredScope: target.scope,
    env: target.env,
  });
}

function runtimeConfigControlCharacterLocation(
  target: ResolvedRuntimeConfigScopeTarget,
): ResolvedProject02RuntimeLocation {
  const runtimeLocation =
    target.scope === 'character'
      ? target.runtimeLocation
      : target.characterRuntimeLocation;

  if (runtimeLocation === undefined) {
    throw new TypeError(
      'Plugin config control requires an activated character runtime.',
    );
  }

  return runtimeLocation;
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
export function assertScopedGlobalLayerLoadable(options: {
  readonly runtimeLocation: ResolvedProject02ConfigLocation;
  readonly env?: NodeJS.ProcessEnv;
}): void {
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

  // The authored document when the file was readable, so a repair edits
  // the operator's real bytes; the minimal versioned document only when
  // there is nothing on disk to edit. Never the global bootstrap, which
  // would seed a store root into the overlay.
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
      // The overlay's own authored layer: the shared preparer applies
      // the operation to these bytes and validates the whole candidate,
      // exactly as it does for the global document.
      authoredDocument: materialization.document,
      diagnostics: Object.freeze([]),
    },
    ...(options.operation === undefined ? {} : {operation: options.operation}),
    validateCandidate: candidate => {
      assertOverlayLocatedCandidateStaysCharacterScoped(candidate);
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
    });
  }

  return layeredRuntimeConfigFingerprintForScope({
    globalConfig: options.candidate,
    characterScope: options.snapshot.characterRuntimeLocation?.characterScope,
    overlay: options.snapshot.characterOverlay?.overlay,
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
    readonly document: JsonBoundaryObject;
  };

/**
 * Fills package-owned defaults into the overlay's authored document.
 * It only ever adds what is missing, so it composes with repair: an
 * authored value the package also defines stays exactly as written,
 * including one that is currently invalid and about to be fixed.
 */
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

  // A malformed plugins section cannot be materialized into. Leaving it
  // untouched keeps the authored bytes intact for the candidate
  // validation, which names the real problem instead of this merge
  // inventing a second error for the same document.
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

/**
 * What a document holds at `key`, keeping "nothing is here" apart from
 * "something is here, but it is not a section".
 *
 * Answering both with `undefined` is what let an authored value be
 * overwritten. A merge that fills in what is missing reads "malformed"
 * as "missing" and writes package defaults over the very bytes that are
 * the problem — so the operator loses what they wrote to a run that
 * reported nothing wrong. The two states differ in exactly the way that
 * matters here: absent is a thing to fill in, malformed is a thing to
 * report. Naming them separately makes every caller say which it means
 * rather than leaving one of the two to be remembered.
 */
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
    // The authored wrapper is preserved rather than rebuilt: an
    // unknown or invalid field an operator wrote stays in the document
    // for the candidate validation to name.
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
  // A malformed config is not a missing one, so there is nothing here to
  // fill in. Materializing into it would replace what the operator
  // authored with package defaults and report success, which is the one
  // outcome a merge that only ever adds must never produce. Contributing
  // no value leaves the authored bytes in the plugin wrapper below, where
  // the candidate validation names them as `plugins.<id>.config`.
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
      configChanged: outcome.configChanged,
      autoEnabledPluginIds: Object.freeze([...outcome.autoEnabledPluginIds]),
    }),
  });
}
