/**
 * A capture is rooted in one already-bound package directory and traverses
 * only its canonical tree, so every path it describes belongs to that package.
 */
import {
  closeFileSync,
  fileSystemConstants,
  listDirectoryNamesSync,
  openFileSync,
  readBytesFromFileSync,
  statFileSync,
  type BigIntStats,
} from './file-system.ts';
import {isAbsolute, join, resolve, sep} from 'node:path';

import {
  compareText,
  filesystemMetadataIdentity,
  packageDirectorySnapshotIsCurrent,
  snapshotPackageDirectory,
  type PackageDirectorySnapshot,
} from './package-metadata.ts';
import {
  canonicalPath,
  describeRealEntry,
  relativePathIfContained,
  resolveContainedPath,
} from './real-path.ts';

export type CapturedPackageFile = {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly source: Buffer;
  readonly type: 'file';
};

export type CapturedPackageArtifact = {
  readonly packageDirectory: PackageDirectorySnapshot;
  readonly directories: ReadonlySet<string>;
  readonly files: ReadonlyMap<string, CapturedPackageFile>;
};

/**
 * `identity` describes the walk and is not re-imposed at read time.
 * `absolutePath` is where the package names the file, which for a link is not
 * where the bytes are.
 */
export type PlannedPackageFile = {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly identity: string;
  readonly maxReadableBytes: number;
  readonly type: 'file';
};

export type PlannedPackageCapture = {
  readonly packageDirectory: PackageDirectorySnapshot;
  readonly directories: ReadonlySet<string>;
  readonly files: ReadonlyMap<string, PlannedPackageFile>;
};

/**
 * A link is not itself a rejection: the walk resolves one to the file it names
 * and rejects only what it points at.
 */
export type PackageCaptureRejectionReason =
  'changed' | 'not_regular' | 'too_large' | 'unreadable';

export class PackageCaptureError extends Error {
  readonly path: string;
  readonly reason: PackageCaptureRejectionReason;

  constructor(options: {
    readonly path: string;
    readonly reason: PackageCaptureRejectionReason;
  }) {
    super('Package could not be captured.');
    this.name = 'PackageCaptureError';
    this.path = options.path;
    this.reason = options.reason;
  }
}

type PackageCaptureState = {
  readonly directories: Set<string>;
  readonly files: Map<string, PlannedPackageFile>;
  /**
   * Directories count against `maxFiles` too: a tree of empty directories
   * consumes no bytes and would otherwise traverse without limit.
   */
  entryCount: number;
  totalBytes: number;
};

type PackageCaptureLimits = {
  readonly packageDirectory: PackageDirectorySnapshot;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly fileByteLimits?: ReadonlyMap<string, number>;
};

/**
 * The walk recurses per level, so this bounds stack depth rather than leaving
 * it to whichever path limit the platform happens to enforce first.
 */
const maxPackageCaptureDepth = 64;

/**
 * Stat only: every rejection a reading capture raises while walking is raised
 * here too, and only the bytes are missing.
 */
export function planPackageDirectoryCapture(
  options: PackageCaptureLimits,
): PlannedPackageCapture {
  const limits = requiredCaptureLimits(options);
  const state: PackageCaptureState = {
    directories: new Set(),
    files: new Map(),
    entryCount: 0,
    totalBytes: 0,
  };

  planDirectory({
    directory: options.packageDirectory,
    limits,
    depth: 0,
    state,
  });
  assertBoundPackage(options.packageDirectory);

  return Object.freeze({
    packageDirectory: options.packageDirectory,
    directories: state.directories,
    files: state.files,
  } satisfies PlannedPackageCapture);
}

/**
 * The file itself is re-checked; the walk's stat and the package snapshot are
 * deliberately not, so an ordinary edit or reinstall after discovery does not
 * make the package unloadable.
 */
export function readPlannedPackageFile(options: {
  readonly packageDirectory: PackageDirectorySnapshot;
  readonly file: PlannedPackageFile;
}): Buffer {
  const readPath = plannedPackageFileReadPath(options);

  if (readPath === undefined) {
    throw captureError(options.file.absolutePath, 'not_regular');
  }
  return readBoundRegularFile({
    path: readPath,
    maxBytes: options.file.maxReadableBytes,
  });
}

/**
 * Where the bytes live, which for a link is not `absolutePath`. Resolved at
 * each use, so a path that comes to name something else is re-judged then.
 */
export function plannedPackageFileReadPath(options: {
  readonly packageDirectory: PackageDirectorySnapshot;
  readonly file: PlannedPackageFile;
}): string | undefined {
  return resolveContainedPackageFile({
    packageDirectory: options.packageDirectory,
    path: options.file.absolutePath,
  })?.readPath;
}

