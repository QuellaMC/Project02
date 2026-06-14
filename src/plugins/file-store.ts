import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, sep } from 'node:path';

import type { RuntimePluginJsonValue } from './types.ts';
import type { RuntimePluginFileStore } from './types.ts';

export type CreateRuntimePluginFileStoreOptions = {
  readonly storeRoot?: string;
  readonly sessionId: string;
  readonly pluginId: string;
};

const inMemoryPluginStores = new Map<string, InMemoryPluginStoreState>();

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
  let revision = 0;

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
    },
    appendJsonl(path, value) {
      const filePath = join(root, safeRelativePath(path));

      mkdirSync(dirname(filePath), { recursive: true });
      appendFileSync(filePath, `${JSON.stringify(freezeJsonValue(value))}\n`, 'utf8');
      revision += 1;
    },
    revision() {
      return revision;
    }
  } satisfies RuntimePluginFileStore);
}

function createInMemoryRuntimePluginFileStore(
  options: CreateRuntimePluginFileStoreOptions
): RuntimePluginFileStore {
  const key = `${options.sessionId}\u0000${options.pluginId}`;
  let state = inMemoryPluginStores.get(key);

  if (state === undefined) {
    state = {
      files: new Map<string, RuntimePluginJsonValue>(),
      revision: 0
    };
    inMemoryPluginStores.set(key, state);
  }

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
    normalized.startsWith('/') ||
    normalized.includes('\\') ||
    normalized.split('/').some((part) => part.length === 0 || part === '.' || part === '..') ||
    normalized.split('/').some((part) => part.includes(sep) && sep !== '/')
  ) {
    throw new TypeError('Plugin file path must be a safe relative path.');
  }

  return normalized;
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
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
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
