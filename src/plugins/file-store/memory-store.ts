import type { RuntimePluginFileStore } from '../types.ts';
import type {
  CreateRuntimePluginFileStoreOptions,
  InMemoryPluginStoreState,
  StagedPluginFileStoreOperation
} from './contracts.ts';
import {
  assertJsonlPathMode,
  assertJsonPathMode,
  freezeRuntimePluginFileStoreJsonValue,
  isJsonArray,
  normalizeRuntimePluginFileStorePath
} from './shared.ts';

const inMemoryPluginStoresByKey = new Map<string, InMemoryPluginStoreState>();
const inMemoryPluginStoresBySessionIdentity = new WeakMap<
  object,
  Map<string, InMemoryPluginStoreState>
>();

export function createInMemoryRuntimePluginFileStore(
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

export function inMemoryPluginStoreState(
  options: CreateRuntimePluginFileStoreOptions
): InMemoryPluginStoreState {
  const key = `${options.sessionId}\u0000${options.pluginId}`;

  if (options.sessionIdentity !== undefined) {
    let stores = inMemoryPluginStoresBySessionIdentity.get(
      options.sessionIdentity
    );

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
      files: new Map(),
      pathModes: new Map(),
      revision: 0
    };
    stores.set(key, state);
  }

  return state;
}

export function inMemoryPluginFileStoreContent(
  state: InMemoryPluginStoreState,
  path: string
): string | undefined {
  const value = state.files.get(path);

  if (value === undefined) {
    return undefined;
  }

  if (state.pathModes.get(path) === 'jsonl') {
    if (!isJsonArray(value)) {
      throw new TypeError('Plugin JSONL path already stores non-array JSON.');
    }

    return value.map((line) => `${JSON.stringify(line)}\n`).join('');
  }

  return `${JSON.stringify(value)}\n`;
}

export function applyInMemoryPluginFileStoreOperation(
  state: InMemoryPluginStoreState,
  operation: Pick<StagedPluginFileStoreOperation, 'kind' | 'path' | 'value'>
): void {
  if (operation.kind === 'write_json') {
    assertJsonPathMode(state.pathModes.get(operation.path));
    state.files.set(operation.path, operation.value);
    state.pathModes.set(operation.path, 'json');
    state.revision += 1;
    return;
  }

  assertJsonlPathMode(state.pathModes.get(operation.path));
  const current = state.files.get(operation.path);

  if (current === undefined) {
    state.files.set(operation.path, Object.freeze([operation.value]));
  } else if (isJsonArray(current)) {
    state.files.set(
      operation.path,
      Object.freeze([...current, operation.value])
    );
  } else {
    throw new TypeError('Plugin JSONL path already stores non-array JSON.');
  }

  state.pathModes.set(operation.path, 'jsonl');
  state.revision += 1;
}
