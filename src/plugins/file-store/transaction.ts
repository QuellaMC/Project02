import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { RuntimeEventIdentity } from '../../runtime/event.ts';
import type { RuntimePluginFileStore } from '../types.ts';
import { createRuntimePluginFileStore } from './base-store.ts';
import type {
  CreateRuntimePluginFileStoreOptions,
  InMemoryPluginStoreState,
  RuntimePluginFileStorePathMode,
  RuntimePluginFileStorePreparedTransaction,
  RuntimePluginFileStoreTransaction,
  StagedPluginFileStoreOperation
} from './contracts.ts';
import {
  assertSafeDurablePluginPath,
  canonicalDurablePluginStoreRoot,
  durablePluginRoot,
  hashOptionalFileContent,
  readDurablePathModes,
  readOptionalRegularFile
} from './durable-primitives.ts';
import {
  applyInMemoryPluginFileStoreOperation,
  inMemoryPluginFileStoreContent,
  inMemoryPluginStoreState
} from './memory-store.ts';
import {
  assertJsonlPathMode,
  assertJsonPathMode,
  freezeRuntimePluginFileStoreJsonValue,
  normalizeRuntimePluginFileStorePath
} from './shared.ts';
import {
  prepareDurablePluginFileStoreTransaction,
  recoverPreparedDurablePluginFileStoreTransactions
} from './wal.ts';

const transactionSessionIdentityKeys = new WeakMap<object, string>();

type TransactionalPluginStoreOverlay = {
  readonly base: RuntimePluginFileStore;
  readonly options: CreateRuntimePluginFileStoreOptions;
  readonly pathModes: Map<string, RuntimePluginFileStorePathMode>;
  readonly pathSnapshots: Map<string, TransactionalPluginStorePathSnapshot>;
};

type TransactionalPluginStorePathSnapshot = {
  readonly hash: string;
  readonly mode: RuntimePluginFileStorePathMode | undefined;
};

type PreparedInMemoryPluginFileStoreOperation =
  StagedPluginFileStoreOperation & {
    readonly beforeHash: string;
    readonly afterHash: string;
  };

