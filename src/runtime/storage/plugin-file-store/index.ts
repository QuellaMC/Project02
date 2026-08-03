/**
 * Public surface of the plugin file-store engine (durable + in-memory
 * backends). A tool's write is durable when the call returns, so there is
 * one write path and no staging layer. The plugin-facing capability
 * contract lives in src/plugins/api/file-store-contract.ts; hosts receive
 * these factories via the RuntimePluginFileStoreProvider option instead of
 * importing them.
 */
export {createRuntimePluginFileStore} from './base-store.ts';
export {
  freezeRuntimePluginFileStoreJsonValue,
  normalizeRuntimePluginFileStorePath,
} from './shared.ts';
export type {
  CreateRuntimePluginFileStoreOptions,
  RuntimePluginFileStoreProvider,
} from '../../../plugins/index.ts';
