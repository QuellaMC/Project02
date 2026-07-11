import { appendFileSync } from 'node:fs';
import {
  createLocalRuntimeSessionPaths,
  createLocalRuntimeStorageLayout,
  LocalRuntimeStorageContractError,
  type LocalRuntimeSessionPathsOptions
} from './layout-contract.ts';
import {
  decodeConversationLogRecord,
  encodeConversationLogRecord
} from './conversation-codec.ts';
import {
  decodeRawEventLogRecord,
  encodeRawEventLogRecord
} from './raw-event-codec.ts';
import {
  decodeRuntimeTraceEntry,
  encodeRuntimeTraceEntry
} from './trace-codec.ts';
import type { RuntimeLogStore } from '../log.ts';
import { assertLocalRuntimeSessionReadable } from './session-store.ts';
import {
  localRuntimeMutationLockResourceIsOwnedByCurrentProcess,
  type LocalRuntimeMutationLockOwnerToken
} from './mutation-lock.ts';
import type {
  CachedRuntimeSessionEvidence,
  DurableRuntimeSessionEvidence,
  RuntimeEvidenceIncrementalState
} from './runtime-evidence-contract.ts';
import {
  createMutableDurableRuntimeSessionEvidence,
  readCoherentRuntimeSessionEvidence,
  readRuntimeEvidenceFileStamps,
  sameRuntimeEvidenceFileStamps,
  scavengeAbandonedRuntimeEvidenceTemporaryFiles
} from './runtime-evidence-cache.ts';
import {
  applyIncrementalConversationAppend,
  applyIncrementalConversationRemoval,
  applyIncrementalRawEventAppend,
  applyIncrementalTraceAppend,
  assertIncrementalConversationAppend,
  assertIncrementalRawEventAppend,
  assertIncrementalStatePublicReadable,
  assertIncrementalTraceAppend,
  createRuntimeEvidenceIncrementalState
} from './runtime-evidence-validation.ts';
import {
  createRuntimeSessionEvidenceSnapshot,
  recoverAbandonedRuntimeWriterEvidence,
  removeConversationLogRecords
} from './runtime-evidence-recovery.ts';

export { findValidatedTerminalRawEventForSession } from './runtime-evidence-validation.ts';

export type CreateFileRuntimeLogStoreOptions = LocalRuntimeSessionPathsOptions & {
  readonly writerLockOwnerToken?: LocalRuntimeMutationLockOwnerToken;
  readonly onEvidenceValidation?: (
    mode: 'cold_snapshot' | 'incremental_append'
  ) => void;
  readonly onEvidenceFileRead?: (event: {
    readonly filePath: string;
    readonly attempt: number;
  }) => void;
};

