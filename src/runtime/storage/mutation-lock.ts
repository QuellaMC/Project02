import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import {basename, join} from 'node:path';
import {
  listDirectoryNamesSync,
  makeDirectorySync,
  readTextFileSync,
  removePathSync,
  renamePathSync,
  statPathNumericSync,
  writeTextFileSync,
  type Stats,
} from '../../shared/file-system.ts';
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

const defaultLocalRuntimeMutationLockWaitTimeoutMs = 10_000;
const defaultLocalRuntimeMutationLockIncompleteGraceMs = 30_000;

type LocalRuntimeMutationLockBusyCode = Extract<
  LocalRuntimeStorageContractErrorCode,
  'session_busy' | 'storage_busy'
>;

type AcquireLocalRuntimeMutationLockOptions = {
  readonly locksRoot: string;
  readonly resourceKey: string;
  readonly waitTimeoutMs?: number;
  readonly incompleteGraceMs?: number;
  readonly busyCode?: LocalRuntimeMutationLockBusyCode;
  readonly ownerToken?: LocalRuntimeMutationLockOwnerToken;
};

export type LocalRuntimeMutationLockOwnerToken = object;

type AcquireLocalRuntimeMutationLocksOptions = Omit<
  AcquireLocalRuntimeMutationLockOptions,
  'locksRoot' | 'resourceKey'
> & {
  readonly targets: readonly LocalRuntimeMutationLockTarget[];
};

type LocalRuntimeMutationLockLeaseSync = {
  readonly lockPath: string;
  readonly resourceKey: string;
  release(): void;
};

/**
 * The awaiting entry point's view of the one lease: the lock work is
 * synchronous, and `release` is a promise only so callers stay symmetric
 * with the `await` that acquired it.
 */
export type LocalRuntimeMutationLockLease = Omit<
  LocalRuntimeMutationLockLeaseSync,
  'release'
> & {
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

type OwnedMutationLock = {
  count: number;
  readonly lease: LocalRuntimeMutationLockLeaseSync;
};

/** One registry, so a token's reentrancy is the same from every entry point. */
const ownedMutationLocks = new WeakMap<
  LocalRuntimeMutationLockOwnerToken,
  Map<string, OwnedMutationLock>
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
    (ownedMutationLocks.get(options.ownerToken)?.get(lockPath)?.count ?? 0) > 0
  );
}

export async function acquireLocalRuntimeMutationLock(
  options: AcquireLocalRuntimeMutationLockOptions,
): Promise<LocalRuntimeMutationLockLease> {
  const normalized = normalizeMutationLockOptions(options);
  const wait = startMutationLockWait(normalized);

  prepareLocksRoot(normalized.locksRoot);

  for (;;) {
    const attempt = attemptMutationLockAcquire(normalized, options.ownerToken);

    if (attempt.status === 'acquired') {
      return awaitableMutationLockLease(attempt.lease);
    }

    if (attempt.status === 'contended') {
      await delay(wait.remainingRetryDelayMs());
    }
  }
}

/** @internal For reentrancy and abandoned-lock regression tests. */
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
  const wait = startMutationLockWait(normalized);

  prepareLocksRoot(normalized.locksRoot);

  for (;;) {
    const attempt = attemptMutationLockAcquire(normalized, ownerToken);

    if (attempt.status === 'acquired') {
      return attempt.lease;
    }

    if (attempt.status === 'contended') {
      sleepSync(wait.remainingRetryDelayMs());
    }
  }
}

type MutationLockAttempt =
  | {
      readonly status: 'acquired';
      readonly lease: LocalRuntimeMutationLockLeaseSync;
    }
  /** A reclaimed abandoned lock is progress, so the next try comes at once. */
  | {readonly status: 'reclaimed'}
  | {readonly status: 'contended'};

function attemptMutationLockAcquire(
  normalized: NormalizedMutationLockOptions,
  ownerToken: LocalRuntimeMutationLockOwnerToken | undefined,
): MutationLockAttempt {
  const reentered = reenterMutationLock(ownerToken, normalized);

  if (reentered !== undefined) {
    return {status: 'acquired', lease: reentered};
  }

  const lease = tryCreateMutationLock(normalized);

  if (lease !== undefined) {
    return {
      status: 'acquired',
      lease: registerMutationLockOwner(ownerToken, normalized, lease),
    };
  }

  return reclaimAbandonedMutationLock(normalized)
    ? {status: 'reclaimed'}
    : {status: 'contended'};
}

function awaitableMutationLockLease(
  lease: LocalRuntimeMutationLockLeaseSync,
): LocalRuntimeMutationLockLease {
  return Object.freeze({
    lockPath: lease.lockPath,
    resourceKey: lease.resourceKey,
    release(): Promise<void> {
      lease.release();
      return Promise.resolve();
    },
  } satisfies LocalRuntimeMutationLockLease);
}

