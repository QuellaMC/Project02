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
import {assertCharacterDataDirReadable} from '../storage/character-data.ts';
import {
  acquireLocalRuntimeMutationLockSync,
  createLocalRuntimeMutationLockOwnerToken,
  defaultLocalRuntimeMutationLockWaitTimeoutMs,
  LocalRuntimeMutationLockBusyError,
  type LocalRuntimeMutationLockLeaseSync,
  type LocalRuntimeMutationLockOwnerToken,
  type LocalRuntimeMutationLocksLeaseSync,
} from '../storage/mutation-lock.ts';
import {runtimeConfigEnvPathForLocation} from './env-file.ts';
import {createLayeredRuntimeConfigFingerprint} from './fingerprint.ts';
import {
  loadProject02RuntimeConfig,
  RuntimeConfigLocationError,
} from './load.ts';
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
  characterOverlayConfigPath,
  deriveRuntimeConfigCharacterScope,
  layeredRuntimeConfigFingerprintForScope,
  loadCharacterOverlayForScope,
  type LoadedProject02CharacterOverlayConfig,
} from './overlay.ts';
import type {
  LoadedProject02RuntimeConfig,
  Project02RuntimeConfig,
  ResolvedRuntimeConfigScopeTarget,
  RuntimeConfigCharacterScope,
  RuntimeConfigMutationOperation,
} from './types.ts';

