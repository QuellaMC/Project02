/**
 * Public surface of the plugin file-store engine (durable + in-memory
 * backends, WAL, transactions). The plugin-facing capability contract lives
 * in src/plugins/file-store/contracts.ts; hosts receive these factories via
 * the RuntimePluginFileStoreProvider option instead of importing them.
 */
export {createRuntimePluginFileStore} from './base-store.ts';
export {
  freezeRuntimePluginFileStoreJsonValue,
  normalizeRuntimePluginFileStorePath,
} from './shared.ts';
export {createRuntimePluginFileStoreTransaction} from './transaction.ts';
export type {
  CreateRuntimePluginFileStoreOptions,
  RuntimePluginFileStorePreparedTransaction,
  RuntimePluginFileStoreProvider,
  RuntimePluginFileStoreTransaction,
} from '../../../plugins/index.ts';