export function createFileRuntimeLogStore(
  options: CreateFileRuntimeLogStoreOptions = {}
): RuntimeLogStore {
  const paths = createLocalRuntimeSessionPaths(options);
  const layout = createLocalRuntimeStorageLayout({ storeRoot: paths.storeRoot });
  let cachedEvidence: CachedRuntimeSessionEvidence | undefined;
  let incrementalState: RuntimeEvidenceIncrementalState | undefined;
  let writerRecoveryChecked = false;
  let sessionReadabilityChecked = false;
  let temporaryFilesScavenged = false;
  const assertSessionReadable = (): void => {
    if (sessionReadabilityChecked) {
      return;
    }

    assertLocalRuntimeSessionReadable({
      ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
      sessionId: paths.sessionId
    });
    sessionReadabilityChecked = true;
  };
  const assertWriterOwnership = (): void => {
    if (
      localRuntimeMutationLockResourceIsOwnedByCurrentProcess({
        locksRoot: layout.locksRoot,
        resourceKey: `session-writer:${paths.sessionId}`
      })
    ) {
      return;
    }

    throw new LocalRuntimeStorageContractError(
      'session_busy',
      `Durable runtime mutation requires the active session writer lease: ${paths.sessionId}.`
    );
  };
  const refreshStoredEvidence = (): DurableRuntimeSessionEvidence => {
    const currentStamps = readRuntimeEvidenceFileStamps(paths);

    if (
      cachedEvidence !== undefined &&
      sameRuntimeEvidenceFileStamps(cachedEvidence.stamps, currentStamps)
    ) {
      return cachedEvidence.evidence;
    }

    const loaded = readCoherentRuntimeSessionEvidence(
      paths,
      options.onEvidenceFileRead
    );
    cachedEvidence = loaded;
    incrementalState = undefined;
    writerRecoveryChecked = false;
    return loaded.evidence;
  };
  const readStoredEvidence = (): DurableRuntimeSessionEvidence => {
    const writerIsActive = localRuntimeMutationLockResourceIsOwnedByCurrentProcess({
      locksRoot: layout.locksRoot,
      resourceKey: `session-writer:${paths.sessionId}`
    });

    if (writerIsActive && !temporaryFilesScavenged) {
      scavengeAbandonedRuntimeEvidenceTemporaryFiles(paths);
      temporaryFilesScavenged = true;
    }

    if (writerIsActive && cachedEvidence !== undefined) {
      return cachedEvidence.evidence;
    }

    return refreshStoredEvidence();
  };
  const ensureIncrementalState = (
    evidence: DurableRuntimeSessionEvidence
  ): RuntimeEvidenceIncrementalState => {
    if (incrementalState === undefined) {
      options.onEvidenceValidation?.('cold_snapshot');
      incrementalState = createRuntimeEvidenceIncrementalState(paths, evidence);
    }

    return incrementalState;
  };
  const replaceCachedEvidence = (evidence: DurableRuntimeSessionEvidence): void => {
    cachedEvidence = {
      evidence: createMutableDurableRuntimeSessionEvidence(evidence),
      stamps: readRuntimeEvidenceFileStamps(paths)
    };
    incrementalState = undefined;
  };
  const invalidateCachedEvidence = (): void => {
    cachedEvidence = undefined;
    incrementalState = undefined;
    writerRecoveryChecked = false;
  };

  return Object.freeze({
    localRuntimeSessionPaths: paths,
    ...(options.writerLockOwnerToken === undefined
      ? {}
      : { localRuntimeWriterLockOwnerToken: options.writerLockOwnerToken }),
    appendTrace(entry) {
      const encoded = encodeRuntimeTraceEntry(entry);
      const storedEntry = decodeRuntimeTraceEntry(encoded);
      const evidence = readStoredEvidence();
      const state = ensureIncrementalState(evidence);

      assertSessionReadable();
      assertWriterOwnership();
      options.onEvidenceValidation?.('incremental_append');
      assertIncrementalTraceAppend(state, storedEntry);

      try {
        appendJsonLine(paths.tracePath, encodeRuntimeTraceEntry(storedEntry));
        cachedEvidence?.evidence.traceEntries.push(storedEntry);
        applyIncrementalTraceAppend(state, storedEntry);
      } catch (error: unknown) {
        invalidateCachedEvidence();
        throw error;
      }

      return storedEntry;
    },
    appendRawEvent(record) {
      const encoded = encodeRawEventLogRecord(record);
      const storedRecord = decodeRawEventLogRecord(encoded);
      const evidence = readStoredEvidence();
      const state = ensureIncrementalState(evidence);

      assertSessionReadable();
      assertWriterOwnership();
      options.onEvidenceValidation?.('incremental_append');
      assertIncrementalRawEventAppend({
        paths,
        evidence,
        state,
        record: storedRecord
      });

      try {
        appendJsonLine(paths.rawEventsPath, encodeRawEventLogRecord(storedRecord));
        cachedEvidence?.evidence.rawEvents.push(storedRecord);
        applyIncrementalRawEventAppend({
          evidence,
          state,
          record: storedRecord
        });
      } catch (error: unknown) {
        invalidateCachedEvidence();
        throw error;
      }

      return storedRecord;
    },
    appendConversationMessage(record) {
      const encoded = encodeConversationLogRecord(record);
      const storedRecord = decodeConversationLogRecord(encoded);
      const evidence = readStoredEvidence();
      const state = ensureIncrementalState(evidence);

      assertSessionReadable();
      assertWriterOwnership();
      options.onEvidenceValidation?.('incremental_append');
      assertIncrementalConversationAppend({
        paths,
        state,
        evidence,
        record: storedRecord
      });

      try {
        appendJsonLine(
          paths.conversationPath,
          encodeConversationLogRecord(storedRecord)
        );
        cachedEvidence?.evidence.conversationMessages.push(storedRecord);
        applyIncrementalConversationAppend(state, storedRecord);
      } catch (error: unknown) {
        invalidateCachedEvidence();
        throw error;
      }

      return storedRecord;
    },
    recoverAbandonedWriterEvidence() {
      assertSessionReadable();
      assertWriterOwnership();

      if (writerRecoveryChecked) {
        return false;
      }

      const cacheBeforeRefresh = cachedEvidence;
      const evidence = refreshStoredEvidence();

      if (
        cacheBeforeRefresh === cachedEvidence &&
        incrementalState !== undefined &&
        incrementalState.openRawIdentity === undefined &&
        incrementalState.traceStartedWithoutRaw.size === 0 &&
        incrementalState.missingStoredTerminalTraceEvidence.size === 0
      ) {
        writerRecoveryChecked = true;
        return false;
      }

      let recovered: DurableRuntimeSessionEvidence | undefined;

      try {
        recovered = recoverAbandonedRuntimeWriterEvidence({ paths, evidence });

        if (recovered === undefined) {
          ensureIncrementalState(evidence);
        }
      } catch (error: unknown) {
        if (
          error instanceof LocalRuntimeStorageContractError &&
          error.code === 'partial_write'
        ) {
          throw error;
        }

        throw new LocalRuntimeStorageContractError(
          'partial_write',
          `Local runtime evidence cannot safely recover the abandoned writer for session "${paths.sessionId}".`,
          { cause: error }
        );
      }

      writerRecoveryChecked = true;

      if (recovered === undefined) {
        return false;
      }

      replaceCachedEvidence(recovered);
      ensureIncrementalState(cachedEvidence?.evidence ?? recovered);
      writerRecoveryChecked = true;
      return true;
    },
    checkpointWriterEvidence() {
      assertWriterOwnership();

      if (cachedEvidence !== undefined) {
        cachedEvidence = {
          evidence: cachedEvidence.evidence,
          stamps: readRuntimeEvidenceFileStamps(paths)
        };
      }

      writerRecoveryChecked = false;
    },
    removeConversationMessages(messageIds) {
      assertSessionReadable();
      assertWriterOwnership();
      const evidence = readStoredEvidence();
      const state = ensureIncrementalState(evidence);
      const updated = removeConversationLogRecords({
        paths,
        evidence,
        messageIds
      });

      if (updated !== undefined) {
        cachedEvidence = {
          evidence: createMutableDurableRuntimeSessionEvidence(updated),
          stamps: readRuntimeEvidenceFileStamps(paths)
        };
        applyIncrementalConversationRemoval(state, messageIds);
      }
    },
    readSessionEvidence() {
      assertSessionReadable();
      const evidence = readStoredEvidence();
      assertIncrementalStatePublicReadable(ensureIncrementalState(evidence));
      return createRuntimeSessionEvidenceSnapshot(evidence);
    },
    traceEntries() {
      assertSessionReadable();
      const evidence = readStoredEvidence();
      assertIncrementalStatePublicReadable(ensureIncrementalState(evidence));
      return Object.freeze([...evidence.traceEntries]);
    },
    rawEvents() {
      assertSessionReadable();
      const evidence = readStoredEvidence();
      assertIncrementalStatePublicReadable(ensureIncrementalState(evidence));
      return Object.freeze([...evidence.rawEvents]);
    },
    conversationMessages() {
      assertSessionReadable();
      const evidence = readStoredEvidence();
      assertIncrementalStatePublicReadable(ensureIncrementalState(evidence));
      return Object.freeze([...evidence.conversationMessages]);
    }
  } satisfies RuntimeLogStore);
}

function appendJsonLine(filePath: string, line: string): void {
  try {
    appendFileSync(filePath, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not append local runtime log file: ${filePath}.`
    );
  }
}
