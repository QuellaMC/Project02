import { appendFileSync } from 'node:fs';
import { LocalRuntimeStorageContractError } from './layout-contract.ts';
import { encodeConversationLogRecord } from './conversation-codec.ts';
import { encodeRawEventLogRecord } from './raw-event-codec.ts';
import { encodeRuntimeTraceEntry } from './trace-codec.ts';
import type { RuntimeLogStore } from '../evidence/records.ts';
import {
  createRuntimeSessionEvidenceSnapshot,
  removeConversationLogRecords
} from '../evidence/recovery.ts';
import {
  FileRuntimeLogStoreState,
  type FileRuntimeLogStoreStateOptions
} from './file-runtime-log-store-state.ts';

export {
  durableRuntimeSessionCharacterProfile,
  findValidatedTerminalRawEventForSession
} from '../evidence/validation.ts';

export type CreateFileRuntimeLogStoreOptions = FileRuntimeLogStoreStateOptions;

export function createFileRuntimeLogStore(
  options: CreateFileRuntimeLogStoreOptions = {}
): RuntimeLogStore {
  const state = new FileRuntimeLogStoreState(options);
  const { paths, writerLockOwnerToken } = state;

  return Object.freeze({
    localRuntimeSessionPaths: paths,
    localRuntimeWriterLockOwnerToken: writerLockOwnerToken,
    appendTrace(entry) {
      const evidence = state.readStoredEvidence();
      const machine = state.ensureTransitionMachine(evidence);

      state.assertSessionReadable();
      state.assertWriterOwnership();
      state.recordIncrementalValidation();
      const storedEntry = machine.prepareTraceAppend(entry);

      try {
        appendJsonLine(paths.tracePath, encodeRuntimeTraceEntry(storedEntry));
        machine.commitTraceAppend(storedEntry);
        state.checkpointCachedEvidenceStamps();
      } catch (error: unknown) {
        state.invalidateCachedEvidence();
        throw error;
      }

      return storedEntry;
    },
    appendRawEvent(record) {
      const evidence = state.readStoredEvidence();
      const machine = state.ensureTransitionMachine(evidence);

      state.assertSessionReadable();
      state.assertWriterOwnership();
      state.recordIncrementalValidation();
      const storedRecord = machine.prepareRawEventAppend(record);

      try {
        appendJsonLine(paths.rawEventsPath, encodeRawEventLogRecord(storedRecord));
        machine.commitRawEventAppend(storedRecord);
        state.checkpointCachedEvidenceStamps();
      } catch (error: unknown) {
        state.invalidateCachedEvidence();
        throw error;
      }

      return storedRecord;
    },
    appendConversationMessage(record, expectedCharacter) {
      const evidence = state.readStoredEvidence();
      const machine = state.ensureTransitionMachine(evidence);

      state.assertSessionReadable();
      state.assertWriterOwnership();
      state.recordIncrementalValidation();
      const storedRecord = machine.prepareConversationAppend(
        record,
        expectedCharacter
      );

      try {
        appendJsonLine(
          paths.conversationPath,
          encodeConversationLogRecord(storedRecord)
        );
        machine.commitConversationAppend(storedRecord);
        state.checkpointCachedEvidenceStamps();
      } catch (error: unknown) {
        state.invalidateCachedEvidence();
        throw error;
      }

      return storedRecord;
    },
    recoverAbandonedWriterEvidence() {
      return state.recoverAbandonedWriterEvidence();
    },
    checkpointWriterEvidence() {
      state.checkpointWriterEvidence();
    },
    removeConversationMessages(messageIds) {
      state.assertSessionReadable();
      state.assertWriterOwnership();
      const evidence = state.readStoredEvidence();
      const machine = state.ensureTransitionMachine(evidence);
      const updated = removeConversationLogRecords({
        paths,
        evidence,
        messageIds
      });

      if (updated !== undefined) {
        machine.removeConversationMessages(messageIds);
        state.checkpointCachedEvidenceStamps();
      }
    },
    readSessionEvidence() {
      state.assertSessionReadable();
      const evidence = state.readStoredEvidence();
      state.ensureTransitionMachine(evidence).assertPublicReadable();
      return createRuntimeSessionEvidenceSnapshot(evidence);
    },
    traceEntries() {
      state.assertSessionReadable();
      const evidence = state.readStoredEvidence();
      state.ensureTransitionMachine(evidence).assertPublicReadable();
      return Object.freeze([...evidence.traceEntries]);
    },
    rawEvents() {
      state.assertSessionReadable();
      const evidence = state.readStoredEvidence();
      state.ensureTransitionMachine(evidence).assertPublicReadable();
      return Object.freeze([...evidence.rawEvents]);
    },
    conversationMessages() {
      state.assertSessionReadable();
      const evidence = state.readStoredEvidence();
      state.ensureTransitionMachine(evidence).assertPublicReadable();
      return Object.freeze([...evidence.conversationMessages]);
    }
  } satisfies RuntimeLogStore);
}

function appendJsonLine(filePath: string, line: string): void {
  try {
    appendFileSync(filePath, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (error: unknown) {
    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not append local runtime log file: ${filePath}.`,
      { cause: error }
    );
  }
}
