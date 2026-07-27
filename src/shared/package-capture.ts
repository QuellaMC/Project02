/**
 * Physical package capture shared by data-only character packages and
 * executable plugin packages. A capture is rooted in one already-bound
 * package directory and traverses only its canonical tree, so every path it
 * describes belongs to the package it was rooted in.
 *
 * Walking and reading are separate. `planPackageDirectoryCapture` stats every
 * entry and enforces every limit without reading a byte; `capturePackageFiles`
 * plans and reads a few named files; `readPlannedPackageFile` reads one planned
 * file whenever its caller actually needs it. A caller that only needs to know
 * whether a tree is capturable pays no memory for its contents, and because
 * both answers come from the same walk they cannot drift.
 */
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import {isAbsolute, join, resolve, sep} from 'node:path';

import {
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
 * One regular file the walk accepted, described by its stat alone.
 *
 * `maxReadableBytes` is resolved here rather than at read time so a planned
 * file carries its own bound: a later reader does not need the limits the walk
 * ran under, and cannot widen them. It bounds one file. The aggregate `maxBytes`
 * is a walk-time bound on the tree as the walk found it, not a running total
 * over reads that may happen much later.
 *
 * `identity` is the file's filesystem identity as the walk saw it. A later read
 * is bounded but not pinned to it — a package edited underneath a running
 * process is read as it is then — so it describes the walk, not a promise about
 * the bytes.
 *
 * `absolutePath` is where the package names the file, not necessarily the file
 * itself: a link is resolved to the contained file it names, and resolved again
 * at read time rather than remembered, so a name that comes to point somewhere
 * else is re-judged instead of trusted.
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
 * Why a package could not be captured.
 *
 * A file link is not among them: the walk resolves one to the real file it
 * names and captures that, so a link is only rejected for what it points at
 * — nothing (`not_regular`), or a file that moved out from under the plan
 * (`changed`).
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
   * Every captured entry, directory or file, counted against `maxFiles`.
   *
   * Directories are recorded and recursed into, so counting only files let a
   * package of empty directories traverse without limit: it consumed no bytes
   * and never reached the file cap.
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
 * Bounds how deep a captured package may nest.
 *
 * `planDirectory` recurses per level, so depth is stack depth. Most
 * filesystems reject a long enough path first, but that is a platform
 * accident: this makes the limit a package diagnostic instead.
 */
const maxPackageCaptureDepth = 64;

/**
 * Walks the package tree with stat only.
 *
 * Every rejection a reading capture can raise while walking is raised here too
 * — a non-regular entry, an unreadable directory, an entry or byte budget
 * overrun, an over-deep tree, a package that changed mid-walk — because stat is
 * what those decisions were always made on. What is missing is only the bytes.
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
 * Reads the bytes of one planned file, whenever its caller needs them.
 *
 * What the plan supplies is the file's own byte limit and the promise that the
 * walk accepted this path; what is re-checked now is everything about the file
 * itself — still inside the package, still a regular file, still within that
 * limit, still whole. The walk's stat is deliberately not re-imposed: a package
 * edited underneath a running process is read as it is then, because refusing it
 * would turn an ordinary edit into a failure the operator cannot act on.
 *
 * The package snapshot is not re-asserted either. It says the tree still matches
 * the walk, which a deferred read has no reason to require and every reason not
 * to — a package legitimately reinstalled after discovery would otherwise become
 * unloadable.
 */
export function readPlannedPackageFile(options: {
  readonly packageDirectory: PackageDirectorySnapshot;
  readonly file: PlannedPackageFile;
}): Buffer {
  const resolved = resolveContainedPackageFile({
    packageDirectory: options.packageDirectory,
    path: options.file.absolutePath,
  });

  if (resolved === undefined) {
    throw captureError(options.file.absolutePath, 'not_regular');
  }
  return readBoundRegularFile({
    path: resolved.readPath,
    maxBytes: options.file.maxReadableBytes,
  });
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
    names = readdirSync(options.directory.realPackageRoot).sort(compareText);
  } catch {
    throw captureError(options.directory.realPackageRoot, 'unreadable');
  }
  assertBoundDirectory(options.directory);
  assertBoundPackage(packageDirectory);

  for (const name of names) {
    const absolutePath = join(options.directory.realPackageRoot, name);

    assertBoundPackage(packageDirectory);
    const entry = describeRealEntry(absolutePath);

    // An entry the directory listed a moment ago and no longer has is as
    // uncapturable as one that cannot be stat'd, so both read as unreadable.
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
        // A link to anything but a contained regular file: a directory link
        // would let the walk cycle, a link out of the package would let it
        // describe a tree it does not own, and a dangling link has nothing to
        // read at all.
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
 * Resolves a package path to the contained regular file it names.
 *
 * A plain file resolves to itself and a link resolves to its target, so the
 * walk and every later read agree on what a path means without either needing
 * to know which it was. Only a contained regular file resolves: a link out of
 * the package would let the walk describe one tree while a read returns another,
 * and a directory link would let the walk cycle.
 *
 * The walk and the read call this separately rather than sharing a remembered
 * result, so a path that comes to name something else is re-judged at the moment
 * it is used.
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
 * Accepts one regular file against the remaining budgets, from its stat.
 *
 * The stat's size is what the budgets are spent on, and the bound that survives
 * on the planned file is re-checked against the descriptor when the bytes are
 * read, so a file that grew after the walk is refused at the read rather than
 * silently outspending the accounting.
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

/**
 * Reads one already-resolved regular file, whole and unchanged.
 *
 * The checks here are about this read: the descriptor is a regular file within
 * its limit, the bytes are exactly the file, and nothing rewrote it while it was
 * being read. Whether the surrounding package is still the one that was walked
 * is a separate question, and belongs to whoever knows when the walk happened —
 * an immediate capture asserts it around the whole operation, and a deferred
 * read deliberately does not.
 */
function readBoundRegularFile(options: {
  readonly path: string;
  readonly maxBytes: number;
}): Buffer {
  let descriptor: number | undefined;

  try {
    // The path is already canonical, so opening without following is not a
    // restriction on links — it is what keeps the descriptor bound to a real
    // file rather than to a name that could be repointed after resolution.
    descriptor = openSync(
      options.path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const openedStat = fstatSync(descriptor, {bigint: true});

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
    const finalOpenedStat = fstatSync(descriptor, {bigint: true});

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
      closeSync(descriptor);
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
    const bytesRead = readSync(
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

  if (readSync(options.descriptor, Buffer.allocUnsafe(1), 0, 1, null) !== 0) {
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
 * Re-checks that an open file is still the one the read was bounded against.
 *
 * The path must still be its own canonical spelling: this runs on a path the
 * caller already resolved, so a link appearing at it means the file was
 * replaced between the resolve and the read.
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
