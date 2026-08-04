import type {RuntimeLogStore} from '../evidence/records.ts';
import {type createLocalRuntimeMutationLockOwnerToken} from './mutation-lock.ts';

export function runtimeLogStoreWithWriterOwner(
  logStore: RuntimeLogStore,
  ownerToken: ReturnType<typeof createLocalRuntimeMutationLockOwnerToken>,
): RuntimeLogStore {
  return Object.freeze({
    ...(logStore.localRuntimeSessionPaths === undefined
      ? {}
      : {localRuntimeSessionPaths: logStore.localRuntimeSessionPaths}),
    localRuntimeWriterLockOwnerToken: ownerToken,
    appendTrace(entry) {
      return logStore.appendTrace(entry);
    },
    appendRawEvent(record, expectedCharacter) {
      return logStore.appendRawEvent(record, expectedCharacter);
    },
    prepareRawEvent(record, expectedCharacter) {
      return logStore.prepareRawEvent(record, expectedCharacter);
    },
    persistPreparedRawEvent(record) {
      logStore.persistPreparedRawEvent(record);
    },
    ...(logStore.checkpointWriterEvidence === undefined
      ? {}
      : {
          checkpointWriterEvidence() {
            logStore.checkpointWriterEvidence?.();
          },
        }),
    ...(logStore.recoverAbandonedWriterEvidence === undefined
      ? {}
      : {
          recoverAbandonedWriterEvidence() {
            return logStore.recoverAbandonedWriterEvidence?.() ?? false;
          },
        }),
    readSessionEvidence() {
      return logStore.readSessionEvidence();
    },
    traceEntries() {
      return logStore.traceEntries();
    },
    rawEvents() {
      return logStore.rawEvents();
    },
    conversationMessages() {
      return logStore.conversationMessages();
    },
  } satisfies RuntimeLogStore);
}
