import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, sep } from 'node:path';

import type { RuntimePluginJsonValue } from './types.ts';
import type { RuntimePluginFileStore } from './types.ts';

export type CreateRuntimePluginFileStoreOptions = {
  readonly storeRoot?: string;
  readonly sessionId: string;
  readonly sessionIdentity?: object;
  readonly pluginId: string;
};

const durableRevisionFileName = '.project02-plugin-store-revision';
const inMemoryPluginStoresByKey = new Map<string, InMemoryPluginStoreState>();
const inMemoryPluginStoresBySessionIdentity = new WeakMap<
  object,
  Map<string, InMemoryPluginStoreState>
>();

type InMemoryPluginStoreState = {
  readonly files: Map<string, RuntimePluginJsonValue>;
  revision: number;
};

export function createRuntimePluginFileStore(
  options: CreateRuntimePluginFileStoreOptions
): RuntimePluginFileStore {
  if (options.storeRoot === undefined) {
    return createInMemoryRuntimePluginFileStore(options);
  }

  const root = join(
    options.storeRoot,
    'sessions',
    options.sessionId,
    'plugins',
    options.pluginId
  );
  let revision = readDurableRevision(root);

  return Object.freeze({
    readJson(path) {
      const filePath = join(root, safeRelativePath(path));

      try {
        return freezeJsonValue(JSON.parse(readFileSync(filePath, 'utf8')) as unknown);
      } catch (error: unknown) {
        if (isMissingFileError(error)) {
          return undefined;
        }

        throw error;
      }
    },
    readJsonl(path) {
      const filePath = join(root, safeRelativePath(path));

      try {
        return Object.freeze(
          readFileSync(filePath, 'utf8')
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .map((line) => freezeJsonValue(JSON.parse(line) as unknown))
        );
      } catch (error: unknown) {
        if (isMissingFileError(error)) {
          return Object.freeze([]);
        }

        throw error;
      }
    },
    writeJsonAtomic(path, value) {
      const filePath = join(root, safeRelativePath(path));
      const tmpPath = `${filePath}.${String(process.pid)}.${String(Date.now())}.tmp`;

      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(tmpPath, `${JSON.stringify(freezeJsonValue(value))}\n`, 'utf8');
      renameSync(tmpPath, filePath);
      revision += 1;
      writeDurableRevision(root, revision);
    },
    appendJsonl(path, value) {
      const filePath = join(root, safeRelativePath(path));

      mkdirSync(dirname(filePath), { recursive: true });
      appendFileSync(filePath, `${JSON.stringify(freezeJsonValue(value))}\n`, 'utf8');
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
      const value = state.files.get(safeRelativePath(path));

      return value === undefined ? undefined : freezeJsonValue(value);
    },
    readJsonl(path) {
      const value = state.files.get(safeRelativePath(path));

      if (value === undefined) {
        return Object.freeze([]);
      }

      if (!isJsonArray(value)) {
        throw new TypeError('Plugin JSONL path already stores non-array JSON.');
      }

      return Object.freeze(value.map(freezeJsonValue));
    },
    writeJsonAtomic(path, value) {
      state.files.set(safeRelativePath(path), freezeJsonValue(value));
      state.revision += 1;
    },
    appendJsonl(path, value) {
      const safePath = safeRelativePath(path);
      const current = state.files.get(safePath);
      const nextLine = freezeJsonValue(value);

      if (current === undefined) {
        state.files.set(safePath, Object.freeze([nextLine]));
      } else if (isJsonArray(current)) {
        state.files.set(safePath, Object.freeze([...current, nextLine]));
      } else {
        throw new TypeError('Plugin JSONL path already stores non-array JSON.');
      }

      state.revision += 1;
    },
    revision() {
      return state.revision;
    }
  } satisfies RuntimePluginFileStore);
}

function safeRelativePath(path: string): string {
  const normalized = path.trim();

  if (
    normalized.length === 0 ||
    normalized === durableRevisionFileName ||
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
    if (entry.name === durableRevisionFileName) {
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

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function freezeJsonValue(value: unknown): RuntimePluginJsonValue {
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
    return Object.freeze(value.map(freezeJsonValue));
  }

  if (typeof value === 'object') {
    const frozen: Record<string, RuntimePluginJsonValue> = {};

    for (const [key, item] of Object.entries(value)) {
      frozen[key] = freezeJsonValue(item);
    }

    return Object.freeze(frozen);
  }

  throw new TypeError('Plugin file value must be JSON serializable.');
}

function isJsonArray(
  value: RuntimePluginJsonValue
): value is readonly RuntimePluginJsonValue[] {
  return Array.isArray(value);
}
