import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { RuntimeEventIdentity } from '../../../core/index.ts';
import {
  createLocalRuntimeMutationLockOwnerToken,
  type LocalRuntimeMutationLockOwnerToken
} from '../mutation-lock.ts';
import type { RuntimePluginFileStore } from '../../../plugins/index.ts';
import { createRuntimePluginFileStore } from './base-store.ts';
import { createDurableRuntimePluginFileStore } from './durable-store.ts';
import type {
  CreateRuntimePluginFileStoreOptions, InMemoryRuntimePluginFileStoreOptions,
  RuntimePluginFileStorePathMode, RuntimePluginFileStorePreparedTransaction,
  RuntimePluginFileStoreTransaction
} from '../../../plugins/index.ts';
import type {
  InMemoryPluginStoreState,
  StagedPluginFileStoreOperation
} from './contracts.ts';
import {
  assertSafeDurablePluginPath,
  canonicalDurablePluginStoreRoot,
  durablePluginRoot,
  hashOptionalFileContent,
  readDurablePathMode,
  readOptionalRegularFile,
  withDurablePluginStoreMutation
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
  type DurablePluginFileStoreFaultInjector,
  prepareDurablePluginFileStoreTransaction,
  recoverDirectDurablePluginFileStoreMutation,
  recoverPreparedDurablePluginFileStoreTransactions
} from './wal.ts';

const transactionSessionIdentityKeys = new WeakMap<object, string>();

