import {randomUUID} from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {hostname} from 'node:os';
import {basename, join} from 'node:path';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {isNodeErrorWithCode} from '../../shared/node-error.ts';
import {processIsAlive} from './process-liveness.ts';

import {
  LocalRuntimeStorageContractError,
  type LocalRuntimeStorageContractErrorCode,
} from './layout-contract.ts';
import {
  normalizeMutationLockTarget,
  normalizeMutationLockTargets,
  type LocalRuntimeMutationLockTarget,
  type NormalizedMutationLockTarget,
} from './mutation-lock-target.ts';

export type {LocalRuntimeMutationLockTarget} from './mutation-lock-target.ts';

export const defaultLocalRuntimeMutationLockWaitTimeoutMs = 10_000;
export const defaultLocalRuntimeMutationLockIncompleteGraceMs = 30_000;

type LocalRuntimeMutationLockBusyCode = Extract<
  LocalRuntimeStorageContractErrorCode,
  'session_busy' | 'storage_busy'
>;

export type AcquireLocalRuntimeMutationLockOptions = {
  readonly locksRoot: string;
  readonly resourceKey: string;
  readonly waitTimeoutMs?: number;
  readonly incompleteGraceMs?: number;
  readonly busyCode?: LocalRuntimeMutationLockBusyCode;
  readonly ownerToken?: LocalRuntimeMutationLockOwnerToken;
};

export type LocalRuntimeMutationLockOwnerToken = object;

export type AcquireLocalRuntimeMutationLocksOptions = Omit<
  AcquireLocalRuntimeMutationLockOptions,
  'locksRoot' | 'resourceKey'
> & {
  readonly targets: readonly LocalRuntimeMutationLockTarget[];
};

export type LocalRuntimeMutationLockLease = {
  readonly lockPath: string;
  readonly resourceKey: string;
  release(): Promise<void>;
};

export type LocalRuntimeMutationLockLeaseSync = {
  readonly lockPath: string;
  readonly resourceKey: string;
  release(): void;
};

export type LocalRuntimeMutationLocksLease = {
  readonly targets: readonly LocalRuntimeMutationLockTarget[];
  release(): Promise<void>;
};

export type LocalRuntimeMutationLocksLeaseSync = {
  readonly targets: readonly LocalRuntimeMutationLockTarget[];
  release(): void;
};

type MutationLockOwner = {
  readonly version: 1;
  readonly resourceKey: string;
  readonly nonce: string;
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
};

type MutationLockReclamationIntentOwner = {
  readonly version: 1;
  readonly pid: number;
  readonly hostname: string;
  readonly createdAt: string;
};

type ReclaimObservedMutationLockTestHooks = {
  readonly afterValidation?: () => void;
};

export class LocalRuntimeMutationLockBusyError extends LocalRuntimeStorageContractError {
  constructor(code: LocalRuntimeMutationLockBusyCode, message: string) {
    super(code, message);
    this.name = 'LocalRuntimeMutationLockBusyError';
  }
}

export class LocalRuntimeMutationLocksAcquireError extends Error {
  readonly target: LocalRuntimeMutationLockTarget;

  constructor(target: LocalRuntimeMutationLockTarget, cause: unknown) {
    super(
      `Could not acquire local runtime mutation lock for ${target.resourceKey}.`,
      {cause},
    );
    this.name = 'LocalRuntimeMutationLocksAcquireError';
    this.target = target;
  }
}

type AsyncOwnedMutationLock = {
  count: number;
  readonly lease: LocalRuntimeMutationLockLease;
};

type SyncOwnedMutationLock = {
  count: number;
  readonly lease: LocalRuntimeMutationLockLeaseSync;
};

const asyncOwnedMutationLocks = new WeakMap<
  LocalRuntimeMutationLockOwnerToken,
  Map<string, AsyncOwnedMutationLock>
>();
const syncOwnedMutationLocks = new WeakMap<
  LocalRuntimeMutationLockOwnerToken,
  Map<string, SyncOwnedMutationLock>
>();

export function createLocalRuntimeMutationLockOwnerToken(): LocalRuntimeMutationLockOwnerToken {
  return Object.freeze({});
}

