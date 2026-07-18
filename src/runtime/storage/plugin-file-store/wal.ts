import {randomUUID, type Hash} from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  type Dirent,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeSync,
} from 'node:fs';
import {dirname, join} from 'node:path';
import {hostname} from 'node:os';

import {canonicalJsonStringify} from '../../../shared/canonical-json.ts';
import {processIsAlive} from '../process-liveness.ts';
import type {RuntimeEventIdentity} from '../../../core/index.ts';
import {parseAtomicReplacementFileName} from '../atomic-file.ts';
import {findValidatedTerminalRawEventForSession} from '../file-runtime-log-store.ts';
import {
  createLocalRuntimeSessionPaths,
  type LocalRuntimeSessionPaths,
} from '../layout-contract.ts';
import {
  createLocalRuntimeMutationLockOwnerToken,
  LocalRuntimeMutationLockBusyError,
  type LocalRuntimeMutationLockOwnerToken,
} from '../mutation-lock.ts';
import type {
  CreateRuntimePluginFileStoreOptions,
  RuntimePluginFileStorePathMode,
  RuntimePluginFileStorePreparedTransaction,
} from '../../../plugins/index.ts';
import type {StagedPluginFileStoreOperation} from './contracts.ts';
import {
  assertDurableOperationPathMode,
  assertRegularFile,
  assertSafeDurablePluginPath,
  assertSafeDurablePluginRoot,
  assertSafeDurableTransactionJournalDirectory,
  createPresentFileContentHash,
  durableOperationAfterContent,
  durablePluginRoot,
  hashOptionalFileContent,
  readDurablePathModes,
  readDurableRevision,
  readOptionalRegularFile,
  readOptionalRegularFileBuffer,
  readPersistedDurableRevision,
  requiredJournalOperationRevision,
  requiredJournalOperationString,
  withDurablePluginStoreMutationsAsync,
  withDurablePluginStoreMutation,
  withDurablePluginStoreMutations,
  writeDurablePathModes,
  writeDurableRevision,
  writeTextAtomic,
} from './durable-primitives.ts';
import type {RuntimePluginJsonValue} from '../../../plugins/index.ts';
import {
  durableDirectMutationJournalFileName,
  isMissingFileError,
} from './shared.ts';
import {
  durableTransactionProgressVersion,
  parseDurablePluginFileStoreTransactionProgress,
  type DurablePluginFileStoreTransactionProgress,
} from './wal-progress.ts';
import {
  assertDurableTransactionJournalDoesNotExist,
  durablePluginFileStoreTransactionJournalPath,
  durableTransactionJournalVersion,
  readDurablePluginFileStoreJournal,
  type DurablePluginFileStoreJournal,
  type DurablePluginFileStoreJournalOperation,
  writeDurablePluginFileStoreJournal,
} from './wal-codec.ts';

const durableTransactionDirectoryName = '.plugin-transactions';
const durableTransactionProgressSuffix = '.progress';
const activeDurableTransactionJournalPaths = new Set<string>();

export type DurablePluginFileStoreFaultPoint = 'after_content_persisted';

export type DurablePluginFileStoreFaultInjector = (
  point: DurablePluginFileStoreFaultPoint,
) => void;

export function recoverDirectDurablePluginFileStoreMutation(options: {
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly pluginId: string;
  readonly root: string;
  readonly ownerToken: LocalRuntimeMutationLockOwnerToken;
}): void {
  withDurablePluginStoreMutation(
    {
      storeRoot: options.storeRoot,
      root: options.root,
      ownerToken: options.ownerToken,
    },
    () => {
      recoverDirectDurablePluginFileStoreMutationLocked(options);
    },
  );
}

export function applyRecoverableDurablePluginFileStoreOperation(options: {
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly pluginId: string;
  readonly root: string;
  readonly kind: 'append_jsonl' | 'write_json';
  readonly path: string;
  readonly value: RuntimePluginJsonValue;
  readonly ownerToken: LocalRuntimeMutationLockOwnerToken;
  readonly faultInjector?: DurablePluginFileStoreFaultInjector;
}): void {
  withDurablePluginStoreMutation(
    {
      storeRoot: options.storeRoot,
      root: options.root,
      ownerToken: options.ownerToken,
    },
    () => {
      recoverDirectDurablePluginFileStoreMutationLocked(options);
      assertSafeDurablePluginPath(options.root, options.path);
      const filePath = join(options.root, options.path);
      const owner = createDurablePluginFileStoreJournalOwner();
      const directIdentity = `direct:${owner.ownerNonce}`;
      const pendingJournal = Object.freeze({
        version: durableTransactionJournalVersion,
        eventId: directIdentity,
        traceId: directIdentity,
        createdAt: new Date().toISOString(),
        ...owner,
        sessionId: options.sessionId,
        operations: Object.freeze([
          Object.freeze({
            index: 0,
            pluginId: options.pluginId,
            path: options.path,
            kind: options.kind,
            value: options.value,
            expectedBeforeHash: hashOptionalFileContent(
              readOptionalRegularFile(filePath),
            ),
            status: 'pending',
          } satisfies DurablePluginFileStoreJournalOperation),
        ]),
      } satisfies DurablePluginFileStoreJournal);
      const journal = materializeDurablePluginFileStoreJournal({
        storeRoot: options.storeRoot,
        journal: pendingJournal,
      });
      const journalPath = directDurablePluginFileStoreJournalPath(options.root);

      writeDurablePluginFileStoreJournal(journalPath, journal);
      const operation = journal.operations[0];

      if (operation === undefined) {
        throw new TypeError(
          'Plugin fileStore direct mutation journal is malformed.',
        );
      }

      applyPlannedDurablePluginFileStoreJournalOperation({
        storeRoot: options.storeRoot,
        sessionId: options.sessionId,
        operation,
        ownerToken: options.ownerToken,
        ...(options.faultInjector === undefined
          ? {}
          : {faultInjector: options.faultInjector}),
      });
      rmSync(journalPath, {force: true});
    },
  );
}