export function capturePackageDirectoryArtifact(
  options: PackageCaptureLimits,
): CapturedPackageArtifact {
  const planned = planPackageDirectoryCapture(options);
  const files = new Map<string, CapturedPackageFile>();

  for (const [relativePath, file] of planned.files) {
    files.set(
      relativePath,
      Object.freeze({
        absolutePath: file.absolutePath,
        relativePath,
        source: readPlannedPackageFile({
          packageDirectory: planned.packageDirectory,
          file,
        }),
        type: 'file',
      } satisfies CapturedPackageFile),
    );
  }
  assertBoundPackage(options.packageDirectory);

  return Object.freeze({
    packageDirectory: planned.packageDirectory,
    directories: planned.directories,
    files,
  } satisfies CapturedPackageArtifact);
}

function requiredCaptureLimits(options: PackageCaptureLimits): {
  readonly packageDirectory: PackageDirectorySnapshot;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly fileByteLimits: ReadonlyMap<string, number> | undefined;
} {
  if (
    !Number.isSafeInteger(options.maxFiles) ||
    options.maxFiles < 1 ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1
  ) {
    throw new TypeError('Package capture limits must be positive integers.');
  }

  return Object.freeze({
    packageDirectory: options.packageDirectory,
    maxFiles: options.maxFiles,
    maxBytes: options.maxBytes,
    fileByteLimits: normalizeFileByteLimits(options.fileByteLimits),
  });
}

export function capturePackageFiles(options: {
  readonly packageDirectory: PackageDirectorySnapshot;
  readonly relativePaths: readonly string[];
  readonly maxBytes: number;
}): CapturedPackageArtifact {
  if (
    options.relativePaths.length < 1 ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1
  ) {
    throw new TypeError(
      'Package file capture requires paths and a byte limit.',
    );
  }
  const paths = new Set(options.relativePaths.map(normalizeRelativePath));

  if (
    paths.size !== options.relativePaths.length ||
    [...paths].some(
      path =>
        path === '' ||
        path === '..' ||
        path.startsWith('../') ||
        isAbsolute(path),
    )
  ) {
    throw new TypeError('Package capture paths must be unique and relative.');
  }
  const limits = requiredCaptureLimits({
    packageDirectory: options.packageDirectory,
    maxFiles: paths.size,
    maxBytes: options.maxBytes,
  });
  const state: PackageCaptureState = {
    directories: new Set(),
    files: new Map(),
    entryCount: 0,
    totalBytes: 0,
  };
  const files = new Map<string, CapturedPackageFile>();

  for (const relativePath of paths) {
    const absolutePath = resolve(
      options.packageDirectory.realPackageRoot,
      relativePath,
    );

    if (
      relativePathIfContained(
        options.packageDirectory.realPackageRoot,
        absolutePath,
      ) !== relativePath
    ) {
      throw new TypeError('Package capture path escaped its package.');
    }
    assertBoundPackage(options.packageDirectory);
    const resolved = resolveContainedPackageFile({
      packageDirectory: options.packageDirectory,
      path: absolutePath,
    });

    if (resolved === undefined) {
      throw captureError(absolutePath, 'not_regular');
    }
    const planned = planFile({
      absolutePath,
      stat: resolved.stat,
      limits,
      state,
    });

    files.set(
      relativePath,
      Object.freeze({
        absolutePath,
        relativePath,
        source: readPlannedPackageFile({
          packageDirectory: options.packageDirectory,
          file: planned,
        }),
        type: 'file',
      } satisfies CapturedPackageFile),
    );
  }
  assertBoundPackage(options.packageDirectory);

  return Object.freeze({
    packageDirectory: options.packageDirectory,
    directories: state.directories,
    files,
  } satisfies CapturedPackageArtifact);
}

export function readCapturedPackageFile(
  artifact: Pick<CapturedPackageArtifact, 'files'>,
  relativePath: string,
): Buffer | undefined {
  const file = artifact.files.get(normalizeRelativePath(relativePath));

  return file === undefined ? undefined : Buffer.from(file.source);
}