export function createRuntimePluginFileStoreTransaction(): RuntimePluginFileStoreTransaction {
  const overlays = new Map<string, TransactionalPluginStoreOverlay>();
  const operations: StagedPluginFileStoreOperation[] = [];
  let inMemorySessionBoundary:
    | { readonly kind: 'object'; readonly identity: object }
    | { readonly kind: 'text'; readonly sessionId: string }
    | undefined;
  let closed = false;

  function overlayFor(
    options: CreateRuntimePluginFileStoreOptions
  ): TransactionalPluginStoreOverlay {
    assertTransactionOpen(closed);

    if (options.storeRoot === undefined) {
      const nextBoundary =
        options.sessionIdentity === undefined
          ? ({ kind: 'text', sessionId: options.sessionId } as const)
          : ({ kind: 'object', identity: options.sessionIdentity } as const);

      if (inMemorySessionBoundary === undefined) {
        inMemorySessionBoundary = nextBoundary;
      } else if (
        inMemorySessionBoundary.kind !== nextBoundary.kind ||
        (nextBoundary.kind === 'object'
          ? inMemorySessionBoundary.kind !== 'object' ||
            inMemorySessionBoundary.identity !== nextBoundary.identity
          : inMemorySessionBoundary.kind !== 'text' ||
            inMemorySessionBoundary.sessionId !== nextBoundary.sessionId)
      ) {
        throw new TypeError(
          'Plugin fileStore transaction cannot mix distinct in-memory session identities.'
        );
      }
    }

    const key = transactionStoreKey(options);
    let overlay = overlays.get(key);

    if (overlay === undefined) {
      const storeRoot =
        options.storeRoot === undefined
          ? undefined
          : canonicalDurablePluginStoreRoot(options.storeRoot);
      const frozenOptions = Object.freeze({
        ...(storeRoot === undefined ? {} : { storeRoot }),
        sessionId: options.sessionId,
        ...(options.sessionIdentity === undefined
          ? {}
          : { sessionIdentity: options.sessionIdentity }),
        pluginId: options.pluginId
      } satisfies CreateRuntimePluginFileStoreOptions);

      overlay = {
        base: createRuntimePluginFileStore(frozenOptions),
        options: frozenOptions,
        pathModes: new Map(),
        pathSnapshots: new Map()
      };
      overlays.set(key, overlay);
    }

    return overlay;
  }

  return Object.freeze({
    fileStoreFor(options) {
      const overlay = overlayFor(options);

      return Object.freeze({
        readJson(path) {
          const safePath = normalizeRuntimePluginFileStorePath(path);

          assertJsonPathMode(overlay.pathModes.get(safePath));
          captureTransactionalPluginStorePathHash(
            overlay,
            safePath,
            'write_json'
          );
          const stagedWrite = [...operations].reverse().find(
            (operation) =>
              operation.storeKey === transactionStoreKey(overlay.options) &&
              operation.path === safePath &&
              operation.kind === 'write_json'
          );

          if (stagedWrite !== undefined) {
            return freezeRuntimePluginFileStoreJsonValue(stagedWrite.value);
          }

          return overlay.base.readJson(safePath);
        },
        readJsonl(path) {
          const safePath = normalizeRuntimePluginFileStorePath(path);

          assertJsonlPathMode(overlay.pathModes.get(safePath));
          captureTransactionalPluginStorePathHash(
            overlay,
            safePath,
            'append_jsonl'
          );
          const appends = operations.filter(
            (operation) =>
              operation.storeKey === transactionStoreKey(overlay.options) &&
              operation.path === safePath &&
              operation.kind === 'append_jsonl'
          );

          return Object.freeze([
            ...overlay.base.readJsonl(safePath),
            ...appends.map((operation) =>
              freezeRuntimePluginFileStoreJsonValue(operation.value)
            )
          ]);
        },
        writeJsonAtomic(path, value) {
          const safePath = normalizeRuntimePluginFileStorePath(path);

          assertTransactionOpen(closed);
          assertJsonPathMode(overlay.pathModes.get(safePath));
          const expectedBeforeHash = captureTransactionalPluginStorePathHash(
            overlay,
            safePath,
            'write_json'
          );
          operations.push(
            Object.freeze({
              storeKey: transactionStoreKey(overlay.options),
              options: overlay.options,
              pluginId: overlay.options.pluginId,
              path: safePath,
              kind: 'write_json',
              value: freezeRuntimePluginFileStoreJsonValue(value),
              expectedBeforeHash
            } satisfies StagedPluginFileStoreOperation)
          );
          overlay.pathModes.set(safePath, 'json');
        },
        appendJsonl(path, value) {
          const safePath = normalizeRuntimePluginFileStorePath(path);

          assertTransactionOpen(closed);
          assertJsonlPathMode(overlay.pathModes.get(safePath));
          const expectedBeforeHash = captureTransactionalPluginStorePathHash(
            overlay,
            safePath,
            'append_jsonl'
          );
          operations.push(
            Object.freeze({
              storeKey: transactionStoreKey(overlay.options),
              options: overlay.options,
              pluginId: overlay.options.pluginId,
              path: safePath,
              kind: 'append_jsonl',
              value: freezeRuntimePluginFileStoreJsonValue(value),
              expectedBeforeHash
            } satisfies StagedPluginFileStoreOperation)
          );
          overlay.pathModes.set(safePath, 'jsonl');
        },
        revision() {
          return (
            overlay.base.revision() +
            operations.filter(
              (operation) =>
                operation.storeKey === transactionStoreKey(overlay.options)
            ).length
          );
        }
      } satisfies RuntimePluginFileStore);
    },
    prepare(identity) {
      assertTransactionOpen(closed);
      closed = true;
      return prepareRuntimePluginFileStoreOperations({
        identity,
        operations: Object.freeze([...operations])
      });
    },
    rollback() {
      assertTransactionOpen(closed);
      overlays.clear();
      operations.splice(0);
      closed = true;
    },
    hasPendingWrites() {
      return operations.length > 0;
    }
  } satisfies RuntimePluginFileStoreTransaction);
}

