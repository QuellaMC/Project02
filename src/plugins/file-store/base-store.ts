import type { RuntimePluginFileStore } from '../types.ts';
import type {
  CreateRuntimePluginFileStoreOptions,
  InMemoryRuntimePluginFileStoreOptions
} from './contracts.ts';
import { createDurableRuntimePluginFileStore } from './durable-store.ts';
import { createInMemoryRuntimePluginFileStore } from './memory-store.ts';

export function createRuntimePluginFileStore(
  options: CreateRuntimePluginFileStoreOptions
): RuntimePluginFileStore {
  if (options.storeRoot === undefined) {
    const sessionIdentity = requiredInMemorySessionIdentity(options);

    return createInMemoryRuntimePluginFileStore(
      Object.freeze({
        sessionId: options.sessionId,
        sessionIdentity,
        pluginId: options.pluginId
      } satisfies InMemoryRuntimePluginFileStoreOptions)
    );
  }

  return createDurableRuntimePluginFileStore({
    ...options,
    storeRoot: options.storeRoot
  });
}

function requiredInMemorySessionIdentity(options: object): object {
  const sessionIdentity: unknown = Reflect.get(options, 'sessionIdentity');

  if (
    sessionIdentity === null ||
    (typeof sessionIdentity !== 'object' &&
      typeof sessionIdentity !== 'function')
  ) {
    throw new TypeError(
      'In-memory plugin fileStore requires sessionIdentity.'
    );
  }

  return sessionIdentity;
}
