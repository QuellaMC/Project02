/**
 * The single transaction owner for runtime config control.
 *
 * Global config/env locks are acquired first, then the active character
 * overlay lock. The transaction reloads every authored layer under that
 * lock set, prepares one pure candidate, and commits to the exact locked
 * paths. Path drift restarts the whole transaction.
 */
import {existsSync} from 'node:fs';
import {basename, dirname} from 'node:path';

import {
  characterDataDirectoryName,
  createProject02HomeLayout,
  LocalRuntimeStorageContractError,
} from '../storage/layout-contract.ts';
import {
  acquireLocalRuntimeMutationLockSync,
  acquireLocalRuntimeMutationLocksSync,
  createLocalRuntimeMutationLockOwnerToken,
  LocalRuntimeMutationLockBusyError,
  LocalRuntimeMutationLocksAcquireError,
  type LocalRuntimeMutationLockLeaseSync,
  type LocalRuntimeMutationLockOwnerToken,
  type LocalRuntimeMutationLocksLeaseSync,
} from '../storage/mutation-lock.ts';
import {runtimeConfigEnvPathForLocation} from './env-file.ts';
import {createLayeredRuntimeConfigFingerprint} from './fingerprint.ts';
import {RuntimeConfigLocationError} from './load.ts';
import {
  canonicalRuntimeConfigMutationPath,
  commitPreparedRuntimeConfigMutation,
  createRuntimeConfigMutationBase,
  RuntimeConfigConflictError,
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
  loadProject02RuntimeConfigForLocation,
  resolveProject02RuntimeLocation,
  sameRuntimeConfigCharacterScope,
  type ResolvedProject02RuntimeLocation,
  type ResolvedRuntimeConfigScopeTarget,
} from './location.ts';
import type {
  LoadedProject02RuntimeConfig,
  Project02RuntimeConfig,
  RuntimeConfigMutationOperation,
} from './types.ts';

