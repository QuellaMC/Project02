/**
 * The single transaction owner for runtime config control.
 *
 * The immutable control target contributes every file the transaction can
 * observe or write to one storage-owned lock batch. The transaction reloads
 * every authored layer under that complete lease, prepares one pure candidate,
 * and commits to the target captured before preparation. Selector drift
 * conflicts; it never retargets or restarts the transaction.
 */
import {pathExistsSync} from '../../shared/file-system.ts';
import {dirname} from 'node:path';

import {
  acquireLocalRuntimeMutationLocksSync,
  LocalRuntimeMutationLocksAcquireError,
  type LocalRuntimeMutationLockTarget,
  type LocalRuntimeMutationLocksLeaseSync,
} from '../storage/mutation-lock.ts';
import {runtimeConfigEnvPathForLocation} from './env-file.ts';
import {createLayeredRuntimeConfigFingerprint} from './fingerprint.ts';
import {
  assertSelectedRuntimeConfigStillBound,
  loadSelectedProject02RuntimeConfig,
  RuntimeConfigLocationError,
} from './load.ts';
import {
  blockingRuntimeConfigLayerDiagnostic,
  canonicalRuntimeConfigMutationPath,
  commitPreparedRuntimeConfigMutation,
  createRuntimeConfigAuthoredSnapshot,
  RuntimeConfigConflictError,
  runtimeConfigControlFileLockTarget,
  RuntimeConfigMutationError,
  type PreparedRuntimeConfigMutationCandidate,
  type RuntimeConfigMutationResult,
} from './mutate.ts';
import {
  layeredRuntimeConfigFingerprintForScope,
  readCharacterOverlayForScope,
  type LoadedProject02CharacterOverlayConfig,
  type RuntimeConfigCharacterOverlaySnapshot,
} from './overlay.ts';
import {
  assertProject02ReloadedConfigUsesBoundHome,
  assertRuntimeConfigCandidateHomeAdoptable,
  assertResolvedProject02HomeAdoptable,
  assertResolvedProject02HomeCurrent,
  assertSelectedProject02HomeAdoptable,
  requireResolvedRuntimeConfigScopeTarget,
  resolveAdoptableRuntimeConfigCandidateHomeTarget,
  type RuntimeConfigCandidateHomeTarget,
  type ResolvedProject02ConfigLocation,
  type ResolvedProject02RuntimeLocation,
  type ResolvedRuntimeConfigScopeTarget,
} from './location.ts';
import type {
  LoadedProject02RuntimeConfig,
  Project02RuntimeConfig,
  RuntimeConfigMutationOperation,
  SelectedLoadedProject02RuntimeConfig,
} from './types.ts';
import type {JsonBoundaryObject} from '../../shared/json-boundary.ts';

export type RuntimeConfigControlSnapshot = {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  /** Exact authored document used for conflict fingerprints and repair. */
  readonly globalDocument: JsonBoundaryObject;
  /** Validated view of that same document, including the absent-file bootstrap. */
  readonly validatedGlobalConfig?: Project02RuntimeConfig;
  readonly runtimeLocation: ResolvedProject02ConfigLocation;
  readonly characterRuntimeLocation?: ResolvedProject02RuntimeLocation;
  readonly characterOverlay?: RuntimeConfigCharacterOverlaySnapshot;
};

export type RuntimeConfigControlTransactionPreparation<T> = {
  readonly preparedCandidate: PreparedRuntimeConfigMutationCandidate;
  readonly commit: boolean;
  readonly operation?: RuntimeConfigMutationOperation;
  readonly context: T;
};

export type RuntimeConfigControlTransactionResult<T> = {
  readonly result: RuntimeConfigMutationResult;
  readonly context: T;
};

type RuntimeConfigControlOverlayLockTarget = {
  readonly displayPath: string;
  readonly canonicalPath: string;
  readonly target?: LocalRuntimeMutationLockTarget;
};

type RuntimeConfigControlLockPlan = {
  readonly canonicalGlobalConfigPath: string;
  readonly displayGlobalConfigPath: string;
  readonly canonicalEnvPath?: string;
  readonly displayEnvPath?: string;
  readonly overlay?: RuntimeConfigControlOverlayLockTarget;
  readonly targets: readonly LocalRuntimeMutationLockTarget[];
};

type RuntimeConfigControlCandidateHome = {
  readonly homeRoot: string;
  readonly candidateTarget?: RuntimeConfigCandidateHomeTarget;
};

