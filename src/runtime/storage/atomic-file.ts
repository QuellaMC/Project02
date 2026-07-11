import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  type Dirent,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import {
  chmod,
  mkdir,
  open,
  rename,
  unlink
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export type AtomicReplaceFileOptions = {
  readonly targetPath: string;
  readonly content: string | Uint8Array;
  readonly mode?: number;
  readonly createParent?: boolean;
};

export async function atomicReplaceFile(
  options: AtomicReplaceFileOptions
): Promise<void> {
  const targetDirectory = dirname(options.targetPath);
  const temporaryPath = temporaryReplacementPath(options.targetPath);
  const mode = options.mode ?? 0o600;
  let temporaryFileExists = false;

  if (options.createParent !== false) {
    await mkdir(targetDirectory, { recursive: true });
  }

  try {
    const handle = await open(temporaryPath, 'wx', mode);
    temporaryFileExists = true;

    try {
      await handle.writeFile(options.content);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await chmodIfSupported(temporaryPath, mode);
    await rename(temporaryPath, options.targetPath);
    temporaryFileExists = false;
    await chmodIfSupported(options.targetPath, mode);
    await syncDirectoryIfSupported(targetDirectory);
  } finally {
    if (temporaryFileExists) {
      await unlink(temporaryPath).catch(() => {});
    }
  }
}

export function atomicReplaceFileSync(options: AtomicReplaceFileOptions): void {
  const targetDirectory = dirname(options.targetPath);
  const temporaryPath = temporaryReplacementPath(options.targetPath);
  const mode = options.mode ?? 0o600;
  let temporaryFileExists = false;
  let fileDescriptor: number | undefined;

  if (options.createParent !== false) {
    mkdirSync(targetDirectory, { recursive: true });
  }

  try {
    fileDescriptor = openSync(temporaryPath, 'wx', mode);
    temporaryFileExists = true;
    writeFileSync(fileDescriptor, options.content);
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    chmodSyncIfSupported(temporaryPath, mode);
    renameSync(temporaryPath, options.targetPath);
    temporaryFileExists = false;
    chmodSyncIfSupported(options.targetPath, mode);
    syncDirectorySyncIfSupported(targetDirectory);
  } finally {
    if (fileDescriptor !== undefined) {
      try {
        closeSync(fileDescriptor);
      } catch {
        // The original file operation failure remains authoritative.
      }
    }

    if (temporaryFileExists) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The original file operation failure remains authoritative.
      }
    }
  }
}

export function cleanupAbandonedAtomicReplacementFilesSync(
  targetPath: string
): void {
  const targetDirectory = dirname(targetPath);
  const prefix = `.${basename(targetPath)}.`;
  let entries: Dirent[];

  try {
    entries = readdirSync(targetDirectory, { withFileTypes: true });
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return;
    }

    throw error;
  }

  for (const entry of entries) {
    const ownerPid = atomicReplacementOwnerPid({ name: entry.name, prefix });

    if (
      !entry.isFile() ||
      ownerPid === undefined ||
      processIsAlive(ownerPid)
    ) {
      continue;
    }

    try {
      unlinkSync(join(targetDirectory, entry.name));
    } catch (error: unknown) {
      if (!isNodeErrorWithCode(error, 'ENOENT')) {
        throw error;
      }
    }
  }
}

function temporaryReplacementPath(targetPath: string): string {
  const targetDirectory = dirname(targetPath);

  return join(
    targetDirectory,
    `.${basename(targetPath)}.${String(process.pid)}.${randomUUID()}.tmp`
  );
}

function atomicReplacementOwnerPid(options: {
  readonly name: string;
  readonly prefix: string;
}): number | undefined {
  if (!options.name.startsWith(options.prefix)) {
    return undefined;
  }

  const suffix = options.name.slice(options.prefix.length);
  const match = /^(\d+)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/iu.exec(
    suffix
  );
  const pid = match?.[1] === undefined ? Number.NaN : Number(match[1]);

  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !isNodeErrorWithCode(error, 'ESRCH');
  }
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

async function chmodIfSupported(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch {
    // Some filesystems do not support chmod.
  }
}

function chmodSyncIfSupported(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Some filesystems do not support chmod.
  }
}

async function syncDirectoryIfSupported(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r');

    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not available on every supported filesystem.
  }
}

function syncDirectorySyncIfSupported(path: string): void {
  let fileDescriptor: number | undefined;

  try {
    fileDescriptor = openSync(path, 'r');
    fsyncSync(fileDescriptor);
  } catch {
    // Directory fsync is not available on every supported filesystem.
  } finally {
    if (fileDescriptor !== undefined) {
      try {
        closeSync(fileDescriptor);
      } catch {
        // Best-effort directory durability must not mask a successful rename.
      }
    }
  }
}