export type RuntimeConfigControlSnapshot = {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly globalDocument: Project02RuntimeConfig;
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly characterOverlay: RuntimeConfigCharacterOverlaySnapshot;
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

type LockedOverlay = {
  readonly canonicalPath: string;
  readonly leaseAcquired: boolean;
};

const runtimeConfigControlDriftRetryLimit = 8;

/**
 * Lock-free snapshot used only for effect preparation. Apply always reloads
 * and re-verifies the expectation under its complete lock set.
 */
export function readRuntimeConfigControlSnapshot(
  target: ResolvedRuntimeConfigScopeTarget,
): RuntimeConfigControlSnapshot {
  const loadedConfig = loadSelectedGlobalConfig(target);
  const runtimeLocation = runtimeLocationForLoadedGlobal(target, loadedConfig);
  const canonicalGlobalConfigPath = canonicalRuntimeConfigMutationPath(
    loadedConfig.path ?? runtimeLocation.globalConfigPath,
  );
  assertGlobalTargetOutsideCharacterData(canonicalGlobalConfigPath);

  return snapshotFromLoadedGlobal({
    target,
    loadedConfig,
    runtimeLocation,
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
  const preflightSnapshot = readRuntimeConfigControlSnapshot(options.target);
  let anticipatedEnvPath = options.secretMutation
    ? runtimeConfigEnvPathForLocation(preflightSnapshot.runtimeLocation)
    : undefined;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return applyRuntimeConfigControlAttempt(options, anticipatedEnvPath);
    } catch (error: unknown) {
      if (!(error instanceof RuntimeConfigControlPathDrift)) {
        throw error;
      }

      anticipatedEnvPath = error.anticipatedEnvPath ?? anticipatedEnvPath;

      if (attempt >= runtimeConfigControlDriftRetryLimit) {
        throw new RuntimeConfigMutationError(
          'Runtime config mutation paths kept changing while acquiring filesystem locks.',
        );
      }
    }
  }
}

function applyRuntimeConfigControlAttempt<T>(
  options: ApplyRuntimeConfigControlTransactionOptions<T>,
  anticipatedEnvPath: string | undefined,
): RuntimeConfigControlTransactionResult<T> {
  const leases: (
    LocalRuntimeMutationLocksLeaseSync | LocalRuntimeMutationLockLeaseSync
  )[] = [];
  const ownerToken = createLocalRuntimeMutationLockOwnerToken();

  try {
    const canonicalGlobalConfigPath = canonicalRuntimeConfigMutationPath(
      options.target.runtimeLocation.globalConfigPath,
    );
    assertGlobalTargetOutsideCharacterData(canonicalGlobalConfigPath);
    const canonicalAnticipatedEnvPath =
      anticipatedEnvPath === undefined
        ? undefined
        : canonicalRuntimeConfigMutationPath(anticipatedEnvPath);

    leases.push(
      acquireGlobalControlLocks({
        canonicalGlobalConfigPath,
        displayGlobalConfigPath:
          options.target.runtimeLocation.globalConfigPath,
        ...(canonicalAnticipatedEnvPath === undefined
          ? {}
          : {
              canonicalEnvPath: canonicalAnticipatedEnvPath,
              displayEnvPath: anticipatedEnvPath ?? canonicalAnticipatedEnvPath,
            }),
        ownerToken,
      }),
    );

    const loadedConfig = loadSelectedGlobalConfig(options.target);
    const currentRuntimeLocation = runtimeLocationForLoadedGlobal(
      options.target,
      loadedConfig,
    );
    const currentCanonicalGlobalConfigPath = canonicalRuntimeConfigMutationPath(
      loadedConfig.path ?? currentRuntimeLocation.globalConfigPath,
    );

    if (currentCanonicalGlobalConfigPath !== canonicalGlobalConfigPath) {
      throw new RuntimeConfigControlPathDrift();
    }

    assertGlobalTargetOutsideCharacterData(currentCanonicalGlobalConfigPath);
    const currentEnvPath = runtimeConfigEnvPathForLocation(
      currentRuntimeLocation,
    );
    const currentCanonicalEnvPath =
      canonicalRuntimeConfigMutationPath(currentEnvPath);

    if (
      options.secretMutation &&
      currentCanonicalEnvPath !== canonicalAnticipatedEnvPath
    ) {
      throw new RuntimeConfigControlPathDrift(currentEnvPath);
    }

    if (
      options.target.scope === 'character' &&
      canonicalRuntimeConfigMutationPath(currentRuntimeLocation.overlayPath) !==
        options.target.canonicalConfigPath
    ) {
      throw new RuntimeConfigControlPathDrift();
    }
    const lockedOverlay = lockOverlayForScope({
      runtimeLocation: currentRuntimeLocation,
      ownerToken,
      leases,
      required: options.target.scope === 'character',
    });
    const snapshot = snapshotFromLoadedGlobal({
      target: options.target,
      loadedConfig,
      runtimeLocation: currentRuntimeLocation,
    });

    if (options.expectedFingerprint !== undefined) {
      verifyRuntimeConfigControlExpectation(
        snapshot,
        options.expectedFingerprint,
      );
    }

    const preparation = options.prepare(snapshot);
    const candidateRuntimeLocation = runtimeConfigControlCandidateLocation({
      target: options.target,
      snapshot,
      candidate: preparation.preparedCandidate.config,
    });
    const candidateEnvPath = runtimeConfigEnvPathForLocation(
      candidateRuntimeLocation,
    );
    const canonicalCandidateEnvPath =
      canonicalRuntimeConfigMutationPath(candidateEnvPath);

    if (
      options.secretMutation &&
      canonicalCandidateEnvPath !== canonicalAnticipatedEnvPath
    ) {
      throw new RuntimeConfigControlPathDrift(candidateEnvPath);
    }

    const writePath =
      options.target.scope === 'global'
        ? canonicalGlobalConfigPath
        : requiredCharacterWritePath(
            options.target,
            lockedOverlay,
            preparation.commit,
          );
    const resultRuntimeLocation =
      options.target.scope === 'character'
        ? snapshot.runtimeLocation
        : candidateRuntimeLocation;
    const resultOverlay = resultOverlayForCandidate({
      previousLocation: snapshot.runtimeLocation,
      previousOverlay: snapshot.characterOverlay.overlay,
      resultLocation: resultRuntimeLocation,
      ownerToken,
      leases,
    });

    if (preparation.commit) {
      commitPreparedRuntimeConfigMutation({
        canonicalConfigPath: writePath,
        displayConfigPath: options.target.configPath,
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
        configPath: options.target.configPath,
        envPath: candidateEnvPath,
        config: preparation.preparedCandidate.config,
        fingerprint:
          options.target.scope === 'character'
            ? createLayeredRuntimeConfigFingerprint({
                globalConfig: snapshot.globalDocument,
                characterId:
                  options.target.runtimeLocation.characterScope.characterId,
                overlayConfig: preparation.preparedCandidate.config,
              })
            : layeredRuntimeConfigFingerprintForScope({
                globalConfig: preparation.preparedCandidate.config,
                characterScope: resultRuntimeLocation.characterScope,
                overlay: resultOverlay,
              }),
      } satisfies RuntimeConfigMutationResult),
      context: preparation.context,
    });
  } finally {
    releaseControlLeases(leases);
  }
}

