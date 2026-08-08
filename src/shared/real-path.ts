/**
 * Reports what is at a path without judging it. A link is not inherently
 * wrong — package sources are intentionally linked in, and `/tmp` is a link
 * on macOS — so callers own that policy and throw their own error types.
 */
import {basename, dirname, isAbsolute, relative, resolve, sep} from 'node:path';

import {
  lstatPath,
  lstatPathSync,
  nativeRealPathSync,
  readLinkTargetSync,
  type BigIntStats,
} from './file-system.ts';
import {isNodeErrorWithCode} from './node-error.ts';

export class PathResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathResolutionError';
  }
}

/** `absent` is ENOENT only; every other failure is `unreadable`. */
export type RealEntry =
  | {readonly kind: 'file'; readonly stats: BigIntStats}
  | {readonly kind: 'directory'; readonly stats: BigIntStats}
  | {readonly kind: 'link'; readonly stats: BigIntStats}
  | {readonly kind: 'other'; readonly stats: BigIntStats}
  | {readonly kind: 'absent'; readonly error: unknown}
  | {readonly kind: 'unreadable'; readonly error: unknown};

export type RealEntryKind = RealEntry['kind'];

export function describeRealEntry(path: string): RealEntry {
  let stats: BigIntStats;

  try {
    stats = lstatPathSync(path);
  } catch (error: unknown) {
    return isNodeErrorWithCode(error, 'ENOENT')
      ? Object.freeze({kind: 'absent', error})
      : Object.freeze({kind: 'unreadable', error});
  }

  return Object.freeze({kind: presentEntryKind(stats), stats});
}

export async function describeRealEntryAsync(path: string): Promise<RealEntry> {
  let stats: BigIntStats;

  try {
    stats = await lstatPath(path);
  } catch (error: unknown) {
    return isNodeErrorWithCode(error, 'ENOENT')
      ? Object.freeze({kind: 'absent', error})
      : Object.freeze({kind: 'unreadable', error});
  }

  return Object.freeze({kind: presentEntryKind(stats), stats});
}

function presentEntryKind(
  stats: BigIntStats,
): 'file' | 'directory' | 'link' | 'other' {
  if (stats.isSymbolicLink()) {
    return 'link';
  }
  if (stats.isDirectory()) {
    return 'directory';
  }

  return stats.isFile() ? 'file' : 'other';
}

export type CanonicalPathOptions = {
  /**
   * Resolve a dangling link to the path it names instead of canonicalizing the
   * link's own location.
   */
  readonly followDanglingLinks?: boolean;
};

/**
 * Canonicalizes a path that need not exist. Throws `PathResolutionError` when
 * dangling links form a cycle, so no canonical spelling exists.
 */
export function canonicalPath(
  path: string,
  options: CanonicalPathOptions = {},
): string {
  return canonicalAbsolutePath(
    resolve(path),
    options.followDanglingLinks === true,
    new Set<string>(),
  );
}

function canonicalAbsolutePath(
  path: string,
  followDanglingLinks: boolean,
  followedLinks: Set<string>,
): string {
  try {
    return nativeRealPathSync(path);
  } catch {
    const linkTarget = followDanglingLinks
      ? danglingLinkTarget(path, followedLinks)
      : undefined;

    return linkTarget === undefined
      ? canonicalMissingPath(path, followDanglingLinks, followedLinks)
      : canonicalAbsolutePath(linkTarget, followDanglingLinks, followedLinks);
  }
}

function danglingLinkTarget(
  path: string,
  followedLinks: Set<string>,
): string | undefined {
  try {
    if (!lstatPathSync(path).isSymbolicLink()) {
      return undefined;
    }

    if (followedLinks.has(path)) {
      throw new PathResolutionError(
        `Could not resolve path because ${path} is part of a symlink cycle.`,
      );
    }

    followedLinks.add(path);
    return resolve(dirname(path), readLinkTargetSync(path));
  } catch (error: unknown) {
    if (error instanceof PathResolutionError) {
      throw error;
    }

    return undefined;
  }
}

function canonicalMissingPath(
  path: string,
  followDanglingLinks: boolean,
  followedLinks: Set<string>,
): string {
  const parent = dirname(path);

  if (parent === path) {
    return path;
  }

  return resolve(
    canonicalAbsolutePath(parent, followDanglingLinks, followedLinks),
    basename(path),
  );
}

export function pathIsAtOrBelow(path: string, root: string): boolean {
  return relativePathIfContained(root, path) !== undefined;
}

/**
 * The `/`-separated path from `root` down to `path`; the empty string means
 * `path` is `root` itself. Both sides are compared as given, so a caller that
 * cares about links canonicalizes first.
 */
export function relativePathIfContained(
  root: string,
  path: string,
): string | undefined {
  const suffix = relative(resolve(root), resolve(path));

  if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    return undefined;
  }
  return suffix.split(sep).join('/');
}

export type ContainedPathResult =
  | {
      readonly status: 'contained';
      readonly canonicalPath: string;
      readonly relativePath: string;
    }
  | {readonly status: 'escapes'; readonly canonicalPath: string}
  | {readonly status: 'unresolvable'};

export function resolveContainedPath(options: {
  readonly root: string;
  readonly path: string;
  readonly followDanglingLinks?: boolean;
}): ContainedPathResult {
  let resolved: string;

  try {
    resolved = canonicalPath(options.path, {
      ...(options.followDanglingLinks === undefined
        ? {}
        : {followDanglingLinks: options.followDanglingLinks}),
    });
  } catch {
    return Object.freeze({status: 'unresolvable'});
  }
  const relativePath = relativePathIfContained(options.root, resolved);

  return relativePath === undefined
    ? Object.freeze({status: 'escapes', canonicalPath: resolved})
    : Object.freeze({
        status: 'contained',
        canonicalPath: resolved,
        relativePath,
      });
}

/** Ordered `root` first, down to `path`. */
export function pathComponentChain(options: {
  readonly root: string;
  readonly path: string;
  readonly includeRoot: boolean;
}): readonly string[] | undefined {
  const suffix = relativePathIfContained(options.root, options.path);

  if (suffix === undefined) {
    return undefined;
  }
  let current = resolve(options.root);
  const chain = options.includeRoot ? [current] : [];

  for (const component of suffix === '' ? [] : suffix.split('/')) {
    current = resolve(current, component);
    chain.push(current);
  }

  return Object.freeze(chain);
}

export type UnacceptableComponent = {
  readonly path: string;
  readonly kind: Exclude<RealEntryKind, 'absent'>;
};

/**
 * The walk stops at the first component that is not there, because what does
 * not exist cannot redirect a write. A `path` outside `root` has no components
 * to check and is reported clean.
 */
export function firstUnacceptableComponent(options: {
  readonly root: string;
  readonly path: string;
  readonly accept: readonly RealEntryKind[];
}): UnacceptableComponent | undefined {
  const chain = pathComponentChain({
    root: options.root,
    path: options.path,
    includeRoot: false,
  });

  if (chain === undefined) {
    return undefined;
  }

  for (const current of chain) {
    const entry = describeRealEntry(current);

    if (
      entry.kind === 'absent' ||
      (entry.kind === 'unreadable' &&
        isNodeErrorWithCode(entry.error, 'ENOTDIR'))
    ) {
      return undefined;
    }
    if (!options.accept.includes(entry.kind)) {
      return Object.freeze({path: current, kind: entry.kind});
    }
  }

  return undefined;
}