export function acquireLocalRuntimeMutationLocksSync(
  options: AcquireLocalRuntimeMutationLocksOptions,
): LocalRuntimeMutationLocksLeaseSync {
  const {targets: inputTargets, ...lockOptions} = options;
  const normalizedTargets = normalizeMutationLockTargets(inputTargets);
  const targets = publicMutationLockTargets(normalizedTargets);
  const leases: LocalRuntimeMutationLockLeaseSync[] = [];

  try {
    for (const target of normalizedTargets) {
      try {
        leases.push(
          acquireNormalizedMutationLockSync(
            normalizedMutationLockOptionsForTarget(target, {
              ...lockOptions,
              waitTimeoutMs: waitTimeoutMsPerTarget(options.waitTimeoutMs),
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
    releaseMutationLocksReverse(leases);
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
      releaseMutationLocksReverse(leases);
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

function reenterMutationLock(
  ownerToken: LocalRuntimeMutationLockOwnerToken | undefined,
  options: NormalizedMutationLockOptions,
): LocalRuntimeMutationLockLeaseSync | undefined {
  if (ownerToken === undefined) {
    return undefined;
  }

  const owned = ownedMutationLocks.get(ownerToken)?.get(options.lockPath);

  if (owned === undefined) {
    return undefined;
  }

  owned.count += 1;
  return createReenteredLease(ownerToken, options, owned);
}

function registerMutationLockOwner(
  ownerToken: LocalRuntimeMutationLockOwnerToken | undefined,
  options: NormalizedMutationLockOptions,
  lease: LocalRuntimeMutationLockLeaseSync,
): LocalRuntimeMutationLockLeaseSync {
  if (ownerToken === undefined) {
    return lease;
  }

  const ownerLocks =
    ownedMutationLocks.get(ownerToken) ?? new Map<string, OwnedMutationLock>();
  const owned = {count: 1, lease} satisfies OwnedMutationLock;

  ownerLocks.set(options.lockPath, owned);
  ownedMutationLocks.set(ownerToken, ownerLocks);
  return createReenteredLease(ownerToken, options, owned);
}

function createReenteredLease(
  ownerToken: LocalRuntimeMutationLockOwnerToken,
  options: NormalizedMutationLockOptions,
  owned: OwnedMutationLock,
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

      ownedMutationLocks.get(ownerToken)?.delete(options.lockPath);
      owned.lease.release();
    },
  } satisfies LocalRuntimeMutationLockLeaseSync);
}

function releaseMutationLocksReverse(
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

function prepareLocksRoot(locksRoot: string): void {
  try {
    makeDirectorySync(locksRoot, {recursive: true});
  } catch (error: unknown) {
    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not prepare local runtime mutation lock directory: ${locksRoot}.`,
      {cause: error},
    );
  }
}

function tryCreateMutationLock(
  options: NormalizedMutationLockOptions,
): LocalRuntimeMutationLockLeaseSync | undefined {
  if (hasActiveMutationLockReclamationIntent(options)) {
    return undefined;
  }

  try {
    makeDirectorySync(options.lockPath);
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
    writeTextFileSync(
      ownerPath(options.lockPath),
      `${JSON.stringify(owner)}\n`,
      {flag: 'wx', mode: 0o600},
    );
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

  if (hasActiveMutationLockReclamationIntent(options)) {
    releaseOwnedMutationLock(options.lockPath, owner.nonce);
    return undefined;
  }

  const materializedOwner = readMutationLockOwner(options.lockPath);

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
      releaseOwnedMutationLock(options.lockPath, owner.nonce);
    },
  } satisfies LocalRuntimeMutationLockLeaseSync);
}

function releaseOwnedMutationLock(lockPath: string, nonce: string): void {
  const owner = readMutationLockOwner(lockPath);

  if (owner?.nonce !== nonce) {
    return;
  }

  removePathSync(lockPath, {force: true, recursive: true});
}

/** @internal Exposed only for deterministic generation-race regression tests. */
export function reclaimObservedLocalRuntimeMutationLock(
  options: AcquireLocalRuntimeMutationLockOptions,
  observedOwner: unknown,
  hooks: ReclaimObservedMutationLockTestHooks = {},
): boolean {
  if (!isMutationLockOwner(observedOwner)) {
    throw new TypeError(
      'Observed local runtime mutation lock owner is invalid.',
    );
  }

  return reclaimObservedMutationLock(
    normalizeMutationLockOptions(options),
    observedOwner,
    hooks,
  );
}

function reclaimAbandonedMutationLock(
  options: NormalizedMutationLockOptions,
): boolean {
  if (hasActiveMutationLockReclamationIntent(options)) {
    return false;
  }

  const owner = readMutationLockOwner(options.lockPath);

  if (owner !== undefined) {
    return reclaimObservedMutationLock(options, owner);
  }

  let observedLockStat: Stats;

  try {
    observedLockStat = statPathNumericSync(options.lockPath);
  } catch (error: unknown) {
    return isNodeErrorWithCode(error, 'ENOENT');
  }

  if (
    options.incompleteGraceMs > 0 &&
    Date.now() - observedLockStat.mtimeMs < options.incompleteGraceMs
  ) {
    return false;
  }

  return withMutationLockReclamationIntent(options, () => {
    const currentOwner = readMutationLockOwner(options.lockPath);

    if (currentOwner !== undefined) {
      return reclaimObservedMutationLockUnderIntent(options, currentOwner);
    }

    let currentLockStat: Stats;

    try {
      currentLockStat = statPathNumericSync(options.lockPath);
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

    return quarantineMutationLock(options);
  });
}

function reclaimObservedMutationLock(
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

  return withMutationLockReclamationIntent(options, () => {
    const reclaimed = reclaimObservedMutationLockUnderIntent(
      options,
      observedOwner,
      hooks,
    );

    return reclaimed;
  });
}

function reclaimObservedMutationLockUnderIntent(
  options: NormalizedMutationLockOptions,
  observedOwner: MutationLockOwner,
  hooks: ReclaimObservedMutationLockTestHooks = {},
): boolean {
  const currentOwner = readMutationLockOwner(options.lockPath);

  if (
    currentOwner === undefined ||
    !sameMutationLockOwnerGeneration(currentOwner, observedOwner) ||
    currentOwner.hostname !== hostname() ||
    processIsAlive(currentOwner.pid)
  ) {
    return false;
  }

  hooks.afterValidation?.();
  return quarantineMutationLock(options);
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

function withMutationLockReclamationIntent(
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
    makeDirectorySync(intentPath);
    created = true;
    writeTextFileSync(
      ownerPath(intentPath),
      `${JSON.stringify(intentOwner)}\n`,
      {flag: 'wx', mode: 0o600},
    );
  } catch (error: unknown) {
    if (created) {
      removePathSync(intentPath, {force: true, recursive: true});
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
    removePathSync(intentPath, {force: true, recursive: true});
  }
}

function hasActiveMutationLockReclamationIntent(
  options: NormalizedMutationLockOptions,
): boolean {
  const prefix = `${basename(options.lockPath)}.reclaim-`;
  let entries: readonly string[];

  try {
    entries = listDirectoryNamesSync(options.locksRoot);
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
    const owner = readMutationLockReclamationIntentOwner(intentPath);

    if (owner !== undefined) {
      if (owner.hostname === hostname() && !processIsAlive(owner.pid)) {
        removePathSync(intentPath, {force: true, recursive: true});
        continue;
      }

      return true;
    }

    let intentStat: Stats;

    try {
      intentStat = statPathNumericSync(intentPath);
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

    removePathSync(intentPath, {force: true, recursive: true});
  }

  return false;
}

function readMutationLockReclamationIntentOwner(
  intentPath: string,
): MutationLockReclamationIntentOwner | undefined {
  let raw: string;

  try {
    raw = readTextFileSync(ownerPath(intentPath));
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

function quarantineMutationLock(
  options: NormalizedMutationLockOptions,
): boolean {
  const quarantinePath = `${options.lockPath}.stale-${randomUUID()}`;

  try {
    renamePathSync(options.lockPath, quarantinePath);
  } catch (error: unknown) {
    return isNodeErrorWithCode(error, 'ENOENT');
  }

  removePathSync(quarantinePath, {force: true, recursive: true});
  return true;
}

function readMutationLockOwner(
  lockPath: string,
): MutationLockOwner | undefined {
  let raw: string;

  try {
    raw = readTextFileSync(ownerPath(lockPath));
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

type MutationLockWait = {
  /** Throws the busy error once the resource has stopped making progress. */
  remainingRetryDelayMs(): number;
};

/**
 * Every target gets its own full stall budget; a pooled allowance would
 * reach the second target already spent on a healthy first one.
 */
function waitTimeoutMsPerTarget(configuredWaitMs: number | undefined): number {
  return configuredWaitMs ?? defaultLocalRuntimeMutationLockWaitTimeoutMs;
}

/**
 * `waitTimeoutMs` bounds how long the resource may sit without progress,
 * not how long this caller may queue behind other contenders.
 */
function startMutationLockWait(
  normalized: NormalizedMutationLockOptions,
): MutationLockWait {
  let deadlineStartedAt = Date.now();
  let observedNonce = readMutationLockOwner(normalized.lockPath)?.nonce;

  return {
    remainingRetryDelayMs(): number {
      const currentNonce = readMutationLockOwner(normalized.lockPath)?.nonce;

      if (currentNonce !== undefined && currentNonce !== observedNonce) {
        // A new nonce means the queue is draining; restart the budget.
        observedNonce = currentNonce;
        deadlineStartedAt = Date.now();
      }

      const stalledMs = Date.now() - deadlineStartedAt;

      if (stalledMs >= normalized.waitTimeoutMs) {
        throw new LocalRuntimeMutationLockBusyError(
          normalized.busyCode,
          `Local runtime mutation resource is busy: ${normalized.resourceKey}.`,
        );
      }

      return Math.min(
        randomizedRetryDelayMs(),
        Math.max(1, normalized.waitTimeoutMs - stalledMs),
      );
    },
  };
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