export async function prepareDurablePluginFileStoreTransaction(options: {
  readonly identity: RuntimeEventIdentity;
  readonly operations: readonly StagedPluginFileStoreOperation[];
  readonly ownerToken: LocalRuntimeMutationLockOwnerToken;
  readonly sessionId: string;
  readonly storeRoot: string;
  readonly faultInjector?: DurablePluginFileStoreFaultInjector;
}): Promise<RuntimePluginFileStorePreparedTransaction> {
  const journalPath = durablePluginFileStoreTransactionJournalPath({
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    identity: options.identity,
  });
  const journalResourceKey = durablePluginJournalMutationResourceKey({
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    identity: options.identity,
  });
  const owner = createDurablePluginFileStoreJournalOwner();
  const pendingJournal = Object.freeze({
    version: durableTransactionJournalVersion,
    eventId: options.identity.eventId,
    traceId: options.identity.traceId,
    createdAt: options.identity.createdAt,
    ...owner,
    sessionId: options.sessionId,
    operations: Object.freeze(
      options.operations.map((operation, index) =>
        Object.freeze({
          index,
          pluginId: operation.pluginId,
          path: operation.path,
          kind: operation.kind,
          value: operation.value,
          expectedBeforeHash: operation.expectedBeforeHash,
          status: 'pending',
        } satisfies DurablePluginFileStoreJournalOperation),
      ),
    ),
  } satisfies DurablePluginFileStoreJournal);
  const roots = durablePluginRootsForOperations({
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    operations: options.operations,
  });

  await withDurablePluginStoreMutationsAsync(
    {
      storeRoot: options.storeRoot,
      roots,
      resourceKeys: [journalResourceKey],
      ownerToken: options.ownerToken,
    },
    () => {
      recoverDirectDurablePluginFileStoreMutationsForOperationsLocked({
        storeRoot: options.storeRoot,
        sessionId: options.sessionId,
        operations: options.operations,
        ownerToken: options.ownerToken,
      });
      const journal = materializeDurablePluginFileStoreJournal({
        storeRoot: options.storeRoot,
        journal: pendingJournal,
      });

      assertDurableTransactionJournalDoesNotExist(journalPath);
      writeDurablePluginFileStoreJournal(journalPath, journal);
      activeDurableTransactionJournalPaths.add(journalPath);
    },
  );

  let state:
    | 'discarded'
    | 'discarding'
    | 'finalized'
    | 'finalizing'
    | 'prepared'
    | 'recovery_required' = 'prepared';
  let activeTransition: Promise<void> | undefined;

  return Object.freeze({
    discard() {
      if (state === 'discarding' || state === 'finalizing') {
        return activeTransition ?? Promise.resolve();
      }

      if (state !== 'prepared') {
        return Promise.resolve();
      }

      state = 'discarding';
      const transition = withDurablePluginStoreMutationsAsync(
        {
          storeRoot: options.storeRoot,
          roots,
          resourceKeys: [journalResourceKey],
          ownerToken: options.ownerToken,
        },
        () => {
          const currentJournal =
            readDurablePluginFileStoreJournalIfPresent(journalPath);

          if (currentJournal !== undefined) {
            assertJournalIdentityUnchanged(pendingJournal, currentJournal);
            assertJournalPathMatchesIdentity(
              options.storeRoot,
              journalPath,
              currentJournal,
            );
          }

          activeDurableTransactionJournalPaths.delete(journalPath);
          rmSync(durablePluginFileStoreProgressPath(journalPath), {
            force: true,
          });
          rmSync(journalPath, {force: true});
        },
      ).then(
        () => {
          state = 'discarded';
          activeTransition = undefined;
        },
        (error: unknown) => {
          state = 'prepared';
          activeTransition = undefined;
          throw error;
        },
      );

      activeTransition = transition;
      return transition;
    },
    finalize() {
      if (state === 'discarding' || state === 'finalizing') {
        return activeTransition ?? Promise.resolve();
      }

      if (state === 'discarded' || state === 'finalized') {
        return Promise.resolve();
      }

      state = 'finalizing';
      const transition = finalizeDurablePluginFileStoreJournal({
        storeRoot: options.storeRoot,
        journalPath,
        expectedJournalIdentity: pendingJournal,
        ownerToken: options.ownerToken,
        ...(options.faultInjector === undefined
          ? {}
          : {faultInjector: options.faultInjector}),
      }).then(
        () => {
          activeDurableTransactionJournalPaths.delete(journalPath);
          state = 'finalized';
          activeTransition = undefined;
        },
        (error: unknown) => {
          if (error instanceof LocalRuntimeMutationLockBusyError) {
            state = 'prepared';
          } else {
            activeDurableTransactionJournalPaths.delete(journalPath);
            state = 'recovery_required';
          }
          activeTransition = undefined;
          throw error;
        },
      );

      activeTransition = transition;
      return transition;
    },
  } satisfies RuntimePluginFileStorePreparedTransaction);
}

async function finalizeDurablePluginFileStoreJournal(options: {
  readonly storeRoot: string;
  readonly journalPath: string;
  readonly expectedJournalIdentity: DurablePluginFileStoreJournal;
  readonly ownerToken: LocalRuntimeMutationLockOwnerToken;
  readonly faultInjector?: DurablePluginFileStoreFaultInjector;
}): Promise<void> {
  const initialJournal = readDurablePluginFileStoreJournalIfPresent(
    options.journalPath,
  );

  if (initialJournal === undefined) {
    return;
  }

  assertJournalIdentityUnchanged(
    options.expectedJournalIdentity,
    initialJournal,
  );
  assertJournalPathMatchesIdentity(
    options.storeRoot,
    options.journalPath,
    initialJournal,
  );

  const roots = durablePluginRootsForJournal(options.storeRoot, initialJournal);
  const journalResourceKey = durablePluginJournalMutationResourceKey({
    storeRoot: options.storeRoot,
    sessionId: initialJournal.sessionId,
    identity: initialJournal,
  });

  await withDurablePluginStoreMutationsAsync(
    {
      storeRoot: options.storeRoot,
      roots,
      resourceKeys: [journalResourceKey],
      ownerToken: options.ownerToken,
    },
    () => {
      finalizeLockedDurablePluginFileStoreJournal({
        ...options,
        lockedRoots: roots,
      });
    },
  );
}

