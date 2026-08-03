import {join} from 'node:path';

import {readTextFileSync} from '../../../shared/file-system.ts';

import {createLocalRuntimeMutationLockOwnerToken} from '../mutation-lock.ts';
import type {RuntimePluginFileStore} from '../../../plugins/index.ts';
import type {CreateRuntimePluginFileStoreOptions} from '../../../plugins/index.ts';
import {
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
  recoverDirectDurablePluginFileStoreMutation,
} from './wal.ts';

export type DurableRuntimePluginFileStoreDependencies = {
  readonly faultInjector?: DurablePluginFileStoreFaultInjector;
};

export function createDurableRuntimePluginFileStore(
  options: CreateRuntimePluginFileStoreOptions & {readonly storeRoot: string},
  dependencies: DurableRuntimePluginFileStoreDependencies = {},
): RuntimePluginFileStore {
  const durableOptions = Object.freeze({
    ...options,
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

  function recoverInterruptedWrite(): void {
    recoverDirectDurablePluginFileStoreMutation({
      storeRoot: durableOptions.storeRoot,
      sessionId: durableOptions.sessionId,
      pluginId: durableOptions.pluginId,
      root,
      ownerToken,
    });
  }

  // A write is durable when its call returns, so opening a store only
  // finishes a single interrupted write.
  recoverInterruptedWrite();
  withDurablePluginStoreMutation(
    {storeRoot: durableOptions.storeRoot, root, ownerToken},
    () => {
      assertSafeDurablePluginRoot(root);
      cleanupDurablePluginStoreAtomicTempFiles(root);
    },
  );

  return Object.freeze({
    readJson(path) {
      const safePath = normalizeRuntimePluginFileStorePath(path);
      const filePath = join(root, safePath);

      recoverInterruptedWrite();
      return withDurablePluginStoreMutation(
        {storeRoot: durableOptions.storeRoot, root, ownerToken},
        () => {
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
        },
      );
    },
    readJsonl(path) {
      const safePath = normalizeRuntimePluginFileStorePath(path);
      const filePath = join(root, safePath);

      recoverInterruptedWrite();
      return withDurablePluginStoreMutation(
        {storeRoot: durableOptions.storeRoot, root, ownerToken},
        () => {
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
        },
      );
    },
    writeJsonAtomic(path, value) {
      const safePath = normalizeRuntimePluginFileStorePath(path);

      recoverInterruptedWrite();
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

      recoverInterruptedWrite();
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
      recoverInterruptedWrite();
      return withDurablePluginStoreMutation(
        {storeRoot: durableOptions.storeRoot, root, ownerToken},
        () => {
          assertSafeDurablePluginRoot(root);
          return readDurableRevision(root);
        },
      );
    },
  } satisfies RuntimePluginFileStore);
}
