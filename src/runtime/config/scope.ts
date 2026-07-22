/**
 * Scope-aware runtime config mutations: the same control operations,
 * targeted at either the global config.json or one character's
 * overlay. Global scope delegates to the existing control functions
 * unchanged. Character scope rejects global-only fields and secret
 * operations, verifies the caller's layered expectation across both
 * authored documents, and then runs the untouched per-file mutation
 * machinery against the overlay file — never the global one, and never
 * through the global bootstrap (which would seed a store root into the
 * overlay): an absent overlay is first materialized as a minimal
 * versioned document.
 */
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

import {isNodeErrorWithCode} from '../../shared/node-error.ts';
import {
  createProject02HomeLayout,
  homeRootForCharacterDataDir,
} from '../storage/layout-contract.ts';
import {acquireLocalRuntimeMutationLockSync} from '../storage/mutation-lock.ts';
import type {RuntimePluginManifest} from '../../plugins/api/index.ts';
import {
  applyRuntimeConfigControlOperation,
  applyRuntimePluginConfigControlOperation,
  prepareRuntimePluginConfigControlOperation,
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
import {loadProject02RuntimeConfig} from './load.ts';
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
import {
  project02RuntimeConfigFieldDefinitions,
  runtimeConfigValueMatchesField,
  type Project02ConfigFieldDefinition,
} from './schema.ts';
import {
  runtimeConfigVersion,
  type LoadedProject02RuntimeConfig,
  type Project02RuntimeConfig,
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

export type ResolvedRuntimeConfigScopeTarget = {
  readonly scope: RuntimeConfigMutationScopeSelector;
  /** The file this scope's mutations write. */
  readonly configPath: string;
  readonly characterScope?: RuntimeConfigCharacterScope;
  /** project02.* fields this scope may author. */
  readonly allowedProject02Fields: readonly Project02ConfigFieldDefinition[];
  readonly secretOpsAllowed: boolean;
};

/**
 * Names the file, field allowlist, and secret policy for one scope.
 * Character scope requires a derivable character (configured id +
 * resolvable home); anything else is a usage error, not a fallback.
 */
export function resolveRuntimeConfigScopeTarget(
  options: ScopedRuntimeConfigLocation & {
    readonly scope: RuntimeConfigMutationScopeSelector;
  },
): ResolvedRuntimeConfigScopeTarget {
  const loadedConfig = loadProject02RuntimeConfig(options);

  if (options.scope === 'global') {
    return Object.freeze({
      scope: 'global',
      configPath: resolveRuntimeConfigControlTargetPath(options),
      allowedProject02Fields: project02RuntimeConfigFieldDefinitions(),
      secretOpsAllowed: true,
    });
  }

  const characterScope = requiredCharacterScope(loadedConfig, options);

  return Object.freeze({
    scope: 'character',
    configPath: characterOverlayConfigPath(characterScope.dataRoot),
    characterScope,
    allowedProject02Fields: project02RuntimeConfigFieldDefinitions().filter(
      field => field.scopes.includes('character'),
    ),
    secretOpsAllowed: false,
  });
}

export function assertRuntimeConfigSecretScopeAllowed(
  scope: RuntimeConfigMutationScopeSelector,
): void {
  if (scope === 'character') {
    throw new RuntimeConfigMutationError(
      'Secrets are shared across characters; run the secret command ' +
        'without --character.',
    );
  }
}

export function applyScopedRuntimeConfigControlOperation(
  options: ScopedRuntimeConfigLocation & {
    readonly scope: RuntimeConfigMutationScopeSelector;
    readonly expectedFingerprint?: string;
    readonly operation: RuntimeConfigControlOperation;
  },
): RuntimeConfigMutationResult {
  if (options.scope === 'global') {
    return applyRuntimeConfigControlOperation(options);
  }

  assertCharacterScopedControlOperation(options.operation);

  return applyCharacterScopedMutation({
    ...options,
    operation: options.operation,
  });
}

export function applyScopedRuntimePluginConfigControlOperation(
  options: ScopedRuntimeConfigLocation & {
    readonly scope: RuntimeConfigMutationScopeSelector;
    readonly manifest: RuntimePluginManifest;
    readonly actor: RuntimePluginConfigControlActor;
    readonly expectedFingerprint: string;
    readonly operation: RuntimePluginConfigFieldControlOperation;
  },
): RuntimeConfigMutationResult {
  if (options.scope === 'global') {
    return applyRuntimePluginConfigControlOperation(options);
  }

  if (options.operation.kind === 'secret_set') {
    assertRuntimeConfigSecretScopeAllowed('character');
  }

  const mutation = runtimePluginConfigControlMutation(options);

  return applyCharacterScopedMutation({
    ...options,
    operation: mutation.operation,
    // The manifest-aware candidate validation must see what the runtime
    // will actually resolve: the overlay candidate merged over the
    // current global document, not the sparse overlay alone.
    validateCandidate: (candidate, globalDocument) => {
      mutation.validateCandidate(
        mergeCharacterOverlayDocument(globalDocument, candidate),
      );
    },
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
 * rejected here, before any ensure step materializes a stamp or data
 * marker for the character.
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
 * overlay (the mutation machinery takes the overlay's own lock inside),
 * and no path takes them in the reverse order.
 */
function withGlobalConfigLayerLock<T>(
  options: ScopedRuntimeConfigLocation,
  run: (context: {
    readonly loadedConfig: ReturnType<typeof loadProject02RuntimeConfig>;
    readonly globalDocument: Project02RuntimeConfig;
  }) => T,
): T {
  const globalLayerLocation = scopedGlobalLayerLocation(options);
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
function scopedGlobalLayerLocation(
  options: ScopedRuntimeConfigLocation,
): ScopedRuntimeConfigLocation {
  if (options.configPath === undefined) {
    return options;
  }

  const scope =
    options.characterScope ??
    deriveRuntimeConfigCharacterScope({
      loadedConfig: loadProject02RuntimeConfig(options),
      ...(options.storeRoot === undefined
        ? {}
        : {storeRoot: options.storeRoot}),
      ...(options.characterId === undefined
        ? {}
        : {characterId: options.characterId}),
    });

  if (
    scope === undefined ||
    canonicalRuntimeConfigMutationPath(options.configPath.trim()) !==
      canonicalRuntimeConfigMutationPath(
        characterOverlayConfigPath(scope.dataRoot),
      )
  ) {
    return options;
  }

  return Object.freeze({
    ...(options.env === undefined ? {} : {env: options.env}),
    storeRoot: homeRootForCharacterDataDir(scope.dataRoot),
    ...(options.characterId === undefined
      ? {}
      : {characterId: options.characterId}),
    ...(options.characterScope === undefined
      ? {}
      : {characterScope: options.characterScope}),
  });
}

/**
 * The global layer a scoped read composes against: the OWNING home's
 * config, even when --config aliases the overlay itself.
 */
export function loadScopedGlobalLayerConfig(
  options: ScopedRuntimeConfigLocation,
): LoadedProject02RuntimeConfig {
  return loadProject02RuntimeConfig(scopedGlobalLayerLocation(options));
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
    loadProject02RuntimeConfig(scopedGlobalLayerLocation(options)),
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
    readonly operation: Parameters<
      typeof applyRuntimeConfigMutation
    >[0]['operation'];
    readonly validateCandidate?: (
      candidate: Project02RuntimeConfig,
      globalDocument: Project02RuntimeConfig,
    ) => void;
  },
): RuntimeConfigMutationResult {
  return withGlobalConfigLayerLock(
    options,
    ({loadedConfig, globalDocument}) => {
      const characterScope = requiredCharacterScope(loadedConfig, options);
      const overlayPath = characterOverlayConfigPath(characterScope.dataRoot);

      // The stamp is the proof that the guarded initializer ran for
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

      // Validate the candidate against a synthetic base BEFORE an
      // absent overlay is materialized: a rejected edit must not leave
      // a fresh overlay behind (that would move the layered
      // fingerprint for a failed change).
      prepareRuntimeConfigMutationCandidate({
        loadedConfig: {
          source: 'path',
          path: overlayPath,
          config:
            overlay.config ??
            Object.freeze({
              version: runtimeConfigVersion,
            } satisfies Project02RuntimeConfig),
          diagnostics: Object.freeze([]),
        },
        configPath: overlayPath,
        operation: options.operation,
        validateCandidate: candidate => {
          assertOverlayLocatedCandidateStaysCharacterScoped(candidate);
          options.validateCandidate?.(candidate, globalDocument);
        },
      });

      const overlayBase = ensureMinimalOverlayDocument(overlayPath, overlay);
      const result = applyRuntimeConfigMutation({
        configPath: overlayPath,
        // This seam's callers initialize the data directory (home
        // guard plus stamp) before mutating; see the option's doc.
        characterScopeManaged: true,
        ...(options.env === undefined ? {} : {env: options.env}),
        operation: options.operation,
        ...(options.expectedFingerprint === undefined
          ? {}
          : {expectedFingerprint: createRuntimeConfigFingerprint(overlayBase)}),
        validateCandidate: candidate => {
          assertOverlayLocatedCandidateStaysCharacterScoped(candidate);
          options.validateCandidate?.(candidate, globalDocument);
        },
      });

      return Object.freeze({
        ...result,
        fingerprint: createLayeredRuntimeConfigFingerprint({
          globalConfig: globalDocument,
          characterId: characterScope.characterId,
          overlayConfig: result.config,
        }),
      });
    },
  );
}

/**
 * Read-only twin of the scoped apply: verifies the layered expectation
 * and names the committed fingerprint and target path without writing
 * anything — an absent overlay stays absent until the apply.
 */
export function prepareScopedRuntimePluginConfigControlOperation(
  options: ScopedRuntimeConfigLocation & {
    readonly scope: RuntimeConfigMutationScopeSelector;
    readonly manifest: RuntimePluginManifest;
    readonly actor: RuntimePluginConfigControlActor;
    readonly expectedFingerprint: string;
    readonly operation: RuntimePluginConfigFieldControlOperation;
  },
): {
  readonly resultFingerprint: string;
  readonly targetConfigPath: string;
} {
  if (options.scope === 'global') {
    return prepareRuntimePluginConfigControlOperation(options);
  }

  if (options.operation.kind === 'secret_set') {
    assertRuntimeConfigSecretScopeAllowed('character');
  }

  const mutation = runtimePluginConfigControlMutation(options);

  return withGlobalConfigLayerLock(
    options,
    ({loadedConfig, globalDocument}) => {
      const characterScope = requiredCharacterScope(loadedConfig, options);
      const overlayPath = characterOverlayConfigPath(characterScope.dataRoot);

      // The stamp is the proof that the guarded initializer ran for
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
        operation: mutation.operation,
        validateCandidate: candidate => {
          assertOverlayLocatedCandidateStaysCharacterScoped(candidate);
          mutation.validateCandidate(
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

/**
 * Materializes an absent overlay as the minimal versioned document so
 * the mutation base never routes through the global bootstrap. Losing
 * the creation race to a sibling is fine: the mutation lock serializes
 * the writes that follow.
 */
function ensureMinimalOverlayDocument(
  overlayPath: string,
  overlay: LoadedProject02CharacterOverlayConfig,
): Project02RuntimeConfig {
  if (overlay.config !== undefined) {
    return overlay.config;
  }

  const minimalDocument = Object.freeze({
    version: runtimeConfigVersion,
  } satisfies Project02RuntimeConfig);

  mkdirSync(dirname(overlayPath), {recursive: true});

  try {
    writeFileSync(
      overlayPath,
      `${JSON.stringify(minimalDocument, null, 2)}\n`,
      {flag: 'wx'},
    );
  } catch (error: unknown) {
    if (!isNodeErrorWithCode(error, 'EEXIST')) {
      throw error;
    }
  }

  return minimalDocument;
}
