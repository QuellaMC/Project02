import type {
  CreateRuntimePluginFileStoreOptions,
  RuntimePluginFileStorePathMode,
  RuntimePluginJsonValue,
} from '../../../plugins/index.ts';

/** Engine-internal shapes; not the plugin-facing capability contract. */
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
