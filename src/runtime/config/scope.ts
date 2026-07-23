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
import {basename, dirname} from 'node:path';

import {
  createProject02HomeLayout,
  homeRootForCharacterDataDir,
} from '../storage/layout-contract.ts';
import {acquireLocalRuntimeMutationLockSync} from '../storage/mutation-lock.ts';
import type {RuntimePluginManifest} from '../../plugins/api/index.ts';
import {
  applyGlobalRuntimeConfigControlMutation,
  assertRuntimeConfigControlOperation,
  prepareGlobalRuntimeConfigControlMutation,
  resolveRuntimeConfigControlTargetPath,
  runtimePluginConfigControlMutation,
  type RuntimeConfigControlOperation,
  type RuntimePluginConfigControlActor,
  type RuntimePluginConfigFieldControlOperation,
} from './control.ts';
import {
  createLayeredRuntimeConfigFingerprint,
  createRuntimeConfigFingerprint,
} from './fingerprint.ts';
import {defaultRuntimeConfigPath, loadProject02RuntimeConfig} from './load.ts';
import {
  applyRuntimeConfigMutation,
  assertOverlayLocatedCandidateStaysCharacterScoped,
  assertOverlayLocatedTargetIsInitialized,
  canonicalRuntimeConfigMutationPath,
  characterOverlayGlobalOnlyFieldMessage,
  createRuntimeConfigMutationBase,
  prepareRuntimeConfigMutationCandidate,
  RuntimeConfigConflictError,
  RuntimeConfigMutationError,
  selectedConfigPathIsCharacterOverlay,
  type RuntimeConfigMutationResult,
} from './mutate.ts';
import {
  characterOverlayConfigPath,
  characterOverlayFingerprintLayer,
  deriveRuntimeConfigCharacterScope,
  loadCharacterOverlayForScope,
  type LoadedProject02CharacterOverlayConfig,
} from './overlay.ts';
import {mergeCharacterOverlayDocument} from './resolve-layered.ts';
import {resolveProject02RuntimeStoreRoot} from './resolve.ts';
import {
  project02RuntimeConfigFieldDefinitions,
  runtimeConfigValueMatchesField,
} from './schema.ts';
import {runtimePluginScopeViolation} from './plugin-scope.ts';
import {
  runtimeConfigEnvVarName,
  runtimeConfigVersion,
  type LoadedProject02RuntimeConfig,
  type Project02RuntimeConfig,
  type Project02RuntimePluginConfig,
  type RuntimeConfigCharacterScope,
  type RuntimeConfigMutationOperation,
} from './types.ts';

export type RuntimeConfigMutationScopeSelector = 'global' | 'character';

type ScopedRuntimeConfigLocation = {
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly storeRoot?: string;
  /** Explicit character id (e.g. --character); wins over the configured one. */
  readonly characterId?: string;
  /**
   * Full explicit scope (id + data root), e.g. from a plugin host's
   * control state. Wins over any derivation: a host's storeRoot is the
   * character DATA root, and re-deriving from it would nest the path.
   */
  readonly characterScope?: RuntimeConfigCharacterScope;
};

type ResolvedRuntimeConfigScopeTargetBase = {
  /** The file this target's mutations write. */
  readonly configPath: string;
  /** Stable identity used by prepared-effect reconciliation. */
  readonly canonicalConfigPath: string;
  /** The authoritative home config composed with the target. */
  readonly globalConfigPath: string;
  readonly homeRoot: string;
  /** Preserves whether the caller explicitly selected a store. */
  readonly selectedStoreRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
};

