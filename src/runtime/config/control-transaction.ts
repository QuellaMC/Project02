/**
 * The one layered control transaction: every scoped or global control
 * mutation resolves its lock set here and acquires it in one canonical
 * order — the global config/env pair (canonically sorted) first, then
 * the active character's overlay — so concurrent global and character
 * mutations serialize instead of deadlocking in opposite acquisition
 * orders. The snapshot loaded under those locks (global document plus
 * guarded overlay) is the only state expectations verify against and
 * result fingerprints compose from, closing the verify-then-write gap
 * the old per-scope wrappers each solved separately.
 */
import {existsSync} from 'node:fs';
import {basename, dirname, resolve} from 'node:path';

import {
  characterDataDirectoryName,
  createProject02HomeLayout,
  LocalRuntimeStorageContractError,
} from '../storage/layout-contract.ts';
import {
  acquireLocalRuntimeMutationLockSync,
  createLocalRuntimeMutationLockOwnerToken,
  LocalRuntimeMutationLockBusyError,
  type LocalRuntimeMutationLockLeaseSync,
  type LocalRuntimeMutationLockOwnerToken,
  type LocalRuntimeMutationLocksLeaseSync,
} from '../storage/mutation-lock.ts';
import {loadProject02RuntimeConfig} from './load.ts';
import {
  acquireRuntimeConfigControlPairLease,
  assertOverlayLocatedTargetIsInitialized,
  assertRuntimeConfigMutationTargetSelectable,
  canonicalRuntimeConfigMutationPath,
  createRuntimeConfigMutationBase,
  RuntimeConfigConflictError,
  RuntimeConfigMutationError,
  RuntimeConfigPathDriftError,
  storeRootForSelectedDefaultConfigPath,
} from './mutate.ts';
import {
  characterOverlayConfigPath,
  deriveRuntimeConfigCharacterScope,
  layeredRuntimeConfigFingerprintForScope,
  loadCharacterOverlayForScope,
  type LoadedProject02CharacterOverlayConfig,
} from './overlay.ts';
import {
  runtimeConfigEnvVarName,
  type LoadedProject02RuntimeConfig,
  type Project02RuntimeConfig,
  type RuntimeConfigCharacterScope,
} from './types.ts';

export type LayeredControlLocation = {
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly storeRoot?: string;
  /** Explicit character id (e.g. --character); wins over the configured one. */
  readonly characterId?: string;
  /** Full explicit scope; wins over any derivation. */
  readonly characterScope?: RuntimeConfigCharacterScope;
};

export type LayeredControlSnapshot = {
  /** Re-enters the transaction's locks inside the mutation machinery. */
  readonly ownerToken: LocalRuntimeMutationLockOwnerToken;
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  /** Mutation base of the global layer (bootstrapped when absent). */
  readonly globalDocument: Project02RuntimeConfig;
  /** The global-layer file this transaction's mutations target. */
  readonly selectedGlobalPath: string;
  readonly canonicalGlobalPath: string;
  /**
   * The selection itself sits inside a character-data directory (judged
   * as written, not through symlinks): the overlay is the mutation
   * TARGET there, and the mutation machinery owns its precise marker
   * and symlink rejections.
   */
  readonly aliasedOverlaySelection: boolean;
  readonly characterScope: RuntimeConfigCharacterScope | undefined;
  /** Guarded overlay snapshot; undefined when no scope composes one. */
  readonly overlay: LoadedProject02CharacterOverlayConfig | undefined;
  /** Env path the lock set covers for a secret write. */
  readonly anticipatedEnvPath: string | undefined;
};

export type LayeredControlLockMode =
  /** Global pair plus overlay: the full mutation lock set. */
  | 'mutation'
  /** Only the global-layer file: read-only scoped preparation. */
  | 'global_layer'
  /** No locks: read-only verification the apply re-runs under locks. */
  | 'none';

const layeredControlDriftRetryLimit = 8;