export function localRuntimeMutationLockOwnerOwnsResource(options: {
  readonly locksRoot: string;
  readonly resourceKey: string;
  readonly ownerToken: LocalRuntimeMutationLockOwnerToken;
}): boolean {
  const resourceKey = options.resourceKey.trim();

  if (resourceKey.length === 0) {
    return false;
  }

  const {lockPath} = normalizeMutationLockTarget({
    locksRoot: options.locksRoot,
    resourceKey,
  });

  return (
    (asyncOwnedMutationLocks.get(options.ownerToken)?.get(lockPath)?.count ??
      0) > 0 ||
    (syncOwnedMutationLocks.get(options.ownerToken)?.get(lockPath)?.count ??
      0) > 0
  );
}

export async function acquireLocalRuntimeMutationLock(
  options: AcquireLocalRuntimeMutationLockOptions,
): Promise<LocalRuntimeMutationLockLease> {
  const normalized = normalizeMutationLockOptions(options);

  return acquireNormalizedMutationLock(normalized, options.ownerToken);
}

async function acquireNormalizedMutationLock(
  normalized: NormalizedMutationLockOptions,
  ownerToken: LocalRuntimeMutationLockOwnerToken | undefined,
): Promise<LocalRuntimeMutationLockLease> {
  const startedAt = Date.now();

  await prepareLocksRoot(normalized.locksRoot);

  for (;;) {
    const reentered = reenterAsyncMutationLock(ownerToken, normalized);

    if (reentered !== undefined) {
      return reentered;
    }

    const lease = await tryCreateMutationLock(normalized);

    if (lease !== undefined) {
      return registerAsyncMutationLockOwner(ownerToken, normalized, lease);
    }

    if (reclaimAbandonedMutationLock(normalized)) {
      continue;
    }

    const elapsedMs = Date.now() - startedAt;

    if (elapsedMs >= normalized.waitTimeoutMs) {
      throw new LocalRuntimeMutationLockBusyError(
        normalized.busyCode,
        `Local runtime mutation resource is busy: ${normalized.resourceKey}.`,
      );
    }

    await delay(
      Math.min(
        randomizedRetryDelayMs(),
        Math.max(1, normalized.waitTimeoutMs - elapsedMs),
      ),
    );
  }
}

export async function acquireLocalRuntimeMutationLocks(
  options: AcquireLocalRuntimeMutationLocksOptions,
): Promise<LocalRuntimeMutationLocksLease> {
  const {targets: inputTargets, ...lockOptions} = options;
  const normalizedTargets = normalizeMutationLockTargets(inputTargets);
  const targets = publicMutationLockTargets(normalizedTargets);
  const leases: LocalRuntimeMutationLockLease[] = [];
  const startedAt = Date.now();

  try {
    for (const target of normalizedTargets) {
      const configuredWaitMs =
        options.waitTimeoutMs ?? defaultLocalRuntimeMutationLockWaitTimeoutMs;
      const remainingWaitMs = Math.max(
        0,
        configuredWaitMs - (Date.now() - startedAt),
      );

      try {
        leases.push(
          await acquireNormalizedMutationLock(
            normalizedMutationLockOptionsForTarget(target, {
              ...lockOptions,
              waitTimeoutMs: remainingWaitMs,
            }),
            options.ownerToken,
          ),
        );
      } catch (error: unknown) {
        throw new LocalRuntimeMutationLocksAcquireError(
          publicMutationLockTarget(target),
          error,
        );
      }
    }
  } catch (error: unknown) {
    await releaseAsyncMutationLocksReverse(leases);
    throw error;
  }

  let released = false;

  return Object.freeze({
    targets,
    async release() {
      if (released) {
        return;
      }

      released = true;
      await releaseAsyncMutationLocksReverse(leases);
    },
  } satisfies LocalRuntimeMutationLocksLease);
}

export function acquireLocalRuntimeMutationLockSync(
  options: AcquireLocalRuntimeMutationLockOptions,
): LocalRuntimeMutationLockLeaseSync {
  const normalized = normalizeMutationLockOptions(options);

  return acquireNormalizedMutationLockSync(normalized, options.ownerToken);
}