export type ResolvedRuntimeConfigScopeTarget =
  | (ResolvedRuntimeConfigScopeTargetBase & {
      readonly scope: 'global';
      /**
       * Only an explicitly supplied scope is retained. Otherwise global
       * writes re-derive the active character after committing so a
       * project02.character change fingerprints the new overlay.
       */
      readonly characterScope?: RuntimeConfigCharacterScope;
    })
  | (ResolvedRuntimeConfigScopeTargetBase & {
      readonly scope: 'character';
      readonly characterScope: RuntimeConfigCharacterScope;
    });

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
  const globalLayerLocation =
    options.scope === 'character'
      ? resolveScopedGlobalLayerLocation(options)
      : options;
  const loadedConfig = loadProject02RuntimeConfig(globalLayerLocation);
  const globalConfigPath =
    loadedConfig.path ??
    globalLayerLocation.configPath ??
    defaultRuntimeConfigPath(globalLayerLocation.storeRoot);
  const canonicalGlobalConfigPath =
    canonicalRuntimeConfigMutationPath(globalConfigPath);
  const homeRoot = resolveProject02RuntimeStoreRoot({
    loadedConfig,
    ...(globalLayerLocation.storeRoot === undefined
      ? {}
      : {storeRoot: globalLayerLocation.storeRoot}),
  });
  const shared = {
    globalConfigPath,
    homeRoot,
    ...(options.storeRoot === undefined
      ? {}
      : {selectedStoreRoot: options.storeRoot}),
    ...(options.env === undefined ? {} : {env: options.env}),
  };

  if (options.scope === 'global') {
    return Object.freeze({
      ...shared,
      scope: 'global',
      configPath: globalConfigPath,
      canonicalConfigPath: canonicalGlobalConfigPath,
      ...(options.characterScope === undefined
        ? {}
        : {characterScope: options.characterScope}),
    });
  }

  const characterScope = requiredCharacterScope(loadedConfig, {
    storeRoot: homeRoot,
    ...(globalLayerLocation.characterId === undefined
      ? {}
      : {characterId: globalLayerLocation.characterId}),
    ...(globalLayerLocation.characterScope === undefined
      ? {}
      : {characterScope: globalLayerLocation.characterScope}),
  });

  const characterConfigPath = characterOverlayConfigPath(
    characterScope.dataRoot,
  );

  return Object.freeze({
    ...shared,
    scope: 'character',
    configPath: characterConfigPath,
    canonicalConfigPath:
      canonicalRuntimeConfigMutationPath(characterConfigPath),
    characterScope,
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

  if (options.target.scope === 'global') {
    if (mutation.operation === undefined) {
      throw new TypeError(
        'Global runtime config control requires an operation.',
      );
    }

    const result = applyGlobalRuntimeConfigControlMutation({
      configPath: options.target.configPath,
      ...(options.target.env === undefined ? {} : {env: options.target.env}),
      ...(options.target.selectedStoreRoot === undefined
        ? {}
        : {storeRoot: options.target.selectedStoreRoot}),
      ...(options.target.characterScope === undefined
        ? {}
        : {characterScope: options.target.characterScope}),
      ...(options.expectedFingerprint === undefined
        ? {}
        : {expectedFingerprint: options.expectedFingerprint}),
      operation: mutation.operation,
      ...(mutation.validateCandidate === undefined
        ? {}
        : {validateCandidate: mutation.validateCandidate}),
    });

    return withMaterializationOutcome(result, {
      configChanged: false,
      autoEnabledPluginIds: Object.freeze([]),
    });
  }

  return applyCharacterScopedMutation({
    configPath: options.target.globalConfigPath,
    storeRoot: options.target.homeRoot,
    characterScope: options.target.characterScope,
    ...(options.target.env === undefined ? {} : {env: options.target.env}),
    ...(options.expectedFingerprint === undefined
      ? {}
      : {expectedFingerprint: options.expectedFingerprint}),
    ...(mutation.operation === undefined
      ? {}
      : {operation: mutation.operation}),
    ...(options.characterMaterialization === undefined
      ? {}
      : {materialization: options.characterMaterialization}),
    ...(mutation.validateCandidate === undefined
      ? {}
      : {
          validateCandidate: (candidate, globalDocument) => {
            mutation.validateCandidate?.(
              mergeCharacterOverlayDocument(globalDocument, candidate),
            );
          },
        }),
  });
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

  if (options.target.scope === 'global') {
    return prepareGlobalRuntimeConfigControlMutation({
      configPath: options.target.configPath,
      ...(options.target.env === undefined ? {} : {env: options.target.env}),
      ...(options.target.selectedStoreRoot === undefined
        ? {}
        : {storeRoot: options.target.selectedStoreRoot}),
      ...(options.target.characterScope === undefined
        ? {}
        : {characterScope: options.target.characterScope}),
      expectedFingerprint: options.expectedFingerprint,
      operation: mutation.operation,
      ...(mutation.validateCandidate === undefined
        ? {}
        : {validateCandidate: mutation.validateCandidate}),
    });
  }

  return prepareCharacterRuntimeConfigControlMutation({
    target: options.target,
    expectedFingerprint: options.expectedFingerprint,
    operation: mutation.operation,
    ...(mutation.validateCandidate === undefined
      ? {}
      : {validateCandidate: mutation.validateCandidate}),
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
    authoredScope: target.scope,
    ...(target.env === undefined ? {} : {env: target.env}),
    ...(target.scope === 'character'
      ? {storeRoot: target.homeRoot}
      : target.selectedStoreRoot === undefined
        ? {}
        : {storeRoot: target.selectedStoreRoot}),
  });
}

/**
 * An overlay is one layer of the layered config: it cannot be verified
 * or merged against a global file that failed to load. A missing
 * default file is fine (defaults apply); anything else blocks the
 * scoped change before durable state is touched.
 */
export function assertGlobalConfigLoadableForCharacterScope(
  loadedConfig: LoadedProject02RuntimeConfig,
): void {
  const blockingDiagnostic = loadedConfig.diagnostics.find(
    diagnostic =>
      diagnostic.severity === 'error' &&
      diagnostic.code !== 'runtime_config_missing',
  );

  if (blockingDiagnostic !== undefined) {
    throw new RuntimeConfigMutationError(
      'Cannot change character-scoped config because the home config ' +
        `failed to load: ${blockingDiagnostic.message}`,
    );
  }
}

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

  if (!field.scopes.includes('character')) {
    throw new RuntimeConfigMutationError(
      characterOverlayGlobalOnlyFieldMessage(field.path),
    );
  }

  if (
    operation.kind === 'set' &&
    (!runtimeConfigValueMatchesField(operation.value, field) ||
      (typeof operation.value === 'string' &&
        operation.value.trim().length === 0))
  ) {
    throw new RuntimeConfigMutationError(
      `${field.invalidValueMessage} Path: ${operation.path}.`,
    );
  }
}

