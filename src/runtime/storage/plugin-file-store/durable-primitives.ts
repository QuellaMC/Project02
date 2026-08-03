import {createHash, type Hash} from 'node:crypto';
import {join, parse, resolve} from 'node:path';

import {
  listDirectoryEntriesSync,
  lstatPathSync,
  readFileBytesSync,
  readTextFileSync,
  removePathSync,
  type Dirent,
} from '../../../shared/file-system.ts';
import {
  canonicalPath,
  describeRealEntry,
  firstUnacceptableComponent,
} from '../../../shared/real-path.ts';

import {
  atomicReplaceFileSync,
  isAbandonedAtomicReplacementFile,
  parseAtomicReplacementFileName,
} from '../atomic-file.ts';
import {
  createLocalRuntimePluginPaths,
  createLocalRuntimeStorageLayout,
} from '../layout-contract.ts';
import {
  acquireLocalRuntimeMutationLocks,
  acquireLocalRuntimeMutationLocksSync,
  LocalRuntimeMutationLocksAcquireError,
  type LocalRuntimeMutationLockOwnerToken,
} from '../mutation-lock.ts';
import type {RuntimePluginJsonValue} from '../../../plugins/index.ts';
import type {RuntimePluginFileStorePathMode} from '../../../plugins/index.ts';
import {MalformedJsonLineError} from '../json-lines.ts';
import {
  assertJsonlPathMode,
  assertJsonPathMode,
  durableDirectMutationJournalFileName,
  durablePathModesFileName,
  durableRevisionFileName,
  isMissingFileError,
  isPlainObject,
  isRuntimePluginFileStorePathMode,
  normalizeRuntimePluginFileStorePath,
  parseRuntimePluginJsonlContent,
} from './shared.ts';

const durablePathModeCacheMaxRoots = 128;
const durablePathModeCache = new Map<
  string,
  {
    readonly fileStamp: string;
    readonly modes: ReadonlyMap<string, RuntimePluginFileStorePathMode>;
  }
>();

export type DurablePluginFileStoreOperation = {
  readonly pluginId?: string;
  readonly path: string;
  readonly kind: 'append_jsonl' | 'write_json';
  readonly value: RuntimePluginJsonValue;
};

export function durablePluginRoot(options: {
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly pluginId: string;
}): string {
  return createLocalRuntimePluginPaths(options).pluginRoot;
}

export function withDurablePluginStoreMutation<T>(
  options: {
    readonly resourceKeys?: readonly string[];
    readonly storeRoot: string;
    readonly root: string;
    readonly ownerToken?: LocalRuntimeMutationLockOwnerToken;
  },
  operation: () => T,
): T {
  return withDurablePluginStoreMutations(
    {
      storeRoot: options.storeRoot,
      roots: [options.root],
      ...(options.resourceKeys === undefined
        ? {}
        : {resourceKeys: options.resourceKeys}),
      ...(options.ownerToken === undefined
        ? {}
        : {ownerToken: options.ownerToken}),
    },
    operation,
  );
}

export function withDurablePluginStoreMutations<T>(
  options: {
    readonly resourceKeys?: readonly string[];
    readonly storeRoot: string;
    readonly roots: readonly string[];
    readonly ownerToken?: LocalRuntimeMutationLockOwnerToken;
  },
  operation: () => T,
): T {
  const locksRoot = createLocalRuntimeStorageLayout({
    storeRoot: options.storeRoot,
  }).locksRoot;
  const resourceKeys = [
    ...options.roots.map(durablePluginStoreMutationResourceKey),
    ...(options.resourceKeys ?? []),
  ];
  let lease: ReturnType<typeof acquireLocalRuntimeMutationLocksSync>;

  try {
    lease = acquireLocalRuntimeMutationLocksSync({
      targets: resourceKeys.map(resourceKey => ({locksRoot, resourceKey})),
      waitTimeoutMs: 0,
      ...(options.ownerToken === undefined
        ? {}
        : {ownerToken: options.ownerToken}),
    });
  } catch (error: unknown) {
    throw singleMutationLockError(error);
  }

  try {
    return operation();
  } finally {
    lease.release();
  }
}