function acquireNormalizedMutationLockSync(
  normalized: NormalizedMutationLockOptions,
  ownerToken: LocalRuntimeMutationLockOwnerToken | undefined,
): LocalRuntimeMutationLockLeaseSync {
  const startedAt = Date.now();

  prepareLocksRootSync(normalized.locksRoot);

  for (;;) {
    const reentered = reenterSyncMutationLock(ownerToken, normalized);

    if (reentered !== undefined) {
      return reentered;
    }

    const lease = tryCreateMutationLockSync(normalized);

    if (lease !== undefined) {
      return registerSyncMutationLockOwner(ownerToken, normalized, lease);
    }

    if (reclaimAbandonedMutationLockSync(normalized)) {
      continue;
    }

    const elapsedMs = Date.now() - startedAt;

    if (elapsedMs >= normalized.waitTimeoutMs) {
      throw new LocalRuntimeMutationLockBusyError(
        normalized.busyCode,
        `Local runtime mutation resource is busy: ${normalized.resourceKey}.`,
      );
    }

    sleepSync(
      Math.min(
        randomizedRetryDelayMs(),
        Math.max(1, normalized.waitTimeoutMs - elapsedMs),
      ),
    );
  }
}

export function acquireLocalRuntimeMutationLocksSync(
  options: AcquireLocalRuntimeMutationLocksOptions,
): LocalRuntimeMutationLocksLeaseSync {
  const {targets: inputTargets, ...lockOptions} = options;
  const normalizedTargets = normalizeMutationLockTargets(inputTargets);
  const targets = publicMutationLockTargets(normalizedTargets);
  const leases: LocalRuntimeMutationLockLeaseSync[] = [];
  const startedAt = Date.now();

  try {
    for (const target of normalizedTargets) {
      const configuredWaitMs =
        options.waitTimeoutMs ?? defaultLocalRuntimeMutationLockWaitTimeoutMs;
      const remainingWaitMs = Math.max(
        0,
        configuredWaitMs - (Date.now() - startedAt),
      );

      try {
        leases.push(
          acquireNormalizedMutationLockSync(
            normalizedMutationLockOptionsForTarget(target, {
              ...lockOptions,
              waitTimeoutMs: remainingWaitMs,
            }),
            options.ownerToken,
          ),
        );
      } catch (error: unknown) {
        throw new LocalRuntimeMutationLocksAcquireError(
          publicMutationLockTarget(target),
          error,
        );
      }
    }
  } catch (error: unknown) {
    releaseSyncMutationLocksReverse(leases);
    throw error;
  }

  let released = false;

  return Object.freeze({
    targets,
    release() {
      if (released) {
        return;
      }

      released = true;
      releaseSyncMutationLocksReverse(leases);
    },
  } satisfies LocalRuntimeMutationLocksLeaseSync);
}

type NormalizedMutationLockOptions = NormalizedMutationLockTarget & {
  readonly waitTimeoutMs: number;
  readonly incompleteGraceMs: number;
  readonly busyCode: LocalRuntimeMutationLockBusyCode;
};

function normalizeMutationLockOptions(
  options: AcquireLocalRuntimeMutationLockOptions,
): NormalizedMutationLockOptions {
  return normalizedMutationLockOptionsForTarget(
    normalizeMutationLockTarget(options),
    options,
  );
}

function normalizedMutationLockOptionsForTarget(
  target: NormalizedMutationLockTarget,
  options: Omit<
    AcquireLocalRuntimeMutationLockOptions,
    'locksRoot' | 'resourceKey'
  >,
): NormalizedMutationLockOptions {
  const waitTimeoutMs = normalizeNonNegativeSafeInteger(
    options.waitTimeoutMs ?? defaultLocalRuntimeMutationLockWaitTimeoutMs,
    'waitTimeoutMs',
  );
  const incompleteGraceMs = normalizeNonNegativeSafeInteger(
    options.incompleteGraceMs ??
      defaultLocalRuntimeMutationLockIncompleteGraceMs,
    'incompleteGraceMs',
  );

  return {
    ...target,
    waitTimeoutMs,
    incompleteGraceMs,
    busyCode: options.busyCode ?? 'storage_busy',
  };
}

function publicMutationLockTargets(
  targets: readonly NormalizedMutationLockTarget[],
): readonly LocalRuntimeMutationLockTarget[] {
  return Object.freeze(targets.map(publicMutationLockTarget));
}

function publicMutationLockTarget(
  target: NormalizedMutationLockTarget,
): LocalRuntimeMutationLockTarget {
  return Object.freeze({
    locksRoot: target.displayLocksRoot,
    resourceKey: target.resourceKey,
  });
}

