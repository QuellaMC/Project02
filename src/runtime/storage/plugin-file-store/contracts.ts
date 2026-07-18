import type {
  CreateRuntimePluginFileStoreOptions,
  RuntimePluginFileStorePathMode,
  RuntimePluginJsonValue,
} from '../../../plugins/index.ts';

/**
 * Engine-internal shapes of the plugin file-store. The plugin-facing
 * capability contract (store, transaction, provider) stays in
 * src/plugins/file-store/contracts.ts; these types describe how this engine
 * stages and tracks state and are not part of that contract.
 */
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