function prepareRuntimePluginFileStoreOperations(options: {
  readonly identity: RuntimeEventIdentity;
  readonly operations: readonly StagedPluginFileStoreOperation[];
}): RuntimePluginFileStorePreparedTransaction {
  const firstOperation = options.operations[0];

  if (firstOperation === undefined) {
    return createNoopPreparedPluginFileStoreTransaction();
  }

  const durable = firstOperation.options.storeRoot !== undefined;

  for (const operation of options.operations) {
    if ((operation.options.storeRoot !== undefined) !== durable) {
      throw new TypeError(
        'Plugin fileStore transaction cannot mix durable and in-memory stores.'
      );
    }

    if (
      operation.options.storeRoot !== firstOperation.options.storeRoot ||
      operation.options.sessionId !== firstOperation.options.sessionId
    ) {
      throw new TypeError(
        'Plugin fileStore transaction must stay within one runtime session.'
      );
    }
  }

  if (!durable) {
    return createPreparedInMemoryPluginFileStoreTransaction(options.operations);
  }

  const storeRoot = firstOperation.options.storeRoot;

  return prepareDurablePluginFileStoreTransaction({
    identity: options.identity,
    operations: options.operations,
    sessionId: firstOperation.options.sessionId,
    storeRoot
  });
}

function createNoopPreparedPluginFileStoreTransaction(): RuntimePluginFileStorePreparedTransaction {
  return Object.freeze({
    discard() {},
    finalize() {}
  } satisfies RuntimePluginFileStorePreparedTransaction);
}

function captureTransactionalPluginStorePathHash(
  overlay: TransactionalPluginStoreOverlay,
  path: string,
  kind: StagedPluginFileStoreOperation['kind']
): string {
  const existing = overlay.pathSnapshots.get(path);

  if (existing !== undefined) {
    assertOperationPathMode(kind, existing.mode);
    return existing.hash;
  }

  const snapshot = currentPluginFileStorePathSnapshot(
    overlay.options,
    path,
    kind
  );

  overlay.pathSnapshots.set(path, snapshot);
  return snapshot.hash;
}

function currentPluginFileStorePathSnapshot(
  options: CreateRuntimePluginFileStoreOptions,
  path: string,
  kind: StagedPluginFileStoreOperation['kind']
): TransactionalPluginStorePathSnapshot {
  if (options.storeRoot === undefined) {
    const state = inMemoryPluginStoreState(options);
    const mode = state.pathModes.get(path);

    assertOperationPathMode(kind, mode);
    return Object.freeze({
      hash: hashOptionalFileContent(
        inMemoryPluginFileStoreContent(state, path)
      ),
      mode
    });
  }

  const durableOptions = Object.freeze({
    ...options,
    storeRoot: options.storeRoot
  } satisfies CreateRuntimePluginFileStoreOptions & { readonly storeRoot: string });
  const root = durablePluginRoot({
    storeRoot: durableOptions.storeRoot,
    sessionId: durableOptions.sessionId,
    pluginId: durableOptions.pluginId
  });

  recoverPreparedDurablePluginFileStoreTransactions(durableOptions);
  assertSafeDurablePluginPath(root, path);
  const mode = readDurablePathModes(root).get(path);

  assertOperationPathMode(kind, mode);
  return Object.freeze({
    hash: hashOptionalFileContent(readOptionalRegularFile(join(root, path))),
    mode
  });
}

function assertOperationPathMode(
  kind: StagedPluginFileStoreOperation['kind'],
  mode: RuntimePluginFileStorePathMode | undefined
): void {
  if (kind === 'write_json') {
    assertJsonPathMode(mode);
    return;
  }

  assertJsonlPathMode(mode);
}

