/**
 * Public API of src/runtime/storage.
 *
 * Cross-module imports of storage must land here (arch:check rule 5).
 * The session-store surface joins as the Slice 3f cli extractions route
 * through it; until then its deep imports stay baselined.
 */
export {
  createLocalRuntimePluginPaths,
  createLocalRuntimeSessionMetadata,
  createLocalRuntimeSessionPaths,
  createLocalRuntimeStorageLayout,
  createLocalRuntimeStorageSchemaMarker,
  decodeStorageSchemaMarker,
  defaultLocalRuntimeSessionId,
  defaultLocalRuntimeStoreRoot,
  encodeStorageSchemaMarker,
  LocalRuntimeStorageContractError,
  localRuntimeReadableStorageSchemaVersions,
  localRuntimeStorageSchemaVersion,
  normalizeLocalRuntimePluginId,
  normalizeLocalRuntimeSessionId,
  type CreateLocalRuntimeSessionMetadataOptions,
  type CreateLocalRuntimeStorageSchemaMarkerOptions,
  type LocalRuntimePluginPaths,
  type LocalRuntimePluginPathsOptions,
  type LocalRuntimeReadableStorageSchemaVersion,
  type LocalRuntimeSessionMetadata,
  type LocalRuntimeSessionPaths,
  type LocalRuntimeSessionPathsOptions,
  type LocalRuntimeStorageContractErrorCode,
  type LocalRuntimeStorageLayout,
  type LocalRuntimeStorageLayoutOptions,
  type LocalRuntimeStorageSchemaMarker,
} from './layout-contract.ts';
export {
  createRuntimePluginFileStore,
  createRuntimePluginFileStoreTransaction,
  type RuntimePluginFileStoreProvider,
} from './plugin-file-store/index.ts';
export {
  createDurableChatRuntime,
  isMissingDefaultSessionStore,
  type DurableChatRuntime,
  type DurableSessionSelection,
} from './durable-session-bootstrap.ts';
export {
  characterBindingFileName,
  characterBindingFormat,
  characterBindingPath,
  readCharacterBinding,
  reconcileCharacterBinding,
  type CharacterBinding,
  type CharacterBindingReadResult,
  type CharacterBindingReconcileResult,
} from './character-binding.ts';
export {runtimeLogStoreWithWriterOwner} from './log-store-writer-lease.ts';
export {
  acquireLocalRuntimeSessionWriterLease,
  createLocalRuntimeSessionStore,
  LocalRuntimeSessionStoreError,
  type LocalRuntimeSessionConversationEvidence,
} from './session-store.ts';
export {
  createLocalRuntimeMutationLockOwnerToken,
  type LocalRuntimeMutationLockLease,
} from './mutation-lock.ts';
export {
  createFileRuntimeLogStore,
  durableRuntimeSessionCharacterProfile,
} from './file-runtime-log-store.ts';
