import type {RuntimeLogStore} from './records.ts';
import type {MutableDurableRuntimeSessionEvidence} from './contract.ts';
import {createRuntimeSessionEvidenceSnapshot} from './recovery.ts';
import {createRuntimeEvidenceTransitionMachine} from './transition.ts';

/**
 * In-memory `RuntimeLogStore`: the second store implementation next to
 * storage/file-runtime-log-store.ts. Both fold appends through the same
 * evidence transition machine and build read snapshots with the same
 * shared derivation (one snapshot implementation, arch rule 7).
 */
export function createRuntimeLogStore(
  options: {readonly sessionId?: string} = {},
): RuntimeLogStore {
  const evidence: MutableDurableRuntimeSessionEvidence = {
    traceEntries: [],
    rawEvents: [],
    conversationMessages: [],
  };
  const transitionMachine = createRuntimeEvidenceTransitionMachine({
    evidence,
    ...(options.sessionId === undefined ? {} : {sessionId: options.sessionId}),
  });

  return Object.freeze({
    appendTrace(entry) {
      const storedEntry = transitionMachine.prepareTraceAppend(entry);

      transitionMachine.commitTraceAppend(storedEntry);

      return storedEntry;
    },
    appendRawEvent(record) {
      const storedRecord = transitionMachine.prepareRawEventAppend(record);

      transitionMachine.commitRawEventAppend(storedRecord);

      return storedRecord;
    },
    appendConversationMessage(record, expectedCharacter) {
      const storedRecord = transitionMachine.prepareConversationAppend(
        record,
        expectedCharacter,
      );

      transitionMachine.commitConversationAppend(storedRecord);

      return storedRecord;
    },
    removeConversationMessages(messageIds) {
      transitionMachine.removeConversationMessages(messageIds);
    },
    readSessionEvidence() {
      transitionMachine.assertPublicReadable();

      return createRuntimeSessionEvidenceSnapshot(evidence);
    },
    traceEntries() {
      transitionMachine.assertPublicReadable();

      return Object.freeze([...evidence.traceEntries]);
    },
    rawEvents() {
      transitionMachine.assertPublicReadable();

      return Object.freeze([...evidence.rawEvents]);
    },
    conversationMessages() {
      transitionMachine.assertPublicReadable();

      return Object.freeze([...evidence.conversationMessages]);
    },
  } satisfies RuntimeLogStore);
}
