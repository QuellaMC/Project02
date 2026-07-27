/**
 * Mechanical filesystem boundary shared by character and plugin package
 * discovery. Callers retain ownership of source policy, diagnostics,
 * descriptor parsing, and package identity.
 */
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import type {BigIntStats, Dirent} from 'node:fs';
import {
  basename,
  dirname,
  join,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from 'node:path';

import {
  createJsonBoundarySnapshot,
  type JsonBoundaryValue,
} from './json-boundary.ts';

export type PackageSourceCandidate = {
  readonly name: string;
};

export type PackageSourceScanResult =
  | {
      readonly status: 'scanned';
      readonly candidates: readonly PackageSourceCandidate[];
    }
  | {
      readonly status: 'unavailable';
      readonly error: unknown;
    };

export type PackageDirectorySnapshot = {
  readonly packageRoot: string;
  readonly realPackageRoot: string;
  readonly packageIdentity: string;
  readonly canonicalAncestry: readonly PackageDirectoryAncestryEntry[];
};

export type PackageDirectoryAncestryEntry = {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly type: 'directory';
};

export function snapshotPackageDirectory(
  packageRoot: string,
): PackageDirectorySnapshot | undefined {
  return snapshotDirectory(packageRoot, {followRootLink: false});
}

/**
 * Snapshots a package *source root*, where an intentional link is allowed.
 *
 * The home ownership guard accepts a linked `plugins`/`characters` root so an
 * operator can install a package collection from elsewhere. Rejecting one here
 * would turn that approved layout into the globally blocking
 * `package_source_unavailable`, so even the bundled default package would fail
 * to load. Individual packages inside the source stay strict: they resolve
 * through `snapshotPackageDirectoryFromSource`, which snapshots the real path
 * and rejects a link there.
 */
export function snapshotPackageSourceDirectory(
  sourceRoot: string,
): PackageDirectorySnapshot | undefined {
  return snapshotDirectory(sourceRoot, {followRootLink: true});
}

function snapshotDirectory(
  packageRoot: string,
  options: {readonly followRootLink: boolean},
): PackageDirectorySnapshot | undefined {
  const normalizedRoot = resolve(packageRoot);
  // Following pins the identity of the directory a linked root names, which is
  // the state the rest of discovery reads. Not following reports a link as
  // neither a directory nor equal to itself, which is the strict rejection.
  const statRoot = options.followRootLink ? statSync : lstatSync;

  try {
    const initialStat = statRoot(normalizedRoot, {bigint: true});

    if (!initialStat.isDirectory()) {
      return undefined;
    }
    const realPackageRoot = realpathSync(normalizedRoot);
    const canonicalAncestry =
      snapshotCanonicalDirectoryAncestry(realPackageRoot);
    const finalStat = statRoot(normalizedRoot, {bigint: true});

    if (
      !finalStat.isDirectory() ||
      filesystemMetadataIdentity(initialStat) !==
        filesystemMetadataIdentity(finalStat) ||
      realpathSync(normalizedRoot) !== realPackageRoot
    ) {
      return undefined;
    }

    return Object.freeze({
      packageRoot: normalizedRoot,
      realPackageRoot,
      packageIdentity: filesystemMetadataIdentity(finalStat),
      canonicalAncestry,
    });
  } catch {
    return undefined;
  }
}

export function snapshotPackageDirectoryFromSource(options: {
  readonly sourceDirectory: PackageDirectorySnapshot;
  readonly packageName: string;
}): PackageDirectorySnapshot | undefined {
  if (
    basename(options.packageName) !== options.packageName ||
    options.packageName === '.' ||
    options.packageName === '..'
  ) {
    return undefined;
  }
  const packageRoot = join(
    options.sourceDirectory.packageRoot,
    options.packageName,
  );
  const snapshot = snapshotPackageDirectory(
    join(options.sourceDirectory.realPackageRoot, options.packageName),
  );

  if (
    snapshot === undefined ||
    dirname(snapshot.realPackageRoot) !==
      options.sourceDirectory.realPackageRoot ||
    !directoryAncestryStartsWith(
      snapshot.canonicalAncestry,
      options.sourceDirectory.canonicalAncestry,
    )
  ) {
    return undefined;
  }
  return Object.freeze({...snapshot, packageRoot});
}

export function packageDirectorySnapshotsEqual(
  left: PackageDirectorySnapshot,
  right: PackageDirectorySnapshot | undefined,
): boolean {
  return (
    right !== undefined &&
    left.packageRoot === right.packageRoot &&
    left.realPackageRoot === right.realPackageRoot &&
    left.packageIdentity === right.packageIdentity &&
    directoryAncestriesEqual(left.canonicalAncestry, right.canonicalAncestry)
  );
}

export function packageDirectorySnapshotIsCurrent(
  snapshot: PackageDirectorySnapshot,
): boolean {
  return packageDirectorySnapshotsEqual(
    snapshot,
    snapshotPackageDirectory(snapshot.packageRoot),
  );
}

export function scanPackageSourceRoot(root: string): PackageSourceScanResult {
  let entries: Dirent[];

  try {
    entries = readdirSync(root, {withFileTypes: true});
  } catch (error: unknown) {
    return Object.freeze({status: 'unavailable', error});
  }

  const candidates = entries
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .map(entry =>
      Object.freeze({
        name: entry.name,
      } satisfies PackageSourceCandidate),
    )
    .sort((left, right) => compareText(left.name, right.name));

  return Object.freeze({
    status: 'scanned',
    candidates: Object.freeze(candidates),
  });
}

export type BoundedPackageJsonRejectionReason =
  'unreadable' | 'not_file' | 'too_large' | 'invalid_json' | 'unsafe_json';

export type BoundedPackageJsonReadResult =
  | {
      readonly status: 'accepted';
      readonly value: JsonBoundaryValue;
    }
  | {
      readonly status: 'rejected';
      readonly reason: BoundedPackageJsonRejectionReason;
    };

export function parseBoundedPackageJsonSource(options: {
  readonly source: string | Uint8Array;
  readonly maxBytes: number;
  readonly boundaryField: string;
}): BoundedPackageJsonReadResult {
  const source =
    typeof options.source === 'string'
      ? options.source
      : Buffer.from(options.source).toString('utf8');

  if (Buffer.byteLength(source, 'utf8') > options.maxBytes) {
    return rejectedPackageJson('too_large');
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return rejectedPackageJson('invalid_json');
  }

  try {
    return Object.freeze({
      status: 'accepted',
      value: createJsonBoundarySnapshot(parsed, {
        field: options.boundaryField,
      }),
    });
  } catch {
    return rejectedPackageJson('unsafe_json');
  }
}

export function readBoundedPackageJsonFile(options: {
  readonly path: string | URL;
  readonly maxBytes: number;
  readonly boundaryField: string;
}): BoundedPackageJsonReadResult {
  let metadataStat: BigIntStats;

  // Stat through links: what matters is that the path names a regular file
  // small enough to read, not how it was spelled. A dangling link stats as
  // unreadable, which is what it is.
  try {
    metadataStat = statSync(options.path, {bigint: true});
  } catch {
    return rejectedPackageJson('unreadable');
  }

  if (!metadataStat.isFile()) {
    return rejectedPackageJson('not_file');
  }
  if (metadataStat.size > BigInt(options.maxBytes)) {
    return rejectedPackageJson('too_large');
  }

  let source: string;

  try {
    source = readFileSync(options.path, 'utf8');
  } catch {
    return rejectedPackageJson('unreadable');
  }

  let finalMetadataStat: BigIntStats;

  try {
    finalMetadataStat = statSync(options.path, {bigint: true});
  } catch {
    return rejectedPackageJson('unreadable');
  }

  if (
    !finalMetadataStat.isFile() ||
    filesystemMetadataIdentity(finalMetadataStat) !==
      filesystemMetadataIdentity(metadataStat)
  ) {
    return rejectedPackageJson('unreadable');
  }

  return parseBoundedPackageJsonSource({
    source,
    maxBytes: options.maxBytes,
    boundaryField: options.boundaryField,
  });
}

export function filesystemMetadataIdentity(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(':');
}

function snapshotCanonicalDirectoryAncestry(
  canonicalPath: string,
): readonly PackageDirectoryAncestryEntry[] {
  const parsed = parsePath(canonicalPath);
  const suffix = relative(parsed.root, canonicalPath);
  const components = suffix === '' ? [] : suffix.split(sep).filter(Boolean);
  const paths = [parsed.root];
  let currentPath = parsed.root;

  for (const component of components) {
    currentPath = join(currentPath, component);
    paths.push(currentPath);
  }

  return Object.freeze(
    paths.map(path => {
      const stat = lstatSync(path, {bigint: true});

      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new TypeError('Canonical package ancestry must be directories.');
      }
      return Object.freeze({
        path,
        device: String(stat.dev),
        inode: String(stat.ino),
        type: 'directory',
      } satisfies PackageDirectoryAncestryEntry);
    }),
  );
}

function directoryAncestriesEqual(
  left: readonly PackageDirectoryAncestryEntry[],
  right: readonly PackageDirectoryAncestryEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const candidate = right[index];

      return (
        candidate !== undefined &&
        entry.path === candidate.path &&
        entry.device === candidate.device &&
        entry.inode === candidate.inode
      );
    })
  );
}

function directoryAncestryStartsWith(
  ancestry: readonly PackageDirectoryAncestryEntry[],
  expectedPrefix: readonly PackageDirectoryAncestryEntry[],
): boolean {
  return (
    ancestry.length === expectedPrefix.length + 1 &&
    expectedPrefix.every((entry, index) => {
      const candidate = ancestry[index];

      return (
        candidate !== undefined &&
        entry.path === candidate.path &&
        entry.device === candidate.device &&
        entry.inode === candidate.inode
      );
    })
  );
}

function rejectedPackageJson(
  reason: BoundedPackageJsonRejectionReason,
): BoundedPackageJsonReadResult {
  return Object.freeze({status: 'rejected', reason});
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
