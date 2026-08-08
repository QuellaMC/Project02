import type {
  RuntimePluginFileStorePathMode,
  RuntimePluginJsonValue,
} from '../../../plugins/api/index.ts';

/** Engine-internal shapes; not the plugin-facing capability contract. */
export type InMemoryPluginStoreState = {
  readonly files: Map<string, RuntimePluginJsonValue>;
  readonly pathModes: Map<string, RuntimePluginFileStorePathMode>;
  revision: number;
};
