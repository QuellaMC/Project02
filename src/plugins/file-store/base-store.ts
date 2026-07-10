import type { RuntimePluginFileStore } from '../types.ts';
import type { CreateRuntimePluginFileStoreOptions } from './contracts.ts';
import { createDurableRuntimePluginFileStore } from './durable-store.ts';
import { createInMemoryRuntimePluginFileStore } from './memory-store.ts';

export function createRuntimePluginFileStore(
  options: CreateRuntimePluginFileStoreOptions
): RuntimePluginFileStore {
  if (options.storeRoot === undefined) {
    return createInMemoryRuntimePluginFileStore(options);
  }

  return createDurableRuntimePluginFileStore({
    ...options,
    storeRoot: options.storeRoot
  });
}