function createPreparedInMemoryPluginFileStoreTransaction(
  operations: readonly StagedPluginFileStoreOperation[]
): RuntimePluginFileStorePreparedTransaction {
  const preparedOperations = materializeInMemoryPluginFileStoreOperations(
    operations
  );
  let state: 'discarded' | 'finalized' | 'prepared' = 'prepared';

  return Object.freeze({
    discard() {
      if (state === 'prepared') {
        state = 'discarded';
      }
    },
    finalize() {
      if (state !== 'prepared') {
        return;
      }

      const nextStates = new Map<
        string,
        {
          readonly actual: InMemoryPluginStoreState;
          readonly next: InMemoryPluginStoreState;
        }
      >();

      for (const operation of preparedOperations) {
        let states = nextStates.get(operation.storeKey);

        if (states === undefined) {
          const actual = inMemoryPluginStoreState(operation.options);

          states = {
            actual,
            next: {
              files: new Map(actual.files),
              pathModes: new Map(actual.pathModes),
              revision: actual.revision
            }
          };
          nextStates.set(operation.storeKey, states);
        }

        const currentHash = hashOptionalFileContent(
          inMemoryPluginFileStoreContent(states.next, operation.path)
        );

        if (currentHash === operation.beforeHash) {
          applyInMemoryPluginFileStoreOperation(states.next, operation);
        } else if (currentHash !== operation.afterHash) {
          throw new Error(
            `Plugin fileStore transaction conflict for ${operation.pluginId}/${operation.path}.`
          );
        }
      }

      for (const { actual, next } of nextStates.values()) {
        actual.files.clear();
        actual.pathModes.clear();

        for (const [path, value] of next.files) {
          actual.files.set(path, value);
        }

        for (const [path, mode] of next.pathModes) {
          actual.pathModes.set(path, mode);
        }

        actual.revision = next.revision;
      }

      state = 'finalized';
    }
  } satisfies RuntimePluginFileStorePreparedTransaction);
}

function materializeInMemoryPluginFileStoreOperations(
  operations: readonly StagedPluginFileStoreOperation[]
): readonly PreparedInMemoryPluginFileStoreOperation[] {
  const virtualStates = new Map<string, InMemoryPluginStoreState>();
  const materializedPaths = new Set<string>();

  return Object.freeze(
    operations.map((operation) => {
      let state = virtualStates.get(operation.storeKey);

      if (state === undefined) {
        const actual = inMemoryPluginStoreState(operation.options);

        state = {
          files: new Map(actual.files),
          pathModes: new Map(actual.pathModes),
          revision: actual.revision
        };
        virtualStates.set(operation.storeKey, state);
      }

      const beforeHash = hashOptionalFileContent(
        inMemoryPluginFileStoreContent(state, operation.path)
      );
      const operationPathKey = `${operation.storeKey}\u0000${operation.path}`;

      if (
        !materializedPaths.has(operationPathKey) &&
        beforeHash !== operation.expectedBeforeHash
      ) {
        throw new Error(
          `Plugin fileStore transaction conflict for ${operation.pluginId}/${operation.path}.`
        );
      }

      materializedPaths.add(operationPathKey);
      applyInMemoryPluginFileStoreOperation(state, operation);

      return Object.freeze({
        ...operation,
        beforeHash,
        afterHash: hashOptionalFileContent(
          inMemoryPluginFileStoreContent(state, operation.path)
        )
      } satisfies PreparedInMemoryPluginFileStoreOperation);
    })
  );
}

function transactionStoreKey(
  options: CreateRuntimePluginFileStoreOptions
): string {
  const rootKey =
    options.storeRoot ??
    (options.sessionIdentity === undefined
      ? '<memory>'
      : `<memory:${transactionSessionIdentityKey(options.sessionIdentity)}>`);

  return [rootKey, options.sessionId, options.pluginId].join('\u0000');
}

function transactionSessionIdentityKey(identity: object): string {
  let key = transactionSessionIdentityKeys.get(identity);

  if (key === undefined) {
    key = randomUUID();
    transactionSessionIdentityKeys.set(identity, key);
  }

  return key;
}

function assertTransactionOpen(closed: boolean): void {
  if (closed) {
    throw new Error('Plugin fileStore transaction is already closed.');
  }
}