export function verifyRuntimeConfigControlExpectation(
  snapshot: Pick<
    RuntimeConfigControlSnapshot,
    'globalDocument' | 'runtimeLocation' | 'characterOverlay'
  >,
  expectedFingerprint: string,
): void {
  const currentFingerprint = layeredRuntimeConfigFingerprintForScope({
    globalConfig: snapshot.globalDocument,
    characterScope: snapshot.runtimeLocation.characterScope,
    overlay: snapshot.characterOverlay.overlay,
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
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
}): RuntimeConfigControlSnapshot {
  if (options.target.scope === 'character') {
    assertGlobalConfigLoadableForCharacterScope(options.loadedConfig);
  }

  const globalDocument = createRuntimeConfigMutationBase({
    loadedConfig: options.loadedConfig,
    configPath: options.runtimeLocation.globalConfigPath,
    ...(options.runtimeLocation.selection.storeRoot === undefined
      ? {}
      : {storeRoot: options.runtimeLocation.selection.storeRoot}),
  });
  const characterOverlay = readCharacterOverlayForScope(
    options.runtimeLocation.characterScope,
  );

  if (
    options.target.scope === 'character' &&
    characterOverlay.marker === undefined
  ) {
    throw new RuntimeConfigMutationError(
      `Config file "${options.target.configPath}" sits in a character-data ` +
        'directory that has no identity marker; run the command with ' +
        `--character ${options.runtimeLocation.characterScope.characterId} to initialize it first.`,
    );
  }

  assertCharacterOverlayMutable(options.target, characterOverlay.overlay);

  return Object.freeze({
    loadedConfig: options.loadedConfig,
    globalDocument,
    runtimeLocation: options.runtimeLocation,
    characterOverlay,
  });
}

function loadSelectedGlobalConfig(
  target: ResolvedRuntimeConfigScopeTarget,
): LoadedProject02RuntimeConfig {
  return loadProject02RuntimeConfigForLocation(target.runtimeLocation);
}

function runtimeLocationForLoadedGlobal(
  target: ResolvedRuntimeConfigScopeTarget,
  loadedConfig: LoadedProject02RuntimeConfig,
): ResolvedProject02RuntimeLocation {
  return resolveProject02RuntimeLocation({
    loadedConfig,
    selection: target.runtimeLocation.selection,
    selectedConfig: {
      source: target.runtimeLocation.configSource,
      path: target.runtimeLocation.globalConfigPath,
    },
  });
}

function runtimeConfigControlCandidateLocation(options: {
  readonly target: ResolvedRuntimeConfigScopeTarget;
  readonly snapshot: RuntimeConfigControlSnapshot;
  readonly candidate: Project02RuntimeConfig;
}): ResolvedProject02RuntimeLocation {
  const globalConfig =
    options.target.scope === 'global'
      ? options.candidate
      : options.snapshot.globalDocument;

  return resolveProject02RuntimeLocation({
    loadedConfig: Object.freeze({
      source: 'path',
      path: options.target.runtimeLocation.globalConfigPath,
      config: globalConfig,
      diagnostics: Object.freeze([]),
    }),
    selection: options.target.runtimeLocation.selection,
    selectedConfig: {
      source: options.target.runtimeLocation.configSource,
      path: options.target.runtimeLocation.globalConfigPath,
    },
  });
}

function resultOverlayForCandidate(options: {
  readonly previousLocation: ResolvedProject02RuntimeLocation;
  readonly previousOverlay: LoadedProject02CharacterOverlayConfig;
  readonly resultLocation: ResolvedProject02RuntimeLocation;
  readonly ownerToken: LocalRuntimeMutationLockOwnerToken;
  readonly leases: (
    LocalRuntimeMutationLocksLeaseSync | LocalRuntimeMutationLockLeaseSync
  )[];
}): LoadedProject02CharacterOverlayConfig {
  if (
    sameRuntimeConfigCharacterScope(
      options.resultLocation.characterScope,
      options.previousLocation.characterScope,
    )
  ) {
    return options.previousOverlay;
  }

  lockOverlayForScope({
    runtimeLocation: options.resultLocation,
    ownerToken: options.ownerToken,
    leases: options.leases,
    required: false,
  });

  return readCharacterOverlayForScope(options.resultLocation.characterScope)
    .overlay;
}

function assertCharacterOverlayMutable(
  target: ResolvedRuntimeConfigScopeTarget,
  overlay: LoadedProject02CharacterOverlayConfig | undefined,
): void {
  if (target.scope !== 'character' || overlay === undefined) {
    return;
  }

  const blocking = overlay.diagnostics.find(
    diagnostic => diagnostic.severity === 'error',
  );

  if (blocking !== undefined) {
    throw new RuntimeConfigMutationError(
      `Cannot mutate the character overlay because it failed to load: ${blocking.message}`,
    );
  }
}

function assertGlobalTargetOutsideCharacterData(path: string): void {
  const containingDirectory = dirname(path);

  if (basename(dirname(containingDirectory)) !== characterDataDirectoryName) {
    return;
  }

  throw new RuntimeConfigLocationError(
    `Runtime config path "${path}" is inside a character-data directory. ` +
      'Use --store with --character to select a character overlay.',
  );
}

function lockOverlayForScope(options: {
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly ownerToken: LocalRuntimeMutationLockOwnerToken;
  readonly leases: (
    LocalRuntimeMutationLocksLeaseSync | LocalRuntimeMutationLockLeaseSync
  )[];
  readonly required: boolean;
}): LockedOverlay {
  const overlayPath = options.runtimeLocation.overlayPath;
  const canonicalPath = canonicalRuntimeConfigMutationPath(overlayPath);

  if (!existsSync(dirname(canonicalPath))) {
    if (options.required) {
      throw new RuntimeConfigMutationError(
        `Could not write runtime config file at ${overlayPath}.`,
      );
    }

    return Object.freeze({canonicalPath, leaseAcquired: false});
  }

  let lease: LocalRuntimeMutationLockLeaseSync | undefined;

  try {
    lease = acquireLocalRuntimeMutationLockSync({
      locksRoot: createProject02HomeLayout({
        homeRoot: dirname(canonicalPath),
      }).locksRoot,
      resourceKey: `runtime-control-file:${canonicalPath}`,
      ownerToken: options.ownerToken,
    });
  } catch (error: unknown) {
    if (!options.required && lockFailureProvesNoOverlayWriter(error)) {
      return Object.freeze({canonicalPath, leaseAcquired: false});
    }

    throw runtimeConfigControlFileError(
      `Could not write runtime config file at ${overlayPath}.`,
      error,
    );
  }

  options.leases.push(lease);

  if (canonicalRuntimeConfigMutationPath(overlayPath) !== canonicalPath) {
    throw new RuntimeConfigControlPathDrift();
  }

  return Object.freeze({canonicalPath, leaseAcquired: true});
}

function requiredCharacterWritePath(
  target: Extract<
    ResolvedRuntimeConfigScopeTarget,
    {readonly scope: 'character'}
  >,
  lockedOverlay: LockedOverlay | undefined,
  commit: boolean,
): string {
  if (lockedOverlay === undefined) {
    throw new RuntimeConfigMutationError(
      `Character "${target.runtimeLocation.characterScope.characterId}" overlay lock is unavailable.`,
    );
  }

  if (commit && !lockedOverlay.leaseAcquired) {
    throw new RuntimeConfigMutationError(
      `Could not write runtime config file at ${target.configPath}.`,
    );
  }

  return lockedOverlay.canonicalPath;
}

function lockFailureProvesNoOverlayWriter(error: unknown): boolean {
  return (
    error instanceof LocalRuntimeStorageContractError &&
    !(error instanceof LocalRuntimeMutationLockBusyError)
  );
}

function acquireGlobalControlLocks(options: {
  readonly canonicalGlobalConfigPath: string;
  readonly displayGlobalConfigPath: string;
  readonly canonicalEnvPath?: string;
  readonly displayEnvPath?: string;
  readonly ownerToken: LocalRuntimeMutationLockOwnerToken;
}): LocalRuntimeMutationLocksLeaseSync {
  const paths =
    options.canonicalEnvPath === undefined
      ? [options.canonicalGlobalConfigPath]
      : [options.canonicalGlobalConfigPath, options.canonicalEnvPath];

  try {
    return acquireLocalRuntimeMutationLocksSync({
      targets: paths.map(path => ({
        locksRoot: createProject02HomeLayout({
          homeRoot: dirname(path),
        }).locksRoot,
        resourceKey: runtimeControlPathResourceKey(path),
      })),
      ownerToken: options.ownerToken,
    });
  } catch (error: unknown) {
    const failedTarget =
      error instanceof LocalRuntimeMutationLocksAcquireError
        ? error.target
        : undefined;
    const envFailed =
      options.canonicalEnvPath !== undefined &&
      failedTarget?.resourceKey ===
        runtimeControlPathResourceKey(options.canonicalEnvPath);

    throw runtimeConfigControlFileError(
      envFailed
        ? `Could not write runtime config env file at ${
            options.displayEnvPath ?? options.canonicalEnvPath
          }.`
        : `Could not write runtime config file at ${options.displayGlobalConfigPath}.`,
      error,
    );
  }
}

function runtimeControlPathResourceKey(path: string): string {
  return `runtime-control-file:${path}`;
}

function releaseControlLeases(
  leases: readonly (
    LocalRuntimeMutationLocksLeaseSync | LocalRuntimeMutationLockLeaseSync
  )[],
): void {
  let firstError: unknown;

  for (const lease of [...leases].reverse()) {
    try {
      lease.release();
    } catch (error: unknown) {
      firstError ??= error;
    }
  }

  if (firstError !== undefined) {
    throw firstError instanceof Error
      ? firstError
      : new RuntimeConfigMutationError(
          'Could not release all runtime config path locks.',
          {cause: firstError},
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

class RuntimeConfigControlPathDrift extends Error {
  readonly anticipatedEnvPath: string | undefined;

  constructor(anticipatedEnvPath?: string) {
    super('Runtime config mutation paths changed while locks were acquired.');
    this.name = 'RuntimeConfigControlPathDrift';
    this.anticipatedEnvPath = anticipatedEnvPath;
  }
}
