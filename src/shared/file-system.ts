/**
 * The one place this codebase touches the filesystem.
 *
 * Every `node:fs` call in `src/` lives here. Nothing else may import
 * `node:fs` — `pnpm arch:check` enforces that with zero exemptions, so
 * "which files can hit the disk" has a one-word answer instead of the
 * nineteen files it was spread across.
 *
 * This seam owns mechanism, not policy. Every function is the raw
 * operation with this codebase's conventions applied — `bigint` stats,
 * `utf8` text, `withFileTypes` entries — and it raises the underlying
 * `node:fs` error unchanged. That is deliberate: callers already disagree
 * about what a failure *means*, and they should keep disagreeing.
 *
 *   runtime/storage      → LocalRuntimeStorageContractError
 *   runtime/config       → diagnostics naming the operator's own file
 *   plugin-file-store    → TypeError the plugin host branches on
 *   characters, plugins  → package rejection reasons
 *
 * Collapsing those into one error type would delete distinctions the CLI
 * and the plugin host branch on, so this seam unifies the *how* and
 * leaves the *what it means* where it already is.
 *
 * Two shared modules build directly on top of this one and are the right
 * thing to reach for first: `real-path.ts` answers "what is really at
 * this path" without an lstat block per caller, and
 * `runtime/storage/store-file.ts` maps store reads to contract errors.
 */
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type BigIntStats,
  type Dirent,
  type Stats,
} from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';

export type {BigIntStats, Dirent, FileHandle, Stats};

/** `node:fs` flag constants, for callers that pass their own open flags. */
export const fileSystemConstants = constants;

// --- Reading -------------------------------------------------------------

export function readTextFileSync(path: string): string {
  return readFileSync(path, 'utf8');
}

export function readFileBytesSync(path: string): Buffer {
  return readFileSync(path);
}

