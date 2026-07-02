import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, sep } from 'node:path';

import {
  createLocalRuntimePluginPaths
} from '../runtime/storage/layout.ts';
import type { RuntimePluginJsonValue } from './types.ts';
import type { RuntimePluginFileStore } from './types.ts';

export type CreateRuntimePluginFileStoreOptions = {
  readonly storeRoot?: string;
  readonly sessionId: string;
  readonly sessionIdentity?: object;
  readonly pluginId: string;
};

const durableRevisionFileName = '.project02-plugin-store-revision';
const durablePathModesFileName = '.project02-plugin-store-modes.json';
const inMemoryPluginStoresByKey = new Map<string, InMemoryPluginStoreState>();
const inMemoryPluginStoresBySessionIdentity = new WeakMap<
  object,
  Map<string, InMemoryPluginStoreState>
>();

type InMemoryPluginStoreState = {
  readonly files: Map<string, RuntimePluginJsonValue>;
  readonly pathModes: Map<string, RuntimePluginFileStorePathMode>;
  revision: number;
};

type RuntimePluginFileStorePathMode = 'json' | 'jsonl';

export function createRuntimePluginFileStore(
  options: CreateRuntimePluginFileStoreOptions
): RuntimePluginFileStore {
  if (options.storeRoot === undefined) {
    return createInMemoryRuntimePluginFileStore(options);
  }

  const root = createLocalRuntimePluginPaths({
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    pluginId: options.pluginId
  }).pluginRoot;
  let revision = readDurableRevision(root);
  const pathModes = readDurablePathModes(root);

  return Object.freeze({
    readJson(path) {
      const safePath = normalizeRuntimePluginFileStorePath(path);
      const filePath = join(root, safePath);

      assertDurableJsonPathMode({
        filePath,
        mode: durablePathModeForPath(root, pathModes, safePath),
        path: safePath
      });

      try {
        return freezeRuntimePluginFileStoreJsonValue(
          JSON.parse(readFileSync(filePath, 'utf8')) as unknown
        );
      } catch (error: unknown) {
        if (isMissingFileError(error)) {
          return undefined;
        }

        throw error;
      }
    },
    readJsonl(path) {
      const safePath = normalizeRuntimePluginFileStorePath(path);
      const filePath = join(root, safePath);

      assertDurableJsonlPathMode({
        filePath,
        mode: durablePathModeForPath(root, pathModes, safePath),
        path: safePath
      });

      try {
        return parseRuntimePluginJsonlContent(readFileSync(filePath, 'utf8'));
      } catch (error: unknown) {
        if (isMissingFileError(error)) {
          return Object.freeze([]);
        }

        throw error;
      }
    },
    writeJsonAtomic(path, value) {
      const safePath = normalizeRuntimePluginFileStorePath(path);
      const filePath = join(root, safePath);
      const tmpPath = `${filePath}.${String(process.pid)}.${String(Date.now())}.tmp`;

      assertDurableJsonPathMode({
        filePath,
        mode: durablePathModeForPath(root, pathModes, safePath),
        path: safePath
      });

      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(
        tmpPath,
        `${JSON.stringify(freezeRuntimePluginFileStoreJsonValue(value))}\n`,
        'utf8'
      );
      renameSync(tmpPath, filePath);
      pathModes.set(safePath, 'json');
      writeDurablePathModes(root, pathModes);
      revision += 1;
      writeDurableRevision(root, revision);
    },
    appendJsonl(path, value) {
      const safePath = normalizeRuntimePluginFileStorePath(path);
      const filePath = join(root, safePath);
      const nextLine = freezeRuntimePluginFileStoreJsonValue(value);

      assertDurableJsonlPathMode({
        filePath,
        mode: durablePathModeForPath(root, pathModes, safePath),
        path: safePath
      });

      mkdirSync(dirname(filePath), { recursive: true });
      appendFileSync(
        filePath,
        `${JSON.stringify(nextLine)}\n`,
        'utf8'
      );
      pathModes.set(safePath, 'jsonl');
      writeDurablePathModes(root, pathModes);
      revision += 1;
      writeDurableRevision(root, revision);
    },
    revision() {
      return revision;
    }
  } satisfies RuntimePluginFileStore);
}

