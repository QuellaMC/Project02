import type {RuntimeLogStore} from '../evidence/contract.ts';
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
    appendRawEvent(record, expectedCharacter) {
      return logStore.appendRawEvent(record, expectedCharacter);
    },
    prepareRawEvent(record, expectedCharacter) {
      return logStore.prepareRawEvent(record, expectedCharacter);
    },
    persistPreparedRawEvent(record, expectedCharacter) {
      logStore.persistPreparedRawEvent(record, expectedCharacter);
    },
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
