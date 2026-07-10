import type { Hash } from 'node:crypto';
import {
  appendFileSync,
  type Dirent,
  mkdirSync,
  readdirSync,
  rmSync
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { RuntimeEventIdentity } from '../../runtime/event.ts';
import { findValidatedTerminalRawEventForSession } from '../../runtime/storage/file-runtime-log-store.ts';
import {
  createLocalRuntimeSessionPaths,
  type LocalRuntimeSessionPaths
} from '../../runtime/storage/layout.ts';
import type {
  CreateRuntimePluginFileStoreOptions,
  RuntimePluginFileStorePathMode,
  RuntimePluginFileStorePreparedTransaction,
  StagedPluginFileStoreOperation
} from './contracts.ts';
import {
  assertDurableOperationPathMode,
  assertSafeDurablePluginPath,
  assertSafeDurablePluginRoot,
  assertSafeDurableTransactionJournalDirectory,
  createPresentFileContentHash,
  durableOperationAfterContent,
  durablePluginRoot,
  durableTransactionTempFileOwnerPid,
  hashOptionalFileContent,
  processIsAlive,
  readDurablePathModes,
  readDurableRevision,
  readOptionalRegularFile,
  readOptionalRegularFileBuffer,
  readPersistedDurableRevision,
  requiredJournalOperationRevision,
  requiredJournalOperationString,
  withDurablePluginStoreMutation,
  writeDurablePathModes,
  writeDurableRevision,
  writeTextAtomic
} from './durable-primitives.ts';
import { isMissingFileError } from './shared.ts';
import {
  assertDurableTransactionJournalDoesNotExist,
  durablePluginFileStoreTransactionJournalPath,
  durableTransactionJournalVersion,
  readDurablePluginFileStoreJournal,
  type DurablePluginFileStoreJournal,
  type DurablePluginFileStoreJournalOperation,
  writeDurablePluginFileStoreJournal
} from './wal-codec.ts';

const durableTransactionDirectoryName = '.plugin-transactions';
const activeDurableTransactionJournalPaths = new Set<string>();

export function prepareDurablePluginFileStoreTransaction(options: {
  readonly identity: RuntimeEventIdentity;
  readonly operations: readonly StagedPluginFileStoreOperation[];
  readonly sessionId: string;
  readonly storeRoot: string;
}): RuntimePluginFileStorePreparedTransaction {
  const journalPath = durablePluginFileStoreTransactionJournalPath({
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    identity: options.identity
  });
  const pendingJournal = Object.freeze({
    version: durableTransactionJournalVersion,
    eventId: options.identity.eventId,
    traceId: options.identity.traceId,
    createdAt: options.identity.createdAt,
    ownerPid: process.pid,
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
          status: 'pending'
        } satisfies DurablePluginFileStoreJournalOperation)
      )
    )
  } satisfies DurablePluginFileStoreJournal);
  const journal = materializeDurablePluginFileStoreJournal({
    storeRoot: options.storeRoot,
    journal: pendingJournal
  });

  assertDurableTransactionJournalDoesNotExist(journalPath);
  writeDurablePluginFileStoreJournal(journalPath, journal);
  activeDurableTransactionJournalPaths.add(journalPath);

  let state:
    | 'discarded'
    | 'finalized'
    | 'finalizing'
    | 'prepared'
    | 'recovery_required' = 'prepared';

  return Object.freeze({
    discard() {
      if (state !== 'prepared') {
        return;
      }

      activeDurableTransactionJournalPaths.delete(journalPath);
      rmSync(journalPath, { force: true });
      state = 'discarded';
    },
    finalize() {
      if (
        state === 'discarded' ||
        state === 'finalized' ||
        state === 'finalizing'
      ) {
        return;
      }

      activeDurableTransactionJournalPaths.delete(journalPath);
      state = 'finalizing';

      try {
        finalizeDurablePluginFileStoreJournal({
          storeRoot: options.storeRoot,
          journalPath
        });
        state = 'finalized';
      } catch (error: unknown) {
        state = 'recovery_required';
        throw error;
      }
    }
  } satisfies RuntimePluginFileStorePreparedTransaction);
}