/**
 * Both layers loaded under the GLOBAL file's control lock: a scoped
 * mutation's layered expectation is only meaningful if the global layer
 * cannot move between the check and the overlay write, so the lock is
 * held across verify + mutate. Ordering is always global before
 * overlay (the mutation machinery takes the overlay's own lock inside);
 * every character-scoped apply and prepare path uses this order.
 */
function withGlobalConfigLayerLock<T>(
  options: ScopedRuntimeConfigLocation,
  run: (context: {
    readonly loadedConfig: ReturnType<typeof loadProject02RuntimeConfig>;
    readonly globalDocument: Project02RuntimeConfig;
  }) => T,
): T {
  const globalLayerLocation = resolveScopedGlobalLayerLocation(options);
  const canonicalGlobalPath = canonicalRuntimeConfigMutationPath(
    resolveRuntimeConfigControlTargetPath(globalLayerLocation),
  );
  const runWithLoadedConfig = () => {
    const loadedConfig = loadProject02RuntimeConfig(globalLayerLocation);

    assertGlobalConfigLoadableForCharacterScope(loadedConfig);

    return run({
      loadedConfig,
      globalDocument: createRuntimeConfigMutationBase({
        loadedConfig,
        ...(globalLayerLocation.configPath === undefined
          ? {}
          : {configPath: globalLayerLocation.configPath}),
        ...(globalLayerLocation.storeRoot === undefined
          ? {}
          : {storeRoot: globalLayerLocation.storeRoot}),
      }),
    });
  };
  const globalLock = acquireLocalRuntimeMutationLockSync({
    locksRoot: createProject02HomeLayout({
      homeRoot: dirname(canonicalGlobalPath),
    }).locksRoot,
    resourceKey: `runtime-control-file:${canonicalGlobalPath}`,
  });

  try {
    return runWithLoadedConfig();
  } finally {
    globalLock.release();
  }
}

