import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RuntimePluginFileStore } from '../types.ts';
import type { CreateRuntimePluginFileStoreOptions } from './contracts.ts';
import {
  applyDurablePluginFileStoreOperation,
  assertDurableOperationPathMode,
  assertSafeDurablePluginPath,
  assertSafeDurablePluginRoot,
  canonicalDurablePluginStoreRoot,
  cleanupDurablePluginStoreAtomicTempFiles,
  durablePluginRoot,
  readDurablePathModes,
  readDurableRevision
} from './durable-primitives.ts';
import {
  freezeRuntimePluginFileStoreJsonValue,
  isMissingFileError,
  normalizeRuntimePluginFileStorePath,
  parseRuntimePluginJsonlContent
} from './shared.ts';
import { recoverPreparedDurablePluginFileStoreTransactions } from './wal.ts';

export function createDurableRuntimePluginFileStore(
  options: CreateRuntimePluginFileStoreOptions & { readonly storeRoot: string }
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

  recoverPreparedDurablePluginFileStoreTransactions(durableOptions);
  assertSafeDurablePluginRoot(root);
  cleanupDurablePluginStoreAtomicTempFiles(root);

  return Object.freeze({
    readJson(path) {
      const safePath = normalizeRuntimePluginFileStorePath(path);
      const filePath = join(root, safePath);

      recoverPreparedDurablePluginFileStoreTransactions(durableOptions);
      assertSafeDurablePluginPath(root, safePath);
      assertDurableOperationPathMode({
        filePath,
        mode: readDurablePathModes(root).get(safePath),
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
    },
    readJsonl(path) {
      const safePath = normalizeRuntimePluginFileStorePath(path);
      const filePath = join(root, safePath);

      recoverPreparedDurablePluginFileStoreTransactions(durableOptions);
      assertSafeDurablePluginPath(root, safePath);
      assertDurableOperationPathMode({
        filePath,
        mode: readDurablePathModes(root).get(safePath),
        operation: { kind: 'append_jsonl', path: safePath }
      });

      try {
        return parseRuntimePluginJsonlContent(readFileSync(filePath, 'utf8'));
      } catch (error: unknown) {
        if (isMissingFileError(error)) {
          return Object.freeze([]);
        }

        throw error;
      }
    },
    writeJsonAtomic(path, value) {
      const safePath = normalizeRuntimePluginFileStorePath(path);

      recoverPreparedDurablePluginFileStoreTransactions(durableOptions);
      applyDurablePluginFileStoreOperation({
        root,
        kind: 'write_json',
        path: safePath,
        value: freezeRuntimePluginFileStoreJsonValue(value)
      });
    },
    appendJsonl(path, value) {
      const safePath = normalizeRuntimePluginFileStorePath(path);

      recoverPreparedDurablePluginFileStoreTransactions(durableOptions);
      applyDurablePluginFileStoreOperation({
        root,
        kind: 'append_jsonl',
        path: safePath,
        value: freezeRuntimePluginFileStoreJsonValue(value)
      });
    },
    revision() {
      recoverPreparedDurablePluginFileStoreTransactions(durableOptions);
      assertSafeDurablePluginRoot(root);
      return readDurableRevision(root);
    }
  } satisfies RuntimePluginFileStore);
}
