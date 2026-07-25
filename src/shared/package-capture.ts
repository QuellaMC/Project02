/**
 * Physical package capture shared by data-only character packages and
 * executable plugin packages. A capture is rooted in one already-bound
 * package directory, traverses only its canonical tree, and returns copied
 * bytes after the complete ancestry and every opened file still match.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';

import {
  filesystemMetadataIdentity,
  packageDirectorySnapshotIsCurrent,
  snapshotPackageDirectory,
  type PackageDirectorySnapshot,
} from './package-metadata.ts';

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

export class PackageCaptureError extends Error {
  readonly path: string;
  readonly reason:
    'changed' | 'symbolic_link' | 'not_regular' | 'too_large' | 'unreadable';

  constructor(options: {
    readonly path: string;
    readonly reason:
      'changed' | 'symbolic_link' | 'not_regular' | 'too_large' | 'unreadable';
  }) {
    super('Package could not be captured.');
    this.name = 'PackageCaptureError';
    this.path = options.path;
    this.reason = options.reason;
  }
}

type PackageCaptureState = {
  readonly directories: Set<string>;
  readonly files: Map<string, CapturedPackageFile>;
  fileCount: number;
  totalBytes: number;
};

export function capturePackageDirectoryArtifact(options: {
  readonly packageDirectory: PackageDirectorySnapshot;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly fileByteLimits?: ReadonlyMap<string, number>;
}): CapturedPackageArtifact {
  if (
    !Number.isSafeInteger(options.maxFiles) ||
    options.maxFiles < 1 ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1
  ) {
    throw new TypeError('Package capture limits must be positive integers.');
  }
  const fileByteLimits = normalizeFileByteLimits(options.fileByteLimits);
  const state: PackageCaptureState = {
    directories: new Set(),
    files: new Map(),
    fileCount: 0,
    totalBytes: 0,
  };

  captureDirectory({
    directory: options.packageDirectory,
    packageDirectory: options.packageDirectory,
    maxFiles: options.maxFiles,
    maxBytes: options.maxBytes,
    fileByteLimits,
    state,
  });
  assertBoundPackage(options.packageDirectory);

  return Object.freeze({
    packageDirectory: options.packageDirectory,
    directories: state.directories,
    files: state.files,
  } satisfies CapturedPackageArtifact);
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
  const state: PackageCaptureState = {
    directories: new Set(),
    files: new Map(),
    fileCount: 0,
    totalBytes: 0,
  };

  for (const relativePath of paths) {
    const absolutePath = resolve(
      options.packageDirectory.realPackageRoot,
      relativePath,
    );

    if (
      packageRelativePathIfContained(
        options.packageDirectory.realPackageRoot,
        absolutePath,
      ) !== relativePath
    ) {
      throw new TypeError('Package capture path escaped its package.');
    }
    assertBoundPackage(options.packageDirectory);
    let stat: BigIntStats;

    try {
      stat = lstatSync(absolutePath, {bigint: true});
    } catch {
      throw captureError(absolutePath, 'unreadable');
    }
    if (stat.isSymbolicLink()) {
      throw captureError(absolutePath, 'symbolic_link');
    }
    if (!stat.isFile()) {
      throw captureError(absolutePath, 'not_regular');
    }
    captureFile({
      absolutePath,
      initialStat: stat,
      packageDirectory: options.packageDirectory,
      maxFiles: paths.size,
      maxBytes: options.maxBytes,
      fileByteLimits: undefined,
      state,
    });
  }
  assertBoundPackage(options.packageDirectory);

  return Object.freeze({
    packageDirectory: options.packageDirectory,
    directories: state.directories,
    files: state.files,
  } satisfies CapturedPackageArtifact);
}

export function readCapturedPackageFile(
  artifact: Pick<CapturedPackageArtifact, 'files'>,
  relativePath: string,
): Buffer | undefined {
  const file = artifact.files.get(normalizeRelativePath(relativePath));

  return file === undefined ? undefined : Buffer.from(file.source);
}

function captureDirectory(options: {
  readonly directory: PackageDirectorySnapshot;
  readonly packageDirectory: PackageDirectorySnapshot;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly fileByteLimits: ReadonlyMap<string, number> | undefined;
  readonly state: PackageCaptureState;
}): void {
  assertBoundPackage(options.packageDirectory);
  assertBoundDirectory(options.directory);
  let names: string[];

  try {
    names = readdirSync(options.directory.realPackageRoot).sort(compareText);
  } catch {
    throw captureError(options.directory.realPackageRoot, 'unreadable');
  }
  assertBoundDirectory(options.directory);
  assertBoundPackage(options.packageDirectory);

  for (const name of names) {
    const absolutePath = join(options.directory.realPackageRoot, name);
    let stat: BigIntStats;

    assertBoundPackage(options.packageDirectory);
    try {
      stat = lstatSync(absolutePath, {bigint: true});
    } catch {
      throw captureError(absolutePath, 'unreadable');
    }
    assertBoundPackage(options.packageDirectory);

    if (stat.isSymbolicLink()) {
      throw captureError(absolutePath, 'symbolic_link');
    }
    if (stat.isDirectory()) {
      const directory = snapshotContainedDirectory({
        packageDirectory: options.packageDirectory,
        path: absolutePath,
      });
      const relativePath = packageRelativePath(
        options.packageDirectory.realPackageRoot,
        directory.realPackageRoot,
      );

      options.state.directories.add(relativePath);
      captureDirectory({...options, directory});
      continue;
    }
    if (!stat.isFile()) {
      throw captureError(absolutePath, 'not_regular');
    }
    captureFile({...options, absolutePath, initialStat: stat});
  }

  assertBoundDirectory(options.directory);
  assertBoundPackage(options.packageDirectory);
}

function captureFile(options: {
  readonly absolutePath: string;
  readonly initialStat: BigIntStats;
  readonly packageDirectory: PackageDirectorySnapshot;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly fileByteLimits: ReadonlyMap<string, number> | undefined;
  readonly state: PackageCaptureState;
}): void {
  const relativePath = packageRelativePath(
    options.packageDirectory.realPackageRoot,
    options.absolutePath,
  );
  const remainingBytes = options.maxBytes - options.state.totalBytes;
  const maxReadableBytes = Math.min(
    remainingBytes,
    options.fileByteLimits?.get(relativePath) ?? remainingBytes,
  );

  if (
    options.state.fileCount >= options.maxFiles ||
    options.initialStat.size > BigInt(maxReadableBytes)
  ) {
    throw captureError(options.absolutePath, 'too_large');
  }
  const source = readBoundRegularFile({
    path: options.absolutePath,
    expected: options.initialStat,
    packageDirectory: options.packageDirectory,
    maxBytes: maxReadableBytes,
  });

  if (options.state.totalBytes + source.byteLength > options.maxBytes) {
    throw captureError(options.absolutePath, 'too_large');
  }
  options.state.fileCount += 1;
  options.state.totalBytes += source.byteLength;
  options.state.files.set(
    relativePath,
    Object.freeze({
      absolutePath: options.absolutePath,
      relativePath,
      source,
      type: 'file',
    }),
  );
}

function readBoundRegularFile(options: {
  readonly path: string;
  readonly expected: BigIntStats;
  readonly packageDirectory: PackageDirectorySnapshot;
  readonly maxBytes: number;
}): Buffer {
  let descriptor: number | undefined;

  try {
    assertBoundPackage(options.packageDirectory);
    descriptor = openSync(
      options.path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const openedStat = fstatSync(descriptor, {bigint: true});

    if (!openedStat.isFile()) {
      throw captureError(options.path, 'changed');
    }
    if (openedStat.size > BigInt(options.maxBytes)) {
      throw captureError(options.path, 'too_large');
    }
    if (!filesystemStatsEqual(options.expected, openedStat)) {
      throw captureError(options.path, 'changed');
    }
    assertBoundPackage(options.packageDirectory);
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
    assertBoundPackage(options.packageDirectory);
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
    packageRelativePathIfContained(
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

function assertBoundRegularFile(path: string, expected: BigIntStats): void {
  let current: BigIntStats;

  try {
    current = lstatSync(path, {bigint: true});
  } catch {
    throw captureError(path, 'changed');
  }
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    !filesystemStatsEqual(expected, current) ||
    realpathSync(path) !== path
  ) {
    throw captureError(path, 'changed');
  }
}

function filesystemStatsEqual(left: BigIntStats, right: BigIntStats): boolean {
  return filesystemMetadataIdentity(left) === filesystemMetadataIdentity(right);
}

function packageRelativePath(root: string, path: string): string {
  const relativePath = packageRelativePathIfContained(root, path);

  if (relativePath === undefined || relativePath === '') {
    throw captureError(path, 'changed');
  }
  return relativePath;
}

function packageRelativePathIfContained(
  root: string,
  path: string,
): string | undefined {
  const relativePath = relative(resolve(root), resolve(path));

  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return undefined;
  }
  return normalizeRelativePath(relativePath);
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
  reason: PackageCaptureError['reason'],
): PackageCaptureError {
  return new PackageCaptureError({path, reason});
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
