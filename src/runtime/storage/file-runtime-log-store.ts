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

export {durableRuntimeSessionCharacterProfile} from '../evidence/validation.ts';

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

      this.persistPreparedRawEvent(storedRecord, expectedCharacter);
      return storedRecord;
    },
    prepareRawEvent(record, expectedCharacter) {
      const machine = state.transitionMachine();

      state.assertWriterOwnership();
      state.recordIncrementalValidation();
      return machine.prepareRawEventAppend(record, expectedCharacter);
    },
    persistPreparedRawEvent(record, expectedCharacter) {
      const machine = state.transitionMachine();

      // Re-checked here, not just in prepareRawEvent: a caller may await
      // between preparing and persisting, and both the lease and the
      // evidence state have to hold at the moment the bytes land, not
      // only when the record was built — an append in between makes the
      // prepared record stale, and stale bytes on disk are a session the
      // next start refuses to read.
      state.assertWriterOwnership();
      machine.assertRawEventAppend(record, expectedCharacter);

      try {
        appendJsonLine(paths.rawEventsPath, encodeRawEventLogRecord(record));
        machine.commitRawEventAppend(record, expectedCharacter);
        state.checkpointCachedEvidenceStamps();
      } catch (error: unknown) {
        state.invalidateCachedEvidence();
        throw error;
      }
    },
    readSessionEvidence() {
      const evidence = state.readStoredEvidence();

      return Object.freeze({
        rawEvents: Object.freeze([...evidence.rawEvents]),
        conversationMessages: Object.freeze([...evidence.conversationMessages]),
      });
    },
    traceEntries() {
      return deriveRuntimeTraceEntries(this.rawEvents());
    },
    rawEvents() {
      return Object.freeze([...state.readStoredEvidence().rawEvents]);
    },
    conversationMessages() {
      return Object.freeze([
        ...state.readStoredEvidence().conversationMessages,
      ]);
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