/**
 * Loads the layered snapshot under the canonical lock order and runs
 * `run` against it. A path drift thrown by the mutation machinery
 * (config or env file moved while locking) releases every lock and
 * retries the whole transaction, so no attempt ever holds one lock
 * while acquiring another out of order.
 */
export function withLayeredControlSnapshot<T>(
  options: LayeredControlLocation & {
    readonly scopeSelector: 'global' | 'character';
    readonly lockMode: LayeredControlLockMode;
    readonly secretMutation?: boolean;
    /**
     * Present when the caller carries a layered expectation: the
     * overlay then always joins the snapshot (aliased selections
     * included), matching what the expectation fingerprinted.
     */
    readonly expectingFingerprint?: boolean;
  },
  run: (snapshot: LayeredControlSnapshot) => T,
): T {
  for (let attempt = 0; ; attempt += 1) {
    const leases: (
      LocalRuntimeMutationLocksLeaseSync | LocalRuntimeMutationLockLeaseSync
    )[] = [];

    try {
      return runLayeredControlAttempt(options, run, leases);
    } catch (error: unknown) {
      if (
        !(error instanceof RuntimeConfigPathDriftError) ||
        attempt >= layeredControlDriftRetryLimit
      ) {
        throw error;
      }
    } finally {
      for (const lease of [...leases].reverse()) {
        lease.release();
      }
    }
  }
}

function runLayeredControlAttempt<T>(
  options: Parameters<typeof withLayeredControlSnapshot>[0],
  run: (snapshot: LayeredControlSnapshot) => T,
  leases: (
    LocalRuntimeMutationLocksLeaseSync | LocalRuntimeMutationLockLeaseSync
  )[],
): T {
  const ownerToken = createLocalRuntimeMutationLockOwnerToken();
  const location = {
    ...(options.configPath === undefined
      ? {}
      : {configPath: options.configPath}),
    ...(options.env === undefined ? {} : {env: options.env}),
    ...(options.storeRoot === undefined ? {} : {storeRoot: options.storeRoot}),
  };
  const selectedGlobalPath = selectedRuntimeConfigControlPath(options);
  const canonicalGlobalPath =
    canonicalRuntimeConfigMutationPath(selectedGlobalPath);
  const aliasedOverlaySelection =
    selectedPathIsOverlayShapedAsWritten(selectedGlobalPath);
  const anticipatedEnvPath =
    options.secretMutation === true
      ? anticipatedRuntimeConfigEnvPath(options, selectedGlobalPath)
      : undefined;

  // The mutation machinery's own target preflight, run BEFORE any lock
  // exists so a rejected target (an unmarked or symlinked data
  // location) leaves no lock root behind. The machinery re-runs it
  // idempotently inside.
  if (options.lockMode === 'mutation' && options.scopeSelector === 'global') {
    assertRuntimeConfigMutationTargetSelectable({
      displayConfigPath: selectedGlobalPath.trim(),
      canonicalSelectedConfigPath: canonicalGlobalPath,
      characterScopeManaged: false,
    });
  }

  // The global config/env pair first, canonically sorted — the same
  // order a standalone secret write acquires them in.
  if (options.lockMode !== 'none') {
    leases.push(
      acquireRuntimeConfigControlPairLease({
        canonicalConfigPath: canonicalGlobalPath,
        displayConfigPath: selectedGlobalPath.trim(),
        ...(anticipatedEnvPath === undefined
          ? {}
          : {canonicalEnvPath: anticipatedEnvPath}),
        ownerToken,
      }),
    );
  }

  const loadedConfig = loadProject02RuntimeConfig(location);

  // A character-scoped change composes with the global layer: it must
  // fail before durable state (or even a lock root) is touched when
  // that layer cannot load.
  if (options.scopeSelector === 'character') {
    assertGlobalConfigLoadableForCharacterScope(loadedConfig);
  }

  const characterScope = snapshotCharacterScope(loadedConfig, options);
  const globalDocument = createRuntimeConfigMutationBase({
    loadedConfig,
    ...(options.configPath === undefined
      ? {}
      : {configPath: options.configPath}),
    ...(options.storeRoot === undefined ? {} : {storeRoot: options.storeRoot}),
  });

  // The overlay lock joins only after the global pair, and only when a
  // scoped writer could exist: an aliased selection is the overlay
  // itself (already locked above), and an absent data directory must
  // not grow a lock root from a read or a conflict.
  if (
    options.lockMode !== 'none' &&
    characterScope !== undefined &&
    !aliasedOverlaySelection
  ) {
    joinOverlayControlLock({
      options,
      characterScope,
      canonicalGlobalPath,
      ownerToken,
      leases,
    });
  }

  const overlay =
    characterScope !== undefined &&
    (options.expectingFingerprint === true || !aliasedOverlaySelection)
      ? loadCharacterOverlayForScope(characterScope)
      : undefined;

  return run(
    Object.freeze({
      ownerToken,
      loadedConfig,
      globalDocument,
      selectedGlobalPath,
      canonicalGlobalPath,
      aliasedOverlaySelection,
      characterScope,
      overlay,
      anticipatedEnvPath,
    } satisfies LayeredControlSnapshot),
  );
}

