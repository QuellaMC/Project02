import {join} from 'node:path';

import {readTextFileSync} from '../../../shared/file-system.ts';

import {createLocalRuntimeMutationLockOwnerToken} from '../mutation-lock.ts';
import type {RuntimePluginFileStore} from '../../../plugins/api/index.ts';
import type {CreateRuntimePluginFileStoreOptions} from '../../../plugins/api/index.ts';
import {
  characterScopeDurableStoreIdentity,
  assertDurableOperationPathMode,
  assertSafeDurablePluginPath,
  assertSafeDurablePluginRoot,
  canonicalDurablePluginStoreRoot,
  cleanupDurablePluginStoreAtomicTempFiles,
  durablePluginRoot,
  readDurablePathMode,
  readDurableRevision,
  withDurablePluginStoreMutation,
} from './durable-primitives.ts';
import {
  freezeRuntimePluginFileStoreJsonValue,
  isMissingFileError,
  normalizeRuntimePluginFileStorePath,
  parseRuntimePluginJsonlContent,
} from './shared.ts';
import {
  applyRecoverableDurablePluginFileStoreOperation,
  type DurablePluginFileStoreFaultInjector,
  recoverDirectDurablePluginFileStoreMutationLocked,
} from './wal.ts';

type DurableRuntimePluginFileStoreDependencies = {
  readonly faultInjector?: DurablePluginFileStoreFaultInjector;
};

export function createDurableRuntimePluginFileStore(
  options: CreateRuntimePluginFileStoreOptions & {readonly storeRoot: string},
  dependencies: DurableRuntimePluginFileStoreDependencies = {},
): RuntimePluginFileStore {
  const durableOptions = Object.freeze({
    ...options,
    // One engine identity per store: character scope replaces the calling
    // session so every session derives the same root and WAL identity.
    sessionId:
      options.scope === 'character'
        ? characterScopeDurableStoreIdentity
        : options.sessionId,
    storeRoot: canonicalDurablePluginStoreRoot(options.storeRoot),
  } satisfies CreateRuntimePluginFileStoreOptions & {
    readonly storeRoot: string;
  });
  const root = durablePluginRoot({
    storeRoot: durableOptions.storeRoot,
    sessionId: durableOptions.sessionId,
    pluginId: durableOptions.pluginId,
  });
  const ownerToken = createLocalRuntimeMutationLockOwnerToken();

  /**
   * Callers already holding the mutation lease pass it through, so no
   * writer can journal a new write between recovery and the read after it.
   */
  function recoverInterruptedWrite(): void {
    recoverDirectDurablePluginFileStoreMutationLocked({
      storeRoot: durableOptions.storeRoot,
      sessionId: durableOptions.sessionId,
      pluginId: durableOptions.pluginId,
      root,
      ownerToken,
    });
  }

  function withStoreLease<T>(operation: () => T): T {
    return withDurablePluginStoreMutation(
      {storeRoot: durableOptions.storeRoot, root, ownerToken},
      () => {
        recoverInterruptedWrite();
        return operation();
      },
    );
  }

  // A write is durable when its call returns, so opening a store only
  // finishes a single interrupted write.
  withStoreLease(() => {
    assertSafeDurablePluginRoot(root);
    cleanupDurablePluginStoreAtomicTempFiles(root);
  });

  return Object.freeze({
    readJson(path) {
      const safePath = normalizeRuntimePluginFileStorePath(path);
      const filePath = join(root, safePath);

      return withStoreLease(() => {
        assertSafeDurablePluginPath(root, safePath);
        assertDurableOperationPathMode({
          filePath,
          mode: readDurablePathMode(root, safePath),
          operation: {kind: 'write_json', path: safePath},
        });

        try {
          return freezeRuntimePluginFileStoreJsonValue(
            JSON.parse(readTextFileSync(filePath)) as unknown,
          );
        } catch (error: unknown) {
          if (isMissingFileError(error)) {
            return undefined;
          }

          throw error;
        }
      });
    },
    readJsonl(path) {
      const safePath = normalizeRuntimePluginFileStorePath(path);
      const filePath = join(root, safePath);

      return withStoreLease(() => {
        assertSafeDurablePluginPath(root, safePath);
        assertDurableOperationPathMode({
          filePath,
          mode: readDurablePathMode(root, safePath),
          operation: {kind: 'append_jsonl', path: safePath},
        });

        try {
          return parseRuntimePluginJsonlContent(readTextFileSync(filePath));
        } catch (error: unknown) {
          if (isMissingFileError(error)) {
            return Object.freeze([]);
          }

          throw error;
        }
      });
    },
    writeJsonAtomic(path, value) {
      const safePath = normalizeRuntimePluginFileStorePath(path);

      applyRecoverableDurablePluginFileStoreOperation({
        storeRoot: durableOptions.storeRoot,
        sessionId: durableOptions.sessionId,
        pluginId: durableOptions.pluginId,
        root,
        kind: 'write_json',
        path: safePath,
        value: freezeRuntimePluginFileStoreJsonValue(value),
        ownerToken,
        ...(dependencies.faultInjector === undefined
          ? {}
          : {faultInjector: dependencies.faultInjector}),
      });
    },
    appendJsonl(path, value) {
      const safePath = normalizeRuntimePluginFileStorePath(path);

      applyRecoverableDurablePluginFileStoreOperation({
        storeRoot: durableOptions.storeRoot,
        sessionId: durableOptions.sessionId,
        pluginId: durableOptions.pluginId,
        root,
        kind: 'append_jsonl',
        path: safePath,
        value: freezeRuntimePluginFileStoreJsonValue(value),
        ownerToken,
        ...(dependencies.faultInjector === undefined
          ? {}
          : {faultInjector: dependencies.faultInjector}),
      });
    },
    revision() {
      return withStoreLease(() => {
        assertSafeDurablePluginRoot(root);
        return readDurableRevision(root);
      });
    },
    // The lock re-enters for this store's owner token, so nested store
    // calls inside the operation acquire nothing new.
    withMutations(operation) {
      return withStoreLease(operation);
    },
  } satisfies RuntimePluginFileStore);
}