export async function readTextFile(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

/**
 * The file's last byte, or `undefined` when it is absent or empty.
 *
 * Appenders read this to tell a complete log from one a crash interrupted
 * mid-record, which is a question about one byte rather than a reason to
 * read a session's whole history into memory on every append.
 */
export function readFinalByteSync(path: string): number | undefined {
  let handle: number;

  try {
    handle = openSync(path, 'r');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }

  try {
    const size = fstatSync(handle).size;

    if (size === 0) {
      return undefined;
    }

    const buffer = Buffer.alloc(1);

    readSync(handle, buffer, 0, 1, size - 1);
    return buffer[0];
  } finally {
    closeSync(handle);
  }
}

// --- Inspecting ----------------------------------------------------------

/**
 * Stats follow links; `lstat*` reports the link itself. Both are `bigint`
 * because callers compare inodes for identity, and the `number` form
 * silently rounds the large ones some filesystems hand out.
 */
export function statPathSync(path: string): BigIntStats {
  return statSync(path, {bigint: true});
}

/**
 * Stats as plain numbers. Prefer `statPathSync`: identity comparisons need
 * `bigint`, because a filesystem handing out large inodes rounds them in
 * the `number` form. This variant exists for callers doing millisecond
 * arithmetic against `Date.now()`, where `bigint` `mtimeMs` would truncate
 * the sub-millisecond part the comparison currently sees.
 */
export function statPathNumericSync(path: string): Stats {
  return statSync(path);
}

export function lstatPathSync(path: string): BigIntStats {
  return lstatSync(path, {bigint: true});
}

export async function lstatPath(path: string): Promise<BigIntStats> {
  return lstat(path, {bigint: true});
}

export function realPathSync(path: string): string {
  return realpathSync(path);
}

/**
 * Canonicalize through the OS resolver rather than Node's JavaScript one.
 * The two disagree on case-insensitive filesystems: only the native call
 * returns the spelling the filesystem actually stored, which is what a
 * caller comparing two paths for identity needs.
 */
export function nativeRealPathSync(path: string): string {
  return realpathSync.native(path);
}

export function readLinkTargetSync(path: string): string {
  return readlinkSync(path);
}

/**
 * Prefer `real-path.ts`'s `describeRealEntry` when the next line acts on
 * what is there: existence answered separately from a later read is a
 * check-then-act race. This exists for the callers that genuinely only
 * need the boolean.
 */
export function pathExistsSync(path: string): boolean {
  return existsSync(path);
}

export function listDirectoryEntriesSync(path: string): Dirent[] {
  return readdirSync(path, {withFileTypes: true});
}

/**
 * Entry names without their types, for a caller that stats each one
 * itself anyway — a `Dirent` type is decided at readdir time, and a
 * caller re-checking it later would be trusting the older answer.
 */
export function listDirectoryNamesSync(path: string): string[] {
  return readdirSync(path);
}

export async function listDirectoryEntries(path: string): Promise<Dirent[]> {
  return readdir(path, {withFileTypes: true});
}

export async function listDirectoryNames(path: string): Promise<string[]> {
  return readdir(path);
}

// --- Writing -------------------------------------------------------------

export function appendTextFileSync(
  path: string,
  text: string,
  mode: number,
): void {
  appendFileSync(path, text, {encoding: 'utf8', mode});
}

/**
 * Cut a file back to `length` bytes. Append-only logs use this to drop a
 * trailing record a crash left unfinished, which is the one edit an
 * append-only file makes to what is already on disk.
 */
export function truncateFileSync(path: string, length: number): void {
  truncateSync(path, length);
}

/**
 * Append bytes, taking the platform's default creation mode. The text
 * variant asks its caller for a mode because the log it writes is the
 * operator's; this one replays a journal into a file the plugin host
 * already owns, and forcing a mode here would rewrite permissions the
 * replayed file was created with.
 */
export function appendBytesFileSync(path: string, bytes: Uint8Array): void {
  appendFileSync(path, bytes);
}

/**
 * `flag` is the caller's, because `'wx'` — create, or fail if it already
 * exists — is how the lock files claim exclusivity. A default would turn
 * a failed claim into a silent overwrite of somebody else's lock.
 */
export type WriteTextFileOptions = {
  readonly mode: number;
  readonly flag?: string;
};

export async function writeTextFile(
  path: string,
  text: string,
  options: WriteTextFileOptions,
): Promise<void> {
  await writeFile(path, text, {
    encoding: 'utf8',
    mode: options.mode,
    ...(options.flag === undefined ? {} : {flag: options.flag}),
  });
}

export function writeTextFileSync(
  path: string,
  text: string,
  options: WriteTextFileOptions,
): void {
  writeFileSync(path, text, {
    encoding: 'utf8',
    mode: options.mode,
    ...(options.flag === undefined ? {} : {flag: options.flag}),
  });
}

export function renamePathSync(fromPath: string, toPath: string): void {
  renameSync(fromPath, toPath);
}

export async function renamePath(
  fromPath: string,
  toPath: string,
): Promise<void> {
  await rename(fromPath, toPath);
}

export function chmodPathSync(path: string, mode: number): void {
  chmodSync(path, mode);
}

export async function chmodPath(path: string, mode: number): Promise<void> {
  await chmod(path, mode);
}

// --- Creating and removing ----------------------------------------------

export function makeDirectorySync(
  path: string,
  options?: {readonly recursive?: boolean; readonly mode?: number},
): void {
  mkdirSync(path, options);
}

export async function makeDirectory(
  path: string,
  options?: {readonly recursive?: boolean; readonly mode?: number},
): Promise<void> {
  await mkdir(path, options);
}

export function unlinkPathSync(path: string): void {
  unlinkSync(path);
}

export async function unlinkPath(path: string): Promise<void> {
  await unlink(path);
}

export function removePathSync(
  path: string,
  options?: {readonly recursive?: boolean; readonly force?: boolean},
): void {
  rmSync(path, options);
}

export async function removePath(
  path: string,
  options?: {readonly recursive?: boolean; readonly force?: boolean},
): Promise<void> {
  await rm(path, options);
}

export async function removeDirectory(path: string): Promise<void> {
  await rmdir(path);
}

// --- Descriptors --------------------------------------------------------

/**
 * Descriptor-level access, for the three operations that cannot be
 * expressed against a path: creating a file only if it does not exist
 * (`wx`), flushing one to disk before renaming it over its target, and
 * reading a bounded prefix of a file whose size is only trustworthy once
 * it is already open.
 */
export function openFileSync(
  path: string,
  flags: string | number,
  mode?: number,
): number {
  return openSync(path, flags, mode);
}

export async function openFile(
  path: string,
  flags: string | number,
  mode?: number,
): Promise<FileHandle> {
  return open(path, flags, mode);
}

export function closeFileSync(fileDescriptor: number): void {
  closeSync(fileDescriptor);
}

export function flushFileSync(fileDescriptor: number): void {
  fsyncSync(fileDescriptor);
}

export function statFileSync(fileDescriptor: number): BigIntStats {
  return fstatSync(fileDescriptor, {bigint: true});
}

/**
 * Write a descriptor's entire contents. Text or bytes, because the atomic
 * replace path carries whichever its caller handed it and re-encoding to
 * pick a typed variant would change the bytes that reach the disk.
 */
export function writeToFileSync(
  fileDescriptor: number,
  content: string | Uint8Array,
): void {
  writeFileSync(fileDescriptor, content);
}

/**
 * One write syscall's worth of text, returning how much of it landed.
 * `writeToFileSync` above loops until the whole content is written; this
 * is the single call, for a caller appending to a descriptor it opened
 * itself and flushes explicitly.
 */
export function writeTextToFileSync(
  fileDescriptor: number,
  text: string,
): number {
  return writeSync(fileDescriptor, text);
}

export function readBytesFromFileSync(
  fileDescriptor: number,
  target: Uint8Array,
  offset: number,
  length: number,
  position: number | null,
): number {
  return readSync(fileDescriptor, target, offset, length, position);
}