export async function withDurablePluginStoreMutationsAsync<T>(
  options: {
    readonly resourceKeys?: readonly string[];
    readonly storeRoot: string;
    readonly roots: readonly string[];
    readonly ownerToken?: LocalRuntimeMutationLockOwnerToken;
  },
  operation: () => T | Promise<T>,
): Promise<T> {
  const locksRoot = createLocalRuntimeStorageLayout({
    storeRoot: options.storeRoot,
  }).locksRoot;
  const resourceKeys = [
    ...options.roots.map(durablePluginStoreMutationResourceKey),
    ...(options.resourceKeys ?? []),
  ];
  let lease: Awaited<ReturnType<typeof acquireLocalRuntimeMutationLocks>>;

  try {
    lease = await acquireLocalRuntimeMutationLocks({
      targets: resourceKeys.map(resourceKey => ({locksRoot, resourceKey})),
      waitTimeoutMs: 0,
      ...(options.ownerToken === undefined
        ? {}
        : {ownerToken: options.ownerToken}),
    });
  } catch (error: unknown) {
    throw singleMutationLockError(error);
  }

  try {
    return await operation();
  } finally {
    await lease.release();
  }
}

export function durablePluginStoreMutationResourceKey(root: string): string {
  return `plugin:${canonicalDurablePluginStoreRoot(root)}`;
}

function singleMutationLockError(error: unknown): unknown {
  return error instanceof LocalRuntimeMutationLocksAcquireError
    ? (error.cause ?? error)
    : error;
}

export function canonicalDurablePluginStoreRoot(storeRoot: string): string {
  const canonical = canonicalPath(storeRoot);

  assertSafeDurableDirectoryPath(canonical, 'Plugin fileStore store root');
  return canonical;
}

function assertSafeDurableDirectoryPath(path: string, label: string): void {
  const absolute = resolve(path);
  const offending = firstUnacceptableComponent({
    root: parse(absolute).root,
    path: absolute,
    accept: ['directory'],
  });

  if (offending !== undefined) {
    throw new TypeError(
      offending.kind === 'link'
        ? `${label} must be a real directory and cannot contain symlinks.`
        : `${label} must be a real directory.`,
    );
  }
}

export function assertSafeDurableTransactionJournalDirectory(
  path: string,
): void {
  assertSafeDurableDirectoryPath(
    path,
    'Plugin fileStore transaction journal root',
  );
}

export function assertSafeDurablePluginRoot(root: string): void {
  assertSafeDurableDirectoryPath(root, 'Plugin fileStore root');
}

export function assertSafeDurablePluginPath(
  root: string,
  safePath: string,
): void {
  assertSafeDurablePluginRoot(root);
  const offending = firstUnacceptableComponent({
    root,
    path: join(root, ...safePath.split('/')),
    accept: ['directory', 'file'],
  });

  if (offending !== undefined) {
    throw new TypeError(
      offending.kind === 'link'
        ? 'Plugin fileStore paths cannot contain symlinks.'
        : 'Plugin fileStore contains an unsupported entry.',
    );
  }
}

export function assertRegularFile(path: string, label: string): void {
  const entry = describeRealEntry(path);

  if (entry.kind === 'absent' || entry.kind === 'unreadable') {
    // `readOptionalRegularFile` reads "not there yet" off the error code, so
    // the original has to reach it rather than a message written over it.
    throw entry.error;
  }
  if (entry.kind !== 'file') {
    throw new TypeError(`${label} must be a regular file.`);
  }
}

export function readOptionalRegularFile(path: string): string | undefined {
  try {
    assertRegularFile(path, 'Plugin fileStore path');
    return readTextFileSync(path);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw error;
  }
}

export function readOptionalRegularFileBuffer(
  path: string,
): Buffer | undefined {
  try {
    assertRegularFile(path, 'Plugin fileStore path');
    return readFileBytesSync(path);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw error;
  }
}

export function writeTextAtomic(path: string, content: string): void {
  atomicReplaceFileSync({
    targetPath: path,
    content,
    mode: 0o600,
  });
}

export function hashOptionalFileContent(
  content: string | Buffer | undefined,
): string {
  return content === undefined
    ? createHash('sha256').update('missing\u0000').digest('hex')
    : createPresentFileContentHash(content).digest('hex');
}