/**
 * Lock-free snapshot used only for effect preparation. Apply always reloads
 * and re-verifies the expectation under its complete lock set.
 *
 * `requireCharacterMarker` defaults to the commit's rule — a character-scoped
 * target must already name an initialized data directory. A caller that is
 * only simulating the write passes `false`: initialization is exactly what it
 * is deciding whether to perform, so demanding the marker up front would
 * refuse the question instead of answering it.
 */
export function readRuntimeConfigControlSnapshot(
  target: ResolvedRuntimeConfigScopeTarget,
  options: {readonly requireCharacterMarker?: boolean} = {},
): RuntimeConfigControlSnapshot {
  target = requireResolvedRuntimeConfigScopeTarget(target);
  assertRuntimeConfigTargetStillBound(target);
  assertSelectedProject02HomeAdoptable(target.runtimeLocation);
  assertRuntimeConfigEffectiveHomeAvailable(target, false);
  const loadedConfig = loadSelectedGlobalConfig(target);
  assertReloadedGlobalConfigUsesBoundHome(target, loadedConfig);

  return snapshotFromLoadedGlobal({
    target,
    loadedConfig,
    requireCharacterMarker: options.requireCharacterMarker ?? true,
  });
}

type ApplyRuntimeConfigControlTransactionOptions<T> = {
  readonly target: ResolvedRuntimeConfigScopeTarget;
  readonly expectedFingerprint?: string;
  readonly secretMutation: boolean;
  readonly prepare: (
    snapshot: RuntimeConfigControlSnapshot,
  ) => RuntimeConfigControlTransactionPreparation<T>;
};

export function applyRuntimeConfigControlTransaction<T>(
  options: ApplyRuntimeConfigControlTransactionOptions<T>,
): RuntimeConfigControlTransactionResult<T> {
  const target = requireResolvedRuntimeConfigScopeTarget(options.target);
  const lockPlan = createRuntimeConfigControlLockPlan(
    target,
    options.secretMutation,
  );
  const lease = acquireRuntimeConfigControlLocks(lockPlan);

  try {
    assertRuntimeConfigTargetStillBound(target);
    assertRuntimeConfigOverlayLockStillBound(lockPlan.overlay);
    assertSelectedProject02HomeAdoptable(target.runtimeLocation);
    assertRuntimeConfigEffectiveHomeAvailable(target, options.secretMutation);
    const loadedConfig = loadSelectedGlobalConfig(target);
    assertReloadedGlobalConfigUsesBoundHome(target, loadedConfig);
    const currentEnvPath = runtimeConfigEnvPathForLocation(
      target.runtimeLocation,
    );
    const currentCanonicalEnvPath =
      canonicalRuntimeConfigMutationPath(currentEnvPath);

    if (
      options.secretMutation &&
      currentCanonicalEnvPath !== lockPlan.canonicalEnvPath
    ) {
      throw runtimeConfigTargetConflict(
        'Runtime config env target changed after the control target was bound.',
      );
    }

    const snapshot = snapshotFromLoadedGlobal({
      target,
      loadedConfig,
      // The commit's own rule, unconditionally: a character-scoped write
      // lands only in a directory the initializer already claimed.
      requireCharacterMarker: true,
    });

    if (options.expectedFingerprint !== undefined) {
      verifyRuntimeConfigControlExpectation(
        snapshot,
        options.expectedFingerprint,
      );
    }

    const preparation = options.prepare(snapshot);
    const candidateHome = runtimeConfigControlCandidateHome({
      target,
      candidate: preparation.preparedCandidate.config,
      operation: preparation.operation,
    });
    const candidateEnvPath = runtimeConfigEnvPathForLocation(candidateHome);
    const canonicalCandidateEnvPath =
      canonicalRuntimeConfigMutationPath(candidateEnvPath);

    if (
      options.secretMutation &&
      canonicalCandidateEnvPath !== lockPlan.canonicalEnvPath
    ) {
      throw runtimeConfigTargetConflict(
        'Runtime config env target changed while preparing the mutation.',
      );
    }

    const writePath =
      target.scope === 'character'
        ? requiredCharacterWritePath(target, lockPlan.overlay)
        : target.canonicalConfigPath;

    if (preparation.commit) {
      assertRuntimeConfigTargetStillBound(target);
      assertRuntimeConfigOverlayLockStillBound(lockPlan.overlay);
      assertRuntimeConfigEffectiveHomeAvailable(target, options.secretMutation);
      assertRuntimeConfigControlCandidateHomeAdoptable(candidateHome);

      commitPreparedRuntimeConfigMutation({
        canonicalConfigPath: writePath,
        displayConfigPath: target.configPath,
        canonicalEnvPath: canonicalCandidateEnvPath,
        displayEnvPath: candidateEnvPath,
        ...(preparation.operation === undefined
          ? {}
          : {operation: preparation.operation}),
        preparedCandidate: preparation.preparedCandidate,
      });
    }

    return Object.freeze({
      result: Object.freeze({
        configPath: target.configPath,
        envPath: candidateEnvPath,
        config: preparation.preparedCandidate.config,
        fingerprint:
          target.scope === 'character'
            ? createLayeredRuntimeConfigFingerprint({
                globalConfig: snapshot.globalDocument,
                characterId: target.runtimeLocation.characterScope.characterId,
                overlayConfig: preparation.preparedCandidate.config,
              })
            : layeredRuntimeConfigFingerprintForScope({
                globalConfig: preparation.preparedCandidate.config,
                characterScope:
                  snapshot.characterRuntimeLocation?.characterScope,
                overlay: snapshot.characterOverlay?.overlay,
              }),
      } satisfies RuntimeConfigMutationResult),
      context: preparation.context,
    });
  } finally {
    lease.release();
  }
}

