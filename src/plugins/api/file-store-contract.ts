import type { RuntimeEventIdentity } from '../../core/index.ts';
import type { RuntimePluginFileStore } from './types.ts';

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
  | DurableRuntimePluginFileStoreOptions
  | InMemoryRuntimePluginFileStoreOptions;

export type RuntimePluginFileStoreTransaction = {
  fileStoreFor(
    options: CreateRuntimePluginFileStoreOptions
  ): RuntimePluginFileStore;
  prepare(
    identity: RuntimeEventIdentity
  ): Promise<RuntimePluginFileStorePreparedTransaction>;
  rollback(): void;
  hasPendingWrites(): boolean;
};

export type RuntimePluginFileStorePreparedTransaction = {
  discard(): Promise<void>;
  finalize(): Promise<void>;
};

export type RuntimePluginFileStorePathMode = 'json' | 'jsonl';

/**
 * Host capability for creating plugin file stores and their transactions.
 * The composition root injects the concrete engine
 * (src/runtime/storage/plugin-file-store/) so the host never imports it.
 */
export type RuntimePluginFileStoreProvider = {
  readonly createFileStore: (
    options: CreateRuntimePluginFileStoreOptions
  ) => RuntimePluginFileStore;
  readonly createFileStoreTransaction: () => RuntimePluginFileStoreTransaction;
};