function reenterAsyncMutationLock(
  ownerToken: LocalRuntimeMutationLockOwnerToken | undefined,
  options: NormalizedMutationLockOptions,
): LocalRuntimeMutationLockLease | undefined {
  if (ownerToken === undefined) {
    return undefined;
  }

  const owned = asyncOwnedMutationLocks.get(ownerToken)?.get(options.lockPath);

  if (owned === undefined) {
    return undefined;
  }

  owned.count += 1;
  return createReenteredAsyncLease(ownerToken, options, owned);
}

function registerAsyncMutationLockOwner(
  ownerToken: LocalRuntimeMutationLockOwnerToken | undefined,
  options: NormalizedMutationLockOptions,
  lease: LocalRuntimeMutationLockLease,
): LocalRuntimeMutationLockLease {
  if (ownerToken === undefined) {
    return lease;
  }

  const ownerLocks =
    asyncOwnedMutationLocks.get(ownerToken) ??
    new Map<string, AsyncOwnedMutationLock>();
  const owned = {count: 1, lease} satisfies AsyncOwnedMutationLock;

  ownerLocks.set(options.lockPath, owned);
  asyncOwnedMutationLocks.set(ownerToken, ownerLocks);
  return createReenteredAsyncLease(ownerToken, options, owned);
}

function createReenteredAsyncLease(
  ownerToken: LocalRuntimeMutationLockOwnerToken,
  options: NormalizedMutationLockOptions,
  owned: AsyncOwnedMutationLock,
): LocalRuntimeMutationLockLease {
  let released = false;

  return Object.freeze({
    lockPath: options.lockPath,
    resourceKey: options.resourceKey,
    async release() {
      if (released) {
        return;
      }

      released = true;
      owned.count -= 1;

      if (owned.count !== 0) {
        return;
      }

      asyncOwnedMutationLocks.get(ownerToken)?.delete(options.lockPath);
      await owned.lease.release();
    },
  } satisfies LocalRuntimeMutationLockLease);
}

function reenterSyncMutationLock(
  ownerToken: LocalRuntimeMutationLockOwnerToken | undefined,
  options: NormalizedMutationLockOptions,
): LocalRuntimeMutationLockLeaseSync | undefined {
  if (ownerToken === undefined) {
    return undefined;
  }

  const owned = syncOwnedMutationLocks.get(ownerToken)?.get(options.lockPath);

  if (owned === undefined) {
    return undefined;
  }

  owned.count += 1;
  return createReenteredSyncLease(ownerToken, options, owned);
}

function registerSyncMutationLockOwner(
  ownerToken: LocalRuntimeMutationLockOwnerToken | undefined,
  options: NormalizedMutationLockOptions,
  lease: LocalRuntimeMutationLockLeaseSync,
): LocalRuntimeMutationLockLeaseSync {
  if (ownerToken === undefined) {
    return lease;
  }

  const ownerLocks =
    syncOwnedMutationLocks.get(ownerToken) ??
    new Map<string, SyncOwnedMutationLock>();
  const owned = {count: 1, lease} satisfies SyncOwnedMutationLock;

  ownerLocks.set(options.lockPath, owned);
  syncOwnedMutationLocks.set(ownerToken, ownerLocks);
  return createReenteredSyncLease(ownerToken, options, owned);
}

function createReenteredSyncLease(
  ownerToken: LocalRuntimeMutationLockOwnerToken,
  options: NormalizedMutationLockOptions,
  owned: SyncOwnedMutationLock,
): LocalRuntimeMutationLockLeaseSync {
  let released = false;

  return Object.freeze({
    lockPath: options.lockPath,
    resourceKey: options.resourceKey,
    release() {
      if (released) {
        return;
      }

      released = true;
      owned.count -= 1;

      if (owned.count !== 0) {
        return;
      }

      syncOwnedMutationLocks.get(ownerToken)?.delete(options.lockPath);
      owned.lease.release();
    },
  } satisfies LocalRuntimeMutationLockLeaseSync);
}

async function releaseAsyncMutationLocksReverse(
  leases: readonly LocalRuntimeMutationLockLease[],
): Promise<void> {
  let firstError: unknown;

  for (const lease of [...leases].reverse()) {
    try {
      await lease.release();
    } catch (error: unknown) {
      firstError ??= error;
    }
  }

  if (firstError !== undefined) {
    throw errorFromUnknown(
      firstError,
      'Could not release all local runtime mutation locks.',
    );
  }
}