export function verifyRuntimeConfigControlExpectation(
  snapshot: Pick<
    RuntimeConfigControlSnapshot,
    | 'globalDocument'
    | 'runtimeLocation'
    | 'characterRuntimeLocation'
    | 'characterOverlay'
  >,
  expectedFingerprint: string,
): void {
  const currentFingerprint = layeredRuntimeConfigFingerprintForScope({
    globalConfig: snapshot.globalDocument,
    characterScope: snapshot.characterRuntimeLocation?.characterScope,
    overlay: snapshot.characterOverlay?.overlay,
  });

  if (expectedFingerprint !== currentFingerprint) {
    throw new RuntimeConfigConflictError(
      'Runtime config changed before the mutation could be committed. ' +
        `Expected ${expectedFingerprint}, found ${currentFingerprint}.`,
    );
  }
}

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

function snapshotFromLoadedGlobal(options: {
  readonly target: ResolvedRuntimeConfigScopeTarget;
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly requireCharacterMarker: boolean;
}): RuntimeConfigControlSnapshot {
  if (options.target.scope === 'character') {
    assertGlobalConfigLoadableForCharacterScope(options.loadedConfig);
  }

  const globalSnapshot = createRuntimeConfigAuthoredSnapshot(
    options.loadedConfig,
  );
  const characterRuntimeLocation =
    options.target.scope === 'character'
      ? options.target.runtimeLocation
      : options.target.characterRuntimeLocation;
  const characterOverlay =
    characterRuntimeLocation === undefined
      ? undefined
      : readCharacterOverlayForScope(characterRuntimeLocation.characterScope);

  if (
    options.requireCharacterMarker &&
    options.target.scope === 'character' &&
    characterOverlay?.marker === undefined
  ) {
    throw new RuntimeConfigMutationError(
      `Config file "${options.target.configPath}" sits in a character-data ` +
        'directory that has no identity marker; run the command with ' +
        `--character ${options.target.runtimeLocation.characterScope.characterId} to initialize it first.`,
    );
  }

  assertCharacterOverlayMutable(options.target, characterOverlay?.overlay);

  return Object.freeze({
    loadedConfig: options.loadedConfig,
    globalDocument: globalSnapshot.document,
    ...(globalSnapshot.validatedConfig === undefined
      ? {}
      : {validatedGlobalConfig: globalSnapshot.validatedConfig}),
    runtimeLocation: options.target.runtimeLocation,
    ...(characterRuntimeLocation === undefined
      ? {}
      : {characterRuntimeLocation}),
    ...(characterOverlay === undefined ? {} : {characterOverlay}),
  });
}

function loadSelectedGlobalConfig(
  target: ResolvedRuntimeConfigScopeTarget,
): SelectedLoadedProject02RuntimeConfig {
  return loadSelectedProject02RuntimeConfig(
    target.runtimeLocation.selectedConfig,
  );
}

function runtimeConfigControlCandidateHome(options: {
  readonly target: ResolvedRuntimeConfigScopeTarget;
  readonly candidate: Project02RuntimeConfig;
  readonly operation: RuntimeConfigMutationOperation | undefined;
}): RuntimeConfigControlCandidateHome {
  if (!runtimeConfigMutationMovesEffectiveHome(options.operation)) {
    return Object.freeze({
      homeRoot: options.target.runtimeLocation.homeRoot,
    });
  }

  const candidateTarget = resolveAdoptableRuntimeConfigCandidateHomeTarget({
    configLocation: options.target.runtimeLocation,
    config: options.candidate,
  });

  return Object.freeze({
    homeRoot: candidateTarget.homeRoot,
    candidateTarget,
  });
}