function finalizeLockedDurablePluginFileStoreJournal(options: {
  readonly storeRoot: string;
  readonly journalPath: string;
  readonly lockedRoots: readonly string[];
  readonly expectedJournalIdentity: DurablePluginFileStoreJournal;
  readonly ownerToken: LocalRuntimeMutationLockOwnerToken;
  readonly faultInjector?: DurablePluginFileStoreFaultInjector;
}): void {
  recoverDirectDurablePluginFileStoreMutationsForOperationsLocked({
    storeRoot: options.storeRoot,
    sessionId: options.expectedJournalIdentity.sessionId,
    operations: options.expectedJournalIdentity.operations,
    ownerToken: options.ownerToken,
  });

  const preflightJournal = readDurablePluginFileStoreJournalIfPresent(
    options.journalPath,
  );

  if (preflightJournal === undefined) {
    return;
  }

  assertJournalIdentityUnchanged(
    options.expectedJournalIdentity,
    preflightJournal,
  );
  assertJournalPathMatchesIdentity(
    options.storeRoot,
    options.journalPath,
    preflightJournal,
  );
  assertJournalRootsAreLocked(
    options.storeRoot,
    preflightJournal,
    options.lockedRoots,
  );

  if (
    preflightJournal.operations.some(
      operation => operation.status === 'pending',
    )
  ) {
    throw new Error(
      'Plugin fileStore transaction journal was not materialized.',
    );
  }

  const progress = readDurablePluginFileStoreTransactionProgress(
    options.journalPath,
    preflightJournal,
  );

  if (
    progress !== undefined ||
    preflightJournal.operations.every(
      operation => operation.status === 'planned',
    )
  ) {
    finalizeBatchedDurablePluginFileStoreJournal({
      ...options,
      journal: preflightJournal,
      ...(progress === undefined ? {} : {progress}),
      ...(options.faultInjector === undefined
        ? {}
        : {faultInjector: options.faultInjector}),
    });
    return;
  }

  preflightDurablePluginFileStoreJournal({
    storeRoot: options.storeRoot,
    journal: preflightJournal,
  });
  finalizeLegacyDurablePluginFileStoreJournal(options);
}

function finalizeLegacyDurablePluginFileStoreJournal(options: {
  readonly storeRoot: string;
  readonly journalPath: string;
  readonly lockedRoots: readonly string[];
  readonly expectedJournalIdentity: DurablePluginFileStoreJournal;
  readonly ownerToken: LocalRuntimeMutationLockOwnerToken;
}): void {
  for (;;) {
    let journal = readDurablePluginFileStoreJournalIfPresent(
      options.journalPath,
    );

    if (journal === undefined) {
      return;
    }

    assertJournalIdentityUnchanged(options.expectedJournalIdentity, journal);
    assertJournalPathMatchesIdentity(
      options.storeRoot,
      options.journalPath,
      journal,
    );
    assertJournalRootsAreLocked(
      options.storeRoot,
      journal,
      options.lockedRoots,
    );
    const operation = journal.operations.find(
      item => item.status !== 'applied',
    );

    if (operation === undefined) {
      rmSync(options.journalPath, {force: true});
      return;
    }

    const current = journal.operations[operation.index];

    if (current === undefined || current.status === 'pending') {
      throw new Error(
        'Plugin fileStore transaction journal was not materialized.',
      );
    }

    const reconciled = reconcileDurableJournalOperationRevision({
      storeRoot: options.storeRoot,
      sessionId: journal.sessionId,
      operation: current,
    });

    if (reconciled !== current) {
      journal = replaceDurablePluginFileStoreJournalOperation(
        journal,
        reconciled,
      );
      writeDurablePluginFileStoreJournal(options.journalPath, journal);
    }

    applyPlannedDurablePluginFileStoreJournalOperation({
      storeRoot: options.storeRoot,
      sessionId: journal.sessionId,
      operation: reconciled,
      ownerToken: options.ownerToken,
    });

    journal = replaceDurablePluginFileStoreJournalOperation(
      journal,
      Object.freeze({
        ...reconciled,
        status: 'applied',
      } satisfies DurablePluginFileStoreJournalOperation),
    );
    writeDurablePluginFileStoreJournal(options.journalPath, journal);
  }
}

function finalizeBatchedDurablePluginFileStoreJournal(options: {
  readonly storeRoot: string;
  readonly journalPath: string;
  readonly journal: DurablePluginFileStoreJournal;
  readonly progress?: DurablePluginFileStoreTransactionProgress;
  readonly faultInjector?: DurablePluginFileStoreFaultInjector;
}): void {
  preflightDurablePluginFileStoreJournal({
    storeRoot: options.storeRoot,
    journal: options.journal,
    appliedCount: options.progress?.appliedCount ?? 0,
  });

  const progress =
    options.progress ??
    createDurablePluginFileStoreTransactionProgress({
      storeRoot: options.storeRoot,
      journalPath: options.journalPath,
      journal: options.journal,
    });

  assertDurablePluginFileStoreProgressRevisions({
    storeRoot: options.storeRoot,
    journal: options.journal,
    progress,
  });

  let appliedCount = progress.appliedCount;
  const pathsSinceProgress = new Set<string>();

  for (
    let index = progress.appliedCount;
    index < options.journal.operations.length;
    index += 1
  ) {
    const operation = options.journal.operations[index];

    if (operation === undefined) {
      throw new TypeError(
        'Plugin fileStore transaction progress is malformed.',
      );
    }

    applyPlannedDurablePluginFileStoreJournalContent({
      storeRoot: options.storeRoot,
      sessionId: options.journal.sessionId,
      operation,
    });
    options.faultInjector?.('after_content_persisted');
    appliedCount += 1;
    pathsSinceProgress.add(`${operation.pluginId}\u0000${operation.path}`);
    const nextOperation = options.journal.operations[appliedCount];
    const nextPathKey =
      nextOperation === undefined
        ? undefined
        : `${nextOperation.pluginId}\u0000${nextOperation.path}`;

    if (
      appliedCount % 64 === 0 ||
      nextPathKey === undefined ||
      pathsSinceProgress.has(nextPathKey)
    ) {
      appendDurablePluginFileStoreTransactionProgress(
        options.journalPath,
        appliedCount,
      );
      pathsSinceProgress.clear();
    }
  }

  persistBatchedDurablePluginFileStoreMetadata({
    storeRoot: options.storeRoot,
    journal: options.journal,
    progress,
  });
  rmSync(options.journalPath, {force: true});
  rmSync(durablePluginFileStoreProgressPath(options.journalPath), {
    force: true,
  });
}