type TransactionalPluginStoreOverlay = {
  base?: RuntimePluginFileStore;
  readonly options: CreateRuntimePluginFileStoreOptions;
  readonly ownerToken: LocalRuntimeMutationLockOwnerToken;
  readonly pathModes: Map<string, RuntimePluginFileStorePathMode>;
  readonly pathSnapshots: Map<string, TransactionalPluginStorePathSnapshot>;
  durableRecoveryComplete: boolean;
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

export function createRuntimePluginFileStoreTransaction(
  dependencies: {
    readonly durableFaultInjector?: DurablePluginFileStoreFaultInjector;
  } = {}
): RuntimePluginFileStoreTransaction {
  const overlays = new Map<string, TransactionalPluginStoreOverlay>();
  const operations: StagedPluginFileStoreOperation[] = [];
  const durableOwnerToken = createLocalRuntimeMutationLockOwnerToken();
  let inMemorySessionBoundary: object | undefined;
  let closed = false;

  function overlayFor(
    options: CreateRuntimePluginFileStoreOptions
  ): TransactionalPluginStoreOverlay {
    assertTransactionOpen(closed);

    if (options.storeRoot === undefined) {
      if (inMemorySessionBoundary === undefined) {
        inMemorySessionBoundary = options.sessionIdentity;
      } else if (inMemorySessionBoundary !== options.sessionIdentity) {
        throw new TypeError(
          'Plugin fileStore transaction cannot mix distinct in-memory session identities.'
        );
      }
    }

    const key = transactionStoreKey(options);
    let overlay = overlays.get(key);

    if (overlay === undefined) {
      const frozenOptions = freezePluginFileStoreOptions(options);

      overlay = {
        options: frozenOptions,
        ownerToken: durableOwnerToken,
        pathModes: new Map(),
        pathSnapshots: new Map(),
        durableRecoveryComplete: false
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
          assertTransactionOpen(closed);
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

          return runtimePluginFileStoreForOverlay(overlay).readJson(safePath);
        },
        readJsonl(path) {
          assertTransactionOpen(closed);
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
            ...runtimePluginFileStoreForOverlay(overlay).readJsonl(safePath),
            ...appends.map((operation) =>
              freezeRuntimePluginFileStoreJsonValue(operation.value)
            )
          ]);
        },
        writeJsonAtomic(path, value) {
          assertTransactionOpen(closed);
          const safePath = normalizeRuntimePluginFileStorePath(path);

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
          assertTransactionOpen(closed);
          const safePath = normalizeRuntimePluginFileStorePath(path);

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
          assertTransactionOpen(closed);
          return (
            runtimePluginFileStoreForOverlay(overlay).revision() +
            operations.filter(
              (operation) =>
                operation.storeKey === transactionStoreKey(overlay.options)
            ).length
          );
        }
      } satisfies RuntimePluginFileStore);
    },
    async prepare(identity) {
      assertTransactionOpen(closed);
      closed = true;
      return await prepareRuntimePluginFileStoreOperations({
        identity,
        operations: Object.freeze([...operations]),
        ownerToken: durableOwnerToken,
        ...(dependencies.durableFaultInjector === undefined
          ? {}
          : { faultInjector: dependencies.durableFaultInjector })
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

function runtimePluginFileStoreForOverlay(
  overlay: TransactionalPluginStoreOverlay
): RuntimePluginFileStore {
  if (overlay.base === undefined) {
    if (overlay.options.storeRoot === undefined) {
      overlay.base = createRuntimePluginFileStore(overlay.options);
    } else {
      ensureDurableTransactionalPluginStoreReady(overlay);
      overlay.base = createDurableRuntimePluginFileStore(overlay.options, {
        skipInitialCleanup: true,
        skipPreparedTransactionRecovery: true
      });
    }
  }

  return overlay.base;
}

function ensureDurableTransactionalPluginStoreReady(
  overlay: TransactionalPluginStoreOverlay
): void {
  if (
    overlay.options.storeRoot === undefined ||
    overlay.durableRecoveryComplete
  ) {
    return;
  }

  recoverPreparedDurablePluginFileStoreTransactions(
    overlay.options,
    overlay.ownerToken,
    { recoverDirectMutation: false }
  );
  overlay.durableRecoveryComplete = true;
}

async function prepareRuntimePluginFileStoreOperations(options: {
  readonly identity: RuntimeEventIdentity;
  readonly operations: readonly StagedPluginFileStoreOperation[];
  readonly ownerToken: LocalRuntimeMutationLockOwnerToken;
  readonly faultInjector?: DurablePluginFileStoreFaultInjector;
}): Promise<RuntimePluginFileStorePreparedTransaction> {
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

  return await prepareDurablePluginFileStoreTransaction({
    identity: options.identity,
    operations: options.operations,
    ownerToken: options.ownerToken,
    sessionId: firstOperation.options.sessionId,
    storeRoot,
    ...(options.faultInjector === undefined
      ? {}
      : { faultInjector: options.faultInjector })
  });
}

function createNoopPreparedPluginFileStoreTransaction(): RuntimePluginFileStorePreparedTransaction {
  return Object.freeze({
    async discard() {},
    async finalize() {}
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

  ensureDurableTransactionalPluginStoreReady(overlay);

  const snapshot = currentPluginFileStorePathSnapshot(
    overlay.options,
    path,
    kind,
    overlay.ownerToken
  );

  overlay.pathSnapshots.set(path, snapshot);
  return snapshot.hash;
}

function currentPluginFileStorePathSnapshot(
  options: CreateRuntimePluginFileStoreOptions,
  path: string,
  kind: StagedPluginFileStoreOperation['kind'],
  ownerToken: LocalRuntimeMutationLockOwnerToken
): TransactionalPluginStorePathSnapshot {
  if (options.storeRoot === undefined) {
    const state = inMemoryPluginStoreState(
      options satisfies InMemoryRuntimePluginFileStoreOptions
    );
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
      assertSafeDurablePluginPath(root, path);
      const mode = readDurablePathMode(root, path);

      assertOperationPathMode(kind, mode);
      return Object.freeze({
        hash: hashOptionalFileContent(
          readOptionalRegularFile(join(root, path))
        ),
        mode
      });
    }
  );
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
  let state: 'discarded' | 'finalized' | 'finalizing' | 'prepared' = 'prepared';

  return Object.freeze({
    async discard() {
      if (state === 'prepared') {
        state = 'discarded';
      }

      await Promise.resolve();
    },
    async finalize() {
      if (state !== 'prepared') {
        return;
      }

      state = 'finalizing';
      await Promise.resolve();
      state = 'prepared';

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
          const actual = inMemoryPluginStoreState(
            requireInMemoryPluginFileStoreOptions(operation.options)
          );

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
        const actual = inMemoryPluginStoreState(
          requireInMemoryPluginFileStoreOptions(operation.options)
        );

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
    `<memory:${transactionSessionIdentityKey(options.sessionIdentity)}>`;

  return [rootKey, options.sessionId, options.pluginId].join('\u0000');
}

function freezePluginFileStoreOptions(
  options: CreateRuntimePluginFileStoreOptions
): CreateRuntimePluginFileStoreOptions {
  if (options.storeRoot === undefined) {
    return Object.freeze({
      sessionId: options.sessionId,
      sessionIdentity: options.sessionIdentity,
      pluginId: options.pluginId
    } satisfies InMemoryRuntimePluginFileStoreOptions);
  }

  return Object.freeze({
    storeRoot: canonicalDurablePluginStoreRoot(options.storeRoot),
    sessionId: options.sessionId,
    ...(options.sessionIdentity === undefined
      ? {}
      : { sessionIdentity: options.sessionIdentity }),
    pluginId: options.pluginId
  } satisfies CreateRuntimePluginFileStoreOptions);
}

function requireInMemoryPluginFileStoreOptions(
  options: CreateRuntimePluginFileStoreOptions
): InMemoryRuntimePluginFileStoreOptions {
  if (options.storeRoot !== undefined) {
    throw new TypeError(
      'Expected an in-memory plugin fileStore operation.'
    );
  }

  return options;
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