function assertRuntimeConfigControlCandidateHomeAdoptable(
  candidate: RuntimeConfigControlCandidateHome,
): void {
  if (candidate.candidateTarget !== undefined) {
    assertRuntimeConfigCandidateHomeAdoptable(candidate.candidateTarget);
  }
}

function runtimeConfigMutationMovesEffectiveHome(
  operation: RuntimeConfigMutationOperation | undefined,
): boolean {
  return (
    (operation?.kind === 'set' || operation?.kind === 'unset') &&
    operation.path === 'project02.storeRoot'
  );
}

/**
 * The overlay obeys the same repairability rule as the global document:
 * an invalid authored value is what `set` and `unset` are for, so only a
 * layer with no readable authored bytes blocks the mutation.
 */
function assertCharacterOverlayMutable(
  target: ResolvedRuntimeConfigScopeTarget,
  overlay: LoadedProject02CharacterOverlayConfig | undefined,
): void {
  if (target.scope !== 'character' || overlay === undefined) {
    return;
  }

  const blocking = blockingRuntimeConfigLayerDiagnostic(overlay);

  if (blocking !== undefined) {
    throw new RuntimeConfigMutationError(
      `Cannot mutate the character overlay because it failed to load: ${blocking.message}`,
    );
  }
}

function assertRuntimeConfigEffectiveHomeAvailable(
  target: ResolvedRuntimeConfigScopeTarget,
  secretMutation: boolean,
): void {
  try {
    if (secretMutation || target.scope === 'character') {
      assertResolvedProject02HomeAdoptable(target.runtimeLocation, {
        requireRealEnvFile: secretMutation,
      });
      return;
    }

    assertResolvedProject02HomeCurrent(target.runtimeLocation);
  } catch (error: unknown) {
    if (error instanceof RuntimeConfigLocationError) {
      throw runtimeConfigTargetConflict(
        'The resolved Project02 home changed after the control target was bound.',
      );
    }

    throw error;
  }
}

function assertReloadedGlobalConfigUsesBoundHome(
  target: ResolvedRuntimeConfigScopeTarget,
  loadedConfig: SelectedLoadedProject02RuntimeConfig,
): void {
  try {
    assertProject02ReloadedConfigUsesBoundHome({
      configLocation: target.runtimeLocation,
      loadedConfig,
    });
  } catch (error: unknown) {
    if (error instanceof RuntimeConfigLocationError) {
      throw runtimeConfigTargetConflict(
        'The reloaded runtime config could not preserve its resolved Project02 home.',
      );
    }

    throw error;
  }
}

function assertRuntimeConfigTargetStillBound(
  target: ResolvedRuntimeConfigScopeTarget,
): void {
  try {
    assertSelectedRuntimeConfigStillBound(
      target.runtimeLocation.selectedConfig,
    );
  } catch {
    throw runtimeConfigTargetConflict(
      'The selected runtime config path now names another file.',
    );
  }

  if (
    target.scope === 'character' &&
    canonicalRuntimeConfigMutationPath(target.runtimeLocation.overlayPath) !==
      target.canonicalConfigPath
  ) {
    throw runtimeConfigTargetConflict(
      'The selected character overlay path now names another file.',
    );
  }
}

function runtimeConfigTargetConflict(
  message: string,
): RuntimeConfigConflictError {
  return new RuntimeConfigConflictError(
    `${message} Resolve a fresh control target before retrying.`,
  );
}

function runtimeConfigControlOverlayLockTarget(options: {
  readonly runtimeLocation: ResolvedProject02RuntimeLocation | undefined;
  readonly required: boolean;
}): RuntimeConfigControlOverlayLockTarget | undefined {
  if (options.runtimeLocation === undefined) {
    if (options.required) {
      throw new TypeError(
        'Character config control requires a bound character runtime location.',
      );
    }

    return undefined;
  }

  const overlayPath = options.runtimeLocation.overlayPath;
  const canonicalPath = canonicalRuntimeConfigMutationPath(overlayPath);
  const overlay = {
    displayPath: overlayPath,
    canonicalPath,
  };

  if (!pathExistsSync(dirname(canonicalPath))) {
    return Object.freeze(overlay);
  }

  return Object.freeze({
    ...overlay,
    target: runtimeConfigControlFileLockTarget(canonicalPath),
  });
}