/**
 * The location the scoped machinery reads its GLOBAL layer from. A
 * --config pointed at the overlay itself is not a global layer — the
 * overlay is the mutation TARGET — so the global document is re-pointed
 * at the OWNING home. That also keeps the global-layer lock on the home
 * config instead of the overlay file (which the mutation itself locks),
 * so the aliased case cannot self-deadlock.
 */
export function resolveScopedGlobalLayerLocation(
  options: ScopedRuntimeConfigLocation,
): ScopedRuntimeConfigLocation {
  const selectedPath =
    options.configPath ??
    (options.storeRoot === undefined
      ? (options.env ?? process.env)[runtimeConfigEnvVarName]
      : undefined);

  if (selectedPath === undefined || selectedPath.trim().length === 0) {
    return options;
  }

  const canonicalSelected = canonicalRuntimeConfigMutationPath(
    selectedPath.trim(),
  );

  if (!selectedConfigPathIsCharacterOverlay(canonicalSelected)) {
    return options;
  }

  const selectedDataRoot = dirname(canonicalSelected);
  const selectedCharacterId = basename(selectedDataRoot);
  const requestedCharacterId =
    options.characterScope?.characterId ?? options.characterId;
  const selectedOverlayMatchesScope =
    requestedCharacterId === undefined ||
    (requestedCharacterId === selectedCharacterId &&
      (options.characterScope === undefined ||
        canonicalRuntimeConfigMutationPath(
          characterOverlayConfigPath(options.characterScope.dataRoot),
        ) === canonicalSelected));

  if (!selectedOverlayMatchesScope) {
    throw new RuntimeConfigMutationError(
      `Config path "${canonicalSelected}" is another character's ` +
        `overlay; it cannot serve as the global layer for character ` +
        `"${requestedCharacterId}".`,
    );
  }

  return Object.freeze({
    ...(options.env === undefined ? {} : {env: options.env}),
    storeRoot: homeRootForCharacterDataDir(selectedDataRoot),
    characterId: options.characterId ?? selectedCharacterId,
    ...(options.characterScope === undefined
      ? {}
      : {characterScope: options.characterScope}),
  });
}

/**
 * Read-only preflight for CLI verbs: validates the global layer the
 * scoped machinery will actually read (the OWNING home's config, even
 * when --config aliases the overlay), before ensure materializes any
 * durable character state.
 */
export function assertScopedGlobalLayerLoadable(
  options: ScopedRuntimeConfigLocation,
): void {
  assertGlobalConfigLoadableForCharacterScope(
    loadProject02RuntimeConfig(resolveScopedGlobalLayerLocation(options)),
  );
}

function verifyScopedExpectation(options: {
  readonly expectedFingerprint: string | undefined;
  readonly globalDocument: Project02RuntimeConfig;
  readonly characterScope: RuntimeConfigCharacterScope;
  readonly overlay: LoadedProject02CharacterOverlayConfig;
}): void {
  if (options.expectedFingerprint === undefined) {
    return;
  }

  const currentFingerprint = createLayeredRuntimeConfigFingerprint({
    globalConfig: options.globalDocument,
    characterId: options.characterScope.characterId,
    overlayConfig: characterOverlayFingerprintLayer(options.overlay),
  });

  if (options.expectedFingerprint !== currentFingerprint) {
    throw new RuntimeConfigConflictError(
      'Runtime config changed before the mutation could be committed. ' +
        `Expected ${options.expectedFingerprint}, found ${currentFingerprint}.`,
    );
  }
}