function releaseSyncMutationLocksReverse(
  leases: readonly LocalRuntimeMutationLockLeaseSync[],
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
    throw errorFromUnknown(
      firstError,
      'Could not release all local runtime mutation locks.',
    );
  }
}

function errorFromUnknown(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message, {cause: error});
}

async function prepareLocksRoot(locksRoot: string): Promise<void> {
  try {
    await mkdir(locksRoot, {recursive: true});
  } catch (error: unknown) {
    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not prepare local runtime mutation lock directory: ${locksRoot}.`,
      {cause: error},
    );
  }
}

function prepareLocksRootSync(locksRoot: string): void {
  try {
    mkdirSync(locksRoot, {recursive: true});
  } catch (error: unknown) {
    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not prepare local runtime mutation lock directory: ${locksRoot}.`,
      {cause: error},
    );
  }
}

async function tryCreateMutationLock(
  options: NormalizedMutationLockOptions,
): Promise<LocalRuntimeMutationLockLease | undefined> {
  if (hasActiveMutationLockReclamationIntentSync(options)) {
    return undefined;
  }

  try {
    await mkdir(options.lockPath);
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'EEXIST')) {
      return undefined;
    }

    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not create local runtime mutation lock: ${options.lockPath}.`,
      {cause: error},
    );
  }

  const now = new Date().toISOString();
  const owner = {
    version: 1,
    resourceKey: options.resourceKey,
    nonce: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: now,
  } satisfies MutationLockOwner;

  try {
    await writeFile(ownerPath(options.lockPath), `${JSON.stringify(owner)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return undefined;
    }

    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not materialize local runtime mutation lock owner: ${options.lockPath}.`,
      {cause: error},
    );
  }

  if (hasActiveMutationLockReclamationIntentSync(options)) {
    await releaseOwnedMutationLock(options.lockPath, owner.nonce);
    return undefined;
  }

  const materializedOwner = await readMutationLockOwner(options.lockPath);

  if (materializedOwner?.nonce !== owner.nonce) {
    return undefined;
  }

  let released = false;

  return Object.freeze({
    lockPath: options.lockPath,
    resourceKey: options.resourceKey,
    async release() {
      if (released) {
        return;
      }

      released = true;
      await releaseOwnedMutationLock(options.lockPath, owner.nonce);
    },
  } satisfies LocalRuntimeMutationLockLease);
}

function tryCreateMutationLockSync(
  options: NormalizedMutationLockOptions,
): LocalRuntimeMutationLockLeaseSync | undefined {
  if (hasActiveMutationLockReclamationIntentSync(options)) {
    return undefined;
  }

  try {
    mkdirSync(options.lockPath);
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'EEXIST')) {
      return undefined;
    }

    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not create local runtime mutation lock: ${options.lockPath}.`,
      {cause: error},
    );
  }

  const now = new Date().toISOString();
  const owner = {
    version: 1,
    resourceKey: options.resourceKey,
    nonce: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: now,
  } satisfies MutationLockOwner;

  try {
    writeFileSync(ownerPath(options.lockPath), `${JSON.stringify(owner)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return undefined;
    }

    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not materialize local runtime mutation lock owner: ${options.lockPath}.`,
      {cause: error},
    );
  }

  if (hasActiveMutationLockReclamationIntentSync(options)) {
    releaseOwnedMutationLockSync(options.lockPath, owner.nonce);
    return undefined;
  }

  const materializedOwner = readMutationLockOwnerSync(options.lockPath);

  if (materializedOwner?.nonce !== owner.nonce) {
    return undefined;
  }

  let released = false;

  return Object.freeze({
    lockPath: options.lockPath,
    resourceKey: options.resourceKey,
    release() {
      if (released) {
        return;
      }

      released = true;
      releaseOwnedMutationLockSync(options.lockPath, owner.nonce);
    },
  } satisfies LocalRuntimeMutationLockLeaseSync);
}

async function releaseOwnedMutationLock(
  lockPath: string,
  nonce: string,
): Promise<void> {
  const owner = await readMutationLockOwner(lockPath);

  if (owner?.nonce !== nonce) {
    return;
  }

  await rm(lockPath, {force: true, recursive: true});
}

function releaseOwnedMutationLockSync(lockPath: string, nonce: string): void {
  const owner = readMutationLockOwnerSync(lockPath);

  if (owner?.nonce !== nonce) {
    return;
  }

  rmSync(lockPath, {force: true, recursive: true});
}

