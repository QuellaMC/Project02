import {randomUUID} from 'node:crypto';
import {dirname, join} from 'node:path';
import {hostname} from 'node:os';

import {
  appendBytesFileSync,
  makeDirectorySync,
  removePathSync,
} from '../../../shared/file-system.ts';
import {type LocalRuntimeMutationLockOwnerToken} from '../mutation-lock.ts';
import {
  assertDurableOperationPathMode,
  assertSafeDurablePluginPath,
  assertSafeDurablePluginRoot,
  durableOperationAfterContent,
  durablePluginRoot,
  hashOptionalFileContent,
  readDurablePathModes,
  readDurableRevision,
  readOptionalRegularFile,
  readOptionalRegularFileBuffer,
  readPersistedDurableRevision,
  withDurablePluginStoreMutation,
  writeDurablePathModes,
  writeDurableRevision,
  writeTextAtomic,
} from './durable-primitives.ts';
import type {RuntimePluginJsonValue} from '../../../plugins/index.ts';
import {discardTornJsonLineTail} from '../json-lines.ts';
import {
  durableDirectMutationJournalFileName,
  isMissingFileError,
} from './shared.ts';
import {
  durableTransactionJournalVersion,
  readDurablePluginFileStoreJournal,
  type DurablePluginFileStoreJournal,
  type DurablePluginFileStoreJournalOperation,
  writeDurablePluginFileStoreJournal,
} from './wal-codec.ts';

export type DurablePluginFileStoreFaultPoint = 'after_content_persisted';

export type DurablePluginFileStoreFaultInjector = (
  point: DurablePluginFileStoreFaultPoint,
) => void;

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

      const journal = Object.freeze({
        version: durableTransactionJournalVersion,
        ...createDurablePluginFileStoreJournalOwner(),
        sessionId: options.sessionId,
        operation: planDurablePluginFileStoreOperation(options),
      } satisfies DurablePluginFileStoreJournal);
      const journalPath = directDurablePluginFileStoreJournalPath(options.root);

      writeDurablePluginFileStoreJournal(journalPath, journal);
      applyPlannedDurablePluginFileStoreJournalOperation({
        storeRoot: options.storeRoot,
        sessionId: options.sessionId,
        operation: journal.operation,
        ownerToken: options.ownerToken,
        ...(options.faultInjector === undefined
          ? {}
          : {faultInjector: options.faultInjector}),
      });
      removePathSync(journalPath, {force: true});
    },
  );
}

/**
 * Reads the target file once and records what the write will turn it into, so
 * a crash between the journal and the write leaves enough to finish the job.
 */
function planDurablePluginFileStoreOperation(options: {
  readonly root: string;
  readonly pluginId: string;
  readonly kind: 'append_jsonl' | 'write_json';
  readonly path: string;
  readonly value: RuntimePluginJsonValue;
}): DurablePluginFileStoreJournalOperation {
  assertSafeDurablePluginRoot(options.root);
  assertSafeDurablePluginPath(options.root, options.path);

  const filePath = join(options.root, options.path);

  // Validate before touching anything: truncating a torn tail is a write,
  // and an operation this gate rejects must not have already changed the
  // file it was rejected for.
  assertDurableOperationPathMode({
    filePath,
    mode: readDurablePathModes(options.root).get(options.path),
    operation: options,
  });

  // Before the bytes this journal is planned against are read. A write
  // replaces the file, so only an append can splice onto a torn tail.
  if (options.kind === 'append_jsonl') {
    discardTornJsonLineTail(filePath);
  }

  const beforeContent = readOptionalRegularFile(filePath);

  const beforeRevision = readDurableRevision(options.root);
  const common = {
    pluginId: options.pluginId,
    path: options.path,
    value: options.value,
    beforeHash: hashOptionalFileContent(beforeContent),
    beforeRevision,
    afterRevision: beforeRevision + 1,
  };

  if (options.kind === 'write_json') {
    const afterContent = durableOperationAfterContent({
      beforeContent,
      operation: options,
    });

    return Object.freeze({
      ...common,
      kind: options.kind,
      afterHash: hashOptionalFileContent(afterContent),
      afterContent,
    });
  }

  const appendedLine = `${JSON.stringify(options.value)}\n`;
  const beforeLength =
    beforeContent === undefined ? 0 : Buffer.byteLength(beforeContent);

  return Object.freeze({
    ...common,
    kind: options.kind,
    afterHash: hashOptionalFileContent(`${beforeContent ?? ''}${appendedLine}`),
    beforeLength,
    appendedLine,
    afterLength: beforeLength + Buffer.byteLength(appendedLine),
  });
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
          writeTextAtomic(filePath, options.operation.afterContent);
        } else {
          const remaining =
            contentState.kind === 'before'
              ? Buffer.from(options.operation.appendedLine, 'utf8')
              : contentState.remaining;

          makeDirectorySync(dirname(filePath), {recursive: true});
          appendBytesFileSync(filePath, remaining);
        }

        // A write_json that rewrites identical content leaves the file at its
        // before-hash, which is also its after-hash; there is nothing to verify.
        const sameContentWrite =
          options.operation.kind === 'write_json' &&
          options.operation.beforeHash === options.operation.afterHash;

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

      const afterRevision = options.operation.afterRevision;
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
  const {beforeHash, afterHash} = operation;
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

  const {beforeLength, afterLength, appendedLine} = operation;
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

function directDurablePluginFileStoreJournalPath(root: string): string {
  return join(root, durableDirectMutationJournalFileName);
}

export function recoverDirectDurablePluginFileStoreMutationLocked(options: {
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

  // The journal lives inside the plugin root it describes, so a journal
  // naming a different session, host, or plugin is not this store's.
  if (
    journal.sessionId !== options.sessionId ||
    journal.ownerHostname !== hostname() ||
    journal.operation.pluginId !== options.pluginId
  ) {
    throw new TypeError(
      'Plugin fileStore direct mutation journal is malformed.',
    );
  }

  applyPlannedDurablePluginFileStoreJournalOperation({
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    operation: journal.operation,
    ownerToken: options.ownerToken,
  });
  removePathSync(journalPath, {force: true});
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