function finalizeDurablePluginFileStoreJournal(options: {
  readonly storeRoot: string;
  readonly journalPath: string;
}): void {
  for (;;) {
    let journal = readDurablePluginFileStoreJournal(options.journalPath);
    const operation = journal.operations.find(
      (item) => item.status !== 'applied'
    );

    if (operation === undefined) {
      rmSync(options.journalPath, { force: true });
      return;
    }

    const current = journal.operations[operation.index];

    if (current === undefined || current.status === 'pending') {
      throw new Error('Plugin fileStore transaction journal was not materialized.');
    }

    const reconciled = reconcileDurableJournalOperationRevision({
      storeRoot: options.storeRoot,
      sessionId: journal.sessionId,
      operation: current
    });

    if (reconciled !== current) {
      journal = replaceDurablePluginFileStoreJournalOperation(
        journal,
        reconciled
      );
      writeDurablePluginFileStoreJournal(options.journalPath, journal);
    }

    applyPlannedDurablePluginFileStoreJournalOperation({
      storeRoot: options.storeRoot,
      sessionId: journal.sessionId,
      operation: reconciled
    });

    journal = replaceDurablePluginFileStoreJournalOperation(
      journal,
      Object.freeze({
        ...reconciled,
        status: 'applied'
      } satisfies DurablePluginFileStoreJournalOperation)
    );
    writeDurablePluginFileStoreJournal(options.journalPath, journal);
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
        { hash: Hash | undefined; length: number }
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
        pluginId: operation.pluginId
      });

      assertSafeDurablePluginRoot(root);
      virtualStore = {
        appendStates: new Map(),
        contents: new Map(),
        modes: readDurablePathModes(root),
        root,
        revision: readDurableRevision(root)
      };
      virtualStores.set(storeKey, virtualStore);
    }

    assertSafeDurablePluginPath(virtualStore.root, operation.path);
    let beforeContent = virtualStore.contents.get(operation.path);

    if (!virtualStore.contents.has(operation.path)) {
      beforeContent = readOptionalRegularFile(
        join(virtualStore.root, operation.path)
      );
      virtualStore.contents.set(operation.path, beforeContent);
    }

    assertDurableOperationPathMode({
      filePath: join(virtualStore.root, operation.path),
      mode: virtualStore.modes.get(operation.path),
      operation
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
        operation
      });

      beforeHash = hashOptionalFileContent(beforeContent);
      plannedContent = {
        afterContent,
        afterHash: hashOptionalFileContent(afterContent)
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
            beforeContent === undefined ? 0 : Buffer.byteLength(beforeContent)
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
        beforeLength
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
      afterRevision: beforeRevision + 1
    } satisfies DurablePluginFileStoreJournalOperation);

    operations.push(planned);
    virtualStore.modes.set(
      operation.path,
      operation.kind === 'write_json' ? 'json' : 'jsonl'
    );
    virtualStore.revision += 1;
  }

  return Object.freeze({
    ...options.journal,
    operations: Object.freeze(operations)
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
    pluginId: options.operation.pluginId
  });

  assertSafeDurablePluginPath(root, options.operation.path);
  const contentState = classifyDurableJournalOperationContent(
    join(root, options.operation.path),
    options.operation
  );

  if (contentState.kind === 'after') {
    return options.operation;
  }

  const currentRevision =
    contentState.kind === 'partial'
      ? readPersistedDurableRevision(root) ??
        requiredJournalOperationRevision(options.operation.beforeRevision)
      : readDurableRevision(root);

  if (currentRevision === options.operation.beforeRevision) {
    return options.operation;
  }

  return Object.freeze({
    ...options.operation,
    beforeRevision: currentRevision,
    afterRevision: currentRevision + 1
  } satisfies DurablePluginFileStoreJournalOperation);
}