function createPresentFileContentHash(content: string | Buffer): Hash {
  return createHash('sha256').update('present\u0000').update(content);
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function readDurableRevision(root: string): number {
  return readPersistedDurableRevision(root) ?? initialDurableRevision(root);
}

export function readPersistedDurableRevision(root: string): number | undefined {
  const revisionPath = join(root, durableRevisionFileName);

  try {
    const parsed = Number(readTextFileSync(revisionPath).trim());

    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }

    throw new TypeError('Plugin file store revision is malformed.');
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw error;
  }
}

export function writeDurableRevision(root: string, revision: number): void {
  writeTextAtomic(join(root, durableRevisionFileName), `${String(revision)}\n`);
}

export function readDurablePathModes(
  root: string,
): Map<string, RuntimePluginFileStorePathMode> {
  return new Map(readCachedDurablePathModes(root));
}

export function readDurablePathMode(
  root: string,
  path: string,
): RuntimePluginFileStorePathMode | undefined {
  return readCachedDurablePathModes(root).get(path);
}

function readCachedDurablePathModes(
  root: string,
): ReadonlyMap<string, RuntimePluginFileStorePathMode> {
  const beforeStamp = durablePathModesFileStamp(root);
  const cached = durablePathModeCache.get(root);

  if (cached?.fileStamp === beforeStamp) {
    touchDurablePathModeCache(root, cached);
    return cached.modes;
  }

  const pathModes = readDurablePathModesFile(root);
  const afterStamp = durablePathModesFileStamp(root);

  if (beforeStamp === afterStamp) {
    cacheDurablePathModes(root, afterStamp, pathModes);
  } else {
    durablePathModeCache.delete(root);
  }

  return pathModes;
}

function readDurablePathModesFile(
  root: string,
): ReadonlyMap<string, RuntimePluginFileStorePathMode> {
  const modesPath = join(root, durablePathModesFileName);

  try {
    const parsed = JSON.parse(readTextFileSync(modesPath)) as unknown;

    if (!isPlainObject(parsed)) {
      throw new TypeError('Plugin file store path modes are malformed.');
    }

    const pathModes = new Map<string, RuntimePluginFileStorePathMode>();

    for (const [path, mode] of Object.entries(parsed)) {
      const safePath = normalizeRuntimePluginFileStorePath(path);

      if (safePath !== path || !isRuntimePluginFileStorePathMode(mode)) {
        throw new TypeError('Plugin file store path modes are malformed.');
      }

      pathModes.set(safePath, mode);
    }

    return pathModes;
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return new Map<string, RuntimePluginFileStorePathMode>();
    }

    throw error;
  }
}

export function writeDurablePathModes(
  root: string,
  pathModes: ReadonlyMap<string, RuntimePluginFileStorePathMode>,
): void {
  const sortedPathModes = [...pathModes].sort(([left], [right]) =>
    left.localeCompare(right),
  );

  writeTextAtomic(
    join(root, durablePathModesFileName),
    `${JSON.stringify(Object.fromEntries(sortedPathModes))}\n`,
  );
  cacheDurablePathModes(
    root,
    durablePathModesFileStamp(root),
    new Map(pathModes),
  );
}

function durablePathModesFileStamp(root: string): string {
  try {
    const stat = lstatPathSync(join(root, durablePathModesFileName));

    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(
      ':',
    );
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return 'missing';
    }

    throw error;
  }
}

function cacheDurablePathModes(
  root: string,
  fileStamp: string,
  modes: ReadonlyMap<string, RuntimePluginFileStorePathMode>,
): void {
  const entry = Object.freeze({
    fileStamp,
    modes: new Map(modes),
  });

  touchDurablePathModeCache(root, entry);

  while (durablePathModeCache.size > durablePathModeCacheMaxRoots) {
    const oldestRoot = durablePathModeCache.keys().next().value;

    if (oldestRoot === undefined) {
      break;
    }

    durablePathModeCache.delete(oldestRoot);
  }
}

function touchDurablePathModeCache(
  root: string,
  entry: {
    readonly fileStamp: string;
    readonly modes: ReadonlyMap<string, RuntimePluginFileStorePathMode>;
  },
): void {
  durablePathModeCache.delete(root);
  durablePathModeCache.set(root, entry);
}

function initialDurableRevision(root: string): number {
  try {
    cleanupDurablePluginStoreAtomicTempFiles(root);
    return countDurableStoreEntries(root);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return 0;
    }

    throw error;
  }
}