function preflightDurablePluginFileStoreJournal(options: {
  readonly storeRoot: string;
  readonly journal: DurablePluginFileStoreJournal;
  readonly appliedCount?: number;
}): void {
  const operationsByPath = new Map<
    string,
    DurablePluginFileStoreJournalOperation[]
  >();

  for (const operation of options.journal.operations) {
    const key = `${operation.pluginId}\u0000${operation.path}`;
    const pathOperations = operationsByPath.get(key);

    if (pathOperations === undefined) {
      operationsByPath.set(key, [operation]);
    } else {
      pathOperations.push(operation);
    }
  }

  for (const pathOperations of operationsByPath.values()) {
    const firstPending = pathOperations.find(operation =>
      options.appliedCount === undefined
        ? operation.status !== 'applied'
        : operation.index >= options.appliedCount,
    );
    const operation = firstPending ?? pathOperations[pathOperations.length - 1];

    if (operation === undefined) {
      continue;
    }

    const root = durablePluginRoot({
      storeRoot: options.storeRoot,
      sessionId: options.journal.sessionId,
      pluginId: operation.pluginId,
    });

    assertSafeDurablePluginPath(root, operation.path);
    const inspection = inspectDurableJournalOperationContent(
      join(root, operation.path),
      operation,
    );

    if (
      inspection.kind === 'conflict' ||
      (firstPending === undefined && inspection.kind !== 'after')
    ) {
      throwDurablePluginFileStoreTransactionConflict(operation);
    }
  }
}

function durablePluginFileStoreProgressPath(journalPath: string): string {
  return `${journalPath}${durableTransactionProgressSuffix}`;
}

function createDurablePluginFileStoreTransactionProgress(options: {
  readonly storeRoot: string;
  readonly journalPath: string;
  readonly journal: DurablePluginFileStoreJournal;
}): DurablePluginFileStoreTransactionProgress {
  const pluginIds = [
    ...new Set(options.journal.operations.map(operation => operation.pluginId)),
  ].sort((left, right) => left.localeCompare(right));
  const progress = Object.freeze({
    version: durableTransactionProgressVersion,
    eventId: options.journal.eventId,
    traceId: options.journal.traceId,
    createdAt: options.journal.createdAt,
    ownerNonce: options.journal.ownerNonce,
    sessionId: options.journal.sessionId,
    baseRevisions: Object.freeze(
      pluginIds.map(pluginId =>
        Object.freeze({
          pluginId,
          revision: baseDurablePluginFileStoreTransactionRevision({
            storeRoot: options.storeRoot,
            journal: options.journal,
            pluginId,
          }),
        }),
      ),
    ),
    appliedCount: 0,
  } satisfies DurablePluginFileStoreTransactionProgress);

  writeTextAtomic(
    durablePluginFileStoreProgressPath(options.journalPath),
    `${JSON.stringify(progress)}\n`,
  );
  return progress;
}

function baseDurablePluginFileStoreTransactionRevision(options: {
  readonly storeRoot: string;
  readonly journal: DurablePluginFileStoreJournal;
  readonly pluginId: string;
}): number {
  const root = durablePluginRoot({
    storeRoot: options.storeRoot,
    sessionId: options.journal.sessionId,
    pluginId: options.pluginId,
  });
  const persistedRevision = readPersistedDurableRevision(root);

  if (persistedRevision !== undefined) {
    const firstOperation = options.journal.operations[0];

    if (
      firstOperation?.pluginId === options.pluginId &&
      persistedRevision >=
        requiredJournalOperationRevision(firstOperation.afterRevision) &&
      durableJournalOperationMetadataMayAlreadyBeReflected({
        root,
        operation: firstOperation,
      })
    ) {
      return persistedRevision - 1;
    }

    return persistedRevision;
  }

  const firstOperation = options.journal.operations.find(
    operation => operation.pluginId === options.pluginId,
  );

  return firstOperation === undefined
    ? readDurableRevision(root)
    : requiredJournalOperationRevision(firstOperation.beforeRevision);
}

function durableJournalOperationMetadataMayAlreadyBeReflected(options: {
  readonly root: string;
  readonly operation: DurablePluginFileStoreJournalOperation;
}): boolean {
  const beforeHash = requiredJournalOperationString(
    options.operation.beforeHash,
  );
  const afterHash = requiredJournalOperationString(options.operation.afterHash);

  if (beforeHash === afterHash) {
    return true;
  }

  return (
    inspectDurableJournalOperationContent(
      join(options.root, options.operation.path),
      options.operation,
    ).kind === 'after'
  );
}

function readDurablePluginFileStoreTransactionProgress(
  journalPath: string,
  journal: DurablePluginFileStoreJournal,
): DurablePluginFileStoreTransactionProgress | undefined {
  let content: string;

  try {
    assertRegularFile(
      durablePluginFileStoreProgressPath(journalPath),
      'Plugin fileStore transaction progress',
    );
    content = readFileSync(
      durablePluginFileStoreProgressPath(journalPath),
      'utf8',
    );
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw error;
  }

  return parseDurablePluginFileStoreTransactionProgress(content, journal);
}

