/**
 * Filesystem mechanics for package discovery and bounded JSON file reads.
 * Callers retain ownership of source policy, diagnostics, descriptor parsing,
 * and package identity.
 */
import {
  listDirectoryEntriesSync,
  lstatPathSync,
  nativeRealPathSync,
  readTextFileSync,
  statPathSync,
  type BigIntStats,
  type Dirent,
} from './file-system.ts';
import {basename, dirname, join, parse as parsePath, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  createJsonBoundarySnapshot,
  type JsonBoundaryValue,
} from './json-boundary.ts';
import {describeRealEntry, pathComponentChain} from './real-path.ts';

type PackageSourceScanResult =
  | {
      readonly status: 'scanned';
      readonly candidates: readonly string[];
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

type PackageDirectoryAncestryEntry = {
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
 * A source root may itself be a link, so an operator can install a package
 * collection from elsewhere. Individual packages inside it stay strict.
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
  // Not following reports a link as neither a directory nor equal to itself,
  // which is how the strict mode rejects one.
  const statRoot = options.followRootLink ? statPathSync : lstatPathSync;

  try {
    const initialStat = statRoot(normalizedRoot);

    if (!initialStat.isDirectory()) {
      return undefined;
    }
    const realPackageRoot = nativeRealPathSync(normalizedRoot);
    const canonicalAncestry =
      snapshotCanonicalDirectoryAncestry(realPackageRoot);
    const finalStat = statRoot(normalizedRoot);

    if (
      !finalStat.isDirectory() ||
      filesystemMetadataIdentity(initialStat) !==
        filesystemMetadataIdentity(finalStat) ||
      nativeRealPathSync(normalizedRoot) !== realPackageRoot
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
    entries = listDirectoryEntriesSync(root);
  } catch (error: unknown) {
    return Object.freeze({status: 'unavailable', error});
  }

  const candidates = entries
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .map(entry => entry.name)
    .sort(compareText);

  return Object.freeze({
    status: 'scanned',
    candidates: Object.freeze(candidates),
  });
}

/**
 * No other validator sees `"$schema"`, and it is only an editor's pointer to
 * a schema document, so a string is the whole rule.
 */
export function packageDescriptorSchemaRefIsValid(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

export type BoundedPackageJsonRejectionReason =
  'unreadable' | 'not_file' | 'too_large' | 'invalid_json' | 'unsafe_json';

type BoundedPackageJsonReadResult =
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
  const read = readBoundedJsonFileSource(options);

  if (read.status === 'rejected') {
    return rejectedPackageJson(
      read.reason === 'uninspectable' ? 'unreadable' : read.reason,
    );
  }

  return parseBoundedPackageJsonSource({
    source: read.source,
    maxBytes: options.maxBytes,
    boundaryField: options.boundaryField,
  });
}

export type BoundedJsonFileSourceRejectionReason =
  'uninspectable' | 'not_file' | 'too_large' | 'unreadable';

type BoundedJsonFileSourceResult =
  | {readonly status: 'accepted'; readonly source: string}
  | {
      readonly status: 'rejected';
      readonly reason: BoundedJsonFileSourceRejectionReason;
    };

/**
 * The identity recheck after the read is what the size cap rests on: a file
 * swapped between the stat and the read is refused instead of parsed.
 */
export function readBoundedJsonFileSource(options: {
  readonly path: string | URL;
  readonly maxBytes: number;
}): BoundedJsonFileSourceResult {
  let path: string;

  // A package reading its own descriptor has a `file:` URL, and the
  // filesystem seam takes only strings.
  try {
    path =
      typeof options.path === 'string'
        ? options.path
        : fileURLToPath(options.path);
  } catch {
    return rejectedJsonFileSource('uninspectable');
  }

  let metadataStat: BigIntStats;

  // Stat through links: what matters is that the path names a regular file
  // small enough to read, not how it was spelled.
  try {
    metadataStat = statPathSync(path);
  } catch {
    return rejectedJsonFileSource('uninspectable');
  }

  if (!metadataStat.isFile()) {
    return rejectedJsonFileSource('not_file');
  }
  if (metadataStat.size > BigInt(options.maxBytes)) {
    return rejectedJsonFileSource('too_large');
  }

  let source: string;

  try {
    source = readTextFileSync(path);
  } catch {
    return rejectedJsonFileSource('unreadable');
  }

  let finalMetadataStat: BigIntStats;

  try {
    finalMetadataStat = statPathSync(path);
  } catch {
    return rejectedJsonFileSource('unreadable');
  }

  if (
    !finalMetadataStat.isFile() ||
    filesystemMetadataIdentity(finalMetadataStat) !==
      filesystemMetadataIdentity(metadataStat)
  ) {
    return rejectedJsonFileSource('unreadable');
  }

  // Invalid bytes decode to replacement characters that weigh more than the
  // bytes on disk, so the decoded source is capped too.
  return Buffer.byteLength(source, 'utf8') > options.maxBytes
    ? rejectedJsonFileSource('too_large')
    : Object.freeze({status: 'accepted', source});
}

/**
 * Every file-change stamp in the runtime compares these fields, which makes
 * change detection best effort rather than a guarantee: timestamps advance
 * once per filesystem tick — 4 ms on ext4 — so a change landing in the same
 * tick as the one before it, moving no bytes, stamps identically and reads
 * as no change at all.
 */
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
  packagePath: string,
): readonly PackageDirectoryAncestryEntry[] {
  const chain = pathComponentChain({
    root: parsePath(packagePath).root,
    path: packagePath,
    includeRoot: true,
  });

  if (chain === undefined) {
    throw new TypeError('Canonical package ancestry must be absolute.');
  }

  return Object.freeze(
    chain.map(path => {
      const entry = describeRealEntry(path);

      if (entry.kind !== 'directory') {
        throw new TypeError('Canonical package ancestry must be directories.');
      }
      return Object.freeze({
        path,
        device: String(entry.stats.dev),
        inode: String(entry.stats.ino),
        type: 'directory',
      } satisfies PackageDirectoryAncestryEntry);
    }),
  );
}

function directoryAncestryEntriesEqual(
  entry: PackageDirectoryAncestryEntry,
  candidate: PackageDirectoryAncestryEntry | undefined,
): boolean {
  return (
    candidate !== undefined &&
    entry.path === candidate.path &&
    entry.device === candidate.device &&
    entry.inode === candidate.inode
  );
}

function directoryAncestriesEqual(
  left: readonly PackageDirectoryAncestryEntry[],
  right: readonly PackageDirectoryAncestryEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) =>
      directoryAncestryEntriesEqual(entry, right[index]),
    )
  );
}

function directoryAncestryStartsWith(
  ancestry: readonly PackageDirectoryAncestryEntry[],
  expectedPrefix: readonly PackageDirectoryAncestryEntry[],
): boolean {
  return (
    ancestry.length === expectedPrefix.length + 1 &&
    expectedPrefix.every((entry, index) =>
      directoryAncestryEntriesEqual(entry, ancestry[index]),
    )
  );
}

function rejectedPackageJson(
  reason: BoundedPackageJsonRejectionReason,
): BoundedPackageJsonReadResult {
  return Object.freeze({status: 'rejected', reason});
}

function rejectedJsonFileSource(
  reason: BoundedJsonFileSourceRejectionReason,
): BoundedJsonFileSourceResult {
  return Object.freeze({status: 'rejected', reason});
}

/**
 * Code-point order, deliberately locale-independent so two machines order
 * the same bytes the same way.
 */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
