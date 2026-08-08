import {createHash} from 'node:crypto';
import {join} from 'node:path';

import {compareText} from '../../shared/package-metadata.ts';
import {canonicalPath} from '../../shared/real-path.ts';

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

  // Two spellings of one lock root must hash to one lock file. The root need
  // not exist yet: acquiring the lock creates it.
  const locksRoot = canonicalPath(target.locksRoot);
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
      compareText(left.lockPath, right.lockPath),
    ),
  );
}