function appendDurablePluginFileStoreTransactionProgress(
  journalPath: string,
  appliedCount: number,
): void {
  const path = durablePluginFileStoreProgressPath(journalPath);
  const descriptor = openSync(path, 'a', 0o600);

  try {
    writeSync(descriptor, `${String(appliedCount)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertDurablePluginFileStoreProgressRevisions(options: {
  readonly storeRoot: string;
  readonly journal: DurablePluginFileStoreJournal;
  readonly progress: DurablePluginFileStoreTransactionProgress;
}): void {
  const operationCountByPlugin = new Map<string, number>();

  for (const operation of options.journal.operations) {
    operationCountByPlugin.set(
      operation.pluginId,
      (operationCountByPlugin.get(operation.pluginId) ?? 0) + 1,
    );
  }

  for (const base of options.progress.baseRevisions) {
    const root = durablePluginRoot({
      storeRoot: options.storeRoot,
      sessionId: options.journal.sessionId,
      pluginId: base.pluginId,
    });
    const currentRevision = readDurableRevision(root);
    const finalRevision =
      base.revision + (operationCountByPlugin.get(base.pluginId) ?? 0);

    if (
      currentRevision !== base.revision &&
      currentRevision !== finalRevision
    ) {
      throw new Error(
        `Plugin fileStore transaction conflict for ${base.pluginId}/revision.`,
      );
    }
  }
}

function applyPlannedDurablePluginFileStoreJournalContent(options: {
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly operation: DurablePluginFileStoreJournalOperation;
}): void {
  const root = durablePluginRoot({
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    pluginId: options.operation.pluginId,
  });

  assertSafeDurablePluginPath(root, options.operation.path);
  const filePath = join(root, options.operation.path);
  const contentState = classifyDurableJournalOperationContent(
    filePath,
    options.operation,
  );

  if (contentState.kind === 'after') {
    return;
  }

  if (options.operation.kind === 'write_json') {
    writeTextAtomic(
      filePath,
      requiredJournalOperationString(options.operation.afterContent),
    );
  } else {
    const remaining =
      contentState.kind === 'before'
        ? Buffer.from(
            requiredJournalOperationString(options.operation.appendedLine),
            'utf8',
          )
        : contentState.remaining;

    mkdirSync(dirname(filePath), {recursive: true});
    appendFileSync(filePath, remaining);
  }

  const sameContentWrite =
    options.operation.kind === 'write_json' &&
    requiredJournalOperationString(options.operation.beforeHash) ===
      requiredJournalOperationString(options.operation.afterHash);

  if (
    !sameContentWrite &&
    classifyDurableJournalOperationContent(filePath, options.operation).kind !==
      'after'
  ) {
    throwDurablePluginFileStoreTransactionConflict(options.operation);
  }
}

function persistBatchedDurablePluginFileStoreMetadata(options: {
  readonly storeRoot: string;
  readonly journal: DurablePluginFileStoreJournal;
  readonly progress: DurablePluginFileStoreTransactionProgress;
}): void {
  const operationsByPlugin = new Map<
    string,
    DurablePluginFileStoreJournalOperation[]
  >();

  for (const operation of options.journal.operations) {
    const operations = operationsByPlugin.get(operation.pluginId);

    if (operations === undefined) {
      operationsByPlugin.set(operation.pluginId, [operation]);
    } else {
      operations.push(operation);
    }
  }

  for (const base of options.progress.baseRevisions) {
    const operations = operationsByPlugin.get(base.pluginId) ?? [];
    const root = durablePluginRoot({
      storeRoot: options.storeRoot,
      sessionId: options.journal.sessionId,
      pluginId: base.pluginId,
    });
    const pathModes = readDurablePathModes(root);

    for (const operation of operations) {
      pathModes.set(
        operation.path,
        operation.kind === 'write_json' ? 'json' : 'jsonl',
      );
    }

    writeDurablePathModes(root, pathModes);
    writeDurableRevision(root, base.revision + operations.length);
  }
}

function materializeDurablePluginFileStoreJournal(options: {
  readonly storeRoot: string;
  readonly journal: DurablePluginFileStoreJournal;
}): DurablePluginFileStoreJournal {
  const virtualStores = new Map<
    string,
    {
      readonly appendStates: Map<
        string,
        {hash: Hash | undefined; length: number}
      >;
      readonly contents: Map<string, string | undefined>;
      readonly modes: Map<string, RuntimePluginFileStorePathMode>;
      readonly root: string;
      revision: number;
    }
  >();
  const operations: DurablePluginFileStoreJournalOperation[] = [];
  const materializedPaths = new Set<string>();

  for (const operation of options.journal.operations) {
    const storeKey = `${options.journal.sessionId}\u0000${operation.pluginId}`;
    let virtualStore = virtualStores.get(storeKey);

    if (virtualStore === undefined) {
      const root = durablePluginRoot({
        storeRoot: options.storeRoot,
        sessionId: options.journal.sessionId,
        pluginId: operation.pluginId,
      });

      assertSafeDurablePluginRoot(root);
      virtualStore = {
        appendStates: new Map(),
        contents: new Map(),
        modes: readDurablePathModes(root),
        root,
        revision: readDurableRevision(root),
      };
      virtualStores.set(storeKey, virtualStore);
    }

    assertSafeDurablePluginPath(virtualStore.root, operation.path);
    let beforeContent = virtualStore.contents.get(operation.path);

    if (!virtualStore.contents.has(operation.path)) {
      beforeContent = readOptionalRegularFile(
        join(virtualStore.root, operation.path),
      );
      virtualStore.contents.set(operation.path, beforeContent);
    }

    assertDurableOperationPathMode({
      filePath: join(virtualStore.root, operation.path),
      mode: virtualStore.modes.get(operation.path),
      operation,
    });

    let beforeHash: string;
    let plannedContent:
      | {
          readonly afterContent: string;
          readonly afterHash: string;
        }
      | {
          readonly afterHash: string;
          readonly afterLength: number;
          readonly appendedLine: string;
          readonly beforeLength: number;
        };

    if (operation.kind === 'write_json') {
      const afterContent = durableOperationAfterContent({
        beforeContent,
        operation,
      });

      beforeHash = hashOptionalFileContent(beforeContent);
      plannedContent = {
        afterContent,
        afterHash: hashOptionalFileContent(afterContent),
      };
      virtualStore.contents.set(operation.path, afterContent);
    } else {
      let appendState = virtualStore.appendStates.get(operation.path);

      if (appendState === undefined) {
        appendState = {
          hash:
            beforeContent === undefined
              ? undefined
              : createPresentFileContentHash(beforeContent),
          length:
            beforeContent === undefined ? 0 : Buffer.byteLength(beforeContent),
        };
        virtualStore.appendStates.set(operation.path, appendState);
      }

      beforeHash =
        appendState.hash === undefined
          ? hashOptionalFileContent(undefined)
          : appendState.hash.copy().digest('hex');
      const beforeLength = appendState.length;
      const appendedLine = `${JSON.stringify(operation.value)}\n`;

      if (appendState.hash === undefined) {
        appendState.hash = createPresentFileContentHash('');
      }

      appendState.hash.update(appendedLine);
      appendState.length += Buffer.byteLength(appendedLine);
      plannedContent = {
        afterHash: appendState.hash.copy().digest('hex'),
        afterLength: appendState.length,
        appendedLine,
        beforeLength,
      };
    }

    const operationPathKey = `${storeKey}\u0000${operation.path}`;

    if (
      !materializedPaths.has(operationPathKey) &&
      beforeHash !== operation.expectedBeforeHash
    ) {
      throwDurablePluginFileStoreTransactionConflict(operation);
    }

    materializedPaths.add(operationPathKey);
    const beforeRevision = virtualStore.revision;
    const planned = Object.freeze({
      ...operation,
      status: 'planned',
      beforeHash,
      ...plannedContent,
      beforeRevision,
      afterRevision: beforeRevision + 1,
    } satisfies DurablePluginFileStoreJournalOperation);

    operations.push(planned);
    virtualStore.modes.set(
      operation.path,
      operation.kind === 'write_json' ? 'json' : 'jsonl',
    );
    virtualStore.revision += 1;
  }

  return Object.freeze({
    ...options.journal,
    operations: Object.freeze(operations),
  } satisfies DurablePluginFileStoreJournal);
}

function reconcileDurableJournalOperationRevision(options: {
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly operation: DurablePluginFileStoreJournalOperation;
}): DurablePluginFileStoreJournalOperation {
  const root = durablePluginRoot({
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    pluginId: options.operation.pluginId,
  });

  assertSafeDurablePluginPath(root, options.operation.path);
  const contentState = classifyDurableJournalOperationContent(
    join(root, options.operation.path),
    options.operation,
  );

  if (contentState.kind === 'after') {
    return options.operation;
  }

  const currentRevision =
    contentState.kind === 'partial'
      ? (readPersistedDurableRevision(root) ??
        requiredJournalOperationRevision(options.operation.beforeRevision))
      : readDurableRevision(root);

  if (currentRevision === options.operation.beforeRevision) {
    return options.operation;
  }

  return Object.freeze({
    ...options.operation,
    beforeRevision: currentRevision,
    afterRevision: currentRevision + 1,
  } satisfies DurablePluginFileStoreJournalOperation);
}

function applyPlannedDurablePluginFileStoreJournalOperation(options: {
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly operation: DurablePluginFileStoreJournalOperation;
  readonly ownerToken: LocalRuntimeMutationLockOwnerToken;
  readonly faultInjector?: DurablePluginFileStoreFaultInjector;
}): void {
  const root = durablePluginRoot({
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    pluginId: options.operation.pluginId,
  });

  withDurablePluginStoreMutation(
    {
      storeRoot: options.storeRoot,
      root,
      ownerToken: options.ownerToken,
    },
    () => {
      assertSafeDurablePluginPath(root, options.operation.path);
      const filePath = join(root, options.operation.path);
      const contentState = classifyDurableJournalOperationContent(
        filePath,
        options.operation,
      );

      if (contentState.kind !== 'after') {
        if (options.operation.kind === 'write_json') {
          writeTextAtomic(
            filePath,
            requiredJournalOperationString(options.operation.afterContent),
          );
        } else {
          const appendedLine = requiredJournalOperationString(
            options.operation.appendedLine,
          );
          const remaining =
            contentState.kind === 'before'
              ? Buffer.from(appendedLine, 'utf8')
              : contentState.remaining;

          mkdirSync(dirname(filePath), {recursive: true});
          appendFileSync(filePath, remaining);
        }

        const sameContentWrite =
          options.operation.kind === 'write_json' &&
          requiredJournalOperationString(options.operation.beforeHash) ===
            requiredJournalOperationString(options.operation.afterHash);

        if (
          !sameContentWrite &&
          classifyDurableJournalOperationContent(filePath, options.operation)
            .kind !== 'after'
        ) {
          throwDurablePluginFileStoreTransactionConflict(options.operation);
        }

        options.faultInjector?.('after_content_persisted');
      }

      const pathModes = readDurablePathModes(root);
      pathModes.set(
        options.operation.path,
        options.operation.kind === 'write_json' ? 'json' : 'jsonl',
      );
      writeDurablePathModes(root, pathModes);

      const afterRevision = requiredJournalOperationRevision(
        options.operation.afterRevision,
      );
      const persistedRevision = readPersistedDurableRevision(root);
      const currentRevision = persistedRevision ?? readDurableRevision(root);

      if (persistedRevision === undefined || currentRevision < afterRevision) {
        writeDurableRevision(root, afterRevision);
      }
    },
  );
}

type DurableJournalOperationContentState =
  | {readonly kind: 'after'}
  | {readonly kind: 'before'}
  | {readonly kind: 'partial'; readonly remaining: Buffer};

type DurableJournalOperationContentInspection =
  DurableJournalOperationContentState | {readonly kind: 'conflict'};

function classifyDurableJournalOperationContent(
  filePath: string,
  operation: DurablePluginFileStoreJournalOperation,
): DurableJournalOperationContentState {
  const inspection = inspectDurableJournalOperationContent(filePath, operation);

  if (inspection.kind === 'conflict') {
    throwDurablePluginFileStoreTransactionConflict(operation);
  }

  return inspection;
}

function inspectDurableJournalOperationContent(
  filePath: string,
  operation: DurablePluginFileStoreJournalOperation,
): DurableJournalOperationContentInspection {
  const beforeHash = requiredJournalOperationString(operation.beforeHash);
  const afterHash = requiredJournalOperationString(operation.afterHash);
  const currentContent = readOptionalRegularFileBuffer(filePath);
  const currentHash = hashOptionalFileContent(currentContent);

  if (currentHash === beforeHash) {
    return {kind: 'before'};
  }

  if (currentHash === afterHash) {
    return {kind: 'after'};
  }

  if (operation.kind === 'write_json' || currentContent === undefined) {
    return {kind: 'conflict'};
  }

  const beforeLength = requiredJournalOperationRevision(operation.beforeLength);
  const afterLength = requiredJournalOperationRevision(operation.afterLength);
  const appendedLine = requiredJournalOperationString(operation.appendedLine);
  const current = currentContent;

  if (current.length < beforeLength || current.length >= afterLength) {
    return {kind: 'conflict'};
  }

  const prefix = current.subarray(0, beforeLength);
  const missingHash = hashOptionalFileContent(undefined);
  const prefixHash =
    beforeLength === 0 && beforeHash === missingHash
      ? missingHash
      : hashOptionalFileContent(prefix);
  const appended = Buffer.from(appendedLine, 'utf8');
  const suffix = current.subarray(beforeLength);

  if (
    prefixHash !== beforeHash ||
    suffix.length > appended.length ||
    !suffix.equals(appended.subarray(0, suffix.length))
  ) {
    return {kind: 'conflict'};
  }

  return {
    kind: 'partial',
    remaining: appended.subarray(suffix.length),
  };
}

function throwDurablePluginFileStoreTransactionConflict(
  operation: Pick<DurablePluginFileStoreJournalOperation, 'path' | 'pluginId'>,
): never {
  throw new Error(
    `Plugin fileStore transaction conflict for ${operation.pluginId}/${operation.path}.`,
  );
}

function replaceDurablePluginFileStoreJournalOperation(
  journal: DurablePluginFileStoreJournal,
  operation: DurablePluginFileStoreJournalOperation,
): DurablePluginFileStoreJournal {
  return Object.freeze({
    ...journal,
    operations: Object.freeze(
      journal.operations.map(item =>
        item.index === operation.index ? operation : item,
      ),
    ),
  } satisfies DurablePluginFileStoreJournal);
}

function readDurablePluginFileStoreJournalIfPresent(
  journalPath: string,
): DurablePluginFileStoreJournal | undefined {
  try {
    return readDurablePluginFileStoreJournal(journalPath);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw error;
  }
}

function durablePluginRootsForOperations(options: {
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly operations: readonly Pick<
    StagedPluginFileStoreOperation,
    'pluginId'
  >[];
}): readonly string[] {
  return Object.freeze(
    [
      ...new Set(
        options.operations.map(operation =>
          durablePluginRoot({
            storeRoot: options.storeRoot,
            sessionId: options.sessionId,
            pluginId: operation.pluginId,
          }),
        ),
      ),
    ].sort((left, right) => left.localeCompare(right)),
  );
}

function durablePluginRootsForJournal(
  storeRoot: string,
  journal: DurablePluginFileStoreJournal,
): readonly string[] {
  return durablePluginRootsForOperations({
    storeRoot,
    sessionId: journal.sessionId,
    operations: journal.operations,
  });
}

function assertJournalRootsAreLocked(
  storeRoot: string,
  journal: DurablePluginFileStoreJournal,
  lockedRoots: readonly string[],
): void {
  const currentRoots = durablePluginRootsForJournal(storeRoot, journal);

  if (
    currentRoots.length !== lockedRoots.length ||
    currentRoots.some((root, index) => root !== lockedRoots[index])
  ) {
    throw new TypeError(
      'Plugin fileStore transaction journal changed its plugin roots while locked.',
    );
  }
}

function directDurablePluginFileStoreJournalPath(root: string): string {
  return join(root, durableDirectMutationJournalFileName);
}

function recoverDirectDurablePluginFileStoreMutationsForOperationsLocked(options: {
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly operations: readonly Pick<
    DurablePluginFileStoreJournalOperation,
    'pluginId'
  >[];
  readonly ownerToken: LocalRuntimeMutationLockOwnerToken;
}): void {
  const pluginIds = [
    ...new Set(options.operations.map(operation => operation.pluginId)),
  ].sort((left, right) => left.localeCompare(right));

  for (const pluginId of pluginIds) {
    recoverDirectDurablePluginFileStoreMutationLocked({
      storeRoot: options.storeRoot,
      sessionId: options.sessionId,
      pluginId,
      root: durablePluginRoot({
        storeRoot: options.storeRoot,
        sessionId: options.sessionId,
        pluginId,
      }),
      ownerToken: options.ownerToken,
    });
  }
}

function recoverDirectDurablePluginFileStoreMutationLocked(options: {
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly pluginId: string;
  readonly root: string;
  readonly ownerToken: LocalRuntimeMutationLockOwnerToken;
}): void {
  const journalPath = directDurablePluginFileStoreJournalPath(options.root);
  const journal = readDurablePluginFileStoreJournalIfPresent(journalPath);

  if (journal === undefined) {
    return;
  }

  const operation = journal.operations[0];

  if (
    journal.sessionId !== options.sessionId ||
    journal.ownerHostname !== hostname() ||
    journal.eventId !== `direct:${journal.ownerNonce}` ||
    journal.traceId !== journal.eventId ||
    journal.operations.length !== 1 ||
    operation === undefined ||
    operation.pluginId !== options.pluginId ||
    operation.status !== 'planned'
  ) {
    throw new TypeError(
      'Plugin fileStore direct mutation journal is malformed.',
    );
  }

  applyPlannedDurablePluginFileStoreJournalOperation({
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    operation,
    ownerToken: options.ownerToken,
  });
  rmSync(journalPath, {force: true});
}

function createDurablePluginFileStoreJournalOwner(): Pick<
  DurablePluginFileStoreJournal,
  'ownerHostname' | 'ownerNonce' | 'ownerPid'
> {
  return Object.freeze({
    ownerHostname: hostname(),
    ownerNonce: randomUUID(),
    ownerPid: process.pid,
  });
}

function durablePluginJournalMutationResourceKey(options: {
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly identity: RuntimeEventIdentity;
}): string {
  return `plugin-journal:${durablePluginFileStoreTransactionJournalPath(
    options,
  )}`;
}

function assertJournalPathMatchesIdentity(
  storeRoot: string,
  journalPath: string,
  journal: DurablePluginFileStoreJournal,
): void {
  const expectedPath = durablePluginFileStoreTransactionJournalPath({
    storeRoot,
    sessionId: journal.sessionId,
    identity: journal,
  });

  if (journalPath !== expectedPath) {
    throw new TypeError(
      'Plugin fileStore transaction journal identity does not match its path.',
    );
  }
}

function assertJournalIdentityUnchanged(
  expected: DurablePluginFileStoreJournal,
  current: DurablePluginFileStoreJournal,
): void {
  if (
    expected.eventId !== current.eventId ||
    expected.traceId !== current.traceId ||
    expected.createdAt !== current.createdAt ||
    expected.sessionId !== current.sessionId ||
    expected.ownerPid !== current.ownerPid ||
    expected.ownerHostname !== current.ownerHostname ||
    expected.ownerNonce !== current.ownerNonce ||
    immutableJournalOperationsKey(expected) !==
      immutableJournalOperationsKey(current)
  ) {
    throw new TypeError(
      'Plugin fileStore transaction journal identity changed while locked.',
    );
  }
}

function immutableJournalOperationsKey(
  journal: DurablePluginFileStoreJournal,
): string {
  return canonicalJsonStringify(
    journal.operations.map(operation => ({
      index: operation.index,
      pluginId: operation.pluginId,
      path: operation.path,
      kind: operation.kind,
      value: operation.value,
      expectedBeforeHash: operation.expectedBeforeHash,
    })),
  );
}

export function recoverPreparedDurablePluginFileStoreTransactions(
  options: CreateRuntimePluginFileStoreOptions & {readonly storeRoot: string},
  ownerToken: LocalRuntimeMutationLockOwnerToken = createLocalRuntimeMutationLockOwnerToken(),
  recoveryOptions: {
    readonly recoverDirectMutation?: boolean;
  } = {},
): void {
  const sessionPaths = createLocalRuntimeSessionPaths(options);
  const root = durablePluginRoot({
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    pluginId: options.pluginId,
  });

  if (recoveryOptions.recoverDirectMutation !== false) {
    recoverDirectDurablePluginFileStoreMutation({
      storeRoot: options.storeRoot,
      sessionId: options.sessionId,
      pluginId: options.pluginId,
      root,
      ownerToken,
    });
  }
  const journalsRoot = join(
    sessionPaths.sessionRoot,
    durableTransactionDirectoryName,
  );

  let entries: Dirent[];

  try {
    assertSafeDurableTransactionJournalDirectory(journalsRoot);
    entries = readdirSync(journalsRoot, {withFileTypes: true});
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return;
    }

    throw error;
  }

  for (const entry of entries) {
    const journalPath = join(journalsRoot, entry.name);

    if (entry.isFile() && entry.name.endsWith('.tmp')) {
      if (parseAtomicReplacementFileName(entry.name) === undefined) {
        throw new TypeError(
          'Plugin fileStore transaction directory contains an unsupported temp file.',
        );
      }

      // Atomic temp names do not encode a hostname. Preserve them because a
      // PID alone cannot prove that another host no longer owns the write.
      continue;
    }

    if (entry.isFile() && isDurablePluginFileStoreProgressName(entry.name)) {
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      throw new TypeError(
        'Plugin fileStore transaction directory contains an unsupported entry.',
      );
    }

    if (activeDurableTransactionJournalPaths.has(journalPath)) {
      continue;
    }

    const journal = readDurablePluginFileStoreJournalIfPresent(journalPath);

    if (journal === undefined) {
      continue;
    }

    if (journal.sessionId !== sessionPaths.sessionId) {
      throw new TypeError('Plugin fileStore transaction session is malformed.');
    }

    assertJournalPathMatchesIdentity(options.storeRoot, journalPath, journal);

    if (journal.ownerHostname !== hostname()) {
      continue;
    }

    if (journal.ownerPid !== process.pid && processIsAlive(journal.ownerPid)) {
      continue;
    }

    const roots = durablePluginRootsForJournal(options.storeRoot, journal);
    const journalResourceKey = durablePluginJournalMutationResourceKey({
      storeRoot: options.storeRoot,
      sessionId: journal.sessionId,
      identity: journal,
    });

    withDurablePluginStoreMutations(
      {
        storeRoot: options.storeRoot,
        roots,
        resourceKeys: [journalResourceKey],
        ownerToken,
      },
      () => {
        const lockedJournal =
          readDurablePluginFileStoreJournalIfPresent(journalPath);

        if (lockedJournal === undefined) {
          return;
        }

        if (lockedJournal.sessionId !== sessionPaths.sessionId) {
          throw new TypeError(
            'Plugin fileStore transaction session is malformed.',
          );
        }

        assertJournalIdentityUnchanged(journal, lockedJournal);
        assertJournalPathMatchesIdentity(
          options.storeRoot,
          journalPath,
          lockedJournal,
        );
        assertJournalRootsAreLocked(options.storeRoot, lockedJournal, roots);
        recoverDirectDurablePluginFileStoreMutationsForOperationsLocked({
          storeRoot: options.storeRoot,
          sessionId: lockedJournal.sessionId,
          operations: lockedJournal.operations,
          ownerToken,
        });

        if (lockedJournal.ownerHostname !== hostname()) {
          return;
        }

        if (
          lockedJournal.ownerPid !== process.pid &&
          processIsAlive(lockedJournal.ownerPid)
        ) {
          return;
        }

        const terminal = durableRuntimeTerminalForJournal(
          sessionPaths,
          lockedJournal,
        );
        const progress = readDurablePluginFileStoreTransactionProgress(
          journalPath,
          lockedJournal,
        );

        if (terminal === 'completed') {
          finalizeLockedDurablePluginFileStoreJournal({
            storeRoot: options.storeRoot,
            journalPath,
            lockedRoots: roots,
            expectedJournalIdentity: lockedJournal,
            ownerToken,
          });
          return;
        }

        if (
          lockedJournal.operations.some(
            operation =>
              operation.status === 'applied' ||
              durableJournalOperationMayHaveApplied({
                storeRoot: options.storeRoot,
                sessionId: lockedJournal.sessionId,
                operation,
              }),
          ) ||
          (progress?.appliedCount ?? 0) > 0
        ) {
          throw new Error(
            'Plugin fileStore transaction is partially applied or changed without completed terminal evidence.',
          );
        }

        rmSync(durablePluginFileStoreProgressPath(journalPath), {
          force: true,
        });
        rmSync(journalPath, {force: true});
      },
    );
  }
}

function isDurablePluginFileStoreProgressName(name: string): boolean {
  return /^[0-9a-f]{64}\.json\.progress$/u.test(name);
}

function durableJournalOperationMayHaveApplied(options: {
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly operation: DurablePluginFileStoreJournalOperation;
}): boolean {
  const root = durablePluginRoot({
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    pluginId: options.operation.pluginId,
  });

  assertSafeDurablePluginPath(root, options.operation.path);
  const beforeHash = requiredJournalOperationString(
    options.operation.beforeHash,
  );
  const afterHash = requiredJournalOperationString(options.operation.afterHash);

  if (beforeHash === afterHash) {
    const persistedRevision = readPersistedDurableRevision(root);
    const afterRevision = requiredJournalOperationRevision(
      options.operation.afterRevision,
    );

    if (persistedRevision !== undefined && persistedRevision >= afterRevision) {
      return true;
    }
  }

  const inspection = inspectDurableJournalOperationContent(
    join(root, options.operation.path),
    options.operation,
  );

  return inspection.kind === 'after' || inspection.kind === 'partial';
}

function durableRuntimeTerminalForJournal(
  sessionPaths: LocalRuntimeSessionPaths,
  journal: Pick<
    DurablePluginFileStoreJournal,
    'createdAt' | 'eventId' | 'traceId'
  >,
): 'completed' | 'none' | 'rejected' {
  const terminal = findValidatedTerminalRawEventForSession(
    sessionPaths,
    journal,
  );

  if (terminal?.kind === 'runtime_turn_completed') {
    return 'completed';
  }

  return terminal?.kind === 'runtime_turn_rejected' ? 'rejected' : 'none';
}
