/**
 * The only module that may import `node:fs`; `pnpm arch:check` enforces
 * that with zero exemptions. Every function raises the underlying
 * `node:fs` error unchanged, because callers disagree about what a
 * failure means.
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
  type BigIntStats,
  type Dirent,
  type Stats,
} from 'node:fs';
import {mkdir, readdir, readFile, rmdir} from 'node:fs/promises';

import {isNodeErrorWithCode} from './node-error.ts';

export type {BigIntStats, Dirent, Stats};

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

/** The file's last byte, or `undefined` when it is absent or empty. */
export function readFinalByteSync(path: string): number | undefined {
  let handle: number;

  try {
    handle = openSync(path, 'r');
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
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
 * `bigint` because callers compare inodes for identity, and the `number`
 * form silently rounds the large ones some filesystems hand out.
 */
export function statPathSync(path: string): BigIntStats {
  return statSync(path, {bigint: true});
}

/**
 * For millisecond arithmetic against `Date.now()`, where `bigint` `mtimeMs`
 * would truncate the sub-millisecond part the comparison sees.
 */
export function statPathNumericSync(path: string): Stats {
  return statSync(path);
}

export function lstatPathSync(path: string): BigIntStats {
  return lstatSync(path, {bigint: true});
}

/**
 * The OS resolver, which is the only one that returns the spelling the
 * filesystem stored; Node's JavaScript one disagrees on case-insensitive
 * filesystems.
 */
export function nativeRealPathSync(path: string): string {
  return realpathSync.native(path);
}

export function readLinkTargetSync(path: string): string {
  return readlinkSync(path);
}

/**
 * Prefer `describeRealEntry` when the next line acts on what is there:
 * existence answered separately from a later read is a check-then-act race.
 */
export function pathExistsSync(path: string): boolean {
  return existsSync(path);
}

export function listDirectoryEntriesSync(path: string): Dirent[] {
  return readdirSync(path, {withFileTypes: true});
}

/**
 * Names only, for a caller that stats each entry itself: a `Dirent` type is
 * decided at readdir time and is the older answer by then.
 */
export function listDirectoryNamesSync(path: string): string[] {
  return readdirSync(path);
}

export async function listDirectoryEntries(path: string): Promise<Dirent[]> {
  return readdir(path, {withFileTypes: true});
}

// --- Writing -------------------------------------------------------------

export function appendTextFileSync(
  path: string,
  text: string,
  mode: number,
): void {
  appendFileSync(path, text, {encoding: 'utf8', mode});
}

export function truncateFileSync(path: string, length: number): void {
  truncateSync(path, length);
}

/**
 * No mode: this appends to a file its owner already created, and forcing
 * one would rewrite the permissions it was created with.
 */
export function appendBytesFileSync(path: string, bytes: Uint8Array): void {
  appendFileSync(path, bytes);
}

/**
 * `flag` is the caller's: lock files claim exclusivity with `'wx'`, and a
 * default would turn a failed claim into a silent overwrite.
 */
type WriteTextFileOptions = {
  readonly mode: number;
  readonly flag?: string;
};

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

export function chmodPathSync(path: string, mode: number): void {
  chmodSync(path, mode);
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

export function removePathSync(
  path: string,
  options?: {readonly recursive?: boolean; readonly force?: boolean},
): void {
  rmSync(path, options);
}

export async function removeDirectory(path: string): Promise<void> {
  await rmdir(path);
}

// --- Descriptors --------------------------------------------------------

export function openFileSync(
  path: string,
  flags: string | number,
  mode?: number,
): number {
  return openSync(path, flags, mode);
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
 * Text or bytes, because re-encoding to pick one would change the bytes
 * that reach the disk.
 */
export function writeToFileSync(
  fileDescriptor: number,
  content: string | Uint8Array,
): void {
  writeFileSync(fileDescriptor, content);
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