function reclaimAbandonedMutationLock(
  options: NormalizedMutationLockOptions,
): boolean {
  return reclaimAbandonedMutationLockSync(options);
}

/** @internal Exposed only for deterministic generation-race regression tests. */
export function reclaimObservedLocalRuntimeMutationLock(
  options: AcquireLocalRuntimeMutationLockOptions,
  observedOwner: unknown,
  hooks: ReclaimObservedMutationLockTestHooks = {},
): Promise<boolean> {
  if (!isMutationLockOwner(observedOwner)) {
    throw new TypeError(
      'Observed local runtime mutation lock owner is invalid.',
    );
  }

  return Promise.resolve(
    reclaimObservedMutationLockSync(
      normalizeMutationLockOptions(options),
      observedOwner,
      hooks,
    ),
  );
}

function reclaimAbandonedMutationLockSync(
  options: NormalizedMutationLockOptions,
): boolean {
  if (hasActiveMutationLockReclamationIntentSync(options)) {
    return false;
  }

  const owner = readMutationLockOwnerSync(options.lockPath);

  if (owner !== undefined) {
    return reclaimObservedMutationLockSync(options, owner);
  }

  let observedLockStat: ReturnType<typeof statSync>;

  try {
    observedLockStat = statSync(options.lockPath);
  } catch (error: unknown) {
    return isNodeErrorWithCode(error, 'ENOENT');
  }

  if (
    options.incompleteGraceMs > 0 &&
    Date.now() - observedLockStat.mtimeMs < options.incompleteGraceMs
  ) {
    return false;
  }

  return withMutationLockReclamationIntentSync(options, () => {
    const currentOwner = readMutationLockOwnerSync(options.lockPath);

    if (currentOwner !== undefined) {
      return reclaimObservedMutationLockUnderIntentSync(options, currentOwner);
    }

    let currentLockStat: ReturnType<typeof statSync>;

    try {
      currentLockStat = statSync(options.lockPath);
    } catch (error: unknown) {
      return isNodeErrorWithCode(error, 'ENOENT');
    }

    if (
      currentLockStat.dev !== observedLockStat.dev ||
      currentLockStat.ino !== observedLockStat.ino ||
      currentLockStat.mtimeMs !== observedLockStat.mtimeMs
    ) {
      return false;
    }

    return quarantineMutationLockSync(options);
  });
}

function reclaimObservedMutationLockSync(
  options: NormalizedMutationLockOptions,
  observedOwner: MutationLockOwner,
  hooks: ReclaimObservedMutationLockTestHooks = {},
): boolean {
  if (
    observedOwner.hostname !== hostname() ||
    processIsAlive(observedOwner.pid)
  ) {
    return false;
  }

  return withMutationLockReclamationIntentSync(options, () => {
    const reclaimed = reclaimObservedMutationLockUnderIntentSync(
      options,
      observedOwner,
      hooks,
    );

    return reclaimed;
  });
}

function reclaimObservedMutationLockUnderIntentSync(
  options: NormalizedMutationLockOptions,
  observedOwner: MutationLockOwner,
  hooks: ReclaimObservedMutationLockTestHooks = {},
): boolean {
  const currentOwner = readMutationLockOwnerSync(options.lockPath);

  if (
    currentOwner === undefined ||
    !sameMutationLockOwnerGeneration(currentOwner, observedOwner) ||
    currentOwner.hostname !== hostname() ||
    processIsAlive(currentOwner.pid)
  ) {
    return false;
  }

  hooks.afterValidation?.();
  return quarantineMutationLockSync(options);
}

function sameMutationLockOwnerGeneration(
  currentOwner: MutationLockOwner,
  observedOwner: MutationLockOwner,
): boolean {
  return (
    currentOwner.resourceKey === observedOwner.resourceKey &&
    currentOwner.nonce === observedOwner.nonce &&
    currentOwner.pid === observedOwner.pid &&
    currentOwner.hostname === observedOwner.hostname &&
    currentOwner.acquiredAt === observedOwner.acquiredAt
  );
}

