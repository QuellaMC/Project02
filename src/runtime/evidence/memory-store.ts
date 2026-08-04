import type {CharacterProfile, SpeakerIdentity} from '../../core/index.ts';
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
  options: {
    readonly sessionId?: string;
    readonly boundCharacter?: CharacterProfile;
    readonly boundUserSpeaker?: SpeakerIdentity;
  } = {},
): RuntimeLogStore {
  const evidence: MutableDurableRuntimeSessionEvidence = {
    traceEntries: [],
    rawEvents: [],
    conversationMessages: [],
  };
  const transitionMachine = createRuntimeEvidenceTransitionMachine({
    evidence,
    ...(options.sessionId === undefined ? {} : {sessionId: options.sessionId}),
    ...(options.boundCharacter === undefined
      ? {}
      : {boundCharacter: options.boundCharacter}),
    ...(options.boundUserSpeaker === undefined
      ? {}
      : {boundUserSpeaker: options.boundUserSpeaker}),
  });

  return Object.freeze({
    appendTrace(entry) {
      const storedEntry = transitionMachine.prepareTraceAppend(entry);

      transitionMachine.commitTraceAppend(storedEntry);

      return storedEntry;
    },
    appendRawEvent(record, expectedCharacter) {
      const storedRecord = transitionMachine.prepareRawEventAppend(
        record,
        expectedCharacter,
      );

      transitionMachine.commitRawEventAppend(storedRecord);

      return storedRecord;
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
