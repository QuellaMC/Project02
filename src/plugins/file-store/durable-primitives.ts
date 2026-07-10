import { createHash, randomUUID, type Hash } from 'node:crypto';
import {
  appendFileSync,
  type Dirent,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';

import { createLocalRuntimePluginPaths } from '../../runtime/storage/layout.ts';
import type { RuntimePluginJsonValue } from '../types.ts';
import type { RuntimePluginFileStorePathMode } from './contracts.ts';
import {
  assertJsonlPathMode,
  assertJsonPathMode,
  durablePathModesFileName,
  durableRevisionFileName,
  isMissingFileError,
  isPlainObject,
  isRuntimePluginFileStorePathMode,
  normalizeRuntimePluginFileStorePath,
  parseRuntimePluginJsonlContent
} from './shared.ts';

const durablePluginStoreMutationRoots = new Set<string>();

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

export function applyDurablePluginFileStoreOperation(options: {
  readonly root: string;
  readonly kind: 'append_jsonl' | 'write_json';
  readonly path: string;
  readonly value: RuntimePluginJsonValue;
}): void {
  withDurablePluginStoreMutation(options.root, () => {
    assertSafeDurablePluginPath(options.root, options.path);
    const filePath = join(options.root, options.path);
    const pathModes = readDurablePathModes(options.root);

    assertDurableOperationPathMode({
      filePath,
      mode: pathModes.get(options.path),
      operation: options
    });

    const beforeRevision = readDurableRevision(options.root);

    if (options.kind === 'write_json') {
      writeTextAtomic(
        filePath,
        durableOperationAfterContent({
          beforeContent: readOptionalRegularFile(filePath),
          operation: options
        })
      );
    } else {
      mkdirSync(dirname(filePath), { recursive: true });
      appendFileSync(filePath, `${JSON.stringify(options.value)}\n`, 'utf8');
    }

    pathModes.set(options.path, options.kind === 'write_json' ? 'json' : 'jsonl');
    writeDurablePathModes(options.root, pathModes);
    writeDurableRevision(options.root, beforeRevision + 1);
  });
}

export function withDurablePluginStoreMutation<T>(
  root: string,
  operation: () => T
): T {
  if (durablePluginStoreMutationRoots.has(root)) {
    throw new Error('Plugin fileStore mutation is already active for this root.');
  }

  durablePluginStoreMutationRoots.add(root);

  try {
    return operation();
  } finally {
    durablePluginStoreMutationRoots.delete(root);
  }
}

export function canonicalDurablePluginStoreRoot(storeRoot: string): string {
  let current = resolve(storeRoot);
  const missingParts: string[] = [];

  for (;;) {
    try {
      const canonical = join(realpathSync(current), ...missingParts);

      assertSafeDurableDirectoryPath(canonical, 'Plugin fileStore store root');
      return canonical;
    } catch (error: unknown) {
      if (!isMissingFileError(error)) {
        throw error;
      }

      const parent = dirname(current);

      if (parent === current) {
        throw error;
      }

      missingParts.unshift(basename(current));
      current = parent;
    }
  }
}

function assertSafeDurableDirectoryPath(path: string, label: string): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;

  for (const part of parts) {
    current = join(current, part);

    try {
      const stat = lstatSync(current);

      if (stat.isSymbolicLink()) {
        throw new TypeError(
          `${label} must be a real directory and cannot contain symlinks.`
        );
      }

      if (!stat.isDirectory()) {
        throw new TypeError(`${label} must be a real directory.`);
      }
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return;
      }

      throw error;
    }
  }
}

export function assertSafeDurableTransactionJournalDirectory(
  path: string
): void {
  assertSafeDurableDirectoryPath(
    path,
    'Plugin fileStore transaction journal root'
  );
}

export function assertSafeDurablePluginRoot(root: string): void {
  assertSafeDurableDirectoryPath(root, 'Plugin fileStore root');
}

export function assertSafeDurablePluginPath(
  root: string,
  safePath: string
): void {
  assertSafeDurablePluginRoot(root);
  let current = root;

  for (const part of safePath.split('/')) {
    current = join(current, part);

    try {
      const stat = lstatSync(current);

      if (stat.isSymbolicLink()) {
        throw new TypeError('Plugin fileStore paths cannot contain symlinks.');
      }

      if (!stat.isDirectory() && !stat.isFile()) {
        throw new TypeError('Plugin fileStore contains an unsupported entry.');
      }
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return;
      }

      throw error;
    }
  }
}

export function assertRegularFile(path: string, label: string): void {
  const stat = lstatSync(path);

  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new TypeError(`${label} must be a regular file.`);
  }
}