function withMutationLockReclamationIntentSync(
  options: NormalizedMutationLockOptions,
  operation: () => boolean,
): boolean {
  const intentPath = `${options.lockPath}.reclaim-${randomUUID()}`;
  const now = new Date().toISOString();
  const intentOwner = {
    version: 1,
    pid: process.pid,
    hostname: hostname(),
    createdAt: now,
  } satisfies MutationLockReclamationIntentOwner;
  let created = false;

  try {
    mkdirSync(intentPath);
    created = true;
    writeFileSync(ownerPath(intentPath), `${JSON.stringify(intentOwner)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error: unknown) {
    if (created) {
      rmSync(intentPath, {force: true, recursive: true});
    }
    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not create local runtime mutation-lock reclamation intent: ${intentPath}.`,
      {cause: error},
    );
  }

  try {
    return operation();
  } finally {
    rmSync(intentPath, {force: true, recursive: true});
  }
}

function hasActiveMutationLockReclamationIntentSync(
  options: NormalizedMutationLockOptions,
): boolean {
  const prefix = `${basename(options.lockPath)}.reclaim-`;
  let entries: readonly string[];

  try {
    entries = readdirSync(options.locksRoot);
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return false;
    }

    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not inspect local runtime mutation-lock reclamation intents: ${options.locksRoot}.`,
      {cause: error},
    );
  }

  for (const entry of entries) {
    if (!entry.startsWith(prefix)) {
      continue;
    }

    const intentPath = join(options.locksRoot, entry);
    const owner = readMutationLockReclamationIntentOwnerSync(intentPath);

    if (owner !== undefined) {
      if (owner.hostname === hostname() && !processIsAlive(owner.pid)) {
        rmSync(intentPath, {force: true, recursive: true});
        continue;
      }

      return true;
    }

    let intentStat: ReturnType<typeof statSync>;

    try {
      intentStat = statSync(intentPath);
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, 'ENOENT')) {
        continue;
      }

      return true;
    }

    if (
      options.incompleteGraceMs > 0 &&
      Date.now() - intentStat.mtimeMs < options.incompleteGraceMs
    ) {
      return true;
    }

    rmSync(intentPath, {force: true, recursive: true});
  }

  return false;
}

function readMutationLockReclamationIntentOwnerSync(
  intentPath: string,
): MutationLockReclamationIntentOwner | undefined {
  let raw: string;

  try {
    raw = readFileSync(ownerPath(intentPath), 'utf8');
  } catch {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return isMutationLockReclamationIntentOwner(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function quarantineMutationLockSync(
  options: NormalizedMutationLockOptions,
): boolean {
  const quarantinePath = `${options.lockPath}.stale-${randomUUID()}`;

  try {
    renameSync(options.lockPath, quarantinePath);
  } catch (error: unknown) {
    return isNodeErrorWithCode(error, 'ENOENT');
  }

  rmSync(quarantinePath, {force: true, recursive: true});
  return true;
}

async function readMutationLockOwner(
  lockPath: string,
): Promise<MutationLockOwner | undefined> {
  let raw: string;

  try {
    raw = await readFile(ownerPath(lockPath), 'utf8');
  } catch {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;

    return isMutationLockOwner(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readMutationLockOwnerSync(
  lockPath: string,
): MutationLockOwner | undefined {
  let raw: string;

  try {
    raw = readFileSync(ownerPath(lockPath), 'utf8');
  } catch {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;

    return isMutationLockOwner(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isMutationLockOwner(value: unknown): value is MutationLockOwner {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const owner = value as Record<string, unknown>;

  return (
    owner['version'] === 1 &&
    typeof owner['resourceKey'] === 'string' &&
    typeof owner['nonce'] === 'string' &&
    Number.isSafeInteger(owner['pid']) &&
    (owner['pid'] as number) > 0 &&
    typeof owner['hostname'] === 'string' &&
    typeof owner['acquiredAt'] === 'string'
  );
}

function isMutationLockReclamationIntentOwner(
  value: unknown,
): value is MutationLockReclamationIntentOwner {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const owner = value as Record<string, unknown>;

  return (
    owner['version'] === 1 &&
    Number.isSafeInteger(owner['pid']) &&
    (owner['pid'] as number) > 0 &&
    typeof owner['hostname'] === 'string' &&
    typeof owner['createdAt'] === 'string'
  );
}

function ownerPath(lockPath: string): string {
  return join(lockPath, 'owner.json');
}

function randomizedRetryDelayMs(): number {
  return 10 + Math.floor(Math.random() * 91);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>(resolveDelay => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function sleepSync(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function normalizeNonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }

  return value;
}
