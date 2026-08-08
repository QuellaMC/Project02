import {randomUUID} from 'node:crypto';
import {basename, dirname, join} from 'node:path';
import {
  chmodPathSync,
  closeFileSync,
  flushFileSync,
  listDirectoryEntriesSync,
  makeDirectorySync,
  openFileSync,
  renamePathSync,
  unlinkPathSync,
  writeToFileSync,
  type Dirent,
} from '../../shared/file-system.ts';
import {isNodeErrorWithCode} from '../../shared/node-error.ts';
import {processIsAlive} from './process-liveness.ts';

export type AtomicReplaceFileOptions = {
  readonly targetPath: string;
  readonly content: string | Uint8Array;
  readonly mode?: number;
  readonly createParent?: boolean;
};

export function atomicReplaceFileSync(options: AtomicReplaceFileOptions): void {
  const targetDirectory = dirname(options.targetPath);
  const temporaryPath = createAtomicReplacementPath(options.targetPath);
  const mode = options.mode ?? 0o600;
  let temporaryFileExists = false;
  let fileDescriptor: number | undefined;

  if (options.createParent !== false) {
    makeDirectorySync(targetDirectory, {recursive: true});
  }

  try {
    fileDescriptor = openFileSync(temporaryPath, 'wx', mode);
    temporaryFileExists = true;
    writeToFileSync(fileDescriptor, options.content);
    flushFileSync(fileDescriptor);
    closeFileSync(fileDescriptor);
    fileDescriptor = undefined;
    chmodIfSupported(temporaryPath, mode);
    renamePathSync(temporaryPath, options.targetPath);
    temporaryFileExists = false;
    chmodIfSupported(options.targetPath, mode);
    syncDirectoryIfSupported(targetDirectory);
  } finally {
    if (fileDescriptor !== undefined) {
      try {
        closeFileSync(fileDescriptor);
      } catch {
        // The original file operation failure remains authoritative.
      }
    }

    if (temporaryFileExists) {
      try {
        unlinkPathSync(temporaryPath);
      } catch {
        // The original file operation failure remains authoritative.
      }
    }
  }
}

export function cleanupAbandonedAtomicReplacementFilesSync(
  targetPath: string,
): void {
  cleanupAbandonedAtomicReplacementsIn(dirname(targetPath), [
    basename(targetPath),
  ]);
}

/**
 * A missing directory, or a file that vanishes mid-scan, is another
 * process finishing the same cleanup rather than a failure.
 */
export function cleanupAbandonedAtomicReplacementsIn(
  directory: string,
  targetNames: readonly string[],
): void {
  let entries: Dirent[];

  try {
    entries = listDirectoryEntriesSync(directory);
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return;
    }

    throw error;
  }

  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !targetNames.some(targetName =>
        atomicReplacementFileBelongsToTarget(entry.name, targetName),
      ) ||
      !isAbandonedAtomicReplacementFile(entry.name)
    ) {
      continue;
    }

    try {
      unlinkPathSync(join(directory, entry.name));
    } catch (error: unknown) {
      if (!isNodeErrorWithCode(error, 'ENOENT')) {
        throw error;
      }
    }
  }
}

function createAtomicReplacementPath(targetPath: string): string {
  const targetDirectory = dirname(targetPath);

  return join(
    targetDirectory,
    `.${basename(targetPath)}.${String(process.pid)}.${randomUUID()}.tmp`,
  );
}

type AtomicReplacementFileIdentity = {
  readonly targetName: string;
  readonly ownerPid: number;
};

export function parseAtomicReplacementFileName(
  fileName: string,
): AtomicReplacementFileIdentity | undefined {
  const match =
    /^\.(.+)\.(\d+)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/iu.exec(
      fileName,
    );
  const targetName = match?.[1];
  const ownerPid = match?.[2] === undefined ? Number.NaN : Number(match[2]);

  return targetName !== undefined &&
    targetName.length > 0 &&
    Number.isSafeInteger(ownerPid) &&
    ownerPid > 0
    ? Object.freeze({targetName, ownerPid})
    : undefined;
}

export function atomicReplacementFileBelongsToTarget(
  fileName: string,
  targetPath: string,
): boolean {
  return (
    parseAtomicReplacementFileName(fileName)?.targetName ===
    basename(targetPath)
  );
}

export function isAbandonedAtomicReplacementFile(fileName: string): boolean {
  const identity = parseAtomicReplacementFileName(fileName);

  return identity !== undefined && !processIsAlive(identity.ownerPid);
}

export function isLiveAtomicReplacementForAnyTarget(
  fileName: string,
  targetPaths: readonly string[],
): boolean {
  return (
    targetPaths.some(targetPath =>
      atomicReplacementFileBelongsToTarget(fileName, targetPath),
    ) && !isAbandonedAtomicReplacementFile(fileName)
  );
}

function chmodIfSupported(path: string, mode: number): void {
  try {
    chmodPathSync(path, mode);
  } catch {
    // Some filesystems do not support chmod.
  }
}

function syncDirectoryIfSupported(path: string): void {
  let fileDescriptor: number | undefined;

  try {
    fileDescriptor = openFileSync(path, 'r');
    flushFileSync(fileDescriptor);
  } catch {
    // Directory fsync is not available on every supported filesystem.
  } finally {
    if (fileDescriptor !== undefined) {
      try {
        closeFileSync(fileDescriptor);
      } catch {
        // Best-effort directory durability must not mask a successful rename.
      }
    }
  }
}