/**
 * The one layered-expectation verifier: the caller's fingerprint is
 * compared against the snapshot's pair of authored documents, composed
 * exactly as every inspect surface composes them.
 */
export function verifyLayeredControlExpectation(
  snapshot: Pick<
    LayeredControlSnapshot,
    'globalDocument' | 'characterScope' | 'overlay'
  >,
  expectedFingerprint: string,
): void {
  const currentFingerprint = layeredRuntimeConfigFingerprintForScope({
    globalConfig: snapshot.globalDocument,
    characterScope: snapshot.characterScope,
    overlay: snapshot.overlay,
  });

  if (expectedFingerprint !== currentFingerprint) {
    throw new RuntimeConfigConflictError(
      'Runtime config changed before the mutation could be committed. ' +
        `Expected ${expectedFingerprint}, found ${currentFingerprint}.`,
    );
  }
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

export function requiredLayeredCharacterScope(
  snapshot: Pick<LayeredControlSnapshot, 'characterScope'>,
): RuntimeConfigCharacterScope {
  if (snapshot.characterScope === undefined) {
    throw new RuntimeConfigMutationError(
      'Character scope is unavailable: the configured character id or ' +
        'store root does not form a character-data path.',
    );
  }

  return snapshot.characterScope;
}

export function requiredLayeredOverlay(
  snapshot: Pick<LayeredControlSnapshot, 'overlay'>,
): LoadedProject02CharacterOverlayConfig {
  if (snapshot.overlay === undefined) {
    throw new TypeError(
      'Layered control snapshot is missing the character overlay.',
    );
  }

  return snapshot.overlay;
}

/**
 * True only for lock-acquisition failures that prove no scoped writer
 * can hold the lock either (an uncreatable lock root in a hostile
 * store); the mutation then surfaces the store problem with its own
 * precise error. A BUSY lock proves the opposite — a scoped writer is
 * active right now — so the transaction must abort instead of
 * verifying unlocked and racing that writer's commit.
 */
export function lockFailureProvesNoOverlayWriter(error: unknown): boolean {
  return (
    error instanceof LocalRuntimeStorageContractError &&
    !(error instanceof LocalRuntimeMutationLockBusyError)
  );
}

function joinOverlayControlLock(input: {
  readonly options: Parameters<typeof withLayeredControlSnapshot>[0];
  readonly characterScope: RuntimeConfigCharacterScope;
  readonly canonicalGlobalPath: string;
  readonly ownerToken: LocalRuntimeMutationLockOwnerToken;
  readonly leases: (
    LocalRuntimeMutationLocksLeaseSync | LocalRuntimeMutationLockLeaseSync
  )[];
}): void {
  const canonicalOverlayPath = canonicalRuntimeConfigMutationPath(
    characterOverlayConfigPath(input.characterScope.dataRoot),
  );

  // The marker is the proof that the guarded initializer ran for this
  // directory; without it no scoped write — not even a lock root — may
  // create durable character state. Runs under the global-layer lock,
  // before the overlay lock exists.
  if (input.options.scopeSelector === 'character') {
    assertOverlayLocatedTargetIsInitialized(canonicalOverlayPath);
  }

  if (
    input.options.lockMode === 'mutation' &&
    canonicalOverlayPath !== input.canonicalGlobalPath &&
    existsSync(dirname(canonicalOverlayPath))
  ) {
    const overlayLease = acquireOverlayControlLock(
      canonicalOverlayPath,
      input.ownerToken,
    );

    if (overlayLease !== undefined) {
      input.leases.push(overlayLease);
    }
  }
}

function acquireOverlayControlLock(
  canonicalOverlayPath: string,
  ownerToken: LocalRuntimeMutationLockOwnerToken,
): LocalRuntimeMutationLockLeaseSync | undefined {
  try {
    return acquireLocalRuntimeMutationLockSync({
      locksRoot: createProject02HomeLayout({
        homeRoot: dirname(canonicalOverlayPath),
      }).locksRoot,
      resourceKey: `runtime-control-file:${canonicalOverlayPath}`,
      ownerToken,
    });
  } catch (error: unknown) {
    if (lockFailureProvesNoOverlayWriter(error)) {
      return undefined;
    }

    throw error;
  }
}

function snapshotCharacterScope(
  loadedConfig: LoadedProject02RuntimeConfig,
  options: Parameters<typeof withLayeredControlSnapshot>[0],
): RuntimeConfigCharacterScope | undefined {
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

  if (options.scopeSelector === 'character' && characterScope === undefined) {
    throw new RuntimeConfigMutationError(
      'Character scope is unavailable: the configured character id or ' +
        'store root does not form a character-data path.',
    );
  }

  return characterScope;
}

// Mirrors the mutation machinery's own location resolution so the
// transaction locks the same file the mutation will write.
function selectedRuntimeConfigControlPath(
  options: LayeredControlLocation,
): string {
  const env = options.env ?? process.env;
  const envSelectedPath =
    options.storeRoot === undefined
      ? env[runtimeConfigEnvVarName]?.trim()
      : undefined;

  return (
    options.configPath ??
    (envSelectedPath !== undefined && envSelectedPath.length > 0
      ? envSelectedPath
      : undefined) ??
    createProject02HomeLayout(
      options.storeRoot === undefined ? {} : {homeRoot: options.storeRoot},
    ).configPath
  );
}

// The env path a secret write commits to, derived from the CURRENT
// config: a secret mutation never moves the store root, so the path
// the machinery derives from its candidate matches this one, and any
// drift (a concurrent store-root change) retries the transaction.
function anticipatedRuntimeConfigEnvPath(
  options: LayeredControlLocation,
  selectedGlobalPath: string,
): string {
  const loadedConfig = loadProject02RuntimeConfig({
    ...(options.configPath === undefined
      ? {}
      : {configPath: options.configPath}),
    ...(options.env === undefined ? {} : {env: options.env}),
    ...(options.storeRoot === undefined ? {} : {storeRoot: options.storeRoot}),
  });
  const selectedStoreRoot =
    options.storeRoot ??
    storeRootForSelectedDefaultConfigPath(selectedGlobalPath);
  const effectiveStoreRoot =
    loadedConfig.config?.project02?.storeRoot ?? selectedStoreRoot;

  return canonicalRuntimeConfigMutationPath(
    createProject02HomeLayout(
      effectiveStoreRoot === undefined ? {} : {homeRoot: effectiveStoreRoot},
    ).envPath,
  );
}

// Judged AS WRITTEN (not symlink-canonicalized), matching the mutation
// machinery's own overlay-shape classification: a symlink sitting where
// an overlay belongs must reach its precise rejection, not a scope
// guard's generic one.
export function selectedPathIsOverlayShapedAsWritten(
  selectedPath: string,
): boolean {
  const written = resolve(selectedPath.trim());

  return basename(dirname(dirname(written))) === characterDataDirectoryName;
}