function applyPlannedDurablePluginFileStoreJournalOperation(options: {
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly operation: DurablePluginFileStoreJournalOperation;
}): void {
  const root = durablePluginRoot({
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    pluginId: options.operation.pluginId
  });

  withDurablePluginStoreMutation(root, () => {
    assertSafeDurablePluginPath(root, options.operation.path);
    const filePath = join(root, options.operation.path);
    const contentState = classifyDurableJournalOperationContent(
      filePath,
      options.operation
    );

    if (contentState.kind !== 'after') {
      if (options.operation.kind === 'write_json') {
        writeTextAtomic(
          filePath,
          requiredJournalOperationString(options.operation.afterContent)
        );
      } else {
        const appendedLine = requiredJournalOperationString(
          options.operation.appendedLine
        );
        const remaining =
          contentState.kind === 'before'
            ? Buffer.from(appendedLine, 'utf8')
            : contentState.remaining;

        mkdirSync(dirname(filePath), { recursive: true });
        appendFileSync(filePath, remaining);
      }

      if (
        classifyDurableJournalOperationContent(filePath, options.operation)
          .kind !== 'after'
      ) {
        throwDurablePluginFileStoreTransactionConflict(options.operation);
      }
    }

    const pathModes = readDurablePathModes(root);
    pathModes.set(
      options.operation.path,
      options.operation.kind === 'write_json' ? 'json' : 'jsonl'
    );
    writeDurablePathModes(root, pathModes);

    const afterRevision = requiredJournalOperationRevision(
      options.operation.afterRevision
    );
    const currentRevision = readDurableRevision(root);

    if (currentRevision < afterRevision) {
      writeDurableRevision(root, afterRevision);
    }
  });
}

type DurableJournalOperationContentState =
  | { readonly kind: 'after' }
  | { readonly kind: 'before' }
  | { readonly kind: 'partial'; readonly remaining: Buffer };

type DurableJournalOperationContentInspection =
  | DurableJournalOperationContentState
  | { readonly kind: 'conflict' };

function classifyDurableJournalOperationContent(
  filePath: string,
  operation: DurablePluginFileStoreJournalOperation
): DurableJournalOperationContentState {
  const inspection = inspectDurableJournalOperationContent(
    filePath,
    operation
  );

  if (inspection.kind === 'conflict') {
    throwDurablePluginFileStoreTransactionConflict(operation);
  }

  return inspection;
}

function inspectDurableJournalOperationContent(
  filePath: string,
  operation: DurablePluginFileStoreJournalOperation
): DurableJournalOperationContentInspection {
  const beforeHash = requiredJournalOperationString(operation.beforeHash);
  const afterHash = requiredJournalOperationString(operation.afterHash);
  const currentContent = readOptionalRegularFileBuffer(filePath);
  const currentHash = hashOptionalFileContent(currentContent);

  if (currentHash === beforeHash) {
    return { kind: 'before' };
  }

  if (currentHash === afterHash) {
    return { kind: 'after' };
  }

  if (operation.kind === 'write_json' || currentContent === undefined) {
    return { kind: 'conflict' };
  }

  const beforeLength = requiredJournalOperationRevision(operation.beforeLength);
  const afterLength = requiredJournalOperationRevision(operation.afterLength);
  const appendedLine = requiredJournalOperationString(operation.appendedLine);
  const current = currentContent;

  if (current.length < beforeLength || current.length >= afterLength) {
    return { kind: 'conflict' };
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
    return { kind: 'conflict' };
  }

  return {
    kind: 'partial',
    remaining: appended.subarray(suffix.length)
  };
}

function throwDurablePluginFileStoreTransactionConflict(
  operation: Pick<DurablePluginFileStoreJournalOperation, 'path' | 'pluginId'>
): never {
  throw new Error(
    `Plugin fileStore transaction conflict for ${operation.pluginId}/${operation.path}.`
  );
}

