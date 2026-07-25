import {createHash} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';

import {isNodeErrorWithCode} from '../../shared/node-error.ts';

export type LocalRuntimeMutationLockTarget = {
  readonly locksRoot: string;
  readonly resourceKey: string;
};

export type NormalizedMutationLockTarget = {
  readonly displayLocksRoot: string;
  readonly locksRoot: string;
  readonly resourceKey: string;
  readonly lockPath: string;
};

export function normalizeMutationLockTarget(
  target: LocalRuntimeMutationLockTarget,
): NormalizedMutationLockTarget {
  const resourceKey = target.resourceKey.trim();

  if (resourceKey.length === 0) {
    throw new TypeError(
      'Local runtime mutation lock resource key must be non-empty.',
    );
  }

  const locksRoot = canonicalMutationLocksRoot(target.locksRoot);
  const hash = createHash('sha256').update(resourceKey).digest('hex');

  return Object.freeze({
    displayLocksRoot: target.locksRoot,
    locksRoot,
    resourceKey,
    lockPath: join(locksRoot, `${hash}.lock`),
  });
}

export function normalizeMutationLockTargets(
  targets: readonly LocalRuntimeMutationLockTarget[],
): readonly NormalizedMutationLockTarget[] {
  const byLockPath = new Map<string, NormalizedMutationLockTarget>();

  for (const target of targets) {
    const normalized = normalizeMutationLockTarget(target);
    const current = byLockPath.get(normalized.lockPath);

    if (
      current === undefined ||
      normalized.displayLocksRoot < current.displayLocksRoot
    ) {
      byLockPath.set(normalized.lockPath, normalized);
    }
  }

  return Object.freeze(
    [...byLockPath.values()].sort((left, right) =>
      compareCodeUnits(left.lockPath, right.lockPath),
    ),
  );
}

function canonicalMutationLocksRoot(locksRoot: string): string {
  let current = resolve(locksRoot);
  const missingParts: string[] = [];

  for (;;) {
    try {
      return join(realpathSync.native(current), ...missingParts);
    } catch (error: unknown) {
      if (!isNodeErrorWithCode(error, 'ENOENT')) {
        throw error;
      }

      const parent = dirname(current);

      if (parent === current) {
        return resolve(current, ...missingParts);
      }

      missingParts.unshift(basename(current));
      current = parent;
    }
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