function createInMemoryRuntimePluginFileStore(
  options: CreateRuntimePluginFileStoreOptions
): RuntimePluginFileStore {
  const state = inMemoryPluginStoreState(options);

  return Object.freeze({
    readJson(path) {
      const safePath = normalizeRuntimePluginFileStorePath(path);
      const value = state.files.get(safePath);

      assertJsonPathMode(state.pathModes.get(safePath));

      return value === undefined
        ? undefined
        : freezeRuntimePluginFileStoreJsonValue(value);
    },
    readJsonl(path) {
      const safePath = normalizeRuntimePluginFileStorePath(path);
      const value = state.files.get(safePath);

      assertJsonlPathMode(state.pathModes.get(safePath));

      if (value === undefined) {
        return Object.freeze([]);
      }

      if (!isJsonArray(value)) {
        throw new TypeError('Plugin JSONL path already stores non-array JSON.');
      }

      return Object.freeze(value.map(freezeRuntimePluginFileStoreJsonValue));
    },
    writeJsonAtomic(path, value) {
      const safePath = normalizeRuntimePluginFileStorePath(path);

      assertJsonPathMode(state.pathModes.get(safePath));

      state.files.set(safePath, freezeRuntimePluginFileStoreJsonValue(value));
      state.pathModes.set(safePath, 'json');
      state.revision += 1;
    },
    appendJsonl(path, value) {
      const safePath = normalizeRuntimePluginFileStorePath(path);
      const current = state.files.get(safePath);
      const nextLine = freezeRuntimePluginFileStoreJsonValue(value);

      assertJsonlPathMode(state.pathModes.get(safePath));

      if (current === undefined) {
        state.files.set(safePath, Object.freeze([nextLine]));
      } else if (isJsonArray(current)) {
        state.files.set(safePath, Object.freeze([...current, nextLine]));
      } else {
        throw new TypeError('Plugin JSONL path already stores non-array JSON.');
      }

      state.pathModes.set(safePath, 'jsonl');
      state.revision += 1;
    },
    revision() {
      return state.revision;
    }
  } satisfies RuntimePluginFileStore);
}

export function normalizeRuntimePluginFileStorePath(path: string): string {
  const normalized = path.trim();

  if (
    normalized.length === 0 ||
    normalized === durableRevisionFileName ||
    normalized === durablePathModesFileName ||
    normalized.startsWith('/') ||
    normalized.includes('\\') ||
    normalized.split('/').some((part) => part.length === 0 || part === '.' || part === '..') ||
    normalized.split('/').some((part) => part.includes(sep) && sep !== '/')
  ) {
    throw new TypeError('Plugin file path must be a safe relative path.');
  }

  return normalized;
}

function inMemoryPluginStoreState(
  options: CreateRuntimePluginFileStoreOptions
): InMemoryPluginStoreState {
  const key = `${options.sessionId}\u0000${options.pluginId}`;

  if (options.sessionIdentity !== undefined) {
    let stores = inMemoryPluginStoresBySessionIdentity.get(options.sessionIdentity);

    if (stores === undefined) {
      stores = new Map<string, InMemoryPluginStoreState>();
      inMemoryPluginStoresBySessionIdentity.set(options.sessionIdentity, stores);
    }

    return pluginStoreStateForKey(stores, key);
  }

  return pluginStoreStateForKey(inMemoryPluginStoresByKey, key);
}

function pluginStoreStateForKey(
  stores: Map<string, InMemoryPluginStoreState>,
  key: string
): InMemoryPluginStoreState {
  let state = stores.get(key);

  if (state === undefined) {
    state = {
      files: new Map<string, RuntimePluginJsonValue>(),
      pathModes: new Map<string, RuntimePluginFileStorePathMode>(),
      revision: 0
    };
    stores.set(key, state);
  }

  return state;
}

