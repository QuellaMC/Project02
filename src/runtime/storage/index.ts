/**
 * Public API of src/runtime/storage.
 *
 * Cross-module imports of storage must land here (arch:check rule 5). The
 * remaining storage surfaces (layout contract, codecs, session store) join
 * this barrel in Slice 3 of the migration plan, which also dissolves the
 * layout.ts re-export barrel; until then their deep imports stay baselined.
 */
export { createLocalRuntimeStorageLayout } from './layout.ts';
export {
  createRuntimePluginFileStore,
  createRuntimePluginFileStoreTransaction,
  type RuntimePluginFileStoreProvider
} from './plugin-file-store/index.ts';