export function readOptionalRegularFile(path: string): string | undefined {
  try {
    assertRegularFile(path, 'Plugin fileStore path');
    return readFileSync(path, 'utf8');
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw error;
  }
}

export function readOptionalRegularFileBuffer(path: string): Buffer | undefined {
  try {
    assertRegularFile(path, 'Plugin fileStore path');
    return readFileSync(path);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw error;
  }
}

export function writeTextAtomic(path: string, content: string): void {
  const tmpPath = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;

  mkdirSync(dirname(path), { recursive: true });

  try {
    writeFileSync(tmpPath, content, 'utf8');
    renameSync(tmpPath, path);
  } catch (error: unknown) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

export function hashOptionalFileContent(
  content: string | Buffer | undefined
): string {
  return content === undefined
    ? createHash('sha256').update('missing\u0000').digest('hex')
    : createPresentFileContentHash(content).digest('hex');
}

export function createPresentFileContentHash(content: string | Buffer): Hash {
  return createHash('sha256').update('present\u0000').update(content);
}

export function requiredJournalOperationString(
  value: string | undefined
): string {
  if (value === undefined) {
    throw new TypeError('Plugin fileStore transaction operation is not planned.');
  }

  return value;
}

export function requiredJournalOperationRevision(
  value: number | undefined
): number {
  if (!isNonNegativeSafeInteger(value)) {
    throw new TypeError('Plugin fileStore transaction operation is not planned.');
  }

  return value;
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0;
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ESRCH'
    ) {
      return false;
    }

    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EPERM'
    ) {
      return true;
    }

    throw error;
  }
}

export function durableTransactionTempFileOwnerPid(
  name: string
): number | undefined {
  const match = /\.json\.(\d+)\.[^.]+\.tmp$/u.exec(name);
  const parsed = match?.[1] === undefined ? Number.NaN : Number(match[1]);

  return isPositiveSafeInteger(parsed) ? parsed : undefined;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function readDurableRevision(root: string): number {
  return readPersistedDurableRevision(root) ?? initialDurableRevision(root);
}

export function readPersistedDurableRevision(
  root: string
): number | undefined {
  const revisionPath = join(root, durableRevisionFileName);

  try {
    const parsed = Number(readFileSync(revisionPath, 'utf8').trim());

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
  writeTextAtomic(
    join(root, durableRevisionFileName),
    `${String(revision)}\n`
  );
}

export function readDurablePathModes(
  root: string
): Map<string, RuntimePluginFileStorePathMode> {
  const modesPath = join(root, durablePathModesFileName);

  try {
    const parsed = JSON.parse(readFileSync(modesPath, 'utf8')) as unknown;

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
  pathModes: ReadonlyMap<string, RuntimePluginFileStorePathMode>
): void {
  const sortedPathModes = [...pathModes].sort(([left], [right]) =>
    left.localeCompare(right)
  );

  writeTextAtomic(
    join(root, durablePathModesFileName),
    `${JSON.stringify(Object.fromEntries(sortedPathModes))}\n`
  );
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
  directory: string
): void {
  let entries: Dirent[];

  try {
    entries = readdirSync(directory, { withFileTypes: true });
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

    const ownerPid = durableAtomicTempFileOwnerPid(entry.name);

    if (entry.isFile() && ownerPid !== undefined && !processIsAlive(ownerPid)) {
      rmSync(entryPath, { force: true });
    }
  }
}

function durableAtomicTempFileOwnerPid(name: string): number | undefined {
  const match = /\.(\d+)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/iu.exec(
    name
  );
  const parsed = match?.[1] === undefined ? Number.NaN : Number(match[1]);

  return isPositiveSafeInteger(parsed) ? parsed : undefined;
}

function countDurableStoreEntries(directory: string): number {
  let count = 0;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.name === durableRevisionFileName ||
      entry.name === durablePathModesFileName
    ) {
      continue;
    }

    const entryPath = join(directory, entry.name);

    if (durableAtomicTempFileOwnerPid(entry.name) !== undefined) {
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
      count += readFileSync(entryPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0).length;
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
      path: options.operation.path
    });
    return;
  }

  assertDurableJsonlPathMode({
    filePath: options.filePath,
    mode: options.mode,
    path: options.operation.path
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
        readFileSync(options.filePath, 'utf8')
      );

      if (records.length !== 1 || !Array.isArray(records[0])) {
        return;
      }
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return;
      }

      if (!(error instanceof SyntaxError)) {
        throw error;
      }
    }
  }

  try {
    JSON.parse(readFileSync(options.filePath, 'utf8'));
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
    lstatSync(options.filePath);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return;
    }

    throw error;
  }

  throw new TypeError('Plugin JSON path already stores JSONL.');
}
