import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createLocalRuntimeMutationLockOwnerToken } from '../mutation-lock.ts';
import type { RuntimePluginFileStore } from '../../../plugins/index.ts';
import type { CreateRuntimePluginFileStoreOptions } from '../../../plugins/index.ts';
import {
  assertDurableOperationPathMode,
  assertSafeDurablePluginPath,
  assertSafeDurablePluginRoot,
  canonicalDurablePluginStoreRoot,
  cleanupDurablePluginStoreAtomicTempFiles,
  durablePluginRoot,
  readDurablePathMode,
  readDurableRevision,
  withDurablePluginStoreMutation
} from './durable-primitives.ts';
import {
  freezeRuntimePluginFileStoreJsonValue,
  isMissingFileError,
  normalizeRuntimePluginFileStorePath,
  parseRuntimePluginJsonlContent
} from './shared.ts';
import {
  applyRecoverableDurablePluginFileStoreOperation,
  type DurablePluginFileStoreFaultInjector,
  recoverDirectDurablePluginFileStoreMutation,
  recoverPreparedDurablePluginFileStoreTransactions
} from './wal.ts';

export type DurableRuntimePluginFileStoreDependencies = {
  readonly faultInjector?: DurablePluginFileStoreFaultInjector;
  readonly skipInitialCleanup?: boolean;
  readonly skipPreparedTransactionRecovery?: boolean;
};

export function createDurableRuntimePluginFileStore(
  options: CreateRuntimePluginFileStoreOptions & { readonly storeRoot: string },
  dependencies: DurableRuntimePluginFileStoreDependencies = {}
): RuntimePluginFileStore {
  const durableOptions = Object.freeze({
    ...options,
    storeRoot: canonicalDurablePluginStoreRoot(options.storeRoot)
  } satisfies CreateRuntimePluginFileStoreOptions & { readonly storeRoot: string });
  const root = durablePluginRoot({
    storeRoot: durableOptions.storeRoot,
    sessionId: durableOptions.sessionId,
    pluginId: durableOptions.pluginId
  });
  const ownerToken = createLocalRuntimeMutationLockOwnerToken();

  if (dependencies.skipPreparedTransactionRecovery !== true) {
    recoverPreparedDurablePluginFileStoreTransactions(
      durableOptions,
      ownerToken
    );
  }
  if (dependencies.skipInitialCleanup !== true) {
    withDurablePluginStoreMutation(
      { storeRoot: durableOptions.storeRoot, root, ownerToken },
      () => {
        assertSafeDurablePluginRoot(root);
        cleanupDurablePluginStoreAtomicTempFiles(root);
      }
    );
  }

  function recoverPreparedTransactions(): void {
    if (dependencies.skipPreparedTransactionRecovery !== true) {
      recoverPreparedDurablePluginFileStoreTransactions(
        durableOptions,
        ownerToken,
        { recoverDirectMutation: false }
      );
    }
  }

  return Object.freeze({
    readJson(path) {
      const safePath = normalizeRuntimePluginFileStorePath(path);
      const filePath = join(root, safePath);

      recoverPreparedTransactions();
      return withDurablePluginStoreMutation(
        { storeRoot: durableOptions.storeRoot, root, ownerToken },
        () => {
          recoverDirectDurablePluginFileStoreMutation({
            storeRoot: durableOptions.storeRoot,
            sessionId: durableOptions.sessionId,
            pluginId: durableOptions.pluginId,
            root,
            ownerToken
          });
          assertSafeDurablePluginPath(root, safePath);
          assertDurableOperationPathMode({
            filePath,
            mode: readDurablePathMode(root, safePath),
            operation: { kind: 'write_json', path: safePath }
          });

          try {
            return freezeRuntimePluginFileStoreJsonValue(
              JSON.parse(readFileSync(filePath, 'utf8')) as unknown
            );
          } catch (error: unknown) {
            if (isMissingFileError(error)) {
              return undefined;
            }

            throw error;
          }
        }
      );
    },
    readJsonl(path) {
      const safePath = normalizeRuntimePluginFileStorePath(path);
      const filePath = join(root, safePath);

      recoverPreparedTransactions();
      return withDurablePluginStoreMutation(
        { storeRoot: durableOptions.storeRoot, root, ownerToken },
        () => {
          recoverDirectDurablePluginFileStoreMutation({
            storeRoot: durableOptions.storeRoot,
            sessionId: durableOptions.sessionId,
            pluginId: durableOptions.pluginId,
            root,
            ownerToken
          });
          assertSafeDurablePluginPath(root, safePath);
          assertDurableOperationPathMode({
            filePath,
            mode: readDurablePathMode(root, safePath),
            operation: { kind: 'append_jsonl', path: safePath }
          });

          try {
            return parseRuntimePluginJsonlContent(
              readFileSync(filePath, 'utf8')
            );
          } catch (error: unknown) {
            if (isMissingFileError(error)) {
              return Object.freeze([]);
            }

            throw error;
          }
        }
      );
    },
    writeJsonAtomic(path, value) {
      const safePath = normalizeRuntimePluginFileStorePath(path);

      recoverPreparedTransactions();
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
          : { faultInjector: dependencies.faultInjector })
      });
    },
    appendJsonl(path, value) {
      const safePath = normalizeRuntimePluginFileStorePath(path);

      recoverPreparedTransactions();
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
          : { faultInjector: dependencies.faultInjector })
      });
    },
    revision() {
      recoverPreparedTransactions();
      return withDurablePluginStoreMutation(
        { storeRoot: durableOptions.storeRoot, root, ownerToken },
        () => {
          recoverDirectDurablePluginFileStoreMutation({
            storeRoot: durableOptions.storeRoot,
            sessionId: durableOptions.sessionId,
            pluginId: durableOptions.pluginId,
            root,
            ownerToken
          });
          assertSafeDurablePluginRoot(root);
          return readDurableRevision(root);
        }
      );
    }
  } satisfies RuntimePluginFileStore);
}