function planDirectory(options: {
  readonly directory: PackageDirectorySnapshot;
  readonly limits: ReturnType<typeof requiredCaptureLimits>;
  readonly depth: number;
  readonly state: PackageCaptureState;
}): void {
  const packageDirectory = options.limits.packageDirectory;

  assertBoundPackage(packageDirectory);
  assertBoundDirectory(options.directory);

  if (options.depth > maxPackageCaptureDepth) {
    throw captureError(options.directory.realPackageRoot, 'too_large');
  }
  let names: string[];

  try {
    names = listDirectoryNamesSync(options.directory.realPackageRoot).sort(
      compareText,
    );
  } catch {
    throw captureError(options.directory.realPackageRoot, 'unreadable');
  }
  assertBoundDirectory(options.directory);
  assertBoundPackage(packageDirectory);

  for (const name of names) {
    const absolutePath = join(options.directory.realPackageRoot, name);

    assertBoundPackage(packageDirectory);
    const entry = describeRealEntry(absolutePath);

    // An entry the listing showed a moment ago and no longer has is as
    // uncapturable as one that cannot be stat'd.
    if (entry.kind === 'absent' || entry.kind === 'unreadable') {
      throw captureError(absolutePath, 'unreadable');
    }
    assertBoundPackage(packageDirectory);

    if (entry.kind === 'link') {
      const linked = resolveContainedPackageFile({
        packageDirectory,
        path: absolutePath,
      });

      if (linked === undefined) {
        throw captureError(absolutePath, 'not_regular');
      }
      const planned = planFile({
        ...options,
        absolutePath,
        stat: linked.stat,
      });

      options.state.files.set(planned.relativePath, planned);
      continue;
    }
    if (entry.kind === 'directory') {
      const directory = snapshotContainedDirectory({
        packageDirectory,
        path: absolutePath,
      });
      const relativePath = packageRelativePath(
        packageDirectory.realPackageRoot,
        directory.realPackageRoot,
      );

      if (options.state.entryCount >= options.limits.maxFiles) {
        throw captureError(absolutePath, 'too_large');
      }
      options.state.entryCount += 1;
      options.state.directories.add(relativePath);
      planDirectory({...options, directory, depth: options.depth + 1});
      continue;
    }
    if (entry.kind !== 'file') {
      throw captureError(absolutePath, 'not_regular');
    }
    const planned = planFile({...options, absolutePath, stat: entry.stats});

    options.state.files.set(planned.relativePath, planned);
  }

  assertBoundDirectory(options.directory);
  assertBoundPackage(packageDirectory);
}

/**
 * Only a contained regular file resolves: a link out of the package would let
 * the walk describe one tree while a read returns another, and a directory
 * link would let the walk cycle.
 */
function resolveContainedPackageFile(options: {
  readonly packageDirectory: PackageDirectorySnapshot;
  readonly path: string;
}):
  | {
      readonly readPath: string;
      readonly stat: BigIntStats;
    }
  | undefined {
  const resolved = resolveContainedPath({
    root: options.packageDirectory.realPackageRoot,
    path: options.path,
  });

  if (resolved.status !== 'contained') {
    return undefined;
  }
  const entry = describeRealEntry(resolved.canonicalPath);

  return entry.kind === 'file'
    ? Object.freeze({readPath: resolved.canonicalPath, stat: entry.stats})
    : undefined;
}

/**
 * Budgets are spent from the walk's stat, and the surviving bound is
 * re-checked against the descriptor at read time, so a file that grew after
 * the walk is refused there rather than outspending the accounting.
 */
function planFile(options: {
  readonly absolutePath: string;
  readonly stat: BigIntStats;
  readonly limits: ReturnType<typeof requiredCaptureLimits>;
  readonly state: PackageCaptureState;
}): PlannedPackageFile {
  const relativePath = packageRelativePath(
    options.limits.packageDirectory.realPackageRoot,
    options.absolutePath,
  );
  const remainingBytes = options.limits.maxBytes - options.state.totalBytes;
  const maxReadableBytes = Math.min(
    remainingBytes,
    options.limits.fileByteLimits?.get(relativePath) ?? remainingBytes,
  );

  if (
    options.state.entryCount >= options.limits.maxFiles ||
    options.stat.size > BigInt(maxReadableBytes)
  ) {
    throw captureError(options.absolutePath, 'too_large');
  }
  options.state.entryCount += 1;
  options.state.totalBytes += Number(options.stat.size);

  return Object.freeze({
    absolutePath: options.absolutePath,
    relativePath,
    identity: filesystemMetadataIdentity(options.stat),
    maxReadableBytes,
    type: 'file',
  } satisfies PlannedPackageFile);
}