function applyCharacterScopedMutation(
  options: ScopedRuntimeConfigLocation & {
    readonly expectedFingerprint?: string;
    readonly operation?: Parameters<
      typeof applyRuntimeConfigMutation
    >[0]['operation'];
    readonly materialization?: RuntimeConfigCharacterMaterialization;
    readonly validateCandidate?: (
      candidate: Project02RuntimeConfig,
      globalDocument: Project02RuntimeConfig,
    ) => void;
  },
): RuntimeConfigControlApplyResult {
  return withGlobalConfigLayerLock(
    options,
    ({loadedConfig, globalDocument}) => {
      const characterScope = requiredCharacterScope(loadedConfig, options);
      const overlayPath = characterOverlayConfigPath(characterScope.dataRoot);

      // The marker is the proof that the guarded initializer ran for
      // this directory; without it no scoped write — not even from a
      // plugin-control state — may create durable character state.
      assertOverlayLocatedTargetIsInitialized(
        canonicalRuntimeConfigMutationPath(overlayPath),
      );

      const overlay = loadCharacterOverlayForScope(characterScope);

      assertOverlayMutable(overlay);
      verifyScopedExpectation({
        expectedFingerprint: options.expectedFingerprint,
        globalDocument,
        characterScope,
        overlay,
      });

      const overlayBase =
        overlay.config ??
        Object.freeze({
          version: runtimeConfigVersion,
        } satisfies Project02RuntimeConfig);
      let materializationOutcome = mergeCharacterMaterializationIntoOverlay({
        current: overlayBase,
        materialization: options.materialization,
        overlayAbsent: overlay.config === undefined,
      });
      const transformBase =
        options.materialization === undefined
          ? undefined
          : (current: Project02RuntimeConfig) => {
              materializationOutcome = mergeCharacterMaterializationIntoOverlay(
                {
                  current,
                  materialization: options.materialization,
                  overlayAbsent: overlay.config === undefined,
                },
              );

              return materializationOutcome.config;
            };

      if (
        options.operation === undefined &&
        !materializationOutcome.configChanged
      ) {
        return withMaterializationOutcome(
          {
            configPath: overlayPath,
            envPath: createProject02HomeLayout(
              options.storeRoot === undefined
                ? {}
                : {homeRoot: options.storeRoot},
            ).envPath,
            config: overlayBase,
            fingerprint: createLayeredRuntimeConfigFingerprint({
              globalConfig: globalDocument,
              characterId: characterScope.characterId,
              overlayConfig: overlayBase,
            }),
          },
          materializationOutcome,
        );
      }

      const result = applyRuntimeConfigMutation({
        configPath: overlayPath,
        // This seam's callers initialize the data directory (home
        // guard plus marker) before mutating; see the option's doc.
        characterScopeManaged: true,
        ...(options.env === undefined ? {} : {env: options.env}),
        ...(options.operation === undefined
          ? {}
          : {operation: options.operation}),
        ...(transformBase === undefined ? {} : {transformBase}),
        // A direct overlay writer does not take the global-layer lock.
        // Pin the exact overlay base too so it cannot be overwritten.
        expectedFingerprint: createRuntimeConfigFingerprint(overlayBase),
        validateCandidate: candidate => {
          assertOverlayLocatedCandidateStaysCharacterScoped(candidate);
          options.validateCandidate?.(candidate, globalDocument);
        },
      });

      return withMaterializationOutcome(
        Object.freeze({
          ...result,
          fingerprint: createLayeredRuntimeConfigFingerprint({
            globalConfig: globalDocument,
            characterId: characterScope.characterId,
            overlayConfig: result.config,
          }),
        }),
        materializationOutcome,
      );
    },
  );
}