function replaceDurablePluginFileStoreJournalOperation(
  journal: DurablePluginFileStoreJournal,
  operation: DurablePluginFileStoreJournalOperation
): DurablePluginFileStoreJournal {
  return Object.freeze({
    ...journal,
    operations: Object.freeze(
      journal.operations.map((item) =>
        item.index === operation.index ? operation : item
      )
    )
  } satisfies DurablePluginFileStoreJournal);
}

export function recoverPreparedDurablePluginFileStoreTransactions(
  options: CreateRuntimePluginFileStoreOptions & { readonly storeRoot: string }
): void {
  const sessionPaths = createLocalRuntimeSessionPaths(options);
  const journalsRoot = join(
    sessionPaths.sessionRoot,
    durableTransactionDirectoryName
  );

  let entries: Dirent[];

  try {
    assertSafeDurableTransactionJournalDirectory(journalsRoot);
    entries = readdirSync(journalsRoot, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return;
    }

    throw error;
  }

  for (const entry of entries) {
    const journalPath = join(journalsRoot, entry.name);

    if (entry.isFile() && entry.name.endsWith('.tmp')) {
      const ownerPid = durableTransactionTempFileOwnerPid(entry.name);

      if (ownerPid === undefined) {
        throw new TypeError(
          'Plugin fileStore transaction directory contains an unsupported temp file.'
        );
      }

      if (processIsAlive(ownerPid)) {
        continue;
      }

      rmSync(journalPath, { force: true });
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      throw new TypeError(
        'Plugin fileStore transaction directory contains an unsupported entry.'
      );
    }

    if (activeDurableTransactionJournalPaths.has(journalPath)) {
      continue;
    }

    const journal = readDurablePluginFileStoreJournal(journalPath);

    if (journal.sessionId !== sessionPaths.sessionId) {
      throw new TypeError('Plugin fileStore transaction session is malformed.');
    }

    if (journal.ownerPid !== process.pid && processIsAlive(journal.ownerPid)) {
      continue;
    }

    const terminal = durableRuntimeTerminalForJournal(sessionPaths, journal);

    if (terminal === 'completed') {
      finalizeDurablePluginFileStoreJournal({
        storeRoot: options.storeRoot,
        journalPath
      });
      continue;
    }

    if (
      journal.operations.some(
        (operation) =>
          operation.status === 'applied' ||
          durableJournalOperationMayHaveApplied({
            storeRoot: options.storeRoot,
            sessionId: journal.sessionId,
            operation
          })
      )
    ) {
      throw new Error(
        'Plugin fileStore transaction is partially applied or changed without completed terminal evidence.'
      );
    }

    rmSync(journalPath, { force: true });
  }
}

function durableJournalOperationMayHaveApplied(options: {
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly operation: DurablePluginFileStoreJournalOperation;
}): boolean {
  const root = durablePluginRoot({
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    pluginId: options.operation.pluginId
  });

  assertSafeDurablePluginPath(root, options.operation.path);
  const beforeHash = requiredJournalOperationString(
    options.operation.beforeHash
  );
  const afterHash = requiredJournalOperationString(options.operation.afterHash);

  if (beforeHash === afterHash) {
    const persistedRevision = readPersistedDurableRevision(root);
    const afterRevision = requiredJournalOperationRevision(
      options.operation.afterRevision
    );

    if (
      persistedRevision !== undefined &&
      persistedRevision >= afterRevision
    ) {
      return true;
    }
  }

  const inspection = inspectDurableJournalOperationContent(
    join(root, options.operation.path),
    options.operation
  );

  return inspection.kind === 'after' || inspection.kind === 'partial';
}

function durableRuntimeTerminalForJournal(
  sessionPaths: LocalRuntimeSessionPaths,
  journal: Pick<
    DurablePluginFileStoreJournal,
    'createdAt' | 'eventId' | 'traceId'
  >
): 'completed' | 'none' | 'rejected' {
  const terminal = findValidatedTerminalRawEventForSession(
    sessionPaths,
    journal
  );

  if (terminal?.kind === 'runtime_turn_completed') {
    return 'completed';
  }

  return terminal?.kind === 'runtime_turn_rejected' ? 'rejected' : 'none';
}