function readBoundRegularFile(options: {
  readonly path: string;
  readonly maxBytes: number;
}): Buffer {
  let descriptor: number | undefined;

  try {
    // The path is already canonical, so `O_NOFOLLOW` binds the descriptor to
    // the resolved file rather than to a name that could be repointed after.
    descriptor = openFileSync(
      options.path,
      fileSystemConstants.O_RDONLY | fileSystemConstants.O_NOFOLLOW,
    );
    const openedStat = statFileSync(descriptor);

    if (!openedStat.isFile()) {
      throw captureError(options.path, 'not_regular');
    }
    if (openedStat.size > BigInt(options.maxBytes)) {
      throw captureError(options.path, 'too_large');
    }
    const source = readExactlyFromDescriptor({
      descriptor,
      path: options.path,
      byteLength: Number(openedStat.size),
    });
    const finalOpenedStat = statFileSync(descriptor);

    if (
      !filesystemStatsEqual(openedStat, finalOpenedStat) ||
      BigInt(source.byteLength) !== finalOpenedStat.size
    ) {
      throw captureError(options.path, 'changed');
    }
    assertBoundRegularFile(options.path, finalOpenedStat);
    return source;
  } catch (error: unknown) {
    if (error instanceof PackageCaptureError) {
      throw error;
    }
    throw captureError(options.path, 'unreadable');
  } finally {
    if (descriptor !== undefined) {
      closeFileSync(descriptor);
    }
  }
}

function readExactlyFromDescriptor(options: {
  readonly descriptor: number;
  readonly path: string;
  readonly byteLength: number;
}): Buffer {
  const source = Buffer.alloc(options.byteLength);
  let offset = 0;

  while (offset < source.byteLength) {
    const bytesRead = readBytesFromFileSync(
      options.descriptor,
      source,
      offset,
      source.byteLength - offset,
      null,
    );

    if (bytesRead === 0) {
      throw captureError(options.path, 'changed');
    }
    offset += bytesRead;
  }

  if (
    readBytesFromFileSync(
      options.descriptor,
      Buffer.allocUnsafe(1),
      0,
      1,
      null,
    ) !== 0
  ) {
    throw captureError(options.path, 'changed');
  }
  return source;
}

function snapshotContainedDirectory(options: {
  readonly packageDirectory: PackageDirectorySnapshot;
  readonly path: string;
}): PackageDirectorySnapshot {
  const snapshot = snapshotPackageDirectory(options.path);

  if (
    snapshot === undefined ||
    relativePathIfContained(
      options.packageDirectory.realPackageRoot,
      snapshot.realPackageRoot,
    ) === undefined
  ) {
    throw captureError(options.path, 'changed');
  }
  return snapshot;
}

function assertBoundPackage(snapshot: PackageDirectorySnapshot): void {
  if (!packageDirectorySnapshotIsCurrent(snapshot)) {
    throw captureError(snapshot.packageRoot, 'changed');
  }
}

function assertBoundDirectory(snapshot: PackageDirectorySnapshot): void {
  if (!packageDirectorySnapshotIsCurrent(snapshot)) {
    throw captureError(snapshot.realPackageRoot, 'changed');
  }
}

/**
 * The path is one the caller already resolved, so a spelling that is no longer
 * its own canonical form means the file was replaced mid-read.
 */
function assertBoundRegularFile(path: string, expected: BigIntStats): void {
  const current = describeRealEntry(path);

  if (
    current.kind !== 'file' ||
    !filesystemStatsEqual(expected, current.stats) ||
    canonicalPath(path) !== path
  ) {
    throw captureError(path, 'changed');
  }
}

function filesystemStatsEqual(left: BigIntStats, right: BigIntStats): boolean {
  return filesystemMetadataIdentity(left) === filesystemMetadataIdentity(right);
}

function packageRelativePath(root: string, path: string): string {
  const relativePath = relativePathIfContained(root, path);

  if (relativePath === undefined || relativePath === '') {
    throw captureError(path, 'changed');
  }
  return relativePath;
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join('/');
}

function normalizeFileByteLimits(
  limits: ReadonlyMap<string, number> | undefined,
): ReadonlyMap<string, number> | undefined {
  if (limits === undefined) {
    return undefined;
  }
  const normalized = new Map<string, number>();

  for (const [path, maxBytes] of limits) {
    const relativePath = normalizeRelativePath(path);

    if (
      relativePath === '' ||
      relativePath === '..' ||
      relativePath.startsWith('../') ||
      isAbsolute(relativePath) ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      normalized.has(relativePath)
    ) {
      throw new TypeError('Package file byte limits must be unique and valid.');
    }
    normalized.set(relativePath, maxBytes);
  }
  return normalized;
}

function captureError(
  path: string,
  reason: PackageCaptureRejectionReason,
): PackageCaptureError {
  return new PackageCaptureError({path, reason});
}