/**
 * Read-only twin of the scoped apply: verifies the layered expectation
 * and names the committed fingerprint and target path without writing
 * anything — an absent overlay stays absent until the apply.
 */
function prepareCharacterRuntimeConfigControlMutation(options: {
  readonly target: Extract<
    ResolvedRuntimeConfigScopeTarget,
    {readonly scope: 'character'}
  >;
  readonly expectedFingerprint: string;
  readonly operation: RuntimeConfigMutationOperation;
  readonly validateCandidate?: (config: Project02RuntimeConfig) => void;
}): {
  readonly resultFingerprint: string;
  readonly targetConfigPath: string;
} {
  return withGlobalConfigLayerLock(
    {
      configPath: options.target.globalConfigPath,
      storeRoot: options.target.homeRoot,
      characterScope: options.target.characterScope,
      ...(options.target.env === undefined ? {} : {env: options.target.env}),
    },
    ({globalDocument}) => {
      const characterScope = options.target.characterScope;
      const overlayPath = options.target.configPath;

      // The marker is the proof that the guarded initializer ran for
      // this directory; without it no scoped write — not even from a
      // plugin-control state — may create durable character state.
      assertOverlayLocatedTargetIsInitialized(
        canonicalRuntimeConfigMutationPath(overlayPath),
      );

      const overlay = loadCharacterOverlayForScope(characterScope);

      assertOverlayMutable(overlay);
      verifyScopedExpectation({
        expectedFingerprint: options.expectedFingerprint,
        globalDocument,
        characterScope,
        overlay,
      });

      const overlayBase =
        overlay.config ??
        Object.freeze({
          version: runtimeConfigVersion,
        } satisfies Project02RuntimeConfig);
      const prepared = prepareRuntimeConfigMutationCandidate({
        loadedConfig: {
          source: 'path',
          path: overlayPath,
          config: overlayBase,
          diagnostics: Object.freeze([]),
        },
        configPath: overlayPath,
        operation: options.operation,
        validateCandidate: candidate => {
          assertOverlayLocatedCandidateStaysCharacterScoped(candidate);
          options.validateCandidate?.(
            mergeCharacterOverlayDocument(globalDocument, candidate),
          );
        },
      });

      return Object.freeze({
        resultFingerprint: createLayeredRuntimeConfigFingerprint({
          globalConfig: globalDocument,
          characterId: characterScope.characterId,
          overlayConfig: prepared.config,
        }),
        targetConfigPath: canonicalRuntimeConfigMutationPath(overlayPath),
      });
    },
  );
}

function requiredCharacterScope(
  loadedConfig: ReturnType<typeof loadProject02RuntimeConfig>,
  options: {
    readonly storeRoot?: string;
    readonly characterId?: string;
    readonly characterScope?: RuntimeConfigCharacterScope;
  },
): RuntimeConfigCharacterScope {
  const characterScope =
    options.characterScope ??
    deriveRuntimeConfigCharacterScope({
      loadedConfig,
      ...(options.storeRoot === undefined
        ? {}
        : {storeRoot: options.storeRoot}),
      ...(options.characterId === undefined
        ? {}
        : {characterId: options.characterId}),
    });

  if (characterScope === undefined) {
    throw new RuntimeConfigMutationError(
      'Character scope is unavailable: the configured character id or ' +
        'store root does not form a character-data path.',
    );
  }

  return characterScope;
}

function assertOverlayMutable(
  overlay: LoadedProject02CharacterOverlayConfig,
): void {
  const blocking = overlay.diagnostics.find(
    diagnostic => diagnostic.severity === 'error',
  );

  if (blocking !== undefined) {
    throw new RuntimeConfigMutationError(
      `Cannot mutate the character overlay because it failed to load: ${blocking.message}`,
    );
  }
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