function requiredCharacterWritePath(
  target: Extract<
    ResolvedRuntimeConfigScopeTarget,
    {readonly scope: 'character'}
  >,
  overlay: RuntimeConfigControlOverlayLockTarget | undefined,
): string {
  if (overlay?.target === undefined) {
    throw new RuntimeConfigMutationError(
      `Character "${target.runtimeLocation.characterScope.characterId}" overlay lock is unavailable.`,
    );
  }

  return overlay.canonicalPath;
}

function createRuntimeConfigControlLockPlan(
  target: ResolvedRuntimeConfigScopeTarget,
  secretMutation: boolean,
): RuntimeConfigControlLockPlan {
  assertRuntimeConfigTargetStillBound(target);
  assertSelectedProject02HomeAdoptable(target.runtimeLocation);
  assertRuntimeConfigEffectiveHomeAvailable(target, secretMutation);

  const canonicalGlobalConfigPath =
    target.runtimeLocation.selectedConfig.canonicalPath;
  const displayGlobalConfigPath = target.runtimeLocation.selectedConfig.path;
  const displayEnvPath = secretMutation
    ? runtimeConfigEnvPathForLocation(target.runtimeLocation)
    : undefined;
  const canonicalEnvPath =
    displayEnvPath === undefined
      ? undefined
      : canonicalRuntimeConfigMutationPath(displayEnvPath);

  const overlay = runtimeConfigControlOverlayLockTarget({
    runtimeLocation:
      target.scope === 'character'
        ? target.runtimeLocation
        : target.characterRuntimeLocation,
    required: target.scope === 'character',
  });
  const targets = [
    runtimeConfigControlFileLockTarget(canonicalGlobalConfigPath),
    ...(canonicalEnvPath === undefined
      ? []
      : [runtimeConfigControlFileLockTarget(canonicalEnvPath)]),
    ...(overlay?.target === undefined ? [] : [overlay.target]),
  ];

  return Object.freeze({
    canonicalGlobalConfigPath,
    displayGlobalConfigPath,
    ...(canonicalEnvPath === undefined
      ? {}
      : {
          canonicalEnvPath,
          displayEnvPath: displayEnvPath ?? canonicalEnvPath,
        }),
    ...(overlay === undefined ? {} : {overlay}),
    targets: Object.freeze(targets),
  });
}

function acquireRuntimeConfigControlLocks(
  plan: RuntimeConfigControlLockPlan,
): LocalRuntimeMutationLocksLeaseSync {
  try {
    return acquireLocalRuntimeMutationLocksSync({
      targets: plan.targets,
    });
  } catch (error: unknown) {
    const failedTarget =
      error instanceof LocalRuntimeMutationLocksAcquireError
        ? error.target
        : undefined;
    const envFailed =
      plan.canonicalEnvPath !== undefined &&
      failedTarget?.resourceKey ===
        runtimeConfigControlFileLockTarget(plan.canonicalEnvPath).resourceKey;
    const overlayFailed =
      plan.overlay?.target !== undefined &&
      failedTarget?.resourceKey === plan.overlay.target.resourceKey;

    throw runtimeConfigControlFileError(
      envFailed
        ? `Could not write runtime config env file at ${
            plan.displayEnvPath ?? plan.canonicalEnvPath
          }.`
        : overlayFailed
          ? `Could not write runtime config file at ${plan.overlay.displayPath}.`
          : `Could not write runtime config file at ${plan.displayGlobalConfigPath}.`,
      error,
    );
  }
}

function assertRuntimeConfigOverlayLockStillBound(
  overlay: RuntimeConfigControlOverlayLockTarget | undefined,
): void {
  if (overlay === undefined) {
    return;
  }

  const parentExists = pathExistsSync(dirname(overlay.canonicalPath));

  if (
    canonicalRuntimeConfigMutationPath(overlay.displayPath) !==
      overlay.canonicalPath ||
    (overlay.target === undefined) === parentExists
  ) {
    throw runtimeConfigTargetConflict(
      'The selected character overlay path changed while its lock was acquired.',
    );
  }
}

function runtimeConfigControlFileError(
  message: string,
  cause: unknown,
): RuntimeConfigMutationError {
  return cause instanceof RuntimeConfigMutationError
    ? cause
    : new RuntimeConfigMutationError(message, {cause});
}