function readDurableRevision(root: string): number {
  const revisionPath = join(root, durableRevisionFileName);

  try {
    const parsed = Number(readFileSync(revisionPath, 'utf8').trim());

    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }

    throw new TypeError('Plugin file store revision is malformed.');
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return initialDurableRevision(root);
    }

    throw error;
  }
}

function writeDurableRevision(root: string, revision: number): void {
  const revisionPath = join(root, durableRevisionFileName);
  const tmpPath = `${revisionPath}.${String(process.pid)}.${String(Date.now())}.tmp`;

  mkdirSync(root, { recursive: true });
  writeFileSync(tmpPath, `${String(revision)}\n`, 'utf8');
  renameSync(tmpPath, revisionPath);
}

function readDurablePathModes(
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

function writeDurablePathModes(
  root: string,
  pathModes: ReadonlyMap<string, RuntimePluginFileStorePathMode>
): void {
  const modesPath = join(root, durablePathModesFileName);
  const tmpPath = `${modesPath}.${String(process.pid)}.${String(Date.now())}.tmp`;
  const sortedPathModes = [...pathModes].sort(([left], [right]) =>
    left.localeCompare(right)
  );

  mkdirSync(root, { recursive: true });
  writeFileSync(
    tmpPath,
    `${JSON.stringify(Object.fromEntries(sortedPathModes))}\n`,
    'utf8'
  );
  renameSync(tmpPath, modesPath);
}

function durablePathModeForPath(
  root: string,
  pathModes: Map<string, RuntimePluginFileStorePathMode>,
  path: string
): RuntimePluginFileStorePathMode | undefined {
  const cachedMode = pathModes.get(path);

  if (cachedMode !== undefined) {
    return cachedMode;
  }

  const persistedMode = readDurablePathModes(root).get(path);

  if (persistedMode !== undefined) {
    pathModes.set(path, persistedMode);
  }

  return persistedMode;
}

function initialDurableRevision(root: string): number {
  try {
    return countDurableStoreEntries(root);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return 0;
    }

    throw error;
  }
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

    if (entry.isDirectory()) {
      count += countDurableStoreEntries(entryPath);
      continue;
    }

    if (!entry.isFile()) {
      continue;
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
    statSync(options.filePath);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return;
    }

    throw error;
  }

  throw new TypeError('Plugin JSON path already stores JSONL.');
}

function assertJsonlPathMode(
  mode: RuntimePluginFileStorePathMode | undefined
): void {
  if (mode === 'json') {
    throw new TypeError('Plugin JSONL path already stores non-array JSON.');
  }
}

function assertJsonPathMode(
  mode: RuntimePluginFileStorePathMode | undefined
): void {
  if (mode === 'jsonl') {
    throw new TypeError('Plugin JSON path already stores JSONL.');
  }
}

function isRuntimePluginFileStorePathMode(
  value: unknown
): value is RuntimePluginFileStorePathMode {
  return value === 'json' || value === 'jsonl';
}

function parseRuntimePluginJsonlContent(
  content: string
): readonly RuntimePluginJsonValue[] {
  return Object.freeze(
    content
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) =>
        freezeRuntimePluginFileStoreJsonValue(JSON.parse(line) as unknown)
      )
  );
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

export function freezeRuntimePluginFileStoreJsonValue(
  value: unknown
): RuntimePluginJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Plugin file value must be finite JSON.');
    }

    return value;
  }

  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeRuntimePluginFileStoreJsonValue));
  }

  if (typeof value === 'object') {
    const frozenEntries: Array<readonly [string, RuntimePluginJsonValue]> = [];

    for (const [key, item] of Object.entries(value)) {
      frozenEntries.push([key, freezeRuntimePluginFileStoreJsonValue(item)]);
    }

    return Object.freeze(Object.fromEntries(frozenEntries));
  }

  throw new TypeError('Plugin file value must be JSON serializable.');
}

function isJsonArray(
  value: RuntimePluginJsonValue
): value is readonly RuntimePluginJsonValue[] {
  return Array.isArray(value);
}