export function cleanupDurablePluginStoreAtomicTempFiles(
  directory: string,
): void {
  let entries: Dirent[];

  try {
    entries = listDirectoryEntriesSync(directory);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return;
    }

    throw error;
  }

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      cleanupDurablePluginStoreAtomicTempFiles(entryPath);
      continue;
    }

    if (entry.isFile() && isAbandonedAtomicReplacementFile(entry.name)) {
      removePathSync(entryPath, {force: true});
    }
  }
}

function countDurableStoreEntries(directory: string): number {
  let count = 0;

  for (const entry of listDirectoryEntriesSync(directory)) {
    if (
      entry.name === durableRevisionFileName ||
      entry.name === durablePathModesFileName ||
      entry.name === durableDirectMutationJournalFileName
    ) {
      continue;
    }

    const entryPath = join(directory, entry.name);

    if (parseAtomicReplacementFileName(entry.name) !== undefined) {
      continue;
    }

    if (entry.isDirectory()) {
      count += countDurableStoreEntries(entryPath);
      continue;
    }

    if (!entry.isFile()) {
      throw new TypeError('Plugin file store contains an unsupported entry.');
    }

    if (entry.name.endsWith('.jsonl')) {
      count += readTextFileSync(entryPath).match(/\n/gu)?.length ?? 0;
      continue;
    }

    count += 1;
  }

  return count;
}

export function assertDurableOperationPathMode(options: {
  readonly filePath: string;
  readonly mode: RuntimePluginFileStorePathMode | undefined;
  readonly operation: Pick<DurablePluginFileStoreOperation, 'kind' | 'path'>;
}): void {
  if (options.operation.kind === 'write_json') {
    assertDurableJsonPathMode({
      filePath: options.filePath,
      mode: options.mode,
      path: options.operation.path,
    });
    return;
  }

  assertDurableJsonlPathMode({
    filePath: options.filePath,
    mode: options.mode,
    path: options.operation.path,
  });
}

export function durableOperationAfterContent(options: {
  readonly beforeContent: string | undefined;
  readonly operation: Pick<DurablePluginFileStoreOperation, 'kind' | 'value'>;
}): string {
  const line = `${JSON.stringify(options.operation.value)}\n`;

  return options.operation.kind === 'write_json'
    ? line
    : `${options.beforeContent ?? ''}${line}`;
}

function assertDurableJsonlPathMode(options: {
  readonly filePath: string;
  readonly mode: RuntimePluginFileStorePathMode | undefined;
  readonly path: string;
}): void {
  assertJsonlPathMode(options.mode);

  if (options.mode !== undefined) {
    return;
  }

  if (options.path.endsWith('.jsonl')) {
    try {
      const records = parseRuntimePluginJsonlContent(
        readTextFileSync(options.filePath),
      );

      // Reading nothing means every line was unparseable, which is what a
      // JSON document spread over several lines looks like to a JSONL
      // reader — so let the whole-file check below have the last word. A
      // lone array is the other ambiguous shape: one JSONL record and a
      // JSON document at once.
      if (
        records.length > 0 &&
        (records.length !== 1 || !Array.isArray(records[0]))
      ) {
        return;
      }
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return;
      }

      // Unreadable as JSONL is the answer this check wants, not a
      // failure: a JSON document spread over several lines is exactly
      // what it is trying to recognize. The whole-file parse below
      // decides.
      if (
        !(error instanceof SyntaxError) &&
        !(error instanceof MalformedJsonLineError)
      ) {
        throw error;
      }
    }
  }

  try {
    JSON.parse(readTextFileSync(options.filePath));
  } catch (error: unknown) {
    if (isMissingFileError(error) || error instanceof SyntaxError) {
      return;
    }

    throw error;
  }

  throw new TypeError('Plugin JSONL path already stores JSON.');
}

function assertDurableJsonPathMode(options: {
  readonly filePath: string;
  readonly mode: RuntimePluginFileStorePathMode | undefined;
  readonly path: string;
}): void {
  assertJsonPathMode(options.mode);

  if (options.mode !== undefined || !options.path.endsWith('.jsonl')) {
    return;
  }

  try {
    lstatPathSync(options.filePath);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return;
    }

    throw error;
  }

  throw new TypeError('Plugin JSON path already stores JSONL.');
}