export type RuntimeConfigControlSnapshot = {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly globalDocument: Project02RuntimeConfig;
  readonly characterScope: RuntimeConfigCharacterScope | undefined;
  readonly overlay: LoadedProject02CharacterOverlayConfig | undefined;
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
  preflightRuntimeConfigControlTarget(target);
  const loadedConfig = loadSelectedGlobalConfig(target);
  const canonicalGlobalConfigPath = canonicalRuntimeConfigMutationPath(
    loadedConfig.path ?? target.globalConfigPath,
  );
  assertGlobalTargetOutsideCharacterData(canonicalGlobalConfigPath);

  return snapshotFromLoadedGlobal({
    target,
    loadedConfig,
    characterScope: controlCharacterScope(target, loadedConfig),
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
  preflightRuntimeConfigControlTarget(options.target);

  let anticipatedEnvPath = options.secretMutation
    ? currentRuntimeConfigEnvPath(options.target)
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
      options.target.globalConfigPath,
    );
    assertGlobalTargetOutsideCharacterData(canonicalGlobalConfigPath);
    const canonicalAnticipatedEnvPath =
      anticipatedEnvPath === undefined
        ? undefined
        : canonicalRuntimeConfigMutationPath(anticipatedEnvPath);

    leases.push(
      acquireGlobalControlLocks({
        canonicalGlobalConfigPath,
        displayGlobalConfigPath: options.target.globalConfigPath,
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
    const currentCanonicalGlobalConfigPath = canonicalRuntimeConfigMutationPath(
      loadedConfig.path ?? options.target.globalConfigPath,
    );

    if (currentCanonicalGlobalConfigPath !== canonicalGlobalConfigPath) {
      throw new RuntimeConfigControlPathDrift();
    }

    assertGlobalTargetOutsideCharacterData(currentCanonicalGlobalConfigPath);
    const currentEnvPath = runtimeConfigEnvPathForLocation({
      loadedConfig,
      ...(options.target.selectedStoreRoot === undefined
        ? {}
        : {storeRoot: options.target.selectedStoreRoot}),
    });
    const currentCanonicalEnvPath =
      canonicalRuntimeConfigMutationPath(currentEnvPath);

    if (
      options.secretMutation &&
      currentCanonicalEnvPath !== canonicalAnticipatedEnvPath
    ) {
      throw new RuntimeConfigControlPathDrift(currentEnvPath);
    }

    const characterScope = controlCharacterScope(options.target, loadedConfig);
    const lockedOverlay =
      characterScope === undefined
        ? undefined
        : lockOverlayForScope({
            characterScope,
            ownerToken,
            leases,
            required: options.target.scope === 'character',
          });
    const snapshot = snapshotFromLoadedGlobal({
      target: options.target,
      loadedConfig,
      characterScope,
    });

    if (options.expectedFingerprint !== undefined) {
      verifyRuntimeConfigControlExpectation(
        snapshot,
        options.expectedFingerprint,
      );
    }

    const preparation = options.prepare(snapshot);
    const candidateEnvPath = runtimeConfigControlCandidateEnvPath({
      target: options.target,
      snapshot,
      candidate: preparation.preparedCandidate.config,
    });
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
    const resultScope =
      options.target.scope === 'character'
        ? options.target.characterScope
        : controlCharacterScopeForCandidate(
            options.target,
            preparation.preparedCandidate.config,
          );
    const resultOverlay = resultOverlayForCandidate({
      previousScope: snapshot.characterScope,
      previousOverlay: snapshot.overlay,
      resultScope,
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
                characterId: options.target.characterScope.characterId,
                overlayConfig: preparation.preparedCandidate.config,
              })
            : layeredRuntimeConfigFingerprintForScope({
                globalConfig: preparation.preparedCandidate.config,
                characterScope: resultScope,
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

function currentRuntimeConfigEnvPath(
  target: ResolvedRuntimeConfigScopeTarget,
): string {
  const loadedConfig = loadSelectedGlobalConfig(target);

  return runtimeConfigEnvPathForLocation({
    loadedConfig,
    ...(target.selectedStoreRoot === undefined
      ? {}
      : {storeRoot: target.selectedStoreRoot}),
  });
}

function snapshotFromLoadedGlobal(options: {
  readonly target: ResolvedRuntimeConfigScopeTarget;
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly characterScope: RuntimeConfigCharacterScope | undefined;
}): RuntimeConfigControlSnapshot {
  if (options.target.scope === 'character') {
    assertGlobalConfigLoadableForCharacterScope(options.loadedConfig);
  }

  const globalDocument = createRuntimeConfigMutationBase({
    loadedConfig: options.loadedConfig,
    configPath: options.target.globalConfigPath,
    ...(options.target.selectedStoreRoot === undefined
      ? {}
      : {storeRoot: options.target.selectedStoreRoot}),
  });
  const overlay =
    options.characterScope === undefined
      ? undefined
      : loadCharacterOverlayForScope(options.characterScope);

  assertCharacterOverlayMutable(options.target, overlay);

  return Object.freeze({
    loadedConfig: options.loadedConfig,
    globalDocument,
    characterScope: options.characterScope,
    overlay,
  });
}

function loadSelectedGlobalConfig(
  target: ResolvedRuntimeConfigScopeTarget,
): LoadedProject02RuntimeConfig {
  return loadProject02RuntimeConfig({
    configPath: target.globalConfigPath,
    ...(target.env === undefined ? {} : {env: target.env}),
    ...(target.selectedStoreRoot === undefined
      ? {}
      : {storeRoot: target.selectedStoreRoot}),
  });
}

function controlCharacterScope(
  target: ResolvedRuntimeConfigScopeTarget,
  loadedConfig: LoadedProject02RuntimeConfig,
): RuntimeConfigCharacterScope | undefined {
  if (target.scope === 'character' || target.characterScope !== undefined) {
    return target.characterScope;
  }

  return deriveRuntimeConfigCharacterScope({
    loadedConfig,
    ...(target.selectedStoreRoot === undefined
      ? {}
      : {storeRoot: target.selectedStoreRoot}),
  });
}

function controlCharacterScopeForCandidate(
  target: Extract<ResolvedRuntimeConfigScopeTarget, {readonly scope: 'global'}>,
  config: Project02RuntimeConfig,
): RuntimeConfigCharacterScope | undefined {
  if (target.characterScope !== undefined) {
    return target.characterScope;
  }

  return deriveRuntimeConfigCharacterScope({
    loadedConfig: Object.freeze({
      source: 'path',
      path: target.globalConfigPath,
      config,
      diagnostics: Object.freeze([]),
    }),
    ...(target.selectedStoreRoot === undefined
      ? {}
      : {storeRoot: target.selectedStoreRoot}),
  });
}

function runtimeConfigControlCandidateEnvPath(options: {
  readonly target: ResolvedRuntimeConfigScopeTarget;
  readonly snapshot: RuntimeConfigControlSnapshot;
  readonly candidate: Project02RuntimeConfig;
}): string {
  const globalConfig =
    options.target.scope === 'global'
      ? options.candidate
      : options.snapshot.globalDocument;

  return runtimeConfigEnvPathForLocation({
    loadedConfig: Object.freeze({
      source: 'path',
      path: options.target.globalConfigPath,
      config: globalConfig,
      diagnostics: Object.freeze([]),
    }),
    ...(options.target.selectedStoreRoot === undefined
      ? {}
      : {storeRoot: options.target.selectedStoreRoot}),
  });
}

function resultOverlayForCandidate(options: {
  readonly previousScope: RuntimeConfigCharacterScope | undefined;
  readonly previousOverlay: LoadedProject02CharacterOverlayConfig | undefined;
  readonly resultScope: RuntimeConfigCharacterScope | undefined;
  readonly ownerToken: LocalRuntimeMutationLockOwnerToken;
  readonly leases: (
    LocalRuntimeMutationLocksLeaseSync | LocalRuntimeMutationLockLeaseSync
  )[];
}): LoadedProject02CharacterOverlayConfig | undefined {
  if (options.resultScope === undefined) {
    return undefined;
  }

  if (sameCharacterScope(options.resultScope, options.previousScope)) {
    return options.previousOverlay;
  }

  lockOverlayForScope({
    characterScope: options.resultScope,
    ownerToken: options.ownerToken,
    leases: options.leases,
    required: false,
  });

  return loadCharacterOverlayForScope(options.resultScope);
}

function sameCharacterScope(
  left: RuntimeConfigCharacterScope,
  right: RuntimeConfigCharacterScope | undefined,
): boolean {
  return (
    right !== undefined &&
    left.characterId === right.characterId &&
    left.dataRoot === right.dataRoot
  );
}

function preflightRuntimeConfigControlTarget(
  target: ResolvedRuntimeConfigScopeTarget,
): void {
  assertGlobalTargetOutsideCharacterData(
    canonicalRuntimeConfigMutationPath(target.globalConfigPath),
  );

  if (target.scope !== 'character') {
    return;
  }

  assertGlobalConfigLoadableForCharacterScope(loadSelectedGlobalConfig(target));
  const marker = assertCharacterDataDirReadable({
    storageOptions: {storeRoot: target.characterScope.dataRoot},
    characterId: target.characterScope.characterId,
  });

  if (marker === undefined) {
    throw new RuntimeConfigMutationError(
      `Config file "${target.configPath}" sits in a character-data ` +
        'directory that has no identity marker; run the command with ' +
        `--character ${target.characterScope.characterId} to initialize it first.`,
    );
  }

  assertCharacterOverlayMutable(
    target,
    loadCharacterOverlayForScope(target.characterScope),
  );
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
  readonly characterScope: RuntimeConfigCharacterScope;
  readonly ownerToken: LocalRuntimeMutationLockOwnerToken;
  readonly leases: (
    LocalRuntimeMutationLocksLeaseSync | LocalRuntimeMutationLockLeaseSync
  )[];
  readonly required: boolean;
}): LockedOverlay {
  const overlayPath = characterOverlayConfigPath(
    options.characterScope.dataRoot,
  );
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
      `Character "${target.characterScope.characterId}" overlay lock is unavailable.`,
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
    return acquireControlPathLocks(paths, options.ownerToken);
  } catch (error: unknown) {
    const pathError =
      error instanceof RuntimeControlPathLockError ? error : undefined;
    const envFailed =
      options.canonicalEnvPath !== undefined &&
      pathError?.path === options.canonicalEnvPath;

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

class RuntimeControlPathLockError extends Error {
  readonly path: string;

  constructor(path: string, options?: ErrorOptions) {
    super(`Could not acquire runtime control path lock for ${path}.`, options);
    this.name = 'RuntimeControlPathLockError';
    this.path = path;
  }
}

function acquireControlPathLocks(
  canonicalPathsInput: readonly string[],
  ownerToken: LocalRuntimeMutationLockOwnerToken,
): LocalRuntimeMutationLocksLeaseSync {
  const canonicalPaths = Object.freeze(
    [...new Set(canonicalPathsInput)].sort(compareCodeUnits),
  );
  const leases: LocalRuntimeMutationLockLeaseSync[] = [];
  const startedAt = Date.now();

  try {
    for (const path of canonicalPaths) {
      try {
        leases.push(
          acquireLocalRuntimeMutationLockSync({
            locksRoot: createProject02HomeLayout({
              homeRoot: dirname(path),
            }).locksRoot,
            resourceKey: `runtime-control-file:${path}`,
            waitTimeoutMs: Math.max(
              0,
              defaultLocalRuntimeMutationLockWaitTimeoutMs -
                (Date.now() - startedAt),
            ),
            ownerToken,
          }),
        );
      } catch (error: unknown) {
        throw new RuntimeControlPathLockError(path, {cause: error});
      }
    }
  } catch (error: unknown) {
    releaseControlLeases(leases);
    throw error;
  }

  let released = false;

  return Object.freeze({
    resourceKeys: Object.freeze(
      canonicalPaths.map(path => `runtime-control-file:${path}`),
    ),
    release() {
      if (released) {
        return;
      }

      released = true;
      releaseControlLeases(leases);
    },
  } satisfies LocalRuntimeMutationLocksLeaseSync);
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

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

class RuntimeConfigControlPathDrift extends Error {
  readonly anticipatedEnvPath: string | undefined;

  constructor(anticipatedEnvPath?: string) {
    super('Runtime config mutation paths changed while locks were acquired.');
    this.name = 'RuntimeConfigControlPathDrift';
    this.anticipatedEnvPath = anticipatedEnvPath;
  }
}
