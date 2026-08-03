import type {RuntimePluginFileStore} from './types.ts';

type RuntimePluginFileStoreIdentity = {
  readonly sessionId: string;
  readonly pluginId: string;
};

export type DurableRuntimePluginFileStoreOptions =
  RuntimePluginFileStoreIdentity & {
    readonly storeRoot: string;
    readonly sessionIdentity?: object;
  };

export type InMemoryRuntimePluginFileStoreOptions =
  RuntimePluginFileStoreIdentity & {
    readonly storeRoot?: undefined;
    readonly sessionIdentity: object;
  };

export type CreateRuntimePluginFileStoreOptions =
  DurableRuntimePluginFileStoreOptions | InMemoryRuntimePluginFileStoreOptions;

export type RuntimePluginFileStorePathMode = 'json' | 'jsonl';

/**
 * Host capability for creating plugin file stores and their transactions.
 * The composition root injects the concrete engine
 * (src/runtime/storage/plugin-file-store/) so the host never imports it.
 */
export type RuntimePluginFileStoreProvider = {
  readonly createFileStore: (
    options: CreateRuntimePluginFileStoreOptions,
  ) => RuntimePluginFileStore;
};
