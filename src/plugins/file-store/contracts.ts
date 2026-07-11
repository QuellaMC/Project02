import type { RuntimeEventIdentity } from '../../runtime/event.ts';
import type {
  RuntimePluginFileStore,
  RuntimePluginJsonValue
} from '../types.ts';

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
  ): RuntimePluginFileStorePreparedTransaction;
  rollback(): void;
  hasPendingWrites(): boolean;
};

export type RuntimePluginFileStorePreparedTransaction = {
  discard(): void;
  finalize(): void;
};

export type RuntimePluginFileStorePathMode = 'json' | 'jsonl';

export type InMemoryPluginStoreState = {
  readonly files: Map<string, RuntimePluginJsonValue>;
  readonly pathModes: Map<string, RuntimePluginFileStorePathMode>;
  revision: number;
};

export type StagedPluginFileStoreOperation = {
  readonly storeKey: string;
  readonly options: CreateRuntimePluginFileStoreOptions;
  readonly pluginId: string;
  readonly path: string;
  readonly kind: 'append_jsonl' | 'write_json';
  readonly value: RuntimePluginJsonValue;
  readonly expectedBeforeHash: string;
};
