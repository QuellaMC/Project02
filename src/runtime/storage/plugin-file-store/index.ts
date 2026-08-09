/**
 * A tool's write is durable when the call returns, so there is one write
 * path and no staging layer.
 */
export {createRuntimePluginFileStore} from './base-store.ts';
export {
  freezeRuntimePluginFileStoreJsonValue,
  normalizeRuntimePluginFileStorePath,
} from './shared.ts';
export type {
  CreateRuntimePluginFileStoreOptions,
  RuntimePluginFileStoreProvider,
} from '../../../plugins/api/index.ts';
