import {appendTextFileSync} from '../../shared/file-system.ts';
import {discardTornJsonLineTail} from './json-lines.ts';
import {LocalRuntimeStorageContractError} from './layout-contract.ts';
import {encodeRawEventLogRecord} from './raw-event-codec.ts';
import type {RuntimeLogStore} from '../evidence/contract.ts';
import {deriveRuntimeTraceEntries} from '../evidence/trace-projection.ts';
import {
  FileRuntimeLogStoreState,
  type FileRuntimeLogStoreStateOptions,
} from './file-runtime-log-store-state.ts';

export {
  durableRuntimeSessionCharacterProfile,
  findValidatedTerminalRawEventForSession,
} from '../evidence/validation.ts';

export type CreateFileRuntimeLogStoreOptions = FileRuntimeLogStoreStateOptions;

export function createFileRuntimeLogStore(
  options: CreateFileRuntimeLogStoreOptions,
): RuntimeLogStore {
  const state = new FileRuntimeLogStoreState(options);
  const {paths, writerLockOwnerToken} = state;

  return Object.freeze({
    localRuntimeSessionPaths: paths,
    localRuntimeWriterLockOwnerToken: writerLockOwnerToken,
    appendRawEvent(record, expectedCharacter) {
      const storedRecord = this.prepareRawEvent(record, expectedCharacter);

      this.persistPreparedRawEvent(storedRecord);
      return storedRecord;
    },
    prepareRawEvent(record, expectedCharacter) {
      const evidence = state.readStoredEvidence();
      const machine = state.ensureTransitionMachine(evidence);

      state.assertSessionReadable();
      state.assertWriterOwnership();
      state.recordIncrementalValidation();
      return machine.prepareRawEventAppend(record, expectedCharacter);
    },
    persistPreparedRawEvent(record) {
      const machine = state.ensureTransitionMachine(state.readStoredEvidence());

      // Re-checked here, not just in prepareRawEvent: a caller may await
      // between preparing and persisting, and the lease has to hold at the
      // moment the bytes land, not only when the record was built.
      state.assertWriterOwnership();

      try {
        appendJsonLine(paths.rawEventsPath, encodeRawEventLogRecord(record));
        machine.commitRawEventAppend(record);
        state.checkpointCachedEvidenceStamps();
      } catch (error: unknown) {
        state.invalidateCachedEvidence();
        throw error;
      }
    },
    readSessionEvidence() {
      state.assertSessionReadable();
      const evidence = state.readStoredEvidence();

      state.ensureTransitionMachine(evidence);
      return Object.freeze({
        rawEvents: Object.freeze([...evidence.rawEvents]),
        conversationMessages: Object.freeze([...evidence.conversationMessages]),
      });
    },
    traceEntries() {
      return deriveRuntimeTraceEntries(this.rawEvents());
    },
    rawEvents() {
      state.assertSessionReadable();
      const evidence = state.readStoredEvidence();

      state.ensureTransitionMachine(evidence);
      return Object.freeze([...evidence.rawEvents]);
    },
    conversationMessages() {
      state.assertSessionReadable();
      const evidence = state.readStoredEvidence();

      state.ensureTransitionMachine(evidence);
      return Object.freeze([...evidence.conversationMessages]);
    },
  } satisfies RuntimeLogStore);
}

function appendJsonLine(filePath: string, line: string): void {
  try {
    discardTornJsonLineTail(filePath);
    appendTextFileSync(filePath, `${line}\n`, 0o600);
  } catch (error: unknown) {
    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not append local runtime log file: ${filePath}.`,
      {cause: error},
    );
  }
}
