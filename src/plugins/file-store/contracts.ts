import type { RuntimeEventIdentity } from '../../runtime/event.ts';
import type {
  RuntimePluginFileStore,
  RuntimePluginJsonValue
} from '../types.ts';

export type CreateRuntimePluginFileStoreOptions = {
  readonly storeRoot?: string;
  readonly sessionId: string;
  readonly sessionIdentity?: object;
  readonly pluginId: string;
};

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
