/**
 * The one filesystem-path seam. Every layer that has to decide "is this path
 * really the thing I think it is" resolves it here instead of writing its own
 * lstat block.
 *
 * Three questions, one implementation each:
 *
 * - `describeRealEntry` — what is at this path right now: a real file, a real
 *   directory, a link, nothing, or something unreadable?
 * - `canonicalPath` — what is the canonical spelling of this path, whether or
 *   not it exists yet, so two spellings of one location compare equal?
 * - `firstUnacceptableComponent` — walking from a root the caller owns down to
 *   a path it is about to create, is every component still a real directory?
 *
 * Callers own policy. A link is not inherently wrong — package sources are
 * intentionally linked in, and `/tmp` is a link on macOS — so this module never
 * decides whether one is acceptable, and it raises no domain errors. It reports
 * what is there; the caller says what it accepts and throws its own type.
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

/**
 * What is at a path, as one value rather than a stats object plus a local
 * convention for which errors mean "absent".
 *
 * `link` is reported apart from `file` and `directory` because a caller that
 * refuses links has to see one before following it, and because a dangling
 * link is itself present while its target is absent.
 *
 * `absent` is ENOENT only. Whether a path under a non-directory parent counts
 * as absent or as broken is a caller's call — some create the parent, others
 * refuse the whole layout — so `unreadable` carries the error for them to
 * classify rather than deciding here.
 *
 * Both failing kinds keep the error they were classified from. A caller whose
 * own callers classify by error code can rethrow the original instead of
 * stat'ing the path a second time to reproduce it — which would report on a
 * different moment than the one it decided from.
 *
 * Stats are `bigint` because callers compare inodes for identity, and on a
 * filesystem that hands out large ones the `number` form silently rounds.
 */
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

/**
 * `describeRealEntry` for a caller already on an async path.
 *
 * It classifies through the same two helpers rather than its own copy, so a
 * sync guard and an async one cannot come to disagree about one directory.
 */
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

/**
 * What a path is when something is there, with links reported as themselves.
 *
 * `describeRealEntry` never follows a link, so a caller that wants the target
 * describes `canonicalPath(path)` instead — one call, and the answer says which
 * question was asked.
 */
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
   * link's own location. A config path that links to a not-yet-written file
   * names that file; a control directory that does not exist yet is named by
   * where it will be created.
   */
  readonly followDanglingLinks?: boolean;
};

/**
 * Canonicalizes a path that need not exist.
 *
 * The OS resolver fails on the first missing component, but callers routinely
 * name something they are about to create, so the missing tail is resolved
 * component by component against the deepest existing ancestor.
 *
 * @throws {PathResolutionError} when following dangling links revisits a path,
 *   which means they form a cycle and no canonical spelling exists.
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

/** True when `path` is `root` or lies beneath it, comparing both as given. */
export function pathIsAtOrBelow(path: string, root: string): boolean {
  return relativePathIfContained(root, path) !== undefined;
}

/**
 * The `/`-separated path from `root` down to `path`, or `undefined` when
 * `path` is not inside `root`. Empty string means `path` is `root` itself.
 *
 * Both sides are compared as given, so callers that care about links
 * canonicalize first — which is why this pairs with `canonicalPath`.
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

/**
 * The containment answer the package loader, the durable store, and the home
 * guards all need: resolve `path` and report where it really lands relative to
 * `root`.
 *
 * A link inside the root is harmless — it names something the root already
 * owns. A link that leaves the root is the case every caller refuses, and it is
 * indistinguishable here from naming an outside path directly, which is why one
 * check covers both.
 */
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

/**
 * Every path from `root` down to `path`, `root` first, or `undefined` when
 * `path` is not inside `root`.
 *
 * Whether `root` itself is included is the caller's call: a guard walking down
 * to something it is about to create has usually already vouched for the root,
 * while one describing a canonical tree wants the root described too.
 */
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
 * Walks every component from `root` down to `path` and reports the first one
 * that is not among `accept`, so a recursive create beneath it cannot land
 * through a link or a file.
 *
 * The walk stops at the first component that is not there: what does not exist
 * cannot redirect a write, and the caller that creates it owns the path from
 * there. That includes a component under an accepted non-directory, which
 * cannot exist at all — nothing below a regular file is reachable, so there is
 * nothing left to check.
 *
 * A `path` outside `root` has no components to check and is reported clean;
 * containment is `resolveContainedPath`'s question, not this one.
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
